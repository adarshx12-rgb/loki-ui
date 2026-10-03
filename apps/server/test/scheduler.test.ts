import { describe, expect, it } from 'vitest';
import { buildExampleWorkflow, templateByKey, type Workflow } from '@nodepilot/shared';
import { makeResolver } from '../src/executor/handlers.js';
import { abortableSleep, runSchedule, type Handler, type Resolution } from '../src/executor/scheduler.js';

const noCreds = { available: () => false, resolve: () => undefined };

function chain(): Workflow {
  // a → b → c, and a → d (parallel branch)
  const t = templateByKey('empty')!;
  const mk = (id: string, x: number) => ({ ...t.build(id, { x, y: 0 }), inputs: id === 'a' ? [] : t.build(id, { x, y: 0 }).inputs });
  return {
    ...buildExampleWorkflow(),
    nodes: [mk('a', 0), mk('b', 1), mk('c', 2), mk('d', 3)],
    edges: [
      { id: 'e1', source: 'a', sourcePort: 'out', target: 'b', targetPort: 'in' },
      { id: 'e2', source: 'b', sourcePort: 'out', target: 'c', targetPort: 'in' },
      { id: 'e3', source: 'a', sourcePort: 'out', target: 'd', targetPort: 'in' },
    ],
  };
}

function fixed(handlers: Record<string, Handler>): (n: Workflow['nodes'][number]) => Resolution {
  return (n) => ({ kind: 'execute', handler: handlers[n.id] ?? (async () => ({ outputs: { out: n.id } })) });
}

describe('scheduler', () => {
  it('runs the example in dependency order and merges fan-in explicitly', async () => {
    const wf = buildExampleWorkflow();
    for (const n of wf.nodes) n.config.demo.latencyMs = 0;
    const order: string[] = [];
    const r = await runSchedule(wf, {
      resolve: makeResolver(noCreds),
      concurrency: 3,
      signal: new AbortController().signal,
      onEvent: (e) => { if (e.type === 'node.started') order.push(e.nodeId); },
    });
    expect(r.status).toBe('succeeded');
    expect(order.indexOf('n_query')).toBe(0);
    expect(order.indexOf('n_plan_combiner')).toBeGreaterThan(Math.max(order.indexOf('n_planner_a'), order.indexOf('n_planner_b')));
    // object_by_source merge: keyed by judge node ids
    const combinerInput = r.nodes.n_score_combiner.input as { scores: Record<string, unknown> };
    expect(Object.keys(combinerInput.scores).sort()).toEqual(['n_judge_coherence', 'n_judge_fidelity', 'n_judge_tension']);
    // array merge for plans
    expect(Array.isArray((r.nodes.n_plan_combiner.input as { plans: unknown[] }).plans)).toBe(true);
    expect(r.nodes.n_results.demo).toBe(true);
    // deterministic
    const r2 = await runSchedule(wf, { resolve: makeResolver(noCreds), concurrency: 1, signal: new AbortController().signal });
    expect(JSON.stringify(r2.outputs.n_results)).toBe(JSON.stringify(r.outputs.n_results));
  });

  it('bounds parallelism', async () => {
    const wf = buildExampleWorkflow();
    let active = 0;
    let peak = 0;
    const slow: Handler = async ({ node }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((res) => setTimeout(res, 20));
      active--;
      return { outputs: Object.fromEntries(node.outputs.map((p) => [p.id, { ok: true }])) };
    };
    const r = await runSchedule(wf, { resolve: () => ({ kind: 'execute', handler: slow }), concurrency: 2, signal: new AbortController().signal });
    expect(r.status).toBe('succeeded');
    expect(peak).toBe(2); // three judges are ready together but only two run at once
  });

  it('propagates failure as skipped downstream with the upstream cause, while independent branches finish', async () => {
    const wf = chain();
    const r = await runSchedule(wf, {
      resolve: fixed({ b: async () => { throw new Error('boom'); } }),
      concurrency: 4,
      signal: new AbortController().signal,
    });
    expect(r.status).toBe('failed');
    expect(r.nodes.b.status).toBe('failed');
    expect(r.nodes.b.error?.message).toBe('boom');
    expect(r.nodes.c.status).toBe('skipped');
    expect(r.nodes.c.error?.upstream).toBe('b');
    expect(r.nodes.d.status).toBe('succeeded');
  });

  it('times out slow nodes', async () => {
    const wf = chain();
    wf.nodes[1].config.timeoutMs = 100;
    const r = await runSchedule(wf, {
      resolve: fixed({ b: async ({ signal }) => { await abortableSleep(5000, signal); return { outputs: { out: 1 } }; } }),
      concurrency: 4,
      signal: new AbortController().signal,
    });
    expect(r.nodes.b.status).toBe('failed');
    expect(r.nodes.b.error?.code).toBe('timeout');
  });

  it('retries only nodes marked safeToRetry, within the bound', async () => {
    const wf = chain();
    let calls = 0;
    const flaky: Handler = async () => { calls++; if (calls < 3) throw new Error('transient'); return { outputs: { out: 1 } }; };
    wf.nodes[1].config.retry = { maxAttempts: 3, backoffMs: 1, safeToRetry: true };
    const r = await runSchedule(wf, { resolve: fixed({ b: flaky }), concurrency: 1, signal: new AbortController().signal });
    expect(r.nodes.b.status).toBe('succeeded');
    expect(r.nodes.b.attempts).toBe(3);

    calls = 0;
    wf.nodes[1].config.retry = { maxAttempts: 3, backoffMs: 1, safeToRetry: false };
    const r2 = await runSchedule(wf, { resolve: fixed({ b: flaky }), concurrency: 1, signal: new AbortController().signal });
    expect(r2.nodes.b.status).toBe('failed');
    expect(calls).toBe(1);
  });

  it('cancels running and pending nodes', async () => {
    const wf = chain();
    const ac = new AbortController();
    const p = runSchedule(wf, {
      resolve: fixed({ b: async ({ signal }) => { await abortableSleep(10_000, signal); return { outputs: { out: 1 } }; } }),
      concurrency: 4,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 50);
    const r = await p;
    expect(r.status).toBe('cancelled');
    expect(r.nodes.a.status).toBe('succeeded');
    expect(r.nodes.b.status).toBe('cancelled');
    expect(r.nodes.c.status).toBe('cancelled');
  });

  it('never executes observed nodes and labels unconfigured nodes honestly', async () => {
    const wf = chain();
    wf.nodes[1].config.implementation = { kind: 'observed', serviceId: 'svc' };
    wf.nodes[3].config.implementation = { kind: 'none' };
    let executed = false;
    const resolver = makeResolver(noCreds);
    const r = await runSchedule(wf, {
      resolve: (n) => (n.id === 'a' ? { kind: 'execute', handler: async () => { executed = true; return { outputs: { out: 1 } }; } } : resolver(n)),
      concurrency: 2,
      signal: new AbortController().signal,
    });
    expect(executed).toBe(true);
    expect(r.nodes.b.status).toBe('observed');
    expect(r.nodes.c.status).toBe('skipped');
    expect(r.nodes.d.status).toBe('failed');
    expect(r.nodes.d.error?.message).toMatch(/^Not configured/);
  });

  it('applies post-processing to outputs', async () => {
    const wf = chain();
    wf.nodes[0].config.postProcess = [{ op: 'select', fields: ['keep'] }];
    const r = await runSchedule(wf, { resolve: fixed({ a: async () => ({ outputs: { out: { keep: 1, drop: 2 } } }) }), concurrency: 1, signal: new AbortController().signal });
    expect(r.outputs.a.out).toEqual({ keep: 1 });
  });
});
