// Compares a head capture with a baseline and classes every material difference as
// intended, unintended, environment drift, flaky or unknown.
import type { ChangeClaim, ControlSet, Difference, EnvFingerprint, Json, Manifest, Observation } from './types.js';
import type { Store } from './store.js';
import { diffImages, diffJson, normalize, rulesFor, type RawDiff } from './diff.js';
import { pathMatches, select } from './jsonpath.js';
import { globMatch, stableStringify } from './util.js';

export interface CompareResult {
  differences: Difference[];
  preexisting: string[];
  envDrift: string[];
  notes: string[];
}

const DRIFT_KEYS: (keyof EnvFingerprint)[] = ['node', 'platform', 'arch', 'browser', 'timezone', 'locale', 'clock', 'fixturesHash'];

export function envDrift(a: EnvFingerprint, b: EnvFingerprint): string[] {
  return DRIFT_KEYS.filter((k) => a[k] !== undefined && b[k] !== undefined && a[k] !== b[k]).map((k) => `${k}: ${a[k]} -> ${b[k]}`);
}

export function matchClaim(claims: ChangeClaim[], probeId: string, d: RawDiff): ChangeClaim | undefined {
  return claims.find(
    (c) =>
      c.approved &&
      globMatch(c.probe, probeId) &&
      (!c.path || pathMatches(c.path, d.path) || pathMatches(d.path, c.path, false)) &&
      (!c.change || c.change === 'any' || c.change === d.change),
  );
}

function valueAt(v: Json, path: string): string {
  return stableStringify(select(v, path).map((x) => x.value));
}

export async function compare(
  store: Store,
  set: ControlSet,
  base: Manifest,
  head: Manifest,
  reruns: Map<string, Observation[]> = new Map(),
  noisyPaths: Record<string, string[]> = {},
): Promise<CompareResult> {
  const differences: Difference[] = [];
  const preexisting: string[] = [];
  const notes: string[] = [];
  const drift = envDrift(base.env, head.env);
  const claims = set.contract.claims ?? [];
  const threshold = set.config.browser?.visualThreshold ?? 0.001;
  const baseObs = new Map(base.observations.map((o) => [o.probeId, o]));
  const headObs = new Map(head.observations.map((o) => [o.probeId, o]));
  const probes = new Map(head.probes.map((p) => [p.id, p]));
  let n = 0;
  const push = (d: Omit<Difference, 'id'>) => differences.push({ id: `D${++n}`, ...d });

  for (const b of base.observations) {
    const h = headObs.get(b.probeId);
    const probe = probes.get(b.probeId) ?? base.probes.find((p) => p.id === b.probeId)!;
    const rules = rulesFor(set.rules, b.probeId);
    if (!h) {
      push({ probeId: b.probeId, path: '$', change: 'removed', class: 'unknown', note: 'probe did not run on head' });
      continue;
    }
    if (!b.ok && !h.ok) {
      preexisting.push(`${b.probeId}: probe already failed on baseline (${b.error})`);
      continue;
    }
    if (b.ok && !h.ok) {
      const infra = /browser not available|ECONNREFUSED|fetch failed/.test(h.error ?? '');
      push({
        probeId: b.probeId,
        path: '$',
        change: 'changed',
        before: 'probe ran',
        after: `probe failed: ${h.error}`,
        class: infra ? 'unknown' : drift.length ? 'environment-drift' : 'unintended',
        note: infra ? 'could not run the probe on head' : 'passed on baseline, fails on head',
      });
      continue;
    }
    const before = normalize(b.value, rules);
    const after = normalize(h.value, rules);
    const raw = b.ok ? diffJson(before, after) : [{ path: '$', change: 'changed' as const, before: `probe failed: ${b.error}`, after: 'probe ran' }];

    // Flakiness: values seen when the same probe was re-run on the same code, before any write.
    const again = reruns.get(b.probeId) ?? [];
    const rerunValues = again.filter((o) => o.ok).map((o) => normalize(o.value, rules));

    for (const d of raw) {
      const claim = matchClaim(claims, b.probeId, d);
      const base = { probeId: b.probeId, path: d.path, change: d.change, before: d.before, after: d.after, evidence: { baseline: Object.values(b.evidence)[0], head: Object.values(h.evidence)[0] } };
      if (claim) {
        push({ ...base, class: 'intended', claimId: claim.id, note: claim.text });
        continue;
      }
      if (drift.length) {
        push({ ...base, class: 'environment-drift', note: drift.join('; ') });
        continue;
      }
      const noisy = (noisyPaths[b.probeId] ?? []).some((p) => pathMatches(p, d.path));
      const headVal = valueAt(after, d.path.replace(/\[\d+\]$/, ''));
      const unstable = rerunValues.some((rv) => valueAt(rv, d.path.replace(/\[\d+\]$/, '')) !== headVal);
      if (unstable || noisy) {
        push({ ...base, class: 'flaky', note: unstable ? `value changed between ${rerunValues.length} re-runs on the same code` : 'field varied between two unchanged runs (noise report)' });
        continue;
      }
      push({ ...base, class: 'unintended', note: probe.mutates ? 'write probe; not re-run' : rerunValues.length ? `stable over ${rerunValues.length} re-runs` : undefined });
    }

    // Visual difference, judged separately from the state diff.
    if (b.evidence.screenshot && h.evidence.screenshot) {
      const vis = await diffImages(store.readEvidence(b.evidence.screenshot), store.readEvidence(h.evidence.screenshot), rules);
      if (vis.changedRatio > threshold) {
        const d: RawDiff = { path: '$.screenshot', change: 'changed', before: 'baseline screenshot', after: vis.sizeChanged ? 'size changed' : `${(vis.changedRatio * 100).toFixed(2)}% of pixels differ` };
        const evidence: Record<string, string> = { baseline: b.evidence.screenshot, head: h.evidence.screenshot };
        if (vis.diffPng) evidence.diff = store.putEvidence(vis.diffPng, 'png');
        const claim = matchClaim(claims, b.probeId, d);
        let cls: Difference['class'] = claim ? 'intended' : drift.length ? 'environment-drift' : 'unintended';
        let note = claim?.text;
        if (cls === 'unintended') {
          for (const o of again) {
            if (!o.evidence.screenshot || o.evidence.screenshot === h.evidence.screenshot) continue;
            const second = await diffImages(store.readEvidence(h.evidence.screenshot), store.readEvidence(o.evidence.screenshot), rules);
            if (second.changedRatio > threshold) {
              cls = 'flaky';
              note = 'screenshot differs between re-runs on the same code';
              break;
            }
          }
        }
        push({ probeId: b.probeId, path: d.path, change: d.change, before: d.before, after: d.after, class: cls, claimId: claim?.id, note, evidence });
      }
    }
  }

  for (const h of head.observations) {
    if (baseObs.has(h.probeId)) continue;
    if (probes.get(h.probeId)?.source !== 'generated') {
      notes.push(`probe ${h.probeId} was added after the baseline; it is judged only by contract checks`);
      continue;
    }
    push({ probeId: h.probeId, path: '$', change: 'added', after: h.ok ? 'new probe, no baseline' : `new probe failed: ${h.error}`, class: 'unknown', note: 'new route or probe: no baseline to compare; needs a contract check' });
  }

  // Existing tests. A run that timed out or parsed no results is no evidence either way: its
  // side of every test comparison is unknown, never an unintended change.
  const noEvidence = (t: typeof base.tests) => !!t && (!!t.error || t.results.length === 0);
  const blind = noEvidence(base.tests) ? 'baseline' : noEvidence(head.tests) ? 'head' : undefined;
  if (blind) {
    const t = blind === 'baseline' ? base.tests! : head.tests!;
    push({ probeId: 'tests', path: '$', change: 'changed', before: blind === 'baseline' ? `${t.results.length} results` : `${base.tests?.results.length ?? 0} results`, after: blind === 'head' ? `${t.results.length} results` : `${head.tests?.results.length ?? 0} results`, class: 'unknown', note: `existing tests not compared: the ${blind} test run ${t.error ?? 'produced no parsed results'} (exit ${t.exitCode}); re-run to judge them` });
  } else if (base.tests || head.tests) {
    const bt = new Map((base.tests?.results ?? []).map((r) => [r.name, r.ok]));
    const ht = new Map((head.tests?.results ?? []).map((r) => [r.name, r.ok]));
    for (const [name, ok] of bt) {
      const hk = ht.get(name);
      if (!ok && hk === false) preexisting.push(`test "${name}" already failed on baseline`);
      else if (ok && hk === false)
        push({ probeId: 'tests', path: `$[${JSON.stringify(name)}]`, change: 'changed', before: 'pass', after: 'fail', class: drift.length ? 'environment-drift' : 'unintended', note: 'existing test passed on baseline, fails on head' });
      else if (hk === undefined) {
        const d: RawDiff = { path: `$[${JSON.stringify(name)}]`, change: 'removed', before: ok ? 'pass' : 'fail' };
        const claim = matchClaim(claims, 'tests', d);
        push({ ...d, probeId: 'tests', class: claim ? 'intended' : 'unintended', claimId: claim?.id, note: claim?.text ?? 'test disappeared on head (deleted, renamed or skipped)' });
      }
    }
    for (const [name, ok] of ht) {
      if (bt.has(name)) continue;
      if (!ok) push({ probeId: 'tests', path: `$[${JSON.stringify(name)}]`, change: 'added', after: 'fail', class: 'unintended', note: 'new test fails on head' });
      else notes.push(`new test on head passes: ${name}`);
    }
    if (head.tests && head.tests.exitCode !== 0 && !head.tests.results.some((r) => !r.ok) && base.tests?.exitCode === 0)
      push({ probeId: 'tests', path: '$', change: 'changed', before: `exit ${base.tests.exitCode}`, after: `exit ${head.tests.exitCode}`, class: 'unintended', note: 'test command failed without a parsed failing test' });
  }
  return { differences, preexisting, envDrift: drift, notes };
}
