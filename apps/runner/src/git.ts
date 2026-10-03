import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function git(cwd: string, args: string[], opts: { maxBuffer?: number } = {}): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args[0]} failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 1000)}`);
  return r.stdout;
}

export interface Worktree {
  repoRoot: string;
  path: string;
  /** Where Claude runs (the project sub-directory inside the worktree). */
  cwd: string;
  branch: string;
  baseCommit: string;
  originalHadUncommittedChanges: boolean;
}

/**
 * Creates an isolated worktree on a new branch from HEAD. The original checkout,
 * including any uncommitted changes, is never modified.
 */
export function createWorktree(projectPath: string, worktreesDir: string, taskId: string): Worktree {
  const repoRoot = path.resolve(git(projectPath, ['rev-parse', '--show-toplevel']).trim());
  let baseCommit: string;
  try {
    baseCommit = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  } catch {
    throw new Error('The repository has no commits yet; commit once before running Claude tasks.');
  }
  const originalHadUncommittedChanges = git(repoRoot, ['status', '--porcelain']).trim().length > 0;
  const branch = `nodepilot/${taskId}`;
  fs.mkdirSync(worktreesDir, { recursive: true });
  const wt = path.join(worktreesDir, `${path.basename(repoRoot)}-${taskId}`);
  git(repoRoot, ['worktree', 'add', '-b', branch, wt, baseCommit]);
  const rel = path.relative(repoRoot, path.resolve(projectPath));
  return { repoRoot, path: wt, cwd: rel ? path.join(wt, rel) : wt, branch, baseCommit, originalHadUncommittedChanges };
}

/** Diff of everything in the worktree relative to the base commit, including new untracked files. */
export function collectDiff(wt: Worktree, maxBytes = 900_000): { diff: string; stat: string; files: string[]; truncated: boolean } {
  git(wt.path, ['add', '--intent-to-add', '--all']);
  const stat = git(wt.path, ['diff', '--stat', wt.baseCommit]);
  const files = git(wt.path, ['diff', '--name-status', wt.baseCommit]).trim().split('\n').filter(Boolean);
  let diff = git(wt.path, ['diff', '--no-color', '--no-ext-diff', wt.baseCommit]);
  const truncated = diff.length > maxBytes;
  if (truncated) diff = diff.slice(0, maxBytes) + `\n… diff truncated (${diff.length} bytes total). Inspect the worktree for the rest.\n`;
  return { diff, stat, files, truncated };
}

/** Runs the runner-configured test command (never a command supplied by the website). */
export function runTests(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env });
    let output = '';
    const add = (b: Buffer) => {
      output += b.toString();
      if (output.length > 400_000) output = output.slice(-200_000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let timedOut = false;
    const kill = () => {
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    };
    const t = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ exitCode: code, output: output.slice(-200_000), timedOut });
    });
  });
}
