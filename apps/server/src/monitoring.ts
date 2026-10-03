import { newId, redactValue, telemetryBatchSchema, telemetryStatusRank, type TelemetryEvent } from '@nodepilot/shared';
import { randomToken, sha256 } from './auth.js';
import type { Bus } from './bus.js';
import { nowIso, tx, type DB } from './db.js';
import { checkHealth, validateTargetUrl } from './netguard.js';
import { HttpError } from './workflows.js';

export type Indicator = 'ok' | 'failing' | 'unknown' | 'stale';

export interface ServiceStatus {
  id: string;
  name: string;
  createdAt: string;
  lastEventAt?: string;
  duplicateCount: number;
  staleAfterS: number;
  indicators: {
    /** From configured health endpoints only. */
    reachable: { state: Indicator; detail: string; checkedAt?: string };
    /** From execution telemetry of the latest finished external run. */
    execution: { state: Indicator; detail: string; runId?: string };
    /** From explicit evaluation events. A 200 response or a succeeded node is NOT an evaluation. */
    evaluation: { state: Indicator; detail: string };
    /** Freshness of telemetry. Staleness never changes recorded run outcomes. */
    telemetry: { state: Indicator; detail: string };
  };
}

export class Monitoring {
  private timer?: NodeJS.Timeout;
  private checking = new Set<string>();

  constructor(private db: DB, private bus: Bus, private opts: { maxEvents: number; retentionDays: number }) {}

  // ---------------- services & ingest tokens ----------------

  createService(name: string, id?: string, staleAfterS = 600): { service: { id: string; name: string }; ingestToken: string } {
    const sid = id ?? newId('svc');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sid)) throw new HttpError(422, 'invalid_id', 'Service id must match [A-Za-z0-9_-]{1,64}');
    if (this.db.prepare('SELECT 1 FROM services WHERE id = ?').get(sid)) throw new HttpError(409, 'exists', `Service "${sid}" exists`);
    const token = randomToken('npi');
    this.db.prepare('INSERT INTO services (id, name, ingest_token_hash, stale_after_s, created_at) VALUES (?, ?, ?, ?, ?)').run(sid, name, sha256(token), staleAfterS, nowIso());
    return { service: { id: sid, name }, ingestToken: token };
  }

  rotateToken(serviceId: string): string {
    const token = randomToken('npi');
    const r = this.db.prepare('UPDATE services SET ingest_token_hash = ? WHERE id = ?').run(sha256(token), serviceId);
    if (r.changes === 0) throw new HttpError(404, 'not_found', 'Service not found');
    return token;
  }

  deleteService(serviceId: string) {
    tx(this.db, () => {
      for (const t of ['telemetry_events', 'external_runs', 'external_node_states']) this.db.prepare(`DELETE FROM ${t} WHERE service_id = ?`).run(serviceId);
      this.db.prepare('UPDATE health_targets SET service_id = NULL WHERE service_id = ?').run(serviceId);
      this.db.prepare('DELETE FROM services WHERE id = ?').run(serviceId);
    });
  }

  serviceIds(): Set<string> {
    return new Set((this.db.prepare('SELECT id FROM services').all() as { id: string }[]).map((r) => r.id));
  }

  /**
   * Ingests a batch of telemetry events.
   *  - Duplicate eventIds are ignored (counted).
   *  - Out-of-order events never regress a node: a terminal status beats `started`,
   *    and within the same rank only a newer timestamp wins.
   */
  ingest(serviceId: string, body: unknown): { accepted: number; duplicates: number } {
    const parsed = telemetryBatchSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(422, 'invalid_events', 'Telemetry batch failed validation', parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })));
    let accepted = 0;
    let duplicates = 0;
    const workflows = new Set<string>();
    tx(this.db, () => {
      for (const raw of parsed.data.events) {
        const ev = redactValue(raw) as TelemetryEvent;
        const ins = this.db
          .prepare('INSERT OR IGNORE INTO telemetry_events (service_id, event_id, run_id, node_id, workflow_id, status, ts, received_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(serviceId, ev.eventId, ev.runId, ev.nodeId, ev.workflowId, ev.status, ev.timestamp, nowIso(), JSON.stringify(ev));
        if (ins.changes === 0) {
          duplicates++;
          continue;
        }
        accepted++;
        workflows.add(ev.workflowId);
        this.applyEvent(serviceId, ev);
      }
      if (duplicates) this.db.prepare('UPDATE services SET duplicate_count = duplicate_count + ? WHERE id = ?').run(duplicates, serviceId);
      if (accepted) this.db.prepare('UPDATE services SET last_event_at = ? WHERE id = ?').run(nowIso(), serviceId);
    });
    for (const w of workflows) this.bus.publish({ type: 'telemetry.updated', workflowId: w, serviceId });
    return { accepted, duplicates };
  }

  private applyEvent(serviceId: string, ev: TelemetryEvent) {
    this.db
      .prepare(
        `INSERT INTO external_runs (service_id, run_id, workflow_id, workflow_revision, environment, code_revision, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(service_id, run_id) DO UPDATE SET
           first_ts = MIN(first_ts, excluded.first_ts), last_ts = MAX(last_ts, excluded.last_ts),
           workflow_revision = COALESCE(external_runs.workflow_revision, excluded.workflow_revision),
           environment = COALESCE(external_runs.environment, excluded.environment),
           code_revision = COALESCE(external_runs.code_revision, excluded.code_revision)`,
      )
      .run(serviceId, ev.runId, ev.workflowId, ev.workflowRevision ?? null, ev.environment ?? null, ev.codeRevision ?? null, ev.timestamp, ev.timestamp);

    const existing = this.db.prepare('SELECT * FROM external_node_states WHERE service_id = ? AND run_id = ? AND node_id = ?').get(serviceId, ev.runId, ev.nodeId) as
      | Record<string, string | number | null>
      | undefined;

    if (ev.status === 'evaluation_passed' || ev.status === 'evaluation_failed') {
      if (!existing) {
        this.db
          .prepare('INSERT INTO external_node_states (service_id, run_id, node_id, workflow_id, status, rank, ts, eval_status, eval_ts, eval_json) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)')
          .run(serviceId, ev.runId, ev.nodeId, ev.workflowId, 'unknown', ev.timestamp, ev.status, ev.timestamp, JSON.stringify(ev.evaluation ?? null));
      } else if (!existing.eval_ts || (existing.eval_ts as string) < ev.timestamp) {
        this.db
          .prepare('UPDATE external_node_states SET eval_status = ?, eval_ts = ?, eval_json = ? WHERE service_id = ? AND run_id = ? AND node_id = ?')
          .run(ev.status, ev.timestamp, JSON.stringify(ev.evaluation ?? null), serviceId, ev.runId, ev.nodeId);
      }
      return;
    }

    const rank = telemetryStatusRank(ev.status);
    const wins = !existing || rank > (existing.rank as number) || (rank === (existing.rank as number) && ev.timestamp > (existing.ts as string));
    if (!wins) return;
    const errorJson = ev.error ? JSON.stringify(ev.error) : null;
    const outputJson = ev.output || ev.usage ? JSON.stringify({ output: ev.output, usage: ev.usage }) : null;
    if (!existing) {
      this.db
        .prepare('INSERT INTO external_node_states (service_id, run_id, node_id, workflow_id, status, rank, ts, duration_ms, error_json, output_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(serviceId, ev.runId, ev.nodeId, ev.workflowId, ev.status, rank, ev.timestamp, ev.durationMs ?? null, errorJson, outputJson);
    } else {
      this.db
        .prepare('UPDATE external_node_states SET status = ?, rank = ?, ts = ?, duration_ms = COALESCE(?, duration_ms), error_json = ?, output_json = COALESCE(?, output_json) WHERE service_id = ? AND run_id = ? AND node_id = ?')
        .run(ev.status, rank, ev.timestamp, ev.durationMs ?? null, errorJson, outputJson, serviceId, ev.runId, ev.nodeId);
    }
  }

  externalRuns(workflowId: string, limit = 20) {
    const runs = this.db
      .prepare('SELECT * FROM external_runs WHERE workflow_id = ? ORDER BY last_ts DESC LIMIT ?')
      .all(workflowId, limit) as Record<string, string | number | null>[];
    return runs.map((r) => {
      const nodes = this.db
        .prepare('SELECT * FROM external_node_states WHERE service_id = ? AND run_id = ?')
        .all(r.service_id, r.run_id) as Record<string, string | number | null>[];
      const statuses = nodes.map((n) => n.status as string);
      const status = statuses.includes('failed') ? 'failed' : statuses.includes('started') ? 'running' : statuses.length && statuses.every((s) => s === 'succeeded' || s === 'unknown') ? 'succeeded' : 'unknown';
      return {
        serviceId: r.service_id as string,
        runId: r.run_id as string,
        workflowId: r.workflow_id as string,
        workflowRevision: r.workflow_revision as number | null,
        environment: r.environment as string | null,
        codeRevision: r.code_revision as string | null,
        firstTs: r.first_ts as string,
        lastTs: r.last_ts as string,
        status,
        nodes: Object.fromEntries(
          nodes.map((n) => [
            n.node_id as string,
            {
              status: n.status as string,
              ts: n.ts as string,
              durationMs: (n.duration_ms as number) ?? undefined,
              error: n.error_json ? JSON.parse(n.error_json as string) : undefined,
              output: n.output_json ? JSON.parse(n.output_json as string) : undefined,
              evaluation: n.eval_status ? { status: n.eval_status as string, ts: n.eval_ts as string, detail: JSON.parse((n.eval_json as string) ?? 'null') } : undefined,
            },
          ]),
        ),
      };
    });
  }

  // ---------------- health targets ----------------

  addTarget(input: { name: string; url: string; serviceId?: string; intervalS?: number }) {
    try {
      validateTargetUrl(input.url);
    } catch (e) {
      throw new HttpError(422, 'invalid_target', (e as Error).message);
    }
    const id = newId('hc');
    const interval = Math.max(10, Math.min(3600, input.intervalS ?? 30));
    this.db.prepare('INSERT INTO health_targets (id, name, url, service_id, interval_s, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, input.name, input.url, input.serviceId ?? null, interval, nowIso());
    void this.runCheck(id);
    return this.targets().find((t) => t.id === id)!;
  }

  removeTarget(id: string) {
    this.db.prepare('DELETE FROM health_targets WHERE id = ?').run(id);
  }

  targets() {
    return (this.db.prepare('SELECT * FROM health_targets ORDER BY name').all() as Record<string, string | number | null>[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      url: r.url as string,
      serviceId: (r.service_id as string) ?? undefined,
      intervalS: r.interval_s as number,
      enabled: !!r.enabled,
      lastCheckedAt: (r.last_checked_at as string) ?? undefined,
      lastOk: r.last_ok === null ? undefined : !!r.last_ok,
      lastStatus: (r.last_status as number) ?? undefined,
      lastLatencyMs: (r.last_latency_ms as number) ?? undefined,
      lastError: (r.last_error as string) ?? undefined,
    }));
  }

  async runCheck(id: string): Promise<void> {
    if (this.checking.has(id)) return;
    const t = this.targets().find((x) => x.id === id);
    if (!t) return;
    this.checking.add(id);
    try {
      const r = await checkHealth(t.url);
      this.db
        .prepare('UPDATE health_targets SET last_checked_at = ?, last_ok = ?, last_status = ?, last_latency_ms = ?, last_error = ? WHERE id = ?')
        .run(nowIso(), r.ok ? 1 : 0, r.status ?? null, r.latencyMs, r.error ?? null, id);
      this.bus.publish({ type: 'health.updated', targetId: id });
    } finally {
      this.checking.delete(id);
    }
  }

  startScheduler(): void {
    const tick = () => {
      const now = Date.now();
      for (const t of this.targets()) {
        if (!t.enabled) continue;
        if (!t.lastCheckedAt || now - Date.parse(t.lastCheckedAt) >= t.intervalS * 1000) void this.runCheck(t.id);
      }
      this.prune();
    };
    this.timer = setInterval(tick, 5000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  prune(): void {
    const cutoff = new Date(Date.now() - this.opts.retentionDays * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM telemetry_events WHERE received_at < ?').run(cutoff);
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM telemetry_events').get() as { c: number }).c;
    if (count > this.opts.maxEvents) {
      this.db
        .prepare('DELETE FROM telemetry_events WHERE rowid IN (SELECT rowid FROM telemetry_events ORDER BY received_at ASC LIMIT ?)')
        .run(count - this.opts.maxEvents);
    }
    this.db.prepare('DELETE FROM external_node_states WHERE run_id IN (SELECT run_id FROM external_runs WHERE last_ts < ?)').run(cutoff);
    this.db.prepare('DELETE FROM external_runs WHERE last_ts < ?').run(cutoff);
  }

  // ---------------- indicators ----------------

  services(now = Date.now()): ServiceStatus[] {
    const rows = this.db.prepare('SELECT * FROM services ORDER BY name').all() as Record<string, string | number | null>[];
    const targets = this.targets();
    return rows.map((s) => {
      const id = s.id as string;
      const staleAfterS = s.stale_after_s as number;
      const tgs = targets.filter((t) => t.serviceId === id);
      const checked = tgs.filter((t) => t.lastCheckedAt);
      const reachable: ServiceStatus['indicators']['reachable'] = tgs.length === 0
        ? { state: 'unknown', detail: 'No health endpoint configured' }
        : checked.length === 0
          ? { state: 'unknown', detail: 'Not checked yet' }
          : checked.every((t) => t.lastOk)
            ? { state: 'ok', detail: `${checked.length} endpoint(s) responding (HTTP 2xx). This does not prove output quality.`, checkedAt: checked[0].lastCheckedAt }
            : { state: 'failing', detail: checked.filter((t) => !t.lastOk).map((t) => `${t.name}: ${t.lastError ?? `HTTP ${t.lastStatus}`}`).join('; '), checkedAt: checked[0].lastCheckedAt };

      const lastRun = this.db.prepare('SELECT run_id FROM external_runs WHERE service_id = ? ORDER BY last_ts DESC LIMIT 5').all(id) as { run_id: string }[];
      let execution: ServiceStatus['indicators']['execution'] = { state: 'unknown', detail: 'No execution telemetry received' };
      for (const { run_id } of lastRun) {
        const states = (this.db.prepare('SELECT status FROM external_node_states WHERE service_id = ? AND run_id = ? AND rank > 0').all(id, run_id) as { status: string }[]).map((r) => r.status);
        if (states.includes('failed')) { execution = { state: 'failing', detail: `Run ${run_id} reported a failed node`, runId: run_id }; break; }
        if (states.length && !states.includes('started')) { execution = { state: 'ok', detail: `Run ${run_id} completed without node failures`, runId: run_id }; break; }
      }
      const ev = this.db
        .prepare('SELECT eval_status, eval_ts FROM external_node_states WHERE service_id = ? AND eval_status IS NOT NULL ORDER BY eval_ts DESC LIMIT 1')
        .get(id) as { eval_status: string; eval_ts: string } | undefined;
      const evaluation: ServiceStatus['indicators']['evaluation'] = !ev
        ? { state: 'unknown', detail: 'No functional evaluation events received' }
        : ev.eval_status === 'evaluation_passed'
          ? { state: 'ok', detail: `Latest evaluation passed at ${ev.eval_ts}` }
          : { state: 'failing', detail: `Latest evaluation failed at ${ev.eval_ts}` };
      const last = s.last_event_at as string | null;
      const telemetry: ServiceStatus['indicators']['telemetry'] = !last
        ? { state: 'unknown', detail: 'No telemetry received yet' }
        : now - Date.parse(last) > staleAfterS * 1000
          ? { state: 'stale', detail: `No events for ${Math.round((now - Date.parse(last)) / 60000)} min (stale after ${Math.round(staleAfterS / 60)} min). Recorded run outcomes are unchanged.` }
          : { state: 'ok', detail: `Last event ${Math.round((now - Date.parse(last)) / 1000)} s ago` };
      return {
        id,
        name: s.name as string,
        createdAt: s.created_at as string,
        lastEventAt: last ?? undefined,
        duplicateCount: s.duplicate_count as number,
        staleAfterS,
        indicators: { reachable, execution, evaluation, telemetry },
      };
    });
  }
}
