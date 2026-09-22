import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { route, renew, release } from '../dist/index.js';
import { Store } from '../dist/store.js';
import { evaluate } from '../dist/engine.js';
import { loadConfig, validateRequest, quotaSnapshot } from '../dist/config.js';
import { fixture, candidate, quota, request } from './helpers.mjs';
const exec = promisify(execFile);
const noRoute = { code: 'AGENT_ROUTER_NO_FEASIBLE_ROUTE' };

test('reserves exact identity, dry-run is nonreserving, renew/release are bounded', async t => {
  const f = await fixture(t);
  const preview = await route(request, { ...f.options, dryRun: true });
  assert.equal(preview.reserved, false);
  let store = new Store(f.config); assert.equal(store.active().size, 0); store.close();
  const decision = await route(request, f.options);
  assert.deepEqual(decision.selected, { model: 'openai-codex/a', thinking: 'high' });
  assert.equal(decision.strategy, 'fallback'); assert.equal(decision.reason, 'jev-disabled');
  await renew(decision.id, f.options); await release(decision.id, f.options); await release(decision.id, f.options);
  await assert.rejects(renew(decision.id, f.options), { code: 'AGENT_ROUTER_LEASE_EXPIRED' });
  store = new Store(f.config); assert.equal(store.active().size, 0); store.close();
});
test('multi-window reserve, expired window cannot erase unexpired weekly exhaustion', async t => {
  const f = await fixture(t), store = new Store(f.config);
  store.putQuota(quota('codex', 20, { windows: [
    { id: '5h', usedPercent: 0, resetAt: new Date(Date.now() - 1000).toISOString() },
    { id: '7d', usedPercent: 100, resetAt: new Date(Date.now() + 86400000).toISOString() },
  ] })); store.close();
  assert.equal((await route(request, f.options)).selected.model, 'claude-bridge/b');
  await assert.rejects(route({ ...request, pin: { model: 'openai-codex/a' } }, f.options), noRoute);
});
test('unknown/stale/reset quotas obey explicit policy and never report fresh zero', async t => {
  const f = await fixture(t); f.config.candidates = [candidate('a')]; f.config.pools[0].unknown = 'exclude'; await f.save();
  const store = new Store(f.config); store.db.prepare('DELETE FROM quota').run(); store.close();
  await assert.rejects(route(request, f.options), noRoute);
  f.config.pools[0].unknown = 'penalize'; await f.save();
  const d = await route(request, f.options); assert.equal(d.candidates[0].quota, 'unknown'); assert.equal(d.candidates[0].headroom, undefined);
  const expired = quota('codex', 0, { windows: [{ id: 'x', usedPercent: 0, resetAt: new Date(Date.now() - 1).toISOString() }] });
  assert.equal(evaluate(f.config, request, new Map([['codex', expired]]), new Map(), [])[0].quota, 'unknown');
  const stale = quota('codex', 0, { observedAt: new Date(Date.now() - 3600000).toISOString() });
  assert.equal(evaluate(f.config, request, new Map([['codex', stale]]), new Map(), [])[0].quota, 'unknown');
});
test('model-scoped windows and unknown usage remain scoped', async t => {
  const f = await fixture(t); f.config.candidates = [candidate('a'), candidate('b')];
  const q = quota('codex', 20); q.windows.push({ id: 'b-weekly', usedPercent: 130, models: ['openai-codex/b'] });
  let rows = evaluate(f.config, request, new Map([['codex', q]]), new Map(), []);
  assert.equal(rows[0].eligible, true); assert.equal(rows[1].eligible, false);
  q.windows[1].known = false;
  rows = evaluate(f.config, request, new Map([['codex', q]]), new Map(), []);
  assert.equal(rows[0].quota, 'known'); assert.equal(rows[1].quota, 'unknown'); assert.equal(rows[1].eligible, true);
});
test('hard identity, role, disabled and native restrictions precede Jev', async t => {
  const f = await fixture(t);
  await assert.rejects(route({ ...request, pin: { model: 'openai-codex/not-configured' } }, f.options), noRoute);
  await assert.rejects(route({ ...request, pin: { model: 'openai-codex/a', thinking: 'max' } }, f.options), noRoute);
  await assert.rejects(route({ ...request, role: 'unknown' }, f.options), noRoute);
  f.config.candidates = [candidate('a', 'codex', { thinking: 'max' })]; await f.save();
  await assert.rejects(route({ ...request, harness: 'native' }, f.options), noRoute);
  assert.equal((await route(request, f.options)).selected.thinking, 'max');
  f.config.candidates[0].enabled = false; await f.save(); await assert.rejects(route(request, f.options), noRoute);
});
test('input boundary rejects extra identity fields, invalid numbers, future timestamps and empty catalog', async t => {
  assert.throws(() => validateRequest({ ...request, thinking: 'max' }));
  assert.throws(() => validateRequest({ ...request, task: '' }));
  assert.throws(() => validateRequest({ ...request, pin: { thinking: 'high' } }));
  assert.throws(() => quotaSnapshot(quota('codex', NaN)));
  assert.throws(() => quotaSnapshot(quota('codex', -1)));
  assert.throws(() => quotaSnapshot(quota('codex', 10, { observedAt: new Date(Date.now() + 3600000).toISOString() })));
  const f = await fixture(t); f.config.candidates = []; await f.save(); await assert.rejects(loadConfig(f.path));
});
test('request IDs are idempotent, mismatched reuse and expired resurrection fail', async t => {
  const f = await fixture(t), r = { ...request, requestId: 'same' };
  const a = await route(r, f.options), b = await route(r, f.options); assert.equal(a.id, b.id);
  await assert.rejects(route({ ...r, task: 'Different' }, f.options), { code: 'AGENT_ROUTER_REQUEST_CONFLICT' });
  const store = new Store(f.config); store.db.prepare('UPDATE decisions SET expires=0 WHERE id=?').run(a.id); store.close();
  await assert.rejects(renew(a.id, f.options), { code: 'AGENT_ROUTER_LEASE_EXPIRED' });
  await assert.rejects(route(r, f.options), { code: 'AGENT_ROUTER_REQUEST_SETTLED' });
  assert.notEqual((await route({ ...request, requestId: 'new' }, f.options)).id, a.id);
});
test('shared pool capacity is atomic across processes, not per model', async t => {
  const f = await fixture(t); f.config.candidates = [candidate('a'), candidate('b')]; f.config.pools[0].maxConcurrent = 2; await f.save();
  const code = `import {route} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};try{console.log(JSON.stringify(await route(${JSON.stringify(request)},{configPath:process.argv[1]})))}catch(e){console.log(JSON.stringify({error:e.code}));}`;
  const results = await Promise.all(Array.from({ length: 8 }, () => exec(process.execPath, ['--input-type=module', '-e', code, f.path])));
  const rows = results.map(r => JSON.parse(r.stdout));
  assert.equal(rows.filter(r => r.reserved).length, 2);
  assert.equal(rows.filter(r => r.error === noRoute.code).length, 6);
});
test('concurrent duplicate requests share one reservation', async t => {
  const f = await fixture(t); f.config.candidates = [candidate('a')]; f.config.pools[0].maxConcurrent = 1; await f.save();
  const r = { ...request, requestId: 'shared' };
  const code = `import {route} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};console.log((await route(${JSON.stringify(r)},{configPath:process.argv[1]})).id)`;
  const rows = await Promise.all(Array.from({ length: 5 }, () => exec(process.execPath, ['--input-type=module', '-e', code, f.path])));
  assert.equal(new Set(rows.map(r => r.stdout.trim())).size, 1);
});
test('audit excludes raw task and secrets; state and credentials permissions are private', async t => {
  const f = await fixture(t), secret = 'SYNTHETIC-DO-NOT-PERSIST';
  const d = await route({ ...request, task: secret }, f.options);
  const store = new Store(f.config); const row = store.db.prepare('SELECT * FROM decisions WHERE id=?').get(d.id); store.close();
  assert.equal(JSON.stringify(row).includes(secret), false);
  assert.equal((await stat(join(f.config.stateDir, 'router.sqlite'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.config.stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal((await readFile(f.path, 'utf8')).includes(secret), false);
});
