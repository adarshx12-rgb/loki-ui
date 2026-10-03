import { registerKnownSecret } from '@nodepilot/shared';
import { nowIso, type DB } from './db.js';
import type { CredentialResolver } from './executor/handlers.js';

/**
 * Local secret store (SQLite file inside the git-ignored data directory) plus
 * environment-variable lookup. Values are write-only from the API: they are
 * never returned to the browser, and every value is registered for redaction.
 */
export class Secrets implements CredentialResolver {
  constructor(private db: DB, private env: NodeJS.ProcessEnv = process.env) {
    for (const r of db.prepare('SELECT value FROM secrets').all() as { value: string }[]) registerKnownSecret(r.value);
  }

  list(): { name: string; createdAt: string }[] {
    return (this.db.prepare('SELECT name, created_at FROM secrets ORDER BY name').all() as { name: string; created_at: string }[]).map((r) => ({
      name: r.name,
      createdAt: r.created_at,
    }));
  }

  set(name: string, value: string): void {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error('Secret names use lowercase letters, digits, ".", "_" and "-"');
    if (!value || value.length > 10_000) throw new Error('Secret value must be 1–10000 characters');
    this.db
      .prepare('INSERT INTO secrets (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at')
      .run(name, value, nowIso());
    registerKnownSecret(value);
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }

  resolve(ref: string): string | undefined {
    if (ref.startsWith('env:')) {
      const v = this.env[ref.slice(4)];
      if (v) registerKnownSecret(v);
      return v || undefined;
    }
    if (ref.startsWith('secret:')) {
      const row = this.db.prepare('SELECT value FROM secrets WHERE name = ?').get(ref.slice(7)) as { value: string } | undefined;
      return row?.value;
    }
    return undefined;
  }

  available(ref: string): boolean {
    return !!this.resolve(ref);
  }
}
