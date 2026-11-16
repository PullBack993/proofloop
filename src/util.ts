import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Json } from './types.js';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with sorted object keys, so equal values always hash the same. */
export function stableStringify(value: unknown, indent?: number): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

export function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

export function newId(prefix: string): string {
  const t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${prefix}-${t}-${randomBytes(3).toString('hex')}`;
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function readJsonIf<T>(file: string, fallback: T): T {
  return existsSync(file) ? readJson<T>(file) : fallback;
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** Glob for ids and paths: `*` matches within a segment, `**` matches anything. */
export function globToRegex(glob: string, segmentChars = '[^/]'): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += `${segmentChars}*`;
    } else if (c === '?') re += segmentChars;
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function globMatch(glob: string, value: string): boolean {
  return globToRegex(glob, '.').test(value) || globToRegex(glob).test(value);
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export function exec(
  command: string,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } ,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('sh', ['-c', command], { cwd: opts.cwd, env: opts.env ?? process.env, detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killGroup(child.pid);
        }, opts.timeoutMs)
      : undefined;
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e), timedOut, durationMs: Date.now() - started });
    });
  });
}

export function killGroup(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function fmtJson(v: Json | undefined): string {
  if (v === undefined) return '∅';
  return truncate(JSON.stringify(v), 120);
}

export class UserError extends Error {}
