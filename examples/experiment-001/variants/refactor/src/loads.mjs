// Domain logic for the load-assignment flow (refactored: shared column list, guard clauses).
const LOAD_COLUMNS = 'id, origin, destination, weightKg, status, driverId, createdAt, assignedAt';
const kg = new Intl.NumberFormat('en-US');

export function canAssign(load, driver) {
  if (!load || !driver) return { ok: false, reason: 'not found' };
  const problems = [
    load.status !== 'open' && `load is ${load.status}`,
    load.weightKg > driver.capacityKg && 'load exceeds driver capacity',
  ].filter(Boolean);
  return problems.length ? { ok: false, reason: problems[0] } : { ok: true };
}

export const formatWeight = (weightKg) => `${kg.format(weightKg)} kg`;

export const listLoads = (db) => db.prepare(`SELECT ${LOAD_COLUMNS} FROM loads ORDER BY id`).all();

export const getLoad = (db, id) => db.prepare(`SELECT ${LOAD_COLUMNS} FROM loads WHERE id = ?`).get(id);

export const listDrivers = (db) => db.prepare('SELECT id, name, capacityKg FROM drivers ORDER BY id').all();

const findDriver = (db, id) => db.prepare('SELECT id, name, capacityKg FROM drivers WHERE id = ?').get(id);

export function assignLoad(db, loadId, driverId) {
  const load = getLoad(db, loadId);
  const driver = findDriver(db, driverId);
  const verdict = canAssign(load, driver);
  if (!verdict.ok) return { status: load && driver ? 409 : 404, body: { error: verdict.reason } };
  db.prepare("UPDATE loads SET status = 'assigned', driverId = ?, assignedAt = ? WHERE id = ?").run(driverId, new Date().toISOString(), loadId);
  return { status: 200, body: getLoad(db, loadId) };
}
