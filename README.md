# ProofLoop

> Your agent says done. ProofLoop shows what changed that nobody asked for, with a reproduction for every finding.

ProofLoop is a local snapshot-and-verify harness for one TypeScript/Node web stack. It sits **in front of your coding agent** (Claude Code or Codex): it records how the app behaves before the agent starts (API responses, browser states, selected database facts, existing test results), starts the agent with guard hooks, sends it back with concrete findings whenever it says "done" while something changed that nobody asked for, and makes the final decision itself when the agent exits. The same engine also runs on its own (`proofloop verify`) for changes made by a person or any other tool.

```
proofloop claude            proofloop codex            proofloop run --agent claude|codex "TASK"
        │                          │                                │
        ▼                          ▼                                ▼
 freeze control set ── baseline at HEAD (before the agent may touch anything)
        │
        ▼
 agent works ── PreToolUse: contract, protected tests, hook settings blocked
        │       PostToolUse: fast checks after every edit
        ▼
 agent says done ── Stop: verify against the baseline ──REJECTED──► findings + reproductions
        │                                                            back to the same session
        ▼ ACCEPTED (or round cap)                                    (up to N rounds)
 agent exits ── final verify outside the session ── exit 0 ACCEPTED / 1 REJECTED
```

This repository implements **phase 1 (Experiment 001)** of *ProofLoop V2: Baseline-First Plan* in full, plus the parts of phase 2 that can be built before real pilot data exists. See [What is built](#what-is-built-against-the-plan).

## Quickstart

```bash
npm install
npm run build
npm link                       # puts `proofloop` on PATH
npx playwright install chromium   # only needed for browser probes
```

## Put it in front of your agent

In a repository with `.proofloop/config.json` (see below), start your agent through ProofLoop instead of directly:

```bash
proofloop claude                         # interactive Claude Code session, gated
proofloop codex                          # interactive Codex session, gated
proofloop claude -- --model opus         # everything after -- goes to the agent CLI
```

Headless, for a task you hand off and come back to:

```bash
proofloop run --agent claude "Add pagination to GET /api/loads"
proofloop run --agent codex --rounds 5 "Add pagination to GET /api/loads"
```

What happens:

1. **Before the agent starts**: the control files are frozen (outside the repo), the working tree must be clean (`--allow-dirty` to override), and a baseline is recorded at `HEAD` in an isolated worktree. If the app cannot start cleanly, the agent is not started.
2. **While it works**: hooks deny edits to `.proofloop/`, protected tests, `.claude/settings*`, `.codex/` and the store, deny human-only commands (`freeze`, `retire`, `approve`…), and run the configured fast checks after every edit.
3. **When it says done**: ProofLoop re-runs every probe against the baseline. If anything changed that no approved claim covers, or a requirement is not `VERIFIED`, the agent is sent back with the findings and a reproduction for each, up to `harness.maxStopRounds` (or `--rounds`).
4. **When it exits**: ProofLoop verifies once more outside the session. That verdict is the exit code (0 ACCEPTED, 1 REJECTED, 2 blocked or error).

How the hooks get in:

- **Claude Code**: injected for that session only with `claude --settings`; nothing is installed. If you also installed the hooks globally, those copies step aside inside a launched session.
- **Codex**: Codex reads hooks from `<repo>/.codex/hooks.json`. The launcher writes it on first use. Codex runs new hooks only after you trust them once with `/hooks` (or pass `--trust-hooks`, which uses `--dangerously-bypass-hook-trust` for that run). If the hooks did not run, the launcher says so; the final verification still applies. Commit `.codex/hooks.json` or add it to `.gitignore`; it holds an absolute path to this ProofLoop build unless `proofloop` is on your PATH (`npm link`).
- **Headless (`run`)**: the loop itself verifies after each agent turn and resumes the same session with the findings (`claude -p --resume`, `codex exec resume`). Claude runs with `--permission-mode acceptEdits`, Codex with `--full-auto`, unless you pass your own after `--`. The frozen contract and lessons are appended to the task.

`npm run test:agent-loop` runs all of this end to end with stand-in `claude` and `codex` executables that make the seeded defect and fix it after the findings come back (27 checks).

## Smoke tests

Run the Experiment 001 smoke test (about 30 s, everything in a temp folder):

```bash
npm run experiment:001
```

Run the unit tests:

```bash
npm test
```

## Use it on a repository

```bash
cd your-app
proofloop init                      # writes .proofloop/config.json, contract.json, rules.json, probes/
# edit .proofloop/config.json: start command, baseUrl, reset (test-only DB), roles, params, tests
proofloop inventory                 # known routes, generated probes, what is not probed
proofloop freeze --by "Your Name"   # freeze the control files (human only)
proofloop noise                     # two runs on unchanged code: must be within the false-alarm limit
proofloop snapshot --ref main       # baseline, recorded in an isolated git worktree
# ... a person or an agent changes the code ...
proofloop verify                    # working tree vs baseline; exit 0 ACCEPTED, 1 REJECTED, 2 error
proofloop verify --ref feature-x    # or verify a commit/branch in its own worktree
```

A run is **ACCEPTED** only when every mandatory requirement is `VERIFIED` on the final commit. Every requirement ends as `VERIFIED`, `FAILED`, `BLOCKED` or `UNKNOWN`. Every difference is classed as `intended` (matches an approved change claim), `unintended`, `environment-drift`, `flaky` or `unknown`.

## Commands

| Command | What it does |
|---|---|
| `init` | Create `.proofloop/` with a starter config and empty contract |
| `freeze [--approve-weakening] --by NAME` | Copy the control files into the store outside the repo as a new version. Any weakening (removed requirement, new ignore rule, removed probe, removed protected path, retired lesson…) is refused unless a human passes `--approve-weakening` |
| `status` | Frozen version, latest baseline, recent runs, warning if the repo copy differs from the frozen one |
| `inventory` | Routes from router files, OpenAPI and file-based pages; generated probes; coverage gaps with reasons |
| `snapshot [--ref REF] [--label L]` | Record a snapshot. With `--ref` it runs in a fresh git worktree |
| `noise [--ref REF]` | Two unchanged runs; false-alarm count against the phase-0 limit; proposed typed rules (never applied) |
| `verify [--ref REF] [--baseline SNAP] [--json]` | Diff + contract + decision + report |
| `report RUN` | Print a stored report |
| `probe run ID [--ref REF]` | Run one probe and print what it observes (the reproduction step) |
| `probes import-har FILE` | Turn recorded traffic (a HAR export) into probes, secrets removed |
| `correct …` | Record a lesson; with `--probe/--path/--op/--value` it becomes a permanent check. `--false-alarm` logs a proposed rule for a human |
| `lessons [--rules]`, `lesson retire`, `lesson approve-pattern` | Lesson store; retiring and approving patterns need `--by NAME` |
| `misses` | Accepted runs that later got more commits: was one of them a miss? |
| `minutes add`, `metrics` | Human minutes by kind, accepted/rejected counts, run time, lesson counts |
| `claude`, `codex` `[--allow-dirty] [--no-final-verify] [--trust-hooks] [-- AGENT ARGS]` | Start the agent behind ProofLoop: baseline first, hooks injected, final verify on exit |
| `run --agent claude\|codex [--rounds N] "TASK" [-- AGENT ARGS]` | Headless loop: task → verify → findings back to the same session → until ACCEPTED or N rounds |
| `hook claude\|codex EVENT`, `hooks print\|install [--agent claude\|codex]` | Hook entry point; install the hooks permanently instead of launching through ProofLoop |

## Control files and the store

Humans edit `.proofloop/` in the repository:

- `config.json` — how to start the app cleanly (`reset`, `start`, `baseUrl`, `healthPath`), test-only env (`env`, `passEnv` for scoped secrets), frozen clock/locale/time zone, roles, route params for generated probes (`params`, and `routeParams` per route), `inventory.roles` to generate every read probe once per role (`anonymous` = no credentials) so authorization changes show up, test command, browser settings, fast checks, protected paths, harness caps, phase-0 limits, external connections and how far each is checked.
- `contract.json` — `requirements` (each with an oracle and checks), `invariants`, change `claims`, declared `unknowns`.
- `rules.json` — typed, versioned comparison rules (`ignore-path`, `mask`, `unordered`, `round`, `ignore-region`), each with an `owner` and a `reason`.
- `probes/*.json` — hand-written critical journeys and recorded traffic.

Runs never read these directly. They use the **frozen** copy in `~/.proofloop/projects/<repo>/` (override with `PROOFLOOP_HOME`), together with snapshots, the SQLite event log, content-hashed evidence (redacted) and reports. Lessons live only in the store.

Oracles, strongest first: `business-rule`, `stated-requirement`, `existing-contract`, `domain-invariant`, `external-spec`, `prior-behaviour`, `reviewed-generated`. Anything else, including a model's or critic's judgement, makes the requirement `UNKNOWN`.

Check types: `assert` (JSONPath + `eq|ne|gt|gte|lt|lte|exists|absent|matches|includes|unique|nonEmpty|count`), `unchanged` (no unclaimed difference against the baseline), `test` (an existing test passes), `probe-ok`.

## The hooks

The launcher injects them for you. To have every session gated, also when you start the agent directly:

```bash
proofloop hooks install                 # Claude Code: merges into ~/.claude/settings.json (with a backup)
proofloop hooks install --agent codex   # Codex: writes <repo>/.codex/hooks.json; trust it once with /hooks
```

or load `plugins/claude-code` as a Claude Code plugin. The hooks only act in repositories that have `.proofloop/config.json`. Claude Code and Codex use the same hook protocol; Codex file edits arrive as `apply_patch`, whose target files are read from the patch.

| Event | What ProofLoop does |
|---|---|
| SessionStart | Loads the frozen contract and the project's lessons into the agent's context; records a baseline at HEAD in the background if none exists |
| UserPromptSubmit | Stores the objective; notices corrections ("this is wrong", "funktioniert nicht") and records them as lessons |
| PreToolUse | Denies edits to `.proofloop/`, protected tests, `.claude/settings*`, hook files and the store; denies human-only commands (`freeze`, `retire`, `approve`…) |
| PostToolUse | Runs the configured fast checks and hands failures straight back |
| Stop | Runs `verify` on the working tree; refuses the stop with the findings and reproductions, up to `harness.maxStopRounds`. A turn that changed nothing reuses the last verdict |

The hooks are not the acceptance authority: a crashed or timed-out hook does not block, and the Codex docs call hooks "a useful guardrail, not a complete enforcement boundary". Acceptance comes from the launcher's final verification (or a separate `proofloop verify`) outside the session. The Bash guard is a heuristic, which is why the frozen control set lives outside the repository.

## How the plan's principles map to the code

| Principle | Where |
|---|---|
| 1 The tool owns acceptance | Frozen control set outside the repo (`src/control.ts`); harness blocks edits (`src/hooks.ts`) |
| 2 Evidence, not claims | Manifest ties each snapshot to commit, uncommitted-diff hash, env fingerprint, fixtures and lock file (`src/snapshot.ts`); content-hashed evidence (`src/store.ts`) |
| 3 Unknown is a valid answer | Unrecognised oracle, unobserved probe, flaky or drifted differences → `UNKNOWN` (`src/contract.ts`) |
| 4 Baseline and specification are different oracles | Implicit `BASELINE` requirement plus contract requirements and invariants, evaluated separately |
| 5 The strongest oracle wins | `ORACLE_STRENGTH`; model/critic oracles never pass; oracle downgrades count as weakening |
| 6 Every difference must be claimed | Unclaimed difference = `unintended` = `BASELINE` fails; approved claims still go through every other check |
| 7 No silent suppression | Rules need owner, reason, version; new rules are weakening; noise only proposes rules |
| 8 Report only what was observed | "Not verified" section: unprobed routes with reasons, unchecked connections, unknowns, probe errors |
| 9 Real connections over mocks | `connections` in config, reported as "not verified live" when only mocked (replay/schema checks are phase 4) |
| 10 The agent cannot change the rules | PreToolUse guard; freeze is human-only; the store is outside the repo |
| 11 Every correction becomes a check | `correct` + lesson store; lesson checks run on every verify as `stated-requirement` |
| 12 Checks only grow on their own | `growControl` throws if a tool-initiated change would weaken anything; retiring needs `--by` |
| 13 A critic's opinion is never evidence | No critic can set a status; only executed checks decide |

## What is built against the plan

| Phase | Status here |
|---|---|
| 0 Measure (days 1–3) | Needs your bugs. Template: [docs/phase-0-bug-log.md](docs/phase-0-bug-log.md). Limits live in `config.limits` |
| 1 Observe (days 4–10) | **Built.** Snapshot CLI and manifest, API + browser (aria snapshot + screenshot) + DB + test capture, isolated worktrees, frozen clock, scoped env, noise report, semantic API diff, line diff, visual diff, typed rules, classification, report with reproductions. Experiment 001 smoke test passes all four criteria |
| 2 Widen (weeks 3–4) | **Partly built.** Generated probes from routes/OpenAPI/pages, HAR import for recorded traffic, coverage in every report, DB facts, correction command and lesson store, Claude Code hook harness v0. Not built: more workflows and the 30–50 bug set (needs real repos) |
| 3 Verify (weeks 5–6) | Not built: impact map, contract critic, mutation testing. Already present: change claims, fixed smoke set via hand probes, negative-authorization probes |
| 4 Connect (week 7) | Not built: traffic replay against real systems, schema checks. Connections are listed as not verified live |
| 5 Repair (weeks 8–9) | **Partly built.** The launcher puts ProofLoop in front of Claude Code and Codex (`proofloop claude|codex`), and `proofloop run` repairs in a loop with a round cap, resuming the same agent session with the findings. Codex adapter built from the Codex hooks reference; tested with stand-in CLIs only, since Codex was not installed here. Not built: repair strategies beyond "send the findings back" |
| 6 Harden (week 10) | Partly: secret redaction, crash-safe event log, setup failures end as `BLOCKED`. Not built: containers, crash resume, setup diagnostics |
| 7 Validate (weeks 11–12) | Needs pilots. `minutes` and `metrics` record the primary measures |

## Lessons from the first real pilot

ProofLoop was run blind on a private Express + MongoDB API: 6 historical bugs picked and sealed by a separate agent, 7 clean commits, configuration frozen before the bug list was opened. It caught 1 of the 6 bugs (with a working reproduction), and 7 of 7 clean commits passed with 0 false alarms on the final configuration. Every miss was a coverage gap, not a wrong verdict: no probe or fixture data reached the broken state (a write route, query parameters, a draft record, a list over 100 items, a fixture built at today's schema). What that changed in ProofLoop:

- Vitest's TAP output puts timings in test names; they are now stripped (they made every clean commit fail).
- `noise` now counts tests that appear or disappear, as `verify` does.
- A run where most probes get the same error (e.g. every request refused) is UNKNOWN, never "no difference".
- A test run that hangs or prints nothing is retried once, then reported as UNKNOWN instead of failing every test.
- Narrowing the test command, dropping a probe role or route parameters now counts as weakening.
- Large mixed commits produce long reports: without change claims, every intended change is unintended too. Small commits and claims matter.

## Known limits

- Only JavaScript/TypeScript apps that start with one command. The frozen clock shim works for Node apps (`NODE_OPTIONS=--import`); other runtimes need `clock.mode: "real"` and typed rules for timestamps.
- Write probes run once, after read probes, in declared order; they are not re-run for flakiness. Probes are single requests: a journey cannot carry an id from one step to the next yet.
- Database probes support SQLite only; MongoDB and Postgres facts are observed through the API.
- Generated probes send no query parameters; filters and search are only covered by hand-written or recorded (HAR) probes.
- Fixtures should come from data that every compared commit understands; a fixture written at today's schema can hide field-level regressions in older commits.
- Route discovery is pattern-based (Express/Fastify/Hono/Koa style, route tables, OpenAPI, Next/Nuxt pages). Dynamic routes it cannot see show up as missing coverage, not as passed.
- Seeded defects (like the one in Experiment 001) only smoke-test the tool. The gate is held-out historical bugs: see [docs/experiment-001.md](docs/experiment-001.md).
- Node's `node:sqlite` is used for storage; Node ≥ 22.13 is required.
