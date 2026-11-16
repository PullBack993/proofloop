// Core types shared across ProofLoop.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// ---------- Configuration (control plane, frozen) ----------

export interface AppConfig {
  /** Working directory of the app, relative to the repository root. */
  cwd?: string;
  /** One-time setup in a fresh workspace, e.g. "npm ci". */
  setup?: string;
  /** Resets the test-only database / fixtures before the app starts. */
  reset?: string;
  /** Starts the app. Must not exit while the app runs. */
  start: string;
  baseUrl: string;
  healthPath?: string;
  startTimeoutMs?: number;
  /** Extra env for the app. Values may reference ${env:NAME} only for names listed in passEnv. */
  env?: Record<string, string>;
  /** Host environment variables the app may see (scoped secrets). Nothing else is passed. */
  passEnv?: string[];
  clock?: { mode: 'frozen' | 'real'; time?: string };
  timezone?: string;
  locale?: string;
}

export interface BrowserConfig {
  enabled?: boolean;
  viewport?: { width: number; height: number };
  executablePath?: string;
  channel?: string;
  /** Share of differing pixels above which a screenshot counts as changed (0..1). */
  visualThreshold?: number;
}

export interface Connection {
  name: string;
  /** Highest level at which this connection is checked. */
  level: 'mock' | 'replay' | 'schema' | 'live' | 'none';
  note?: string;
}

export interface Config {
  version: 1;
  project: string;
  app: AppConfig;
  fixtures?: { files?: string[] };
  roles?: Record<string, { headers?: Record<string, string> }>;
  defaultRole?: string;
  /** Fixture values for route parameters, used by generated probes. */
  params?: Record<string, string>;
  inventory?: { sources?: string[]; openapi?: string; pagesDirs?: string[]; exclude?: string[]; generate?: boolean };
  tests?: { command: string; format: 'tap' | 'exit-code'; timeoutMs?: number };
  browser?: BrowserConfig;
  flakeReruns?: number;
  fastChecks?: { name: string; command: string; timeoutMs?: number }[];
  protectedPaths?: string[];
  harness?: { maxStopRounds?: number; stopTimeoutMs?: number };
  limits?: { falseAlarmsPerCleanRun?: number; setupMinutes?: number; runMinutes?: number };
  connections?: Connection[];
}

// ---------- Probes ----------

export type ProbeSource = 'generated' | 'recorded' | 'hand' | 'lesson';

export interface ProbeBase {
  id: string;
  kind: 'api' | 'browser' | 'db';
  source?: ProbeSource;
  role?: string;
  fixture?: string;
  /** What this probe does not cover (stated coverage limit). */
  coverageLimit?: string;
  /** Route this probe exercises, for coverage. */
  route?: { method: string; path: string };
  /** True when the probe writes state; such probes run after read-only ones and are never re-run. */
  mutates?: boolean;
  area?: string[];
}

export interface ApiProbe extends ProbeBase {
  kind: 'api';
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Json;
}

export interface BrowserStep {
  goto?: string;
  click?: string;
  fill?: { selector: string; value: string };
  press?: { selector: string; key: string };
  waitFor?: string;
}

export interface BrowserProbe extends ProbeBase {
  kind: 'browser';
  path: string;
  steps?: BrowserStep[];
  capture?: { selector?: string; screenshot?: boolean };
}

export interface DbProbe extends ProbeBase {
  kind: 'db';
  /** SQLite file relative to the app directory. */
  sqlite: string;
  query: string;
}

export type Probe = ApiProbe | BrowserProbe | DbProbe;

export interface Observation {
  probeId: string;
  ok: boolean;
  error?: string;
  value: Json;
  /** name -> evidence hash */
  evidence: Record<string, string>;
  durationMs: number;
}

export interface TestResult {
  name: string;
  ok: boolean;
}

export interface TestRun {
  command: string;
  exitCode: number | null;
  results: TestResult[];
  logHash?: string;
  error?: string;
}

// ---------- Snapshot ----------

export interface EnvFingerprint {
  node: string;
  platform: string;
  arch: string;
  browser?: string;
  timezone: string;
  locale: string;
  clock: string;
  fixturesHash?: string;
  lockfileHash?: string;
}

export interface Manifest {
  id: string;
  label: string;
  createdAt: string;
  repoRoot: string;
  commit: string;
  ref?: string;
  dirty: boolean;
  /** Hash of uncommitted changes when the workspace was the working tree. */
  worktreeDiffHash?: string;
  workspace: 'worktree' | 'working-tree';
  controlVersion: number;
  env: EnvFingerprint;
  status: 'complete' | 'blocked';
  blockedReason?: string;
  probes: Probe[];
  observations: Observation[];
  tests?: TestRun;
  appLogHash?: string;
  inventory?: InventoryReport;
}

// ---------- Inventory & coverage ----------

export interface RouteEntry {
  method: string;
  path: string;
  kind: 'api' | 'page';
  file: string;
  line?: number;
}

export interface InventoryReport {
  routes: RouteEntry[];
  probed: { route: RouteEntry; probes: string[] }[];
  unprobed: { route: RouteEntry; reason: string }[];
}

// ---------- Rules ----------

interface RuleBase {
  id: string;
  version: number;
  owner: string;
  reason: string;
  /** Probe id glob. */
  probe: string;
}

export type Rule =
  | (RuleBase & { kind: 'ignore-path'; path: string })
  | (RuleBase & { kind: 'mask'; path: string; pattern: string; replacement?: string })
  | (RuleBase & { kind: 'unordered'; path: string; key?: string })
  | (RuleBase & { kind: 'round'; path: string; digits: number })
  | (RuleBase & { kind: 'ignore-region'; x: number; y: number; width: number; height: number });

// ---------- Contract ----------

export const ORACLE_STRENGTH = [
  'business-rule',
  'stated-requirement',
  'existing-contract',
  'domain-invariant',
  'external-spec',
  'prior-behaviour',
  'reviewed-generated',
] as const;
export type OracleKind = (typeof ORACLE_STRENGTH)[number];

export type Op =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'exists' | 'absent' | 'matches' | 'includes' | 'unique' | 'nonEmpty' | 'count';

export type Check =
  | { type: 'unchanged'; probe: string }
  | { type: 'assert'; probe: string; path: string; op: Op; value?: Json }
  | { type: 'test'; name: string }
  | { type: 'probe-ok'; probe: string };

export interface Requirement {
  id: string;
  text: string;
  mandatory?: boolean;
  oracle: { kind: string; source?: string };
  checks: Check[];
  area?: string[];
}

export interface Invariant {
  id: string;
  text: string;
  probe: string;
  path: string;
  op: Op;
  value?: Json;
  oracle?: { kind: string; source?: string };
}

export interface ChangeClaim {
  id: string;
  text: string;
  probe: string;
  path?: string;
  change?: 'added' | 'removed' | 'changed' | 'any';
  approved: boolean;
}

export interface Contract {
  version: 1;
  objective?: string;
  requirements: Requirement[];
  invariants?: Invariant[];
  claims?: ChangeClaim[];
  unknowns?: string[];
}

// ---------- Lessons ----------

export type MissReason = 'no-probe' | 'no-oracle' | 'ignore-rule' | 'out-of-scope' | 'unknown';

export interface Lesson {
  id: string;
  version: number;
  createdAt: string;
  what: string;
  where?: string;
  foundBy: 'human-told' | 'human-fix-after-accept' | 'escaped-bug' | 'prompt-correction';
  missReason: MissReason;
  runId?: string;
  /** Executable check; absent means the lesson is a builder rule and review item only. */
  check?: Omit<Invariant, 'id'>;
  builderRule: string;
  pattern?: { text: string; status: 'proposed' | 'approved' };
  status: 'active' | 'retired' | 'needs-check';
  retired?: { by: string; reason: string; at: string };
}

// ---------- Control set (frozen) ----------

export interface ControlSet {
  config: Config;
  contract: Contract;
  rules: Rule[];
  probes: Probe[];
  lessons: Lesson[];
}

// ---------- Diff & verify ----------

export type DiffClass = 'intended' | 'unintended' | 'environment-drift' | 'flaky' | 'unknown';

export interface Difference {
  id: string;
  probeId: string;
  path: string;
  change: 'added' | 'removed' | 'changed';
  before?: Json;
  after?: Json;
  class: DiffClass;
  claimId?: string;
  note?: string;
  evidence?: Record<string, string>;
}

export type ReqStatus = 'VERIFIED' | 'FAILED' | 'BLOCKED' | 'UNKNOWN';

export interface CheckOutcome {
  check: string;
  status: ReqStatus;
  detail: string;
  preexisting?: boolean;
}

export interface RequirementResult {
  id: string;
  text: string;
  mandatory: boolean;
  oracle: string;
  status: ReqStatus;
  outcomes: CheckOutcome[];
}
