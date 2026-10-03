import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Guards for outbound health checks. Only explicitly approved targets are ever
 * requested, and only status/latency is returned (never the body), so this is
 * not a general URL-fetching proxy.
 */
const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata', 'metadata.azure.com', 'instance-data', 'instance-data.ec2.internal']);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
function inCidr4(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/** Returns a reason if the address must never be contacted. Loopback and private ranges are allowed (local dev backends). */
export function blockedAddressReason(address: string): string | null {
  let ip = address;
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    if (inCidr4(ip, '169.254.0.0/16')) return 'link-local / cloud metadata range';
    if (inCidr4(ip, '100.100.100.200/32')) return 'cloud metadata address';
    if (inCidr4(ip, '0.0.0.0/8')) return '"this network" range';
    if (inCidr4(ip, '224.0.0.0/4')) return 'multicast';
    if (inCidr4(ip, '240.0.0.0/4')) return 'reserved range';
    return null;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::') return 'unspecified address';
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return 'link-local';
    if (lower.startsWith('ff')) return 'multicast';
    if (lower === 'fd00:ec2::254') return 'cloud metadata address';
    return null;
  }
  return 'not an IP address';
}

export function validateTargetUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https health targets are allowed');
  if (u.username || u.password) throw new Error('Health target URLs must not contain credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) throw new Error(`Host "${host}" is blocked (cloud metadata)`);
  if (net.isIP(host)) {
    const reason = blockedAddressReason(host);
    if (reason) throw new Error(`Address ${host} is blocked: ${reason}`);
  }
  return u;
}

/** DNS lookup that refuses blocked addresses at connect time (defeats DNS rebinding between check and connect). */
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as (e: Error | null, a?: unknown, f?: number) => void)(err);
    const list = addresses as dns.LookupAddress[];
    for (const a of list) {
      const reason = blockedAddressReason(a.address);
      if (reason) return (callback as (e: Error) => void)(new Error(`Resolved address ${a.address} is blocked: ${reason}`));
    }
    if ((options as dns.LookupOptions).all) return (callback as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    (callback as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
  });
};

export interface CheckResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
  redirects: number;
}

function requestOnce(u: URL, timeoutMs: number): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', lookup: guardedLookup, timeout: timeoutMs, headers: { 'user-agent': 'NodePilot-health/0.1', accept: '*/*' } }, (res) => {
      res.resume(); // discard body; we never return it
      resolve({ status: res.statusCode ?? 0, location: res.headers.location });
    });
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** Performs a health check. Redirects are followed only within the approved origin (max 3). */
export async function checkHealth(raw: string, timeoutMs = 5000): Promise<CheckResult> {
  const start = Date.now();
  let redirects = 0;
  try {
    const approved = validateTargetUrl(raw);
    let u = approved;
    for (;;) {
      const r = await requestOnce(u, timeoutMs);
      if (r.status >= 300 && r.status < 400 && r.location) {
        if (++redirects > 3) throw new Error('Too many redirects');
        const next = validateTargetUrl(new URL(r.location, u).toString());
        if (next.origin !== approved.origin) throw new Error(`Redirect to unapproved origin ${next.origin} refused`);
        u = next;
        continue;
      }
      return { ok: r.status >= 200 && r.status < 300, status: r.status, latencyMs: Date.now() - start, redirects };
    }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, error: (e as Error).message, redirects };
  }
}
