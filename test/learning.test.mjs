import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { route } from '../dist/index.js';
import { outcomes, parseConfig } from '../dist/config.js';
import { Store } from '../dist/store.js';
import { candidate, fixture, request } from './helpers.mjs';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const days = n => new Date(Date.now() - n * 86400000).toISOString();
const outcome = (id, extra = {}) => ({ version: 1, id, at: days(0), model: 'openai-codex/a', thinking: 'high', role: 'builder',
  signal: 'review', success: false, source: 'test', ...extra });
const pick = async f => (await route(request, { ...f.options, dryRun: true }));
function record(f, list) { const store = new Store(f.config); store.putOutcomes(list); store.close(); }

test('cost breaks near-ties toward the cheaper candidate; a real fit gap still wins; unpriced counts as dearest', async t => {
  const f = await fixture(t);
  f.config.candidates = [candidate('a', 'codex', { cost: 0.9 }), candidate('b', 'codex', { cost: 0.1 })];
  await f.save();
  assert.equal((await pick(f)).candidateId, 'a', 'cost is ignored at the default weight');
  f.config.policy.costWeight = 0.15; await f.save();
  const cheap = await pick(f);
  assert.equal(cheap.candidateId, 'b');
  assert.equal(cheap.candidates.find(c => c.id === 'a').cost, 0.9);
  f.config.candidates[0].prior = 0.95; f.config.candidates[1].prior = 0.6; await f.save();
  assert.equal((await pick(f)).candidateId, 'a', 'a fit gap larger than the cost gap still wins');
  f.config.candidates[0].prior = 0.7; f.config.candidates[1].prior = 0.7; delete f.config.candidates[1].cost; await f.save();
  const unpriced = await pick(f);
  assert.equal(unpriced.candidateId, 'a');
  assert.ok(unpriced.candidates.find(c => c.id === 'b').reasons.includes('cost-unset'));
});

test('reviewed outcomes move fit per role, decay with age, and match models without their provider', async t => {
  const f = await fixture(t);
  f.config.candidates = [candidate('a', 'codex', { prior: 0.72, roles: ['builder', 'checker'] }), candidate('b', 'codex', { roles: ['builder', 'checker'] })];
  f.config.policy.outcomeWeight = 0.5; await f.save();
  assert.equal((await pick(f)).candidateId, 'a');

  record(f, [1, 2, 3].map(n => outcome(`old-${n}`, { at: days(365) })));
  assert.equal((await pick(f)).candidateId, 'a', 'year-old failures barely count');

  record(f, [1, 2, 3].map(n => outcome(`checker-${n}`, { role: 'checker' })));
  assert.equal((await pick(f)).candidateId, 'a', 'checker verdicts do not judge building');

  record(f, [1, 2, 3].map(n => outcome(`fresh-${n}`, { model: 'a' })));
  const decision = await pick(f);
  assert.equal(decision.candidateId, 'b');
  const a = decision.candidates.find(c => c.id === 'a');
  assert.ok(a.outcome.n > 3 && a.outcome.n < 3.1 && a.outcome.mean < 0.72);
  assert.equal(decision.candidates.find(c => c.id === 'b').outcome, undefined, 'no evidence leaves fit untouched');

  f.config.policy.outcomeWeight = 0; await f.save();
  assert.equal((await pick(f)).candidateId, 'a', 'weight 0 ignores the track record');
});

test('outcome input is strict, and recording an existing id replaces it', async t => {
  assert.throws(() => outcomes({ ...outcome('x'), extra: 1 }), /Unsupported outcome field/);
  assert.throws(() => outcomes(outcome('x', { at: new Date(Date.now() + 3600000).toISOString() })), /future/);
  assert.throws(() => outcomes(outcome('x', { signal: 'self' })), /signal/);
  assert.throws(() => outcomes(outcome('x', { thinking: 'ultra-max' })), /effort/);
  assert.equal(outcomes(outcome('x')).length, 1, 'a single object is accepted');

  const f = await fixture(t);
  record(f, [outcome('grade-1')]);
  record(f, [outcome('grade-1', { success: true, signal: 'grade' })]);
  const store = new Store(f.config); const all = store.outcomes(); store.close();
  assert.equal(all.length, 1); assert.equal(all[0].success, true);
});

test('CLI records outcomes and reports the track record per candidate and role', async t => {
  const f = await fixture(t);
  const run = (args, input) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--config', f.path], { input, encoding: 'utf8' }));
  assert.deepEqual(run(['outcomes', 'record', '--file', '-'], JSON.stringify([outcome('c1'), outcome('c2', { success: true }), outcome('c3', { model: 'nope' })])), { recorded: 3 });
  const stats = run(['outcomes', 'stats']);
  assert.equal(stats.outcomes, 3); assert.equal(stats.unmatched, 1);
  assert.equal(stats.candidates.length, 1);
  assert.deepEqual({ ...stats.candidates[0], mean: undefined, weight: undefined },
    { candidate: 'a', role: 'builder', outcomes: 2, successes: 1, prior: 0.7, mean: undefined, weight: undefined });
});

test('policy additions default off for older configs and reject out-of-range values', async t => {
  const f = await fixture(t);
  const legacy = structuredClone(f.config);
  for (const k of ['costWeight', 'outcomeWeight', 'outcomePrior', 'outcomeHalfLifeMs']) delete legacy.policy[k];
  const parsed = parseConfig(legacy);
  assert.equal(parsed.policy.costWeight, 0); assert.equal(parsed.policy.outcomeWeight, 0);
  assert.throws(() => parseConfig({ ...structuredClone(f.config), policy: { ...f.config.policy, costWeight: 2 } }));
  assert.throws(() => parseConfig({ ...structuredClone(f.config), candidates: [{ ...candidate('a'), cost: -1 }] }));
});
