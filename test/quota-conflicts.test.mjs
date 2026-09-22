import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { candidate, fixture, request } from './helpers.mjs';
import { Store } from '../dist/store.js';
import { quotaBinding, matchesBinding } from '../dist/quota.js';
import { evaluate } from '../dist/engine.js';
import { route, release } from '../dist/index.js';

const exec = promisify(execFile);
const permutations = rows => rows.length ? rows.flatMap((r, i) => permutations(rows.filter((_, j) => j !== i)).map(rest => [r, ...rest])) : [[]];
const ordinary = q => q.gates?.find(g => g.id === 'ordinary-usage');
const noRoute = { code: 'AGENT_ROUTER_NO_FEASIBLE_ROUTE' };
const diagnostics = (f, store) => evaluate(f.config, request, store.quotas(), new Map(), []);
async function setup(t) {
  const f = await fixture(t);
  f.config.pools = [f.config.pools[0]]; f.config.candidates = [candidate('a')]; await f.save();
  const store = new Store(f.config); t.after(() => store.close());
  const clear = () => store.db.exec('DELETE FROM quota_cache; DELETE FROM quota'); clear();
  const base = Date.now() - 30000, at = n => new Date(base + n * 1000).toISOString();
  const window = (usedPercent, extra = {}) => ({ id: 'primary', usedPercent, resetAt: new Date(base + 3600000).toISOString(), ...extra });
  const sample = (usedPercent, n = 1, allowed = 'missing', bound = true, gateTime = n) => ({
    version: 1, pool: 'codex', source: 'synthetic', observedAt: at(n), windows: [window(usedPercent)], warnings: [],
    ...(bound ? { binding: quotaBinding(f.config.pools[0]) } : {}),
    ...(allowed === 'missing' ? {} : { gates: [{ id: 'ordinary-usage', allowed, observedAt: at(gateTime) }] }),
  });
  return { f, store, clear, at, window, sample };
}

test('equal-time 100/20 conflicts: all six gate/order variants survive CLI ingest and public route', async t => {
  const { f, store, clear, sample } = await setup(t), file = join(f.dir, 'snapshot.json');
  let count = 0;
  for (const gate of ['missing', true, null]) for (const order of [[100, 20], [20, 100]]) {
    clear();
    for (const used of order) {
      await writeFile(file, JSON.stringify(sample(used, 1, gate)));
      await exec(process.execPath, [new URL('../dist/cli.js', import.meta.url).pathname, 'quota', 'ingest', '--config', f.path, '--file', file]);
      if (used === 100) await assert.rejects(route(request, { ...f.options, dryRun: true }), noRoute);
    }
    const q = store.quotas().get('codex'), d = diagnostics(f, store)[0];
    assert.deepEqual(q.windows.map(w => w.usedPercent).sort((a, b) => a - b), [20, 100]);
    assert.equal(new Set(q.windows.map(w => w.id)).size, 2);
    assert.equal(d.eligible, false); assert.ok(d.reasons.some(r => r.startsWith('reserve:')));
    await assert.rejects(route(request, { ...f.options, dryRun: true }), noRoute);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM decisions').get().n, 0);
    count++;
  }
  t.diagnostic(`${count} gate/arrival variants; 12 CLI ingests, public exclusion and no leases`);
});

test('incomparable windows retain independent IDs, exact scopes, unknown counters and collision-free diagnostic IDs', async t => {
  const { f, store, clear, sample, window } = await setup(t);
  f.config.candidates = ['a', 'b', 'c'].map(id => candidate(id)); await f.save();
  const rows = [
    { ...sample(20), windows: [window(100, { models: ['openai-codex/a'] }), window(5, { id: 'weekly', models: ['openai-codex/b'] }), window(20, { id: 'quota-view:0', models: [] })] },
    { ...sample(20), windows: [window(100, { models: ['openai-codex/b'] }), window(91, { id: 'weekly', models: ['openai-codex/b'] })] },
    { ...sample(20), windows: [window(35, { known: false, models: ['openai-codex/a'] }), window(100, { id: 'irrelevant', models: [] })] },
    { ...sample(20), windows: [] },
  ];
  let expected;
  for (const sequence of permutations(rows)) {
    clear(); for (const q of sequence) store.putQuota(q);
    const q = store.quotas().get('codex'), d = diagnostics(f, store);
    assert.equal(q.windows.length, 7); assert.equal(new Set(q.windows.map(w => w.id)).size, 7);
    assert.deepEqual(q.windows.find(w => w.id === 'quota-view:0').models, []);
    assert.deepEqual(q.windows.filter(w => w.usedPercent === 100).map(w => w.models).sort(), [[], ['openai-codex/a'], ['openai-codex/b']].sort());
    assert.deepEqual(q.windows.find(w => w.known === false).models, ['openai-codex/a']);
    assert.deepEqual(d.map(x => x.eligible), [false, false, true]);
    assert.equal(d[0].quota, 'unknown'); assert.ok(d[0].reasons.includes('quota-usage-unknown'));
    assert.equal(d[1].reasons.filter(r => r.startsWith('reserve:')).length, 2);
    assert.equal((await route(request, { ...f.options, dryRun: true })).candidateId, 'c');
    const cache = JSON.parse(store.db.prepare('SELECT data FROM quota_cache').get().data);
    assert.equal(cache.observations.length, 4); assert.ok(cache.observations.some(o => o.snapshot.windows.length === 0));
    if (expected) assert.deepEqual(q, expected); expected = q;
  }
  // Per-input cardinality bounds cannot silently trim a larger union of live restrictions.
  clear();
  for (let i = 0; i < 101; i++) store.putQuota({ ...sample(20), windows: [window(100 + i, { models: ['openai-codex/a'] })] });
  const q = store.quotas().get('codex');
  assert.equal(q.windows.length, 101); assert.equal(new Set(q.windows.map(w => w.id)).size, 101);
  assert.deepEqual(q.windows.map(w => w.usedPercent).sort((a, b) => a - b), Array.from({ length: 101 }, (_, i) => 100 + i));
  assert.deepEqual(diagnostics(f, store).map(d => d.eligible), [false, true, true]);
  t.diagnostic('24 scope/window/missing permutations plus 101-view union; no synthesized counters or widened scopes');
});

test('window recovery requires newer time or comparable read tokens, never imported ordering authority', async t => {
  const { f, store, clear, sample, window } = await setup(t);
  const cases = [
    ['new time', [[sample(100), 0], [sample(20, 2), 0]], [20], true, 'known'],
    ['read token', [[sample(100), 1], [sample(20), 2]], [20], true, 'known'],
    ['same read token conflicts', [[sample(100), 1], [sample(20), 1]], [20, 100], false, 'known'],
    ['manual deny survives read recovery', [[sample(100), 0], [sample(100), 1], [sample(20), 2]], [20, 100], false, 'known'],
    ['manual allow cannot erase reads', [[sample(20), 0], [sample(100), 1], [sample(30), 2]], [20, 30], true, 'known'],
    ['manual allow cannot beat newer read exhaustion', [[sample(20), 0], [sample(30), 1], [sample(100), 2]], [20, 100], false, 'known'],
    ['unknown cannot discard known exhaustion', [[{ ...sample(20), windows: [window(20, { known: false })] }, 0], [sample(100), 1]], [20, 100], false, 'unknown'],
    ['unknown import survives comparable recovery', [[{ ...sample(20), windows: [window(20, { known: false })] }, 0], [sample(100), 1], [sample(30), 2]], [20, 30], true, 'unknown'],
    ['missing cannot discard exhaustion', [[{ ...sample(20), windows: [] }, 0], [sample(100), 1]], [100], false, 'known'],
    ['genuinely newer clears incomparable history', [[sample(100), 0], [sample(100), 2], [sample(20, 2), 0]], [20], true, 'known'],
  ];
  let count = 0;
  for (const [name, observations, percentages, eligible, state] of cases) for (const sequence of permutations(observations)) {
    clear(); for (const [q, token] of sequence) store.putQuota(q, token);
    const q = store.quotas().get('codex'), d = diagnostics(f, store)[0];
    assert.deepEqual(q.windows.map(w => w.usedPercent).sort((a, b) => a - b), percentages, name);
    assert.equal(d.eligible, eligible, name); assert.equal(d.quota, state, name);
    if (eligible) assert.equal((await route(request, { ...f.options, dryRun: true })).candidateId, 'a');
    else await assert.rejects(route(request, { ...f.options, dryRun: true }), noRoute);
    const reopened = new Store(f.config);
    try {
      assert.deepEqual(reopened.quotas().get('codex'), q, name);
      // An obsolete read replay after persistence cannot inherit an import's time/token.
      if (observations.some(([, token]) => token === 2)) {
        reopened.putQuota(sample(100), 1); assert.deepEqual(reopened.quotas().get('codex'), q, name);
      }
    } finally { reopened.close(); }
    count++;
  }
  // Cache JSON written by the previous repair has no observation set.
  clear(); const old = sample(100);
  store.db.prepare('INSERT INTO quota_cache VALUES(?,?,?)').run('codex', old.binding, JSON.stringify({ snapshot: old, token: 0, permissions: [] }));
  assert.equal(diagnostics(f, store)[0].eligible, false);
  store.putQuota(sample(20)); assert.equal(store.quotas().get('codex').windows.length, 2);
  store.putQuota(sample(30, 2)); assert.equal(diagnostics(f, store)[0].eligible, true);
  t.diagnostic(`${count} recovery/provenance permutations, reopen/replay, and old-JSON fallback`);
});

test('standalone bound/unbound fold full permission histories across arrival orders, null/missing and explicit recovery', async t => {
  const { f, store, clear, sample, at } = await setup(t);
  let count = 0;
  for (const boundFirst of [true, false]) {
    const a = (state, n, gateTime = n) => sample(20, n, state, boundFirst, gateTime);
    const b = (state, n, gateTime = n) => sample(20, n, state, !boundFirst, gateTime);
    const cases = [
      ['new denial', [a(true, 1), b(false, 5)], false, 5],
      ['denial then null', [a(false, 1), b(null, 5)], false, 1],
      ['denial then missing', [a(false, 1), b('missing', 5)], false, 1],
      ['explicit recovery', [a(false, 1), b(true, 5)], true, 5],
      ['equal contradictory permission', [a(true, 1), b(false, 1)], false, 1],
      ['recorded true behind null view', [a(true, 2), a(null, 3), b(false, 1)], null, 3],
      ['recorded true behind missing view', [a(true, 2), a('missing', 3), b(false, 1)], null, 3],
      ['recovery in other representation', [a(false, 1), b(true, 2), a(null, 3)], null, 3],
      ['gate time beats raw wrapper', [a(true, 10, 4), b(null, 5)], null, 5],
      ['missing time beats raw wrapper', [a(true, 10, 4), b('missing', 5)], null, 5],
      ['explicit gate recovery behind raw wrapper', [a(null, 10, 4), b(true, 5)], true, 5],
    ];
    for (const [name, rows, allowed, gateTime] of cases) for (const sequence of permutations(rows)) {
      clear(); for (const q of sequence) { assert.equal(matchesBinding(f.config.pools[0], q), true); store.putQuota(q); }
      const q = store.quotas().get('codex');
      assert.equal(ordinary(q).allowed, allowed, name); assert.equal(ordinary(q).observedAt, at(gateTime), name);
      assert.equal(q.observedAt, at(Math.max(...rows.map(r => (Date.parse(r.observedAt) - Date.parse(at(0))) / 1000))), name);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM quota_cache').get().n, 2);
      if (allowed === false) await assert.rejects(route(request, { ...f.options, dryRun: true }), noRoute);
      else {
        const decision = await route(request, { ...f.options, dryRun: true });
        assert.equal(decision.candidateId, 'a'); assert.equal(decision.candidates[0].quota, allowed === null ? 'unknown' : 'known');
      }
      count++;
    }
    // Full raw observation history also composes across the two accepted representations.
    for (const rows of [[a(true, 1), { ...b(true, 1), windows: [sample(100).windows[0]] }],
      [{ ...a(true, 1), windows: [sample(100).windows[0]] }, b(true, 2)]]) {
      for (const sequence of permutations(rows)) {
        clear(); for (const q of sequence) store.putQuota(q);
        assert.equal(diagnostics(f, store)[0].eligible, rows[1].observedAt !== rows[0].observedAt);
      }
    }
  }
  t.diagnostic(`${count} permission-history permutations with both binding representations and public admission`);
});

test('standalone legacy reopen preserves applicable denial, recovery, schemas and every active/settled lease ID', async t => {
  const { f, store, clear, sample } = await setup(t); clear(); store.putQuota(sample(20, 1, true));
  const active = await route({ ...request, requestId: 'active-standalone' }, f.options);
  const settled = await route({ ...request, requestId: 'settled-standalone' }, f.options); await release(settled.id, f.options);
  const legacy = new DatabaseSync(join(f.config.stateDir, 'router.sqlite')); t.after(() => legacy.close());
  const insert = legacy.prepare('INSERT INTO quota VALUES(?,?,?) ON CONFLICT(pool) DO UPDATE SET observed=excluded.observed,data=excluded.data');
  const before = legacy.prepare('SELECT * FROM decisions ORDER BY id').all();
  const schema = () => legacy.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name IN ('quota','refresh','decisions') ORDER BY name").all();
  const beforeSchema = schema();
  for (const [state, time, expected] of [[false, 5, false], [null, 6, false], ['missing', 7, false], [true, 8, true]]) {
    const q = sample(20, time, state, false); insert.run(q.pool, Date.parse(q.observedAt), JSON.stringify(q));
    const reopened = new Store(f.config);
    try {
      assert.equal(ordinary(reopened.quotas().get('codex')).allowed, expected);
      assert.equal(reopened.previous('active-standalone').decision.id, active.id);
      assert.equal(reopened.previous('settled-standalone').decision.id, settled.id);
      assert.equal(reopened.previous('settled-standalone').active, false); assert.equal(reopened.active().get('codex'), 1);
      if (expected) assert.equal((await route(request, { ...f.options, dryRun: true })).candidateId, 'a');
      else await assert.rejects(route(request, { ...f.options, dryRun: true }), noRoute);
      assert.deepEqual(legacy.prepare('SELECT * FROM decisions ORDER BY id').all(), before); assert.deepEqual(schema(), beforeSchema);
    } finally { reopened.close(); }
  }
});
