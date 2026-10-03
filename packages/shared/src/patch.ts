import { z } from 'zod';
import { stableStringify } from './graph.js';
import { edgeSchema, idSchema, nodeConfigSchema, nodeSchema, codeRefSchema, inputPortSchema, outputPortSchema, nodeKindSchema, type Workflow, type WorkflowNode } from './schema.js';

const cs = nodeConfigSchema.shape;
/** Partial config without defaults, so omitted keys are left untouched. */
export const configChangesSchema = z
  .object({
    implementation: cs.implementation.optional(),
    params: cs.params.unwrap().optional(),
    timeoutMs: cs.timeoutMs.unwrap().optional(),
    retry: cs.retry.unwrap().optional(),
    postProcess: cs.postProcess.unwrap().optional(),
    demo: cs.demo.unwrap().optional(),
  })
  .strict();

/** Partial node changes. `config` is shallow-merged: provided keys replace existing ones wholesale. */
export const nodeChangesSchema = z
  .object({
    kind: nodeKindSchema,
    label: z.string().min(1).max(120),
    purpose: z.string().max(2000),
    inputs: z.array(inputPortSchema).max(20),
    outputs: z.array(outputPortSchema).max(20),
    config: configChangesSchema,
    notes: z.string().max(100_000),
    instructions: z.string().max(100_000),
    codeRefs: z.array(codeRefSchema).max(50),
  })
  .partial()
  .strict();

export const patchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_node'), node: nodeSchema }),
  z.object({ op: z.literal('replace_node'), node: nodeSchema }),
  z.object({ op: z.literal('update_node'), nodeId: idSchema, changes: nodeChangesSchema }),
  z.object({ op: z.literal('remove_node'), nodeId: idSchema }),
  z.object({ op: z.literal('move_node'), nodeId: idSchema, position: z.object({ x: z.number().finite(), y: z.number().finite() }) }),
  z.object({
    op: z.literal('set_node_display'),
    nodeId: idSchema,
    display: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), collapsed: z.boolean().optional() }),
  }),
  z.object({ op: z.literal('append_node_note'), nodeId: idSchema, text: z.string().min(1).max(20_000), author: z.string().max(80).optional() }),
  z.object({ op: z.literal('add_edge'), edge: edgeSchema }),
  z.object({ op: z.literal('remove_edge'), edgeId: idSchema }),
  z.object({
    op: z.literal('update_workflow'),
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(5000).optional(),
    projectId: idSchema.nullable().optional(),
  }),
]);
export type PatchOp = z.infer<typeof patchOpSchema>;
export type PatchOpInput = z.input<typeof patchOpSchema>;
export const patchSchema = z.array(patchOpSchema).min(1).max(500);

/**
 * Ops that commute with concurrent edits: they only touch layout or append text,
 * so a stale base revision is tolerated (the op is rebased onto the latest revision).
 * Everything else requires the exact base revision.
 */
export const COMMUTATIVE_OPS = new Set<PatchOp['op']>(['move_node', 'set_node_display', 'append_node_note']);
export const LAYOUT_OPS = new Set<PatchOp['op']>(['move_node', 'set_node_display']);

export function isCommutativePatch(ops: PatchOp[]): boolean {
  return ops.every((o) => COMMUTATIVE_OPS.has(o.op));
}

export class PatchError extends Error {
  constructor(message: string, public readonly opIndex: number) {
    super(message);
  }
}

/** Applies ops to a deep copy of the workflow. Does not bump revision; the store does that. */
export function applyPatch(wf: Workflow, ops: PatchOp[], now: () => string = () => new Date().toISOString()): Workflow {
  const next: Workflow = structuredClone(wf);
  ops.forEach((op, i) => {
    const findNode = (id: string): WorkflowNode => {
      const n = next.nodes.find((x) => x.id === id);
      if (!n) throw new PatchError(`op #${i} (${op.op}): node "${id}" does not exist`, i);
      return n;
    };
    switch (op.op) {
      case 'add_node':
        if (next.nodes.some((n) => n.id === op.node.id)) throw new PatchError(`op #${i}: node "${op.node.id}" already exists`, i);
        next.nodes.push(structuredClone(op.node));
        break;
      case 'replace_node': {
        const idx = next.nodes.findIndex((n) => n.id === op.node.id);
        if (idx < 0) throw new PatchError(`op #${i}: node "${op.node.id}" does not exist`, i);
        next.nodes[idx] = structuredClone(op.node);
        break;
      }
      case 'update_node': {
        const n = findNode(op.nodeId);
        const { config, ...rest } = op.changes;
        Object.assign(n, structuredClone(rest));
        if (config) n.config = { ...n.config, ...structuredClone(config) } as WorkflowNode['config'];
        break;
      }
      case 'remove_node':
        findNode(op.nodeId);
        next.nodes = next.nodes.filter((n) => n.id !== op.nodeId);
        next.edges = next.edges.filter((e) => e.source !== op.nodeId && e.target !== op.nodeId);
        break;
      case 'move_node':
        findNode(op.nodeId).position = { ...op.position };
        break;
      case 'set_node_display': {
        const n = findNode(op.nodeId);
        n.display = { ...n.display, ...op.display };
        break;
      }
      case 'append_node_note': {
        const n = findNode(op.nodeId);
        const header = `\n\n---\n**${op.author ?? 'Note'}** · ${now()}\n\n`;
        n.notes = (n.notes ? n.notes + header : header.trimStart()) + op.text;
        break;
      }
      case 'add_edge':
        if (next.edges.some((e) => e.id === op.edge.id)) throw new PatchError(`op #${i}: edge "${op.edge.id}" already exists`, i);
        next.edges.push({ ...op.edge });
        break;
      case 'remove_edge':
        if (!next.edges.some((e) => e.id === op.edgeId)) throw new PatchError(`op #${i}: edge "${op.edgeId}" does not exist`, i);
        next.edges = next.edges.filter((e) => e.id !== op.edgeId);
        break;
      case 'update_workflow':
        if (op.name !== undefined) next.name = op.name;
        if (op.description !== undefined) next.description = op.description;
        if (op.projectId !== undefined) {
          if (op.projectId === null) delete next.projectId;
          else next.projectId = op.projectId;
        }
        break;
    }
  });
  return next;
}

/** Produces ops that transform `from` into `to` (used for undo/redo and file sync). */
export function diffWorkflows(from: Workflow, to: Workflow): PatchOp[] {
  const ops: PatchOp[] = [];
  const toNodes = new Map(to.nodes.map((n) => [n.id, n]));
  const fromNodes = new Map(from.nodes.map((n) => [n.id, n]));
  const toEdges = new Map(to.edges.map((e) => [e.id, e]));
  const fromEdges = new Map(from.edges.map((e) => [e.id, e]));

  for (const e of from.edges) {
    const t = toEdges.get(e.id);
    if (!t || stableStringify(t) !== stableStringify(e)) ops.push({ op: 'remove_edge', edgeId: e.id });
  }
  for (const n of from.nodes) if (!toNodes.has(n.id)) ops.push({ op: 'remove_node', nodeId: n.id });
  for (const n of to.nodes) {
    const f = fromNodes.get(n.id);
    if (!f) ops.push({ op: 'add_node', node: n });
    else if (stableStringify(f) !== stableStringify(n)) {
      const { position: fp, ...fRest } = f;
      const { position: tp, ...tRest } = n;
      if (stableStringify(fRest) === stableStringify(tRest)) ops.push({ op: 'move_node', nodeId: n.id, position: tp });
      else ops.push({ op: 'replace_node', node: n });
      void fp;
    }
  }
  for (const e of to.edges) {
    const f = fromEdges.get(e.id);
    if (!f || stableStringify(f) !== stableStringify(e)) {
      // remove_node above may already have dropped edges attached to removed nodes; only add edges that should exist.
      ops.push({ op: 'add_edge', edge: e });
    }
  }
  if (from.name !== to.name || from.description !== to.description || from.projectId !== to.projectId) {
    ops.push({ op: 'update_workflow', name: to.name, description: to.description, projectId: to.projectId ?? null });
  }
  // Edges removed implicitly by remove_node must not be removed twice.
  const removedNodes = new Set(ops.filter((o) => o.op === 'remove_node').map((o) => (o as { nodeId: string }).nodeId));
  return ops.filter(
    (o) => !(o.op === 'remove_edge' && (() => { const e = fromEdges.get(o.edgeId)!; return removedNodes.has(e.source) || removedNodes.has(e.target); })()),
  ).sort((a, b) => order(a) - order(b));
}

function order(op: PatchOp): number {
  switch (op.op) {
    case 'remove_edge': return 0;
    case 'remove_node': return 1;
    case 'add_node': case 'replace_node': case 'update_node': case 'move_node': case 'set_node_display': case 'append_node_note': return 2;
    case 'add_edge': return 3;
    case 'update_workflow': return 4;
  }
}

/** Short human summary of a patch (used in audit logs and conflict messages). */
export function describePatch(ops: PatchOp[]): string {
  return ops
    .map((o) => {
      switch (o.op) {
        case 'add_node': return `add node ${o.node.id}`;
        case 'replace_node': return `replace node ${o.node.id}`;
        case 'update_node': return `update ${o.nodeId} (${Object.keys(o.changes).join(', ')})`;
        case 'remove_node': return `remove node ${o.nodeId}`;
        case 'move_node': return `move ${o.nodeId}`;
        case 'set_node_display': return `restyle ${o.nodeId}`;
        case 'append_node_note': return `note on ${o.nodeId}`;
        case 'add_edge': return `connect ${o.edge.source}.${o.edge.sourcePort} → ${o.edge.target}.${o.edge.targetPort}`;
        case 'remove_edge': return `remove edge ${o.edgeId}`;
        case 'update_workflow': return 'update workflow details';
      }
    })
    .join('; ');
}

/** Node ids touched by a patch (for conflict reporting). */
export function touchedNodeIds(ops: PatchOp[]): Set<string> {
  const s = new Set<string>();
  for (const o of ops) {
    if ('nodeId' in o) s.add(o.nodeId);
    if ('node' in o) s.add(o.node.id);
    if ('edge' in o) { s.add(o.edge.source); s.add(o.edge.target); }
  }
  return s;
}
