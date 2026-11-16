// Evaluates requirements, invariants and lesson checks against observed evidence.
// The run is ACCEPTED only when every mandatory requirement is VERIFIED on the final commit.
import type { Check, CheckOutcome, ControlSet, Difference, Json, Manifest, Op, ReqStatus, RequirementResult } from './types.js';
import { ORACLE_STRENGTH } from './types.js';
import { select } from './jsonpath.js';
import { activeLessons } from './control.js';
import { fmtJson, globMatch, stableStringify } from './util.js';

const REJECTED_ORACLES = /model|llm|ai|gpt|claude|critic|self/i;

export function applyOp(op: Op, actual: Json[], expected: Json | undefined): { ok: boolean; detail: string } {
  const show = actual.length === 1 ? fmtJson(actual[0]) : `${actual.length} values`;
  const all = (pred: (v: Json) => boolean) => actual.length > 0 && actual.every(pred);
  const num = (v: Json) => (typeof v === 'number' ? v : Number.NaN);
  switch (op) {
    case 'exists':
      return { ok: actual.length > 0 && actual.every((v) => v !== null), detail: actual.length ? `found ${show}` : 'path not found' };
    case 'absent':
      return { ok: actual.length === 0, detail: actual.length ? `present: ${show}` : 'absent' };
    case 'eq':
      return { ok: all((v) => stableStringify(v) === stableStringify(expected ?? null)), detail: `${show} (expected ${fmtJson(expected)})` };
    case 'ne':
      return { ok: all((v) => stableStringify(v) !== stableStringify(expected ?? null)), detail: `${show} (must not be ${fmtJson(expected)})` };
    case 'gt':
      return { ok: all((v) => num(v) > Number(expected)), detail: `${show} > ${expected}` };
    case 'gte':
      return { ok: all((v) => num(v) >= Number(expected)), detail: `${show} >= ${expected}` };
    case 'lt':
      return { ok: all((v) => num(v) < Number(expected)), detail: `${show} < ${expected}` };
    case 'lte':
      return { ok: all((v) => num(v) <= Number(expected)), detail: `${show} <= ${expected}` };
    case 'matches':
      return { ok: all((v) => typeof v === 'string' && new RegExp(String(expected)).test(v)), detail: `${show} ~ /${expected}/` };
    case 'includes':
      return {
        ok: actual.some((v) => (Array.isArray(v) ? v.some((x) => stableStringify(x) === stableStringify(expected ?? null)) : typeof v === 'string' && v.includes(String(expected)))),
        detail: `${show} includes ${fmtJson(expected)}`,
      };
    case 'unique': {
      const vals = actual.map((v) => stableStringify(v));
      const dup = vals.find((v, i) => vals.indexOf(v) !== i);
      return { ok: dup === undefined, detail: dup ? `duplicate value ${dup}` : `${vals.length} unique values` };
    }
    case 'count':
      return { ok: actual.length === Number(expected), detail: `${actual.length} value(s) (expected ${expected})` };
    case 'nonEmpty':
      return { ok: all((v) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== '')), detail: show };
  }
}

function describe(c: Check): string {
  switch (c.type) {
    case 'unchanged':
      return `unchanged vs baseline: ${c.probe}`;
    case 'assert':
      return `${c.probe} ${c.path} ${c.op}${c.value !== undefined ? ' ' + fmtJson(c.value) : ''}`;
    case 'test':
      return `test passes: ${c.name}`;
    case 'probe-ok':
      return `probe runs with a 2xx/3xx status: ${c.probe}`;
  }
}

export function evaluateCheck(c: Check, head: Manifest, base: Manifest | undefined, diffs: Difference[]): CheckOutcome {
  const check = describe(c);
  if (head.status === 'blocked') return { check, status: 'BLOCKED', detail: `head capture blocked: ${head.blockedReason}` };
  if (c.type === 'test') {
    const r = head.tests?.results.find((t) => t.name === c.name || t.name.endsWith(` > ${c.name}`));
    if (!r) return { check, status: 'UNKNOWN', detail: head.tests ? 'test not found in head run' : 'no test command configured' };
    const baseRes = base?.tests?.results.find((t) => t.name === r.name);
    return { check, status: r.ok ? 'VERIFIED' : 'FAILED', detail: r.ok ? 'passes on head' : 'fails on head', preexisting: !r.ok && baseRes?.ok === false };
  }
  const obsMatching = head.observations.filter((o) => globMatch(c.probe, o.probeId));
  if (!obsMatching.length) return { check, status: 'UNKNOWN', detail: 'no probe matched; behaviour not observed' };
  if (c.type === 'unchanged') {
    if (!base) return { check, status: 'UNKNOWN', detail: 'no baseline' };
    const mine = diffs.filter((d) => globMatch(c.probe, d.probeId));
    const bad = mine.filter((d) => d.class === 'unintended');
    if (bad.length) return { check, status: 'FAILED', detail: `${bad.length} unintended difference(s): ${bad.map((d) => d.id).join(', ')}` };
    const unsure = mine.filter((d) => d.class !== 'intended');
    if (unsure.length) return { check, status: 'UNKNOWN', detail: `${unsure.map((d) => `${d.id} ${d.class}`).join(', ')}` };
    const failedObs = obsMatching.filter((o) => !o.ok);
    if (failedObs.length) return { check, status: 'FAILED', detail: `probe error: ${failedObs[0].error}`, preexisting: true };
    return { check, status: 'VERIFIED', detail: `matches baseline${mine.length ? ` apart from ${mine.length} claimed change(s)` : ''}` };
  }
  const failedObs = obsMatching.filter((o) => !o.ok);
  if (failedObs.length) return { check, status: 'BLOCKED', detail: `probe could not run: ${failedObs[0].error}` };
  if (c.type === 'probe-ok') {
    const bad = obsMatching.find((o) => {
      const s = (o.value as { status?: number } | null)?.status;
      return typeof s === 'number' && s >= 400;
    });
    return bad ? { check, status: 'FAILED', detail: `${bad.probeId} returned ${(bad.value as { status: number }).status}` } : { check, status: 'VERIFIED', detail: 'ran' };
  }
  const outcomes = obsMatching.map((o) => ({ o, r: applyOp(c.op, select(o.value, c.path).map((x) => x.value), c.value) }));
  const failed = outcomes.find((x) => !x.r.ok);
  if (failed) {
    const b = base?.observations.find((o) => o.probeId === failed.o.probeId);
    const preexisting = !!b?.ok && !applyOp(c.op, select(b.value, c.path).map((x) => x.value), c.value).ok;
    return { check, status: 'FAILED', detail: `${failed.o.probeId}: ${failed.r.detail}`, preexisting };
  }
  return { check, status: 'VERIFIED', detail: outcomes.map((x) => `${x.o.probeId}: ${x.r.detail}`).join('; ') };
}

function combine(outcomes: CheckOutcome[]): ReqStatus {
  if (!outcomes.length) return 'UNKNOWN';
  if (outcomes.some((o) => o.status === 'FAILED')) return 'FAILED';
  if (outcomes.some((o) => o.status === 'BLOCKED')) return 'BLOCKED';
  if (outcomes.some((o) => o.status === 'UNKNOWN')) return 'UNKNOWN';
  return 'VERIFIED';
}

export function evaluateContract(set: ControlSet, head: Manifest, base: Manifest | undefined, diffs: Difference[]): RequirementResult[] {
  const results: RequirementResult[] = [];

  // Implicit requirement: every material difference is claimed (principle 6).
  const material = diffs.filter((d) => d.class !== 'intended');
  const implicit: CheckOutcome[] = [];
  if (head.status === 'blocked') implicit.push({ check: 'capture', status: 'BLOCKED', detail: head.blockedReason ?? 'blocked' });
  else if (!base) implicit.push({ check: 'baseline', status: 'UNKNOWN', detail: 'no baseline snapshot' });
  else {
    const byClass = (cls: Difference['class']) => material.filter((d) => d.class === cls);
    const un = byClass('unintended');
    implicit.push({ check: 'no unclaimed behaviour change', status: un.length ? 'FAILED' : 'VERIFIED', detail: un.length ? `${un.length} unintended: ${un.map((d) => d.id).join(', ')}` : 'every observed difference is claimed' });
    for (const cls of ['environment-drift', 'flaky', 'unknown'] as const) {
      const xs = byClass(cls);
      if (xs.length) implicit.push({ check: `${cls} differences`, status: 'UNKNOWN', detail: `${xs.length}: ${xs.map((d) => d.id).join(', ')}` });
    }
  }
  results.push({ id: 'BASELINE', text: 'No behaviour change that nobody asked for', mandatory: true, oracle: 'prior-behaviour', status: combine(implicit), outcomes: implicit });

  for (const req of set.contract.requirements) {
    const kind = req.oracle?.kind ?? '';
    const known = (ORACLE_STRENGTH as readonly string[]).includes(kind);
    let outcomes: CheckOutcome[];
    if (!known)
      outcomes = [{ check: 'oracle', status: 'UNKNOWN', detail: REJECTED_ORACLES.test(kind) ? `"${kind}": a model's guess or a critic's opinion never passes anything` : `"${kind}" is not a trusted oracle` }];
    else outcomes = req.checks.map((c) => evaluateCheck(c, head, base, diffs));
    results.push({ id: req.id, text: req.text, mandatory: req.mandatory !== false, oracle: kind, status: combine(outcomes), outcomes });
  }

  for (const inv of set.contract.invariants ?? []) {
    const o = evaluateCheck({ type: 'assert', probe: inv.probe, path: inv.path, op: inv.op, value: inv.value }, head, base, diffs);
    results.push({ id: inv.id, text: inv.text, mandatory: true, oracle: inv.oracle?.kind ?? 'domain-invariant', status: o.status, outcomes: [o] });
  }

  for (const l of activeLessons(set)) {
    if (!l.check) continue;
    const o = evaluateCheck({ type: 'assert', probe: l.check.probe, path: l.check.path, op: l.check.op, value: l.check.value }, head, base, diffs);
    results.push({ id: l.id, text: `Lesson: ${l.what}`, mandatory: true, oracle: 'stated-requirement', status: o.status, outcomes: [o] });
  }
  return results;
}

export function decide(results: RequirementResult[]): 'ACCEPTED' | 'REJECTED' {
  return results.filter((r) => r.mandatory).every((r) => r.status === 'VERIFIED') ? 'ACCEPTED' : 'REJECTED';
}
