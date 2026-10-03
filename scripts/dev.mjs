// Starts the API server (watch mode) and the Vite dev server together.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const procs = [
  ['server', ['run', 'dev', '-w', '@nodepilot/server']],
  ['web', ['run', 'dev', '-w', '@nodepilot/web']],
].map(([name, args]) => {
  const p = spawn(npm, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const tag = (d) => d.toString().split('\n').filter(Boolean).map((l) => `[${name}] ${l}`).join('\n') + '\n';
  p.stdout.on('data', (d) => process.stdout.write(tag(d)));
  p.stderr.on('data', (d) => process.stderr.write(tag(d)));
  p.on('exit', (code) => { console.log(`[${name}] exited with ${code}`); shutdown(); });
  return p;
});
function shutdown() { for (const p of procs) if (p.exitCode === null) p.kill(); process.exit(0); }
process.on('SIGINT', shutdown);
