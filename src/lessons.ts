// Learning from corrections. Every human correction becomes a lesson; a lesson with an
// executable check runs on every later change. The tool adds checks on its own; only a human
// may weaken or retire one, and general patterns stay proposals until a human approves them.
import type { ControlSet, Json, Lesson, MissReason, Op, Rule } from './types.js';
import type { Store } from './store.js';
import { activeLessons, growControl, humanChangeControl, loadFrozen } from './control.js';
import { UserError, newId, readJson } from './util.js';
import type { VerifyReport } from './verify.js';
import { existsSync } from 'node:fs';
import { commitsAfter } from './git.js';

function nextLessonId(set: ControlSet): string {
  const max = set.lessons.reduce((m, l) => Math.max(m, Number(l.id.replace(/\D/g, '')) || 0), 0);
  return `L${max + 1}`;
}

export function loadReport(store: Store, runId: string): VerifyReport {
  const f = store.path('runs', runId, 'report.json');
  if (!existsSync(f)) throw new UserError(`No verify run ${runId}`);
  return readJson<VerifyReport>(f);
}

export interface CorrectOptions {
  runId?: string;
  what: string;
  where?: string;
  missReason?: MissReason;
  foundBy?: Lesson['foundBy'];
  probe?: string;
  path?: string;
  op?: Op;
  value?: Json;
  rule?: string;
  pattern?: string;
}

/** Records a lesson. With probe+path+op it adds a permanent check (growth only, no human needed). */
export function recordLesson(store: Store, o: CorrectOptions): Lesson {
  const frozen = loadFrozen(store);
  if (!frozen) throw new UserError('Nothing frozen yet. Run `proofloop freeze` first.');
  if (o.runId) loadReport(store, o.runId);
  const hasCheck = !!(o.probe && o.path && o.op);
  if (hasCheck && !frozen.set.probes.some((p) => p.id === o.probe) && !/[*?]/.test(o.probe!)) {
    // Generated probes are not frozen; accept any id that a recent snapshot ran.
    const known = store.runs('snapshot').slice(0, 5).some((r) => {
      try {
        return readJson<{ probes: { id: string }[] }>(store.path('snapshots', `${r.id}.json`)).probes.some((p) => p.id === o.probe);
      } catch {
        return false;
      }
    });
    if (!known) throw new UserError(`Unknown probe ${o.probe}. Add a probe for this behaviour first (missing probe = miss reason "no-probe").`);
  }
  let lesson!: Lesson;
  growControl(
    store,
    (set) => {
      lesson = {
        id: nextLessonId(set),
        version: 1,
        createdAt: new Date().toISOString(),
        what: o.what,
        where: o.where,
        foundBy: o.foundBy ?? 'human-told',
        missReason: o.missReason ?? (hasCheck ? 'no-oracle' : 'unknown'),
        runId: o.runId,
        check: hasCheck ? { text: o.what, probe: o.probe!, path: o.path!, op: o.op!, value: o.value, oracle: { kind: 'stated-requirement', source: `human correction${o.runId ? ` on ${o.runId}` : ''}` } } : undefined,
        builderRule: o.rule ?? `Do not repeat: ${o.what}${o.where ? ` (in ${o.where})` : ''}.`,
        pattern: o.pattern ? { text: o.pattern, status: 'proposed' } : undefined,
        status: hasCheck ? 'active' : 'needs-check',
      };
      set.lessons.push(lesson);
    },
    `lesson added: ${o.what}`,
  );
  store.event('lesson.add', lesson, o.runId);
  return lesson;
}

/** Gives a lesson recorded without a check (e.g. from a prompt) its executable check. */
export function attachCheck(store: Store, lessonId: string, c: { probe: string; path: string; op: Op; value?: Json }): Lesson {
  let lesson!: Lesson;
  growControl(
    store,
    (set) => {
      const l = set.lessons.find((x) => x.id === lessonId);
      if (!l) throw new UserError(`No lesson ${lessonId}`);
      if (l.check) throw new UserError(`Lesson ${lessonId} already has a check; changing it needs a new lesson`);
      l.check = { text: l.what, ...c, oracle: { kind: 'stated-requirement', source: `human correction (${l.id})` } };
      l.status = 'active';
      l.version++;
      lesson = l;
    },
    `check added to lesson ${lessonId}`,
  );
  return lesson;
}

/** A finding the human rejects is logged as a proposed comparison rule; it changes nothing yet. */
export function proposeFalseAlarmRule(store: Store, runId: string, findingId: string, reason: string, by: string): { proposalId: string; rule: Rule } {
  const report = loadReport(store, runId);
  const d = report.differences.find((x) => x.id === findingId);
  if (!d) throw new UserError(`No finding ${findingId} in ${runId}`);
  const rule: Rule = {
    id: `fa.${d.probeId}.${d.path.replace(/\[\d+\]/g, '[*]').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '')}`,
    version: 1,
    owner: by,
    reason,
    probe: d.probeId,
    kind: 'ignore-path',
    path: d.path.replace(/\[\d+\]/g, '[*]'),
  };
  const proposalId = newId('prop');
  store.db
    .prepare('INSERT INTO proposals (id, created, kind, status, data) VALUES (?, ?, ?, ?, ?)')
    .run(proposalId, new Date().toISOString(), 'rule', 'proposed', JSON.stringify({ rule, runId, findingId, reason }));
  store.event('false-alarm', { findingId, reason, proposalId }, runId);
  return { proposalId, rule };
}

export function listProposals(store: Store): { id: string; created: string; kind: string; status: string; data: unknown }[] {
  return (store.db.prepare('SELECT * FROM proposals ORDER BY created DESC').all() as { id: string; created: string; kind: string; status: string; data: string }[]).map((r) => ({
    ...r,
    data: JSON.parse(r.data),
  }));
}

export function retireLesson(store: Store, id: string, by: string, reason: string): void {
  humanChangeControl(store, by, `retire lesson ${id}: ${reason}`, (set) => {
    const l = set.lessons.find((x) => x.id === id);
    if (!l) throw new UserError(`No lesson ${id}`);
    l.status = 'retired';
    l.retired = { by, reason, at: new Date().toISOString() };
    l.version++;
  });
}

export function approvePattern(store: Store, id: string, by: string): void {
  humanChangeControl(store, by, `approve general pattern of ${id}`, (set) => {
    const l = set.lessons.find((x) => x.id === id);
    if (!l?.pattern) throw new UserError(`Lesson ${id} has no proposed pattern`);
    l.pattern.status = 'approved';
    l.version++;
  });
}

/** Builder rules handed to any agent at the start of every task in the project. */
export function builderRules(set: ControlSet): string {
  const ls = activeLessons(set);
  if (!ls.length) return '';
  const L = ['Lessons from earlier corrections in this project (ProofLoop checks the ones marked [checked] on every run):'];
  for (const l of ls) L.push(`- [${l.check ? 'checked' : 'review'}] ${l.builderRule}`);
  const patterns = ls.filter((l) => l.pattern?.status === 'approved');
  if (patterns.length) {
    L.push('General patterns approved by a human:');
    for (const l of patterns) L.push(`- ${l.pattern!.text}`);
  }
  return L.join('\n');
}

/** Later commits on top of an accepted run's commit: was this a miss? */
export function fixesAfterAccepted(store: Store, root: string): { runId: string; commit: string; later: number }[] {
  const out: { runId: string; commit: string; later: number }[] = [];
  for (const r of store.runs('verify').filter((x) => x.status === 'ACCEPTED').slice(0, 20)) {
    const later = commitsAfter(root, r.commit_sha).length;
    if (later) out.push({ runId: r.id, commit: r.commit_sha, later });
  }
  return out;
}

const CORRECTION = [
  /\b(this|that|it)('s| is)\s+(still\s+)?(wrong|broken|incorrect|not right)\b/i,
  /\b(is|are)\s+(still\s+)?(wrong|broken|incorrect|missing)\b/i,
  /\b(doesn't|does not|didn't|did not)\s+work\b/i,
  /\byou (missed|forgot|broke)\b/i,
  /\bstill (fails|failing|broken)\b/i,
  /\b(regression|wrong result)\b/i,
  /\b(das ist|ist)\s+(noch\s+)?falsch\b/i,
  /\bfunktioniert\s+(noch\s+)?nicht\b/i,
  /\b(kaputt|vergessen)\b/i,
];

export function looksLikeCorrection(prompt: string): boolean {
  return CORRECTION.some((re) => re.test(prompt));
}
