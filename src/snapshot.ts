// Baseline recorder: starts the app cleanly in an isolated workspace, runs every probe and the
// existing tests, and writes a manifest tied to the commit, environment and fixtures.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ControlSet, EnvFingerprint, Manifest, Observation, Probe } from './types.js';
import type { Store } from './store.js';
import { addWorktree, headCommit, removeWorktree, resolveRef, workingTreeState } from './git.js';
import { appEnv, Blocked, fixedTime, startApp, type RunningApp } from './app.js';
import { BrowserSession, orderProbes, runProbe, runTests, type ProbeContext } from './probes.js';
import { buildInventory } from './inventory.js';
import { newId, sha256, writeJson, readJson } from './util.js';

export interface CaptureOptions {
  ref?: string;
  label: string;
  /** Probe set to use instead of control probes (verify re-runs the baseline's probes). */
  probes?: Probe[];
  keepWorkspace?: boolean;
  log?: (msg: string) => void;
}

/** Hash of the fixture files; an entry may be a folder (every file in it, sorted). */
function fileHash(dir: string, files: string[]): string | undefined {
  const expand = (f: string): string[] => {
    const abs = join(dir, f);
    if (!existsSync(abs)) return [];
    if (!statSync(abs).isDirectory()) return [f];
    return readdirSync(abs).sort().flatMap((x) => expand(join(f, x)));
  };
  const present = files.flatMap(expand);
  if (!present.length) return undefined;
  return sha256(present.map((f) => `${f}\n${sha256(readFileSync(join(dir, f)))}`).join('\n')).slice(0, 16);
}

function fingerprint(set: ControlSet, workspace: string, browser?: string): EnvFingerprint {
  const appDir = join(workspace, set.config.app.cwd ?? '.');
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    browser,
    timezone: set.config.app.timezone ?? 'UTC',
    locale: set.config.app.locale ?? 'en_US.UTF-8',
    clock: fixedTime(set.config) ?? 'real',
    fixturesHash: fileHash(appDir, set.config.fixtures?.files ?? []),
    lockfileHash: fileHash(appDir, ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']),
  };
}

/** A live capture: the app stays up so suspicious probes can be re-run before shutdown. */
export class Capture {
  manifest: Manifest;
  private app?: RunningApp;
  private ctx?: ProbeContext;

  private constructor(
    private store: Store,
    private set: ControlSet,
    readonly workspace: string,
    private worktree: string | undefined,
    manifest: Manifest,
    private opts: CaptureOptions,
  ) {
    this.manifest = manifest;
  }

  static async open(store: Store, root: string, control: { version: number; set: ControlSet }, opts: CaptureOptions): Promise<Capture> {
    const id = newId('snap');
    const log = opts.log ?? (() => {});
    let workspace = root;
    let worktree: string | undefined;
    let commit: string;
    let dirty = false;
    let diffHash: string | undefined;
    if (opts.ref) {
      commit = resolveRef(root, opts.ref);
      worktree = store.path('worktrees', id);
      log(`workspace: git worktree at ${commit.slice(0, 10)}`);
      addWorktree(root, commit, worktree);
      workspace = worktree;
    } else {
      commit = headCommit(root);
      const st = workingTreeState(root);
      dirty = st.dirty;
      diffHash = st.diffHash;
      log(`workspace: working tree at ${commit.slice(0, 10)}${dirty ? ` + uncommitted changes (${diffHash})` : ''}`);
    }
    store.startRun(id, 'snapshot', commit, opts.label);
    const set = control.set;
    const baseProbes = opts.probes ?? set.probes;
    const inv = buildInventory(set.config, workspace, baseProbes);
    const probes = opts.probes
      ? [...baseProbes, ...inv.generated.filter((g) => !baseProbes.some((p) => p.id === g.id))]
      : [...baseProbes, ...inv.generated];
    const manifest: Manifest = {
      id,
      label: opts.label,
      createdAt: new Date().toISOString(),
      repoRoot: root,
      commit,
      ref: opts.ref,
      dirty,
      worktreeDiffHash: diffHash,
      workspace: worktree ? 'worktree' : 'working-tree',
      controlVersion: control.version,
      env: fingerprint(set, workspace),
      status: 'complete',
      probes,
      observations: [],
      inventory: inv.report,
    };
    const cap = new Capture(store, set, workspace, worktree, manifest, opts);
    try {
      log(`starting app: ${set.config.app.start}`);
      cap.app = await startApp(set.config, workspace, { setup: !!worktree });
      let browser: BrowserSession | undefined;
      if (probes.some((p) => p.kind === 'browser') && set.config.browser?.enabled !== false) {
        try {
          browser = await BrowserSession.open(set.config);
          manifest.env.browser = browser.version;
        } catch (e) {
          log(`browser unavailable: ${(e as Error).message.split('\n')[0]}`);
        }
      }
      cap.ctx = { config: set.config, store, baseUrl: cap.app.baseUrl, workspace, browser };
    } catch (e) {
      manifest.status = 'blocked';
      manifest.blockedReason = (e as Error).message;
      if (e instanceof Blocked && e.logs) manifest.appLogHash = store.putEvidence(e.logs, 'log');
      store.event('snapshot.blocked', { reason: manifest.blockedReason }, id);
    }
    return cap;
  }

  get blocked(): boolean {
    return this.manifest.status === 'blocked';
  }

  /** Re-runs of suspicious read-only probes, taken right away so later writes cannot skew them. */
  readonly reruns = new Map<string, Observation[]>();

  async observeAll(suspicious?: (probe: Probe, obs: Observation) => boolean): Promise<void> {
    if (!this.ctx) return;
    const log = this.opts.log ?? (() => {});
    const times = Math.max(0, this.set.config.flakeReruns ?? 2);
    for (const p of orderProbes(this.manifest.probes)) {
      const o = await runProbe(p, this.ctx);
      this.manifest.observations.push(o);
      this.store.event('probe', { probe: p.id, ok: o.ok, error: o.error, ms: o.durationMs }, this.manifest.id);
      let note = '';
      if (!p.mutates && times && suspicious?.(p, o)) {
        const again: Observation[] = [];
        for (let i = 0; i < times; i++) again.push(await runProbe(p, this.ctx));
        this.reruns.set(p.id, again);
        note = ` (differs from baseline; re-ran ${times}x)`;
      }
      log(`  ${o.ok ? '✓' : '✗'} ${p.id}${o.ok ? '' : ` — ${o.error}`}${note}`);
    }
  }

  /** Run one probe against the running app (used by `proofloop probe run`). */
  async observeOne(probe: Probe): Promise<Observation | undefined> {
    if (!this.ctx) return undefined;
    return runProbe(probe, this.ctx);
  }

  async finish(): Promise<Manifest> {
    const log = this.opts.log ?? (() => {});
    if (this.ctx?.browser) await this.ctx.browser.close();
    if (this.app) {
      await this.app.stop();
      this.manifest.appLogHash = this.store.putEvidence(this.app.logs(), 'log');
    }
    if (!this.blocked && this.set.config.tests) {
      log(`running existing tests: ${this.set.config.tests.command}`);
      this.manifest.tests = await runTests(this.set.config, this.workspace, this.store, appEnv(this.set.config));
      const failed = this.manifest.tests?.results.filter((r) => !r.ok).length ?? 0;
      log(`  ${this.manifest.tests?.results.length ?? 0} tests, ${failed} failing`);
    }
    if (this.worktree && !this.opts.keepWorkspace) removeWorktree(this.manifest.repoRoot, this.worktree);
    writeJson(this.store.path('snapshots', `${this.manifest.id}.json`), this.manifest);
    this.store.finishRun(this.manifest.id, this.manifest.status, { label: this.manifest.label });
    return this.manifest;
  }
}

export async function takeSnapshot(store: Store, root: string, control: { version: number; set: ControlSet }, opts: CaptureOptions): Promise<Manifest> {
  const cap = await Capture.open(store, root, control, opts);
  await cap.observeAll();
  return cap.finish();
}

export function loadManifest(store: Store, id: string): Manifest {
  const file = store.path('snapshots', `${id}.json`);
  if (!existsSync(file)) throw new Error(`No snapshot ${id}`);
  return readJson<Manifest>(file);
}

/** Most recent complete baseline, preferring one recorded on the given commit. */
export function latestBaseline(store: Store, commit?: string): Manifest | undefined {
  const rows = store.runs('snapshot').filter((r) => r.status === 'complete' && (r.label ?? '').startsWith('baseline'));
  const pick = (commit && rows.find((r) => r.commit_sha === commit)) || rows[0];
  return pick ? loadManifest(store, pick.id) : undefined;
}
