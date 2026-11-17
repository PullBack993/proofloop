// Runs probes against a running app and records redacted observations plus evidence.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { ApiProbe, BrowserProbe, Config, DbProbe, Json, Observation, Probe, TestRun } from './types.js';
import type { Store } from './store.js';
import { redactHeaders, redactJson, redactText } from './redact.js';
import { exec } from './util.js';
import { fixedTime } from './app.js';

export interface ProbeContext {
  config: Config;
  store: Store;
  baseUrl: string;
  workspace: string;
  browser?: BrowserSession;
}

const KEPT_HEADERS = ['content-type', 'location', 'cache-control', 'access-control-allow-origin', 'www-authenticate'];

export function roleHeaders(config: Config, role: string | undefined): Record<string, string> {
  const r = role ?? config.defaultRole;
  if (!r) return {};
  if (r === 'anonymous' && !config.roles?.anonymous) return {};
  const def = config.roles?.[r];
  if (!def) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(def.headers ?? {}))
    out[k] = v.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => ((config.app.passEnv ?? []).includes(n) ? (process.env[n] ?? '') : ''));
  return out;
}

/** Route written as `/orders/:id`, whatever the source used (`[id]`, `{id}`). */
export function routeKey(path: string): string {
  return path.replace(/\[([A-Za-z_]\w*)\]|\{([A-Za-z_]\w*)\}/g, (_, a, b) => `:${a ?? b}`);
}

export function expandPath(path: string, config: Config): string {
  const own = config.routeParams?.[routeKey(path.split('?')[0])];
  return path.replace(/:([A-Za-z_]\w*)|\[([A-Za-z_]\w*)\]|\{([A-Za-z_]\w*)\}/g, (m, a, b, c) => own?.[a ?? b ?? c] ?? config.params?.[a ?? b ?? c] ?? m);
}

async function runApi(p: ApiProbe, ctx: ProbeContext): Promise<Omit<Observation, 'durationMs'>> {
  const headers: Record<string, string> = { accept: 'application/json', ...roleHeaders(ctx.config, p.role), ...(p.headers ?? {}) };
  let body: string | undefined;
  if (p.body !== undefined && p.body !== null) {
    body = typeof p.body === 'string' ? p.body : JSON.stringify(p.body);
    headers['content-type'] ??= 'application/json';
  }
  const url = ctx.baseUrl + expandPath(p.path, ctx.config);
  const res = await fetch(url, { method: p.method.toUpperCase(), headers, body, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let parsed: Json = text;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      parsed = JSON.parse(text) as Json;
    } catch {
      /* keep text */
    }
  }
  const kept: Record<string, string> = {};
  for (const h of KEPT_HEADERS) {
    const v = res.headers.get(h);
    if (v !== null) kept[h] = h === 'content-type' ? v.replace(/;\s*charset=utf-8/i, '') : v;
  }
  const value = redactJson({ status: res.status, headers: redactHeaders(kept), body: parsed });
  const evidence = { response: ctx.store.putEvidence(JSON.stringify({ request: { method: p.method, url, headers: redactHeaders(headers), body: body && redactText(body) }, response: value }, null, 2), 'json') };
  return { probeId: p.id, ok: true, value, evidence };
}

function runDb(p: DbProbe, ctx: ProbeContext): Omit<Observation, 'durationMs'> {
  const file = join(ctx.workspace, ctx.config.app.cwd ?? '.', p.sqlite);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare(p.query).all() as unknown as Json;
    const value = redactJson({ rows });
    return { probeId: p.id, ok: true, value, evidence: { rows: ctx.store.putEvidence(JSON.stringify(value, null, 2), 'json') } };
  } finally {
    db.close();
  }
}

// ---------- browser ----------

type PW = typeof import('playwright');

export class BrowserSession {
  private constructor(
    private pw: PW,
    private browser: import('playwright').Browser,
    readonly version: string,
  ) {}

  static async open(config: Config): Promise<BrowserSession> {
    const pw = (await import('playwright')) as PW;
    const browser = await pw.chromium.launch({
      headless: true,
      executablePath: config.browser?.executablePath,
      channel: config.browser?.channel,
    });
    return new BrowserSession(pw, browser, `chromium ${browser.version()}`);
  }

  async run(p: BrowserProbe, ctx: ProbeContext): Promise<Omit<Observation, 'durationMs'>> {
    const vp = ctx.config.browser?.viewport ?? { width: 1280, height: 800 };
    const context = await this.browser.newContext({
      viewport: vp,
      locale: (ctx.config.app.locale ?? 'en-US').replace(/\..*$/, '').replace('_', '-'),
      timezoneId: ctx.config.app.timezone ?? 'UTC',
      reducedMotion: 'reduce',
      extraHTTPHeaders: roleHeaders(ctx.config, p.role),
      deviceScaleFactor: 1,
    });
    const consoleErrors: string[] = [];
    try {
      const page = await context.newPage();
      const t = fixedTime(ctx.config);
      if (t) await page.clock.setFixedTime(new Date(t));
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(redactText(m.text()));
      });
      page.on('pageerror', (e) => consoleErrors.push(redactText(String(e))));
      const nav = await page.goto(ctx.baseUrl + expandPath(p.path, ctx.config), { waitUntil: 'networkidle', timeout: 30_000 });
      for (const step of p.steps ?? []) {
        if (step.goto) await page.goto(ctx.baseUrl + expandPath(step.goto, ctx.config), { waitUntil: 'networkidle' });
        if (step.click) await page.locator(step.click).first().click({ timeout: 10_000 });
        if (step.fill) await page.locator(step.fill.selector).first().fill(step.fill.value, { timeout: 10_000 });
        if (step.press) await page.locator(step.press.selector).first().press(step.press.key, { timeout: 10_000 });
        if (step.waitFor) await page.locator(step.waitFor).first().waitFor({ timeout: 10_000 });
        await page.waitForLoadState('networkidle');
      }
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
      const target = page.locator(p.capture?.selector ?? 'body').first();
      const aria = (await target.ariaSnapshot({ timeout: 10_000 })).split('\n');
      const evidence: Record<string, string> = {};
      if (p.capture?.screenshot !== false) {
        const png = await target.screenshot({ animations: 'disabled', timeout: 10_000 });
        evidence.screenshot = ctx.store.putEvidence(png, 'png');
      }
      const value = redactJson({
        status: nav?.status() ?? null,
        url: page.url().replace(ctx.baseUrl, ''),
        title: await page.title(),
        aria,
        consoleErrors,
      });
      evidence.state = ctx.store.putEvidence(JSON.stringify(value, null, 2), 'json');
      return { probeId: p.id, ok: true, value, evidence };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

export async function runProbe(p: Probe, ctx: ProbeContext): Promise<Observation> {
  const started = Date.now();
  try {
    let r: Omit<Observation, 'durationMs'>;
    if (p.kind === 'api') r = await runApi(p, ctx);
    else if (p.kind === 'db') r = runDb(p, ctx);
    else {
      if (!ctx.browser) throw new Error('browser not available (install Chromium with `npx playwright install chromium` or set browser.enabled=false)');
      r = await ctx.browser.run(p, ctx);
    }
    return { ...r, durationMs: Date.now() - started };
  } catch (e) {
    return { probeId: p.id, ok: false, error: redactText(String((e as Error).message ?? e)).slice(0, 2000), value: null, evidence: {}, durationMs: Date.now() - started };
  }
}

/** Read-only probes first, then writes in their declared order; DB facts last so they see the writes. */
export function orderProbes(probes: Probe[]): Probe[] {
  const reads = probes.filter((p) => p.kind !== 'db' && !p.mutates);
  const writes = probes.filter((p) => p.kind !== 'db' && p.mutates);
  const db = probes.filter((p) => p.kind === 'db');
  return [...reads, ...writes, ...db];
}

// ---------- existing tests ----------

export function parseTap(output: string): { name: string; ok: boolean }[] {
  const results: { name: string; ok: boolean }[] = [];
  const stack: string[] = [];
  // Node's TAP reporter nests subtests with 4-space indentation and announces them with "# Subtest: name".
  for (const line of output.split('\n')) {
    const sub = /^(\s*)# Subtest: (.*)$/.exec(line);
    if (sub) {
      const depth = sub[1].length / 4;
      stack.length = depth;
      stack[depth] = sub[2].trim();
      continue;
    }
    const m = /^(\s*)(not ok|ok)\s+\d+\s*(?:-\s*)?(.*)$/i.exec(line);
    if (!m) continue;
    // TAP 14 (Vitest): a trailing "{" opens a block of child results; directives such as
    // "# time=4.5ms" vary per run and are not part of the name.
    let rest = m[3].trim();
    const opens = /\s*\{$/.test(rest);
    if (opens) rest = rest.replace(/\s*\{$/, '');
    const directive = /\s+#\s*(\w+)\b.*$/.exec(rest);
    if (directive) rest = rest.slice(0, directive.index).trim();
    const depth = m[1].length / 4;
    if (opens) {
      stack.length = depth;
      stack[depth] = rest;
    }
    if (directive && /^(SKIP|TODO)$/i.test(directive[1])) continue;
    const parents = stack.slice(0, depth).filter(Boolean);
    const name = [...parents, rest].join(' > ');
    results.push({ name, ok: m[2].toLowerCase() === 'ok' });
  }
  return results;
}

export async function runTests(config: Config, workspace: string, store: Store, env: NodeJS.ProcessEnv): Promise<TestRun | undefined> {
  if (!config.tests) return undefined;
  const cwd = join(workspace, config.app.cwd ?? '.');
  const tests = config.tests;
  const once = async () => {
    const r = await exec(tests.command, { cwd, env, timeoutMs: tests.timeoutMs ?? 10 * 60_000 });
    const results = tests.format === 'tap' ? parseTap(r.stdout) : [{ name: 'test command', ok: r.code === 0 }];
    return { r, results };
  };
  // A suite that hangs or prints nothing is retried once; a second failure is reported as such.
  let { r, results } = await once();
  let retried = '';
  if (r.timedOut || (config.tests.format === 'tap' && results.length === 0)) {
    retried = `first attempt ${r.timedOut ? 'timed out' : 'produced no results'}; retried once. `;
    ({ r, results } = await once());
  }
  const log = redactText(retried + r.stdout + '\n' + r.stderr);
  return {
    command: config.tests.command,
    exitCode: r.code,
    results,
    logHash: store.putEvidence(log, 'log'),
    error: r.timedOut ? 'test command timed out' + (retried ? ' twice' : '') : results.length === 0 && config.tests.format === 'tap' ? 'no test results parsed' : undefined,
  };
}
