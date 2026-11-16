// A small JSONPath subset: $.a.b, $.a[0], $.a[*].b, $.a["key with space"].
// Concrete paths produced by the differ always use this same syntax.
import type { Json } from './types.js';

type Seg = { key: string } | { index: number } | { wildcard: true };

export function parsePath(path: string): Seg[] {
  if (!path.startsWith('$')) throw new Error(`Path must start with $: ${path}`);
  const segs: Seg[] = [];
  let i = 1;
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      i++;
      let key = '';
      while (i < path.length && path[i] !== '.' && path[i] !== '[') key += path[i++];
      segs.push(key === '*' ? { wildcard: true } : { key });
    } else if (c === '[') {
      const end = path.indexOf(']', i);
      if (end < 0) throw new Error(`Unclosed [ in ${path}`);
      const inner = path.slice(i + 1, end);
      if (inner === '*') segs.push({ wildcard: true });
      else if (/^\d+$/.test(inner)) segs.push({ index: Number(inner) });
      else segs.push({ key: JSON.parse(inner.replace(/^'(.*)'$/, '"$1"')) as string });
      i = end + 1;
    } else throw new Error(`Bad path ${path} at ${i}`);
  }
  return segs;
}

/** All values matching the path, with their concrete paths. */
export function select(value: Json | undefined, path: string): { path: string; value: Json }[] {
  let current: { path: string; value: Json }[] = value === undefined ? [] : [{ path: '$', value }];
  for (const seg of parsePath(path)) {
    const next: { path: string; value: Json }[] = [];
    for (const { path: p, value: v } of current) {
      if ('wildcard' in seg) {
        if (Array.isArray(v)) v.forEach((x, i) => next.push({ path: `${p}[${i}]`, value: x }));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) next.push({ path: childPath(p, k), value: x });
      } else if ('index' in seg) {
        if (Array.isArray(v) && seg.index < v.length) next.push({ path: `${p}[${seg.index}]`, value: v[seg.index] });
      } else if (v && typeof v === 'object' && !Array.isArray(v) && seg.key in v) {
        next.push({ path: childPath(p, seg.key), value: (v as Record<string, Json>)[seg.key] });
      }
    }
    current = next;
  }
  return current;
}

export function childPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$-]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

/** Does a pattern (with [*] and .* wildcards, or a trailing ..) match a concrete path, or a prefix of it? */
export function pathMatches(pattern: string, concrete: string, allowPrefix = true): boolean {
  const re = patternRegex(pattern, allowPrefix);
  return re.test(concrete);
}

function patternRegex(pattern: string, allowPrefix: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith('[*]', i)) {
      re += '\\[\\d+\\]';
      i += 2;
    } else if (pattern.startsWith('.**', i)) {
      re += '(?:\\..*|\\[.*)?';
      i += 2;
    } else if (pattern.startsWith('.*', i)) {
      re += '(?:\\.[^.[]+|\\["[^"]*"\\])';
      i += 1;
    } else re += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}${allowPrefix ? '(?:[.[].*)?' : ''}$`);
}

/** Apply a transform to every node matching the pattern. Returns a new value. */
export function transformAt(value: Json, pattern: string, fn: (v: Json) => Json | undefined): Json {
  const walk = (v: Json, p: string): Json | undefined => {
    if (pathMatches(pattern, p, false)) return fn(v);
    if (Array.isArray(v)) {
      const out: Json[] = [];
      v.forEach((x, i) => {
        const r = walk(x, `${p}[${i}]`);
        if (r !== undefined) out.push(r);
      });
      return out;
    }
    if (v && typeof v === 'object') {
      const out: Record<string, Json> = {};
      for (const [k, x] of Object.entries(v)) {
        const r = walk(x, childPath(p, k));
        if (r !== undefined) out[k] = r;
      }
      return out;
    }
    return v;
  };
  const r = walk(value, '$');
  return r === undefined ? null : r;
}
