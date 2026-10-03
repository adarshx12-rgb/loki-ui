import { applyPostProcess, topoOrder, VISUAL_ONLY_KINDS, type NodeRunState, type Workflow, type WorkflowNode } from '@nodepilot/shared';

export interface HandlerContext {
  node: WorkflowNode;
  inputs: Record<string, unknown>;
  runInput: unknown;
  signal: AbortSignal;
  attempt: number;
}

export interface HandlerResult {
  /** Values keyed by output port id. */
  outputs: Record<string, unknown>;
  demo?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export type Handler = (ctx: HandlerContext) => Promise<HandlerResult>;

/** Either a handler that NodePilot executes, or an explanation of why the node is not executed. */
export type Resolution =
  | { kind: 'execute'; handler: Handler }
  | { kind: 'observed'; reason: string }
  | { kind: 'unavailable'; reason: string; code: string };

export interface SchedulerEvent {
  type: 'node.queued' | 'node.started' | 'node.retrying' | 'node.succeeded' | 'node.failed' | 'node.skipped' | 'node.cancelled' | 'node.observed';
  nodeId: string;
  message?: string;
  data?: unknown;
}

export interface ScheduleOptions {
  resolve: (node: WorkflowNode) => Resolution;
  concurrency: number;
  signal: AbortSignal;
  runInput?: unknown;
  onEvent?: (e: SchedulerEvent, state: NodeRunState) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface ScheduleResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  nodes: Record<string, NodeRunState>;
  outputs: Record<string, Record<string, unknown>>;
}

export class NodeError extends Error {
  constructor(message: string, public code: string, public retryable = true) {
    super(message);
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const naturalCmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * Executes an immutable workflow snapshot:
 *  - a node starts once every upstream node is terminal;
 *  - at most `concurrency` nodes run at a time;
 *  - required inputs whose producers did not succeed cause a `skipped` status with the upstream cause;
 *  - fan-in ports merge explicitly (array ordered by edge id, or object keyed by source node id);
 *  - per-node timeouts abort the handler; retries only happen for nodes marked safeToRetry;
 *  - cancelling the run aborts running handlers and marks everything unfinished `cancelled`.
 */
export async function runSchedule(full: Workflow, opts: ScheduleOptions): Promise<ScheduleResult> {
  // Layout-only nodes (groups) are never scheduled.
  const wf: Workflow = { ...full, nodes: full.nodes.filter((n) => !VISUAL_ONLY_KINDS.has(n.kind)) };
  const sleep = opts.sleep ?? abortableSleep;
  const now = opts.now ?? Date.now;
  const order = topoOrder(wf); // throws on cycles; validation should have caught it
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, typeof wf.edges>();
  for (const n of wf.nodes) incoming.set(n.id, []);
  for (const e of wf.edges) incoming.get(e.target)!.push(e);
  for (const list of incoming.values()) list.sort((a, b) => naturalCmp(a.id, b.id));

  const states: Record<string, NodeRunState> = {};
  for (const id of order) states[id] = { nodeId: id, status: 'pending', attempts: 0 };
  const outputs: Record<string, Record<string, unknown>> = {};
  const emit = (e: SchedulerEvent) => opts.onEvent?.(e, states[e.nodeId]);

  const terminal = (s: NodeRunState['status']) => ['succeeded', 'failed', 'skipped', 'cancelled', 'observed'].includes(s);
  const running = new Map<string, Promise<void>>();

  const finish = (id: string, patch: Partial<NodeRunState>, ev: SchedulerEvent) => {
    const st = states[id];
    Object.assign(st, patch);
    st.finishedAt = new Date(now()).toISOString();
    if (st.startedAt) st.durationMs = now() - Date.parse(st.startedAt);
    emit(ev);
  };

  /** Gathers inputs, or returns the reason the node cannot run. */
  const gatherInputs = (node: WorkflowNode): { inputs: Record<string, unknown> } | { skip: string; upstream?: string } => {
    const inputs: Record<string, unknown> = {};
    const edges = incoming.get(node.id)!;
    for (const port of node.inputs) {
      const portEdges = edges.filter((e) => e.targetPort === port.id);
      const available = portEdges.filter((e) => states[e.source].status === 'succeeded' && e.sourcePort in (outputs[e.source] ?? {}));
      const missing = portEdges.filter((e) => !available.includes(e));
      if (port.required && (portEdges.length === 0 || missing.length > 0)) {
        const cause = missing[0];
        if (cause) {
          const st = states[cause.source];
          return { skip: `Required input "${port.label}" unavailable: upstream "${byId.get(cause.source)?.label ?? cause.source}" ${st.status}`, upstream: cause.source };
        }
        return { skip: `Required input "${port.label}" is not connected` };
      }
      if (available.length === 0) continue;
      if (port.multiple) {
        inputs[port.id] =
          port.merge === 'object_by_source'
            ? Object.fromEntries(available.map((e) => [e.source, outputs[e.source][e.sourcePort]]))
            : available.map((e) => outputs[e.source][e.sourcePort]);
      } else {
        inputs[port.id] = outputs[available[0].source][available[0].sourcePort];
      }
    }
    return { inputs };
  };

  const execute = async (node: WorkflowNode, handler: Handler, inputs: Record<string, unknown>) => {
    const st = states[node.id];
    const { timeoutMs, retry } = node.config;
    const maxAttempts = retry.safeToRetry ? retry.maxAttempts : 1;
    st.status = 'running';
    st.startedAt = new Date(now()).toISOString();
    st.input = inputs;
    emit({ type: 'node.started', nodeId: node.id });
    for (let attempt = 1; ; attempt++) {
      st.attempts = attempt;
      const ac = new AbortController();
      const onRunAbort = () => ac.abort(new NodeError('Run cancelled', 'cancelled', false));
      opts.signal.addEventListener('abort', onRunAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (opts.signal.aborted) throw new NodeError('Run cancelled', 'cancelled', false);
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new NodeError(`Timed out after ${timeoutMs} ms`, 'timeout', true);
            ac.abort(err);
            reject(err);
          }, timeoutMs);
        });
        const aborted = new Promise<never>((_, reject) => {
          ac.signal.addEventListener('abort', () => reject(ac.signal.reason), { once: true });
        });
        const result = await Promise.race([handler({ node, inputs, runInput: opts.runInput, signal: ac.signal, attempt }), timeout, aborted]);
        let out: Record<string, unknown> = result.outputs;
        if (node.config.postProcess.length > 0) {
          try {
            out = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, applyPostProcess(v, node.config.postProcess)]));
          } catch (e) {
            throw new NodeError(`Post-processing failed: ${(e as Error).message}`, 'postprocess', false);
          }
        }
        for (const p of node.outputs) {
          if (!(p.id in out)) throw new NodeError(`Handler did not produce output port "${p.id}"`, 'contract', false);
        }
        outputs[node.id] = out;
        finish(node.id, { status: 'succeeded', output: out, demo: result.demo, usage: result.usage }, { type: 'node.succeeded', nodeId: node.id });
        return;
      } catch (raw) {
        const err = raw instanceof NodeError ? raw : new NodeError((raw as Error)?.message ?? String(raw), 'handler_error', true);
        if (opts.signal.aborted || err.code === 'cancelled') {
          finish(node.id, { status: 'cancelled', error: { message: 'Cancelled', code: 'cancelled' } }, { type: 'node.cancelled', nodeId: node.id });
          return;
        }
        if (attempt < maxAttempts && err.retryable) {
          st.status = 'retrying';
          emit({ type: 'node.retrying', nodeId: node.id, message: `Attempt ${attempt} failed: ${err.message}`, data: { attempt, code: err.code } });
          try {
            await sleep(retry.backoffMs * attempt, opts.signal);
          } catch {
            finish(node.id, { status: 'cancelled', error: { message: 'Cancelled', code: 'cancelled' } }, { type: 'node.cancelled', nodeId: node.id });
            return;
          }
          st.status = 'running';
          continue;
        }
        finish(node.id, { status: 'failed', error: { message: err.message, code: err.code } }, { type: 'node.failed', nodeId: node.id, message: err.message });
        return;
      } finally {
        clearTimeout(timer);
        opts.signal.removeEventListener('abort', onRunAbort);
      }
    }
  };

  // Main loop: start every ready node (bounded), wait for any to finish, repeat.
  for (;;) {
    if (opts.signal.aborted) {
      for (const id of order) {
        if (!terminal(states[id].status) && !running.has(id)) {
          finish(id, { status: 'cancelled', reason: 'Run cancelled before node started' }, { type: 'node.cancelled', nodeId: id });
        }
      }
    }
    for (const id of order) {
      if (opts.signal.aborted) break;
      if (running.size >= opts.concurrency) break;
      const st = states[id];
      if (st.status !== 'pending' && st.status !== 'queued') continue;
      const deps = incoming.get(id)!;
      if (!deps.every((e) => terminal(states[e.source].status))) continue;
      const node = byId.get(id)!;
      const res = opts.resolve(node);
      if (res.kind === 'observed') {
        finish(id, { status: 'observed', reason: res.reason }, { type: 'node.observed', nodeId: id, message: res.reason });
        continue;
      }
      const gathered = gatherInputs(node);
      if ('skip' in gathered) {
        finish(id, { status: 'skipped', reason: gathered.skip, error: { message: gathered.skip, code: 'upstream', upstream: gathered.upstream } }, {
          type: 'node.skipped', nodeId: id, message: gathered.skip,
        });
        continue;
      }
      if (res.kind === 'unavailable') {
        finish(id, { status: 'failed', error: { message: res.reason, code: res.code } }, { type: 'node.failed', nodeId: id, message: res.reason });
        continue;
      }
      const p = execute(node, res.handler, gathered.inputs).finally(() => running.delete(id));
      running.set(id, p);
    }
    if (running.size === 0) {
      // Nothing running: either everything is terminal, or nodes became ready synchronously (observed/skipped) and need another pass.
      const pending = order.filter((id) => !terminal(states[id].status));
      if (pending.length === 0) break;
      const progress = pending.some((id) => incoming.get(id)!.every((e) => terminal(states[e.source].status)));
      if (!progress && !opts.signal.aborted) throw new Error('Scheduler stalled (unexpected)');
      continue;
    }
    await Promise.race(running.values());
  }

  const all = Object.values(states);
  const status = opts.signal.aborted && all.some((s) => s.status === 'cancelled')
    ? 'cancelled'
    : all.some((s) => s.status === 'failed')
      ? 'failed'
      : 'succeeded';
  return { status, nodes: states, outputs };
}
