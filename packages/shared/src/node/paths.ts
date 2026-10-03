import fs from 'node:fs';
import path from 'node:path';

export class PathRestrictionError extends Error {
  readonly code = 'PATH_RESTRICTED';
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

function norm(p: string): string {
  const n = path.normalize(p);
  return caseInsensitive ? n.toLowerCase() : n;
}

/** True when `target` equals `root` or is inside it. Both must already be absolute and normalised. */
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(norm(root), norm(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolves the real path of `p`, following symlinks. For paths that do not exist yet,
 * resolves the nearest existing ancestor and appends the remainder, so a symlinked
 * parent directory cannot be used to escape a root.
 */
export function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Resolves `candidate` (absolute, or relative to `base`) and guarantees the real
 * location is inside one of `roots`. Accounts for `..` traversal and symlinks.
 */
export function resolveWithinRoots(
  roots: string[],
  candidate: string,
  opts: { base?: string; mustExist?: boolean } = {},
): { path: string; root: string } {
  if (typeof candidate !== 'string' || candidate.length === 0) throw new PathRestrictionError('Empty path');
  if (candidate.includes('\0')) throw new PathRestrictionError('Path contains a null byte');
  if (roots.length === 0) throw new PathRestrictionError('No approved roots are configured');
  const base = opts.base ?? roots[0];
  const lexical = path.resolve(base, candidate);
  // Lexical check first (cheap, catches obvious traversal even if target is missing).
  const realRoots = roots.map((r) => realpathLoose(r));
  const lexicalOk = roots.some((r) => isWithin(path.resolve(r), lexical)) || realRoots.some((r) => isWithin(r, lexical));
  if (!lexicalOk) throw new PathRestrictionError(`Path is outside the approved directories: ${candidate}`);
  if (opts.mustExist && !fs.existsSync(lexical)) throw new PathRestrictionError(`Path does not exist: ${candidate}`);
  const real = realpathLoose(lexical);
  const root = realRoots.find((r) => isWithin(r, real));
  if (!root) throw new PathRestrictionError(`Path resolves (via symlink) outside the approved directories: ${candidate}`);
  return { path: real, root };
}

/** Validates a directory is suitable as an approved root. */
export function assertApprovableRoot(dir: string): string {
  if (!path.isAbsolute(dir)) throw new PathRestrictionError('Approved directories must be absolute paths');
  const real = realpathLoose(dir);
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    throw new PathRestrictionError(`Directory does not exist: ${dir}`);
  }
  if (!st.isDirectory()) throw new PathRestrictionError(`Not a directory: ${dir}`);
  const parsed = path.parse(real);
  if (parsed.root === real) throw new PathRestrictionError('A filesystem root cannot be approved');
  return real;
}
