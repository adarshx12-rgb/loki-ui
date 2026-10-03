import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { patchOpSchema, type RunDetail, type ValidationResult, type Workflow } from '@nodepilot/shared';
import { z } from 'zod';
import { ApiError, type ApiClient } from './client.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown, note?: string): ToolResult => ({
  content: [{ type: 'text', text: (note ? note + '\n\n' : '') + JSON.stringify(data, null, 2) }],
});

function fail(e: unknown): ToolResult {
  if (e instanceof ApiError) {
    const details = e.details === undefined ? '' : `\n\nDetails:\n${JSON.stringify(e.details, null, 2).slice(0, 20_000)}`;
    return { isError: true, content: [{ type: 'text', text: `${e.code} (HTTP ${e.status}): ${e.message}${details}` }] };
  }
  return { isError: true, content: [{ type: 'text', text: (e as Error).message ?? String(e) }] };
}

const wrap = <A>(fn: (args: A) => Promise<ToolResult>) => async (args: A) => {
  try {
    return await fn(args);
  } catch (e) {
    return fail(e);
  }
};

const enc = encodeURIComponent;
const wfId = z.string().min(1).max(64).describe('Workflow id (see list_workflows)');
const opsSchema = z
  .array(patchOpSchema)
  .min(1)
  .max(100)
  .describe(
    'Patch operations applied atomically. Ops: add_node, replace_node, update_node {nodeId, changes}, remove_node, move_node, set_node_display, append_node_note, add_edge, remove_edge, update_workflow. update_node.changes.config is shallow-merged.',
  );

const PATCH_HELP = `Every patch requires baseRevision = the workflow revision you read. If someone else changed the workflow since, the server rejects the patch with a conflict that lists the intervening changes; re-read with get_workflow and retry. Structural problems (cycles, incompatible ports, dangling edges, secrets in params) are rejected and nothing is saved.`;

export function createMcpServer(api: ApiClient, info = { name: 'nodepilot', version: '0.1.0' }): McpServer {
  const server = new McpServer(info, {
    instructions:
      'NodePilot lets you inspect and edit visual AI workflows (nodes + typed edges). Read with list_workflows/get_workflow/inspect_node, then change them with apply_workflow_patch (immediate) or propose_workflow_patch (queued for the user to review in the app). Changes appear live in the open canvas. ' +
      PATCH_HELP,
  });

  server.registerTool(
    'list_workflows',
    { title: 'List workflows', description: 'List workflows with their current revision.', inputSchema: {}, annotations: { readOnlyHint: true } },
    wrap(async () => ok(await api.get('/api/workflows'))),
  );

  server.registerTool(
    'get_workflow',
    {
      title: 'Get workflow',
      description: 'Return the full workflow document (nodes, edges, revision) and its validation result.',
      inputSchema: { workflowId: wfId },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ workflowId }) => ok(await api.get(`/api/workflows/${enc(workflowId)}`))),
  );

  server.registerTool(
    'inspect_node',
    {
      title: 'Inspect node',
      description: 'Show one node: configuration, ports, connections, notes, code references, validation issues and recent run history.',
      inputSchema: { workflowId: wfId, nodeId: z.string().min(1).max(64) },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ workflowId, nodeId }) => {
      const { workflow, validation } = await api.get<{ workflow: Workflow; validation: ValidationResult }>(`/api/workflows/${enc(workflowId)}`);
      const node = workflow.nodes.find((n) => n.id === nodeId);
      if (!node) return fail(new Error(`Node "${nodeId}" not found. Nodes: ${workflow.nodes.map((n) => n.id).join(', ')}`));
      const history = await api.get(`/api/workflows/${enc(workflowId)}/nodes/${enc(nodeId)}/history`);
      return ok({
        revision: workflow.revision,
        node,
        incoming: workflow.edges.filter((e) => e.target === nodeId),
        outgoing: workflow.edges.filter((e) => e.source === nodeId),
        issues: validation.issues.filter((i) => i.nodeId === nodeId),
        recentRuns: history,
      });
    }),
  );

  server.registerTool(
    'validate_workflow',
    {
      title: 'Validate workflow',
      description: 'Validate the stored workflow. Issue levels: "save" (structural, blocks saving), "run" (blocks execution), "warning".',
      inputSchema: { workflowId: wfId },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ workflowId }) => ok(await api.post(`/api/workflows/${enc(workflowId)}/validate`, {}))),
  );

  server.registerTool(
    'propose_workflow_patch',
    {
      title: 'Propose workflow patch',
      description: `Validate a patch without applying it and queue it as a proposal the user can review and apply in the NodePilot app. ${PATCH_HELP}`,
      inputSchema: { workflowId: wfId, baseRevision: z.number().int().min(0), title: z.string().min(1).max(200).describe('Short description for the reviewer'), ops: opsSchema },
    },
    wrap(async ({ workflowId, baseRevision, title, ops }) => {
      const r = await api.post<{ proposalId: string; summary: string; validation: ValidationResult }>(`/api/workflows/${enc(workflowId)}/proposals`, { baseRevision, title, ops });
      return ok({ proposalId: r.proposalId, summary: r.summary, validation: r.validation }, 'Proposal queued for review in the NodePilot app (not applied yet).');
    }),
  );

  server.registerTool(
    'apply_workflow_patch',
    {
      title: 'Apply workflow patch',
      description: `Apply a patch immediately. The change is audit-logged (actor "mcp") and appears live on the canvas. ${PATCH_HELP}`,
      inputSchema: { workflowId: wfId, baseRevision: z.number().int().min(0), ops: opsSchema },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ workflowId, baseRevision, ops }) => {
      const r = await api.post<{ workflow: Workflow; validation: ValidationResult; rebased?: boolean }>(`/api/workflows/${enc(workflowId)}/patch`, { baseRevision, ops });
      return ok({ newRevision: r.workflow.revision, rebased: !!r.rebased, validation: r.validation }, `Applied. Workflow is now at revision ${r.workflow.revision}.`);
    }),
  );

  server.registerTool(
    'add_node_note',
    {
      title: 'Add node note',
      description: 'Append a Markdown note to a node (attributed to Claude Code). Appending is safe under concurrent edits, so no base revision is needed.',
      inputSchema: { workflowId: wfId, nodeId: z.string().min(1).max(64), text: z.string().min(1).max(20_000) },
    },
    wrap(async ({ workflowId, nodeId, text }) => {
      const { workflow } = await api.get<{ workflow: Workflow }>(`/api/workflows/${enc(workflowId)}`);
      const r = await api.post<{ workflow: Workflow }>(`/api/workflows/${enc(workflowId)}/patch`, {
        baseRevision: workflow.revision,
        ops: [{ op: 'append_node_note', nodeId, text, author: 'Claude Code (MCP)' }],
      });
      return ok({ newRevision: r.workflow.revision }, 'Note added.');
    }),
  );

  server.registerTool(
    'inspect_run',
    {
      title: 'Inspect run',
      description: 'Inspect a local run: status, per-node status/inputs/outputs (redacted, truncated) and events. Pass runId, or workflowId to get the latest run.',
      inputSchema: { runId: z.string().max(64).optional(), workflowId: wfId.optional(), includeEvents: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ runId, workflowId, includeEvents }) => {
      let id = runId;
      if (!id) {
        if (!workflowId) return fail(new Error('Provide runId or workflowId'));
        const runs = await api.get<{ id: string }[]>(`/api/workflows/${enc(workflowId)}/runs`);
        if (!runs.length) return ok({ runs: [] }, 'This workflow has no runs yet. Ask the user to press Run in the app.');
        id = runs[0].id;
      }
      const run = await api.get<RunDetail & { snapshot?: unknown }>(`/api/runs/${enc(id)}`);
      const { snapshot: _s, ...rest } = run;
      const events = includeEvents ? await api.get(`/api/runs/${enc(id)}/events`) : undefined;
      return ok({ ...rest, events });
    }),
  );

  return server;
}
