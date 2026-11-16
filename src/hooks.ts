// In-session harness, Claude Code adapter (v0). Thin: every event calls the same engine as the
// CLI. The harness is not the acceptance authority — a crashed or timed-out stop hook does not
// block in Claude Code, so acceptance always comes from a separate `proofloop verify`.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, proofloopHome } from './store.js';
import { CONTROL_DIR, controlForRun, loadFrozen } from './control.js';
import { headCommit, repoRoot } from './git.js';
import { latestBaseline } from './snapshot.js';
import { verify } from './verify.js';
import { renderAgentFeedback } from './report.js';
import { builderRules, looksLikeCorrection, recordLesson } from './lessons.js';
import { exec, globMatch, sleep, truncate } from './util.js';
import { appEnv } from './app.js';

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
  source?: string;
}

const ALWAYS_PROTECTED = [`${CONTROL_DIR}/**`, '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/**', '.codex/**', '.git/hooks/**'];
const HUMAN_ONLY = /\bproofloop\b[^\n;|&]*\b(freeze|retire|approve|approve-pattern|rules\s+approve|hooks\s+install|lesson\s+retire)\b/;
const WRITE_VERBS = /(>|>>|\brm\b|\bmv\b|\bcp\b|\bsed\s+-i|\bperl\s+-[a-z]*i|\btee\b|\btruncate\b|\bchmod\b|\bln\b|\bgit\s+(checkout|restore|rm|mv)\b|\bpython3?\b|\bnode\b\s+-e|\bdd\b|\binstall\b)/;

function protectedGlobs(root: string, extra: string[]): string[] {
  const home = relative(root, proofloopHome());
  return [...ALWAYS_PROTECTED, ...extra, ...(home.startsWith('..') ? [] : [`${home}/**`])];
}

export function isProtectedPath(root: string, file: string, globs: string[]): boolean {
  const abs = isAbsolute(file) ? file : resolve(root, file);
  if (abs.startsWith(proofloopHome() + '/')) return true;
  if (abs.startsWith(join(homedir(), '.claude') + '/settings')) return true;
  const rel = relative(root, abs);
  if (rel.startsWith('..')) return false;
  return globs.some((g) => globMatch(g, rel));
}

export function bashTouchesProtected(command: string, globs: string[]): string | undefined {
  if (HUMAN_ONLY.test(command)) return 'this ProofLoop command is reserved for a human';
  if (!WRITE_VERBS.test(command)) return undefined;
  const needles = [CONTROL_DIR, '.claude/settings', '.claude/hooks', '.proofloop', proofloopHome(), ...globs.map((g) => g.split(/[*?[]/)[0]).filter((x) => x.length > 2)];
  const hit = needles.find((n) => command.includes(n));
  return hit ? `the command writes near protected path "${hit}"` : undefined;
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

export async function runClaudeHook(event: string, stdin: string): Promise<void> {
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
    return; // not a git repo: ProofLoop does nothing
  }
  if (!existsSync(join(root, CONTROL_DIR, 'config.json'))) return; // project not using ProofLoop
  const store = new Store(root);
  try {
    const sessionId = input.session_id ?? 'unknown';
    switch (event) {
      case 'SessionStart': {
        const control = controlForRun(store, root);
        const lines: string[] = ['ProofLoop is active in this repository. It judges your work; your own "done" does not count.'];
        if (control.set.contract.objective) lines.push(`Objective: ${control.set.contract.objective}`);
        if (control.set.contract.requirements.length) {
          lines.push('Frozen acceptance contract (you cannot change it):');
          for (const r of control.set.contract.requirements) lines.push(`- ${r.id}${r.mandatory === false ? ' (optional)' : ''}: ${r.text}`);
        }
        const rules = builderRules(control.set);
        if (rules) lines.push(rules);
        lines.push(
          'When you try to finish, ProofLoop re-runs every probe against the baseline and refuses the stop while anything fails. Behaviour changes nobody asked for count as failures.',
          `Do not edit ${CONTROL_DIR}/, protected tests or hook settings; those edits are blocked.`,
        );
        const head = headCommit(root);
        const base = latestBaseline(store, head);
        if (!base || base.commit !== head) {
          if (startBackgroundBaseline(store, root)) lines.push(`Recording a baseline at ${head.slice(0, 10)} in the background.`);
        }
        store.event('hook.session-start', { sessionId, source: input.source });
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
        const ti = input.tool_input ?? {};
        let reason: string | undefined;
        if (input.tool_name === 'Bash') reason = bashTouchesProtected(String(ti.command ?? ''), globs);
        else {
          const file = (ti.file_path ?? ti.notebook_path ?? ti.path) as string | undefined;
          if (file && isProtectedPath(root, file, globs)) reason = `${file} is protected by ProofLoop (contract, tests, rules or hook settings)`;
        }
        if (reason) {
          store.event('hook.blocked', { sessionId, tool: input.tool_name, reason });
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
        const control = loadFrozen(store);
        const max = control?.set.config.harness?.maxStopRounds ?? 3;
        const session = store.session(sessionId);
        if (session.stop_rounds >= max) {
          out({ systemMessage: `ProofLoop: stop allowed after ${session.stop_rounds} refused rounds (cap ${max}). The work is NOT accepted; run \`proofloop verify\` for the final report.` });
          return;
        }
        await waitForBaseline(store, 4 * 60_000);
        if (!latestBaseline(store)) {
          out({ systemMessage: 'ProofLoop: no baseline yet, so this change was not judged (UNKNOWN). Run `proofloop snapshot --ref <base>` and `proofloop verify`.' });
          return;
        }
        const report = await verify(store, root, { label: `stop hook ${sessionId}` });
        const reportPath = store.path('runs', report.runId, 'report.md');
        if (report.decision === 'ACCEPTED') {
          store.updateSession(sessionId, { stop_rounds: 0 });
          out({ systemMessage: `ProofLoop: in-session check passed (run ${report.runId}). Final acceptance still needs \`proofloop verify\` outside the session. Report: ${reportPath}` });
          return;
        }
        store.updateSession(sessionId, { stop_rounds: session.stop_rounds + 1 });
        out({ decision: 'block', reason: renderAgentFeedback(report, reportPath) + `\n(round ${session.stop_rounds + 1} of ${max})` });
        return;
      }
      default:
        return;
    }
  } finally {
    store.close();
  }
}

export function claudeHookSettings(command = 'proofloop'): Record<string, unknown> {
  const h = (event: string, timeout?: number) => ({ type: 'command', command: `${command} hook claude ${event}`, ...(timeout ? { timeout } : {}) });
  return {
    hooks: {
      SessionStart: [{ hooks: [h('SessionStart', 60)] }],
      UserPromptSubmit: [{ hooks: [h('UserPromptSubmit', 30)] }],
      PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [h('PreToolUse', 30)] }],
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [h('PostToolUse', 300)] }],
      Stop: [{ hooks: [h('Stop', 600)] }],
    },
  };
}

/** Merges the hooks into a settings file (user-level by default, never the repository). */
export function installClaudeHooks(settingsFile: string, command: string): { file: string; backup?: string } {
  let current: Record<string, unknown> = {};
  let backup: string | undefined;
  if (existsSync(settingsFile)) {
    const text = readFileSync(settingsFile, 'utf8');
    current = JSON.parse(text) as Record<string, unknown>;
    backup = `${settingsFile}.proofloop-backup-${Date.now()}`;
    writeFileSync(backup, text);
  }
  const hooks = (current.hooks ?? {}) as Record<string, { matcher?: string; hooks: { command?: string }[] }[]>;
  const add = claudeHookSettings(command).hooks as Record<string, { matcher?: string; hooks: { command?: string }[] }[]>;
  for (const [event, groups] of Object.entries(add)) {
    const existing = (hooks[event] ?? []).filter((g) => !g.hooks.some((x) => x.command?.includes(' hook claude ')));
    hooks[event] = [...existing, ...groups];
  }
  current.hooks = hooks;
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(current, null, 2) + '\n');
  return { file: settingsFile, backup };
}
