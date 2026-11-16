// Field-level semantic diff with typed, versioned normalization rules, plus a line diff for
// accessibility snapshots and a pixel diff for screenshots.
import type { Json, Rule } from './types.js';
import { childPath, transformAt } from './jsonpath.js';
import { globMatch, stableStringify } from './util.js';

export interface RawDiff {
  path: string;
  change: 'added' | 'removed' | 'changed';
  before?: Json;
  after?: Json;
}

export function rulesFor(rules: Rule[], probeId: string): Rule[] {
  return rules.filter((r) => globMatch(r.probe, probeId));
}

/** Applies every matching rule. Rules are the only way a field is ever ignored. */
export function normalize(value: Json, rules: Rule[]): Json {
  let v = value;
  for (const r of rules) {
    switch (r.kind) {
      case 'ignore-path':
        v = transformAt(v, r.path, () => `<ignored by rule ${r.id}@v${r.version}>`);
        break;
      case 'mask':
        v = transformAt(v, r.path, (x) => (typeof x === 'string' ? x.replace(new RegExp(r.pattern, 'g'), r.replacement ?? '<masked>') : x));
        break;
      case 'round':
        v = transformAt(v, r.path, (x) => (typeof x === 'number' ? Number(x.toFixed(r.digits)) : x));
        break;
      case 'unordered':
        v = transformAt(v, r.path, (x) => {
          if (!Array.isArray(x)) return x;
          const key = (e: Json) =>
            r.key && e && typeof e === 'object' && !Array.isArray(e) ? stableStringify((e as Record<string, Json>)[r.key]) : stableStringify(e);
          return [...x].sort((a, b) => key(a).localeCompare(key(b)));
        });
        break;
      case 'ignore-region':
        break; // applied in the visual diff
    }
  }
  return v;
}

const LINE_DIFF_KEYS = new Set(['aria']);

export function diffJson(before: Json | undefined, after: Json | undefined, path = '$'): RawDiff[] {
  if (before === undefined && after === undefined) return [];
  if (before === undefined) return [{ path, change: 'added', after }];
  if (after === undefined) return [{ path, change: 'removed', before }];
  const isObj = (x: Json) => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (Array.isArray(before) && Array.isArray(after)) {
    if (path.endsWith('.aria') || [...LINE_DIFF_KEYS].some((k) => path === `$.${k}`)) return diffLines(before, after, path);
    const out: RawDiff[] = [];
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) out.push(...diffJson(before[i], after[i], `${path}[${i}]`));
    return out;
  }
  if (isObj(before) && isObj(after)) {
    const b = before as Record<string, Json>;
    const a = after as Record<string, Json>;
    const out: RawDiff[] = [];
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) out.push(...diffJson(b[k], a[k], childPath(path, k)));
    return out;
  }
  return stableStringify(before) === stableStringify(after) ? [] : [{ path, change: 'changed', before, after }];
}

/** LCS line diff, grouped into hunks: one inserted or removed block is one difference. */
export function diffLines(before: Json[], after: Json[], path: string): RawDiff[] {
  const a = before.map((x) => stableStringify(x));
  const b = after.map((x) => stableStringify(x));
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: RawDiff[] = [];
  let hunk: { i: number; j: number; removed: Json[]; added: Json[] } | undefined;
  const flush = () => {
    if (!hunk) return;
    const { removed, added } = hunk;
    const lines = (xs: Json[]) => (xs.length === 1 ? xs[0] : xs);
    if (removed.length && added.length) out.push({ path: `${path}[${hunk.i}]`, change: 'changed', before: lines(removed), after: lines(added) });
    else if (removed.length) out.push({ path: `${path}[${hunk.i}]`, change: 'removed', before: lines(removed) });
    else out.push({ path: `${path}[${hunk.i}]`, change: 'added', after: lines(added) });
    hunk = undefined;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      hunk ??= { i, j, removed: [], added: [] };
      hunk.added.push(after[j]);
      j++;
    } else {
      hunk ??= { i, j, removed: [], added: [] };
      hunk.removed.push(before[i]);
      i++;
    }
  }
  flush();
  return out;
}

export interface VisualResult {
  changedRatio: number;
  diffPng?: Buffer;
  sizeChanged: boolean;
}

export async function diffImages(beforePng: Buffer, afterPng: Buffer, rules: Rule[]): Promise<VisualResult> {
  const { PNG } = await import('pngjs');
  const pixelmatch = (await import('pixelmatch')).default;
  const a = PNG.sync.read(beforePng);
  const b = PNG.sync.read(afterPng);
  if (a.width !== b.width || a.height !== b.height) return { changedRatio: 1, sizeChanged: true };
  for (const r of rules) {
    if (r.kind !== 'ignore-region') continue;
    for (const img of [a, b])
      for (let y = Math.max(0, r.y); y < Math.min(img.height, r.y + r.height); y++)
        for (let x = Math.max(0, r.x); x < Math.min(img.width, r.x + r.width); x++) {
          const idx = (img.width * y + x) << 2;
          img.data[idx] = img.data[idx + 1] = img.data[idx + 2] = 0;
          img.data[idx + 3] = 255;
        }
  }
  const out = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: 0.1 });
  return { changedRatio: changed / (a.width * a.height), diffPng: changed ? PNG.sync.write(out) : undefined, sizeChanged: false };
}
