import { readFile, mkdir, writeFile, rename, chmod, link, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RouterError, type Candidate, type Config, type RouteRequest, type BenchmarkRef, type BenchmarkObservation, type Outcome, type QuotaSnapshot, type RosterEntry } from './types.js';

export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new RouterError('AGENT_ROUTER_INVALID_INPUT', message);
}
export function object(value: unknown): Record<string, any> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  return value as Record<string, any>;
}
/** `label` names the field in the error; hand-edited files need it to be fixable. */
export function text(value: unknown, max = 4096, label?: string): asserts value is string {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, !label ? 'Invalid string'
    : `${label} must be text of 1-${max} characters${typeof value === 'string' ? ` (it is ${value.length})` : ''}`);
}
export function number(value: unknown, min: number, max: number, label?: string): asserts value is number {
  check(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max,
    label ? `${label} must be a number from ${min} to ${max}` : 'Invalid numeric value');
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
const OUTCOME_FIELDS = ['version', 'id', 'at', 'model', 'thinking', 'role', 'signal', 'success', 'source', 'run', 'note'];
export function outcomes(value: unknown): Outcome[] {
  const list = Array.isArray(value) ? value : [value];
  check(list.length > 0 && list.length <= 10000, 'Invalid outcomes');
  return list.map(raw => {
    const v = object(raw);
    check(Object.keys(v).every(k => OUTCOME_FIELDS.includes(k)), 'Unsupported outcome field');
    check(v.version === 1, 'Unsupported outcome version');
    text(v.id, 256); timestamp(v.at); check(Date.parse(v.at) <= Date.now() + 60000, 'Outcome is in the future');
    text(v.model, 256); check(thinkingLevels.includes(v.thinking), 'Invalid reasoning effort');
    text(v.role, 64); check(['review', 'grade'].includes(v.signal), 'Invalid outcome signal');
    check(typeof v.success === 'boolean', 'Outcome success must be boolean'); text(v.source, 64);
    if (v.run !== undefined) text(v.run, 256);
    if (v.note !== undefined) text(v.note, 2000);
    return v as Outcome;
  });
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
  // Capture the validated packet before routing awaits config, quotas or semantic judgments.
  return { ...v, ...(v.pin !== undefined ? { pin: { ...v.pin } } : {}) } as RouteRequest;
}
export async function loadConfig(path = defaultConfigPath()): Promise<Config> {
  const raw = object(await readJson(path));
  if (raw.rosterFile !== undefined) {
    text(raw.rosterFile); check(isAbsolute(raw.rosterFile), 'rosterFile must be absolute');
    applyRoster(raw, await readJson(raw.rosterFile));
  }
  return parseConfig(raw);
}
/** Replace a raw config's candidates with the roster's; a host without a pool gets one, quota unobserved and unpenalized. */
export function applyRoster(raw: Record<string, any>, roster: unknown): Record<string, any> {
  raw.candidates = rosterCandidates(roster);
  const pools = Array.isArray(raw.pools) ? raw.pools : [];
  for (const id of new Set(raw.candidates.map((c: Candidate) => c.pool))) {
    if (!pools.some((p: { id?: unknown }) => p.id === id)) pools.push({ id, reservePercent: 10, unknown: 'allow' });
  }
  raw.pools = pools;
  return raw;
}
const ROSTER_FIELDS = ['model', 'effort', 'roles', 'cost', 'about', 'use', 'avoid', 'scope', 'prior', 'pool', 'enabled'];
/** Expand a hand-edited roster into candidates: file order is preference within each role. */
export function rosterCandidates(value: unknown): Candidate[] {
  const models = object(value).models;
  check(Array.isArray(models) && models.length > 0 && models.length <= 100, 'Roster needs a nonempty models list');
  const entries = models.map((raw: unknown, index: number) => {
    const e = object(raw);
    const at = `roster models[${index}]${typeof e.model === 'string' ? ` (${e.model})` : ''}`;
    const unknown = Object.keys(e).find(k => !ROSTER_FIELDS.includes(k));
    check(unknown === undefined, `${at} has an unsupported field "${unknown}"`);
    text(e.model, 256, `${at} model`); check(/^[^/\s]+\/\S+$/.test(e.model), `${at} model must be <host>/<model id>`);
    check(thinkingLevels.includes(e.effort), `${at} effort must be one of ${thinkingLevels.join(', ')}`);
    strings(e.roles); check(e.roles.length > 0, `${at} needs roles`);
    number(e.cost, 0, 1, `${at} cost`); text(e.use, 4000, `${at} use`);
    if (e.about !== undefined) text(e.about, 200, `${at} about`);
    if (e.avoid !== undefined) text(e.avoid, 4000, `${at} avoid`);
    if (e.scope !== undefined) check(e.scope === 'small-or-verification', `${at} scope must be small-or-verification`);
    if (e.prior !== undefined) number(e.prior, 0, 1, `${at} prior`);
    if (e.pool !== undefined) text(e.pool, 64, `${at} pool`);
    if (e.enabled !== undefined) check(typeof e.enabled === 'boolean', `${at} enabled must be true or false`);
    return e as RosterEntry;
  });
  const order = new Map<string, string[]>();
  for (const e of entries) for (const role of e.roles) order.set(role, [...(order.get(role) ?? []), `${e.model}@${e.effort}`]);
  return entries.map(e => {
    const id = `${e.model}@${e.effort}`, name = e.model.slice(e.model.indexOf('/') + 1);
    const roleRanks = Object.fromEntries(e.roles.map(role => [role, order.get(role)!.indexOf(id)]));
    return {
      id, model: e.model, thinking: e.effort, roles: e.roles, harnesses: ['native'], pool: e.pool ?? e.model.slice(0, e.model.indexOf('/')),
      fit: [`${name} at ${e.effort}${e.about ? `: ${e.about}` : ''}.`, `Use for: ${e.use}`, ...(e.avoid ? [`Not for: ${e.avoid}`] : [])].join('\n'),
      prior: e.prior ?? 0.7, rank: Math.min(...Object.values(roleRanks)), roleRanks, enabled: e.enabled ?? true,
      profiles: ['roster'], benchmarks: [], cost: e.cost, ...(e.scope ? { taskScope: e.scope } : {}),
    } satisfies Candidate;
  });
}
export function parseConfig(value: unknown): Config {
  const c = object(value);
  check(c.version === 1 && typeof c.enabled === 'boolean', 'Unsupported router config');
  for (const field of ['modulePath', 'stateDir', 'credentialsFile']) {
    text(c[field]); check(isAbsolute(c[field]), `${field} must be absolute`);
  }
  if (c.benchmarkFile !== undefined) { text(c.benchmarkFile); check(isAbsolute(c.benchmarkFile), 'benchmarkFile must be absolute'); }
  if (c.rosterFile !== undefined) { text(c.rosterFile); check(isAbsolute(c.rosterFile), 'rosterFile must be absolute'); }
  check(Array.isArray(c.pools) && c.pools.length > 0 && c.pools.length <= 100, 'Invalid quota pools');
  const pools = new Set<string>();
  for (const raw of c.pools) {
    const p = object(raw); text(p.id); check(!pools.has(p.id), 'Duplicate pool'); pools.add(p.id);
    number(p.reservePercent, 0, 100);
    check(['allow', 'penalize', 'exclude'].includes(p.unknown), 'Unknown quota policy required');
    if (p.collector !== undefined) {
      const s = object(p.collector);
      check(['codex', 'claude'].includes(s.provider) && ['cli', 'oauth', 'web', 'app-server'].includes(s.source), 'Only explicit CLI/OAuth/web/app-server collectors supported');
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
    if (v.taskScope !== undefined) check(v.taskScope === 'small-or-verification', 'Invalid candidate task scope');
    strings(v.roles); strings(v.harnesses); strings(v.profiles);
    check(v.roles.length > 0 && v.harnesses.length > 0 && v.harnesses.every((h: string) => ['pi', 'native'].includes(h)), 'Invalid candidate capabilities');
    check(pools.has(v.pool), 'Candidate references unknown quota pool');
    text(v.fit, 16384); number(v.prior, 0, 1); number(v.rank, 0, 1e6);
    if (v.roleRanks !== undefined) for (const [role, rank] of Object.entries(object(v.roleRanks))) {
      check(v.roles.includes(role), 'Rank references unconfigured role'); number(rank, 0, 1e6);
    }
    check(typeof v.enabled === 'boolean' && Array.isArray(v.benchmarks) && v.benchmarks.length <= 20, 'Invalid candidate');
    if (v.cost !== undefined) number(v.cost, 0, 1);
    v.benchmarks.forEach((mapping: unknown) => {
      const m = object(benchmarkRef(mapping));
      text(m.evidenceUrl); timestamp(m.verifiedAt);
      check(new URL(m.evidenceUrl).protocol === 'https:', 'Benchmark mapping needs HTTPS evidence');
    });
  }
  // Policy fields added after v1 default to off, so older configs keep their behavior.
  const p: Record<string, any> = c.policy = { ...POLICY_ADDITIONS, ...object(c.policy) };
  for (const k of ['quotaMaxAgeMs', 'refreshCooldownMs', 'refreshTimeoutMs', 'leaseMs', 'benchmarkMaxAgeMs']) number(p[k], 1, 365 * 86400000);
  check(p.leaseMs >= 60000 && p.refreshTimeoutMs <= 60000, 'Invalid lease/refresh bounds');
  for (const k of ['benchmarkWeight', 'capacityWeight', 'unknownPenalty']) number(p[k], 0, 1);
  check(p.benchmarkWeight <= 0.5, 'Benchmarks may not dominate task fit');
  for (const k of ['costWeight', 'outcomeWeight']) number(p[k], 0, 1);
  number(p.outcomePrior, 0.1, 1000); number(p.outcomeHalfLifeMs, 86400000, 3650 * 86400000);
  const j = object(c.jev); text(j.model, 128); number(j.timeoutMs, 1, 60000); number(j.minConfidence, 0, 1);
  check(typeof j.enabled === 'boolean', 'Invalid Jev configuration');
  return c as Config;
}
const POLICY_ADDITIONS = { costWeight: 0, outcomeWeight: 0, outcomePrior: 6, outcomeHalfLifeMs: 30 * 86400000 };
export function initialConfig(path = defaultConfigPath()): Config {
  const home = dirname(resolve(path));
  return {
    version: 1, enabled: true, modulePath: fileURLToPath(new URL('./index.js', import.meta.url)),
    stateDir: join(home, 'state'), credentialsFile: join(home, 'credentials.json'), benchmarkFile: join(home, 'benchmarks.json'), candidates: [],
    pools: [
      { id: 'codex', reservePercent: 10, unknown: 'penalize' },
      { id: 'claude', reservePercent: 10, unknown: 'penalize' },
      { id: 'cursor', reservePercent: 10, unknown: 'exclude' },
    ],
    policy: { quotaMaxAgeMs: 300000, refreshCooldownMs: 60000, refreshTimeoutMs: 20000, leaseMs: 300000,
      benchmarkMaxAgeMs: 90 * 86400000, benchmarkWeight: 0.15, capacityWeight: 0.2, unknownPenalty: 0.2, ...POLICY_ADDITIONS },
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
