import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, createContext, type AppContext } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';

export interface TestEnv {
  ctx: AppContext;
  app: FastifyInstance;
  dir: string;
  cookie: string;
  mcpToken: string;
  close: () => Promise<void>;
}

export const HOST = '127.0.0.1:4317';

export async function makeEnv(overrides: Partial<ServerConfig> = {}, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<TestEnv> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepilot-test-'));
  const cfg = loadConfig({ NODEPILOT_DATA_DIR: dir } as NodeJS.ProcessEnv, { webDist: undefined, requirePairing: true, ...overrides });
  const ctx = createContext(cfg, { dbFile: path.join(dir, 'test.db'), ...opts });
  ctx.store.ensureExample();
  const app = await buildApp(ctx);
  const code = ctx.auth.createPairingCode();
  const res = await app.inject({ method: 'POST', url: '/api/auth/pair', headers: { host: HOST, 'content-type': 'application/json' }, payload: { code } });
  const cookie = String(res.headers['set-cookie']).split(';')[0];
  const mcpToken = ctx.auth.ensureMcpToken();
  return {
    ctx,
    app,
    dir,
    cookie,
    mcpToken,
    close: async () => {
      ctx.monitoring.stop();
      await ctx.files.stop();
      await app.close();
      ctx.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function ui(env: TestEnv, extra: Record<string, string> = {}) {
  return { host: HOST, cookie: env.cookie, origin: 'http://127.0.0.1:5173', ...extra };
}
