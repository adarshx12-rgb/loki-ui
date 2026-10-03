#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHttpClient, readToken } from './client.js';
import { createMcpServer } from './server.js';

// stdout carries the MCP protocol only. All diagnostics go to stderr.
const log = (...args: unknown[]) => process.stderr.write(`[nodepilot-mcp] ${args.map(String).join(' ')}\n`);
console.log = (...a: unknown[]) => log(...a);
console.info = (...a: unknown[]) => log(...a);
console.warn = (...a: unknown[]) => log(...a);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const baseUrl = process.env.NODEPILOT_URL ?? 'http://127.0.0.1:4317';
const dataDir = path.resolve(process.env.NODEPILOT_DATA_DIR ?? path.join(repoRoot, '.data'));

try {
  const u = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) log(`warning: NODEPILOT_URL ${baseUrl} is not a loopback address`);
} catch {
  log(`invalid NODEPILOT_URL ${baseUrl}`);
  process.exit(1);
}

let token: string;
try {
  token = readToken(dataDir);
} catch (e) {
  log((e as Error).message);
  process.exit(1);
}

const server = createMcpServer(createHttpClient(baseUrl, token));
await server.connect(new StdioServerTransport());
log(`ready (server ${baseUrl}, data ${dataDir})`);
