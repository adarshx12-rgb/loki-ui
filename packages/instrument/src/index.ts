/**
 * @nodepilot/instrument — report node execution events from your own backend to NodePilot.
 *
 * Zero dependencies. Never throws into your code: delivery failures are retried
 * in the background with bounded buffering, then dropped (and counted).
 *
 *   const np = createReporter({ endpoint: 'http://127.0.0.1:4317', token: process.env.NODEPILOT_INGEST_TOKEN!,
 *                               workflowId: 'example-scene-pipeline', workflowRevision: 3,
 *                               environment: 'dev', codeRevision: process.env.GIT_SHA });
 *   const result = await np.traceNode(runId, 'n_scanner', () => scan(plan), { summarize: (r) => `${r.hits.length} hits` });
 *   await np.evaluation(runId, 'n_score_combiner', { name: 'golden-set', passed: score >= 0.8, score, threshold: 0.8 });
 */

export type EventStatus = 'started' | 'succeeded' | 'failed' | 'evaluation_passed' | 'evaluation_failed';

export interface NodeEvent {
  eventId: string;
  runId: string;
  nodeId: string;
  workflowId: string;
  workflowRevision?: number;
  environment?: string;
  codeRevision?: string;
  timestamp: string;
  status: EventStatus;
  durationMs?: number;
  error?: { type?: string; message: string };
  output?: { summary?: string; sizeBytes?: number; fields?: string[] };
  usage?: { inputTokens?: number; outputTokens?: number };
  evaluation?: { name: string; score?: number; threshold?: number };
}

export interface ReporterOptions {
  endpoint: string;
  token: string;
  workflowId: string;
  workflowRevision?: number;
  environment?: string;
  codeRevision?: string;
  /** Flush interval (ms). Default 1000. */
  flushIntervalMs?: number;
  /** Max events kept while the server is unreachable. Default 2000. */
  maxBuffer?: number;
  fetch?: typeof fetch;
  onError?: (err: Error) => void;
}

const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /(Bearer\s+)[^\s"']+/gi,
  /((?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\s"',}]+/gi,
];

/** Strips common credential formats before anything leaves your process. */
export function sanitize(text: string, max = 2000): string {
  let out = text;
  for (const p of SECRETS) out = out.replace(p, (_m, prefix?: string) => (typeof prefix === 'string' ? prefix : '') + '[REDACTED]');
  return out.length > max ? out.slice(0, max) + '…' : out;
}

let counter = 0;
function eventId(): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `${rand}-${(counter++).toString(36)}`;
}

export interface Reporter {
  traceNode<T>(runId: string, nodeId: string, fn: () => Promise<T> | T, opts?: { summarize?: (r: T) => string; usage?: (r: T) => NodeEvent['usage'] }): Promise<T>;
  record(e: Omit<NodeEvent, 'eventId' | 'workflowId' | 'timestamp'> & Partial<Pick<NodeEvent, 'eventId' | 'timestamp'>>): void;
  evaluation(runId: string, nodeId: string, e: { name: string; passed: boolean; score?: number; threshold?: number }): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  stats(): { sent: number; dropped: number; buffered: number; lastError?: string };
}

export function createReporter(o: ReporterOptions): Reporter {
  const doFetch = o.fetch ?? fetch;
  const buffer: NodeEvent[] = [];
  const maxBuffer = o.maxBuffer ?? 2000;
  let sent = 0;
  let dropped = 0;
  let lastError: string | undefined;
  let inflight: Promise<void> | null = null;
  let backoffUntil = 0;

  const push = (e: NodeEvent) => {
    buffer.push(e);
    if (buffer.length > maxBuffer) dropped += buffer.splice(0, buffer.length - maxBuffer).length;
  };

  const flush = async (): Promise<void> => {
    if (inflight) return inflight;
    if (!buffer.length || Date.now() < backoffUntil) return;
    const batch = buffer.splice(0, 500);
    inflight = (async () => {
      try {
        const res = await doFetch(new URL('/api/telemetry/events', o.endpoint), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${o.token}` },
          body: JSON.stringify({ events: batch }),
        });
        if (res.status === 422 || res.status === 401 || res.status === 413) {
          // Not retryable: drop and report.
          dropped += batch.length;
          throw new Error(`NodePilot rejected telemetry: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
        }
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
        sent += batch.length;
        backoffUntil = 0;
      } catch (e) {
        const err = e as Error & { retry?: boolean };
        if (err.retry !== false && !err.message.startsWith('NodePilot rejected')) {
          buffer.unshift(...batch); // duplicates are de-duplicated server-side by eventId
          if (buffer.length > maxBuffer) dropped += buffer.splice(0, buffer.length - maxBuffer).length;
          backoffUntil = Date.now() + 5000;
        }
        lastError = err.message;
        o.onError?.(err);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const timer = setInterval(() => void flush(), o.flushIntervalMs ?? 1000);
  (timer as { unref?: () => void }).unref?.();

  const base = () => ({ workflowId: o.workflowId, workflowRevision: o.workflowRevision, environment: o.environment, codeRevision: o.codeRevision });

  const record: Reporter['record'] = (e) => push({ ...base(), eventId: e.eventId ?? eventId(), timestamp: e.timestamp ?? new Date().toISOString(), ...e } as NodeEvent);

  return {
    record,
    async traceNode(runId, nodeId, fn, opts) {
      const start = Date.now();
      record({ runId, nodeId, status: 'started' });
      try {
        const result = await fn();
        let summary: string | undefined;
        try { summary = opts?.summarize ? sanitize(opts.summarize(result)) : undefined; } catch { /* ignore */ }
        let usage: NodeEvent['usage'];
        try { usage = opts?.usage?.(result); } catch { /* ignore */ }
        record({ runId, nodeId, status: 'succeeded', durationMs: Date.now() - start, output: summary ? { summary } : undefined, usage });
        return result;
      } catch (err) {
        const e = err as Error;
        record({ runId, nodeId, status: 'failed', durationMs: Date.now() - start, error: { type: e?.name, message: sanitize(String(e?.message ?? err)) } });
        throw err;
      }
    },
    evaluation(runId, nodeId, e) {
      record({ runId, nodeId, status: e.passed ? 'evaluation_passed' : 'evaluation_failed', evaluation: { name: e.name, score: e.score, threshold: e.threshold } });
    },
    flush: async () => {
      backoffUntil = 0;
      await flush();
    },
    async close() {
      clearInterval(timer);
      backoffUntil = 0;
      while (buffer.length && !lastErrorIsFatal()) {
        const before = buffer.length;
        await flush();
        if (buffer.length >= before) break;
      }
    },
    stats: () => ({ sent, dropped, buffered: buffer.length, lastError }),
  };

  function lastErrorIsFatal() {
    return !!lastError?.startsWith('NodePilot rejected');
  }
}
