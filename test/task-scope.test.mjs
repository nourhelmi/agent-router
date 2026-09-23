import test from 'node:test';
import assert from 'node:assert/strict';
import { route, renew, release } from '../dist/index.js';
import { parseConfig, privateJson } from '../dist/config.js';
import { evaluate } from '../dist/engine.js';
import { fitCriteria } from '../dist/jev.js';
import { Store } from '../dist/store.js';
import { candidate, fixture, quota, request } from './helpers.mjs';

const luna = 'openai-codex/gpt-6-luna';
const noRoute = { code: 'AGENT_ROUTER_NO_FEASIBLE_ROUTE' };
async function scopedFixture(t) {
  const f = await fixture(t);
  f.config.candidates[0] = candidate('luna', 'codex', {
    model: luna, thinking: 'max', roles: ['builder', 'checker'], prior: 1,
    taskScope: 'small-or-verification',
  });
  f.config.candidates[1].roles = ['advisor', 'builder', 'checker'];
  f.config.jev.enabled = true;
  await privateJson(f.config.credentialsFile, { typesafe: 'synthetic-scope-key' });
  await f.save();
  return f;
}
function mockJev(t, mutate = () => {}) {
  return t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body.state).sort(), ['candidates', 'role', 'task']);
    const answers = { family: { type: 'choice', choice: 'coding', confidence: 1, probabilities: { coding: 1, general: 0 } } };
    body.state.candidates.forEach((c, i) => {
      const score = c.model === luna ? 4 : 1;
      answers[`c${i}`] = { type: 'score', score, confidence: 1,
        probabilities: Object.fromEntries(fitCriteria.map((_, n) => [n, +(n === score)])),
        legend: Object.fromEntries(fitCriteria.map((v, n) => [n, v])) };
    });
    if (body.questions.smallTask) {
      assert.equal(body.questions.smallTask.type, 'noul');
      assert.equal(body.questions.verificationOnly.type, 'noul');
      answers.smallTask = { type: 'noul', noul: 0.99 };
      answers.verificationOnly = { type: 'noul', noul: 0.01 };
    }
    const data = { model: 'jev-scope-fixture', answers };
    await mutate(data, body);
    return Response.json(data);
  });
}

test('task scope is validated and defaults to closed admission before classification', async t => {
  const f = await scopedFixture(t);
  assert.equal(parseConfig(f.config).candidates[0].taskScope, 'small-or-verification');
  const rows = evaluate(f.config, request, new Map([['codex', quota('codex')]]), new Map(), []);
  assert.equal(rows[0].eligible, false);
  assert.ok(rows[0].reasons.includes('task-scope-unconfirmed'));
  for (const value of [null, false, '', 'small', [], {}]) {
    const config = structuredClone(f.config); config.candidates[0].taskScope = value;
    assert.throws(() => parseConfig(config), /task scope/i);
  }
});

test('small OR verification admits max only; uncertain and negative answers cannot be averaged into permission', async t => {
  const f = await scopedFixture(t);
  for (const [small, verification, allowed] of [[.99, .01, true], [.01, .99, true], [.9, 0, true], [.899, 0, false], [.7, .7, false], [0, 0, false]]) {
    const mock = mockJev(t, data => {
      data.answers.smallTask.noul = small; data.answers.verificationOnly.noul = verification;
    });
    const d = await route({ ...request, role: 'checker' }, { ...f.options, dryRun: true });
    assert.equal(d.selected.model === luna, allowed);
    assert.equal(d.candidates[0].eligible, allowed);
    assert.deepEqual(d.candidates[0].taskScope, { small, verification });
    if (allowed) assert.equal(d.selected.thinking, 'max');
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});

test('missing, malformed, unavailable or disabled scope judgment never lets fallback admit Luna', async t => {
  const f = await scopedFixture(t);
  for (const invalid of [undefined, { type: 'score', noul: 1 }, { type: 'noul', noul: '1' }, { type: 'noul', noul: 1.01 }, { type: 'noul', noul: -.01 }, { type: 'noul', noul: null }]) {
    const mock = mockJev(t, data => { data.answers.smallTask = invalid; });
    const d = await route(request, { ...f.options, dryRun: true });
    assert.notEqual(d.selected.model, luna); assert.equal(d.strategy, 'fallback');
    assert.ok(d.candidates[0].reasons.includes('task-scope-unconfirmed'));
    mock.mock.restore();
  }
  const failure = t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic unavailable'); });
  assert.notEqual((await route(request, f.options)).selected.model, luna);
  failure.mock.restore();
  f.config.jev.enabled = false; await f.save();
  const never = t.mock.method(globalThis, 'fetch', () => { throw new Error('MUST NOT FETCH'); });
  for (const role of ['builder', 'checker', 'worker', 'freeform']) {
    assert.notEqual((await route({ ...request, role }, f.options)).selected.model, luna);
    await assert.rejects(route({ ...request, role, pin: { model: luna } }, f.options), noRoute);
  }
  assert.equal(never.mock.callCount(), 0);
});

test('pins obey scope and exact roster; unrestricted pins still skip Jev', async t => {
  const f = await scopedFixture(t);
  const r = { ...request, task: 'Check the supplied patch and report findings only.', pin: { model: luna, thinking: 'max' } };
  const mock = mockJev(t);
  const d = await route(r, f.options);
  assert.deepEqual(d.selected, { model: luna, thinking: 'max' }); assert.equal(d.strategy, 'pinned');
  assert.equal(mock.mock.callCount(), 1); mock.mock.restore();
  const deny = mockJev(t, data => { data.answers.smallTask.noul = 0; data.answers.verificationOnly.noul = 0; });
  await assert.rejects(route(r, f.options), noRoute);
  assert.equal(deny.mock.callCount(), 1);
  for (const pin of [{ model: luna, thinking: 'xhigh' }, { model: 'openai-codex/gpt-5.6-sol' }, { model: 'claude-bridge/claude-sonnet-5' }]) {
    await assert.rejects(route({ ...request, pin }, f.options), noRoute);
  }
  await assert.rejects(route({ ...r, role: 'advisor' }, f.options), noRoute);
  await assert.rejects(route({ ...r, harness: 'native' }, f.options), noRoute);
  assert.equal(deny.mock.callCount(), 1);
  const normal = await route({ ...request, pin: { model: 'claude-bridge/b' } }, f.options);
  assert.equal(normal.strategy, 'pinned'); assert.equal(deny.mock.callCount(), 1);
  const store = new Store(f.config);
  try { assert.equal(store.active().get('codex'), 1); } finally { store.close(); }
});

test('scope never overrides quota; newly feasible candidates need an actual scope judgment', async t => {
  const f = await scopedFixture(t);
  const deny = mockJev(t, () => {
    const store = new Store(f.config); store.putQuota(quota('codex', 100)); store.close();
  });
  assert.notEqual((await route(request, f.options)).selected.model, luna);
  deny.mock.restore();
  const recover = mockJev(t, (_data, body) => {
    assert.equal(body.questions.smallTask, undefined);
    assert.ok(body.state.candidates.every(c => c.model !== luna));
    const store = new Store(f.config); store.putQuota(quota('codex', 0)); store.close();
  });
  const d = await route(request, f.options);
  assert.notEqual(d.selected.model, luna);
  assert.ok(d.candidates[0].reasons.includes('task-scope-unconfirmed'));
  assert.equal(recover.mock.callCount(), 1);
});

test('scope applies to fresh admissions, preserving exact live lease replay/renew/release', async t => {
  const f = await scopedFixture(t), mock = mockJev(t);
  const r = { ...request, requestId: 'scoped-lease', pin: { model: luna } };
  const d = await route(r, f.options);
  f.config.candidates[0].enabled = false; f.config.jev.enabled = false; await f.save();
  assert.equal((await route(r, f.options)).id, d.id);
  await renew(d.id, f.options);
  await assert.rejects(route({ ...r, task: 'Implement a large new subsystem' }, f.options), { code: 'AGENT_ROUTER_REQUEST_CONFLICT' });
  await assert.rejects(route({ ...r, requestId: 'fresh' }, f.options), noRoute);
  await release(d.id, f.options);
  await assert.rejects(renew(d.id, f.options), { code: 'AGENT_ROUTER_LEASE_EXPIRED' });
  assert.equal(mock.mock.callCount(), 1);
});

test('route captures caller-owned task and pin before any await', async t => {
  const f = await scopedFixture(t);
  const original = { ...request, task: 'Correct one typo.', requestId: 'captured', pin: { model: luna, thinking: 'max' } };
  const mutable = structuredClone(original);
  const mock = mockJev(t, (_data, body) => {
    assert.equal(body.state.task, original.task);
    assert.equal(body.state.candidates[0].model, luna);
  });
  const pending = route(mutable, f.options);
  mutable.task = 'Design and implement a major subsystem'; mutable.pin.model = 'claude-bridge/b';
  const d = await pending;
  assert.deepEqual(d.selected, { model: luna, thinking: 'max' });
  assert.equal((await route(original, f.options)).id, d.id);
  assert.equal(mock.mock.callCount(), 1);
});
