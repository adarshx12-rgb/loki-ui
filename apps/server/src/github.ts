import crypto from 'node:crypto';
import fs from 'node:fs';
import { redactValue } from '@nodepilot/shared';
import type { Bus } from './bus.js';
import type { ServerConfig } from './config.js';
import { getSetting, nowIso, setSetting, type DB } from './db.js';
import { HttpError } from './workflows.js';

/** GitHub REST API version verified against docs.github.com (2026-10). */
export const GITHUB_API_VERSION = '2026-03-10';

/** Least-privilege, read-only permissions requested for installation tokens. */
export const READ_PERMISSIONS = { contents: 'read', metadata: 'read', pull_requests: 'read', checks: 'read', actions: 'read' } as const;

export function verifyWebhookSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** RS256 JWT for GitHub App auth: iat 60 s in the past, exp 9 minutes ahead (max allowed is 10). */
export function createAppJwt(issuer: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: issuer }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKeyPem);
  return `${header}.${payload}.${base64url(signature)}`;
}

export interface RepoSelection {
  owner: string;
  repo: string;
  branch: string;
}

export type GithubState =
  | { state: 'not_configured'; missing: string[] }
  | { state: 'no_repository' }
  | { state: 'error'; message: string; at: string }
  | { state: 'connected'; at: string };

export class GitHub {
  private token?: { value: string; expiresAt: number };
  private lastState: GithubState | undefined;

  constructor(private db: DB, private bus: Bus, private cfg: ServerConfig['github'], private fetchImpl: typeof fetch = fetch) {}

  missingConfig(): string[] {
    const m: string[] = [];
    if (!this.cfg.clientId && !this.cfg.appId) m.push('GITHUB_APP_CLIENT_ID (or GITHUB_APP_ID)');
    if (!this.cfg.privateKeyPath) m.push('GITHUB_APP_PRIVATE_KEY_PATH');
    if (!this.cfg.installationId) m.push('GITHUB_APP_INSTALLATION_ID');
    return m;
  }

  repo(): RepoSelection | null {
    return getSetting<RepoSelection | null>(this.db, 'github.repo', null);
  }

  setRepo(sel: RepoSelection | null) {
    if (sel) {
      const ok = /^[A-Za-z0-9-]{1,39}$/.test(sel.owner) && /^[A-Za-z0-9._-]{1,100}$/.test(sel.repo) && /^[^\s~^:?*[\\]{1,250}$/.test(sel.branch) && !sel.branch.includes('..');
      if (!ok) throw new HttpError(422, 'invalid_repo', 'Invalid owner, repository or branch name');
    }
    setSetting(this.db, 'github.repo', sel);
    setSetting(this.db, 'github.cache', null);
    this.token = undefined;
    this.bus.publish({ type: 'github.updated' });
  }

  status() {
    const missing = this.missingConfig();
    const repo = this.repo();
    const state: GithubState = missing.length ? { state: 'not_configured', missing } : !repo ? { state: 'no_repository' } : this.lastState ?? { state: 'connected', at: '' };
    const lastDelivery = this.db.prepare('SELECT received_at, event, associated FROM github_deliveries ORDER BY received_at DESC LIMIT 1').get() as
      | { received_at: string; event: string; associated: number }
      | undefined;
    return {
      ...state,
      repo,
      webhook: {
        secretConfigured: !!this.cfg.webhookSecret,
        lastDelivery: lastDelivery ? { at: lastDelivery.received_at, event: lastDelivery.event, associated: !!lastDelivery.associated } : null,
        note: 'GitHub can only deliver webhooks to a publicly reachable URL. On localhost use a tunnel or "Redeliver"/the local test script; otherwise use Refresh (polling).',
      },
      cache: getSetting<unknown>(this.db, 'github.cache', null),
    };
  }

  private async installationToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    const missing = this.missingConfig();
    if (missing.length) throw new HttpError(503, 'github_not_configured', `GitHub App not configured: ${missing.join(', ')}`);
    const key = fs.readFileSync(this.cfg.privateKeyPath!, 'utf8');
    const jwt = createAppJwt(this.cfg.clientId ?? this.cfg.appId!, key);
    const repo = this.repo();
    const res = await this.fetchImpl(`${this.cfg.apiBase}/app/installations/${encodeURIComponent(this.cfg.installationId!)}/access_tokens`, {
      method: 'POST',
      headers: this.headers(jwt),
      body: JSON.stringify({ ...(repo ? { repositories: [repo.repo] } : {}), permissions: READ_PERMISSIONS }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; expires_at?: string; message?: string };
    if (!res.ok || !body.token) throw new HttpError(502, 'github_auth_failed', `GitHub installation token request failed (${res.status}): ${body.message ?? 'unknown error'}`);
    this.token = { value: body.token, expiresAt: Date.parse(body.expires_at ?? '') || Date.now() + 50 * 60_000 };
    return body.token;
  }

  private headers(bearer: string) {
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
      authorization: `Bearer ${bearer}`,
      'user-agent': 'NodePilot',
      'content-type': 'application/json',
    };
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.installationToken();
    const res = await this.fetchImpl(`${this.cfg.apiBase}${path}`, { headers: this.headers(token) });
    const body = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new HttpError(502, 'github_api_error', `GitHub ${path} → ${res.status}: ${(body as { message?: string }).message ?? ''}`);
    return body;
  }

  /** Polls GitHub with the installation token. Tokens never leave the server. */
  async refresh() {
    const repo = this.repo();
    if (!repo) throw new HttpError(409, 'no_repository', 'Select a repository first');
    const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
    const b = encodeURIComponent(repo.branch);
    try {
      type Commit = { sha: string; html_url: string; commit: { message: string; author?: { name?: string; date?: string } } };
      type Pull = { number: number; title: string; html_url: string; user?: { login?: string }; head: { ref: string }; draft?: boolean; updated_at: string };
      type CheckRuns = { check_runs: { name: string; status: string; conclusion: string | null; html_url: string }[] };
      type WfRuns = { workflow_runs: { id: number; name: string; status: string; conclusion: string | null; html_url: string; head_branch: string; created_at: string }[] };
      const [info, commits, pulls] = await Promise.all([
        this.get<{ full_name: string; default_branch: string; private: boolean; html_url: string }>(base),
        this.get<Commit[]>(`${base}/commits?sha=${b}&per_page=10`),
        this.get<Pull[]>(`${base}/pulls?state=open&per_page=10`),
      ]);
      const head = commits[0]?.sha;
      const [checks, runs] = await Promise.all([
        head ? this.get<CheckRuns>(`${base}/commits/${head}/check-runs?per_page=30`) : Promise.resolve({ check_runs: [] }),
        this.get<WfRuns>(`${base}/actions/runs?branch=${b}&per_page=10`).catch(() => ({ workflow_runs: [] })),
      ]);
      const cache = redactValue({
        fetchedAt: nowIso(),
        repository: { fullName: info.full_name, defaultBranch: info.default_branch, private: info.private, url: info.html_url },
        branch: repo.branch,
        commits: commits.map((c) => ({ sha: c.sha, url: c.html_url, message: c.commit.message.split('\n')[0], author: c.commit.author?.name, date: c.commit.author?.date })),
        pulls: pulls.map((p) => ({ number: p.number, title: p.title, url: p.html_url, author: p.user?.login, branch: p.head.ref, draft: !!p.draft, updatedAt: p.updated_at })),
        checks: checks.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url })),
        workflowRuns: runs.workflow_runs.map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url, createdAt: r.created_at })),
      });
      setSetting(this.db, 'github.cache', cache);
      this.lastState = { state: 'connected', at: nowIso() };
      this.bus.publish({ type: 'github.updated' });
      return cache;
    } catch (e) {
      this.lastState = { state: 'error', message: (e as Error).message, at: nowIso() };
      this.bus.publish({ type: 'github.updated' });
      throw e;
    }
  }

  /**
   * Handles a webhook delivery: signature verification, de-duplication by
   * X-GitHub-Delivery, and association with the selected repository.
   */
  handleWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): { status: number; result: string } {
    if (!this.cfg.webhookSecret) return { status: 503, result: 'Webhook secret not configured; delivery rejected' };
    const sig = headers['x-hub-signature-256'];
    if (!verifyWebhookSignature(this.cfg.webhookSecret, rawBody, Array.isArray(sig) ? sig[0] : sig)) return { status: 401, result: 'Invalid signature' };
    const delivery = String(headers['x-github-delivery'] ?? '');
    const event = String(headers['x-github-event'] ?? 'unknown');
    if (!/^[A-Za-z0-9-]{1,100}$/.test(delivery)) return { status: 400, result: 'Missing or invalid X-GitHub-Delivery' };
    let payload: { repository?: { full_name?: string }; action?: string; ref?: string } = {};
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { status: 400, result: 'Invalid JSON' };
    }
    const repo = this.repo();
    const fullName = payload.repository?.full_name ?? null;
    const associated = !!repo && !!fullName && fullName.toLowerCase() === `${repo.owner}/${repo.repo}`.toLowerCase();
    const summary = `${event}${payload.action ? `.${payload.action}` : ''}${payload.ref ? ` ${payload.ref}` : ''}`;
    const ins = this.db
      .prepare('INSERT OR IGNORE INTO github_deliveries (delivery_id, event, repo_full_name, associated, summary, received_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(delivery, event, fullName, associated ? 1 : 0, summary.slice(0, 300), nowIso());
    if (ins.changes === 0) return { status: 200, result: 'duplicate delivery ignored' };
    this.db.prepare('DELETE FROM github_deliveries WHERE delivery_id IN (SELECT delivery_id FROM github_deliveries ORDER BY received_at DESC LIMIT -1 OFFSET 1000)').run();
    this.bus.publish({ type: 'github.updated' });
    if (!associated) return { status: 202, result: `accepted but not associated with the selected repository (${fullName ?? 'none'})` };
    if (['push', 'pull_request', 'check_run', 'check_suite', 'workflow_run', 'status'].includes(event) && this.missingConfig().length === 0) {
      void this.refresh().catch(() => undefined);
    }
    return { status: 202, result: 'accepted' };
  }

  deliveries(limit = 30) {
    return (this.db.prepare('SELECT * FROM github_deliveries ORDER BY received_at DESC LIMIT ?').all(limit) as Record<string, string | number>[]).map((r) => ({
      deliveryId: r.delivery_id as string,
      event: r.event as string,
      repo: r.repo_full_name as string | null,
      associated: !!r.associated,
      summary: r.summary as string,
      receivedAt: r.received_at as string,
    }));
  }
}
