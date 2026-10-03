/**
 * Secret redaction for logs, telemetry, exports and diffs.
 *
 * Two layers: (1) pattern-based detection of common credential formats and
 * secret-looking key/value pairs; (2) exact-value replacement of secrets the
 * process knows about (registered via `registerKnownSecret`).
 */
export const REDACTED = '[REDACTED]';

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI-style
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\bnpa_[A-Za-z0-9]{20,}\b/g, // NodePilot tokens
];

// key=value / "key": "value" / Authorization: Bearer xxx
const KEYED = /((?:"|')?(?:[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret|authorization|cookie)[A-Za-z0-9_-]*)(?:"|')?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|Bearer\s+[^\s"',}]+|[^\s"',}]+)/gi;

const knownSecrets = new Set<string>();

/** Register an exact secret value (>= 8 chars) so it is replaced wherever it appears. */
export function registerKnownSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

export function clearKnownSecrets(): void {
  knownSecrets.clear();
}

export function redactString(input: string): string {
  let out = input;
  for (const s of knownSecrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
  for (const p of PATTERNS) out = out.replace(p, REDACTED);
  out = out.replace(KEYED, (m, prefix: string, value: string) => {
    const key = prefix.replace(/["'\s:=]/g, '');
    if (SAFE_KEYS.test(key) || /^(-?\d+(\.\d+)?|true|false|null|"\[REDACTED\]"|\[REDACTED\])$/.test(value)) return m;
    if (value.startsWith('"')) return `${prefix}"${REDACTED}"`;
    if (value.startsWith("'")) return `${prefix}'${REDACTED}'`;
    return `${prefix}${REDACTED}`;
  });
  return out;
}

const SECRET_KEY = /(password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret|authorization|cookie)/i;
/** Keys that merely *reference* credentials and are safe to keep. */
const SAFE_KEYS = /^(credentialRef|maxTokens|tokenCount|inputTokens|outputTokens|tokens|usage)$/i;

/** Deep-redacts any JSON-like value. Objects keyed with secret-looking names have their values replaced. */
export function redactValue<T>(value: T, depth = 0): T {
  if (depth > 20) return REDACTED as unknown as T;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && !SAFE_KEYS.test(k) && v !== null && v !== undefined && typeof v !== 'boolean' && typeof v !== 'number') {
        out[k] = REDACTED;
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out as T;
  }
  return value;
}

/** True if the text contains something that looks like a credential. */
export function containsSecret(input: string): boolean {
  return redactString(input) !== input;
}

/** Truncates the JSON form of a value to a byte budget, returning a JSON-safe preview. */
export function truncateForStorage(value: unknown, maxChars = 16_000): { value: unknown; truncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return { value: '[unserializable]', truncated: true };
  }
  if (text === undefined) return { value: null, truncated: false };
  if (text.length <= maxChars) return { value, truncated: false };
  return { value: { _truncated: true, preview: text.slice(0, maxChars), originalLength: text.length }, truncated: true };
}

/** Redact then truncate: the standard treatment for anything persisted from execution. */
export function sanitizeForStorage(value: unknown, maxChars = 16_000): { value: unknown; truncated: boolean } {
  return truncateForStorage(redactValue(value), maxChars);
}
