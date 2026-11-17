// ProofLoop CLI commands. Loaded by cli.ts after the warning filter is in place.
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { repoRoot } from './git.js';
import { CONTROL_DIR, controlForRun, freeze, latestVersion, loadFrozen, readRepoControl, validateControl } from './control.js';
import { takeSnapshot, latestBaseline, loadManifest, Capture } from './snapshot.js';
import { verify } from './verify.js';
import { renderMarkdown } from './report.js';
import { noiseReport, renderNoise } from './noise.js';
import { buildInventory } from './inventory.js';
import { harToProbes } from './har.js';
import { approvePattern, attachCheck, builderRules, fixesAfterAccepted, listProposals, loadReport, proposeFalseAlarmRule, recordLesson, retireLesson } from './lessons.js';
import { AGENTS, type Agent, codexHooksFile, hookSettings, installClaudeHooks, installCodexHooks, runHook, selfCommand } from './hooks.js';
import { launchInteractive, runLoop } from './agent.js';
import type { Config, Contract, Json, MissReason, Op, Rule } from './types.js';
import { UserError, exec, readJson, writeJson } from './util.js';

const HELP = `proofloop — your agent says done; ProofLoop shows what changed that nobody asked for.

In front of the agent (start here)
  claude [OPTIONS] [-- CLAUDE ARGS]
  codex  [OPTIONS] [-- CODEX ARGS]
                               Freeze the control set, record the baseline at HEAD, then start the
                               agent with ProofLoop's hooks: protected files are blocked, fast checks
                               run after each edit, and every turn end is verified against the
                               baseline (the agent is sent back while anything fails). When the
                               agent exits, ProofLoop verifies outside the session: exit 0 ACCEPTED,
                               1 REJECTED. Options: --allow-dirty, --no-final-verify, --agent-bin BIN,
                               --trust-hooks (Codex: skip the one-time /hooks trust step)
  run --agent claude|codex [--rounds N] [OPTIONS] "TASK" [-- AGENT ARGS]
                               Headless loop: baseline → agent works on TASK → verify → findings go
                               back to the same agent session → … until ACCEPTED or N rounds (default
                               harness.maxStopRounds). Claude runs with --permission-mode acceptEdits
                               and Codex with --full-auto unless you pass your own.

Setup
  init                         Create .proofloop/ (config, contract, rules, probes)
  freeze [--by NAME] [--note TEXT] [--approve-weakening]
                               Freeze the control files (human only). Weakening needs approval.
  status                       Frozen version, baselines, recent runs

Observe
  inventory                    Known routes, generated probes and coverage
  snapshot [--ref REF] [--label L]
                               Record a snapshot (baseline when label starts with "baseline")
  noise [--ref REF]            Two runs on unchanged code: false alarms + proposed rules
  probe run ID [--ref REF]     Run one probe and print what it observes (reproduction)
  probes import-har FILE [--include-writes] [--prefix P]
                               Turn recorded traffic into probes (secrets removed)

Verify
  verify [--baseline SNAP] [--ref REF] [--json]
                               Diff + contract; exit 0 ACCEPTED, 1 REJECTED, 2 error
  report RUN [--json]          Print a stored report

Learn
  correct --what TEXT [--run RUN] [--where W] [--probe ID --path P --op OP [--value JSON]]
          [--rule TEXT] [--pattern TEXT] [--miss-reason no-probe|no-oracle|ignore-rule|out-of-scope]
  correct --lesson L --probe ID --path P --op OP [--value JSON]   Give a lesson its check
  correct --run RUN --false-alarm --finding D --reason TEXT [--by NAME]
  lessons [--rules]            List lessons, or the builder rules handed to agents
  lesson retire ID --by NAME --reason TEXT     (human only)
  lesson approve-pattern ID --by NAME           (human only)
  proposals                    Proposed comparison rules waiting for a human
  misses                       Accepted runs that later got more commits (was it a miss?)

Measure
  minutes add --minutes N --kind setup|false-alarm|review|correction|repair [--run RUN] [--note T]
  metrics                      Accepted/rejected counts, run time, human minutes

Harness (install the hooks permanently instead of launching through proofloop)
  hook claude|codex EVENT      Hook entry point (reads the event JSON on stdin)
  hooks print [--agent claude|codex] [--command CMD]
  hooks install [--agent claude|codex] [--settings FILE] [--command CMD]
                               Claude: merges into ~/.claude/settings.json (user level).
                               Codex: writes <repo>/.codex/hooks.json; trust it once with /hooks.

Global: --repo DIR (default: current Git repository)
`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseValue(v: string | undefined): Json | undefined {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(v) as Json;
  } catch {
    return v;
  }
}

const log = (m: string) => process.stderr.write(m + '\n');

/** `proofloop claude|codex|run …`: ProofLoop's own options, then `--` and the agent's. */
async function launcher(cmd: string, argv: string[]): Promise<number> {
  const cut = argv.indexOf('--');
  const own = cut >= 0 ? argv.slice(0, cut) : argv;
  const agentArgs = cut >= 0 ? argv.slice(cut + 1) : [];
  const { values: o, positionals: pos } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      agent: { type: 'string' },
      'agent-bin': { type: 'string' },
      'allow-dirty': { type: 'boolean' },
      'no-final-verify': { type: 'boolean' },
      'trust-hooks': { type: 'boolean' },
      rounds: { type: 'string' },
      task: { type: 'string' },
    },
  });
  const agent = (cmd === 'run' ? (o.agent ?? 'claude') : cmd) as Agent;
  if (!AGENTS.includes(agent)) throw new UserError(`Unknown agent "${agent}". Use claude or codex.`);
  const root = repoRoot(o.repo ?? process.cwd());
  const store = new Store(root);
  try {
    const base = { agent, agentArgs, agentBin: o['agent-bin'], allowDirty: o['allow-dirty'], finalVerify: !o['no-final-verify'], trustHooks: o['trust-hooks'], log };
    if (cmd !== 'run') return await launchInteractive(store, root, base);
    const task = o.task ?? pos.join(' ');
    if (!task.trim()) throw new UserError('Usage: proofloop run --agent claude|codex [--rounds N] "TASK" [-- AGENT ARGS]');
    const frozenRounds = loadFrozen(store)?.set.config.harness?.maxStopRounds;
    const rounds = Number(o.rounds ?? frozenRounds ?? 3);
    if (!Number.isInteger(rounds) || rounds < 1) throw new UserError('--rounds must be a positive integer');
    const r = await runLoop(store, root, { ...base, task, rounds });
    log(`\nProofLoop: ${r.decision} after ${r.rounds} round(s)${r.reason ? ` — ${r.reason}` : ''}.${r.sessionId ? ` Agent session: ${r.sessionId}` : ''}`);
    if (r.runs.length) log(`Last report: ${store.path('runs', r.runs[r.runs.length - 1], 'report.md')}`);
    return r.decision === 'ACCEPTED' ? 0 : r.decision === 'BLOCKED' ? 2 : 1;
  } finally {
    store.close();
  }
}

async function main(argv: string[]): Promise<number> {
  if (['claude', 'codex', 'run'].includes(argv[0] ?? '') && !argv.includes('--help') && !argv.includes('-h')) return launcher(argv[0], argv.slice(1));
  const { values: o, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      ref: { type: 'string' },
      label: { type: 'string' },
      baseline: { type: 'string' },
      json: { type: 'boolean' },
      by: { type: 'string' },
      note: { type: 'string' },
      'approve-weakening': { type: 'boolean' },
      run: { type: 'string' },
      what: { type: 'string' },
      where: { type: 'string' },
      probe: { type: 'string' },
      path: { type: 'string' },
      op: { type: 'string' },
      value: { type: 'string' },
      rule: { type: 'string' },
      pattern: { type: 'string' },
      'miss-reason': { type: 'string' },
      'false-alarm': { type: 'boolean' },
      finding: { type: 'string' },
      reason: { type: 'string' },
      lesson: { type: 'string' },
      rules: { type: 'boolean' },
      minutes: { type: 'string' },
      kind: { type: 'string' },
      settings: { type: 'string' },
      command: { type: 'string' },
      'include-writes': { type: 'boolean' },
      prefix: { type: 'string' },
      lock: { type: 'string' },
      agent: { type: 'string' },
      launched: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = pos[0];
  if (!cmd || o.help || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  if (cmd === 'hook') {
    const agent = pos[1] as Agent;
    if (!AGENTS.includes(agent)) throw new UserError('Usage: proofloop hook claude|codex <Event>');
    await runHook(agent, pos[2] ?? '', await readStdin(), { launched: o.launched });
    return 0;
  }
  if (cmd === 'hooks') {
    const agent = (o.agent ?? 'claude') as Agent;
    if (!AGENTS.includes(agent)) throw new UserError('--agent must be claude or codex');
    const onPath = (await exec('command -v proofloop', { cwd: process.cwd(), timeoutMs: 5000 })).code === 0;
    const command = o.command ?? (pos[1] === 'install' && !onPath ? selfCommand() : 'proofloop');
    if (pos[1] === 'print' || !pos[1]) {
      process.stdout.write(JSON.stringify(hookSettings(agent, command), null, 2) + '\n');
      return 0;
    }
    if (pos[1] === 'install') {
      if (agent === 'claude') {
        const file = o.settings ?? join(homedir(), '.claude', 'settings.json');
        const r = installClaudeHooks(file, command);
        log(`Hooks merged into ${r.file}${r.backup ? ` (backup: ${r.backup})` : ''}. They act only in repositories with ${CONTROL_DIR}/config.json.`);
      } else {
        const file = o.settings ?? codexHooksFile(repoRoot(o.repo ?? process.cwd()));
        const r = installCodexHooks(file, command);
        log(`Codex hooks written to ${r.file}${r.backup ? ` (backup: ${r.backup})` : ''}. Open Codex in this repository and trust them once with /hooks.`);
      }
      return 0;
    }
    throw new UserError('Usage: proofloop hooks print|install [--agent claude|codex]');
  }

  const root = repoRoot(o.repo ?? process.cwd());

  if (cmd === 'init') {
    const dir = join(root, CONTROL_DIR);
    if (existsSync(join(dir, 'config.json'))) throw new UserError(`${CONTROL_DIR}/config.json already exists`);
    let start = 'npm start';
    try {
      const pkg = readJson<{ scripts?: Record<string, string> }>(join(root, 'package.json'));
      if (pkg.scripts?.dev && !pkg.scripts?.start) start = 'npm run dev';
    } catch {
      /* no package.json */
    }
    const config: Config = {
      version: 1,
      project: root.split('/').pop() ?? 'app',
      app: { setup: 'npm ci', reset: undefined, start, baseUrl: 'http://127.0.0.1:3000', healthPath: '/', startTimeoutMs: 60000, env: {}, passEnv: [], clock: { mode: 'frozen' }, timezone: 'UTC', locale: 'en_US.UTF-8' },
      fixtures: { files: [] },
      roles: {},
      params: {},
      inventory: { sources: ['.'], pagesDirs: [] },
      tests: { command: 'npm test -- --test-reporter=tap', format: 'tap' },
      browser: { enabled: true, viewport: { width: 1280, height: 800 }, visualThreshold: 0.001 },
      flakeReruns: 2,
      fastChecks: [{ name: 'typecheck', command: 'npx tsc --noEmit', timeoutMs: 120000 }],
      protectedPaths: [],
      harness: { maxStopRounds: 3 },
      limits: { falseAlarmsPerCleanRun: 0, setupMinutes: 30, runMinutes: 10 },
      connections: [],
    };
    const contract: Contract = { version: 1, objective: '', requirements: [], invariants: [], claims: [], unknowns: [] };
    writeJson(join(dir, 'config.json'), config);
    writeJson(join(dir, 'contract.json'), contract);
    writeJson(join(dir, 'rules.json'), [] as Rule[]);
    mkdirSync(join(dir, 'probes'), { recursive: true });
    writeJson(join(dir, 'probes', 'critical.json'), []);
    log(`Created ${CONTROL_DIR}/. Edit config.json (start command, baseUrl, test data), then run \`proofloop freeze --by "<you>"\`.`);
    return 0;
  }

  const store = new Store(root);
  try {
    switch (cmd) {
      case 'freeze': {
        const r = freeze(store, root, { by: o.by ?? process.env.USER ?? 'human', note: o.note, approveWeakening: o['approve-weakening'] });
        for (const w of r.warnings) log(`warning: ${w}`);
        if (!r.changed) log(`No change; frozen version stays v${r.version}.`);
        else {
          log(`Frozen control v${r.version}.`);
          for (const w of r.weakening) log(`  weakening approved: ${w}`);
          for (const c of r.newClaims) log(`  change claim approved: ${c}`);
        }
        return 0;
      }
      case 'status': {
        const v = latestVersion(store);
        process.stdout.write(`store: ${store.dir}\ncontrol: v${v}\n`);
        const base = latestBaseline(store);
        process.stdout.write(`latest baseline: ${base ? `${base.id} at ${base.commit.slice(0, 10)}` : 'none'}\n`);
        if (v) {
          const { repoDiffers } = controlForRun(store, root);
          if (repoDiffers) process.stdout.write(`warning: ${CONTROL_DIR}/ differs from frozen v${v}; run \`proofloop freeze\` to use it\n`);
        }
        for (const r of store.runs().slice(0, 10)) process.stdout.write(`${r.started}  ${r.kind.padEnd(8)} ${r.status.padEnd(9)} ${r.id}  ${(r.commit_sha ?? '').slice(0, 10)} ${r.label ?? ''}\n`);
        return 0;
      }
      case 'inventory': {
        const repo = readRepoControl(root);
        const { generated, report } = buildInventory(repo.config, root, [...repo.probes, ...(loadFrozen(store)?.set.probes.filter((p) => p.source === 'lesson') ?? [])]);
        if (o.json) process.stdout.write(JSON.stringify({ generated, report }, null, 2) + '\n');
        else {
          process.stdout.write(`${report.routes.length} known routes, ${report.probed.length} probed, ${report.unprobed.length} not probed\n\n`);
          for (const p of report.probed) process.stdout.write(`  probed   ${p.route.method.padEnd(6)} ${p.route.path}  ← ${p.probes.join(', ')}\n`);
          for (const u of report.unprobed) process.stdout.write(`  MISSING  ${u.route.method.padEnd(6)} ${u.route.path}  (${u.reason}) ${u.route.file}${u.route.line ? ':' + u.route.line : ''}\n`);
        }
        return 0;
      }
      case 'snapshot': {
        const control = controlForRun(store, root);
        try {
          const m = await takeSnapshot(store, root, control, { ref: o.ref, label: o.label ?? 'baseline', log });
          if (m.status === 'blocked') {
            log(`BLOCKED: ${m.blockedReason}${m.appLogHash ? `\napp log: ${store.evidencePath(m.appLogHash)}` : ''}`);
            process.stdout.write(m.id + '\n');
            return 2;
          }
          const failed = m.observations.filter((x) => !x.ok).length;
          log(`snapshot ${m.id}: ${m.observations.length} probes (${failed} failed${failed ? ', labelled PREEXISTING if they also fail later' : ''}), commit ${m.commit.slice(0, 10)}`);
          process.stdout.write(m.id + '\n');
          return 0;
        } finally {
          if (o.lock) rmSync(o.lock, { force: true });
        }
      }
      case 'noise': {
        const control = controlForRun(store, root);
        const ref = o.ref ?? 'HEAD';
        let a, b;
        if (pos[1] && pos[2]) {
          a = loadManifest(store, pos[1]);
          b = loadManifest(store, pos[2]);
        } else {
          log(`run 1 of 2 on ${ref}`);
          a = await takeSnapshot(store, root, control, { ref, label: 'noise-a', log });
          log(`run 2 of 2 on ${ref}`);
          b = await takeSnapshot(store, root, control, { ref, label: 'noise-b', log, probes: a.probes });
        }
        if (a.status === 'blocked' || b.status === 'blocked') throw new UserError(`noise run blocked: ${a.blockedReason ?? b.blockedReason}`);
        const r = noiseReport(store, control.set, a, b);
        process.stdout.write(o.json ? JSON.stringify(r, null, 2) + '\n' : renderNoise(r));
        return r.withinLimit ? 0 : 1;
      }
      case 'probe': {
        if (pos[1] !== 'run' || !pos[2]) throw new UserError('Usage: proofloop probe run <id> [--ref REF]');
        const control = controlForRun(store, root);
        const base = latestBaseline(store);
        const all = [...control.set.probes, ...(base?.probes ?? [])];
        const probe = all.find((p) => p.id === pos[2]);
        if (!probe) throw new UserError(`Unknown probe ${pos[2]}`);
        const cap = await Capture.open(store, root, control, { ref: o.ref, label: `probe ${probe.id}`, probes: [probe], log });
        if (cap.blocked) {
          await cap.finish();
          throw new UserError(`blocked: ${cap.manifest.blockedReason}`);
        }
        const obs = await cap.observeOne(probe);
        await cap.finish();
        process.stdout.write(JSON.stringify(obs, null, 2) + '\n');
        return obs?.ok ? 0 : 1;
      }
      case 'probes': {
        if (pos[1] !== 'import-har' || !pos[2]) throw new UserError('Usage: proofloop probes import-har <file.har>');
        const repo = readRepoControl(root);
        const { probes, skipped } = harToProbes(pos[2], repo.config, { includeWrites: o['include-writes'], prefix: o.prefix });
        const file = join(root, CONTROL_DIR, 'probes', 'recorded.json');
        const existing = existsSync(file) ? readJson<{ id: string }[]>(file) : [];
        const merged = [...existing, ...probes.filter((p) => !existing.some((e) => e.id === p.id))];
        writeJson(file, merged);
        log(`${probes.length} probes from recorded traffic → ${CONTROL_DIR}/probes/recorded.json (${merged.length - existing.length} new). Review, then \`proofloop freeze\`.`);
        for (const s of skipped) log(`  skipped ${s}`);
        return 0;
      }
      case 'verify': {
        const report = await verify(store, root, { baseline: o.baseline, ref: o.ref, log, label: o.label });
        const md = store.path('runs', report.runId, 'report.md');
        process.stdout.write(o.json ? JSON.stringify(report, null, 2) + '\n' : renderMarkdown(report));
        log(`\n${report.decision} — report: ${md}`);
        return report.decision === 'ACCEPTED' ? 0 : 1;
      }
      case 'report': {
        if (!pos[1]) throw new UserError('Usage: proofloop report <run-id>');
        const r = loadReport(store, pos[1]);
        process.stdout.write(o.json ? JSON.stringify(r, null, 2) + '\n' : renderMarkdown(r));
        return 0;
      }
      case 'correct': {
        if (o['false-alarm']) {
          if (!o.run || !o.finding || !o.reason) throw new UserError('Usage: proofloop correct --run RUN --false-alarm --finding D --reason TEXT');
          const r = proposeFalseAlarmRule(store, o.run, o.finding, o.reason, o.by ?? process.env.USER ?? 'human');
          log(`Logged as false alarm. Proposed rule ${r.proposalId} (NOT applied):\n${JSON.stringify(r.rule, null, 2)}\nA human applies it by adding it to ${CONTROL_DIR}/rules.json and running \`proofloop freeze --approve-weakening\`.`);
          return 0;
        }
        if (o.lesson) {
          if (!o.probe || !o.path || !o.op) throw new UserError('Usage: proofloop correct --lesson L --probe ID --path P --op OP [--value V]');
          const l = attachCheck(store, o.lesson, { probe: o.probe, path: o.path, op: o.op as Op, value: parseValue(o.value) });
          log(`Lesson ${l.id} now has a permanent check; it runs on every later verify.`);
          return 0;
        }
        if (!o.what) throw new UserError('Usage: proofloop correct --what "what was wrong" [--run RUN] [--probe ID --path P --op OP --value V]');
        const l = recordLesson(store, {
          runId: o.run,
          what: o.what,
          where: o.where,
          missReason: o['miss-reason'] as MissReason | undefined,
          probe: o.probe,
          path: o.path,
          op: o.op as Op | undefined,
          value: parseValue(o.value),
          rule: o.rule,
          pattern: o.pattern,
        });
        log(`Lesson ${l.id} recorded${l.check ? ' with a permanent check' : ' as a builder rule and review item (no executable check yet)'}${l.pattern ? '; general pattern proposed, needs human approval' : ''}.`);
        return 0;
      }
      case 'lessons': {
        const f = loadFrozen(store);
        if (!f) throw new UserError('Nothing frozen yet.');
        if (o.rules) process.stdout.write(builderRules(f.set) + '\n');
        else
          for (const l of f.set.lessons)
            process.stdout.write(`${l.id} v${l.version} [${l.status}] ${l.what}${l.check ? `  check: ${l.check.probe} ${l.check.path} ${l.check.op} ${JSON.stringify(l.check.value ?? null)}` : ''}${l.pattern ? `  pattern(${l.pattern.status}): ${l.pattern.text}` : ''}\n`);
        return 0;
      }
      case 'lesson': {
        if (!o.by) throw new UserError('--by NAME is required: only a human may retire a lesson or approve a pattern');
        if (pos[1] === 'retire' && pos[2]) {
          if (!o.reason) throw new UserError('--reason is required');
          retireLesson(store, pos[2], o.by, o.reason);
          log(`Lesson ${pos[2]} retired by ${o.by}.`);
          return 0;
        }
        if (pos[1] === 'approve-pattern' && pos[2]) {
          approvePattern(store, pos[2], o.by);
          log(`Pattern of ${pos[2]} approved by ${o.by}.`);
          return 0;
        }
        throw new UserError('Usage: proofloop lesson retire|approve-pattern ID --by NAME');
      }
      case 'proposals': {
        for (const p of listProposals(store)) process.stdout.write(`${p.id} [${p.status}] ${p.kind} ${JSON.stringify(p.data)}\n`);
        return 0;
      }
      case 'misses': {
        const xs = fixesAfterAccepted(store, root);
        if (!xs.length) log('No accepted run has later commits.');
        for (const x of xs)
          process.stdout.write(`${x.runId} accepted ${x.commit.slice(0, 10)}; ${x.later} later commit(s). Was one of them fixing something ProofLoop missed? If so: proofloop correct --run ${x.runId} --what "..." \n`);
        return 0;
      }
      case 'minutes': {
        if (pos[1] !== 'add' || !o.minutes || !o.kind) throw new UserError('Usage: proofloop minutes add --minutes N --kind setup|false-alarm|review|correction|repair [--run RUN]');
        store.db.prepare('INSERT INTO minutes (ts, run_id, kind, minutes, note) VALUES (?, ?, ?, ?, ?)').run(new Date().toISOString(), o.run ?? null, o.kind, Number(o.minutes), o.note ?? null);
        log('Recorded.');
        return 0;
      }
      case 'metrics': {
        const runs = store.runs('verify');
        const count = (s: string) => runs.filter((r) => r.status === s).length;
        const mins = store.db.prepare('SELECT kind, SUM(minutes) AS m FROM minutes GROUP BY kind').all() as { kind: string; m: number }[];
        const durations = runs.filter((r) => r.duration_ms).map((r) => r.duration_ms!);
        const unintended = runs.reduce((s, r) => s + ((r.data && (JSON.parse(r.data) as { unintended?: number }).unintended) || 0), 0);
        const falseAlarms = (store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'false-alarm'").get() as { n: number }).n;
        const lessons = loadFrozen(store)?.set.lessons ?? [];
        const out = {
          verifyRuns: runs.length,
          accepted: count('ACCEPTED'),
          rejected: count('REJECTED'),
          medianRunSeconds: durations.length ? Math.round(durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)] / 1000) : null,
          unintendedFindings: unintended,
          findingsMarkedFalseAlarm: falseAlarms,
          humanMinutes: Object.fromEntries(mins.map((x) => [x.kind, x.m])),
          humanMinutesPerAcceptedChange: count('ACCEPTED') && mins.length ? mins.reduce((s, x) => s + x.m, 0) / count('ACCEPTED') : null,
          lessons: { total: lessons.length, withCheck: lessons.filter((l) => l.check).length, retired: lessons.filter((l) => l.status === 'retired').length },
        };
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        return 0;
      }
      case 'validate': {
        const v = validateControl(readRepoControl(root));
        for (const e of v.errors) log(`error: ${e}`);
        for (const w of v.warnings) log(`warning: ${w}`);
        return v.errors.length ? 1 : 0;
      }
      default:
        throw new UserError(`Unknown command ${cmd}. Run \`proofloop help\`.`);
    }
  } finally {
    store.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof UserError) log(`proofloop: ${e.message}`);
    else log(`proofloop: internal error: ${(e as Error).stack ?? e}`);
    process.exit(2);
  },
);

