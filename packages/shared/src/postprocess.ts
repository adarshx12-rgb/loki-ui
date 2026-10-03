import type { PostProcessStep } from './schema.js';

/**
 * A deliberately small, validated transformation language. No user code is
 * evaluated: every step is data interpreted by this function.
 */
export function getPath(value: unknown, path: string): unknown {
  if (path === '') return value;
  let cur: unknown = value;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setPath(target: Record<string, unknown>, path: string, val: unknown): Record<string, unknown> {
  if (path === '') return val as Record<string, unknown>;
  const keys = path.split('.');
  if (keys.some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) throw new Error('Invalid path');
  const root = { ...target };
  let cur: Record<string, unknown> = root;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = val;
    else {
      const nextVal = cur[k];
      cur[k] = nextVal && typeof nextVal === 'object' && !Array.isArray(nextVal) ? { ...(nextVal as object) } : {};
      cur = cur[k] as Record<string, unknown>;
    }
  });
  return root;
}

function compare(a: unknown, cmp: string, b: unknown): boolean {
  switch (cmp) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'gt': return typeof a === 'number' && typeof b === 'number' && a > b;
    case 'gte': return typeof a === 'number' && typeof b === 'number' && a >= b;
    case 'lt': return typeof a === 'number' && typeof b === 'number' && a < b;
    case 'lte': return typeof a === 'number' && typeof b === 'number' && a <= b;
    case 'contains':
      if (typeof a === 'string') return typeof b === 'string' && a.includes(b);
      if (Array.isArray(a)) return a.includes(b);
      return false;
    case 'exists': return a !== undefined && a !== null;
    default: return false;
  }
}

function requireArray(value: unknown, path: string, op: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${op}: value at "${path || '(root)'}" is not an array`);
  return value;
}

export function applyPostProcess(input: unknown, steps: PostProcessStep[]): unknown {
  let value: unknown = input;
  for (const step of steps) {
    switch (step.op) {
      case 'select': {
        let out: Record<string, unknown> = {};
        for (const f of step.fields) {
          const v = getPath(value, f);
          if (v !== undefined) out = setPath(out, f, v);
        }
        value = out;
        break;
      }
      case 'map': {
        const out: Record<string, unknown> = {};
        for (const [k, p] of Object.entries(step.mapping)) out[k] = getPath(value, p);
        value = out;
        break;
      }
      case 'filter': {
        const arr = requireArray(getPath(value, step.path), step.path, 'filter');
        const filtered = arr.filter((item) => compare(getPath(item, step.where.field), step.where.cmp, step.where.value));
        value = step.path === '' ? filtered : setPath((value ?? {}) as Record<string, unknown>, step.path, filtered);
        break;
      }
      case 'sort': {
        const arr = [...requireArray(getPath(value, step.path), step.path, 'sort')];
        const dir = step.order === 'desc' ? -1 : 1;
        arr.sort((a, b) => {
          const x = getPath(a, step.by) as never;
          const y = getPath(b, step.by) as never;
          if (x === y) return 0;
          if (x === undefined) return 1;
          if (y === undefined) return -1;
          return (x < y ? -1 : 1) * dir;
        });
        value = step.path === '' ? arr : setPath((value ?? {}) as Record<string, unknown>, step.path, arr);
        break;
      }
      case 'limit': {
        const arr = requireArray(getPath(value, step.path), step.path, 'limit').slice(0, step.count);
        value = step.path === '' ? arr : setPath((value ?? {}) as Record<string, unknown>, step.path, arr);
        break;
      }
    }
  }
  return value;
}
