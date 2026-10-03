/**
 * Example instrumented backend (illustrative). It implements a tiny version of
 * the example scene pipeline in plain TypeScript and reports node execution
 * events to NodePilot with @nodepilot/instrument. NodePilot only OBSERVES this
 * service; it never calls the /run endpoint itself.
 *
 *   NODEPILOT_INGEST_TOKEN=npi_... npm run example-backend
 *   curl -X POST http://127.0.0.1:4400/run -H 'content-type: application/json' -d '{"query":"storm rescue"}'
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { createReporter } from '@nodepilot/instrument';

const PORT = Number(process.env.EXAMPLE_PORT ?? 4400);
const token = process.env.NODEPILOT_INGEST_TOKEN;
if (!token) {
  console.error('Set NODEPILOT_INGEST_TOKEN (create a backend service in NodePilot → Connections → Backends).');
  process.exit(1);
}

const np = createReporter({
  endpoint: process.env.NODEPILOT_URL ?? 'http://127.0.0.1:4317',
  token,
  workflowId: process.env.NODEPILOT_WORKFLOW_ID ?? 'example-scene-pipeline',
  workflowRevision: process.env.NODEPILOT_WORKFLOW_REVISION ? Number(process.env.NODEPILOT_WORKFLOW_REVISION) : undefined,
  environment: process.env.APP_ENV ?? 'local',
  codeRevision: process.env.GIT_SHA,
  onError: (e) => console.error(`[telemetry] ${e.message}`),
});

const SCENES = [
  { id: 'scene-01', tags: ['storm', 'lighthouse', 'tension'] },
  { id: 'scene-03', tags: ['suspense', 'cellar', 'tension'] },
  { id: 'scene-05', tags: ['storm', 'rescue', 'climax'] },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pipeline(query: string, failAt?: string) {
  const runId = `ext-${crypto.randomUUID().slice(0, 8)}`;
  const step = <T>(nodeId: string, fn: () => Promise<T> | T, summarize?: (r: T) => string) =>
    np.traceNode(runId, nodeId, async () => {
      await sleep(30 + Math.random() * 60);
      if (failAt === nodeId) throw new Error(`Simulated failure in ${nodeId}`);
      return fn();
    }, { summarize });

  const terms = await step('n_query', () => query.toLowerCase().split(/\W+/).filter(Boolean), (t) => `${t.length} terms`);
  const [a, b] = await Promise.all([step('n_planner_a', () => terms.map((t) => `search:${t}`)), step('n_planner_b', () => terms.slice(0, 1).map((t) => `deep:${t}`))]);
  const plan = await step('n_plan_combiner', () => [...a, ...b], (p) => `${p.length} steps`);
  const hits = await step('n_scanner', () => SCENES.filter((s) => s.tags.some((t) => terms.includes(t))), (h) => `${h.length} hits`);
  const scene = await step('n_scene_worker', () => hits[0] ?? SCENES[0], (s) => s.id);
  const scores = await Promise.all(['n_judge_coherence', 'n_judge_tension', 'n_judge_fidelity'].map((id) => step(id, () => 5 + (scene.id.length + id.length) % 5)));
  const mean = await step('n_score_combiner', () => scores.reduce((x, y) => x + y, 0) / scores.length, (m) => `mean ${m}`);
  // A functional evaluation is a separate signal from "the code ran": here, a threshold on the score.
  np.evaluation(runId, 'n_score_combiner', { name: 'mean-score>=6', passed: mean >= 6, score: mean, threshold: 6 });
  await step('n_results', () => ({ plan, scene: scene.id, mean }));
  return { runId, scene: scene.id, mean };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, note: 'Liveness only; says nothing about output quality' }));
  }
  if (req.method === 'POST' && req.url?.startsWith('/run')) {
    let body = '';
    for await (const c of req) { body += c; if (body.length > 10_000) return res.writeHead(413).end(); }
    const { query = 'storm rescue', failAt } = JSON.parse(body || '{}') as { query?: string; failAt?: string };
    try {
      const r = await pipeline(String(query), failAt);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
    await np.flush();
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Example backend on http://127.0.0.1:${PORT}  (GET /health, POST /run {"query": "...", "failAt"?: "n_scanner"})`);
});
process.on('SIGINT', async () => { await np.close(); process.exit(0); });
