import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_WORKFLOW_ID, templateByKey } from '@nodepilot/shared';
import { resolveWithinRoots } from '@nodepilot/shared/node';
import { createAppJwt, verifyWebhookSignature } from '../src/github.js';
import { blockedAddressReason, checkHealth, validateTargetUrl } from '../src/netguard.js';
import { HOST, makeEnv, ui, type TestEnv } from './helpers.js';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

describe('pairing, origin and host restrictions', () => {
  it('requires pairing for every API route', async () => {
    env = await makeEnv();
    const r = await env.app.inject({ method: 'GET', url: '/api/workflows', headers: { host: HOST } });
    expect(r.statusCode).toBe(401);
    const run = await env.app.inject({ method: 'POST', url: `/api/workflows/${EXAMPLE_WORKFLOW_ID}/runs`, headers: { host: HOST } });
    expect(run.statusCode).toBe(401);
  });

  it('pairing codes are single-use and wrong codes are throttled', async () => {
    env = await makeEnv();
    const code = env.ctx.auth.createPairingCode();
    const ok = await env.app.inject({ method: 'POST', url: '/api/auth/pair', headers: { host: HOST }, payload: { code } });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    const again = await env.app.inject({ method: 'POST', url: '/api/auth/pair', headers: { host: HOST }, payload: { code } });
    expect(again.statusCode).toBe(401);
    for (let i = 0; i < 10; i++) await env.app.inject({ method: 'POST', url: '/api/auth/pair', headers: { host: HOST }, payload: { code: 'AAAA-AAAA' } });
    const fresh = env.ctx.auth.createPairingCode();
    const blocked = await env.app.inject({ method: 'POST', url: '/api/auth/pair', headers: { host: HOST }, payload: { code: fresh } });
    expect(blocked.statusCode).toBe(429);
  });

  it('rejects foreign origins and unexpected Host headers even with a valid session', async () => {
    env = await makeEnv();
    const evil = await env.app.inject({ method: 'POST', url: `/api/workflows/${EXAMPLE_WORKFLOW_ID}/runs`, headers: ui(env, { origin: 'https://evil.example' }), payload: {} });
    expect(evil.statusCode).toBe(403);
    const rebinding = await env.app.inject({ method: 'GET', url: '/api/workflows', headers: ui(env, { host: 'attacker.example:4317' }) });
    expect(rebinding.statusCode).toBe(403);
    const okRes = await env.app.inject({ method: 'GET', url: '/api/workflows', headers: ui(env) });
    expect(okRes.statusCode).toBe(200);
  });

  it('scopes tokens: the MCP token cannot start runs or read secrets', async () => {
    env = await makeEnv();
    const h = { host: HOST, authorization: `Bearer ${env.mcpToken}` };
    expect((await env.app.inject({ method: 'GET', url: '/api/workflows', headers: h })).statusCode).toBe(200);
    expect((await env.app.inject({ method: 'GET', url: '/api/secrets', headers: h })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'POST', url: `/api/workflows/${EXAMPLE_WORKFLOW_ID}/runs`, headers: h, payload: {} })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: '/api/workflows', headers: { host: HOST, authorization: 'Bearer npm_wrong' } })).statusCode).toBe(401);
  });

  it('with pairing disabled, browsers need no code but Host/Origin checks and token scopes still apply', async () => {
    env = await makeEnv({ requirePairing: false });
    expect((await env.app.inject({ method: 'GET', url: '/api/workflows', headers: { host: HOST } })).statusCode).toBe(200);
    expect((await env.app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: HOST } })).json()).toMatchObject({ paired: true, pairingRequired: false });
    expect((await env.app.inject({ method: 'GET', url: '/api/workflows', headers: { host: HOST, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/api/workflows', headers: { host: 'attacker.example:4317' } })).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/api/secrets', headers: { host: HOST, authorization: 'Bearer npm_wrong' } })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: '/api/secrets', headers: { host: HOST, authorization: `Bearer ${env.mcpToken}` } })).statusCode).toBe(401);
  });

  it('enforces payload limits', async () => {
    env = await makeEnv();
    const big = 'x'.repeat(1.5 * 1024 * 1024);
    const r = await env.app.inject({ method: 'POST', url: '/api/workflows', headers: { ...ui(env), 'content-type': 'application/json' }, payload: JSON.stringify({ name: big }) });
    expect(r.statusCode).toBe(413);
  });
});

describe('concurrent revision conflicts', () => {
  it('rejects a stale non-commutative patch with a useful message, but rebases layout-only patches', async () => {
    env = await makeEnv();
    const wf = env.ctx.store.get(EXAMPLE_WORKFLOW_ID);
    const base = wf.revision;
    // MCP edits the scanner first
    env.ctx.store.applyPatch(wf.id, { baseRevision: base, actor: 'mcp', ops: [{ op: 'update_node', nodeId: 'n_scanner', changes: { label: 'Scanner (MCP)' } }] });
    // UI, still on the old revision, edits the same node
    const res = await env.app.inject({
      method: 'POST',
      url: `/api/workflows/${wf.id}/patch`,
      headers: ui(env),
      payload: { baseRevision: base, ops: [{ op: 'update_node', nodeId: 'n_scanner', changes: { purpose: 'x' } }] },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('revision_conflict');
    expect(body.message).toMatch(/changed since revision 1 \(now 2\)/);
    expect(body.message).toMatch(/n_scanner/);
    expect(body.details.changesSince[0].actor).toBe('mcp');
    expect(env.ctx.store.get(wf.id).nodes.find((n) => n.id === 'n_scanner')!.label).toBe('Scanner (MCP)');

    // moving a node with a stale revision is safe and rebased
    const mv = await env.app.inject({
      method: 'POST',
      url: `/api/workflows/${wf.id}/patch`,
      headers: ui(env),
      payload: { baseRevision: base, ops: [{ op: 'move_node', nodeId: 'n_scanner', position: { x: 1, y: 1 } }] },
    });
    expect(mv.statusCode).toBe(200);
    expect(mv.json().rebased).toBe(true);
    expect(mv.json().workflow.revision).toBe(3);
  });

  it('rejects structurally invalid patches without persisting', async () => {
    env = await makeEnv();
    const wf = env.ctx.store.get(EXAMPLE_WORKFLOW_ID);
    const res = await env.app.inject({
      method: 'POST',
      url: `/api/workflows/${wf.id}/patch`,
      headers: ui(env),
      payload: { baseRevision: wf.revision, ops: [{ op: 'add_edge', edge: { id: 'cyc', source: 'n_results', sourcePort: 'x', target: 'n_query', targetPort: 'y' } }] },
    });
    expect(res.statusCode).toBe(422);
    expect(env.ctx.store.get(wf.id).revision).toBe(wf.revision);
  });

  it('records an audit trail and publishes live updates', async () => {
    env = await makeEnv();
    const seen: string[] = [];
    env.ctx.bus.subscribe(({ event }) => seen.push(event.type));
    const node = templateByKey('scanner')!.build('n_new', { x: 0, y: 0 });
    env.ctx.store.applyPatch(EXAMPLE_WORKFLOW_ID, { baseRevision: 1, actor: 'ui', ops: [{ op: 'add_node', node }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toContain('workflow.updated');
    expect(env.ctx.store.auditLog(EXAMPLE_WORKFLOW_ID)[0].summary).toBe('add node n_new');
  });
});

describe('runs', () => {
  it('runs an immutable snapshot and records per-node state', async () => {
    env = await makeEnv();
    const run = env.ctx.runs.start(EXAMPLE_WORKFLOW_ID, { actor: 'ui' });
    // edit during the run must not affect it
    env.ctx.store.applyPatch(EXAMPLE_WORKFLOW_ID, { baseRevision: 1, actor: 'ui', ops: [{ op: 'remove_node', nodeId: 'n_results' }] });
    const done = await env.ctx.runs.wait(run.id);
    expect(done.status).toBe('succeeded');
    expect(done.workflowRevision).toBe(1);
    expect(done.nodes.n_results.status).toBe('succeeded');
    expect(env.ctx.runs.events(run.id).some((e) => e.type === 'node.succeeded')).toBe(true);
  });

  it('refuses to run invalid workflows and cancels on request', async () => {
    env = await makeEnv();
    const wf = env.ctx.store.get(EXAMPLE_WORKFLOW_ID);
    env.ctx.store.applyPatch(wf.id, { baseRevision: 1, actor: 'ui', ops: [{ op: 'update_node', nodeId: 'n_scanner', changes: { config: { demo: { failMode: 'timeout', latencyMs: 0 }, timeoutMs: 60_000 } } }] });
    const run = env.ctx.runs.start(wf.id, { actor: 'ui' });
    await new Promise((r) => setTimeout(r, 700));
    env.ctx.runs.cancel(run.id);
    const done = await env.ctx.runs.wait(run.id);
    expect(done.status).toBe('cancelled');
    expect(done.nodes.n_scanner.status).toBe('cancelled');

    env.ctx.store.applyPatch(wf.id, { baseRevision: 2, actor: 'ui', ops: [{ op: 'remove_edge', edgeId: 'e5' }] });
    expect(() => env!.ctx.runs.start(wf.id, { actor: 'ui' })).toThrow(/cannot run/);
  });
});

describe('path restrictions', () => {
  it('blocks traversal and symlink escapes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'np-out-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
    expect(resolveWithinRoots([root], 'src/a.ts').path).toMatch(/a\.ts$/);
    expect(() => resolveWithinRoots([root], '../' + path.basename(outside) + '/secret.txt')).toThrow(/outside/);
    expect(() => resolveWithinRoots([root], outside)).toThrow(/outside/);
    expect(() => resolveWithinRoots([root], 'src/\0a')).toThrow(/null byte/);
    // directory junction/symlink pointing outside the root
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    expect(() => resolveWithinRoots([root], 'link/secret.txt')).toThrow(/symlink/);
    expect(() => resolveWithinRoots([root], 'link/new-file.txt')).toThrow(/symlink/);
  });

  it('only approves real directories, and code links stay inside the project', async () => {
    env = await makeEnv();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-proj-'));
    fs.mkdirSync(path.join(root, 'src', 'workers'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'workers', 'scene.ts'), 'export {}');
    const bad = await env.app.inject({ method: 'POST', url: '/api/projects', headers: ui(env), payload: { rootPath: 'relative/path' } });
    expect(bad.statusCode).toBe(422);
    const p = (await env.app.inject({ method: 'POST', url: '/api/projects', headers: ui(env), payload: { rootPath: root } })).json();
    env.ctx.store.applyPatch(EXAMPLE_WORKFLOW_ID, { baseRevision: 1, actor: 'ui', ops: [{ op: 'update_workflow', projectId: p.id }] });
    const refs = (await env.app.inject({ method: 'GET', url: `/api/workflows/${EXAMPLE_WORKFLOW_ID}/nodes/n_scene_worker/coderefs`, headers: ui(env) })).json();
    expect(refs[0].exists).toBe(true);
    expect(refs[0].vscodeUrl).toMatch(/^vscode:\/\/file\/.*scene\.ts$/);
  });
});

describe('telemetry ingest', () => {
  it('deduplicates and handles out-of-order events without regressing status', async () => {
    env = await makeEnv();
    const { ingestToken } = env.ctx.monitoring.createService('Example backend', 'example-backend');
    const h = { host: HOST, authorization: `Bearer ${ingestToken}` };
    const base = { runId: 'r1', nodeId: 'n_scanner', workflowId: EXAMPLE_WORKFLOW_ID, workflowRevision: 1, environment: 'dev' };
    const done = { ...base, eventId: 'ev2', status: 'succeeded', timestamp: '2026-10-01T10:00:02Z', durationMs: 1500 };
    const started = { ...base, eventId: 'ev1', status: 'started', timestamp: '2026-10-01T10:00:00Z' };
    // terminal event arrives first, then the late "started", then a duplicate
    let r = await env.app.inject({ method: 'POST', url: '/api/telemetry/events', headers: h, payload: { events: [done] } });
    expect(r.json()).toEqual({ accepted: 1, duplicates: 0 });
    r = await env.app.inject({ method: 'POST', url: '/api/telemetry/events', headers: h, payload: { events: [started, done] } });
    expect(r.json()).toEqual({ accepted: 1, duplicates: 1 });
    const runs = env.ctx.monitoring.externalRuns(EXAMPLE_WORKFLOW_ID);
    expect(runs[0].nodes.n_scanner.status).toBe('succeeded');
    expect(runs[0].status).toBe('succeeded');
    expect(runs[0].firstTs).toBe('2026-10-01T10:00:00Z');
    const svc = env.ctx.monitoring.services().find((s) => s.id === 'example-backend')!;
    expect(svc.duplicateCount).toBe(1);
    expect(svc.indicators.execution.state).toBe('ok');
    expect(svc.indicators.evaluation.state).toBe('unknown'); // success is not an evaluation
    expect(svc.indicators.reachable.state).toBe('unknown');
  });

  it('marks telemetry stale without changing recorded run outcomes, and redacts secrets', async () => {
    env = await makeEnv();
    const { ingestToken } = env.ctx.monitoring.createService('svc', 'svc', 60);
    const h = { host: HOST, authorization: `Bearer ${ingestToken}` };
    await env.app.inject({
      method: 'POST', url: '/api/telemetry/events', headers: h,
      payload: { events: [{ eventId: 'a', runId: 'r', nodeId: 'n', workflowId: 'w', status: 'failed', timestamp: '2026-10-01T10:00:00Z', error: { message: 'auth failed with sk-ant-api03-SECRETSECRETSECRET' } }] },
    });
    const later = Date.now() + 3600_000;
    const svc = env.ctx.monitoring.services(later)[0];
    expect(svc.indicators.telemetry.state).toBe('stale');
    expect(svc.indicators.execution.state).toBe('failing');
    const runs = env.ctx.monitoring.externalRuns('w');
    expect(JSON.stringify(runs)).not.toContain('SECRETSECRET');
  });

  it('rejects unauthenticated or malformed telemetry', async () => {
    env = await makeEnv();
    expect((await env.app.inject({ method: 'POST', url: '/api/telemetry/events', headers: { host: HOST }, payload: { events: [] } })).statusCode).toBe(401);
    const { ingestToken } = env.ctx.monitoring.createService('svc');
    const bad = await env.app.inject({ method: 'POST', url: '/api/telemetry/events', headers: { host: HOST, authorization: `Bearer ${ingestToken}` }, payload: { events: [{ eventId: 'x' }] } });
    expect(bad.statusCode).toBe(422);
  });
});

describe('GitHub', () => {
  const secret = 'whsec_test_value_123';
  const sign = (body: string) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  it('verifies webhook signatures in constant time', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifyWebhookSignature(secret, body, sign('{"a":1}'))).toBe(true);
    expect(verifyWebhookSignature(secret, body, sign('{"a":2}'))).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha1=abc')).toBe(false);
  });

  it('rejects bad signatures, deduplicates deliveries and associates repositories', async () => {
    env = await makeEnv({ github: { webhookSecret: secret, apiBase: 'http://invalid' } });
    env.ctx.github.setRepo({ owner: 'acme', repo: 'widgets', branch: 'main' });
    const payload = JSON.stringify({ action: 'opened', repository: { full_name: 'acme/widgets' } });
    const send = (body: string, sig: string, id: string) =>
      env!.app.inject({ method: 'POST', url: '/api/github/webhook', headers: { host: HOST, 'content-type': 'application/json', 'x-hub-signature-256': sig, 'x-github-delivery': id, 'x-github-event': 'pull_request' }, payload: body });
    expect((await send(payload, sign('tampered'), 'd1')).statusCode).toBe(401);
    const ok = await send(payload, sign(payload), 'd1');
    expect(ok.statusCode).toBe(202);
    expect(ok.json().result).toBe('accepted');
    const dup = await send(payload, sign(payload), 'd1');
    expect(dup.json().result).toMatch(/duplicate/);
    const other = JSON.stringify({ repository: { full_name: 'someone/else' } });
    expect((await send(other, sign(other), 'd2')).json().result).toMatch(/not associated/);
    expect(env.ctx.github.deliveries().length).toBe(2);
  });

  it('creates RS256 app JWTs with backdated iat and short expiry', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = createAppJwt('Iv1.client', privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), 1_000_000);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: 'Iv1.client' });
    expect(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('reports an honest disconnected state without credentials', async () => {
    env = await makeEnv();
    const s = (await env.app.inject({ method: 'GET', url: '/api/github/status', headers: ui(env) })).json();
    expect(s.state).toBe('not_configured');
    expect(s.missing.length).toBeGreaterThan(0);
  });
});

describe('health check guard', () => {
  it('blocks metadata destinations and non-http schemes', () => {
    expect(() => validateTargetUrl('http://169.254.169.254/latest/meta-data')).toThrow(/blocked/);
    expect(() => validateTargetUrl('http://metadata.google.internal/')).toThrow(/blocked/);
    expect(() => validateTargetUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => validateTargetUrl('http://user:pw@localhost/')).toThrow(/credentials/);
    expect(blockedAddressReason('::ffff:169.254.169.254')).toMatch(/metadata/);
    expect(blockedAddressReason('127.0.0.1')).toBeNull();
  });

  it('refuses redirects to other origins', async () => {
    const http = await import('node:http');
    const srv = http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(302, { location: 'http://169.254.169.254/' }); return res.end(); }
      if (req.url === '/h2') { res.writeHead(302, { location: '/ok' }); return res.end(); }
      res.writeHead(200); res.end('ok');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const bad = await checkHealth(`http://127.0.0.1:${port}/health`);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/blocked|unapproved/);
    const good = await checkHealth(`http://127.0.0.1:${port}/h2`);
    expect(good.ok).toBe(true);
    expect(good.redirects).toBe(1);
    srv.close();
  });
});

describe('file sync', () => {
  it('writes linked files, ignores its own writes, imports external edits and refuses stale ones', async () => {
    env = await makeEnv();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-sync-'));
    const p = env.ctx.projects.add(root);
    env.ctx.files.linkFile(EXAMPLE_WORKFLOW_ID, p.id, 'nodepilot/example.json');
    const file = path.join(root, 'nodepilot', 'example.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(env.ctx.files.importNow(EXAMPLE_WORKFLOW_ID)).toBe('ignored_own_write');

    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.nodes.find((n: { id: string }) => n.id === 'n_scanner').label = 'Scanner edited in file';
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    expect(env.ctx.files.importNow(EXAMPLE_WORKFLOW_ID)).toBe('imported');
    const wf = env.ctx.store.get(EXAMPLE_WORKFLOW_ID);
    expect(wf.nodes.find((n) => n.id === 'n_scanner')!.label).toBe('Scanner edited in file');
    expect(env.ctx.store.auditLog(wf.id)[0].actor).toBe('file');

    // a stale file (old revision) is not imported
    doc.revision = 1;
    doc.name = 'stale';
    fs.writeFileSync(file, JSON.stringify(doc));
    expect(env.ctx.files.importNow(EXAMPLE_WORKFLOW_ID)).toBe('conflict');
    expect(env.ctx.store.get(wf.id).name).not.toBe('stale');
    expect(() => env!.ctx.files.linkFile(EXAMPLE_WORKFLOW_ID, p.id, '../escape.json')).toThrow(/outside/);
  });
});
