import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EXAMPLE_WORKFLOW_ID, templateByKey } from '@nodepilot/shared';
import { createHttpClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';
import { makeEnv, type TestEnv } from '../../server/test/helpers.js';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

async function connect(e: TestEnv, token = e.mcpToken) {
  const address = await e.app.listen({ host: '127.0.0.1', port: 0 });
  e.ctx.cfg.allowedHosts.push(new URL(address).host);
  const server = createMcpServer(createHttpClient(address, token));
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!r.isError, text: r.content[0].text };
  };
  return { client, call };
}

describe('MCP server', () => {
  it('exposes the documented tools', async () => {
    env = await makeEnv();
    const { client } = await connect(env);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['add_node_note', 'apply_workflow_patch', 'get_workflow', 'inspect_node', 'inspect_run', 'list_workflows', 'propose_workflow_patch', 'validate_workflow']);
  });

  it('applies mutations through the authoritative store and broadcasts them to the canvas', async () => {
    env = await makeEnv();
    const { call } = await connect(env);
    const updates: { actor: string; revision: number }[] = [];
    env.ctx.bus.subscribe(({ event }) => { if (event.type === 'workflow.updated') updates.push({ actor: event.actor, revision: event.revision }); });

    const node = templateByKey('judge')!.build('n_judge_style', { x: 1300, y: 500 });
    const r = await call('apply_workflow_patch', {
      workflowId: EXAMPLE_WORKFLOW_ID,
      baseRevision: 1,
      ops: [
        { op: 'add_node', node },
        { op: 'add_edge', edge: { id: 'e_style_in', source: 'n_scene_worker', sourcePort: 'scene', target: 'n_judge_style', targetPort: 'scene' } },
        { op: 'add_edge', edge: { id: 'e_style_out', source: 'n_judge_style', sourcePort: 'score', target: 'n_score_combiner', targetPort: 'scores' } },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/revision 2/);
    await new Promise((res) => setTimeout(res, 10));
    expect(updates).toEqual([{ actor: 'mcp', revision: 2 }]);
    expect(env.ctx.store.auditLog(EXAMPLE_WORKFLOW_ID)[0].actor).toBe('mcp');

    // stale revision → conflict explained, nothing applied
    const stale = await call('apply_workflow_patch', { workflowId: EXAMPLE_WORKFLOW_ID, baseRevision: 1, ops: [{ op: 'update_node', nodeId: 'n_scanner', changes: { label: 'X' } }] });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/revision_conflict.*changed since revision 1/s);

    // invalid (cycle) → rejected with validation details
    const cyc = await call('apply_workflow_patch', {
      workflowId: EXAMPLE_WORKFLOW_ID,
      baseRevision: 2,
      ops: [{ op: 'update_node', nodeId: 'n_query', changes: { inputs: [{ id: 'back', label: 'Back', type: 'any', required: false }] } }, { op: 'add_edge', edge: { id: 'loop', source: 'n_judge_style', sourcePort: 'score', target: 'n_query', targetPort: 'back' } }],
    });
    expect(cyc.isError).toBe(true);
    expect(cyc.text).toMatch(/acyclic/);
    expect(env.ctx.store.get(EXAMPLE_WORKFLOW_ID).revision).toBe(2);
  });

  it('adds notes, proposes patches for review, validates and inspects', async () => {
    env = await makeEnv();
    const { call } = await connect(env);
    expect((await call('add_node_note', { workflowId: EXAMPLE_WORKFLOW_ID, nodeId: 'n_scanner', text: 'Check the index size.' })).isError).toBe(false);
    expect(env.ctx.store.get(EXAMPLE_WORKFLOW_ID).nodes.find((n) => n.id === 'n_scanner')!.notes).toMatch(/Claude Code \(MCP\)[\s\S]*Check the index size/);

    const prop = await call('propose_workflow_patch', { workflowId: EXAMPLE_WORKFLOW_ID, baseRevision: 2, title: 'Longer timeout', ops: [{ op: 'update_node', nodeId: 'n_scanner', changes: { config: { timeoutMs: 90000 } } }] });
    expect(prop.isError).toBe(false);
    expect(env.ctx.store.get(EXAMPLE_WORKFLOW_ID).revision).toBe(2); // not applied
    expect(env.ctx.store.listProposals(EXAMPLE_WORKFLOW_ID)[0].status).toBe('open');

    const v = await call('validate_workflow', { workflowId: EXAMPLE_WORKFLOW_ID });
    expect(JSON.parse(v.text).runnable).toBe(true);
    const n = JSON.parse((await call('inspect_node', { workflowId: EXAMPLE_WORKFLOW_ID, nodeId: 'n_plan_combiner' })).text);
    expect(n.incoming).toHaveLength(2);

    const run = env.ctx.runs.start(EXAMPLE_WORKFLOW_ID, { actor: 'ui' });
    await env.ctx.runs.wait(run.id);
    const ir = JSON.parse((await call('inspect_run', { workflowId: EXAMPLE_WORKFLOW_ID })).text);
    expect(ir.id).toBe(run.id);
    expect(ir.status).toBe('succeeded');
  });

  it('fails clearly with a bad token', async () => {
    env = await makeEnv();
    const { call } = await connect(env, 'npm_bad');
    const r = await call('list_workflows');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/401/);
  });
});
