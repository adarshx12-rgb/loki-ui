import fs from 'node:fs';
import path from 'node:path';
import { buildApp, createContext } from './app.js';
import { loadConfig, REPO_ROOT } from './config.js';

const envFile = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const cfg = loadConfig();
const ctx = createContext(cfg);
const command = process.argv[2];

if (command === 'pair' && !cfg.requirePairing) {
  console.log('\n  Browser pairing is disabled (set NODEPILOT_REQUIRE_PAIRING=1 to enable it).\n');
  process.exit(0);
}
if (command === 'pair') {
  // Issue a new browser pairing code without restarting the server.
  const code = ctx.auth.createPairingCode();
  console.log(`\n  ${cfg.appName} pairing code: ${code}  (valid ${cfg.pairingCodeTtlMs / 60000} min, single use)\n`);
  process.exit(0);
}

ctx.store.ensureExample();
ctx.runs.recoverInterrupted();
ctx.auth.ensureMcpToken();
ctx.files.start();
ctx.monitoring.startScheduler();

const app = await buildApp(ctx);
await app.listen({ host: cfg.host, port: cfg.port });

const code = cfg.requirePairing ? ctx.auth.createPairingCode() : null;
const webUrl = fs.existsSync(path.join(cfg.webDist ?? '', 'index.html')) ? `http://127.0.0.1:${cfg.port}` : `http://127.0.0.1:${process.env.NODEPILOT_WEB_PORT ?? 5173}`;
console.log(`
  ${cfg.appName} server listening on http://${cfg.host}:${cfg.port} (loopback only)
  Data directory: ${cfg.dataDir}

${code
  ? `  Open ${webUrl} and enter this pairing code:  ${code}
  (single use, valid ${cfg.pairingCodeTtlMs / 60000} minutes; run "npm run pair" for a new one)`
  : `  Open ${webUrl}
  (browser pairing disabled; set NODEPILOT_REQUIRE_PAIRING=1 to require a pairing code)`}
`);

const shutdown = async () => {
  ctx.monitoring.stop();
  await ctx.files.stop();
  await app.close();
  ctx.db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
