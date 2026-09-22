import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../dist/index.js';
import { fitCriteria } from '../dist/jev.js';
import { privateJson } from '../dist/config.js';
import { Store } from '../dist/store.js';
import { parseCodexBar, parseClaudeStatusline, refreshQuotas } from '../dist/quota.js';
import { parseDeepSWE, parseArtificialAnalysis, benchmarkScore } from '../dist/benchmarks.js';
import { fixture, quota, request, benchmark, mapping, candidate } from './helpers.mjs';

function answer(score, confidence = 1) {
  return { type: 'score', score, confidence, probabilities: Object.fromEntries(fitCriteria.map((_, i) => [i, +(i === score)])), legend: Object.fromEntries(fitCriteria.map((v,i) => [i,v])) };
}
async function jevFixture(t) {
  const f = await fixture(t); f.config.jev.enabled = true; await f.save();
  await privateJson(f.config.credentialsFile, { typesafe: 'synthetic-secret' });
  return f;
}
function mockJev(t, scores = [1,4], mutate = x => x) {
  return t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal('quotas' in body.state, false); assert.equal('credentials' in body.state, false);
    assert.equal(body.questions.c0.criteria.length, 5);
    const answers = { family: { type: 'choice', choice: 'coding', probabilities: { coding: 1, general: 0 }, confidence: 1 } };
    for (let i = 0; i < body.state.candidates.length; i++) answers[`c${i}`] = answer(scores[i] ?? 4);
    return Response.json(mutate({ model: 'jev-test-version', answers }));
  });
}
test('batches narrow Score judgments with full distribution and exact returned version', async t => {
  const f = await jevFixture(t), mock = mockJev(t);
  const d = await route(request, f.options);
  assert.equal(mock.mock.callCount(), 1); assert.equal(d.strategy, 'jev'); assert.equal(d.jevModel, 'jev-test-version');
  assert.equal(d.selected.model, 'claude-bridge/b'); assert.equal(d.candidates[1].score, 1);
  assert.deepEqual(d.candidates[1].probabilities, {0:0,1:0,2:0,3:0,4:1});
});
test('hard excluded identities never enter Jev state; pins skip paid evaluation', async t => {
  const f = await jevFixture(t), s = new Store(f.config); s.putQuota(quota('codex', 100)); s.close();
  const mock = mockJev(t, [4]);
  const d = await route(request, f.options);
  assert.equal(JSON.parse(mock.mock.calls[0].arguments[1].body).state.candidates.length, 1);
  assert.equal(d.selected.model, 'claude-bridge/b');
  const pinned = await route({ ...request, pin: { model: 'claude-bridge/b', thinking: 'high' } }, f.options);
  assert.equal(pinned.strategy, 'pinned'); assert.equal(mock.mock.callCount(), 1);
});
test('missing credential, HTTP errors and malformed distributions fall back inside router', async t => {
  const f = await jevFixture(t);
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429 }));
  const d = await route(request, { ...f.options, dryRun: true });
  assert.equal(d.strategy, 'fallback'); assert.equal(d.reason, 'jev-http-429');
  mock.mock.restore();
  mockJev(t, [4,4], data => { data.answers.c0.probabilities[0] = 0.7; return data; });
  const invalid = await route(request, { ...f.options, dryRun: true });
  assert.equal(invalid.strategy, 'fallback'); assert.equal(invalid.reason, 'jev-unavailable-or-invalid');
});
test('version pin and low-confidence answers cannot pretend to be accepted Jev judgments', async t => {
  const f = await jevFixture(t); f.config.jev.model = 'jev-evaluated-version'; await f.save();
  const m = mockJev(t); let d = await route(request, { ...f.options, dryRun: true }); assert.equal(d.strategy, 'fallback'); m.mock.restore();
  f.config.jev.model = 'jev-latest'; await f.save();
  mockJev(t, [4,4], data => { for (const k of ['c0','c1']) data.answers[k].confidence = 0.1; return data; });
  d = await route(request, { ...f.options, dryRun: true }); assert.equal(d.strategy, 'fallback'); assert.match(d.reason, /low-confidence/);
});
test('quota is reread after Jev and exhausted preferred candidate cannot launch', async t => {
  const f = await jevFixture(t);
  mockJev(t, [4,1], data => { const s = new Store(f.config); s.putQuota(quota('codex', 100)); s.close(); return data; });
  const d = await route(request, f.options); assert.equal(d.selected.model, 'claude-bridge/b');
});
test('CodexBar preserves timestamps, ignores personal data, parses absent and named windows', () => {
  const pool = { id: 'codex', collector: { provider: 'codex', source: 'cli', windowModels: { spark: ['openai-codex/spark'] } } };
  const now = new Date().toISOString();
  const row = { provider: 'codex', source: 'codex-cli', usage: { updatedAt: now, accountEmail: 'private@example.test', primary: null,
    secondary: { usedPercent: 24, windowMinutes: 10080 }, extraRateWindows: [{ id: 'spark', window: { usedPercent: 110 }, usageKnown: true }] } };
  const q = parseCodexBar([row], pool);
  assert.equal(q.observedAt, now); assert.equal(q.windows.length, 2); assert.equal(q.windows[1].usedPercent, 110);
  assert.deepEqual(q.windows[1].models, ['openai-codex/spark']); assert.equal(JSON.stringify(q).includes('private@'), false);
  assert.throws(() => parseCodexBar([row,row], pool)); assert.throws(() => parseCodexBar([{ ...row, source: 'openai-web' }], pool));
  row.usage.primary = { usedPercent: 0, isSyntheticPlaceholder: true };
  row.usage.extraRateWindows[0].usageKnown = false;
  const unknown = parseCodexBar(row, pool); assert.equal(unknown.windows.length, 2); assert.equal(unknown.windows[1].known, false);
});
test('Claude statusline retains independent missing windows and rejects invented values', () => {
  const time = new Date().toISOString(), reset = Math.floor(Date.now() / 1000) + 600;
  const q = parseClaudeStatusline({ rate_limits: { seven_day: { used_percentage: 42.5, resets_at: reset } } }, 'claude', time);
  assert.equal(q.windows.length, 1); assert.equal(q.windows[0].usedPercent, 42.5); assert.equal(q.observedAt, time);
  assert.throws(() => parseClaudeStatusline({ rate_limits: { five_hour: { resets_at: reset } } }, 'claude', time));
});
test('failed collector retains original timestamp and cooldown prevents repeated auth probing', async t => {
  const f = await fixture(t); f.config.pools[0].collector = { command: '/nonexistent-synthetic-codexbar', provider: 'codex', source: 'cli', windowModels: {} };
  const store = new Store(f.config), before = store.quotas().get('codex');
  await refreshQuotas(f.config, store, true); const first = store.refreshStatus();
  assert.match(first[0].status, /UNAVAILABLE/); assert.equal(store.quotas().get('codex').observedAt, before.observedAt);
  await refreshQuotas(f.config, store, true); assert.deepEqual(store.refreshStatus(), first); store.close();
});
test('exact benchmark variant/cohort mapping; stale, missing and non-code relevance are neutral', () => {
  const a = benchmark('public-a', .8), b = benchmark('public-b', .4), c = candidate('local-a', 'codex', { benchmarks: [mapping(a)] });
  assert.equal(benchmarkScore(c, [a,b], 100000, 'coding').score, 1);
  assert.equal(benchmarkScore(c, [a,b], 100000, 'general').score, undefined);
  assert.equal(benchmarkScore({ ...c, benchmarks: [{ ...mapping(a), variant: 'fixture:max' }] }, [a,b], 100000, 'coding').score, undefined);
  assert.equal(benchmarkScore(c, [{ ...a, observedAt: new Date(0).toISOString() },b], 100000, 'coding').score, undefined);
  assert.equal(benchmarkScore(c, [a], 100000, 'coding').score, undefined);
  const tie = benchmark('public-b', .8); assert.equal(benchmarkScore(c, [a,tie], 100000, 'coding').score, .5);
});
test('source adapters retain nulls as missing, source effort/configuration and methodology', () => {
  const data = { generated_at: new Date().toISOString(), unit: 'Synthetic pass rate definition', n_tasks_in_set: 113, rows: [
    { model: 'model-a', harness: 'fixture-harness', config: 'fixture-config', reasoning_effort: 'xhigh', pass_at_1: .8, n_tasks_attempted: 113, n_attempted: 452 },
    { model: 'model-b', harness: 'fixture-harness', config: 'fixture-short', reasoning_effort: 'high', pass_at_1: .9, n_tasks_attempted: 50, n_attempted: 100 },
  ] };
  const deep = parseDeepSWE(data); assert.equal(deep.length, 1); assert.equal(deep[0].variant, 'fixture-harness:xhigh:fixture-config');
  assert.match(deep[0].methodology, /Publication time/);
  const aa = parseArtificialAnalysis({ intelligence_index_version: 4.3, data: [{ slug: 'synthetic-id', name: 'Synthetic (high)', evaluations: { artificial_analysis_intelligence_index: 61, artificial_analysis_coding_index: null } }] });
  assert.equal(aa.length, 1); assert.equal(aa[0].cohort, 'index-v4.3'); assert.match(aa[0].methodology, /patch version.*unspecified/);
});
