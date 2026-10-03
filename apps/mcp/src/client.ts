import fs from 'node:fs';
import path from 'node:path';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export interface ApiClient {
  get<T = unknown>(p: string): Promise<T>;
  post<T = unknown>(p: string, body: unknown): Promise<T>;
}

/**
 * HTTP client for the NodePilot server. The MCP server never touches the
 * database directly: all mutations go through the same validation, revision
 * checks and audit log as the UI, and the server broadcasts them to the canvas.
 */
export function createHttpClient(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): ApiClient {
  const call = async <T>(method: string, p: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(new URL(p, baseUrl), {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(0, 'server_unreachable', `NodePilot server is not reachable at ${baseUrl}. Start it with "npm start" (or "npm run dev"). (${(e as Error).message})`);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, json?.error ?? 'error', json?.message ?? `HTTP ${res.status}`, json?.details);
    return json as T;
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

export function readToken(dataDir: string): string {
  const file = path.join(dataDir, 'mcp-token');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`Cannot read the NodePilot MCP token at ${file}. Start the NodePilot server once to create it, and check NODEPILOT_DATA_DIR.`);
  }
}
