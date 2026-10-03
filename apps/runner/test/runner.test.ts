import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildArgs, detectClaude, mapPermissionMode, parseStreamLine } from '../src/claude.js';
import { Runner } from '../src/runner.js';
import { makeEnv, ui, type TestEnv } from '../../server/test/helpers.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-repo-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\nuncommitted local edit\n');
  return fs.realpathSync.native(dir);
}

describe('claude CLI integration helpers', () => {
  it('detects capabilities from --help and never maps to bypass modes', () => {
    const caps = detectClaude(FAKE);
    expect(caps.found).toBe(true);
    expect(caps.supportsStreamJson).toBe(true);
    expect(caps.permissionModes).toEqual(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
    expect(mapPermissionMode('default', caps)).toBe('manual');
    expect(() => mapPermissionMode('bypassPermissions', caps)).toThrow(/not allowed/);
    const { args } = buildArgs({ bin: FAKE, caps, cwd: '.', prompt: 'x', permissionMode: 'acceptEdits', allowedTools: [] });
    expect(args).toContain('--permission-prompts');
    expect(args.join(' ')).not.toMatch(/dangerously|bypass/);
    expect(detectClaude('definitely-not-a-real-binary-xyz').found).toBe(false);
  });

  it('parses stream-json results including permission denials', () => {
    const acc = { isError: false, permissionDenials: [] as unknown[] };
    parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }), acc);
    const ev = parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm' } }] }), acc);
    expect(ev.map((e) => e.kind)).toEqual(['permission_denied', 'result']);
    expect((acc as { sessionId?: string }).sessionId).toBe('s1');
  });
});

describe('paired runner end-to-end (fake Claude CLI)', () => {
  it('pairs, shows the task, runs in an isolated worktree and reports diff + tests', async () => {
    env = await makeEnv();
    const address = await env.app.listen({ host: '127.0.0.1', port: 0 });
    env.ctx.cfg.allowedHosts.push(new URL(address).host);
    const repo = makeRepo();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'np-runner-'));
    const logs: string[] = [];
    const runner = new Runner({
      server: address, name: 'test-runner', projects: [repo], claudeBin: FAKE, testCommand: 'node -e "console.log(\'tests ok\')"', testTimeoutMs: 30_000,
      confirm: 'terminal', autoConfirm: true, allowedTools: [], home, log: (m) => logs.push(m),
    });
    await runner.init();

    // Approve the pairing request "in the browser" once it appears, checking the code.
    const approver = (async () => {
      for (let i = 0; i < 100; i++) {
        const pending = env!.ctx.tasks.pendingPairRequests();
        if (pending.length) {
          const bad = await env!.app.inject({ method: 'POST', url: `/api/runner/pair-requests/${pending[0].id}/decide`, headers: ui(env!), payload: { approve: true, code: '000000x' } });
          expect(bad.statusCode).toBe(422);
          const okRes = await env!.app.inject({ method: 'POST', url: `/api/runner/pair-requests/${pending[0].id}/decide`, headers: ui(env!), payload: { approve: true, code: pending[0].code } });
          expect(okRes.statusCode).toBe(200);
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('no pairing request');
    })();
    await runner.pair();
    await approver;
    expect(logs.join('\n')).toMatch(/Pairing code: \d{6}/);
    const runners = env.ctx.tasks.runners();
    expect(runners).toHaveLength(1);

    // A project outside the runner's approved list is refused by the server.
    const refused = await env.app.inject({ method: 'POST', url: '/api/tasks', headers: ui(env), payload: { runnerId: runners[0].id, projectPath: os.tmpdir(), title: 't', prompt: 'p', permissionMode: 'acceptEdits' } });
    expect(refused.statusCode).toBe(403);

    const composed = (await env.app.inject({ method: 'POST', url: '/api/tasks/compose', headers: ui(env), payload: { workflowId: 'example-scene-pipeline', nodeId: 'n_scanner', instruction: 'Improve the scanner' } })).json();
    expect(composed.prompt).toMatch(/UNTRUSTED DATA/);
    expect(composed.prompt).toMatch(/<untrusted_context>/);
    const created = await env.app.inject({
      method: 'POST', url: '/api/tasks', headers: ui(env),
      payload: { runnerId: runners[0].id, projectPath: repo, title: composed.title, prompt: composed.prompt, permissionMode: 'acceptEdits', runTests: true, workflowId: 'example-scene-pipeline', nodeId: 'n_scanner' },
    });
    expect(created.statusCode).toBe(200);
    const taskId = created.json().id;

    await runner.loop({ once: true });
    runner.stop();

    const task = env.ctx.tasks.get(taskId);
    expect(task.status).toBe('completed');
    const result = task.result as Record<string, any>;
    expect(result.diff).toMatch(/\+# Fake change/);
    expect(result.changedFiles.join('\n')).toMatch(/NOTE\.md/);
    expect(result.tests.exitCode).toBe(0);
    expect(result.testOutput).toMatch(/tests ok/);
    expect(result.claude.permissionDenials).toHaveLength(1);
    expect(task.statusDetail).toMatch(/1 permission request\(s\) were denied/);
    // the original checkout is untouched: still has its uncommitted edit and no NOTE.md
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toMatch(/uncommitted local edit/);
    expect(fs.existsSync(path.join(repo, 'NOTE.md'))).toBe(false);
    expect(result.originalHadUncommittedChanges).toBe(true);
    // the fake CLI received a safe argument list
    const fakeArgs = JSON.parse(fs.readFileSync(path.join(result.worktreePath, 'fake-args.json'), 'utf8')) as string[];
    expect(fakeArgs).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none']));
    const kinds = env.ctx.tasks.events(taskId).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['system', 'assistant', 'tool_use', 'permission_denied', 'result']));
  }, 60_000);

  it('cancels a running task and stops the CLI', async () => {
    env = await makeEnv();
    const address = await env.app.listen({ host: '127.0.0.1', port: 0 });
    env.ctx.cfg.allowedHosts.push(new URL(address).host);
    const repo = makeRepo();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'np-runner-'));
    const runner = new Runner({ server: address, name: 'r', projects: [repo], claudeBin: FAKE, testTimeoutMs: 1000, confirm: 'browser', allowedTools: [], home, log: () => {} });
    await runner.init();
    const approver = setInterval(() => {
      const p = env!.ctx.tasks.pendingPairRequests()[0];
      if (p) env!.ctx.tasks.decidePairRequest(p.id, true, p.code);
    }, 50);
    await runner.pair();
    clearInterval(approver);
    const runnerId = env.ctx.tasks.runners()[0].id;
    const task = env.ctx.tasks.create({ runnerId, projectPath: repo, title: 'slow', prompt: 'SLOW task', permissionMode: 'plan', runTests: false });
    const done = runner.loop({ once: true });
    for (let i = 0; i < 100 && env.ctx.tasks.get(task.id).status !== 'running'; i++) await new Promise((r) => setTimeout(r, 100));
    expect(env.ctx.tasks.get(task.id).status).toBe('running');
    env.ctx.tasks.requestCancel(task.id);
    const t0 = Date.now();
    await done;
    runner.stop();
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(env.ctx.tasks.get(task.id).status).toBe('cancelled');
  }, 60_000);
});
