// ProofLoop in front of the agent. The launcher owns the session from start to finish:
//   1. control set frozen and a baseline recorded at HEAD *before* the agent may touch anything,
//   2. the agent starts with ProofLoop's hooks injected (guards, fast checks, stop gate),
//   3. when the agent says it is done, ProofLoop verifies outside the session and decides.
// `proofloop claude|codex` wraps an interactive session; `proofloop run` drives a headless loop
// (task → verify → findings back to the same agent session → verify …) up to a round cap.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Store } from './store.js';
import { controlForRun } from './control.js';
import { headCommit, workingTreeState } from './git.js';
import { latestBaseline, takeSnapshot } from './snapshot.js';
import { verify, type VerifyReport } from './verify.js';
import { renderAgentFeedback } from './report.js';
import { type Agent, agentBriefing, codexHooksFile, hasProofloopHooks, hookSettings, installCodexHooks, selfCommand } from './hooks.js';
import { UserError, newId } from './util.js';
import type { Manifest } from './types.js';

export interface LaunchOptions {
  agent: Agent;
  /** Arguments passed through to the agent CLI (everything after `--`). */
  agentArgs: string[];
  /** Override the agent executable (tests, wrappers). */
  agentBin?: string;
  allowDirty?: boolean;
  finalVerify?: boolean;
  /** Codex only: pass --dangerously-bypass-hook-trust instead of asking for /hooks trust. */
  trustHooks?: boolean;
  log: (m: string) => void;
}

export interface Prepared {
  control: ReturnType<typeof controlForRun>;
  baseline: Manifest;
}

/** Step 1, before any agent runs: frozen control, clean tree, baseline at HEAD. */
export async function prepare(store: Store, root: string, o: Pick<LaunchOptions, 'allowDirty' | 'log'>): Promise<Prepared> {
  const control = controlForRun(store, root);
  if (control.autoFrozen) o.log(`ProofLoop: froze the control files as v${control.version} (first run).`);
  if (control.repoDiffers) o.log(`ProofLoop: warning: .proofloop/ differs from frozen v${control.version}; the frozen copy is used. Run \`proofloop freeze\` to adopt your edits.`);
  const wt = workingTreeState(root);
  if (wt.dirty && !o.allowDirty)
    throw new UserError('The working tree has uncommitted changes. They would be counted as the agent\'s change. Commit or stash them first, or pass --allow-dirty.');
  const head = headCommit(root);
  if (head === 'no-commit') throw new UserError('The repository has no commit yet; ProofLoop records the baseline at HEAD.');
  const existing = latestBaseline(store, head);
  if (existing && existing.commit === head && existing.controlVersion === control.version && existing.status === 'complete') {
    o.log(`ProofLoop: baseline ${existing.id} at ${head.slice(0, 10)} (already recorded).`);
    return { control, baseline: existing };
  }
  o.log(`ProofLoop: recording the baseline at ${head.slice(0, 10)} before the agent starts…`);
  const m = await takeSnapshot(store, root, control, { ref: 'HEAD', label: 'baseline (launcher)', log: (x) => o.log(`  ${x}`) });
  if (m.status === 'blocked') throw new UserError(`Baseline BLOCKED: ${m.blockedReason}. Fix the app's clean start (.proofloop/config.json) before handing work to an agent.`);
  const failed = m.observations.filter((x) => !x.ok).length;
  o.log(`ProofLoop: baseline ${m.id}: ${m.observations.length} probes${failed ? ` (${failed} already failing, labelled PREEXISTING)` : ''}.`);
  return { control, baseline: m };
}

function launchEnv(baseline: Manifest, outerLoop: boolean): NodeJS.ProcessEnv {
  return { ...process.env, PROOFLOOP_LAUNCHED: '1', PROOFLOOP_BASELINE: baseline.id, ...(outerLoop ? { PROOFLOOP_OUTER_LOOP: '1' } : {}) };
}

/** Claude: hooks are injected for this session only (`--settings`), nothing is installed. */
function claudeSettingsFile(store: Store): string {
  mkdirSync(store.path('launch'), { recursive: true });
  const file = store.path('launch', 'claude-settings.json');
  writeFileSync(file, JSON.stringify(hookSettings('claude', selfCommand(), true), null, 2) + '\n');
  return file;
}

/** Codex: hooks live in the repository's `.codex/hooks.json` (the agent cannot edit it). */
function ensureCodexHooks(root: string, log: (m: string) => void): void {
  const file = codexHooksFile(root);
  if (hasProofloopHooks(file, 'codex')) return;
  const r = installCodexHooks(file, selfCommand());
  log(`ProofLoop: wrote Codex hooks to ${r.file}${r.backup ? ` (backup ${r.backup})` : ''}.`);
  log('ProofLoop: Codex runs new hooks only after you trust them: type /hooks in Codex once (or launch with --trust-hooks).');
}

function hasFlag(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.some((n) => a === n || a.startsWith(n + '=')));
}

function runChild(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onLine?: (l: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: onLine ? ['inherit', 'pipe', 'inherit'] : 'inherit' });
    if (onLine && child.stdout) createInterface({ input: child.stdout }).on('line', onLine);
    child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new UserError(`\`${bin}\` was not found on PATH. Install it or pass --agent-bin.`) : e));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1)));
  });
}

function summary(r: VerifyReport, store: Store): string {
  const failing = r.requirements.filter((q) => q.mandatory && q.status !== 'VERIFIED').map((q) => `${q.id} ${q.status}`);
  const unintended = r.differences.filter((d) => d.class === 'unintended').length;
  return [
    `ProofLoop: ${r.decision} (run ${r.runId})`,
    failing.length ? `  not verified: ${failing.join(', ')}` : '  every mandatory requirement VERIFIED',
    `  differences: ${r.differences.length} (${unintended} unintended)`,
    `  report: ${store.path('runs', r.runId, 'report.md')}`,
  ].join('\n');
}

/** Interactive: `proofloop claude|codex [-- agent args]`. Returns the process exit code. */
export async function launchInteractive(store: Store, root: string, o: LaunchOptions): Promise<number> {
  const { baseline } = await prepare(store, root, o);
  const startedAt = new Date().toISOString();
  const env = launchEnv(baseline, false);
  const args = [...o.agentArgs];
  if (o.agent === 'claude') args.unshift('--settings', claudeSettingsFile(store));
  else {
    ensureCodexHooks(root, o.log);
    if (o.trustHooks) args.unshift('--dangerously-bypass-hook-trust');
  }
  const bin = o.agentBin ?? o.agent;
  store.event('launch.start', { agent: o.agent, baseline: baseline.id, mode: 'interactive' });
  o.log(`ProofLoop: starting ${o.agent}. The stop gate re-checks your app against the baseline whenever the agent finishes a turn.\n`);
  const code = await runChild(bin, args, root, env);
  store.event('launch.exit', { agent: o.agent, code });

  const marker = store.path('sessions', `last-start-${o.agent}`);
  const hooksRan = existsSync(marker) && readFileSync(marker, 'utf8') >= startedAt;
  if (!hooksRan)
    o.log(`\nProofLoop: warning: ${o.agent}'s hooks did not run in this session, so nothing was gated while it worked${o.agent === 'codex' ? ' (trust them with /hooks, or use --trust-hooks)' : ''}. The final check below still applies.`);

  if (o.finalVerify === false) return code;
  const wt = workingTreeState(root);
  if (!wt.dirty && headCommit(root) === baseline.commit) {
    o.log('\nProofLoop: no changes since the baseline; nothing to judge.');
    return code;
  }
  o.log('\nProofLoop: final verification outside the session…');
  const report = await verify(store, root, { baseline: baseline.id, label: `final ${o.agent} session`, log: (x) => o.log(`  ${x}`) });
  o.log(summary(report, store));
  return report.decision === 'ACCEPTED' ? 0 : 1;
}

export interface LoopOptions extends LaunchOptions {
  task: string;
  rounds: number;
}

export interface LoopResult {
  decision: 'ACCEPTED' | 'REJECTED' | 'BLOCKED';
  rounds: number;
  runs: string[];
  sessionId?: string;
  reason?: string;
}

function briefTask(task: string, prep: Prepared): string {
  return `${task}\n\n---\n${agentBriefing(prep.control.set).join('\n')}`;
}

/** One agent turn in headless mode. Returns the exit code and the session id to resume. */
async function agentTurn(o: LoopOptions, root: string, store: Store, env: NodeJS.ProcessEnv, prompt: string, sessionId: string | undefined, round: number): Promise<{ code: number; sessionId?: string }> {
  const bin = o.agentBin ?? o.agent;
  const user = o.agentArgs;
  if (o.agent === 'claude') {
    const id = sessionId ?? randomUUID();
    const args = ['-p', prompt, '--settings', claudeSettingsFile(store), ...(sessionId ? ['--resume', id] : ['--session-id', id])];
    if (!hasFlag(user, '--permission-mode', '--dangerously-skip-permissions')) args.push('--permission-mode', 'acceptEdits');
    args.push(...user);
    return { code: await runChild(bin, args, root, env), sessionId: id };
  }
  // Codex: `codex exec --json` prints JSONL events; the first carries the thread id to resume.
  ensureCodexHooks(root, o.log);
  const sandbox = hasFlag(user, '--sandbox', '-s', '--full-auto', '--dangerously-bypass-approvals-and-sandbox') ? [] : ['--full-auto'];
  const trust = o.trustHooks ? ['--dangerously-bypass-hook-trust'] : [];
  const args = sessionId ? ['exec', 'resume', sessionId, prompt, '--json', ...trust, ...user] : ['exec', prompt, '--json', ...sandbox, ...trust, ...user];
  let thread = sessionId;
  const code = await runChild(bin, args, root, env, (line) => {
    let ev: { type?: string; thread_id?: string; item?: { type?: string; text?: string } };
    try {
      ev = JSON.parse(line);
    } catch {
      process.stdout.write(line + '\n');
      return;
    }
    if (ev.type === 'thread.started' && ev.thread_id) thread = ev.thread_id;
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) process.stdout.write(`[codex r${round}] ${ev.item.text}\n`);
  });
  return { code, sessionId: thread };
}

/** Headless outer loop: `proofloop run --agent claude|codex "task"`. */
export async function runLoop(store: Store, root: string, o: LoopOptions): Promise<LoopResult> {
  const prep = await prepare(store, root, o);
  const loopId = newId('loop');
  const env = launchEnv(prep.baseline, true);
  const runs: string[] = [];
  let sessionId: string | undefined;
  let prompt = briefTask(o.task, prep);
  store.event('loop.start', { loopId, agent: o.agent, baseline: prep.baseline.id, task: o.task, rounds: o.rounds });
  for (let round = 1; round <= o.rounds; round++) {
    o.log(`\nProofLoop: round ${round}/${o.rounds} — ${o.agent} is working…`);
    const turn = await agentTurn(o, root, store, env, prompt, sessionId, round);
    sessionId = turn.sessionId;
    if (sessionId) store.updateSession(sessionId, { objective: o.task.slice(0, 2000) });
    if (turn.code !== 0) {
      store.event('loop.end', { loopId, decision: 'BLOCKED', round, agentExit: turn.code });
      return { decision: 'BLOCKED', rounds: round, runs, sessionId, reason: `${o.agent} exited with code ${turn.code}` };
    }
    if (!workingTreeState(root).dirty && headCommit(root) === prep.baseline.commit) {
      o.log('ProofLoop: the agent changed nothing.');
      if (round === o.rounds) break;
      prompt = 'ProofLoop sees no change in the repository. Make the change the task asks for.';
      continue;
    }
    o.log(`ProofLoop: round ${round}: verifying against baseline ${prep.baseline.id}…`);
    const report = await verify(store, root, { baseline: prep.baseline.id, label: `${loopId} round ${round}`, log: (x) => o.log(`  ${x}`) });
    runs.push(report.runId);
    o.log(summary(report, store));
    if (report.decision === 'ACCEPTED') {
      store.event('loop.end', { loopId, decision: 'ACCEPTED', round, run: report.runId });
      return { decision: 'ACCEPTED', rounds: round, runs, sessionId };
    }
    prompt = renderAgentFeedback(report, store.path('runs', report.runId, 'report.md')) + `\n(ProofLoop round ${round} of ${o.rounds})`;
  }
  store.event('loop.end', { loopId, decision: 'REJECTED', rounds: o.rounds });
  return { decision: 'REJECTED', rounds: o.rounds, runs, sessionId, reason: `not accepted after ${o.rounds} rounds` };
}
