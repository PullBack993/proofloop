// Starts the application under test from a clean state, with fixed clock, locale and time
// zone, and only the environment variables the config allows (no host credentials).
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Config } from './types.js';
import { exec, killGroup, sleep } from './util.js';
import { redactText } from './redact.js';

export const DEFAULT_TIME = '2026-01-15T09:00:00.000Z';

export function appEnv(config: Config): NodeJS.ProcessEnv {
  const app = config.app;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    TZ: app.timezone ?? 'UTC',
    LANG: app.locale ?? 'en_US.UTF-8',
    LC_ALL: app.locale ?? 'en_US.UTF-8',
    NODE_ENV: 'test',
    PROOFLOOP: '1',
    CI: '1',
  };
  for (const name of app.passEnv ?? []) if (process.env[name] !== undefined) env[name] = process.env[name];
  for (const [k, v] of Object.entries(app.env ?? {})) {
    env[k] = v.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => ((app.passEnv ?? []).includes(n) ? (process.env[n] ?? '') : ''));
  }
  if ((app.clock?.mode ?? 'frozen') === 'frozen') {
    const shim = join(fileURLToPath(new URL('.', import.meta.url)), 'runtime', 'clock.js');
    env.PROOFLOOP_FIXED_TIME = app.clock?.time ?? DEFAULT_TIME;
    env.NODE_OPTIONS = `--import="${shim}"`;
  }
  return env;
}

export function fixedTime(config: Config): string | undefined {
  return (config.app.clock?.mode ?? 'frozen') === 'frozen' ? (config.app.clock?.time ?? DEFAULT_TIME) : undefined;
}

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

export class RunningApp {
  private log = '';
  constructor(
    private child: ChildProcess,
    readonly baseUrl: string,
  ) {
    child.stdout?.on('data', (d) => (this.log += d));
    child.stderr?.on('data', (d) => (this.log += d));
  }
  get exited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }
  logs(): string {
    return redactText(this.log);
  }
  async stop(): Promise<void> {
    if (this.exited) return;
    const done = new Promise<void>((r) => this.child.once('exit', () => r()));
    killGroup(this.child.pid, 'SIGTERM');
    await Promise.race([done, sleep(5000)]);
    if (!this.exited) killGroup(this.child.pid, 'SIGKILL');
  }
}

export class Blocked extends Error {
  constructor(
    message: string,
    readonly logs?: string,
  ) {
    super(message);
  }
}

/** setup + reset + start + health check. Throws Blocked when the app cannot be brought up. */
export async function startApp(config: Config, workspace: string, opts: { setup: boolean }): Promise<RunningApp> {
  const app = config.app;
  const cwd = join(workspace, app.cwd ?? '.');
  const env = appEnv(config);
  if (opts.setup && app.setup) {
    const r = await exec(app.setup, { cwd, env: { ...env, NODE_OPTIONS: undefined }, timeoutMs: 15 * 60_000 });
    if (r.code !== 0) throw new Blocked(`setup command failed (${app.setup}), exit ${r.code}`, redactText(r.stdout + r.stderr));
  }
  if (app.reset) {
    const r = await exec(app.reset, { cwd, env, timeoutMs: 5 * 60_000 });
    if (r.code !== 0) throw new Blocked(`reset command failed (${app.reset}), exit ${r.code}`, redactText(r.stdout + r.stderr));
  }
  const url = new URL(app.baseUrl);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (await portOpen(url.hostname, port))
    throw new Blocked(`port ${port} is already in use before start; another process would answer the probes`);
  const child = spawn('sh', ['-c', app.start], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const running = new RunningApp(child, app.baseUrl.replace(/\/$/, ''));
  const deadline = Date.now() + (app.startTimeoutMs ?? 60_000);
  const health = new URL(app.healthPath ?? '/', app.baseUrl).toString();
  while (Date.now() < deadline) {
    if (running.exited) throw new Blocked(`app exited during start (${app.start})`, running.logs());
    try {
      const res = await fetch(health, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return running;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  const logs = running.logs();
  await running.stop();
  throw new Blocked(`app did not answer ${health} within ${app.startTimeoutMs ?? 60_000} ms`, logs);
}
