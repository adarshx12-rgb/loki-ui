import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/server (works from both src/ and dist/) */
export const SERVER_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..');

export interface ServerConfig {
  appName: string;
  host: string;
  port: number;
  dataDir: string;
  /** Browser origins allowed to call mutation endpoints and open the event stream. */
  allowedOrigins: string[];
  /** Host header values accepted (DNS-rebinding protection). */
  allowedHosts: string[];
  approvedRoots: string[];
  webDist?: string;
  github: {
    appId?: string;
    clientId?: string;
    privateKeyPath?: string;
    webhookSecret?: string;
    installationId?: string;
    apiBase: string;
  };
  executor: { concurrency: number };
  retention: { runsPerWorkflow: number; telemetryEvents: number; telemetryDays: number };
  /** Printed pairing code lifetime. */
  pairingCodeTtlMs: number;
  /** When false (default for now), browsers are not asked for a pairing code. Host/Origin checks still apply. */
  requirePairing: boolean;
}

function list(v: string | undefined): string[] {
  return (v ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const host = env.NODEPILOT_HOST ?? '127.0.0.1';
  const port = Number(env.NODEPILOT_PORT ?? 4317);
  const webPort = Number(env.NODEPILOT_WEB_PORT ?? 5173);
  const defaultOrigins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${webPort}`,
    `http://localhost:${webPort}`,
  ];
  const defaultHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `127.0.0.1:${webPort}`, `localhost:${webPort}`];
  const cfg: ServerConfig = {
    appName: env.NODEPILOT_APP_NAME ?? 'NodePilot',
    host,
    port,
    dataDir: path.resolve(env.NODEPILOT_DATA_DIR ?? path.join(REPO_ROOT, '.data')),
    allowedOrigins: [...defaultOrigins, ...list(env.NODEPILOT_ALLOWED_ORIGINS)],
    allowedHosts: [...defaultHosts, ...list(env.NODEPILOT_ALLOWED_HOSTS)],
    approvedRoots: list(env.NODEPILOT_APPROVED_ROOTS),
    webDist: path.join(REPO_ROOT, 'apps', 'web', 'dist'),
    github: {
      appId: env.GITHUB_APP_ID || undefined,
      clientId: env.GITHUB_APP_CLIENT_ID || undefined,
      privateKeyPath: env.GITHUB_APP_PRIVATE_KEY_PATH || undefined,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET || undefined,
      installationId: env.GITHUB_APP_INSTALLATION_ID || undefined,
      apiBase: env.GITHUB_API_BASE ?? 'https://api.github.com',
    },
    executor: { concurrency: Math.max(1, Math.min(16, Number(env.NODEPILOT_CONCURRENCY ?? 4))) },
    retention: {
      runsPerWorkflow: Number(env.NODEPILOT_RUNS_PER_WORKFLOW ?? 100),
      telemetryEvents: Number(env.NODEPILOT_TELEMETRY_MAX_EVENTS ?? 20_000),
      telemetryDays: Number(env.NODEPILOT_TELEMETRY_DAYS ?? 7),
    },
    pairingCodeTtlMs: 15 * 60_000,
    requirePairing: env.NODEPILOT_REQUIRE_PAIRING === '1',
    ...overrides,
  };
  if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host) && env.NODEPILOT_ALLOW_NON_LOOPBACK !== '1') {
    throw new Error(`Refusing to bind to non-loopback host "${cfg.host}". Set NODEPILOT_ALLOW_NON_LOOPBACK=1 if you really mean it.`);
  }
  return cfg;
}
