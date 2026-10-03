import {
  executableHash,
  newId,
  sanitizeForStorage,
  type NodeRunState,
  type RunDetail,
  type RunEvent,
  type RunSummary,
  type Workflow,
} from '@nodepilot/shared';
import type { Bus } from './bus.js';
import { nowIso, type DB } from './db.js';
import { runSchedule, type Resolution } from './executor/scheduler.js';
import { HttpError, type WorkflowStore } from './workflows.js';

/**
 * Starts, cancels and records runs. Every run executes an immutable snapshot of
 * the workflow taken at start time; later edits never affect a running run.
 */
export class RunManager {
  private controllers = new Map<string, AbortController>();
  private seqs = new Map<string, number>();
  private active = new Map<string, Promise<void>>();

  constructor(
    private db: DB,
    private bus: Bus,
    private store: WorkflowStore,
    private resolve: (node: Workflow['nodes'][number]) => Resolution,
    private opts: { concurrency: number; runsPerWorkflow: number },
  ) {}

  /** Runs left 'running' by a previous process were interrupted; record that honestly. */
  recoverInterrupted(): void {
    this.db
      .prepare("UPDATE runs SET status = 'failed', error = 'Interrupted: the NodePilot server stopped while this run was in progress', finished_at = ? WHERE status IN ('queued','running')")
      .run(nowIso());
  }

  start(workflowId: string, opts: { input?: unknown; actor: string; expectedRevision?: number }): RunSummary {
    const wf = this.store.get(workflowId);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== wf.revision) {
      throw new HttpError(409, 'revision_conflict', `You are viewing revision ${opts.expectedRevision} but the workflow is at ${wf.revision}. Reload before running.`);
    }
    const v = this.store.validate(wf);
    if (!v.runnable) throw new HttpError(422, 'not_runnable', 'Workflow cannot run until validation errors are fixed', v.issues);
    const snapshot = Object.freeze(structuredClone(wf)) as Workflow;
    const id = newId('run');
    const now = nowIso();
    const input = sanitizeForStorage(opts.input ?? null, 4000).value;
    this.db
      .prepare('INSERT INTO runs (id, workflow_id, workflow_revision, executable_hash, snapshot_json, status, input_json, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, wf.id, wf.revision, executableHash(wf), JSON.stringify(snapshot), 'queued', JSON.stringify(input), opts.actor, now);
    const ac = new AbortController();
    this.controllers.set(id, ac);
    this.seqs.set(id, 0);
    this.event(id, wf.id, { type: 'run.created', message: `Run created from revision ${wf.revision}` });
    const p = this.execute(id, snapshot, opts.input, ac).finally(() => {
      this.controllers.delete(id);
      this.active.delete(id);
      this.prune(wf.id);
    });
    this.active.set(id, p);
    return this.summary(id);
  }

  /** For tests: wait for a run to finish. */
  async wait(runId: string): Promise<RunDetail> {
    await this.active.get(runId);
    return this.get(runId);
  }

  cancel(runId: string): RunSummary {
    const ac = this.controllers.get(runId);
    const run = this.summary(runId);
    if (!ac) throw new HttpError(409, 'not_running', `Run is ${run.status}; nothing to cancel`);
    this.event(runId, run.workflowId, { type: 'run.cancel_requested', message: 'Cancellation requested' });
    ac.abort(new Error('cancelled'));
    return run;
  }

  private async execute(id: string, wf: Workflow, input: unknown, ac: AbortController) {
    const started = nowIso();
    this.db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(started, id);
    this.event(id, wf.id, { type: 'run.started' });
    this.publishRun(id);
    const nodes: Record<string, NodeRunState> = {};
    const persistNodes = () => this.db.prepare('UPDATE runs SET nodes_json = ? WHERE id = ?').run(JSON.stringify(nodes), id);
    try {
      const result = await runSchedule(wf, {
        resolve: this.resolve,
        concurrency: this.opts.concurrency,
        signal: ac.signal,
        runInput: input,
        onEvent: (e, state) => {
          nodes[e.nodeId] = sanitizeState(state);
          persistNodes();
          this.event(id, wf.id, { type: e.type, nodeId: e.nodeId, message: e.message, data: { status: state.status, attempts: state.attempts, durationMs: state.durationMs, ...(e.data as object) } });
        },
      });
      for (const [nid, st] of Object.entries(result.nodes)) nodes[nid] = sanitizeState(st);
      persistNodes();
      const failed = Object.values(result.nodes).filter((n) => n.status === 'failed');
      const error = result.status === 'failed' ? `${failed.length} node(s) failed: ${failed.map((n) => wf.nodes.find((x) => x.id === n.nodeId)?.label ?? n.nodeId).join(', ')}` : null;
      this.db.prepare('UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ?').run(result.status, error, nowIso(), id);
      this.event(id, wf.id, { type: `run.${result.status}`, message: error ?? undefined });
    } catch (e) {
      this.db.prepare("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(`Executor error: ${(e as Error).message}`, nowIso(), id);
      this.event(id, wf.id, { type: 'run.failed', message: (e as Error).message });
    }
    this.publishRun(id);
  }

  private event(runId: string, workflowId: string, e: { type: string; nodeId?: string; message?: string; data?: unknown }) {
    const seq = (this.seqs.get(runId) ?? 0) + 1;
    this.seqs.set(runId, seq);
    const ev: RunEvent = { seq, runId, nodeId: e.nodeId, type: e.type, at: nowIso(), message: e.message, data: e.data };
    this.db
      .prepare('INSERT INTO run_events (run_id, seq, node_id, type, at, message, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, seq, e.nodeId ?? null, e.type, ev.at, e.message ?? null, e.data === undefined ? null : JSON.stringify(sanitizeForStorage(e.data, 2000).value));
    this.bus.publish({ type: 'run.event', event: ev, workflowId });
  }

  private publishRun(id: string) {
    this.bus.publish({ type: 'run.updated', run: this.summary(id) });
  }

  private row(id: string): Record<string, string | number | null> {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    if (!r) throw new HttpError(404, 'not_found', `Run "${id}" not found`);
    return r;
  }

  summary(id: string): RunSummary {
    return mapSummary(this.row(id));
  }

  get(id: string): RunDetail & { snapshot: Workflow } {
    const r = this.row(id);
    return { ...mapSummary(r), nodes: JSON.parse((r.nodes_json as string) ?? '{}'), snapshot: JSON.parse(r.snapshot_json as string) };
  }

  events(runId: string): RunEvent[] {
    const rows = this.db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq').all(runId) as Record<string, string | number | null>[];
    return rows.map((r) => ({
      seq: r.seq as number,
      runId: r.run_id as string,
      nodeId: (r.node_id as string) ?? undefined,
      type: r.type as string,
      at: r.at as string,
      message: (r.message as string) ?? undefined,
      data: r.data_json ? JSON.parse(r.data_json as string) : undefined,
    }));
  }

  list(workflowId: string, limit = 50): RunSummary[] {
    const rows = this.db.prepare('SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?').all(workflowId, limit) as Record<string, string | number | null>[];
    return rows.map(mapSummary);
  }

  /** Per-node history across recent runs. */
  nodeHistory(workflowId: string, nodeId: string, limit = 20) {
    const rows = this.db.prepare('SELECT id, workflow_revision, status, created_at, nodes_json FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?').all(workflowId, limit) as Record<string, string | number>[];
    return rows
      .map((r) => ({ runId: r.id as string, revision: r.workflow_revision as number, runStatus: r.status as string, createdAt: r.created_at as string, node: (JSON.parse(r.nodes_json as string) as Record<string, NodeRunState>)[nodeId] }))
      .filter((r) => r.node);
  }

  private prune(workflowId: string) {
    const old = this.db
      .prepare('SELECT id FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?')
      .all(workflowId, this.opts.runsPerWorkflow) as { id: string }[];
    for (const { id } of old) {
      this.db.prepare('DELETE FROM run_events WHERE run_id = ?').run(id);
      this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
    }
  }
}

function sanitizeState(st: NodeRunState): NodeRunState {
  const input = sanitizeForStorage(st.input);
  const output = sanitizeForStorage(st.output);
  return {
    ...st,
    input: input.value,
    output: output.value,
    truncated: input.truncated || output.truncated || undefined,
    error: st.error ? (sanitizeForStorage(st.error, 2000).value as NodeRunState['error']) : undefined,
  };
}

function mapSummary(r: Record<string, string | number | null>): RunSummary {
  const started = r.started_at as string | null;
  const finished = r.finished_at as string | null;
  return {
    id: r.id as string,
    workflowId: r.workflow_id as string,
    workflowRevision: r.workflow_revision as number,
    executableHash: r.executable_hash as string,
    status: r.status as RunSummary['status'],
    createdAt: r.created_at as string,
    startedAt: started ?? undefined,
    finishedAt: finished ?? undefined,
    durationMs: started && finished ? Date.parse(finished) - Date.parse(started) : undefined,
    error: (r.error as string) ?? undefined,
    input: r.input_json ? JSON.parse(r.input_json as string) : undefined,
    actor: r.actor as string,
  };
}
