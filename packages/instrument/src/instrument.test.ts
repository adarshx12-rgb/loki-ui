import { describe, expect, it } from 'vitest';
import { createReporter, sanitize } from './index.js';

describe('instrumentation helper', () => {
  it('reports started/succeeded/failed with sanitized errors and never throws on delivery failure', async () => {
    const bodies: { events: { status: string; error?: { message: string }; nodeId: string }[] }[] = [];
    let fail = true;
    const fetchImpl = (async (_u: unknown, init: { body: string }) => {
      if (fail) { fail = false; throw new Error('ECONNREFUSED'); }
      bodies.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const np = createReporter({ endpoint: 'http://127.0.0.1:1', token: 't', workflowId: 'w', fetch: fetchImpl, flushIntervalMs: 60_000 });
    expect(await np.traceNode('r', 'a', () => 42)).toBe(42);
    await expect(np.traceNode('r', 'b', () => { throw new Error('bad key sk-ant-api03-abcdefghijklmnopqrstu'); })).rejects.toThrow();
    await np.flush(); // first delivery fails → buffered
    expect(np.stats().buffered).toBe(4);
    await np.flush();
    const events = bodies.flatMap((b) => b.events);
    expect(events.map((e) => `${e.nodeId}:${e.status}`)).toEqual(['a:started', 'a:succeeded', 'b:started', 'b:failed']);
    expect(events[3].error!.message).not.toContain('sk-ant');
    expect(new Set(events.map((e: { eventId?: string }) => e.eventId)).size).toBe(4);
    await np.close();
  });

  it('sanitizes common credential formats', () => {
    expect(sanitize('Authorization: Bearer abc123 token=xyz ghp_aaaaaaaaaaaaaaaaaaaaaaaa')).toBe('Authorization: Bearer [REDACTED] token=[REDACTED] [REDACTED]');
  });
});
