import test from 'node:test';
import assert from 'node:assert/strict';
import { route, renew } from '../dist/index.js';
import { Store } from '../dist/store.js';
import { evaluate, ranked } from '../dist/engine.js';
import { parseCodexBar, quotaBinding, refreshQuotas } from '../dist/quota.js';
import { parseDeepSWE, benchmarkScore } from '../dist/benchmarks.js';
import { privateJson } from '../dist/config.js';
import { fitCriteria } from '../dist/jev.js';
import { fixture, candidate, mapping, request } from './helpers.mjs';

test('renew samples expiry after acquiring the writer lock, not before waiting', async t => {
  const f = await fixture(t); f.config.candidates = [candidate('a')]; f.config.pools[0].maxConcurrent = 1; await f.save();
  const first = await route(request, f.options), expiry = Date.parse(first.expiresAt);
  let clock = expiry - 1; t.mock.method(Date, 'now', () => clock);
  const transaction = Store.prototype.transaction;
  t.mock.method(Store.prototype, 'transaction', function (fn) {
    // Model a competing writer committing a replacement while this writer waits to enter its callback.
    clock = expiry + 1;
    this.reserve({ ...first, id: 'successor', at: new Date(clock).toISOString(), expiresAt: new Date(clock + 300000).toISOString() }, 'successor');
    return transaction.call(this, fn);
  });
  await assert.rejects(renew(first.id, f.options), { code: 'AGENT_ROUTER_LEASE_EXPIRED' });
  const store = new Store(f.config); assert.equal(store.active(clock).get('codex'), 1); store.close();
});
test('account/source/scope rebinding invalidates cached quota even when refresh fails', async t => {
  const f = await fixture(t), pool = f.config.pools[0]; pool.unknown = 'exclude';
  pool.collector = { provider: 'codex', source: 'cli', command: '/nonexistent-fixture-codexbar', account: 'A', windowModels: { spark: [] } };
  const raw = { provider: 'codex', source: 'codex-cli', account: 'A', usage: { updatedAt: new Date().toISOString(), primary: { usedPercent: 0 }, extraRateWindows: [{ id:'spark',window:{usedPercent:100} }] } };
  const snapshot = parseCodexBar(raw, pool), store = new Store(f.config); store.putQuota(snapshot);
  assert.equal(evaluate(f.config, request, store.quotas(), new Map(), [])[0].quota, 'known');
  pool.collector.account = 'B';
  assert.notEqual(snapshot.binding, quotaBinding(pool));
  await refreshQuotas(f.config, store);
  const row = evaluate(f.config, request, store.quotas(), new Map(), [])[0];
  assert.equal(row.quota, 'unknown'); assert.equal(row.eligible, false); assert.ok(row.reasons.includes('quota-binding-changed'));
  assert.equal(store.refreshStatus().length, 1);
  pool.collector.account = 'A'; pool.collector.windowModels.spark = ['openai-codex/a'];
  assert.equal(evaluate(f.config, request, store.quotas(), new Map(), [])[0].quota, 'unknown'); store.close();
});
test('DeepSWE low-effort rows cannot alter a high-effort normalization cohort', () => {
  const row = (model, effort, score) => ({model,harness:'fixture',config:`${model}-${effort}`,reasoning_effort:effort,pass_at_1:score,n_tasks_attempted:113,n_attempted:113});
  const observations = parseDeepSWE({generated_at:new Date().toISOString(),unit:'Synthetic',n_tasks_in_set:113,rows:[row('a','high',.8),row('b','high',.9),row('c','low',.1)]});
  const c = candidate('a', 'codex', {benchmarks:[mapping(observations[0])]});
  assert.equal(benchmarkScore(c, observations.slice(0,2), 100000, 'coding').score, 0);
  assert.equal(benchmarkScore(c, observations, 100000, 'coding').score, 0);
});
test('live two-decimal Score probability rounding is accepted without accepting corrupt distributions', async t => {
  const f = await fixture(t); f.config.jev.enabled = true; await f.save(); await privateJson(f.config.credentialsFile, { typesafe:'synthetic' });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const input = JSON.parse(options.body), answers = { family:{type:'choice',choice:'coding',confidence:.98,probabilities:{general:.01,coding:.99}} };
    for (const key of Object.keys(input.questions).filter(k => k !== 'family')) answers[key] = {
      type:'score',score:3.24,confidence:.37,legend:Object.fromEntries(fitCriteria.map((v,i)=>[i,v])), probabilities:{0:.03,1:.04,2:.1,3:.3,4:.53},
    };
    return Response.json({model:'jev-1.13.0',answers});
  });
  const d = await route(request, f.options); assert.equal(d.strategy, 'jev'); assert.equal(d.candidates[0].score, .81);
});
test('role-specific tie breaks do not leak checker preferences into builder choice', async t => {
  const f = await fixture(t);
  const config = { ...f.config, candidates:[candidate('a','codex',{rank:0,roleRanks:{builder:100,checker:0}}),candidate('z','codex',{rank:0,roleRanks:{builder:0}})] };
  const diagnostics = [{id:'a',eligible:true,utility:.8},{id:'z',eligible:true,utility:.8}];
  assert.equal(ranked(config, diagnostics, 'builder')[0].id, 'z'); assert.equal(ranked(config, diagnostics, 'checker')[0].id, 'a');
});
test('atomic config creation cannot overwrite an existing file under a competing initializer', async t => {
  const f = await fixture(t), before = JSON.stringify(f.config);
  await assert.rejects(privateJson(f.path, {competing:true}, true), {code:'EEXIST'});
  const { readFile } = await import('node:fs/promises'); assert.equal(JSON.stringify(JSON.parse(await readFile(f.path, 'utf8'))), before);
});
