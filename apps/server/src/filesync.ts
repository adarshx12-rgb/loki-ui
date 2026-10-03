import fs from 'node:fs';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { diffWorkflows, fnv1a, parseWorkflow, redactValue, stableStringify, type Workflow } from '@nodepilot/shared';
import type { Bus } from './bus.js';
import { nowIso, type DB } from './db.js';
import type { Projects } from './projects.js';
import { HttpError, type WorkflowStore } from './workflows.js';

interface Link {
  workflowId: string;
  projectId: string;
  relPath: string;
  lastHash: string | null;
  lastError: string | null;
}

/**
 * Two-way sync between a workflow and a JSON file inside an approved project.
 *  - App → file: debounced write after every revision; content hash remembered.
 *  - File → app: debounced watcher; our own writes are recognised by hash (loop prevention);
 *    external edits are imported as a patch through the normal store (actor "file") only if
 *    the file's revision matches the current revision. Otherwise a conflict is reported.
 */
export class FileSync {
  private watchers = new Map<string, FSWatcher>();
  private writeTimers = new Map<string, NodeJS.Timeout>();
  private readTimers = new Map<string, NodeJS.Timeout>();
  private unsub?: () => void;

  constructor(private db: DB, private bus: Bus, private store: WorkflowStore, private projects: Projects, private debounceMs = 300) {}

  start(): void {
    for (const l of this.links()) this.watchLink(l);
    this.unsub = this.bus.subscribe(({ event }) => {
      if (event.type === 'workflow.updated' && this.link(event.workflowId)) this.scheduleWrite(event.workflowId);
      if (event.type === 'workflow.deleted') this.unlink(event.workflowId);
    });
  }

  async stop(): Promise<void> {
    this.unsub?.();
    for (const t of [...this.writeTimers.values(), ...this.readTimers.values()]) clearTimeout(t);
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    this.watchers.clear();
  }

  links(): Link[] {
    return (this.db.prepare('SELECT * FROM workflow_files').all() as Record<string, string | null>[]).map((r) => ({
      workflowId: r.workflow_id!,
      projectId: r.project_id!,
      relPath: r.rel_path!,
      lastHash: r.last_hash,
      lastError: r.last_error,
    }));
  }

  link(workflowId: string): Link | undefined {
    return this.links().find((l) => l.workflowId === workflowId);
  }

  /** Links a workflow to `relPath` (must be a .json file inside the project). Writes the current revision immediately. */
  linkFile(workflowId: string, projectId: string, relPath: string): Link {
    if (!relPath.endsWith('.json')) throw new HttpError(422, 'invalid_path', 'Linked workflow files must end with .json');
    this.store.get(workflowId);
    const abs = this.projects.resolve(projectId, relPath);
    this.db
      .prepare('INSERT INTO workflow_files (workflow_id, project_id, rel_path, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(workflow_id) DO UPDATE SET project_id = excluded.project_id, rel_path = excluded.rel_path, last_hash = NULL, last_error = NULL, updated_at = excluded.updated_at')
      .run(workflowId, projectId, relPath, nowIso());
    this.writeNow(workflowId);
    void abs;
    const l = this.link(workflowId)!;
    this.watchLink(l);
    return l;
  }

  unlink(workflowId: string): void {
    this.db.prepare('DELETE FROM workflow_files WHERE workflow_id = ?').run(workflowId);
    const w = this.watchers.get(workflowId);
    if (w) void w.close();
    this.watchers.delete(workflowId);
  }

  static serialize(wf: Workflow): string {
    // Redacted, stable, human-diffable JSON. Secrets are never in workflows, but redaction is applied as a belt-and-braces step.
    return JSON.stringify(redactValue(wf), null, 2) + '\n';
  }

  private scheduleWrite(workflowId: string) {
    clearTimeout(this.writeTimers.get(workflowId));
    this.writeTimers.set(workflowId, setTimeout(() => this.writeNow(workflowId), this.debounceMs));
  }

  writeNow(workflowId: string): void {
    const l = this.link(workflowId);
    if (!l) return;
    try {
      const abs = this.projects.resolve(l.projectId, l.relPath);
      const text = FileSync.serialize(this.store.get(workflowId));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
      this.setState(workflowId, fnv1a(text), null);
    } catch (e) {
      this.setState(workflowId, l.lastHash, `Write failed: ${(e as Error).message}`);
    }
  }

  private setState(workflowId: string, hash: string | null, error: string | null) {
    this.db.prepare('UPDATE workflow_files SET last_hash = ?, last_error = ?, updated_at = ? WHERE workflow_id = ?').run(hash, error, nowIso(), workflowId);
  }

  private watchLink(l: Link) {
    const existing = this.watchers.get(l.workflowId);
    if (existing) void existing.close();
    let abs: string;
    try {
      abs = this.projects.resolve(l.projectId, l.relPath);
    } catch (e) {
      this.setState(l.workflowId, l.lastHash, (e as Error).message);
      return;
    }
    const w = watch(abs, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
    w.on('change', () => {
      clearTimeout(this.readTimers.get(l.workflowId));
      this.readTimers.set(l.workflowId, setTimeout(() => this.importNow(l.workflowId), this.debounceMs));
    });
    this.watchers.set(l.workflowId, w);
  }

  /** Imports an external file edit. Returns what happened (useful for tests). */
  importNow(workflowId: string): 'ignored_own_write' | 'imported' | 'no_changes' | 'conflict' | 'invalid' {
    const l = this.link(workflowId);
    if (!l) return 'invalid';
    const abs = this.projects.resolve(l.projectId, l.relPath);
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      this.setState(workflowId, l.lastHash, `Read failed: ${(e as Error).message}`);
      return 'invalid';
    }
    const hash = fnv1a(text);
    if (hash === l.lastHash) return 'ignored_own_write';
    const report = (message: string) => {
      this.setState(workflowId, l.lastHash, message);
      this.bus.publish({ type: 'workflow.conflict', workflowId, message, source: l.relPath });
    };
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      report(`File is not valid JSON: ${(e as Error).message}. Not imported.`);
      return 'invalid';
    }
    const parsed = parseWorkflow(doc);
    if (!parsed.workflow) {
      report(`File failed schema validation: ${parsed.issues[0]?.message}. Not imported.`);
      return 'invalid';
    }
    const current = this.store.get(workflowId);
    if (parsed.workflow.id !== current.id) {
      report(`File contains workflow "${parsed.workflow.id}", expected "${current.id}". Not imported.`);
      return 'invalid';
    }
    if (parsed.workflow.revision !== current.revision) {
      report(
        `File is based on revision ${parsed.workflow.revision} but the workflow is at revision ${current.revision}. The file was not imported, to avoid overwriting newer changes. Re-apply your edit to the latest file content (use "Rewrite file" in the app to refresh it).`,
      );
      return 'conflict';
    }
    const ops = diffWorkflows(current, { ...parsed.workflow, createdAt: current.createdAt, updatedAt: current.updatedAt, isExample: current.isExample });
    if (ops.length === 0 || stableStringify(ops) === '[]') {
      this.setState(workflowId, hash, null);
      return 'no_changes';
    }
    try {
      this.store.applyPatch(workflowId, { baseRevision: current.revision, ops, actor: 'file' });
      this.setState(workflowId, hash, null);
      return 'imported';
    } catch (e) {
      const he = e as HttpError;
      report(`File change rejected: ${he.message}`);
      return 'invalid';
    }
  }
}
