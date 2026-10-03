import type { PortType, Workflow, WorkflowEdge, WorkflowNode } from './schema.js';

export function nodeMap(wf: Pick<Workflow, 'nodes'>): Map<string, WorkflowNode> {
  return new Map(wf.nodes.map((n) => [n.id, n]));
}

/** A source port can feed a target port when the types match, or the target accepts `any`/`json` (non-text). */
export function portsCompatible(source: PortType, target: PortType): boolean {
  if (source === target) return true;
  if (target === 'any') return true;
  if (target === 'json' && source !== 'text') return true;
  return false;
}

/** Returns one cycle (as a list of node ids) if the graph contains one, otherwise null. */
export function findCycle(nodes: { id: string }[], edges: Pick<WorkflowEdge, 'source' | 'target'>[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) adj.get(e.source)?.push(e.target);
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string>();
  for (const n of nodes) color.set(n.id, WHITE);

  for (const start of nodes) {
    if (color.get(start.id) !== WHITE) continue;
    // Iterative DFS so large graphs do not overflow the stack.
    const stack: { id: string; i: number }[] = [{ id: start.id, i: 0 }];
    color.set(start.id, GREY);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = adj.get(top.id) ?? [];
      if (top.i >= next.length) {
        color.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      const to = next[top.i++];
      const c = color.get(to);
      if (c === GREY) {
        const cycle = [to];
        let cur = top.id;
        while (cur !== to) {
          cycle.push(cur);
          cur = parent.get(cur)!;
        }
        cycle.push(to);
        return cycle.reverse();
      }
      if (c === WHITE) {
        parent.set(to, top.id);
        color.set(to, GREY);
        stack.push({ id: to, i: 0 });
      }
    }
  }
  return null;
}

/** Kahn topological order; throws if a cycle exists. */
export function topoOrder(wf: Pick<Workflow, 'nodes' | 'edges'>): string[] {
  const indeg = new Map<string, number>(wf.nodes.map((n) => [n.id, 0]));
  for (const e of wf.edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = wf.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of wf.edges) {
      if (e.source !== id) continue;
      const d = indeg.get(e.target)! - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  if (order.length !== wf.nodes.length) throw new Error('Workflow contains a cycle');
  return order;
}

export function upstreamOf(wf: Pick<Workflow, 'edges'>, nodeId: string): Set<string> {
  const out = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of wf.edges) if (e.target === id && !out.has(e.source)) { out.add(e.source); stack.push(e.source); }
  }
  return out;
}

export function downstreamOf(wf: Pick<Workflow, 'edges'>, nodeId: string): Set<string> {
  const out = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of wf.edges) if (e.source === id && !out.has(e.target)) { out.add(e.target); stack.push(e.target); }
  }
  return out;
}

/** Stable JSON stringify (sorted keys) for hashing/comparison. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as object).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

/** FNV-1a 64-bit hash (hex). Not cryptographic; used to detect executable-config changes. */
export function fnv1a(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Hash of everything that influences execution. Position, display, notes and code
 * references are excluded, so moving a node never changes this hash.
 */
export function executableHash(wf: Pick<Workflow, 'nodes' | 'edges'>): string {
  const nodes = [...wf.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({ id: n.id, kind: n.kind, inputs: n.inputs, outputs: n.outputs, config: n.config, instructions: n.instructions }));
  const edges = [...wf.edges]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({ s: e.source, sp: e.sourcePort, t: e.target, tp: e.targetPort }));
  return fnv1a(stableStringify({ nodes, edges }));
}
