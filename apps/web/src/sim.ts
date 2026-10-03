import { diffWorkflows, stableStringify, type PatchOp, type Workflow, type WorkflowNode } from '@nodepilot/shared';

export type Verb = 'Added' | 'Removed' | 'Edited' | 'Moved' | 'Connected' | 'Disconnected' | 'Renamed';

export interface SimChange {
  key: string;
  op: PatchOp;
  verb: Verb;
  title: string;
  detail?: string;
  /** Only the position changed. */
  layoutOnly: boolean;
}

const nodeLabel = (wf: Workflow, id: string) => wf.nodes.find((n) => n.id === id)?.label ?? id;

function fieldChanges(a: WorkflowNode, b: WorkflowNode): string {
  const out: string[] = [];
  if (a.label !== b.label) out.push(`renamed “${a.label}” → “${b.label}”`);
  if (a.kind !== b.kind) out.push(`type ${a.kind} → ${b.kind}`);
  if (a.purpose !== b.purpose) out.push('purpose');
  const ca = a.config;
  const cb = b.config;
  const same = (x: unknown, y: unknown) => stableStringify(x) === stableStringify(y);
  if (!same(ca.implementation, cb.implementation)) out.push('implementation');
  if (!same(ca.params, cb.params)) out.push('parameters');
  if (ca.timeoutMs !== cb.timeoutMs) out.push(`timeout ${ca.timeoutMs} → ${cb.timeoutMs} ms`);
  if (!same(ca.retry, cb.retry)) out.push('retries');
  if (!same(ca.demo, cb.demo)) out.push(`demo fault ${ca.demo.failMode} → ${cb.demo.failMode}`);
  if (!same(ca.postProcess, cb.postProcess)) out.push('post-processing');
  if (a.instructions !== b.instructions) out.push('instructions');
  if (a.notes !== b.notes) out.push('notes');
  if (!same(a.inputs, b.inputs) || !same(a.outputs, b.outputs)) out.push('ports');
  if (!same(a.codeRefs, b.codeRefs)) out.push('code references');
  if (!same(a.display, b.display)) out.push('appearance');
  if (!same(a.position, b.position)) out.push('position');
  return out.join(', ');
}

/** Every difference between the simulation and the project as it was when the simulation started. */
export function simChanges(base: Workflow, sandbox: Workflow): SimChange[] {
  // The sandbox's own name ("… (simulation)") is not a change.
  const ops = diffWorkflows(base, { ...sandbox, name: base.name });
  return ops.map((op): SimChange => {
    switch (op.op) {
      case 'add_node':
        return { key: `add:${op.node.id}`, op, verb: 'Added', title: `“${op.node.label}” (${op.node.kind})`, layoutOnly: false };
      case 'remove_node':
        return { key: `remove:${op.nodeId}`, op, verb: 'Removed', title: `“${nodeLabel(base, op.nodeId)}” and its connections`, layoutOnly: false };
      case 'replace_node': {
        const before = base.nodes.find((n) => n.id === op.node.id)!;
        return { key: `edit:${op.node.id}`, op, verb: 'Edited', title: `“${before.label}”`, detail: fieldChanges(before, op.node), layoutOnly: false };
      }
      case 'move_node':
        return { key: `move:${op.nodeId}`, op, verb: 'Moved', title: `“${nodeLabel(sandbox, op.nodeId)}”`, detail: 'position only', layoutOnly: true };
      case 'add_edge':
        return { key: `connect:${op.edge.id}`, op, verb: 'Connected', title: `${nodeLabel(sandbox, op.edge.source)} → ${nodeLabel(sandbox, op.edge.target)}`, detail: `${op.edge.sourcePort} → ${op.edge.targetPort}`, layoutOnly: false };
      case 'remove_edge': {
        const e = base.edges.find((x) => x.id === op.edgeId);
        return { key: `disconnect:${op.edgeId}`, op, verb: 'Disconnected', title: e ? `${nodeLabel(base, e.source)} → ${nodeLabel(base, e.target)}` : op.edgeId, layoutOnly: false };
      }
      default:
        return { key: `workflow:${op.op}`, op, verb: 'Renamed', title: 'Project details', detail: 'name / description', layoutOnly: false };
    }
  });
}

/**
 * The changes that must travel together with `selected` so main stays valid:
 * a new connection needs its new (or re-ported) nodes; an edited node needs the
 * removal of connections that used ports it no longer has.
 */
export function withDependencies(all: SimChange[], selected: Set<string>, base: Workflow): SimChange[] {
  const keys = new Set(selected);
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of all) {
      if (!keys.has(c.key)) continue;
      const need: string[] = [];
      if (c.op.op === 'add_edge') need.push(`add:${c.op.edge.source}`, `add:${c.op.edge.target}`, `edit:${c.op.edge.source}`, `edit:${c.op.edge.target}`);
      if (c.op.op === 'replace_node') {
        const id = c.op.node.id;
        for (const e of base.edges) if (e.source === id || e.target === id) need.push(`disconnect:${e.id}`);
      }
      for (const k of need) if (all.some((x) => x.key === k) && !keys.has(k)) { keys.add(k); changed = true; }
    }
  }
  return all.filter((c) => keys.has(c.key));
}

/** Changes pulled in automatically for `c` (shown as "also applies …"). */
export function dependenciesOf(all: SimChange[], c: SimChange, base: Workflow): SimChange[] {
  return withDependencies(all, new Set([c.key]), base).filter((x) => x.key !== c.key);
}
