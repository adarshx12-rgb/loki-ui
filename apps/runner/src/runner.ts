import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { redactString } from '@nodepilot/shared';
import { resolveWithinRoots } from '@nodepilot/shared/node';
import { buildArgs, detectClaude, killTree, parseStreamLine, spawnClaude, type ClaudeCapabilities, type ClaudeResult } from './claude.js';
import { collectDiff, createWorktree, runTests, type Worktree } from './git.js';

export interface RunnerOptions {
  server: string;
  name: string;
  projects: string[];
  claudeBin: string;
  testCommand?: string;
  testTimeoutMs: number;
  confirm: 'terminal' | 'browser';
  allowedTools: string[];
  home: string;
  /** For tests: answer local confirmation prompts automatically. */
  autoConfirm?: boolean;
  log?: (msg: string) => void;
}

interface Task {
  id: string;
  title: string;
  prompt: string;
  projectPath: string;
  permissionMode: string;
  runTests: boolean;
  resume?: { sessionId?: string; worktreePath?: string };
}

type EventIn = { kind: string; text: string; data?: unknown };

export class Runner {
  private token?: string;
  private caps!: ClaudeCapabilities;
  private stopped = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private log: (m: string) => void;
  /** Number of tasks processed (tests). */
  processed = 0;

  constructor(private o: RunnerOptions) {
    this.log = o.log ?? ((m) => console.log(m));
  }

  get tokenFile() {
    const key = Buffer.from(this.o.server).toString('base64url').slice(0, 40);
    return path.join(this.o.home, `token-${key}.json`);
  }

  info() {
    return {
      name: this.o.name,
      projects: this.o.projects,
      claude: {
        found: this.caps.found,
        version: this.caps.version,
        supportsStreamJson: this.caps.supportsStreamJson,
        supportsPermissionPrompts: this.caps.supportsPermissionPrompts,
        supportsResume: this.caps.supportsResume,
        permissionModes: this.caps.permissionModes,
        error: this.caps.error,
      },
      testCommand: this.o.testCommand,
      confirmMode: this.o.confirm,
      platform: process.platform,
    };
  }

  private async http<T>(method: string, p: string, body?: unknown, auth = true): Promise<{ status: number; json: T }> {
    const res = await fetch(new URL(p, this.o.server), {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(auth && this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : undefined) as T };
  }

  /** Retries transient network failures with backoff; used for anything that must eventually reach the server. */
  private async reliably<T>(fn: () => Promise<T>, what: string, maxMs = 3600_000): Promise<T> {
    const start = Date.now();
    let delay = 1000;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        if (Date.now() - start > maxMs) throw e;
        this.log(`[runner] server unreachable while ${what} (${(e as Error).message}); retrying in ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  async init() {
    fs.mkdirSync(this.o.home, { recursive: true, mode: 0o700 });
    this.o.projects = this.o.projects.map((p) => {
      const real = fs.realpathSync.native(path.resolve(p));
      if (!fs.statSync(real).isDirectory()) throw new Error(`Not a directory: ${p}`);
      return real;
    });
    if (this.o.projects.length === 0) throw new Error('Approve at least one project directory with --project <dir>');
    this.caps = detectClaude(this.o.claudeBin);
    if (!this.caps.found || this.caps.error) this.log(`[runner] WARNING: ${this.caps.error}`);
    else this.log(`[runner] Claude Code ${this.caps.version} (stream-json ✓, permission modes: ${this.caps.permissionModes?.join(', ') || 'unknown'})`);
    try {
      this.token = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')).token;
    } catch {
      this.token = undefined;
    }
  }

  /** Pairs with the server if needed. The user must approve the shown code in the browser. */
  async pair(): Promise<void> {
    if (this.token) {
      const r = await this.reliably(() => this.http('POST', '/api/runner/heartbeat', this.info()), 'checking pairing');
      if (r.status === 200) return;
      this.log('[runner] stored token was rejected; pairing again');
      this.token = undefined;
    }
    const req = await this.reliably(() => this.http<{ requestId: string; pollSecret: string; code: string; error?: string; message?: string }>('POST', '/api/runner/pair-requests', this.info(), false), 'requesting pairing');
    if (req.status !== 200) throw new Error(`Pairing request failed: ${req.json.message ?? req.status}`);
    this.log(`\n  Pairing code: ${req.json.code}\n  Open NodePilot → Connections → Claude runner, check that the code matches, and approve.\n`);
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await this.reliably(() => this.http<{ status: string; token?: string }>('POST', `/api/runner/pair-requests/${req.json.requestId}/collect`, { pollSecret: req.json.pollSecret }, false), 'waiting for approval');
      if (r.json.status === 'approved' && r.json.token) {
        this.token = r.json.token;
        fs.writeFileSync(this.tokenFile, JSON.stringify({ token: this.token, server: this.o.server }), { mode: 0o600 });
        this.log('[runner] paired ✓');
        return;
      }
      if (r.json.status === 'denied' || r.json.status === 'expired' || r.json.status === 'collected') throw new Error(`Pairing ${r.json.status}`);
    }
  }

  private startHeartbeat() {
    const beat = async () => {
      try {
        const r = await this.http('POST', '/api/runner/heartbeat', this.info());
        if (r.status === 401) this.log('[runner] server no longer accepts this runner token (revoked?). Restart the runner to pair again.');
      } catch {
        /* disconnected; next beat retries */
      }
    };
    this.heartbeatTimer = setInterval(beat, 15_000);
    this.heartbeatTimer.unref();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
  }

  async loop(opts: { once?: boolean } = {}) {
    this.startHeartbeat();
    this.log(`[runner] waiting for tasks (approved projects: ${this.o.projects.join(', ')})`);
    while (!this.stopped) {
      let task: Task | null = null;
      try {
        const r = await this.http<{ task: Task | null }>('GET', `/api/runner/next?waitMs=${opts.once ? 2000 : 20000}`);
        if (r.status === 401) throw new Error('Runner token rejected; restart the runner to pair again');
        task = r.json.task;
      } catch (e) {
        if ((e as Error).message.includes('token rejected')) throw e;
        this.log(`[runner] disconnected from server (${(e as Error).message}); retrying…`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (task) {
        await this.handle(task).catch((e) => this.log(`[runner] task ${task!.id} crashed: ${(e as Error).message}`));
        this.processed++;
      }
      if (opts.once && (task || this.processed > 0)) return;
    }
  }

  // ---------------- task execution ----------------

  private async handle(task: Task) {
    const events: EventIn[] = [];
    let cancelRequested = false;
    let flushing: Promise<void> | null = null;
    const flush = async () => {
      if (!events.length) return;
      const batch = events.splice(0, 200);
      try {
        const r = await this.http<{ cancelRequested?: boolean }>('POST', `/api/runner/tasks/${task.id}/events`, { events: batch });
        if (r.json?.cancelRequested) cancelRequested = true;
      } catch {
        events.unshift(...batch); // keep for retry (bounded below)
        if (events.length > 5000) events.splice(0, events.length - 5000);
      }
    };
    const emit = (kind: string, text: string, data?: unknown) => {
      events.push({ kind, text: redactString(text), data });
      if (!flushing) flushing = new Promise((r) => setTimeout(r, 400)).then(flush).finally(() => (flushing = null));
    };
    const status = (s: string, extra: Record<string, unknown> = {}) =>
      this.reliably(async () => {
        await flush();
        const r = await this.http<{ message?: string }>('POST', `/api/runner/tasks/${task.id}/status`, { status: s, ...extra });
        if (r.status >= 400) this.log(`[runner] server refused status ${s}: ${r.json?.message}`);
        return r;
      }, `reporting status ${s}`);

    // 1. Validate the project against this runner's approved directories (realpath, symlink-safe).
    let projectPath: string;
    try {
      projectPath = resolveWithinRoots(this.o.projects, task.projectPath, { mustExist: true }).path;
    } catch (e) {
      emit('error', `Project rejected by runner: ${(e as Error).message}`);
      await status('failed', { detail: 'Project directory is not approved by this runner' });
      return;
    }
    if (!this.caps.found || this.caps.error) {
      emit('error', this.caps.error ?? 'Claude Code CLI unavailable');
      await status('failed', { detail: this.caps.error });
      return;
    }

    // 2. Show the task locally before anything executes.
    this.log(`\n================ NodePilot task ${task.id} ================`);
    this.log(`Title:            ${task.title}`);
    this.log(`Project:          ${projectPath}`);
    this.log(`Permission mode:  ${task.permissionMode}${this.o.allowedTools.length ? `   pre-approved tools: ${this.o.allowedTools.join(', ')}` : ''}`);
    this.log(`Run tests:        ${task.runTests ? this.o.testCommand ?? '(no --test-cmd configured)' : 'no'}`);
    if (task.resume?.sessionId) this.log(`Resumes session:  ${task.resume.sessionId}`);
    this.log(`---------------- prompt ----------------\n${task.prompt}\n----------------------------------------`);
    if (this.o.confirm === 'terminal') {
      await status('awaiting_local_confirmation', { detail: 'Waiting for approval in the runner terminal' });
      const yes = this.o.autoConfirm ?? (await askYesNo('Run this task with Claude Code? [y/N] '));
      if (!yes) {
        emit('status', 'Declined in the runner terminal');
        await status('rejected', { detail: 'Declined in the runner terminal' });
        return;
      }
    } else {
      this.log('(--confirm browser: the task was approved in the browser; starting)');
    }

    // 3. Isolated worktree (or reuse the parent's when continuing a session).
    let wt: Worktree;
    try {
      if (task.resume?.worktreePath && fs.existsSync(task.resume.worktreePath)) {
        const prev = JSON.parse(fs.readFileSync(path.join(this.o.home, 'worktrees', `${path.basename(task.resume.worktreePath)}.json`), 'utf8')) as Worktree;
        wt = prev;
      } else {
        wt = createWorktree(projectPath, path.join(this.o.home, 'worktrees'), task.id);
        fs.writeFileSync(path.join(this.o.home, 'worktrees', `${path.basename(wt.path)}.json`), JSON.stringify(wt));
      }
    } catch (e) {
      emit('error', `Could not create a git worktree: ${(e as Error).message}`);
      await status('failed', { detail: `Worktree creation failed: ${(e as Error).message}` });
      return;
    }
    emit('status', `Worktree ${wt.path} on branch ${wt.branch} (base ${wt.baseCommit.slice(0, 10)})${wt.originalHadUncommittedChanges ? '. Note: your original checkout has uncommitted changes; they are untouched and NOT included in this worktree.' : ''}`);

    // 4. Run Claude Code.
    let built: { args: string[]; sessionId: string };
    try {
      built = buildArgs({ bin: this.o.claudeBin, caps: this.caps, cwd: wt.cwd, prompt: task.prompt, permissionMode: task.permissionMode, allowedTools: this.o.allowedTools, resumeSessionId: task.resume?.sessionId });
    } catch (e) {
      emit('error', (e as Error).message);
      await status('failed', { detail: (e as Error).message });
      return;
    }
    await status('running', { sessionId: built.sessionId, detail: `claude ${built.args.join(' ')}` });
    const acc: ClaudeResult = { isError: false, permissionDenials: [] };
    const child = spawnClaude({ bin: this.o.claudeBin, caps: this.caps, cwd: wt.cwd, prompt: task.prompt, permissionMode: task.permissionMode, allowedTools: this.o.allowedTools }, built.args);
    let stderr = '';
    child.stderr!.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-20_000); });
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      for (const ev of parseStreamLine(line, acc)) {
        emit(ev.kind, ev.text, ev.data);
        if (ev.kind !== 'log') this.log(`[claude:${ev.kind}] ${ev.text.split('\n')[0].slice(0, 200)}`);
      }
    });
    const control = setInterval(async () => {
      try {
        const r = await this.http<{ cancelRequested?: boolean }>('GET', `/api/runner/tasks/${task.id}/control`);
        if (r.json?.cancelRequested) cancelRequested = true;
      } catch { /* disconnected: keep working, events are buffered */ }
      if (cancelRequested) killTree(child);
    }, 2000);
    const exitCode: number | null = await new Promise((resolve) => {
      child.on('error', (e) => { stderr += `\n${e.message}`; resolve(null); });
      child.on('close', (code) => resolve(code));
    });
    clearInterval(control);
    rl.close();
    await flush();
    if (stderr.trim()) emit('log', `stderr: ${stderr.trim().slice(-4000)}`);

    // 5. Collect diff (and run tests) regardless of outcome so the user can review partial work.
    let diff: ReturnType<typeof collectDiff> | undefined;
    try {
      diff = collectDiff(wt);
    } catch (e) {
      emit('error', `Could not compute diff: ${(e as Error).message}`);
    }
    const resultBase = {
      worktreePath: wt.path,
      branch: wt.branch,
      baseCommit: wt.baseCommit,
      originalHadUncommittedChanges: wt.originalHadUncommittedChanges,
      claudeVersion: this.caps.version,
      sessionId: acc.sessionId ?? built.sessionId,
      exitCode,
      claude: { isError: acc.isError, subtype: acc.subtype, resultText: acc.resultText, costUsd: acc.costUsd, numTurns: acc.numTurns, durationMs: acc.durationMs, permissionDenials: acc.permissionDenials },
      diff: diff?.diff ?? '',
      diffStat: diff?.stat ?? '',
      changedFiles: diff?.files ?? [],
      diffTruncated: diff?.truncated ?? false,
      // Two separate commands (works in POSIX shells, cmd and PowerShell alike).
      cleanup: `git -C "${wt.repoRoot}" worktree remove "${wt.path}"\ngit -C "${wt.repoRoot}" branch -D ${wt.branch}`,
      note: 'Nothing was merged, pushed or applied to your original checkout. Review the worktree and merge manually if you want these changes.',
    };
    this.saveLocal(task.id, resultBase);

    if (cancelRequested) {
      await status('cancelled', { detail: 'Cancelled by the user; Claude was stopped', result: resultBase });
      return;
    }
    const claudeFailed = exitCode !== 0 || acc.isError;
    let tests: { command: string; exitCode: number | null; output: string; timedOut: boolean } | undefined;
    if (task.runTests && this.o.testCommand && !claudeFailed) {
      await status('testing', { detail: this.o.testCommand });
      const ac = new AbortController();
      const r = await runTests(this.o.testCommand, wt.cwd, this.o.testTimeoutMs, ac.signal);
      tests = { command: this.o.testCommand, ...r };
      emit('log', `Tests ${r.timedOut ? 'timed out' : `exited with ${r.exitCode}`}`);
    } else if (task.runTests && !this.o.testCommand) {
      emit('log', 'Tests requested but the runner has no --test-cmd configured; skipped.');
    }
    const result = {
      ...resultBase,
      tests: tests ?? null,
      testOutput: tests?.output,
    };
    this.saveLocal(task.id, result);
    const denied = acc.permissionDenials.length;
    const detail = claudeFailed
      ? `Claude exited with ${exitCode === null ? 'an error starting the process' : `code ${exitCode}`}${acc.subtype ? ` (${acc.subtype})` : ''}${denied ? `; ${denied} permission request(s) were denied` : ''}`
      : `${diff?.files.length ?? 0} file(s) changed${denied ? `; ${denied} permission request(s) were denied` : ''}${tests ? `; tests ${tests.timedOut ? 'timed out' : tests.exitCode === 0 ? 'passed' : 'failed'}` : ''}`;
    await status(claudeFailed ? 'failed' : 'completed', { detail, result });
    this.log(`[runner] task ${task.id} ${claudeFailed ? 'failed' : 'completed'}: ${detail}\n  worktree: ${wt.path}\n  cleanup:  ${resultBase.cleanup}`);
  }

  private saveLocal(taskId: string, result: unknown) {
    const dir = path.join(this.o.home, 'results');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${taskId}.json`), JSON.stringify(result, null, 2));
  }
}

function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log('[runner] stdin is not a terminal; cannot ask for confirmation. Declining. (Use --confirm browser to trust browser approval.)');
    return Promise.resolve(false);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); }));
}

export function defaultHome() {
  return process.env.NODEPILOT_RUNNER_HOME ?? path.join(os.homedir(), '.nodepilot-runner');
}
