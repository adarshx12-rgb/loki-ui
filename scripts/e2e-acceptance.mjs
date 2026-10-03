// End-to-end acceptance flow in a real browser (installed Chrome/Edge via playwright-core).
//
//   create a node in the UI → modify it via the real stdio MCP server → see the live canvas update
//   → run the demo → inspect the failing node → pair a runner → submit an approved Claude task
//   → view its diff and test results.
//
// Requires a built tree (npm run build) and a running server (npm start).
// By default the runner uses the FAKE Claude CLI test fixture (no paid calls) and says so.
// Set E2E_CLAUDE_BIN=claude to use the real Claude Code CLI instead.
//
//   node scripts/e2e-acceptance.mjs [screenshotDir]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.NODEPILOT_URL ?? 'http://127.0.0.1:4317';
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'nodepilot-e2e'));
fs.mkdirSync(shots, { recursive: true });
const CLAUDE_BIN = process.env.E2E_CLAUDE_BIN ?? path.join(root, 'apps/runner/test/fake-claude.mjs');
const usingFake = CLAUDE_BIN.endsWith('fake-claude.mjs');
const log = (...a) => console.log('[e2e]', ...a);
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    log(`✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    log(`✕ ${name}: ${e.message}`);
    throw e;
  }
};

function findBrowser() {
  const candidates = [
    process.env.E2E_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c));
}

const exe = findBrowser();
if (!exe) {
  console.error('No Chrome/Edge found; set E2E_BROWSER');
  process.exit(2);
}

// --- pairing code (issued directly by the server CLI, as a user would) ---
const pairOut = execFileSync(process.execPath, [path.join(root, 'apps/server/dist/index.js'), 'pair'], { encoding: 'utf8' });
const code = /pairing code: (\S+)/.exec(pairOut)?.[1];

const browser = await chromium.launch({ executablePath: exe, headless: process.env.E2E_HEADED ? false : true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, reducedMotion: 'no-preference' });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.message));
const shot = (n) => page.screenshot({ path: path.join(shots, `${n}.png`) });

let mcp;
let runnerProc;
let newNodeId;
let workflowId;
try {
  await step('pair browser with code from server terminal', async () => {
    await page.goto(BASE);
    await page.getByLabel('Pairing code').fill(code);
    await page.getByRole('button', { name: 'Pair this browser' }).click();
    await page.locator('.np-node').first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    await shot('01-workspace');
  });

  await step('create a node in the UI (on an imported copy of the example), undo + redo it with the keyboard', async () => {
    // Work on a copy so the seeded example stays pristine.
    workflowId = await page.evaluate(async () => {
      const ex = await (await fetch('/api/workflows/example-scene-pipeline')).json();
      const doc = { ...ex.workflow, id: 'e2e-' + Date.now().toString(36), name: 'E2E acceptance copy' };
      const r = await fetch('/api/workflows/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) });
      return (await r.json()).id;
    });
    await page.selectOption('select[aria-label="Workflow"]', workflowId);
    await page.locator('.np-node').first().waitFor();
    const before = await page.locator('.np-node').count();
    await page.getByLabel('Search node types').fill('judge');
    await page.locator('.palette-item').filter({ has: page.locator('.palette-label', { hasText: /^Judge$/ }) }).click();
    await page.waitForFunction((n) => document.querySelectorAll('.np-node').length === n + 1, before);
    // undo / redo of the creation via keyboard
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Control+z');
    await page.waitForFunction((n) => document.querySelectorAll('.np-node').length === n, before);
    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction((n) => document.querySelectorAll('.np-node').length === n + 1, before);
    newNodeId = await page.evaluate(async (id) => {
      const r = await (await fetch(`/api/workflows/${id}`)).json();
      return r.workflow.nodes.at(-1).id;
    }, workflowId);
    await shot('02-node-created');
  });

  await step('modify the node through the real stdio MCP server (Claude Code path)', async () => {
    mcp = new Client({ name: 'e2e', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'apps/mcp/dist/index.js')], env: { ...process.env, NODEPILOT_URL: BASE }, stderr: 'pipe' });
    await mcp.connect(transport);
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    if (!tools.includes('apply_workflow_patch')) throw new Error('MCP tools missing');
    const wf = JSON.parse((await mcp.callTool({ name: 'get_workflow', arguments: { workflowId } })).content[0].text).workflow;
    const r = await mcp.callTool({
      name: 'apply_workflow_patch',
      arguments: {
        workflowId,
        baseRevision: wf.revision,
        ops: [
          { op: 'update_node', nodeId: newNodeId, changes: { label: 'Judge: style (edited via MCP)', config: { params: { criterion: 'style' }, demo: { failMode: 'error', latencyMs: 100 } } } },
          { op: 'add_edge', edge: { id: 'e_mcp_in', source: 'n_scene_worker', sourcePort: 'scene', target: newNodeId, targetPort: 'scene' } },
          { op: 'add_edge', edge: { id: 'e_mcp_out', source: newNodeId, sourcePort: 'score', target: 'n_score_combiner', targetPort: 'scores' } },
        ],
      },
    });
    if (r.isError) throw new Error(r.content[0].text);
    await mcp.callTool({ name: 'add_node_note', arguments: { workflowId, nodeId: newNodeId, text: 'Added by the **e2e** acceptance script through MCP.' } });
  });

  await step('canvas updates live (no reload) with the MCP change', async () => {
    await page.locator('.np-node', { hasText: 'Judge: style (edited via MCP)' }).waitFor({ timeout: 5000 });
    await page.locator('.toast', { hasText: 'Claude Code (MCP)' }).first().waitFor({ timeout: 5000 });
    await shot('03-live-mcp-update');
  });

  await step('run the demo; the injected fault fails the new node and blocks downstream', async () => {
    await page.getByRole('button', { name: '▶ Run' }).click();
    await page.locator('.toolbar .chip', { hasText: 'Failed' }).waitFor({ timeout: 15_000 });
    const failed = page.locator('.np-node.st-failed', { hasText: 'Judge: style' });
    await failed.waitFor();
    await page.locator('.np-node.st-skipped', { hasText: 'Score combiner' }).waitFor();
    await page.locator('.np-node.st-succeeded', { hasText: 'Judge: tension' }).waitFor();
    await shot('04-run-failed');
  });

  await step('inspect the failing node (errors & events)', async () => {
    await page.locator('.np-node', { hasText: 'Judge: style' }).click();
    await page.getByRole('tab', { name: 'Errors & events' }).click();
    await page.locator('.banner.fail', { hasText: 'Demo fault injection' }).waitFor();
    await page.getByRole('tab', { name: 'Notes' }).click();
    await page.locator('.markdown strong', { hasText: 'e2e' }).waitFor();
    await page.getByRole('tab', { name: 'Errors & events' }).click();
    await shot('05-inspect-failing-node');
  });

  await step(`pair a local runner (${usingFake ? 'FAKE Claude CLI test fixture' : 'real Claude Code CLI'})`, async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'np-e2e-repo-'));
    const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
    g('init', '-q'); g('config', 'user.email', 'e2e@example.com'); g('config', 'user.name', 'E2E');
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo repo\n');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node -e "console.log(\'1 test passed\')"' } }, null, 2));
    g('add', '.'); g('commit', '-qm', 'init');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'np-e2e-runner-'));
    runnerProc = spawn(process.execPath, [path.join(root, 'apps/runner/dist/index.js'), '--server', BASE, '--project', repo, '--confirm', 'browser', '--claude-bin', CLAUDE_BIN, '--test-cmd', 'npm test', '--home', home, '--name', 'e2e-runner'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    runnerProc.stdout.on('data', (d) => { out += d; process.stdout.write(`[runner] ${d}`); });
    runnerProc.stderr.on('data', (d) => process.stderr.write(`[runner] ${d}`));
    for (let i = 0; i < 100 && !/Pairing code: (\d{6})/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    const runnerCode = /Pairing code: (\d{6})/.exec(out)?.[1];
    if (!runnerCode) throw new Error('runner did not print a pairing code');
    await page.getByRole('button', { name: '⚯ Connections' }).click();
    await page.getByRole('tab', { name: 'Claude runner' }).click();
    await page.getByLabel('Pairing code').waitFor({ timeout: 8000 });
    await page.getByLabel('Pairing code').fill(runnerCode);
    await shot('06-runner-pairing');
    await page.getByRole('button', { name: 'Approve' }).click();
    for (let i = 0; i < 100 && !out.includes('paired ✓'); i++) await new Promise((r) => setTimeout(r, 100));
    if (!out.includes('paired ✓')) throw new Error('runner was not paired');
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Close' }).click();
  });

  await step('Ask Claude on the failing node → review → approve task', async () => {
    await page.locator('.np-node', { hasText: 'Judge: style' }).click();
    await page.locator('.insp-head').getByRole('button', { name: '✦ Ask Claude' }).click();
    if (!usingFake) {
      await page.locator('.modal textarea').first().fill('Create a file named NODEPILOT_CHECK.md containing exactly one line: "hello from NodePilot". Do not change anything else. Do not run any commands.');
    }
    await page.getByRole('button', { name: 'Prepare task for review →' }).click();
    await page.locator('.modal textarea.mono').waitFor();
    const text = await page.locator('.modal textarea.mono').inputValue();
    if (!text.includes('<untrusted_context>')) throw new Error('task text lacks untrusted context framing');
    await page.locator('.modal select').nth(2).selectOption('acceptEdits');
    await shot('07-task-review');
    await page.getByRole('button', { name: 'Approve & send to runner' }).click();
  });

  await step('view the resulting diff and test results', async () => {
    await page.locator('.modal .chip', { hasText: /Completed|Failed/ }).waitFor({ timeout: usingFake ? 30_000 : 240_000 });
    const status = await page.locator('.modal .chip').first().innerText();
    await shot('08-task-progress');
    await page.getByRole('tab', { name: /^Diff/ }).click();
    await page.locator('.diff .add').first().waitFor({ timeout: 5000 });
    await shot('09-task-diff');
    await page.getByRole('tab', { name: 'Tests' }).click();
    await shot('10-task-tests');
    if (!status.includes('Completed')) throw new Error(`task ended with ${status}`);
  });

  await step('keyboard: fit view and help dialog', async () => {
    await page.getByRole('button', { name: 'Close' }).click();
    await page.locator('.react-flow__pane').click({ position: { x: 30, y: 30 } });
    await page.keyboard.press('f');
    await page.keyboard.press('?');
    await page.locator('.modal', { hasText: 'Keyboard shortcuts' }).waitFor();
    await page.keyboard.press('Escape');
  });
} finally {
  await mcp?.close().catch(() => {});
  runnerProc?.kill();
  await browser.close();
  const report = { usingFakeClaude: usingFake, results, consoleErrors, screenshots: shots };
  fs.writeFileSync(path.join(shots, 'report.json'), JSON.stringify(report, null, 2));
  log(JSON.stringify(report, null, 2));
}
