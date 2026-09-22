import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importProfiles } from '../dist/profiles.js';
import { route } from '../dist/index.js';
import { fixture } from './helpers.mjs';

test('catalog defaults and recommendation efforts remain eligible across roles; ranks stay role-specific', async t => {
  const f = await fixture(t), profiles = join(f.dir, 'profiles');
  await mkdir(profiles);
  const astra = 'openai-codex/astra', sol = 'openai-codex/sol', luna = 'openai-codex/luna';
  await writeFile(join(profiles, 'ACTIVE'), 'active');
  await writeFile(join(profiles, 'active.json'), JSON.stringify({
    name: 'active',
    models: {
      [astra]: { character: 'Broad implementation.', defaultThinking: 'xhigh' },
      [sol]: { character: 'Fresh-context checking.', defaultThinking: 'high' },
      [luna]: { character: 'Optional economical browser checks.', defaultThinking: 'max' },
      'openai-codex/no-effort': { character: 'Do not infer an effort from a model name.' },
    },
    recommendations: {
      advisor: [],
      builder: [{ model: astra, thinking: 'xhigh', fit: 'Preferred builder.' }, { model: sol, thinking: 'max', fit: 'Wide work.' }],
      checker: [{ model: sol, thinking: 'high', fit: 'Preferred checker.' }],
    },
  }));
  f.config.candidates = await importProfiles(profiles);
  assert.equal(f.config.candidates.length, 4);
  const a = f.config.candidates.find(c => c.model === astra);
  const l = f.config.candidates.find(c => c.model === luna);
  assert.deepEqual(new Set(a.roles), new Set(['advisor', 'builder', 'checker']));
  assert.equal(a.roleRanks.builder, 0);
  assert.equal(a.roleRanks.checker, 1000, 'builder preference must not leak into checker fallback');
  assert.equal(l.thinking, 'max'); assert.deepEqual(l.harnesses, ['pi']);
  assert.match(l.fit, /Optional economical browser checks/);
  await f.save();
  const input = { role: 'checker', task: 'Review a change', harness: 'pi' };
  assert.equal((await route(input, { ...f.options, dryRun: true })).selected.model, sol);
  assert.equal((await route({ ...input, pin: { model: astra, thinking: 'xhigh' } }, { ...f.options, dryRun: true })).selected.model, astra);
  assert.equal((await route({ ...input, pin: { model: luna, thinking: 'max' } }, { ...f.options, dryRun: true })).selected.model, luna);
  await assert.rejects(route({ ...input, harness: 'native', pin: { model: luna, thinking: 'max' } }, f.options), { code: 'AGENT_ROUTER_NO_FEASIBLE_ROUTE' });
  a.roles = ['builder']; a.roleRanks = { builder: 0 }; await f.save();
  await assert.rejects(route({ ...input, pin: { model: astra, thinking: 'xhigh' } }, f.options), { code: 'AGENT_ROUTER_NO_FEASIBLE_ROUTE' });
});
