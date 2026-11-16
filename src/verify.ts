// Diff and verify: re-runs the baseline's probes on the change, classes every difference,
// evaluates the frozen contract and decides. Never takes the agent's word for anything.
import type { ControlSet, Difference, Manifest, Probe, RequirementResult } from './types.js';
import type { Store } from './store.js';
import { controlForRun, activeLessons } from './control.js';
import { Capture, latestBaseline, loadManifest } from './snapshot.js';
import { compare } from './compare.js';
import { decide, evaluateContract } from './contract.js';
import { newId, readJsonIf, UserError, writeJson } from './util.js';
import { renderMarkdown } from './report.js';
import { expandPath } from './probes.js';
import { diffJson, normalize, rulesFor } from './diff.js';

export interface VerifyReport {
  runId: string;
  decision: 'ACCEPTED' | 'REJECTED';
  createdAt: string;
  durationMs: number;
  controlVersion: number;
  controlNotes: string[];
  baseline: { id: string; commit: string; label: string; createdAt: string };
  head: { id: string; commit: string; dirty: boolean; worktreeDiffHash?: string; status: string; blockedReason?: string };
  requirements: RequirementResult[];
  differences: Difference[];
  preexisting: string[];
  envDrift: string[];
  notes: string[];
  coverage: {
    routes: number;
    probedRoutes: number;
    probes: { id: string; kind: string; source: string; ok: boolean; coverageLimit?: string }[];
    unprobed: { route: string; reason: string }[];
  };
  notVerified: string[];
  reviewItems: string[];
  reproductions: Record<string, string[]>;
  evidenceDir: string;
  baseUrl: string;
}

export function noiseProfile(store: Store): Record<string, string[]> {
  return readJsonIf<Record<string, string[]>>(store.path('noise.json'), {});
}

function reproduction(d: Difference, probe: Probe | undefined, set: ControlSet, base: Manifest, head: Manifest): string[] {
  const out: string[] = [];
  const headRef = head.dirty ? `working tree on ${head.commit.slice(0, 10)}` : head.commit.slice(0, 10);
  if (d.probeId === 'tests' && set.config.tests) {
    out.push(`(cd ${set.config.app.cwd ?? '.'} && ${set.config.tests.command})  # test ${d.path}`);
  } else if (probe?.kind === 'api') {
    const body = probe.body !== undefined && probe.body !== null ? ` -H 'content-type: application/json' -d '${JSON.stringify(probe.body)}'` : '';
    const role = probe.role ?? set.config.defaultRole;
    out.push(`curl -s -X ${probe.method.toUpperCase()} '${set.config.app.baseUrl.replace(/\/$/, '')}${expandPath(probe.path, set.config)}'${role ? ` # with headers of role "${role}"` : ''}${body}`);
  } else if (probe?.kind === 'browser') {
    const steps = (probe.steps ?? []).map((s) => JSON.stringify(s)).join(' → ');
    out.push(`open ${set.config.app.baseUrl.replace(/\/$/, '')}${probe.path}${steps ? ` then ${steps}` : ''}`);
  } else if (probe?.kind === 'db') {
    out.push(`sqlite3 ${probe.sqlite} "${probe.query}"`);
  }
  if (d.probeId !== 'tests') {
    out.push(`proofloop probe run ${d.probeId} --ref ${base.commit.slice(0, 10)}   # baseline`);
    out.push(`proofloop probe run ${d.probeId}${head.dirty ? '' : ` --ref ${head.commit.slice(0, 10)}`}   # head (${headRef})`);
  }
  const show = (v: unknown) => (v === undefined ? '(absent)' : JSON.stringify(v));
  out.push(`expected (baseline) at ${d.path}: ${show(d.before)}`);
  out.push(`observed (head) at ${d.path}: ${show(d.after)}`);
  return out;
}

export async function verify(
  store: Store,
  root: string,
  opts: { baseline?: string; ref?: string; log?: (m: string) => void; label?: string },
): Promise<VerifyReport> {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const control = controlForRun(store, root);
  const controlNotes: string[] = [];
  if (control.autoFrozen) controlNotes.push('Control files were frozen automatically as v1 on this first run.');
  if (control.repoDiffers)
    controlNotes.push(`The control files in ${root}/.proofloop differ from frozen v${control.version}. Repository edits are ignored until a human runs \`proofloop freeze\`.`);
  const base = opts.baseline ? loadManifest(store, opts.baseline) : latestBaseline(store);
  if (!base) throw new UserError('No baseline snapshot. Record one first: `proofloop snapshot --ref <commit-before-the-change>`.');
  if (base.status === 'blocked') throw new UserError(`Baseline ${base.id} is blocked (${base.blockedReason}); record a new one.`);
  if (base.controlVersion !== control.version) controlNotes.push(`Baseline was recorded under control v${base.controlVersion}; verifying under v${control.version}.`);

  const runId = newId('run');
  store.startRun(runId, 'verify', '', opts.label);
  log(`baseline ${base.id} at ${base.commit.slice(0, 10)}`);
  const probes = [...base.probes, ...control.set.probes.filter((p) => !base.probes.some((b) => b.id === p.id))];
  const cap = await Capture.open(store, root, control, { ref: opts.ref, label: `head for ${runId}`, probes, log });
  const baseObs = new Map(base.observations.map((o) => [o.probeId, o]));
  await cap.observeAll((p, o) => {
    const b = baseObs.get(p.id);
    if (!b) return false;
    if (b.ok !== o.ok) return true;
    const rules = rulesFor(control.set.rules, p.id);
    return diffJson(normalize(b.value, rules), normalize(o.value, rules)).length > 0 || (!!b.evidence.screenshot && b.evidence.screenshot !== o.evidence.screenshot);
  });
  const head = await cap.finish();
  log('comparing with baseline');
  const cmp = cap.blocked
    ? { differences: [], preexisting: [], envDrift: [], notes: [] }
    : await compare(store, control.set, base, head, cap.reruns, noiseProfile(store));
  store.db.prepare('UPDATE runs SET commit_sha = ? WHERE id = ?').run(head.commit, runId);

  const requirements = evaluateContract(control.set, head, base, cmp.differences);
  const decision = decide(requirements);

  const inv = head.inventory;
  const notVerified: string[] = [];
  for (const u of inv?.unprobed ?? []) notVerified.push(`${u.route.method} ${u.route.path} — not probed: ${u.reason}`);
  for (const c of control.set.config.connections ?? [])
    if (c.level === 'mock' || c.level === 'none') notVerified.push(`connection "${c.name}" — not verified live (checked at level: ${c.level})${c.note ? `; ${c.note}` : ''}`);
  for (const r of requirements) if (r.status === 'UNKNOWN') notVerified.push(`requirement ${r.id} — UNKNOWN: ${r.outcomes.map((o) => o.detail).join('; ')}`);
  for (const u of control.set.contract.unknowns ?? []) notVerified.push(`declared unknown — ${u}`);
  for (const o of head.observations.filter((o) => !o.ok)) notVerified.push(`probe ${o.probeId} — could not run: ${o.error}`);
  if (!control.set.config.tests) notVerified.push('existing tests — no test command configured');
  const reviewItems = activeLessons(control.set)
    .filter((l) => !l.check)
    .map((l) => `${l.id}: ${l.what} (builder rule: ${l.builderRule})`);

  const probeById = new Map(head.probes.map((p) => [p.id, p]));
  const reproductions: Record<string, string[]> = {};
  for (const d of cmp.differences) if (d.class !== 'intended') reproductions[d.id] = reproduction(d, probeById.get(d.probeId), control.set, base, head);

  const report: VerifyReport = {
    runId,
    decision,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    controlVersion: control.version,
    controlNotes,
    baseline: { id: base.id, commit: base.commit, label: base.label, createdAt: base.createdAt },
    head: { id: head.id, commit: head.commit, dirty: head.dirty, worktreeDiffHash: head.worktreeDiffHash, status: head.status, blockedReason: head.blockedReason },
    requirements,
    differences: cmp.differences,
    preexisting: cmp.preexisting,
    envDrift: cmp.envDrift,
    notes: cmp.notes,
    coverage: {
      routes: inv?.routes.length ?? 0,
      probedRoutes: inv?.probed.length ?? 0,
      probes: head.probes.map((p) => ({
        id: p.id,
        kind: p.kind,
        source: p.source ?? 'hand',
        ok: head.observations.find((o) => o.probeId === p.id)?.ok ?? false,
        coverageLimit: p.coverageLimit,
      })),
      unprobed: (inv?.unprobed ?? []).map((u) => ({ route: `${u.route.method} ${u.route.path}`, reason: u.reason })),
    },
    notVerified,
    reviewItems,
    reproductions,
    evidenceDir: store.path('evidence'),
    baseUrl: control.set.config.app.baseUrl,
  };
  writeJson(store.path('runs', runId, 'report.json'), report);
  const md = renderMarkdown(report);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(store.path('runs', runId, 'report.md'), md);
  store.finishRun(runId, decision, {
    decision,
    unintended: cmp.differences.filter((d) => d.class === 'unintended').length,
    flaky: cmp.differences.filter((d) => d.class === 'flaky').length,
    statuses: Object.fromEntries(requirements.map((r) => [r.id, r.status])),
    baseline: base.id,
    head: head.id,
  });
  return report;
}
