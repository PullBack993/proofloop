// Recreates the test-only database from fixed fixtures.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

const dataDir = new URL('../data/', import.meta.url).pathname;
mkdirSync(dataDir, { recursive: true });
for (const f of ['app.db', 'app.db-wal', 'app.db-shm']) rmSync(dataDir + f, { force: true });
const seed = JSON.parse(readFileSync(new URL('../fixtures/seed.json', import.meta.url), 'utf8'));
const db = new DatabaseSync(dataDir + 'app.db');
db.exec(`
  CREATE TABLE drivers (id TEXT PRIMARY KEY, name TEXT NOT NULL, capacityKg INTEGER NOT NULL);
  CREATE TABLE loads (id TEXT PRIMARY KEY, origin TEXT NOT NULL, destination TEXT NOT NULL,
    weightKg INTEGER NOT NULL, status TEXT NOT NULL, driverId TEXT, createdAt TEXT NOT NULL, assignedAt TEXT);
`);
const d = db.prepare('INSERT INTO drivers VALUES (?, ?, ?)');
for (const x of seed.drivers) d.run(x.id, x.name, x.capacityKg);
const l = db.prepare('INSERT INTO loads VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
for (const x of seed.loads) l.run(x.id, x.origin, x.destination, x.weightKg, x.status, x.driverId ?? null, x.createdAt, x.assignedAt ?? null);
db.close();
console.log(`seeded ${seed.loads.length} loads, ${seed.drivers.length} drivers`);
