import fs from 'node:fs';
import path from 'node:path';
import { newId } from '@nodepilot/shared';
import { assertApprovableRoot, resolveWithinRoots, PathRestrictionError } from '@nodepilot/shared/node';
import { nowIso, type DB } from './db.js';
import { HttpError } from './workflows.js';

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
}

/** Approved project directories. Every filesystem access by the server is confined to these roots. */
export class Projects {
  constructor(private db: DB) {}

  list(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY name').all() as Record<string, string>[]).map((r) => ({
      id: r.id,
      name: r.name,
      rootPath: r.root_path,
      createdAt: r.created_at,
    }));
  }

  get(id: string): Project {
    const p = this.list().find((x) => x.id === id);
    if (!p) throw new HttpError(404, 'not_found', `Project "${id}" is not approved`);
    return p;
  }

  add(rootPath: string, name?: string): Project {
    let real: string;
    try {
      real = assertApprovableRoot(rootPath);
    } catch (e) {
      throw new HttpError(422, 'invalid_root', (e as Error).message);
    }
    const existing = this.list().find((p) => path.normalize(p.rootPath).toLowerCase() === path.normalize(real).toLowerCase());
    if (existing) return existing;
    const p: Project = { id: newId('proj'), name: name?.trim() || path.basename(real), rootPath: real, createdAt: nowIso() };
    this.db.prepare('INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)').run(p.id, p.name, p.rootPath, p.createdAt);
    return p;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /** Resolves a repository-relative path inside a project, refusing traversal and symlink escapes. */
  resolve(projectId: string, rel: string, opts: { mustExist?: boolean } = {}): string {
    const p = this.get(projectId);
    try {
      return resolveWithinRoots([p.rootPath], rel, { base: p.rootPath, mustExist: opts.mustExist }).path;
    } catch (e) {
      if (e instanceof PathRestrictionError) throw new HttpError(403, 'path_restricted', e.message);
      throw e;
    }
  }

  /** Builds a validated VS Code deep link for a code reference. */
  codeLink(projectId: string, rel: string, line?: number) {
    const abs = this.resolve(projectId, rel);
    const exists = fs.existsSync(abs);
    const forward = abs.replace(/\\/g, '/');
    const vscodeUrl = `vscode://file/${forward.startsWith('/') ? forward.slice(1) : forward}${line ? `:${line}` : ''}`;
    return { absolutePath: abs, exists, vscodeUrl: exists ? vscodeUrl : undefined };
  }
}
