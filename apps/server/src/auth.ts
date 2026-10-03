import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { nowIso, tx, type DB } from './db.js';
import type { ServerConfig } from './config.js';

export const SESSION_COOKIE = 'np_session';
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

export type Principal =
  | { kind: 'session' }
  | { kind: 'mcp' }
  | { kind: 'runner'; runnerId: string }
  | { kind: 'ingest'; serviceId: string };

export type PrincipalKind = Principal['kind'];

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function randomToken(prefix = 'npa'): string {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function pairingCode(): string {
  const bytes = crypto.randomBytes(8);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export class AuthService {
  constructor(private db: DB, private cfg: ServerConfig) {}

  /** Creates a single-use browser pairing code (shown in the server terminal only). */
  createPairingCode(): string {
    const code = pairingCode();
    this.db.prepare('INSERT INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)').run(
      sha256(normalizeCode(code)),
      new Date(Date.now() + this.cfg.pairingCodeTtlMs).toISOString(),
    );
    return code;
  }

  /** Throttles guessing: at most 10 failed attempts per 10 minutes across all clients. */
  private tooManyFailures(kind: string): boolean {
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM auth_failures WHERE kind = ? AND at > ?').get(kind, since) as { c: number };
    return row.c >= 10;
  }

  private recordFailure(kind: string) {
    this.db.prepare('INSERT INTO auth_failures (kind, at) VALUES (?, ?)').run(kind, nowIso());
    this.db.prepare('DELETE FROM auth_failures WHERE at < ?').run(new Date(Date.now() - 24 * 3600_000).toISOString());
  }

  /** Exchanges a pairing code for a new session token. */
  redeemPairingCode(code: string, userAgent?: string): { token: string } | { error: string; status: number } {
    if (this.tooManyFailures('pair')) return { error: 'Too many failed pairing attempts. Wait 10 minutes or restart the server for a new code.', status: 429 };
    const hash = sha256(normalizeCode(code ?? ''));
    return tx(this.db, () => {
      const row = this.db.prepare('SELECT expires_at, used_at FROM pairing_codes WHERE code_hash = ?').get(hash) as
        | { expires_at: string; used_at: string | null }
        | undefined;
      if (!row || row.used_at || row.expires_at < nowIso()) {
        this.recordFailure('pair');
        return { error: 'Invalid or expired pairing code', status: 401 };
      }
      this.db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?').run(nowIso(), hash);
      const token = randomToken('nps');
      this.db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)').run(
        sha256(token),
        nowIso(),
        new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        (userAgent ?? '').slice(0, 200),
      );
      return { token };
    });
  }

  validSession(token: string | undefined): boolean {
    if (!token) return false;
    const row = this.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)) as { expires_at: string } | undefined;
    return !!row && row.expires_at > nowIso();
  }

  revokeSession(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  // ---- MCP token: a local file readable by the same OS user, never sent to the browser ----
  mcpTokenPath(): string {
    return path.join(this.cfg.dataDir, 'mcp-token');
  }

  ensureMcpToken(): string {
    const p = this.mcpTokenPath();
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
    const token = randomToken('npm');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, token, { mode: 0o600 });
    return token;
  }

  private mcpTokenHash?: string;
  validMcpToken(token: string): boolean {
    this.mcpTokenHash ??= sha256(this.ensureMcpToken());
    return safeEqual(sha256(token), this.mcpTokenHash);
  }

  runnerForToken(token: string): string | null {
    const row = this.db.prepare('SELECT id FROM runners WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(token)) as { id: string } | undefined;
    return row?.id ?? null;
  }

  serviceForIngestToken(token: string): string | null {
    const row = this.db.prepare('SELECT id FROM services WHERE ingest_token_hash = ?').get(sha256(token)) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Resolves the principal from the session cookie or Bearer token. */
  identify(req: FastifyRequest): Principal | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      if (token.startsWith('npm_') && this.validMcpToken(token)) return { kind: 'mcp' };
      if (token.startsWith('npr_')) {
        const id = this.runnerForToken(token);
        if (id) return { kind: 'runner', runnerId: id };
      }
      if (token.startsWith('npi_')) {
        const id = this.serviceForIngestToken(token);
        if (id) return { kind: 'ingest', serviceId: id };
      }
      return undefined;
    }
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (cookie && this.validSession(cookie)) return { kind: 'session' };
    // Pairing disabled: any request that passed the Host/Origin checks acts as the local user.
    if (!this.cfg.requirePairing) return { kind: 'session' };
    return undefined;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, maxAgeMs = SESSION_TTL_MS): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

/**
 * Host header allow-list (blocks DNS rebinding) and Origin allow-list (blocks
 * cross-site requests). Browsers always send Origin on cross-origin and on
 * state-changing requests; requests carrying a disallowed Origin are rejected.
 */
export function checkHostAndOrigin(req: FastifyRequest, cfg: ServerConfig): string | null {
  const host = (req.headers.host ?? '').toLowerCase();
  if (!cfg.allowedHosts.map((h) => h.toLowerCase()).includes(host)) return `Host "${host}" is not allowed`;
  const origin = req.headers.origin;
  if (origin !== undefined && !cfg.allowedOrigins.includes(origin)) return `Origin "${origin}" is not allowed`;
  // A browser making a state-changing request without Origin is unusual; require Sec-Fetch-Site to be same-origin if present.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none' && origin === undefined) return 'Cross-site request blocked';
  return null;
}

export function requirePrincipal(...kinds: PrincipalKind[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.principal || !kinds.includes(req.principal.kind)) {
      return reply.code(401).send({ error: 'unauthorized', message: `This endpoint requires: ${kinds.join(' or ')}` });
    }
  };
}
