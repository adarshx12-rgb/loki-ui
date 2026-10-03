import {
  applyPatch,
  buildExampleWorkflow,
  describePatch,
  EXAMPLE_WORKFLOW_ID,
  isCommutativePatch,
  newId,
  PatchError,
  patchSchema,
  SCHEMA_VERSION,
  touchedNodeIds,
  validateWorkflow,
  type Actor,
  type PatchOp,
  type ValidationContext,
  type ValidationIssue,
  type ValidationResult,
  type Workflow,
} from '@nodepilot/shared';
import { z } from 'zod';
import type { Bus } from './bus.js';
import { nowIso, tx, type DB } from './db.js';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, details: unknown) {
    super(409, 'revision_conflict', message, details);
  }
}

export interface AuditEntry {
  id: number;
  workflowId: string;
  fromRevision: number | null;
  toRevision: number;
  actor: string;
  summary: string;
  touchedNodes: string[];
  createdAt: string;
}

export interface PatchResult {
  workflow: Workflow;
  validation: ValidationResult;
  applied: boolean;
  rebased?: boolean;
}

/**
 * The single authoritative persistence + validation layer. UI, MCP, file sync
 * and the runner all mutate workflows exclusively through `applyPatch`.
 */
export class WorkflowStore {
  constructor(private db: DB, private bus: Bus, private ctx: () => ValidationContext = () => ({})) {}

  ensureExample(): void {
    const exists = this.db.prepare('SELECT 1 FROM workflows WHERE id = ?').get(EXAMPLE_WORKFLOW_ID);
    if (!exists) this.insert(buildExampleWorkflow(), 'system', 'Seeded illustrative example');
  }

  list(): { id: string; name: string; revision: number; isExample: boolean; nodeCount: number; updatedAt: string; projectId?: string }[] {
    const rows = this.db.prepare('SELECT json FROM workflows ORDER BY updated_at DESC').all() as { json: string }[];
    // Simulation sandboxes are private scratch copies and never listed.
    return rows.map((r) => JSON.parse(r.json) as Workflow).filter((w) => !w.simulationOf).map((w) => {
      return { id: w.id, name: w.name, revision: w.revision, isExample: w.isExample, nodeCount: w.nodes.length, updatedAt: w.updatedAt, projectId: w.projectId };
    });
  }

  get(id: string): Workflow {
    const row = this.db.prepare('SELECT json FROM workflows WHERE id = ?').get(id) as { json: string } | undefined;
    if (!row) throw new HttpError(404, 'not_found', `Workflow "${id}" not found`);
    return JSON.parse(row.json) as Workflow;
  }

  validate(wf: Workflow | unknown): ValidationResult {
    const { workflow: _w, ...r } = validateWorkflow(wf, this.ctx());
    return r;
  }

  create(input: { name: string; description?: string; projectId?: string; id?: string }, actor: Actor): Workflow {
    const id = input.id ?? newId('wf');
    if (this.db.prepare('SELECT 1 FROM workflows WHERE id = ?').get(id)) throw new HttpError(409, 'exists', `Workflow "${id}" already exists`);
    const now = nowIso();
    const wf: Workflow = {
      schemaVersion: SCHEMA_VERSION,
      id,
      name: input.name,
      description: input.description ?? '',
      revision: 1,
      isExample: false,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      nodes: [],
      edges: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.insert(wf, actor, 'Created workflow');
  }

  /** Imports a full workflow document (e.g. from an exported JSON file). */
  importWorkflow(doc: unknown, actor: Actor): Workflow {
    const v = validateWorkflow(doc, this.ctx());
    if (!v.ok || !v.workflow) throw new HttpError(422, 'invalid_workflow', 'Workflow failed validation', v.issues);
    const id = this.db.prepare('SELECT 1 FROM workflows WHERE id = ?').get(v.workflow.id) ? newId('wf') : v.workflow.id;
    const now = nowIso();
    return this.insert({ ...v.workflow, id, revision: 1, isExample: false, createdAt: now, updatedAt: now }, actor, 'Imported workflow');
  }

  private insert(wf: Workflow, actor: Actor, summary: string): Workflow {
    const v = validateWorkflow(wf, this.ctx());
    if (!v.ok || !v.workflow) throw new HttpError(422, 'invalid_workflow', 'Workflow failed validation', v.issues);
    const parsed = v.workflow;
    tx(this.db, () => {
      this.db.prepare('INSERT INTO workflows (id, revision, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        parsed.id, parsed.revision, JSON.stringify(parsed), parsed.createdAt, parsed.updatedAt,
      );
      this.audit(parsed.id, null, parsed.revision, actor, summary, [], []);
    });
    this.bus.publish({ type: 'workflow.created', workflowId: parsed.id });
    return parsed;
  }

  delete(id: string, actor: Actor): void {
    this.get(id);
    tx(this.db, () => {
      this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
      this.audit(id, null, 0, actor, 'Deleted workflow', [], []);
    });
    this.bus.publish({ type: 'workflow.deleted', workflowId: id });
  }

  /**
   * Deletes the workflow and everything recorded about it: runs and their events, proposals, Claude tasks,
   * external telemetry, its linked-file record and its whole audit trail. Shared things (services, secrets,
   * projects) are not touched. Callers should stop anything still running first.
   */
  purge(id: string): void {
    this.get(id);
    tx(this.db, () => {
      const q = (sql: string) => this.db.prepare(sql).run(id);
      q('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ?)');
      q('DELETE FROM runs WHERE workflow_id = ?');
      q('DELETE FROM proposals WHERE workflow_id = ?');
      q('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE workflow_id = ?)');
      q('DELETE FROM tasks WHERE workflow_id = ?');
      q('DELETE FROM external_node_states WHERE workflow_id = ?');
      q('DELETE FROM external_runs WHERE workflow_id = ?');
      q('DELETE FROM telemetry_events WHERE workflow_id = ?');
      q('DELETE FROM workflow_files WHERE workflow_id = ?');
      q('DELETE FROM audit_log WHERE workflow_id = ?');
      q('DELETE FROM workflows WHERE id = ?');
    });
    this.bus.publish({ type: 'workflow.deleted', workflowId: id });
  }

  /** The open simulation sandbox of a workflow, if any. */
  simulationOf(mainId: string): Workflow | null {
    const rows = this.db.prepare('SELECT json FROM workflows').all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Workflow).find((w) => w.simulationOf === mainId) ?? null;
  }

  /**
   * Starts a simulation: a hidden copy of the workflow that can be edited and run freely.
   * Any older sandbox of the same workflow is discarded first.
   */
  createSimulation(mainId: string, actor: Actor): Workflow {
    const main = this.get(mainId);
    if (main.simulationOf) throw new HttpError(409, 'already_simulation', 'This is already a simulation');
    const old = this.simulationOf(mainId);
    if (old) this.purge(old.id);
    return this.importWorkflow({ ...main, id: newId('sim'), name: `${main.name} (simulation)`.slice(0, 120), simulationOf: mainId }, actor);
  }

  parseOps(raw: unknown): PatchOp[] {
    const r = patchSchema.safeParse(raw);
    if (!r.success) {
      throw new HttpError(
        422,
        'invalid_patch',
        'Patch failed schema validation',
        r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return r.data;
  }

  /**
   * Applies a patch with optimistic concurrency.
   *  - Non-commutative patches require `baseRevision === current.revision`.
   *  - Layout-only / note-append patches are rebased onto the latest revision.
   *  - Any save-level validation issue rejects the patch (nothing persisted).
   */
  applyPatch(id: string, opts: { baseRevision: number; ops: unknown; actor: Actor; dryRun?: boolean }): PatchResult {
    const ops = this.parseOps(opts.ops);
    return tx(this.db, () => {
      const current = this.get(id);
      let rebased = false;
      if (opts.baseRevision !== current.revision) {
        if (opts.baseRevision > current.revision) {
          throw new ConflictError(`Base revision ${opts.baseRevision} is newer than the stored revision ${current.revision}.`, { currentRevision: current.revision });
        }
        if (!isCommutativePatch(ops)) throw this.conflict(current, opts.baseRevision, ops);
        rebased = true;
      }
      let next: Workflow;
      try {
        next = applyPatch(current, ops);
      } catch (e) {
        if (e instanceof PatchError) throw new HttpError(422, 'patch_failed', e.message, { opIndex: e.opIndex });
        throw e;
      }
      next.revision = current.revision + 1;
      next.updatedAt = nowIso();
      const v = validateWorkflow(next, this.ctx());
      const { workflow: parsed, ...validation } = v;
      if (!v.ok || !parsed) {
        throw new HttpError(422, 'validation_failed', `Change rejected: ${firstSaveIssue(v.issues)}`, v.issues);
      }
      if (opts.dryRun) return { workflow: parsed, validation, applied: false, rebased };
      this.db.prepare('UPDATE workflows SET revision = ?, json = ?, updated_at = ? WHERE id = ?').run(parsed.revision, JSON.stringify(parsed), parsed.updatedAt, id);
      const summary = describePatch(ops);
      this.audit(id, current.revision, parsed.revision, opts.actor, summary, ops, [...touchedNodeIds(ops)]);
      // Publish after commit (tx returns before the listeners run synchronously? no: publish is synchronous, so defer).
      queueMicrotask(() => this.bus.publish({ type: 'workflow.updated', workflowId: id, revision: parsed.revision, actor: opts.actor, summary }));
      return { workflow: parsed, validation, applied: true, rebased };
    });
  }

  private conflict(current: Workflow, base: number, ops: PatchOp[]): ConflictError {
    const changes = this.auditSince(current.id, base);
    const mine = touchedNodeIds(ops);
    const overlapping = new Set<string>();
    for (const c of changes) for (const n of c.touchedNodes) if (mine.has(n)) overlapping.add(n);
    const who = changes.map((c) => `r${c.toRevision} by ${c.actor}: ${c.summary}`).join('\n');
    const overlapText = overlapping.size
      ? `Your change touches the same node(s): ${[...overlapping].join(', ')}.`
      : 'The concurrent changes touched different nodes, so re-applying your change on the latest revision is likely safe.';
    return new ConflictError(
      `Workflow changed since revision ${base} (now ${current.revision}). ${overlapText} Reload the workflow, review the changes below, then re-apply your edit with baseRevision=${current.revision}.`,
      { currentRevision: current.revision, baseRevision: base, changesSince: changes, overlappingNodes: [...overlapping], latest: current },
    );
  }

  private audit(workflowId: string, from: number | null, to: number, actor: string, summary: string, ops: unknown[], touched: string[]) {
    this.db
      .prepare('INSERT INTO audit_log (workflow_id, from_revision, to_revision, actor, summary, ops_json, touched_nodes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(workflowId, from, to, actor, summary.slice(0, 2000), JSON.stringify(ops), JSON.stringify(touched), nowIso());
  }

  auditSince(workflowId: string, afterRevision: number): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_log WHERE workflow_id = ? AND to_revision > ? ORDER BY to_revision ASC LIMIT 200')
      .all(workflowId, afterRevision) as Record<string, unknown>[];
    return rows.map(mapAudit);
  }

  auditLog(workflowId: string, limit = 100): AuditEntry[] {
    const rows = this.db.prepare('SELECT * FROM audit_log WHERE workflow_id = ? ORDER BY id DESC LIMIT ?').all(workflowId, limit) as Record<string, unknown>[];
    return rows.map(mapAudit);
  }

  // ---- proposals: validated patches waiting for review in the UI ----

  propose(id: string, opts: { baseRevision: number; ops: unknown; actor: Actor; title: string }) {
    const result = this.applyPatch(id, { ...opts, dryRun: true });
    const ops = this.parseOps(opts.ops);
    const proposalId = newId('prop');
    this.db
      .prepare('INSERT INTO proposals (id, workflow_id, base_revision, actor, title, ops_json, validation_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(proposalId, id, opts.baseRevision, opts.actor, opts.title.slice(0, 200), JSON.stringify(ops), JSON.stringify(result.validation), nowIso());
    this.bus.publish({ type: 'proposal.created', workflowId: id, proposalId });
    return { proposalId, summary: describePatch(ops), validation: result.validation, preview: result.workflow };
  }

  listProposals(workflowId: string) {
    const rows = this.db.prepare("SELECT * FROM proposals WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 50").all(workflowId) as Record<string, string | number>[];
    return rows.map((r) => ({
      id: r.id as string,
      workflowId: r.workflow_id as string,
      baseRevision: r.base_revision as number,
      actor: r.actor as string,
      title: r.title as string,
      ops: JSON.parse(r.ops_json as string) as PatchOp[],
      summary: describePatch(JSON.parse(r.ops_json as string)),
      validation: JSON.parse(r.validation_json as string),
      status: r.status as string,
      createdAt: r.created_at as string,
    }));
  }

  resolveProposal(workflowId: string, proposalId: string, action: 'apply' | 'reject', actor: Actor) {
    const p = this.listProposals(workflowId).find((x) => x.id === proposalId);
    if (!p) throw new HttpError(404, 'not_found', 'Proposal not found');
    if (p.status !== 'open') throw new HttpError(409, 'proposal_closed', `Proposal is already ${p.status}`);
    let result: PatchResult | undefined;
    if (action === 'apply') result = this.applyPatch(workflowId, { baseRevision: p.baseRevision, ops: p.ops, actor });
    this.db.prepare('UPDATE proposals SET status = ?, resolved_at = ? WHERE id = ?').run(action === 'apply' ? 'applied' : 'rejected', nowIso(), proposalId);
    this.bus.publish({ type: 'proposal.created', workflowId, proposalId });
    return result;
  }
}

function mapAudit(r: Record<string, unknown>): AuditEntry {
  return {
    id: r.id as number,
    workflowId: r.workflow_id as string,
    fromRevision: (r.from_revision as number | null) ?? null,
    toRevision: r.to_revision as number,
    actor: r.actor as string,
    summary: r.summary as string,
    touchedNodes: JSON.parse((r.touched_nodes as string) ?? '[]'),
    createdAt: r.created_at as string,
  };
}

function firstSaveIssue(issues: ValidationIssue[]): string {
  return issues.find((i) => i.level === 'save')?.message ?? 'invalid workflow';
}

export const patchBodySchema = z.object({ baseRevision: z.number().int().min(0), ops: z.unknown() });
