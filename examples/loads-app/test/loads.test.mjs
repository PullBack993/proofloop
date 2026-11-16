import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAssign, formatWeight } from '../src/loads.mjs';

test('canAssign accepts an open load within capacity', () => {
  assert.deepEqual(canAssign({ status: 'open', weightKg: 1000 }, { capacityKg: 3000 }), { ok: true });
});

test('canAssign rejects overweight', () => {
  assert.equal(canAssign({ status: 'open', weightKg: 5000 }, { capacityKg: 3000 }).ok, false);
});

test('canAssign rejects loads that are not open', () => {
  assert.equal(canAssign({ status: 'assigned', weightKg: 10 }, { capacityKg: 3000 }).ok, false);
});

test('formatWeight uses kg with thousands separators', () => {
  assert.equal(formatWeight(12500), '12,500 kg');
});
