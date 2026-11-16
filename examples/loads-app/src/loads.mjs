// Domain logic for the load-assignment flow.

export function canAssign(load, driver) {
  if (!load || !driver) return { ok: false, reason: 'not found' };
  if (load.status !== 'open') return { ok: false, reason: `load is ${load.status}` };
  if (load.weightKg > driver.capacityKg) return { ok: false, reason: 'load exceeds driver capacity' };
  return { ok: true };
}

export function formatWeight(kg) {
  return `${kg.toLocaleString('en-US')} kg`;
}

export function listLoads(db) {
  return db.prepare('SELECT id, origin, destination, weightKg, status, driverId, createdAt, assignedAt FROM loads ORDER BY id').all();
}

export function getLoad(db, id) {
  return db.prepare('SELECT id, origin, destination, weightKg, status, driverId, createdAt, assignedAt FROM loads WHERE id = ?').get(id);
}

export function listDrivers(db) {
  return db.prepare('SELECT id, name, capacityKg FROM drivers ORDER BY id').all();
}

export function assignLoad(db, loadId, driverId) {
  const load = getLoad(db, loadId);
  const driver = db.prepare('SELECT id, name, capacityKg FROM drivers WHERE id = ?').get(driverId);
  const check = canAssign(load, driver);
  if (!check.ok) return { status: load && driver ? 409 : 404, body: { error: check.reason } };
  db.prepare("UPDATE loads SET status = 'assigned', driverId = ?, assignedAt = ? WHERE id = ?").run(driverId, new Date().toISOString(), loadId);
  return { status: 200, body: getLoad(db, loadId) };
}
