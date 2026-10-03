// Local GitHub webhook test: signs a sample payload with GITHUB_WEBHOOK_SECRET exactly like
// GitHub does (HMAC-SHA256, X-Hub-Signature-256) and posts it to the local server.
// This exercises verification, de-duplication and repository association without a
// public endpoint. It does NOT prove that GitHub can reach your machine.
//
//   GITHUB_WEBHOOK_SECRET=... node scripts/github-webhook-test.mjs owner/repo [event]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const envFile = path.resolve(import.meta.dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const secret = process.env.GITHUB_WEBHOOK_SECRET;
if (!secret) { console.error('Set GITHUB_WEBHOOK_SECRET (same value as the server).'); process.exit(1); }
const repo = process.argv[2] ?? 'octo-org/octo-repo';
const event = process.argv[3] ?? 'push';
const url = `${process.env.NODEPILOT_URL ?? 'http://127.0.0.1:4317'}/api/github/webhook`;
const body = JSON.stringify({ ref: 'refs/heads/main', action: event === 'pull_request' ? 'opened' : undefined, repository: { full_name: repo } });
const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
const delivery = crypto.randomUUID();
const send = async (signature) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': signature }, body });
  return `${r.status} ${JSON.stringify(await r.json())}`;
};
console.log('valid signature      →', await send(sig));
console.log('same delivery again  →', await send(sig));
console.log('tampered signature   →', await send('sha256=' + '0'.repeat(64)));
