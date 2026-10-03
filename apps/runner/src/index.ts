#!/usr/bin/env node
import os from 'node:os';
import { parseArgs } from 'node:util';
import { defaultHome, Runner } from './runner.js';

const HELP = `NodePilot local Claude runner

Usage:
  npm run runner -- --project <dir> [--project <dir> ...] [options]

Options:
  --server <url>        NodePilot server (default http://127.0.0.1:4317)
  --project <dir>       Approve a project directory (git repository). Repeatable. Required.
  --test-cmd <cmd>      Test command run in the worktree when a task asks for tests (e.g. "npm test").
                        The website can only toggle it; it can never supply its own command.
  --test-timeout <sec>  Test timeout in seconds (default 600)
  --confirm <mode>      "terminal" (default): show each task here and ask y/N before running.
                        "browser": trust the approval given in the browser.
  --allow-tool <rule>   Pre-approve a Claude Code tool rule, e.g. "Bash(npm test)". Repeatable.
                        Everything else follows Claude Code's normal permission rules; in headless
                        mode requests that would prompt are denied and reported.
  --claude-bin <path>   Claude Code executable (default "claude")
  --name <name>         Runner display name (default: hostname)
  --home <dir>          Runner state directory (default ~/.nodepilot-runner)
  -h, --help            Show this help

The runner never uses permission-bypass flags, never pushes or merges, and never
sends your Claude credentials anywhere: Claude Code uses its own local login.`;

const { values } = parseArgs({
  options: {
    server: { type: 'string', default: process.env.NODEPILOT_URL ?? 'http://127.0.0.1:4317' },
    project: { type: 'string', multiple: true, default: [] },
    'test-cmd': { type: 'string' },
    'test-timeout': { type: 'string', default: '600' },
    confirm: { type: 'string', default: 'terminal' },
    'allow-tool': { type: 'string', multiple: true, default: [] },
    'claude-bin': { type: 'string', default: 'claude' },
    name: { type: 'string', default: os.hostname() },
    home: { type: 'string', default: defaultHome() },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || values.project!.length === 0) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}
if (values.confirm !== 'terminal' && values.confirm !== 'browser') {
  console.error('--confirm must be "terminal" or "browser"');
  process.exit(1);
}
for (const t of values['allow-tool']!) {
  if (/dangerously|bypass/i.test(t)) {
    console.error(`Refusing --allow-tool "${t}"`);
    process.exit(1);
  }
}

const runner = new Runner({
  server: values.server!,
  name: values.name!,
  projects: values.project!,
  claudeBin: values['claude-bin']!,
  testCommand: values['test-cmd'],
  testTimeoutMs: Number(values['test-timeout']) * 1000,
  confirm: values.confirm,
  allowedTools: values['allow-tool']!,
  home: values.home!,
});

process.on('SIGINT', () => {
  console.log('\n[runner] stopping');
  runner.stop();
  process.exit(0);
});

try {
  await runner.init();
  await runner.pair();
  await runner.loop();
} catch (e) {
  console.error(`[runner] ${(e as Error).message}`);
  process.exit(1);
}
