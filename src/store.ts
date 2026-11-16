// Control-plane storage. Lives outside the repository (default ~/.proofloop) so the
// builder cannot reach it through the files it edits.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { sha256 } from './util.js';

export function proofloopHome(): string {
  return process.env.PROOFLOOP_HOME ?? join(homedir(), '.proofloop');
}

export class Store {
  readonly dir: string;
  readonly db: DatabaseSync;

  constructor(readonly repoRoot: string) {
    const slug = basename(repoRoot).replace(/[^\w.-]/g, '_');
    this.dir = join(proofloopHome(), 'projects', `${slug}-${sha256(repoRoot).slice(0, 10)}`);
    mkdirSync(this.dir, { recursive: true });
    this.db = new DatabaseSync(join(this.dir, 'state.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
        commit_sha TEXT, label TEXT, started TEXT NOT NULL, finished TEXT,
        duration_ms INTEGER, data TEXT);
      CREATE TABLE IF NOT EXISTS control_versions (
        version INTEGER PRIMARY KEY, created TEXT NOT NULL, by TEXT NOT NULL,
        note TEXT, hash TEXT NOT NULL, weakening TEXT);
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, created TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS minutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, run_id TEXT,
        kind TEXT NOT NULL, minutes REAL NOT NULL, note TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, started TEXT NOT NULL, objective TEXT,
        stop_rounds INTEGER NOT NULL DEFAULT 0, data TEXT);
    `);
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  event(kind: string, data: unknown, runId?: string): void {
    this.db
      .prepare('INSERT INTO events (ts, run_id, kind, data) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString(), runId ?? null, kind, JSON.stringify(data));
  }

  events(runId: string): { ts: string; kind: string; data: unknown }[] {
    return (this.db.prepare('SELECT ts, kind, data FROM events WHERE run_id = ? ORDER BY id').all(runId) as {
      ts: string;
      kind: string;
      data: string;
    }[]).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  startRun(id: string, kind: string, commit: string, label?: string): void {
    this.db
      .prepare('INSERT INTO runs (id, kind, status, commit_sha, label, started) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, kind, 'running', commit, label ?? null, new Date().toISOString());
    this.event('run.start', { kind, commit, label }, id);
  }

  finishRun(id: string, status: string, data: unknown): void {
    const row = this.db.prepare('SELECT started FROM runs WHERE id = ?').get(id) as { started: string } | undefined;
    const duration = row ? Date.now() - Date.parse(row.started) : null;
    this.db
      .prepare('UPDATE runs SET status = ?, finished = ?, duration_ms = ?, data = ? WHERE id = ?')
      .run(status, new Date().toISOString(), duration, JSON.stringify(data), id);
    this.event('run.finish', { status }, id);
  }

  runs(kind?: string): RunRow[] {
    const rows = (kind
      ? this.db.prepare('SELECT * FROM runs WHERE kind = ? ORDER BY started DESC').all(kind)
      : this.db.prepare('SELECT * FROM runs ORDER BY started DESC').all()) as unknown as RunRow[];
    return rows;
  }

  run(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
  }

  // ---- evidence: content-addressed, already redacted by the caller ----
  putEvidence(data: string | Buffer, ext = 'txt'): string {
    const hash = sha256(data);
    const file = this.evidencePath(hash, ext);
    if (!existsSync(file)) {
      mkdirSync(join(this.dir, 'evidence', hash.slice(0, 2)), { recursive: true });
      writeFileSync(file, data);
    }
    return `${hash}.${ext}`;
  }

  evidencePath(hash: string, ext?: string): string {
    const name = ext ? `${hash}.${ext}` : hash;
    return join(this.dir, 'evidence', name.slice(0, 2), name);
  }

  readEvidence(ref: string): Buffer {
    return readFileSync(this.evidencePath(ref));
  }

  session(id: string): SessionRow {
    let row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
    if (!row) {
      this.db.prepare('INSERT INTO sessions (id, started) VALUES (?, ?)').run(id, new Date().toISOString());
      row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow;
    }
    return row;
  }

  updateSession(id: string, fields: Partial<Pick<SessionRow, 'objective' | 'stop_rounds' | 'data'>>): void {
    this.session(id);
    for (const [k, v] of Object.entries(fields)) this.db.prepare(`UPDATE sessions SET ${k} = ? WHERE id = ?`).run(v as string | number, id);
  }

  close(): void {
    this.db.close();
  }
}

export interface RunRow {
  id: string;
  kind: string;
  status: string;
  commit_sha: string;
  label: string | null;
  started: string;
  finished: string | null;
  duration_ms: number | null;
  data: string | null;
}

export interface SessionRow {
  id: string;
  started: string;
  objective: string | null;
  stop_rounds: number;
  data: string | null;
}
