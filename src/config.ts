import { readFile, mkdir, writeFile, rename, chmod, link, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RouterError, type Config, type RouteRequest, type BenchmarkRef, type BenchmarkObservation, type QuotaSnapshot } from './types.js';

export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new RouterError('AGENT_ROUTER_INVALID_INPUT', message);
}
export function object(value: unknown): Record<string, any> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  return value as Record<string, any>;
}
export function text(value: unknown, max = 4096): asserts value is string {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'Invalid string');
}
export function number(value: unknown, min: number, max: number): asserts value is number {
  check(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, 'Invalid numeric value');
}
export function strings(value: unknown): asserts value is string[] {
  check(Array.isArray(value) && value.length <= 1000, 'Expected bounded string array');
  for (const item of value) text(item);
}
export function timestamp(value: unknown): asserts value is string {
  text(value, 64);
  check(/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), 'Invalid timestamp');
}
export const defaultConfigPath = () => process.env.AGENT_ROUTER_CONFIG || join(homedir(), '.config', 'agent-router', 'config.json');
export async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  check(Buffer.byteLength(raw) <= 8_000_000, 'JSON input exceeds size limit');
  return JSON.parse(raw);
}
export async function privateJson(path: string, value: unknown, exclusive = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    if (exclusive) await link(tmp, path);
    else await rename(tmp, path);
    await chmod(path, 0o600);
  } finally { await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export function benchmarkRef(value: unknown): BenchmarkRef {
  const v = object(value);
  check(['deepswe', 'artificial-analysis'].includes(v.source), 'Invalid benchmark source');
  for (const field of ['model', 'variant', 'metric', 'cohort']) text(v[field]);
  return v as BenchmarkRef;
}
export function benchmarks(value: unknown): BenchmarkObservation[] {
  check(Array.isArray(value) && value.length <= 10000, 'Invalid benchmark observations');
  const seen = new Set<string>();
  for (const entry of value) {
    const v = object(benchmarkRef(entry));
    number(v.value, -1e9, 1e9);
    check(typeof v.higherIsBetter === 'boolean', 'Missing score direction');
    timestamp(v.observedAt);
    check(Date.parse(v.observedAt) <= Date.now() + 60000, 'Benchmark observation is in the future');
    text(v.sourceUrl); text(v.methodology);
    const url = new URL(v.sourceUrl);
    check(url.protocol === 'https:' && !url.username && !url.password, 'Invalid benchmark source URL');
    if (v.sampleSize !== undefined) number(v.sampleSize, 1, 1e9);
    const key = JSON.stringify([v.source, v.model, v.variant, v.metric, v.cohort]);
    check(!seen.has(key), 'Duplicate benchmark identity'); seen.add(key);
  }
  return value as BenchmarkObservation[];
}
export function quotaSnapshot(value: unknown): QuotaSnapshot {
  const v = object(value);
  check(v.version === 1, 'Unsupported quota snapshot');
  text(v.pool); text(v.source); timestamp(v.observedAt);
  if (v.binding !== undefined) check(typeof v.binding === 'string' && /^[a-f0-9]{64}$/.test(v.binding), 'Invalid quota binding');
  check(Date.parse(v.observedAt) <= Date.now() + 60000, 'Quota observation is in the future');
  check(Array.isArray(v.windows) && v.windows.length <= 100, 'Invalid quota windows');
  strings(v.warnings);
  if (v.gates !== undefined) {
    check(Array.isArray(v.gates) && v.gates.length <= 100, 'Invalid quota gates');
    const gates = new Set<string>();
    for (const raw of v.gates) {
      const g = object(raw); text(g.id); check(!gates.has(g.id), 'Duplicate quota gate'); gates.add(g.id);
      check(g.allowed === null || typeof g.allowed === 'boolean', 'Invalid provider permission');
      timestamp(g.observedAt); check(Date.parse(g.observedAt) <= Date.parse(v.observedAt), 'Permission newer than snapshot');
      if (g.models !== undefined) strings(g.models);
    }
  }
  const ids = new Set<string>();
  for (const entry of v.windows) {
    const w = object(entry);
    text(w.id); check(!ids.has(w.id), 'Duplicate quota window'); ids.add(w.id);
    number(w.usedPercent, 0, 1e6);
    if (w.known !== undefined) check(typeof w.known === 'boolean', 'Invalid quota-known flag');
    if (w.resetAt !== undefined) timestamp(w.resetAt);
    if (w.windowMinutes !== undefined) number(w.windowMinutes, 1, 1e9);
    if (w.models !== undefined) strings(w.models);
  }
  return v as QuotaSnapshot;
}
export function validateRequest(value: unknown): RouteRequest {
  const v = object(value);
  check(Object.keys(v).every(k => ['role', 'task', 'harness', 'pin', 'requestId'].includes(k)), 'Unsupported route request field');
  text(v.role, 64); text(v.task, 32768);
  check(['pi', 'native'].includes(v.harness), 'Invalid harness');
  if (v.requestId !== undefined) text(v.requestId, 256);
  if (v.pin !== undefined) {
    const pin = object(v.pin);
    check(Object.keys(pin).every(k => ['model', 'thinking'].includes(k)), 'Invalid pin field');
    text(pin.model, 256);
    if (pin.thinking !== undefined) check(thinkingLevels.includes(pin.thinking), 'Invalid reasoning effort');
  }
  return v as RouteRequest;
}
export async function loadConfig(path = defaultConfigPath()): Promise<Config> {
  return parseConfig(await readJson(path));
}
export function parseConfig(value: unknown): Config {
  const c = object(value);
  check(c.version === 1 && typeof c.enabled === 'boolean', 'Unsupported router config');
  for (const field of ['modulePath', 'stateDir', 'credentialsFile']) {
    text(c[field]); check(isAbsolute(c[field]), `${field} must be absolute`);
  }
  if (c.benchmarkFile !== undefined) { text(c.benchmarkFile); check(isAbsolute(c.benchmarkFile), 'benchmarkFile must be absolute'); }
  check(Array.isArray(c.pools) && c.pools.length > 0 && c.pools.length <= 100, 'Invalid quota pools');
  const pools = new Set<string>();
  for (const raw of c.pools) {
    const p = object(raw); text(p.id); check(!pools.has(p.id), 'Duplicate pool'); pools.add(p.id);
    number(p.reservePercent, 0, 100); number(p.maxConcurrent, 1, 1000);
    check(Number.isInteger(p.maxConcurrent), 'Concurrency must be integer');
    check(['allow', 'penalize', 'exclude'].includes(p.unknown), 'Unknown quota policy required');
    if (p.collector !== undefined) {
      const s = object(p.collector);
      check(['codex', 'claude'].includes(s.provider) && ['cli', 'oauth', 'app-server'].includes(s.source), 'Only explicit CLI/OAuth/app-server collectors supported');
      if (s.source === 'app-server') check(s.provider === 'codex' && s.account === undefined, 'App-server uses the active Codex CLI account; account selection is not supported');
      text(s.command);
      if (s.account !== undefined) text(s.account);
      for (const models of Object.values(object(s.windowModels))) strings(models);
    }
  }
  check(Array.isArray(c.candidates) && c.candidates.length > 0 && c.candidates.length <= 100, 'Invalid candidate catalog');
  const ids = new Set<string>();
  for (const raw of c.candidates) {
    const v = object(raw);
    text(v.id); check(!ids.has(v.id), 'Duplicate candidate'); ids.add(v.id);
    text(v.model, 256); check(v.model.includes('/'), 'Model must include provider');
    check(thinkingLevels.includes(v.thinking), 'Invalid reasoning effort');
    strings(v.roles); strings(v.harnesses); strings(v.profiles);
    check(v.roles.length > 0 && v.harnesses.length > 0 && v.harnesses.every((h: string) => ['pi', 'native'].includes(h)), 'Invalid candidate capabilities');
    check(pools.has(v.pool), 'Candidate references unknown quota pool');
    text(v.fit, 16384); number(v.prior, 0, 1); number(v.rank, 0, 1e6);
    if (v.roleRanks !== undefined) for (const [role, rank] of Object.entries(object(v.roleRanks))) {
      check(v.roles.includes(role), 'Rank references unconfigured role'); number(rank, 0, 1e6);
    }
    check(typeof v.enabled === 'boolean' && Array.isArray(v.benchmarks) && v.benchmarks.length <= 20, 'Invalid candidate');
    v.benchmarks.forEach((mapping: unknown) => {
      const m = object(benchmarkRef(mapping));
      text(m.evidenceUrl); timestamp(m.verifiedAt);
      check(new URL(m.evidenceUrl).protocol === 'https:', 'Benchmark mapping needs HTTPS evidence');
    });
  }
  const p = object(c.policy);
  for (const k of ['quotaMaxAgeMs', 'refreshCooldownMs', 'refreshTimeoutMs', 'leaseMs', 'benchmarkMaxAgeMs']) number(p[k], 1, 365 * 86400000);
  check(p.leaseMs >= 60000 && p.refreshTimeoutMs <= 60000, 'Invalid lease/refresh bounds');
  for (const k of ['benchmarkWeight', 'capacityWeight', 'unknownPenalty']) number(p[k], 0, 1);
  check(p.benchmarkWeight <= 0.5, 'Benchmarks may not dominate task fit');
  const j = object(c.jev); text(j.model, 128); number(j.timeoutMs, 1, 60000); number(j.minConfidence, 0, 1);
  check(typeof j.enabled === 'boolean', 'Invalid Jev configuration');
  return c as Config;
}
export function initialConfig(path = defaultConfigPath()): Config {
  const home = dirname(resolve(path));
  return {
    version: 1, enabled: true, modulePath: fileURLToPath(new URL('./index.js', import.meta.url)),
    stateDir: join(home, 'state'), credentialsFile: join(home, 'credentials.json'), benchmarkFile: join(home, 'benchmarks.json'), candidates: [],
    pools: [
      { id: 'codex', reservePercent: 10, maxConcurrent: 3, unknown: 'penalize' },
      { id: 'claude', reservePercent: 10, maxConcurrent: 3, unknown: 'penalize' },
      { id: 'cursor', reservePercent: 10, maxConcurrent: 2, unknown: 'exclude' },
    ],
    policy: { quotaMaxAgeMs: 300000, refreshCooldownMs: 60000, refreshTimeoutMs: 20000, leaseMs: 300000,
      benchmarkMaxAgeMs: 90 * 86400000, benchmarkWeight: 0.15, capacityWeight: 0.2, unknownPenalty: 0.2 },
    jev: { enabled: true, model: 'jev-latest', timeoutMs: 10000, minConfidence: 0.35 },
  };
}
export async function credential(config: Config, name: 'typesafe' | 'artificialAnalysis'): Promise<string | undefined> {
  const env = process.env[name === 'typesafe' ? 'TYPESAFE_API_KEY' : 'ARTIFICIAL_ANALYSIS_API_KEY'];
  if (env?.trim()) return env.trim();
  try {
    const value = object(await readJson(config.credentialsFile))[name];
    if (value === undefined) return undefined;
    text(value); return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new RouterError('AGENT_ROUTER_CREDENTIALS', 'Cannot read valid private credentials');
  }
}
