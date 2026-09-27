import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { route } from '../dist/index.js';
import { loadConfig, privateJson, rosterCandidates } from '../dist/config.js';
import { fixture } from './helpers.mjs';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const roster = { models: [
  { model: 'claude/claude-opus-5-5', effort: 'high', roles: ['advisor', 'builder'], cost: 1, about: 'best judgment',
    use: 'open product decisions', avoid: 'routine implementation' },
  { model: 'opencode/opencode-go/kimi-k3', effort: 'max', roles: ['builder', 'checker'], cost: 0.1, use: 'bounded implementation' },
  { model: 'codex/gpt-6-luna', effort: 'max', roles: ['checker'], cost: 0.05, use: 'scripted checks', scope: 'small-or-verification', enabled: false },
] };

test('a roster expands into candidates: host is the pool, file order is preference per role', () => {
  const [opus, kimi, luna] = rosterCandidates(roster);
  assert.equal(opus.id, 'claude/claude-opus-5-5@high'); assert.equal(opus.pool, 'claude');
  assert.equal(opus.fit, 'claude-opus-5-5 at high: best judgment.\nUse for: open product decisions\nNot for: routine implementation');
  assert.deepEqual(opus.roleRanks, { advisor: 0, builder: 0 });
  assert.equal(kimi.pool, 'opencode'); assert.deepEqual(kimi.roleRanks, { builder: 1, checker: 0 }); assert.equal(kimi.rank, 0);
  assert.deepEqual(kimi.harnesses, ['native']); assert.equal(kimi.cost, 0.1); assert.equal(kimi.prior, 0.7);
  assert.equal(luna.taskScope, 'small-or-verification'); assert.equal(luna.enabled, false);
  assert.throws(() => rosterCandidates({ models: [{ ...roster.models[0], model: 'no-host' }] }), /<host>\/<model id>/);
  assert.throws(() => rosterCandidates({ models: [{ ...roster.models[0], fit: 'x' }] }), /Unsupported roster field/);
  assert.throws(() => rosterCandidates({ models: [] }), /nonempty/);
});

test('rosterFile replaces inline candidates on every load and adds unpenalized pools for new hosts', async t => {
  const f = await fixture(t);
  const file = join(f.dir, 'roster.json'); await writeFile(file, JSON.stringify(roster));
  await privateJson(f.path, { ...f.config, rosterFile: file });
  const config = await loadConfig(f.path);
  assert.deepEqual(config.candidates.map(c => c.id), roster.models.map(m => `${m.model}@${m.effort}`));
  assert.deepEqual(config.pools.find(p => p.id === 'opencode'), { id: 'opencode', reservePercent: 10, unknown: 'allow' });
  assert.equal(config.pools.find(p => p.id === 'claude').unknown, 'penalize', 'configured pools are kept');
  f.config.policy.costWeight = 0.15; await privateJson(f.path, { ...f.config, rosterFile: file });
  const d = await route({ role: 'builder', task: 'Implement a parser', harness: 'native' }, { configPath: f.path, dryRun: true });
  assert.equal(d.candidateId, 'opencode/opencode-go/kimi-k3@max', 'any host routes natively; cost breaks the prior tie');
});

test('CLI: init --roster needs no profiles, and roster use switches an existing config', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-router-roster-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'roster.json'); await writeFile(file, JSON.stringify(roster));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, HOME: dir } }));
  const path = join(dir, 'router.json');
  assert.equal(run('init', '--roster', file, '--config', path).candidates, 3);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(stored.candidates, []); assert.equal(stored.rosterFile, file);
  const other = join(dir, 'other.json');
  await writeFile(other, JSON.stringify({ models: [roster.models[1]] }));
  assert.deepEqual(run('roster', 'use', '--file', other, '--config', path).candidates, ['opencode/opencode-go/kimi-k3@max']);
  assert.throws(() => execFileSync(process.execPath, [cli, 'benchmarks', 'map', '--candidate', 'x', '--config', path], { stdio: 'pipe' }));
});
