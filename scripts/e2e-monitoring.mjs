// Browser check of backend monitoring with the example instrumented backend.
// Creates a service + ingest token and a health target in the UI, starts the example
// backend with that token, triggers one good and one failing external run, and checks
// that the UI shows them as OBSERVED telemetry with separate indicators.
//
//   node scripts/e2e-monitoring.mjs [screenshotDir]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.NODEPILOT_URL ?? 'http://127.0.0.1:4317';
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'nodepilot-e2e'));
fs.mkdirSync(shots, { recursive: true });
const exe = [process.env.E2E_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((p) => fs.existsSync(p));
const code = /pairing code: (\S+)/.exec(execFileSync(process.execPath, [path.join(root, 'apps/server/dist/index.js'), 'pair'], { encoding: 'utf8' }))[1];
const log = (...a) => console.log('[e2e-monitoring]', ...a);

const browser = await chromium.launch({ executablePath: exe, headless: true });
// Reduced motion on: verifies nothing depends on animation.
const page = await (await browser.newContext({ viewport: { width: 1600, height: 960 }, reducedMotion: 'reduce' })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let backend;
try {
  await page.goto(BASE);
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.locator('.np-node').first().waitFor();
  await page.selectOption('select[aria-label="Workflow"]', 'example-scene-pipeline');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, '11-workspace-example.png') });

  await page.getByRole('button', { name: '⚯ Connections' }).click();
  await page.getByRole('tab', { name: 'Backends' }).click();
  const sid = 'example-backend-' + Date.now().toString(36);
  await page.getByLabel('Service id').first().fill(sid);
  await page.getByRole('button', { name: 'Create & get token' }).click();
  const token = (await page.locator('.banner .mono.sel-all').innerText()).trim();
  if (!token.startsWith('npi_')) throw new Error('no ingest token shown');
  log('ingest token issued (shown once in UI)');

  backend = spawn(process.execPath, [path.join(root, 'examples/instrumented-backend/dist/index.js')], { env: { ...process.env, NODEPILOT_INGEST_TOKEN: token, EXAMPLE_PORT: '4400', GIT_SHA: 'abc1234def' }, stdio: 'pipe' });
  await new Promise((r) => setTimeout(r, 800));
  await page.getByLabel('Target URL').fill('http://127.0.0.1:4400/health');
  await page.getByLabel('Service id').nth(1).fill(sid);
  await page.getByRole('button', { name: 'Approve & add' }).click();
  // A blocked metadata target is refused.
  await page.getByLabel('Target URL').fill('http://169.254.169.254/latest/meta-data');
  await page.getByRole('button', { name: 'Approve & add' }).click();
  await page.locator('.toast', { hasText: 'blocked' }).waitFor();
  log('metadata target refused ✓');

  for (const body of [{ query: 'storm rescue tension' }, { query: 'storm', failAt: 'n_scanner' }]) {
    await fetch('http://127.0.0.1:4400/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  await page.waitForTimeout(6000); // let health + telemetry refresh
  await page.screenshot({ path: path.join(shots, '12-backends-indicators.png') });
  const card = page.locator('.card', { hasText: sid });
  await card.locator('.indicator', { hasText: 'Service reachable' }).locator('.chip', { hasText: 'OK' }).waitFor({ timeout: 15000 });
  await card.locator('.indicator', { hasText: 'Workflow executing' }).locator('.chip', { hasText: 'Failing' }).waitFor();
  await card.locator('.indicator', { hasText: 'Telemetry freshness' }).locator('.chip', { hasText: 'OK' }).waitFor();
  log('indicators: reachable OK, latest run failing, telemetry fresh ✓');
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('tab', { name: 'External telemetry' }).click();
  const rows = page.locator('.timeline .tbl tbody tr', { hasText: sid });
  await rows.first().waitFor();
  await rows.filter({ hasText: 'Failed' }).first().click();
  await page.locator('.np-node.st-failed', { hasText: 'Scanner' }).waitFor();
  await page.locator('.np-node', { hasText: 'Scanner' }).locator('.badge', { hasText: 'EXT' }).waitFor();
  const animated = await page.locator('.react-flow__edge.animated').count();
  await page.screenshot({ path: path.join(shots, '13-external-overlay.png') });
  log(`external run overlay ✓ (animated edges with reduced motion: ${animated})`);
  if (animated !== 0) throw new Error('edges animated despite reduced motion');
  log(errors.length ? `page errors: ${errors.join('; ')}` : 'no page errors');
} finally {
  backend?.kill();
  await browser.close();
}
