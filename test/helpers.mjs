import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialConfig, privateJson } from '../dist/config.js';
import { Store } from '../dist/store.js';

export const candidate = (id, pool = 'codex', extra = {}) => ({ id, model: `openai-codex/${id}`, thinking: 'high', roles: ['builder'], harnesses: ['pi','native'], pool, fit: `Synthetic guidance for ${id}`, prior: 0.7, rank: 0, enabled: true, profiles: ['synthetic'], benchmarks: [], ...extra });
export const request = { role: 'builder', task: 'Implement a parser', harness: 'pi' };
export const quota = (pool, usedPercent = 20, extra = {}) => ({ version: 1, pool, source: 'synthetic', observedAt: new Date().toISOString(), windows: [{ id: 'weekly', usedPercent, resetAt: new Date(Date.now() + 86400000).toISOString() }], warnings: [], ...extra });
export const benchmark = (model, value, extra = {}) => ({ source: 'deepswe', model, variant: 'fixture:high', metric: 'pass_at_1', cohort: 'synthetic', value, higherIsBetter: true, observedAt: new Date().toISOString(), sourceUrl: 'https://example.test/benchmark', methodology: 'Synthetic test fixture', ...extra });
export const mapping = b => ({ source: b.source, model: b.model, variant: b.variant, metric: b.metric, cohort: b.cohort, evidenceUrl: 'https://example.test/mapping', verifiedAt: new Date().toISOString() });
export async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-router-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json'), config = initialConfig(path);
  config.jev.enabled = false;
  config.candidates = [candidate('a'), candidate('b', 'claude', { model: 'claude-bridge/b' })];
  const save = () => privateJson(path, config);
  await save();
  const store = new Store(config);
  store.putQuota(quota('codex')); store.putQuota(quota('claude')); store.close();
  return { dir, path, config, save, options: { configPath: path } };
}
