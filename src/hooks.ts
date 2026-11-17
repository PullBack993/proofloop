// In-session harness for Claude Code and Codex. Both agents use the same hook protocol (JSON on
// stdin; hookSpecificOutput / decision:block on stdout), so one engine serves both; only tool names
// differ (Codex edits files through apply_patch). The harness is not the acceptance authority — a
// crashed or timed-out hook does not block — so acceptance always comes from a separate verify,
// which the launcher (`proofloop claude|codex|run`) runs itself when the agent finishes.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, proofloopHome } from './store.js';
import { CONTROL_DIR, controlForRun, loadFrozen } from './control.js';
import { headCommit, repoRoot, workingTreeState } from './git.js';
import { latestBaseline, loadManifest } from './snapshot.js';
import { verify } from './verify.js';
import { renderAgentFeedback } from './report.js';
import { builderRules, looksLikeCorrection, recordLesson } from './lessons.js';
import { exec, globMatch, sleep, truncate } from './util.js';
import { appEnv } from './app.js';
import type { ControlSet } from './types.js';

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
  source?: string;
  turn_id?: string;
}

export type Agent = 'claude' | 'codex';
export const AGENTS: Agent[] = ['claude', 'codex'];

const ALWAYS_PROTECTED = [`${CONTROL_DIR}/**`, '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/**', '.codex/**', '.git/hooks/**'];
const HOME_PROTECTED = () => [join(homedir(), '.claude') + '/settings', join(homedir(), '.claude', 'hooks') + '/', join(homedir(), '.codex') + '/'];
const HUMAN_ONLY = /\bproofloop\b[^\n;|&]*\b(freeze|retire|approve|approve-pattern|rules\s+approve|hooks\s+install|lesson\s+retire)\b/;
// Commands that change files. Output redirection is handled separately (its target is checked).
const WRITE_VERBS = /(\brm\b|\bmv\b|\bcp\b|\bsed\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i|\bperl\s+-[a-z]*i|\btee\b|\btruncate\b|\bchmod\b|\bln\b|\bgit\s+(checkout|restore|rm|mv|apply)\b|\bpatch\b|\bpython3?\b|\bnode\b\s+-e|\bdd\b|\binstall\b|\btouch\b|\bmkdir\b|\bunlink\b)/;

function protectedGlobs(root: string, extra: string[]): string[] {
  const home = relative(root, proofloopHome());
  return [...ALWAYS_PROTECTED, ...extra, ...(home.startsWith('..') ? [] : [`${home}/**`])];
}

export function isProtectedPath(root: string, file: string, globs: string[]): boolean {
  const abs = isAbsolute(file) ? file : resolve(root, file);
  if (abs.startsWith(proofloopHome() + '/')) return true;
  if (HOME_PROTECTED().some((h) => abs.startsWith(h))) return true;
  const rel = relative(root, abs);
  if (rel.startsWith('..')) return false;
  return globs.some((g) => globMatch(g, rel));
}

export function bashTouchesProtected(command: string, globs: string[]): string | undefined {
  if (HUMAN_ONLY.test(command)) return 'this ProofLoop command is reserved for a human';
  const needles = [CONTROL_DIR, '.claude/settings', '.claude/hooks', '.codex/', '.proofloop', proofloopHome(), ...globs.map((g) => g.split(/[*?[]/)[0]).filter((x) => x.length > 2)];
  const found = (text: string) => needles.find((n) => text.includes(n));
  // Harmless redirections (2>/dev/null, 2>&1) are not writes.
  const cleaned = command.replace(/\d*>&\d+/g, ' ').replace(/[\d&]*>>?\s*\/dev\/null\b/g, ' ');
  // A redirection writes to its target: check the target, not the whole line.
  for (const m of cleaned.matchAll(/>>?\|?\s*("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g)) {
    const hit = found(m[1].replace(/^["']|["']$/g, ''));
    if (hit) return `the command writes to protected path "${hit}"`;
  }
  // Any other write: a protected path in the same command segment as the writing command.
  for (const seg of cleaned.split(/\|\||&&|[;|\n]/)) {
    if (!WRITE_VERBS.test(seg)) continue;
    const hit = found(seg);
    if (hit) return `the command writes near protected path "${hit}"`;
  }
  return undefined;
}

/** Files an apply_patch (Codex) touches: Add/Update/Delete File and Move to lines. */
export function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) files.push(m[1].trim());
  return files;
}

/** Paths a tool call writes, for both agents' tool names. */
export function toolTargets(toolName: string | undefined, ti: Record<string, unknown>): { bash?: string; files: string[] } {
  if (toolName === 'Bash' || toolName === 'exec_command' || toolName === 'shell') {
    const c = ti.command ?? ti.cmd;
    return { bash: Array.isArray(c) ? c.join(' ') : String(c ?? ''), files: [] };
  }
  if (toolName === 'apply_patch') return { files: patchFiles(String(ti.command ?? ti.patch ?? ti.input ?? '')) };
  const file = (ti.file_path ?? ti.notebook_path ?? ti.path) as string | undefined;
  return { files: file ? [file] : [] };
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}

function lockPath(store: Store): string {
  return store.path('baseline.lock');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startBackgroundBaseline(store: Store, root: string): boolean {
  const lock = lockPath(store);
  if (existsSync(lock) && pidAlive(Number(readFileSync(lock, 'utf8')))) return false;
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  mkdirSync(store.path('logs'), { recursive: true });
  const logFile = store.path('logs', 'baseline.log');
  const child = spawn(process.execPath, [cli, 'snapshot', '--ref', 'HEAD', '--label', 'baseline (session start)', '--repo', root, '--lock', lock], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  writeFileSync(lock, String(child.pid));
  child.unref();
  writeFileSync(logFile, `started ${new Date().toISOString()} pid ${child.pid}\n`);
  return true;
}

async function waitForBaseline(store: Store, maxMs: number): Promise<void> {
  const lock = lockPath(store);
  const deadline = Date.now() + maxMs;
  while (existsSync(lock) && pidAlive(Number(readFileSync(lock, 'utf8'))) && Date.now() < deadline) await sleep(1000);
}

export interface HookOptions {
  /** Set by the launcher on the hooks it injects; other copies of the hooks step aside. */
  launched?: boolean;
}

/** Launcher state handed to hooks through the environment. */
function launchEnv(): { launched: boolean; outerLoop: boolean; baseline?: string } {
  return { launched: process.env.PROOFLOOP_LAUNCHED === '1', outerLoop: process.env.PROOFLOOP_OUTER_LOOP === '1', baseline: process.env.PROOFLOOP_BASELINE || undefined };
}

interface StopCache {
  state: string;
  decision: string;
  feedback: string;
  runId: string;
}

export async function runHook(agent: Agent, event: string, stdin: string, opts: HookOptions = {}): Promise<void> {
  // Stop must always answer with JSON in Codex; an empty object means "carry on".
  const allow = () => {
    if (event === 'Stop' || event === 'SubagentStop') out({});
  };
  const env = launchEnv();
  // Inside a launched session, user-level copies of the hooks would run twice: let the injected ones act.
  if (env.launched && !opts.launched && agent === 'claude') return allow();
  let input: HookInput = {};
  try {
    input = stdin.trim() ? (JSON.parse(stdin) as HookInput) : {};
  } catch {
    /* malformed input: act as if empty */
  }
  let root: string;
  try {
    root = repoRoot(input.cwd ?? process.cwd());
  } catch {
    return allow(); // not a git repo: ProofLoop does nothing
  }
  if (!existsSync(join(root, CONTROL_DIR, 'config.json'))) return allow(); // project not using ProofLoop
  const store = new Store(root);
  try {
    const sessionId = input.session_id ?? 'unknown';
    switch (event) {
      case 'SessionStart': {
        mkdirSync(store.path('sessions'), { recursive: true });
        writeFileSync(store.path('sessions', `last-start-${agent}`), new Date().toISOString());
        store.event('hook.session-start', { agent, sessionId, source: input.source, launched: env.launched });
        if (env.outerLoop) return; // the outer loop already put the contract into the task
        const control = controlForRun(store, root);
        const lines = agentBriefing(control.set);
        const head = headCommit(root);
        const base = latestBaseline(store, head);
        if (!env.baseline && (!base || base.commit !== head)) {
          if (startBackgroundBaseline(store, root)) lines.push(`Recording a baseline at ${head.slice(0, 10)} in the background.`);
        }
        out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
        return;
      }
      case 'UserPromptSubmit': {
        const prompt = input.prompt ?? '';
        const session = store.session(sessionId);
        if (!session.objective && prompt.trim()) store.updateSession(sessionId, { objective: truncate(prompt, 2000) });
        if (session.objective && looksLikeCorrection(prompt) && loadFrozen(store)) {
          const lesson = recordLesson(store, { what: truncate(prompt.replace(/\s+/g, ' '), 300), foundBy: 'prompt-correction', missReason: 'unknown' });
          store.event('hook.correction', { sessionId, lesson: lesson.id });
          out({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: `ProofLoop recorded this correction as lesson ${lesson.id} (needs an executable check). Reproduce the problem with a concrete request before fixing it, and say which probe/path shows it so the human can run \`proofloop correct --lesson ${lesson.id} --probe <id> --path <$.x> --op <op> --value <v>\`.`,
            },
          });
        }
        return;
      }
      case 'PreToolUse': {
        const control = loadFrozen(store);
        const globs = protectedGlobs(root, control?.set.config.protectedPaths ?? []);
        const t = toolTargets(input.tool_name, input.tool_input ?? {});
        let reason: string | undefined;
        if (t.bash !== undefined) reason = bashTouchesProtected(t.bash, globs);
        else {
          const hit = t.files.find((f) => isProtectedPath(root, f, globs));
          if (hit) reason = `${hit} is protected by ProofLoop (contract, tests, rules or hook settings)`;
        }
        if (reason) {
          store.event('hook.blocked', { agent, sessionId, tool: input.tool_name, reason });
          out({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `ProofLoop: ${reason}. Change the application code instead; test and contract changes go through a human review.`,
            },
          });
        }
        return;
      }
      case 'PostToolUse': {
        const control = loadFrozen(store);
        const checks = control?.set.config.fastChecks ?? [];
        if (!checks.length) return;
        const cwd = join(root, control!.set.config.app.cwd ?? '.');
        const failures: string[] = [];
        for (const c of checks) {
          const r = await exec(c.command, { cwd, env: { ...process.env, ...appEnv(control!.set.config), NODE_OPTIONS: undefined }, timeoutMs: c.timeoutMs ?? 60_000 });
          if (r.code !== 0) failures.push(`${c.name} (${c.command}) failed${r.timedOut ? ' (timeout)' : ''}:\n${truncate((r.stdout + r.stderr).trim().split('\n').slice(-25).join('\n'), 3000)}`);
        }
        if (failures.length) out({ decision: 'block', reason: `ProofLoop fast checks failed:\n${failures.join('\n\n')}` });
        return;
      }
      case 'Stop': {
        if (env.outerLoop) return allow(); // `proofloop run` verifies after the agent returns
        const control = loadFrozen(store);
        const max = control?.set.config.harness?.maxStopRounds ?? 3;
        const session = store.session(sessionId);
        if (session.stop_rounds >= max) {
          out({ systemMessage: `ProofLoop: stop allowed after ${session.stop_rounds} refused rounds (cap ${max}). The work is NOT accepted; run \`proofloop verify\` for the final report.` });
          return;
        }
        await waitForBaseline(store, 4 * 60_000);
        const base = env.baseline ? loadManifest(store, env.baseline) : latestBaseline(store);
        if (!base) {
          out({ systemMessage: 'ProofLoop: no baseline yet, so this change was not judged (UNKNOWN). Run `proofloop snapshot --ref <base>` and `proofloop verify`.' });
          return;
        }
        // Nothing changed since the baseline, or since the last judged turn: reuse that verdict.
        const wt = workingTreeState(root);
        const head = headCommit(root);
        if (!wt.dirty && head === base.commit) return allow();
        const state = `${head}:${wt.diffHash ?? ''}`;
        const cache = session.data ? (JSON.parse(session.data) as StopCache) : undefined;
        let decision: string;
        let feedback: string;
        let runId: string;
        if (cache && cache.state === state) {
          ({ decision, feedback, runId } = cache);
        } else {
          const report = await verify(store, root, { baseline: base.id, label: `stop hook ${agent} ${sessionId}` });
          runId = report.runId;
          decision = report.decision;
          feedback = renderAgentFeedback(report, store.path('runs', report.runId, 'report.md'));
          store.updateSession(sessionId, { data: JSON.stringify({ state, decision, feedback, runId } satisfies StopCache) });
        }
        if (decision === 'ACCEPTED') {
          store.updateSession(sessionId, { stop_rounds: 0 });
          out({ systemMessage: `ProofLoop: in-session check passed (run ${runId}).${env.launched ? '' : ' Final acceptance still needs `proofloop verify` outside the session.'}` });
          return;
        }
        store.updateSession(sessionId, { stop_rounds: session.stop_rounds + 1 });
        out({ decision: 'block', reason: feedback + `\n(round ${session.stop_rounds + 1} of ${max})` });
        return;
      }
      default:
        return allow();
    }
  } finally {
    store.close();
  }
}

/** The briefing every agent gets before it starts: contract, lessons, how it is judged. */
export function agentBriefing(set: ControlSet): string[] {
  const lines: string[] = ['ProofLoop is active in this repository. It judges your work; your own "done" does not count.'];
  if (set.contract.objective) lines.push(`Objective: ${set.contract.objective}`);
  if (set.contract.requirements.length) {
    lines.push('Frozen acceptance contract (you cannot change it):');
    for (const r of set.contract.requirements) lines.push(`- ${r.id}${r.mandatory === false ? ' (optional)' : ''}: ${r.text}`);
  }
  const rules = builderRules(set);
  if (rules) lines.push(rules);
  lines.push(
    'When you finish, ProofLoop re-runs every probe against the baseline recorded before you started and sends you back while anything fails. Behaviour changes nobody asked for count as failures.',
    `Do not edit ${CONTROL_DIR}/, protected tests or hook settings; those edits are blocked.`,
  );
  return lines;
}

type HookGroups = Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]>;

/** Shell-safe command that runs this ProofLoop build, so hooks work without `npm link`. */
export function selfCommand(): string {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const q = (x: string) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`);
  return `${q(process.execPath)} ${q(cli)}`;
}

export function hookSettings(agent: Agent, command = 'proofloop', launched = false): { hooks: HookGroups } {
  const flag = launched ? ' --launched' : '';
  const h = (event: string, timeout?: number) => ({ type: 'command', command: `${command} hook ${agent} ${event}${flag}`, ...(timeout ? { timeout } : {}) });
  const edits = agent === 'claude' ? 'Edit|Write|MultiEdit|NotebookEdit' : 'apply_patch|Edit|Write';
  return {
    hooks: {
      SessionStart: [{ hooks: [h('SessionStart', 60)] }],
      UserPromptSubmit: [{ hooks: [h('UserPromptSubmit', 30)] }],
      PreToolUse: [{ matcher: `${edits}|Bash`, hooks: [h('PreToolUse', 30)] }],
      PostToolUse: [{ matcher: agent === 'claude' ? 'Edit|Write|MultiEdit' : 'apply_patch|Edit|Write', hooks: [h('PostToolUse', 300)] }],
      Stop: [{ hooks: [h('Stop', 900)] }],
    },
  };
}

/** Kept for callers of v0. */
export function claudeHookSettings(command = 'proofloop'): Record<string, unknown> {
  return hookSettings('claude', command);
}

function mergeHooks(file: string, add: HookGroups, marker: string): { file: string; backup?: string } {
  let current: Record<string, unknown> = {};
  let backup: string | undefined;
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    current = JSON.parse(text) as Record<string, unknown>;
    backup = `${file}.proofloop-backup-${Date.now()}`;
    writeFileSync(backup, text);
  }
  const hooks = (current.hooks ?? {}) as HookGroups;
  for (const [event, groups] of Object.entries(add)) {
    const existing = (hooks[event] ?? []).filter((g) => !g.hooks.some((x) => x.command?.includes(marker)));
    hooks[event] = [...existing, ...groups];
  }
  current.hooks = hooks;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  return { file, backup };
}

/** Merges the hooks into a Claude Code settings file (user-level by default, never the repository). */
export function installClaudeHooks(settingsFile: string, command: string): { file: string; backup?: string } {
  return mergeHooks(settingsFile, hookSettings('claude', command).hooks, ' hook claude ');
}

/** Codex hooks file: the repository layer (`<repo>/.codex/hooks.json`) unless a file is given. */
export function codexHooksFile(root: string): string {
  return join(root, '.codex', 'hooks.json');
}

export function installCodexHooks(file: string, command: string): { file: string; backup?: string } {
  return mergeHooks(file, hookSettings('codex', command).hooks, ' hook codex ');
}

export function hasProofloopHooks(file: string, agent: Agent): boolean {
  return existsSync(file) && readFileSync(file, 'utf8').includes(` hook ${agent} `);
}
