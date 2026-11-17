// The control set: config, contract, rules, probes and lessons. Humans edit the copies in
// <repo>/.proofloop; `proofloop freeze` copies them into the store outside the repository.
// Runs only ever use a frozen version. The tool may add checks on its own; anything that
// weakens a check needs an explicit human approval.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Contract, ControlSet, Lesson, Probe, Rule } from './types.js';
import { ORACLE_STRENGTH } from './types.js';
import { Store } from './store.js';
import { hashJson, readJson, readJsonIf, stableStringify, UserError, writeJson } from './util.js';

export const CONTROL_DIR = '.proofloop';

export function readRepoControl(root: string): Omit<ControlSet, 'lessons'> {
  const dir = join(root, CONTROL_DIR);
  const configFile = join(dir, 'config.json');
  if (!existsSync(configFile)) throw new UserError(`No ${CONTROL_DIR}/config.json in ${root}. Run \`proofloop init\` first.`);
  const config = readJson<Config>(configFile);
  const contract = readJsonIf<Contract>(join(dir, 'contract.json'), { version: 1, requirements: [] });
  const rules = readJsonIf<Rule[]>(join(dir, 'rules.json'), []);
  const probes: Probe[] = [];
  const probesDir = join(dir, 'probes');
  if (existsSync(probesDir)) {
    for (const f of readdirSync(probesDir).filter((f) => f.endsWith('.json')).sort()) {
      const data = readJson<Probe | Probe[]>(join(probesDir, f));
      for (const p of Array.isArray(data) ? data : [data]) probes.push({ source: 'hand', ...p });
    }
  }
  return { config, contract, rules, probes };
}

export function validateControl(set: Omit<ControlSet, 'lessons'>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { config, contract, rules, probes } = set;
  if (config.version !== 1) errors.push('config.version must be 1');
  if (!config.app?.start) errors.push('config.app.start is required');
  if (!config.app?.baseUrl) errors.push('config.app.baseUrl is required');
  const dup = (ids: string[], what: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`duplicate ${what} id: ${id}`);
      seen.add(id);
    }
  };
  dup(probes.map((p) => p.id), 'probe');
  dup(rules.map((r) => r.id), 'rule');
  dup(contract.requirements.map((r) => r.id), 'requirement');
  dup((contract.invariants ?? []).map((r) => r.id), 'invariant');
  dup((contract.claims ?? []).map((r) => r.id), 'claim');
  for (const r of rules) {
    if (!r.owner || !r.reason) errors.push(`rule ${r.id}: every rule needs an owner and a reason (no silent suppression)`);
    if (!Number.isInteger(r.version) || r.version < 1) errors.push(`rule ${r.id}: version must be a positive integer`);
    if (!r.probe) errors.push(`rule ${r.id}: probe glob is required`);
  }
  for (const req of contract.requirements) {
    if (!(ORACLE_STRENGTH as readonly string[]).includes(req.oracle?.kind))
      warnings.push(`requirement ${req.id}: oracle "${req.oracle?.kind}" is not a recognised oracle; it will be UNKNOWN`);
    if (!req.checks?.length) warnings.push(`requirement ${req.id}: no checks; it will be UNKNOWN`);
  }
  for (const c of contract.claims ?? []) if (!c.approved) warnings.push(`claim ${c.id} is not approved; matching differences stay unintended`);
  return { errors, warnings };
}

export function latestVersion(store: Store): number {
  const row = store.db.prepare('SELECT MAX(version) AS v FROM control_versions').get() as { v: number | null };
  return row.v ?? 0;
}

export function loadFrozen(store: Store, version?: number): { version: number; set: ControlSet } | undefined {
  const v = version ?? latestVersion(store);
  if (!v) return undefined;
  return { version: v, set: readJson<ControlSet>(store.path('control', `v${v}.json`)) };
}

/** Lists every way `next` is weaker than `prev`. */
export function findWeakening(prev: ControlSet, next: ControlSet): string[] {
  const w: string[] = [];
  const byId = <T extends { id: string }>(xs: T[] | undefined) => new Map((xs ?? []).map((x) => [x.id, x]));
  const prevReq = byId(prev.contract.requirements);
  const nextReq = byId(next.contract.requirements);
  for (const [id, r] of prevReq) {
    const n = nextReq.get(id);
    if (!n) {
      w.push(`requirement ${id} removed`);
      continue;
    }
    if (r.mandatory !== false && n.mandatory === false) w.push(`requirement ${id} made optional`);
    const nextChecks = new Set(n.checks.map((c) => stableStringify(c)));
    for (const c of r.checks) if (!nextChecks.has(stableStringify(c))) w.push(`requirement ${id}: check removed or changed ${stableStringify(c)}`);
    const rank = (k: string) => {
      const i = (ORACLE_STRENGTH as readonly string[]).indexOf(k);
      return i < 0 ? 99 : i;
    };
    if (rank(n.oracle.kind) > rank(r.oracle.kind)) w.push(`requirement ${id}: oracle weakened ${r.oracle.kind} -> ${n.oracle.kind}`);
  }
  const nextInv = byId(next.contract.invariants);
  for (const inv of prev.contract.invariants ?? []) {
    const n = nextInv.get(inv.id);
    if (!n) w.push(`invariant ${inv.id} removed`);
    else if (stableStringify(n) !== stableStringify(inv)) w.push(`invariant ${inv.id} changed`);
  }
  const prevRules = byId(prev.rules);
  for (const r of next.rules) {
    const p = prevRules.get(r.id);
    if (!p) w.push(`comparison rule ${r.id} added (${r.kind} on ${r.probe}): ${r.reason}`);
    else if (stableStringify(p) !== stableStringify(r)) w.push(`comparison rule ${r.id} changed`);
  }
  const nextProbes = new Set(next.probes.map((p) => p.id));
  for (const p of prev.probes) if (!nextProbes.has(p.id)) w.push(`probe ${p.id} removed`);
  const nextProtected = new Set(next.config.protectedPaths ?? []);
  for (const p of prev.config.protectedPaths ?? []) if (!nextProtected.has(p)) w.push(`protected path ${p} removed`);
  if ((next.config.browser?.visualThreshold ?? 0.001) > (prev.config.browser?.visualThreshold ?? 0.001))
    w.push('browser.visualThreshold raised');
  if (prev.config.tests && !next.config.tests) w.push('existing test run removed');
  else if (prev.config.tests && next.config.tests && prev.config.tests.command !== next.config.tests.command)
    w.push(`test command changed (${prev.config.tests.command} -> ${next.config.tests.command}); check it still runs every test it ran before`);
  // Fewer generated probes is weakening too: generation off, roles dropped, route parameters dropped.
  if (prev.config.inventory?.generate !== false && next.config.inventory?.generate === false) w.push('probe generation turned off');
  const nextRoles = new Set(next.config.inventory?.roles ?? []);
  for (const r of prev.config.inventory?.roles ?? []) if (!nextRoles.has(r)) w.push(`generated probes no longer run as role ${r}`);
  for (const route of Object.keys(prev.config.routeParams ?? {})) if (!next.config.routeParams?.[route]) w.push(`route parameters for ${route} removed`);
  if (prev.config.browser?.enabled !== false && next.config.browser?.enabled === false) w.push('browser capture turned off');
  if ((next.config.flakeReruns ?? 2) < (prev.config.flakeReruns ?? 2)) w.push('fewer flakiness re-runs');
  const nextFast = new Set((next.config.fastChecks ?? []).map((f) => f.name));
  for (const f of prev.config.fastChecks ?? []) if (!nextFast.has(f.name)) w.push(`fast check ${f.name} removed`);
  const prevLessons = byId(prev.lessons);
  for (const l of next.lessons) {
    const p = prevLessons.get(l.id);
    if (p && p.status !== 'retired' && l.status === 'retired') w.push(`lesson ${l.id} retired`);
    if (p?.check && stableStringify(p.check) !== stableStringify(l.check)) w.push(`lesson ${l.id} check changed`);
  }
  for (const l of prev.lessons) if (!next.lessons.some((x) => x.id === l.id)) w.push(`lesson ${l.id} removed`);
  return w;
}

export interface FreezeResult {
  version: number;
  changed: boolean;
  weakening: string[];
  warnings: string[];
  newClaims: string[];
}

function writeVersion(store: Store, set: ControlSet, by: string, note: string, weakening: string[]): number {
  const version = latestVersion(store) + 1;
  writeJson(store.path('control', `v${version}.json`), set);
  store.db
    .prepare('INSERT INTO control_versions (version, created, by, note, hash, weakening) VALUES (?, ?, ?, ?, ?, ?)')
    .run(version, new Date().toISOString(), by, note, hashJson(set), JSON.stringify(weakening));
  store.event('control.freeze', { version, by, note, weakening });
  return version;
}

/** Human command: freeze the repository's control files as a new version. */
export function freeze(store: Store, root: string, opts: { by: string; note?: string; approveWeakening?: boolean }): FreezeResult {
  const repo = readRepoControl(root);
  const { errors, warnings } = validateControl(repo);
  if (errors.length) throw new UserError(`Control files are invalid:\n  - ${errors.join('\n  - ')}`);
  const prev = loadFrozen(store);
  const next: ControlSet = { ...repo, lessons: prev?.set.lessons ?? [] };
  // Lesson probes are owned by the store, never by the repository copy.
  const lessonProbes = (prev?.set.probes ?? []).filter((p) => p.source === 'lesson');
  next.probes = [...next.probes.filter((p) => p.source !== 'lesson'), ...lessonProbes];
  if (prev && hashJson(prev.set) === hashJson(next)) return { version: prev.version, changed: false, weakening: [], warnings, newClaims: [] };
  const weakening = prev ? findWeakening(prev.set, next) : [];
  if (weakening.length && !opts.approveWeakening)
    throw new UserError(
      `This freeze weakens the checks, which only a human may approve:\n  - ${weakening.join('\n  - ')}\n` +
        'Re-run with --approve-weakening --by "<your name>" if this is intended.',
    );
  const prevClaims = new Set((prev?.set.contract.claims ?? []).map((c) => c.id));
  const newClaims = (next.contract.claims ?? []).filter((c) => c.approved && !prevClaims.has(c.id)).map((c) => `${c.id}: ${c.text}`);
  const version = writeVersion(store, next, opts.by, opts.note ?? '', weakening);
  return { version, changed: true, weakening, warnings, newClaims };
}

/** Tool-initiated growth: may only add. Throws if the change would weaken anything. */
export function growControl(store: Store, mutate: (set: ControlSet) => void, note: string): number {
  const prev = loadFrozen(store);
  if (!prev) throw new UserError('Nothing frozen yet. Run `proofloop freeze` first.');
  const next = structuredClone(prev.set);
  mutate(next);
  const weakening = findWeakening(prev.set, next);
  if (weakening.length) throw new Error(`Internal: tool-initiated change would weaken checks: ${weakening.join('; ')}`);
  return writeVersion(store, next, 'proofloop', note, []);
}

/** Human-initiated change made by a ProofLoop command (retire a lesson, approve a pattern). */
export function humanChangeControl(store: Store, by: string, note: string, mutate: (set: ControlSet) => void): number {
  const prev = loadFrozen(store);
  if (!prev) throw new UserError('Nothing frozen yet. Run `proofloop freeze` first.');
  const next = structuredClone(prev.set);
  mutate(next);
  return writeVersion(store, next, by, note, findWeakening(prev.set, next));
}

/** Frozen set for a run; freezes v1 automatically the very first time. */
export function controlForRun(store: Store, root: string): { version: number; set: ControlSet; repoDiffers: boolean; autoFrozen: boolean } {
  let frozen = loadFrozen(store);
  let autoFrozen = false;
  if (!frozen) {
    const r = freeze(store, root, { by: 'proofloop (first run, auto-freeze v1)', note: 'auto-frozen at first run' });
    frozen = loadFrozen(store, r.version)!;
    autoFrozen = true;
  }
  let repoDiffers = false;
  try {
    const repo = readRepoControl(root);
    const cmp = { ...repo, lessons: frozen.set.lessons, probes: [...repo.probes, ...frozen.set.probes.filter((p) => p.source === 'lesson')] };
    repoDiffers = hashJson(cmp) !== hashJson(frozen.set);
  } catch {
    repoDiffers = true;
  }
  return { ...frozen, repoDiffers, autoFrozen };
}

export function activeLessons(set: ControlSet): Lesson[] {
  return set.lessons.filter((l) => l.status !== 'retired');
}
