import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { executableHash, redactValue, type Actor } from '@nodepilot/shared';
import { AuthService, checkHostAndOrigin, parseCookies, requirePrincipal, SESSION_COOKIE, sessionCookie, type PrincipalKind } from './auth.js';
import { Bus } from './bus.js';
import { REPO_ROOT, type ServerConfig } from './config.js';
import { openDatabase, type DB } from './db.js';
import { makeResolver } from './executor/handlers.js';
import { FileSync } from './filesync.js';
import { GitHub } from './github.js';
import { filesImportSchema, gitImportSchema, Importer } from './importer.js';
import { Monitoring } from './monitoring.js';
import { Projects } from './projects.js';
import { RunManager } from './runs.js';
import { Secrets } from './secrets.js';
import { composeSchema, createTaskSchema, runnerInfoSchema, Tasks } from './tasks.js';
import { HttpError, patchBodySchema, WorkflowStore } from './workflows.js';
import { TASK_STATUSES } from '@nodepilot/shared';

export interface AppContext {
  cfg: ServerConfig;
  db: DB;
  bus: Bus;
  auth: AuthService;
  store: WorkflowStore;
  runs: RunManager;
  secrets: Secrets;
  projects: Projects;
  files: FileSync;
  monitoring: Monitoring;
  github: GitHub;
  tasks: Tasks;
  importer: Importer;
}

export function createContext(cfg: ServerConfig, opts: { dbFile?: string; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): AppContext {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const db = openDatabase(opts.dbFile ?? path.join(cfg.dataDir, 'nodepilot.db'));
  const bus = new Bus();
  const auth = new AuthService(db, cfg);
  const secrets = new Secrets(db, opts.env ?? process.env);
  const monitoring = new Monitoring(db, bus, { maxEvents: cfg.retention.telemetryEvents, retentionDays: cfg.retention.telemetryDays });
  const store = new WorkflowStore(db, bus, () => ({ credentialAvailable: (ref) => secrets.available(ref), knownServiceIds: monitoring.serviceIds() }));
  const runs = new RunManager(db, bus, store, makeResolver(secrets, opts.fetchImpl), { concurrency: cfg.executor.concurrency, runsPerWorkflow: cfg.retention.runsPerWorkflow });
  const projects = new Projects(db);
  for (const root of cfg.approvedRoots) {
    try { projects.add(root); } catch (e) { process.stderr.write(`[nodepilot] ignoring approved root ${root}: ${(e as Error).message}\n`); }
  }
  const files = new FileSync(db, bus, store, projects);
  const github = new GitHub(db, bus, cfg.github, opts.fetchImpl);
  const tasks = new Tasks(db, bus, store, runs);
  const importer = new Importer(cfg.dataDir, projects, store);
  return { cfg, db, bus, auth, store, runs, secrets, projects, files, monitoring, github, tasks, importer };
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const actorFor = (req: FastifyRequest): Actor => (req.principal?.kind === 'mcp' ? 'mcp' : req.principal?.kind === 'runner' ? 'runner' : 'ui');

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { cfg, auth, store, runs, bus } = ctx;
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    // Keep request logging off: bodies may contain user data. Errors are logged (redacted) below.
  });

  // Raw body for GitHub webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    if (req.url.startsWith('/api/github/webhook')) return done(null, body);
    if ((body as Buffer).length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      const err = new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
      done(err, undefined);
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (!req.url.startsWith('/api/')) {
      reply.header('Content-Security-Policy', CSP);
      return;
    }
    const problem = checkHostAndOrigin(req, cfg);
    if (problem) return reply.code(403).send({ error: 'forbidden_origin', message: problem });
    req.principal = auth.identify(req);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err instanceof z.ZodError) return reply.code(422).send({ error: 'invalid_request', message: 'Request failed validation', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode === 413 || e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'payload_too_large', message: 'Request body exceeds the size limit' });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message });
    process.stderr.write(`[nodepilot] error: ${JSON.stringify(redactValue({ message: e.message, stack: (err as Error).stack?.split('\n').slice(0, 5) }))}\n`);
    return reply.code(500).send({ error: 'internal', message: 'Internal server error' });
  });

  const only = (...k: PrincipalKind[]) => ({ preHandler: requirePrincipal(...k) });
  const UI = only('session');
  const UI_MCP = only('session', 'mcp');
  const RUNNER = only('runner');
  type P = { id: string };

  // ---------------- auth ----------------
  app.get('/api/auth/status', async (req) => ({ paired: req.principal?.kind === 'session', pairingRequired: cfg.requirePairing, appName: cfg.appName }));
  app.post('/api/auth/pair', async (req, reply) => {
    const { code } = z.object({ code: z.string().max(40) }).parse(req.body);
    const r = auth.redeemPairingCode(code, req.headers['user-agent']);
    if ('error' in r) return reply.code(r.status).send({ error: 'pairing_failed', message: r.error });
    reply.header('set-cookie', sessionCookie(r.token));
    return { paired: true };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    const c = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (c) auth.revokeSession(c);
    reply.header('set-cookie', sessionCookie('', 0));
    return { ok: true };
  });

  // ---------------- live stream (SSE) ----------------
  app.get('/api/stream', UI, (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (id: number, data: unknown) => res.write(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write('retry: 2000\n\n');
    const lastId = Number(req.headers['last-event-id'] ?? NaN);
    if (Number.isFinite(lastId)) {
      const missed = bus.since(lastId);
      if (missed === null) res.write(`event: resync\ndata: {}\n\n`);
      else for (const m of missed) send(m.id, m.event);
    } else {
      res.write(`event: hello\ndata: {}\n\n`);
    }
    const unsub = bus.subscribe((e) => send(e.id, e.event));
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => { clearInterval(ping); unsub(); });
  });

  // ---------------- workflows ----------------
  app.get('/api/workflows', UI_MCP, async () => store.list());
  app.post('/api/workflows', UI_MCP, async (req) => {
    const body = z.object({ name: z.string().min(1).max(120), description: z.string().max(5000).optional(), projectId: z.string().max(64).optional() }).parse(req.body);
    return store.create(body, actorFor(req));
  });
  app.post('/api/workflows/import', UI, async (req) => store.importWorkflow(req.body, 'ui'));
  app.get<{ Params: P }>('/api/workflows/:id', UI_MCP, async (req) => {
    const wf = store.get(req.params.id);
    return { workflow: wf, validation: store.validate(wf), executableHash: executableHash(wf) };
  });
  app.delete<{ Params: P }>('/api/workflows/:id', UI, async (req) => {
    store.delete(req.params.id, 'ui');
    return { ok: true };
  });
  app.post<{ Params: P }>('/api/workflows/:id/patch', UI_MCP, async (req) => {
    const body = patchBodySchema.extend({ dryRun: z.boolean().optional() }).parse(req.body);
    const r = store.applyPatch(req.params.id, { ...body, actor: actorFor(req) });
    return { ...r, executableHash: executableHash(r.workflow) };
  });
  app.post<{ Params: P }>('/api/workflows/:id/validate', UI_MCP, async (req) => {
    const body = z.object({ workflow: z.unknown().optional() }).parse(req.body ?? {});
    return store.validate(body.workflow ?? store.get(req.params.id));
  });
  app.get<{ Params: P }>('/api/workflows/:id/audit', UI_MCP, async (req) => store.auditLog(req.params.id));
  app.get<{ Params: P }>('/api/workflows/:id/export', UI, async (req, reply) => {
    reply.header('content-disposition', `attachment; filename="${req.params.id}.nodepilot.json"`);
    return redactValue(store.get(req.params.id));
  });
  app.get<{ Params: P }>('/api/workflows/:id/proposals', UI_MCP, async (req) => store.listProposals(req.params.id));
  app.post<{ Params: P }>('/api/workflows/:id/proposals', UI_MCP, async (req) => {
    const body = patchBodySchema.extend({ title: z.string().min(1).max(200) }).parse(req.body);
    return store.propose(req.params.id, { ...body, actor: actorFor(req) });
  });
  app.post<{ Params: P & { pid: string; action: string } }>('/api/workflows/:id/proposals/:pid/:action', UI, async (req) => {
    const action = z.enum(['apply', 'reject']).parse(req.params.action);
    return store.resolveProposal(req.params.id, req.params.pid, action, 'ui') ?? { ok: true };
  });
  app.get<{ Params: P & { nodeId: string } }>('/api/workflows/:id/nodes/:nodeId/history', UI_MCP, async (req) => runs.nodeHistory(req.params.id, req.params.nodeId));
  app.get<{ Params: P & { nodeId: string } }>('/api/workflows/:id/nodes/:nodeId/coderefs', UI, async (req) => {
    const wf = store.get(req.params.id);
    const node = wf.nodes.find((n) => n.id === req.params.nodeId);
    if (!node) throw new HttpError(404, 'not_found', 'Node not found');
    return node.codeRefs.map((ref) => {
      if (!wf.projectId) return { ref, error: 'Workflow has no project; set one to resolve code references' };
      try {
        return { ref, ...ctx.projects.codeLink(wf.projectId, ref.path, ref.line) };
      } catch (e) {
        return { ref, error: (e as Error).message };
      }
    });
  });
  // file link
  app.get<{ Params: P }>('/api/workflows/:id/file', UI, async (req) => ctx.files.link(req.params.id) ?? null);
  app.put<{ Params: P }>('/api/workflows/:id/file', UI, async (req) => {
    const body = z.object({ projectId: z.string().max(64), relPath: z.string().min(1).max(400) }).parse(req.body);
    return ctx.files.linkFile(req.params.id, body.projectId, body.relPath);
  });
  app.post<{ Params: P }>('/api/workflows/:id/file/rewrite', UI, async (req) => {
    ctx.files.writeNow(req.params.id);
    return ctx.files.link(req.params.id) ?? null;
  });
  app.delete<{ Params: P }>('/api/workflows/:id/file', UI, async (req) => {
    ctx.files.unlink(req.params.id);
    return { ok: true };
  });

  // ---------------- runs ----------------
  app.post<{ Params: P }>('/api/workflows/:id/runs', UI, async (req) => {
    const body = z.object({ input: z.unknown().optional(), expectedRevision: z.number().int().optional() }).parse(req.body ?? {});
    return runs.start(req.params.id, { input: body.input, actor: 'ui', expectedRevision: body.expectedRevision });
  });
  app.get<{ Params: P }>('/api/workflows/:id/runs', UI_MCP, async (req) => runs.list(req.params.id));
  app.get<{ Params: P }>('/api/runs/:id', UI_MCP, async (req) => runs.get(req.params.id));
  app.get<{ Params: P }>('/api/runs/:id/events', UI_MCP, async (req) => runs.events(req.params.id));
  app.post<{ Params: P }>('/api/runs/:id/cancel', UI, async (req) => runs.cancel(req.params.id));
  app.get<{ Params: P }>('/api/workflows/:id/external-runs', UI_MCP, async (req) => ctx.monitoring.externalRuns(req.params.id));

  // ---------------- repository import ----------------
  app.post('/api/import/git', UI, async (req) => ctx.importer.fromGit(gitImportSchema.parse(req.body)));
  app.post('/api/import/files', { ...UI, bodyLimit: 64 * 1024 * 1024 }, async (req) => ctx.importer.fromFiles(filesImportSchema.parse(req.body)));

  // ---------------- projects / secrets / settings ----------------
  app.get('/api/projects', UI_MCP, async () => ctx.projects.list());
  app.post('/api/projects', UI, async (req) => {
    const body = z.object({ rootPath: z.string().min(1).max(500), name: z.string().max(80).optional() }).parse(req.body);
    return ctx.projects.add(body.rootPath, body.name);
  });
  app.delete<{ Params: P }>('/api/projects/:id', UI, async (req) => {
    ctx.projects.remove(req.params.id);
    return { ok: true };
  });
  app.get('/api/secrets', UI, async () => ctx.secrets.list());
  app.put<{ Params: { name: string } }>('/api/secrets/:name', UI, async (req) => {
    const body = z.object({ value: z.string().min(1).max(10_000) }).parse(req.body);
    try { ctx.secrets.set(req.params.name, body.value); } catch (e) { throw new HttpError(422, 'invalid_secret', (e as Error).message); }
    return { ok: true, ref: `secret:${req.params.name}` };
  });
  app.delete<{ Params: { name: string } }>('/api/secrets/:name', UI, async (req) => {
    ctx.secrets.delete(req.params.name);
    return { ok: true };
  });
  app.get('/api/settings/mcp', UI, async () => {
    const entry = path.join(REPO_ROOT, 'apps', 'mcp', 'dist', 'index.js');
    return {
      serverName: 'nodepilot',
      command: process.execPath,
      args: [entry],
      env: { NODEPILOT_URL: `http://127.0.0.1:${cfg.port}`, NODEPILOT_DATA_DIR: cfg.dataDir },
      built: fs.existsSync(entry),
      cli: `claude mcp add nodepilot --scope user -e NODEPILOT_URL=http://127.0.0.1:${cfg.port} -e NODEPILOT_DATA_DIR="${cfg.dataDir}" -- "${process.execPath}" "${entry}"`,
    };
  });

  // ---------------- Claude runner ----------------
  app.post('/api/runner/pair-requests', async (req) => ctx.tasks.createPairRequest(runnerInfoSchema.parse(req.body)));
  app.post<{ Params: P }>('/api/runner/pair-requests/:id/collect', async (req) => {
    const { pollSecret } = z.object({ pollSecret: z.string().min(10).max(200) }).parse(req.body);
    return ctx.tasks.collectPairResult(req.params.id, pollSecret);
  });
  app.get('/api/runner/pair-requests', UI, async () => ctx.tasks.pendingPairRequests());
  app.post<{ Params: P }>('/api/runner/pair-requests/:id/decide', UI, async (req) => {
    const body = z.object({ approve: z.boolean(), code: z.string().max(20).default('') }).parse(req.body);
    return ctx.tasks.decidePairRequest(req.params.id, body.approve, body.code);
  });
  app.get('/api/runners', UI, async () => ctx.tasks.runners());
  app.delete<{ Params: P }>('/api/runners/:id', UI, async (req) => {
    ctx.tasks.revokeRunner(req.params.id);
    return { ok: true };
  });
  const runnerId = (req: FastifyRequest) => (req.principal as { runnerId: string }).runnerId;
  app.post('/api/runner/heartbeat', RUNNER, async (req) => {
    ctx.tasks.heartbeat(runnerId(req), runnerInfoSchema.parse(req.body));
    return { ok: true };
  });
  app.get<{ Querystring: { waitMs?: string } }>('/api/runner/next', RUNNER, async (req) => {
    const wait = Math.max(0, Math.min(25_000, Number(req.query.waitMs ?? 20_000)));
    return { task: await ctx.tasks.next(runnerId(req), wait) };
  });
  app.post<{ Params: P }>('/api/runner/tasks/:id/events', RUNNER, async (req) => {
    const body = z.object({ events: z.array(z.object({ kind: z.enum(['status', 'assistant', 'tool_use', 'tool_result', 'permission_denied', 'error', 'log', 'result', 'system']), text: z.string().max(50_000), data: z.unknown().optional() })).max(200) }).parse(req.body);
    return ctx.tasks.runnerEvents(runnerId(req), req.params.id, body.events);
  });
  app.post<{ Params: P }>('/api/runner/tasks/:id/status', { ...RUNNER, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const body = z.object({ status: z.enum(TASK_STATUSES), detail: z.string().max(5000).optional(), sessionId: z.string().max(100).optional(), result: z.unknown().optional() }).parse(req.body);
    return ctx.tasks.runnerStatus(runnerId(req), req.params.id, body);
  });
  app.get<{ Params: P }>('/api/runner/tasks/:id/control', RUNNER, async (req) => ctx.tasks.control(runnerId(req), req.params.id));

  // ---------------- tasks (browser) ----------------
  app.post('/api/tasks/compose', UI, async (req) => ctx.tasks.compose(composeSchema.parse(req.body)));
  app.post('/api/tasks', UI, async (req) => ctx.tasks.create(createTaskSchema.parse(req.body)));
  app.get<{ Querystring: { workflowId?: string } }>('/api/tasks', UI, async (req) => ctx.tasks.list({ workflowId: req.query.workflowId }));
  app.get<{ Params: P }>('/api/tasks/:id', UI, async (req) => ctx.tasks.get(req.params.id));
  app.get<{ Params: P; Querystring: { after?: string } }>('/api/tasks/:id/events', UI, async (req) => ctx.tasks.events(req.params.id, Number(req.query.after ?? 0)));
  app.post<{ Params: P }>('/api/tasks/:id/cancel', UI, async (req) => ctx.tasks.requestCancel(req.params.id));

  // ---------------- GitHub ----------------
  app.get('/api/github/status', UI, async () => ctx.github.status());
  app.put('/api/github/repo', UI, async (req) => {
    const body = z.object({ owner: z.string(), repo: z.string(), branch: z.string() }).nullable().parse(req.body ?? null);
    ctx.github.setRepo(body);
    return ctx.github.status();
  });
  app.post('/api/github/refresh', UI, async () => ctx.github.refresh());
  app.get('/api/github/deliveries', UI, async () => ctx.github.deliveries());
  app.post('/api/github/webhook', async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? ''));
    const r = ctx.github.handleWebhook(raw, req.headers);
    return reply.code(r.status).send({ result: r.result });
  });

  // ---------------- monitoring ----------------
  app.get('/api/services', UI_MCP, async () => ctx.monitoring.services());
  app.post('/api/services', UI, async (req) => {
    const body = z.object({ name: z.string().min(1).max(80), id: z.string().max(64).optional(), staleAfterS: z.number().int().min(30).max(86400).optional() }).parse(req.body);
    return ctx.monitoring.createService(body.name, body.id, body.staleAfterS);
  });
  app.post<{ Params: P }>('/api/services/:id/rotate', UI, async (req) => ({ ingestToken: ctx.monitoring.rotateToken(req.params.id) }));
  app.delete<{ Params: P }>('/api/services/:id', UI, async (req) => {
    ctx.monitoring.deleteService(req.params.id);
    return { ok: true };
  });
  app.get('/api/health-targets', UI, async () => ctx.monitoring.targets());
  app.post('/api/health-targets', UI, async (req) => {
    const body = z.object({ name: z.string().min(1).max(80), url: z.string().max(2000), serviceId: z.string().max(64).optional(), intervalS: z.number().int().optional() }).parse(req.body);
    return ctx.monitoring.addTarget(body);
  });
  app.post<{ Params: P }>('/api/health-targets/:id/check', UI, async (req) => {
    await ctx.monitoring.runCheck(req.params.id);
    return ctx.monitoring.targets().find((t) => t.id === req.params.id) ?? null;
  });
  app.delete<{ Params: P }>('/api/health-targets/:id', UI, async (req) => {
    ctx.monitoring.removeTarget(req.params.id);
    return { ok: true };
  });
  app.post('/api/telemetry/events', { ...only('ingest'), bodyLimit: 256 * 1024 }, async (req) => {
    return ctx.monitoring.ingest((req.principal as { serviceId: string }).serviceId, req.body);
  });

  app.all('/api/*', async (_req, reply: FastifyReply) => reply.code(404).send({ error: 'not_found', message: 'Unknown API route' }));

  // ---------------- static web app ----------------
  if (cfg.webDist && fs.existsSync(path.join(cfg.webDist, 'index.html'))) {
    // Wildcard serving looks files up per request, so a rebuilt web app (new hashed asset names) works without a restart.
    await app.register(fastifyStatic, { root: cfg.webDist, wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/assets/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  }
  return app;
}
