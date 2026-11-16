import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathMatches, select } from '../src/jsonpath.js';
import { diffJson, diffLines, normalize } from '../src/diff.js';
import { redactJson, redactText } from '../src/redact.js';
import { parseTap } from '../src/probes.js';
import { applyOp, evaluateContract, decide } from '../src/contract.js';
import { findWeakening, validateControl } from '../src/control.js';
import { bashTouchesProtected, isProtectedPath } from '../src/hooks.js';
import { looksLikeCorrection } from '../src/lessons.js';
import { matchClaim, envDrift } from '../src/compare.js';
import { discoverRoutes, buildInventory } from '../src/inventory.js';
import type { Config, ControlSet, Manifest, Rule } from '../src/types.js';

const config: Config = { version: 1, project: 't', app: { start: 'x', baseUrl: 'http://127.0.0.1:1' }, params: { id: 'L-1' } };

test('jsonpath selects wildcards and matches patterns', () => {
  const v = { body: [{ id: 1, tags: ['a'] }, { id: 2, tags: [] }] };
  assert.deepEqual(select(v, '$.body[*].id').map((x) => x.value), [1, 2]);
  assert.deepEqual(select(v, '$.body[1].id').map((x) => x.path), ['$.body[1].id']);
  assert.ok(pathMatches('$.body[*].id', '$.body[3].id'));
  assert.ok(pathMatches('$.body', '$.body[3].id'), 'prefix match');
  assert.ok(!pathMatches('$.body[*].id', '$.body[3].name'));
  assert.ok(pathMatches('$.body.**', '$.body.a.b[2]'));
});

test('diff reports field-level changes and respects typed rules', () => {
  const a = { status: 200, body: { id: 1, at: '2026-01-01T00:00:00Z', items: [3, 1, 2] } };
  const b = { status: 200, body: { id: 1, at: '2026-02-02T10:00:00Z', items: [1, 2, 3], extra: true } };
  const raw = diffJson(a, b);
  assert.ok(raw.some((d) => d.path === '$.body.extra' && d.change === 'added'));
  assert.ok(raw.some((d) => d.path === '$.body.at' && d.change === 'changed'));
  const rules: Rule[] = [
    { id: 'r1', version: 1, owner: 'me', reason: 'server time', probe: '*', kind: 'mask', path: '$.body.at', pattern: '\\d{4}-\\d{2}-\\d{2}T[\\d:]+Z', replacement: '<t>' },
    { id: 'r2', version: 1, owner: 'me', reason: 'set semantics', probe: '*', kind: 'unordered', path: '$.body.items' },
  ];
  const left = diffJson(normalize(a, rules), normalize(b, rules));
  assert.deepEqual(left.map((d) => d.path), ['$.body.extra']);
});

test('line diff groups a removed block into one hunk', () => {
  const d = diffLines(['a', 'b', 'c', 'd', 'e'], ['a', 'e'], '$.aria');
  assert.equal(d.length, 1);
  assert.equal(d[0].change, 'removed');
  assert.deepEqual(d[0].before, ['b', 'c', 'd']);
  const c = diffLines(['a', 'b', 'c'], ['a', 'X', 'c'], '$.aria');
  assert.equal(c.length, 1);
  assert.equal(c[0].change, 'changed');
});

test('redaction removes secrets and personal data', () => {
  assert.equal(redactText('mail jane.doe@example.com now'), 'mail <redacted:email> now');
  assert.match(redactText('Authorization: Bearer abcdefghijklmnop'), /Bearer <redacted>/);
  assert.equal(redactText('card 4111 1111 1111 1111'), 'card <redacted:card>');
  assert.equal(redactText('order 1234567890123'), 'order 1234567890123', 'non-Luhn numbers stay');
  assert.deepEqual(redactJson({ password: 'hunter2', apiKey: 'x', name: 'ok' }), { password: '<redacted>', apiKey: '<redacted>', name: 'ok' });
});

test('TAP parser handles nested subtests and skips', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: suite',
    '    # Subtest: child one',
    '    ok 1 - child one',
    '    # Subtest: child two',
    '    not ok 2 - child two',
    'not ok 1 - suite',
    '# Subtest: skipped',
    'ok 2 - skipped # SKIP',
    '# Subtest: plain',
    'ok 3 - plain',
  ].join('\n');
  assert.deepEqual(parseTap(tap), [
    { name: 'suite > child one', ok: true },
    { name: 'suite > child two', ok: false },
    { name: 'suite', ok: false },
    { name: 'plain', ok: true },
  ]);
});

test('assertion operators', () => {
  assert.ok(applyOp('eq', [200], 200).ok);
  assert.ok(!applyOp('eq', [], 200).ok, 'missing value never passes');
  assert.ok(applyOp('unique', [1, 2, 3], undefined).ok);
  assert.ok(!applyOp('unique', [1, 2, 2], undefined).ok);
  assert.ok(applyOp('count', [1, 2, 3], 3).ok);
  assert.ok(applyOp('absent', [], undefined).ok);
  assert.ok(applyOp('matches', ['L-1001'], '^L-\\d+$').ok);
});

function manifest(obs: Manifest['observations'], extra: Partial<Manifest> = {}): Manifest {
  return {
    id: 'm', label: 'l', createdAt: '', repoRoot: '/', commit: 'c', dirty: false, workspace: 'worktree', controlVersion: 1,
    env: { node: 'v', platform: 'p', arch: 'a', timezone: 'UTC', locale: 'en', clock: 'x' },
    status: 'complete', probes: [], observations: obs, ...extra,
  };
}

test('model or critic oracles never pass; unknown is not verified', () => {
  const set: ControlSet = {
    config, rules: [], probes: [], lessons: [],
    contract: {
      version: 1,
      requirements: [
        { id: 'R1', text: 'judged by a model', oracle: { kind: 'llm-judge' }, checks: [{ type: 'probe-ok', probe: 'p' }] },
        { id: 'R2', text: 'no probe', oracle: { kind: 'business-rule' }, checks: [{ type: 'assert', probe: 'missing', path: '$.x', op: 'exists' }] },
      ],
    },
  };
  const head = manifest([{ probeId: 'p', ok: true, value: { status: 200 }, evidence: {}, durationMs: 1 }]);
  const res = evaluateContract(set, head, manifest([]), []);
  assert.equal(res.find((r) => r.id === 'R1')!.status, 'UNKNOWN');
  assert.equal(res.find((r) => r.id === 'R2')!.status, 'UNKNOWN');
  assert.equal(decide(res), 'REJECTED');
});

test('unclaimed differences fail the implicit baseline requirement; claimed ones pass', () => {
  const set: ControlSet = { config, rules: [], probes: [], lessons: [], contract: { version: 1, requirements: [] } };
  const head = manifest([]);
  const failing = evaluateContract(set, head, manifest([]), [{ id: 'D1', probeId: 'p', path: '$.a', change: 'changed', class: 'unintended' }]);
  assert.equal(failing[0].status, 'FAILED');
  const ok = evaluateContract(set, head, manifest([]), [{ id: 'D1', probeId: 'p', path: '$.a', change: 'changed', class: 'intended' }]);
  assert.equal(decide(ok), 'ACCEPTED');
  const flaky = evaluateContract(set, head, manifest([]), [{ id: 'D1', probeId: 'p', path: '$.a', change: 'changed', class: 'flaky' }]);
  assert.equal(flaky[0].status, 'UNKNOWN');
});

test('claims match only approved, scoped changes', () => {
  const claims = [
    { id: 'C1', text: 't', probe: 'gen.*', path: '$.body[*].eta', change: 'added' as const, approved: true },
    { id: 'C2', text: 't', probe: '*', path: '$.body.secret', approved: false },
  ];
  assert.equal(matchClaim(claims, 'gen.get.loads', { path: '$.body[2].eta', change: 'added' })?.id, 'C1');
  assert.equal(matchClaim(claims, 'gen.get.loads', { path: '$.body[2].eta', change: 'removed' }), undefined);
  assert.equal(matchClaim(claims, 'journey.x', { path: '$.body[2].eta', change: 'added' }), undefined);
  assert.equal(matchClaim(claims, 'gen.x', { path: '$.body.secret', change: 'added' }), undefined, 'unapproved claim');
});

test('environment drift is detected', () => {
  const a = manifest([]).env;
  assert.deepEqual(envDrift(a, { ...a, node: 'v2' }), ['node: v -> v2']);
});

test('weakening needs a human: removed requirements, new ignore rules, retired lessons', () => {
  const prev: ControlSet = {
    config: { ...config, protectedPaths: ['test/**'] }, rules: [], probes: [{ id: 'p', kind: 'api', method: 'GET', path: '/' }],
    contract: { version: 1, requirements: [{ id: 'R1', text: 't', oracle: { kind: 'business-rule' }, checks: [{ type: 'probe-ok', probe: 'p' }] }] },
    lessons: [{ id: 'L1', version: 1, createdAt: '', what: 'x', foundBy: 'human-told', missReason: 'no-oracle', builderRule: 'x', status: 'active' }],
  };
  const next = structuredClone(prev);
  assert.deepEqual(findWeakening(prev, next), []);
  next.contract.requirements[0].mandatory = false;
  next.rules.push({ id: 'r', version: 1, owner: 'o', reason: 'r', probe: '*', kind: 'ignore-path', path: '$.x' });
  next.probes = [];
  next.config.protectedPaths = [];
  next.lessons[0].status = 'retired';
  const w = findWeakening(prev, next).join('\n');
  for (const s of ['made optional', 'rule r added', 'probe p removed', 'protected path test/** removed', 'lesson L1 retired']) assert.match(w, new RegExp(s.replace(/[*]/g, '\\*')));
  const grown = structuredClone(prev);
  grown.lessons.push({ ...prev.lessons[0], id: 'L2' });
  grown.contract.requirements.push({ id: 'R2', text: 'more', oracle: { kind: 'business-rule' }, checks: [] });
  assert.deepEqual(findWeakening(prev, grown), [], 'adding checks is never weakening');
});

test('rules without owner or reason are rejected', () => {
  const v = validateControl({ config, contract: { version: 1, requirements: [] }, probes: [], rules: [{ id: 'r', version: 1, owner: '', reason: '', probe: '*', kind: 'ignore-path', path: '$.a' }] });
  assert.equal(v.errors.length, 1);
});

test('harness protects control files, tests and hook settings', () => {
  const root = '/repo';
  const globs = ['.proofloop/**', '.claude/settings.json', 'test/**'];
  assert.ok(isProtectedPath(root, '/repo/.proofloop/contract.json', globs));
  assert.ok(isProtectedPath(root, 'test/a.test.ts', globs));
  assert.ok(isProtectedPath(root, '/repo/.claude/settings.json', globs));
  assert.ok(!isProtectedPath(root, '/repo/src/app.ts', globs));
  assert.ok(bashTouchesProtected('echo x > .proofloop/rules.json', globs));
  assert.ok(bashTouchesProtected('rm -rf test/', globs));
  assert.ok(bashTouchesProtected('npx proofloop freeze --approve-weakening', globs));
  assert.equal(bashTouchesProtected('cat .proofloop/contract.json', globs), undefined);
  assert.equal(bashTouchesProtected('npm run build', globs), undefined);
});

test('corrections are noticed in plain words (English and German)', () => {
  for (const p of ['this is wrong', "that's still broken", 'the board is wrong', 'You missed the edge case', 'Das ist falsch', 'funktioniert nicht'])
    assert.ok(looksLikeCorrection(p), p);
  for (const p of ['Add pagination to the list', 'please write tests', 'what is the status?']) assert.ok(!looksLikeCorrection(p), p);
});

test('inventory finds routes, generates read-only probes and reports gaps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-inv-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'src', 'app.ts'),
    `app.get('/api/items', h);\napp.get('/api/items/:id', h);\nrouter.post('/api/items', h);\napp.get('/api/orders/:orderId', h);\napp.get('/dashboard', h);\n`,
  );
  const routes = discoverRoutes(config, dir);
  assert.equal(routes.length, 5);
  const { generated, report } = buildInventory(config, dir, []);
  const ids = generated.map((p) => p.id).sort();
  assert.deepEqual(ids, ['gen.get.api.items', 'gen.get.api.items.id', 'gen.page.dashboard']);
  const reasons = report.unprobed.map((u) => `${u.route.method} ${u.route.path}: ${u.reason}`).join('\n');
  assert.match(reasons, /POST \/api\/items: writes need a hand-written/);
  assert.match(reasons, /no fixture value for :orderId/);
});
