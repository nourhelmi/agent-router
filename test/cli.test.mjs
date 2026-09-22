import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, request } from './helpers.mjs';
import { importProfiles } from '../dist/profiles.js';
const exec = promisify(execFile), cli = new URL('../dist/cli.js', import.meta.url).pathname;

test('CLI initialization imports union, preserves ACTIVE as tie-break only, refuses overwrite', async t => {
  const f = await fixture(t), profiles = join(f.dir, 'profiles'); await mkdir(profiles);
  const guide = { name: 'one', models: { 'openai-codex/synthetic': { character: 'Synthetic worker' } }, recommendations: { builder: [{ model: 'openai-codex/synthetic', thinking: 'high', fit: 'Synthetic scoped implementation' }] } };
  await writeFile(join(profiles, 'one.json'), JSON.stringify(guide)); await writeFile(join(profiles, 'ACTIVE'), 'two');
  await writeFile(join(profiles, 'two.json'), JSON.stringify({ ...guide, name: 'two', recommendations: { checker: guide.recommendations.builder } }));
  const candidates = await importProfiles(profiles); assert.equal(candidates.length, 1); assert.deepEqual(candidates[0].roles.sort(), ['advisor','builder','checker']);
  assert.equal(candidates[0].rank, 0); assert.equal(candidates[0].benchmarks.length, 0);
  const path = join(f.dir, 'new-config.json');
  const args = [cli, 'init', '--profiles', profiles, '--config', path];
  const result = JSON.parse((await exec(process.execPath, args)).stdout); assert.equal(result.candidates, 1);
  const before = await readFile(path, 'utf8'); await assert.rejects(exec(process.execPath, args)); assert.equal(await readFile(path, 'utf8'), before);
});
test('CLI routes fixture, reports status, and packaged files omit state and credentials', async t => {
  const f = await fixture(t), input = join(f.dir, 'request.json'); await writeFile(input, JSON.stringify(request));
  const args = [cli, 'route', '--config', f.path, '--file', input, '--dry-run'];
  const decision = JSON.parse((await exec(process.execPath, args)).stdout); assert.equal(decision.reserved, false);
  const status = JSON.parse((await exec(process.execPath, [cli, 'status', '--config', f.path])).stdout); assert.deepEqual(status.active, {});
  const pack = JSON.parse((await exec('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: new URL('../', import.meta.url).pathname })).stdout)[0];
  assert.ok(pack.files.some(f => f.path === 'dist/index.js')); assert.ok(pack.files.some(f => f.path === 'dist/index.d.ts'));
  assert.equal(pack.files.some(f => /credentials|sqlite|\.env|config\.json|test\//.test(f.path)), false);
});
