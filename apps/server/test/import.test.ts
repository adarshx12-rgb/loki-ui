import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_MARKER } from '../src/importer.js';
import { makeEnv, ui, type TestEnv } from './helpers.js';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}:${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
}

describe('project import', () => {
  it('only reads the original folder and keeps a private demo copy in the data folder', async () => {
    env = await makeEnv();
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'np-original-'));
    try {
      fs.mkdirSync(path.join(source, 'src'));
      fs.writeFileSync(path.join(source, 'src', 'planner.ts'), "const m = 'openai/gpt-6-luna';");
      fs.writeFileSync(path.join(source, 'src', 'judge.ts'), 'export const judge = 1;');
      const before = snapshot(source);

      const files = ['src/planner.ts', 'src/judge.ts'].map((p) => ({ path: `original/${p}`, content: fs.readFileSync(path.join(source, p), 'utf8') }));
      const res = await env.ctx.importer.fromFiles({ name: 'Original', files });

      // The original is byte-for-byte and timestamp-for-timestamp unchanged, and nothing new appeared in it.
      expect(snapshot(source)).toEqual(before);

      // The copy lives under NodePilot's data folder, is labelled, and the workflow says so.
      const project = env.ctx.projects.get(res.projectId);
      expect(path.resolve(project.rootPath).startsWith(path.resolve(env.ctx.cfg.dataDir))).toBe(true);
      expect(path.resolve(project.rootPath)).not.toBe(path.resolve(source));
      expect(fs.existsSync(path.join(project.rootPath, DEMO_MARKER))).toBe(true);
      expect(res.workflow.description).toContain('DEMO COPY');
      // Two plain files are not evidence of an AI pipeline: they are mapped as code structure, with links back to the files.
      expect(res.stats.mode).toBe('structure');
      expect(res.workflow.nodes.some((n) => n.codeRefs.some((c) => c.path === 'src/planner.ts'))).toBe(true);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it('refuses paths that would escape the copy', async () => {
    env = await makeEnv();
    await expect(env.ctx.importer.fromFiles({ name: 'Bad', files: [{ path: 'x/../../evil.ts', content: 'x' }, { path: 'x/ok.ts', content: 'y' }] })).rejects.toThrow(/Invalid file path/);
  });

  it('rejects non-https and credentialed git URLs', async () => {
    env = await makeEnv();
    for (const url of ['file:///d:/PROJECTS/search engine', 'http://example.com/a/b.git', 'https://user:pw@example.com/a/b.git', 'not a url']) {
      await expect(env.ctx.importer.fromGit({ url })).rejects.toThrow(/URL|https/i);
    }
  });

  describe('deleting a project', () => {
    const count = (e: TestEnv, sql: string, id: string) => (e.ctx.db.prepare(sql).get(id) as { n: number }).n;

    it('removes the workflow, everything recorded about it, and the demo copy', async () => {
      env = await makeEnv();
      const res = await env.ctx.importer.fromFiles({ name: 'Gone', files: [{ path: 'gone/src/planner.ts', content: 'export const planner = 1;' }] });
      const id = res.workflow.id;
      const copy = env.ctx.projects.get(res.projectId).rootPath;
      expect(fs.existsSync(copy)).toBe(true);
      // Simulate history: a read-only file (like git objects), a finished run, an audit trail.
      fs.mkdirSync(path.join(copy, '.git', 'objects'), { recursive: true });
      const ro = path.join(copy, '.git', 'objects', 'pack.idx');
      fs.writeFileSync(ro, 'x');
      fs.chmodSync(ro, 0o444);
      env.ctx.db.prepare("INSERT INTO runs (id, workflow_id, workflow_revision, executable_hash, snapshot_json, status, actor, created_at) VALUES ('run_x', ?, 1, 'h', '{}', 'failed', 'ui', 'now')").run(id);
      env.ctx.db.prepare("INSERT INTO run_events (run_id, seq, type, at) VALUES ('run_x', 1, 'run.failed', 'now')").run();
      expect(count(env, 'SELECT COUNT(*) n FROM audit_log WHERE workflow_id = ?', id)).toBeGreaterThan(0);
      expect(count(env, 'SELECT COUNT(*) n FROM run_events WHERE run_id = ?', 'run_x')).toBe(1);

      const del = await env.app.inject({ method: 'DELETE', url: `/api/workflows/${id}`, headers: ui(env) });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ ok: true, removedCopy: true });

      expect(count(env, 'SELECT COUNT(*) n FROM workflows WHERE id = ?', id)).toBe(0);
      expect(count(env, 'SELECT COUNT(*) n FROM audit_log WHERE workflow_id = ?', id)).toBe(0);
      expect(count(env, 'SELECT COUNT(*) n FROM runs WHERE workflow_id = ?', id)).toBe(0);
      expect(count(env, 'SELECT COUNT(*) n FROM run_events WHERE run_id = ?', 'run_x')).toBe(0);
      expect(fs.existsSync(copy)).toBe(false);
      expect(env.ctx.projects.list().some((p) => p.id === res.projectId)).toBe(false);
    });

    it('never deletes a folder outside NodePilot’s own imports, and keeps a copy that another workflow still uses', async () => {
      env = await makeEnv();
      // A real folder you approved yourself.
      const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'np-mine-'));
      try {
        fs.writeFileSync(path.join(mine, 'keep.txt'), 'precious');
        const project = env.ctx.projects.add(mine, 'Mine');
        const wf = env.ctx.store.create({ name: 'Linked to my folder', projectId: project.id }, 'ui');
        const del = await env.app.inject({ method: 'DELETE', url: `/api/workflows/${wf.id}`, headers: ui(env) });
        expect(del.json()).toEqual({ ok: true, removedCopy: false });
        expect(fs.readFileSync(path.join(mine, 'keep.txt'), 'utf8')).toBe('precious');
        expect(env.ctx.projects.list().some((p) => p.id === project.id)).toBe(true);
      } finally {
        fs.rmSync(mine, { recursive: true, force: true });
      }

      // Two workflows sharing one demo copy: the copy stays until the last one is deleted.
      const a = await env.ctx.importer.fromFiles({ name: 'Shared', files: [{ path: 's/src/planner.ts', content: 'export const planner = 1;' }] });
      const b = env.ctx.store.create({ name: 'Second', projectId: a.projectId }, 'ui');
      const copy = env.ctx.projects.get(a.projectId).rootPath;
      expect((await env.app.inject({ method: 'DELETE', url: `/api/workflows/${a.workflow.id}`, headers: ui(env) })).json().removedCopy).toBe(false);
      expect(fs.existsSync(copy)).toBe(true);
      expect((await env.app.inject({ method: 'DELETE', url: `/api/workflows/${b.id}`, headers: ui(env) })).json().removedCopy).toBe(true);
      expect(fs.existsSync(copy)).toBe(false);
    });
  });
});
