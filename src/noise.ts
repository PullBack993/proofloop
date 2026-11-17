// Noise report: two runs on unchanged code. Every difference here would be a false alarm, so
// each one gets a proposed typed rule that a human must approve. Nothing is suppressed silently.
import type { ControlSet, Manifest, Rule } from './types.js';
import type { Store } from './store.js';
import { diffJson, normalize, rulesFor } from './diff.js';
import { envDrift } from './compare.js';
import { fmtJson, writeJson } from './util.js';

export interface NoiseReport {
  a: string;
  b: string;
  commit: string;
  falseAlarms: number;
  limit?: number;
  withinLimit: boolean;
  envDrift: string[];
  byProbe: Record<string, { path: string; before: string; after: string }[]>;
  proposedRules: Rule[];
}

function proposeRule(probeId: string, path: string, before: unknown, after: unknown): Rule {
  const generalPath = path.replace(/\[\d+\]/g, '[*]');
  const id = `noise.${probeId}.${generalPath.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '')}`;
  const isoish = /\d{4}-\d{2}-\d{2}T/;
  const uuidish = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const base = { id, version: 1, owner: '<human to fill>', reason: `<why ${generalPath} may change between unchanged runs>`, probe: probeId };
  if (typeof before === 'string' && typeof after === 'string') {
    if (isoish.test(before) && isoish.test(after)) return { ...base, kind: 'mask', path: generalPath, pattern: '\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z?', replacement: '<timestamp>' };
    if (uuidish.test(before) && uuidish.test(after)) return { ...base, kind: 'mask', path: generalPath, pattern: uuidish.source, replacement: '<uuid>' };
  }
  if (typeof before === 'number' && typeof after === 'number') return { ...base, kind: 'round', path: generalPath, digits: 2 };
  return { ...base, kind: 'ignore-path', path: generalPath };
}

export function noiseReport(store: Store, set: ControlSet, a: Manifest, b: Manifest): NoiseReport {
  const byProbe: NoiseReport['byProbe'] = {};
  const proposed = new Map<string, Rule>();
  let falseAlarms = 0;
  const bObs = new Map(b.observations.map((o) => [o.probeId, o]));
  for (const oa of a.observations) {
    const ob = bObs.get(oa.probeId);
    if (!ob || !oa.ok || !ob.ok) {
      if (oa.ok !== ob?.ok) {
        falseAlarms++;
        (byProbe[oa.probeId] ??= []).push({ path: '$', before: oa.ok ? 'ran' : `failed: ${oa.error}`, after: ob?.ok ? 'ran' : `failed: ${ob?.error}` });
      }
      continue;
    }
    const rules = rulesFor(set.rules, oa.probeId);
    const diffs = diffJson(normalize(oa.value, rules), normalize(ob.value, rules));
    for (const d of diffs) {
      falseAlarms++;
      (byProbe[oa.probeId] ??= []).push({ path: d.path, before: fmtJson(d.before), after: fmtJson(d.after) });
      const r = proposeRule(oa.probeId, d.path, d.before, d.after);
      proposed.set(r.id, r);
    }
  }
  // Verify flags a test that appears, disappears or flips, so noise must count all three.
  const at = new Map((a.tests?.results ?? []).map((t) => [t.name, t.ok]));
  const bt = new Map((b.tests?.results ?? []).map((t) => [t.name, t.ok]));
  for (const name of new Set([...at.keys(), ...bt.keys()]))
    if (at.get(name) !== bt.get(name)) {
      falseAlarms++;
      (byProbe.tests ??= []).push({ path: name, before: String(at.get(name) ?? '(absent)'), after: String(bt.get(name) ?? '(absent)') });
    }
  const limit = set.config.limits?.falseAlarmsPerCleanRun;
  // The noise profile marks varying fields as flaky in later verify runs; it never ignores them.
  const profile: Record<string, string[]> = {};
  for (const [probe, ds] of Object.entries(byProbe)) profile[probe] = [...new Set(ds.map((d) => d.path.replace(/\[\d+\]/g, '[*]')))];
  writeJson(store.path('noise.json'), profile);
  const report: NoiseReport = {
    a: a.id,
    b: b.id,
    commit: a.commit,
    falseAlarms,
    limit,
    withinLimit: limit === undefined ? falseAlarms === 0 : falseAlarms <= limit,
    envDrift: envDrift(a.env, b.env),
    byProbe,
    proposedRules: [...proposed.values()],
  };
  writeJson(store.path('noise-report.json'), report);
  return report;
}

export function renderNoise(r: NoiseReport): string {
  const L = [`# Noise report (${r.a} vs ${r.b}, commit ${r.commit.slice(0, 10)})`, ''];
  L.push(`False alarms on unchanged code: **${r.falseAlarms}**${r.limit !== undefined ? ` (limit ${r.limit})` : ''} — ${r.withinLimit ? 'within limit' : 'OVER LIMIT'}`);
  if (r.envDrift.length) L.push(`Environment drift: ${r.envDrift.join('; ')}`);
  for (const [p, ds] of Object.entries(r.byProbe)) {
    L.push('', `## ${p}`);
    for (const d of ds.slice(0, 30)) L.push(`- \`${d.path}\`: ${d.before} → ${d.after}`);
    if (ds.length > 30) L.push(`- … ${ds.length - 30} more`);
  }
  if (r.proposedRules.length) {
    L.push('', '## Proposed rules (NOT applied)', '', 'Copy a rule into .proofloop/rules.json only after checking that the field is not a race or a data leak, fill in owner and reason, then run `proofloop freeze --approve-weakening`.', '', '```json', JSON.stringify(r.proposedRules, null, 2), '```');
  }
  return L.join('\n') + '\n';
}
