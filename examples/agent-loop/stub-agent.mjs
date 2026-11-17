#!/usr/bin/env node
// Stand-in for the `claude` and `codex` CLIs, used by examples/agent-loop/run.sh to test the
// launcher without spending model calls. It parses the same arguments the real CLIs get, calls
// the hooks the way the real agents do (same event JSON on stdin), and "works" by copying files:
// first it makes the seeded defect, and once ProofLoop sends findings back it fixes it.
//   STUB_AGENT=claude|codex   which CLI to imitate
//   STUB_VARIANTS=DIR         holds base/ (original files), defect/ and refactor/
//   STUB_LOG=FILE             JSON lines of everything the stub saw (asserted by run.sh)
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const agent = process.env.STUB_AGENT;
const variants = process.env.STUB_VARIANTS;
const logFile = process.env.STUB_LOG;
const args = process.argv.slice(2);
const cwd = process.cwd();
const log = (entry) => appendFileSync(logFile, JSON.stringify({ agent, ...entry }) + '\n');
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// ---- hooks, read from where each real CLI reads them
let hooks = {};
if (agent === 'claude') {
  const settings = opt('--settings');
  if (settings) hooks = JSON.parse(readFileSync(settings, 'utf8')).hooks ?? {};
} else {
  const file = join(cwd, '.codex', 'hooks.json');
  if (existsSync(file)) hooks = JSON.parse(readFileSync(file, 'utf8')).hooks ?? {};
}
const sessionId = opt('--session-id') ?? opt('--resume') ?? (args[0] === 'exec' && args[1] === 'resume' ? args[2] : 'stub-session-1');

function callHook(event, payload = {}) {
  const results = [];
  for (const group of hooks[event] ?? []) {
    if (group.matcher && payload.tool_name && !new RegExp(`^(?:${group.matcher})$`).test(payload.tool_name)) continue;
    for (const h of group.hooks) {
      const input = JSON.stringify({ session_id: sessionId, cwd, hook_event_name: event, ...payload });
      const r = spawnSync('sh', ['-c', h.command], { input, cwd, env: process.env, encoding: 'utf8', timeout: (h.timeout ?? 600) * 1000 });
      let out = {};
      try {
        out = r.stdout.trim() ? JSON.parse(r.stdout) : {};
      } catch {
        out = { raw: r.stdout };
      }
      results.push({ code: r.status, out });
    }
  }
  log({ hook: event, tool: payload.tool_name, results });
  return results;
}

const editTool = agent === 'claude' ? 'Edit' : 'apply_patch';
const editInput = (file) => (agent === 'claude' ? { file_path: join(cwd, file), old_string: 'a', new_string: 'b' } : { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\n` });

function tryEdit(file) {
  const res = callHook('PreToolUse', { tool_name: editTool, tool_input: editInput(file) });
  const denied = res.some((r) => r.out?.hookSpecificOutput?.permissionDecision === 'deny');
  log({ attempt: file, denied });
  return !denied;
}

function apply(name) {
  cpSync(join(variants, name), cwd, { recursive: true });
  callHook('PostToolUse', { tool_name: editTool, tool_input: editInput('src/loads.mjs'), tool_response: {} });
  log({ applied: name });
}

function makeDefect() {
  tryEdit('.proofloop/contract.json'); // must be denied
  tryEdit('test/loads.test.mjs'); // protected test: must be denied
  if (tryEdit('src/loads.mjs')) apply('defect');
}
function fix() {
  apply('base');
  apply('refactor');
}

const prompt = agent === 'claude' ? opt('-p') : args[0] === 'exec' ? (args[1] === 'resume' ? args[3] : args[1]) : undefined;
log({ argv: args, prompt: prompt?.slice(0, 400) });

if (agent === 'claude' && prompt !== undefined) {
  // headless: claude -p PROMPT (--session-id | --resume)
  if (!args.includes('--resume')) {
    callHook('SessionStart', { source: 'startup' });
    makeDefect();
  } else fix();
  callHook('Stop', { stop_hook_active: false });
  console.log('stub claude: done');
} else if (agent === 'codex' && args[0] === 'exec') {
  const thread = args[1] === 'resume' ? args[2] : 'thr_stub_1';
  console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));
  if (args[1] !== 'resume') {
    callHook('SessionStart', { source: 'startup' });
    makeDefect();
  } else fix();
  callHook('Stop', { stop_hook_active: false });
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }));
} else {
  // interactive: two turns, each ending with the Stop hook the way the real CLIs do
  callHook('SessionStart', { source: 'startup' });
  callHook('UserPromptSubmit', { prompt: 'Add pagination to the loads list' });
  makeDefect();
  const first = callHook('Stop', { stop_hook_active: false });
  const blocked = first.some((r) => r.out?.decision === 'block');
  log({ turn: 1, blocked, reason: first[0]?.out?.reason?.slice(0, 600) });
  if (blocked) {
    fix();
    const second = callHook('Stop', { stop_hook_active: true });
    log({ turn: 2, blocked: second.some((r) => r.out?.decision === 'block'), message: second[0]?.out?.systemMessage });
  }
}
