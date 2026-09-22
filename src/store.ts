import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { benchmarks, quotaSnapshot } from './config.js';
import { matchesBinding } from './quota.js';
import type { Config, BenchmarkObservation, QuotaGate, QuotaSnapshot, QuotaWindow, RouteDecision } from './types.js';

type PermissionFact = { gate: QuotaGate; token: number };
type QuotaObservation = { snapshot: QuotaSnapshot; token: number };
type QuotaCache = QuotaObservation & { permissions: PermissionFact[]; views: PermissionFact[]; observations?: QuotaObservation[] };
type RefreshClaim = { token: number; attempted: number };

function newerPermission(a: PermissionFact, b: PermissionFact): boolean {
  const order = Date.parse(a.gate.observedAt) - Date.parse(b.gate.observedAt) || (a.token && b.token ? a.token - b.token : 0);
  if (order) return order > 0;
  const priority = (g: QuotaGate) => g.allowed === false ? 2 : g.allowed === null ? 1 : 0;
  if (a.gate.allowed !== b.gate.allowed) return priority(a.gate) > priority(b.gate);
  return a.token > b.token || (a.token === b.token && JSON.stringify(a.gate) > JSON.stringify(b.gate));
}
function mergeFacts(facts: PermissionFact[], separateTokens: boolean): Map<string, PermissionFact> {
  const result = new Map<string, PermissionFact>();
  for (const fact of facts) {
    // Unsequenced imports cannot erase a read token (or acquire its ordering authority).
    const key = separateTokens ? JSON.stringify([fact.gate.id, fact.token === 0]) : fact.gate.id, old = result.get(key);
    if (!old || newerPermission(fact, old)) result.set(key, fact);
  }
  return result;
}
// Old cache JSON predates the observation set; its raw snapshot is still valid evidence.
const rawObservations = (cache: QuotaCache): QuotaObservation[] => cache.observations ?? [{ snapshot: cache.snapshot, token: cache.token }];
function latestObservations(samples: QuotaObservation[]): QuotaObservation[] {
  const time = Math.max(...samples.map(s => Date.parse(s.snapshot.observedAt)));
  const latest = samples.filter(s => Date.parse(s.snapshot.observedAt) === time);
  const readToken = Math.max(...latest.map(s => s.token));
  // Only comparable reads supersede each other at the same time. Imports never inherit a token.
  const retained = latest.filter(s => s.token === 0 || s.token === readToken);
  const unique = new Map(retained.map(s => [JSON.stringify([s.token, s.snapshot]), s]));
  return [...unique.keys()].sort().map(key => unique.get(key)!);
}
function mergeQuota(prior: QuotaCache | undefined, incoming: QuotaCache): QuotaCache {
  const previousViews = prior?.views ?? prior?.snapshot.gates?.map(gate => ({ gate, token: prior.token })) ?? [];
  const observations = [...(incoming.views ?? incoming.snapshot.gates?.map(gate => ({ gate, token: incoming.token })) ?? [])];
  const samples = [...(prior ? rawObservations(prior) : []), ...rawObservations(incoming)];
  const ids = mergeFacts([...previousViews, ...observations], false);
  // Missing gates are unknown at that snapshot's time, even when wrappers arrive out of order.
  for (const { gate } of ids.values()) for (const sample of samples) {
    if (!sample.snapshot.gates?.some(g => g.id === gate.id)) observations.push({
      gate: { ...gate, allowed: null, observedAt: sample.snapshot.observedAt }, token: sample.token,
    });
  }
  const permissions = mergeFacts([...(prior?.permissions ?? []), ...incoming.permissions, ...observations.filter(f => f.gate.allowed !== null)], true);
  const views = mergeFacts([...previousViews, ...observations], true);
  const latest = latestObservations(samples);
  // This representative supplies metadata only; budget authority belongs to the entire retained set.
  return { ...latest.at(-1)!, observations: latest, permissions: [...permissions.values()], views: [...views.values()] };
}
function windowViews(cache: QuotaCache): QuotaWindow[] {
  const windows = new Map<string, Map<string, QuotaWindow>>();
  for (const { snapshot } of rawObservations(cache)) for (const window of snapshot.windows) {
    const group = windows.get(window.id) ?? new Map<string, QuotaWindow>();
    // Fixed field order deduplicates identical observations without changing scopes or percentages.
    const key = JSON.stringify([window.usedPercent, window.known, window.resetAt, window.windowMinutes, window.models]);
    group.set(key, window); windows.set(window.id, group);
  }
  const ids = new Set(windows.keys()), result: QuotaWindow[] = [];
  let sequence = 0;
  for (const id of [...windows.keys()].sort()) {
    const group = windows.get(id)!;
    for (const key of [...group.keys()].sort()) {
      const window = group.get(key)!;
      let viewId = id;
      // Reserve all original IDs first, including names that already look like generated views.
      if (group.size > 1) { do { viewId = `quota-view:${sequence++}`; } while (ids.has(viewId)); }
      ids.add(viewId); result.push({ ...window, id: viewId });
    }
  }
  return result;
}
function quotaView(cache: QuotaCache): QuotaSnapshot {
  const { snapshot, token } = cache, gates = new Map(snapshot.gates?.map(g => [g.id, g]));
  const explicit = mergeFacts(cache.permissions, false);
  const views = mergeFacts(cache.views ?? [...cache.permissions, ...(snapshot.gates?.map(gate => ({ gate, token })) ?? [])], false);
  for (const view of [...views.values()].sort((a, b) => a.gate.id.localeCompare(b.gate.id, 'en'))) {
    const fact = explicit.get(view.gate.id);
    // Unknown cannot clear false; retained true prevents a late older false from resurrecting.
    gates.set(view.gate.id, fact && (fact.gate.allowed === false || newerPermission(fact, view)) ? fact.gate : view.gate);
  }
  const warnings = [...new Set(rawObservations(cache).flatMap(s => s.snapshot.warnings))].sort();
  return { ...snapshot, windows: windowViews(cache), warnings, ...(gates.size ? { gates: [...gates.values()] } : {}) };
}

export class Store {
  readonly db: DatabaseSync;
  constructor(private readonly config: Config) {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(config.stateDir, 0o700);
    const path = join(config.stateDir, 'router.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS quota (pool TEXT PRIMARY KEY, observed INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quota_cache (pool TEXT NOT NULL, binding TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(pool,binding));
      CREATE TABLE IF NOT EXISTS benchmarks (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS refresh (pool TEXT PRIMARY KEY, attempted INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS refresh_tokens (pool TEXT PRIMARY KEY, token INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, request_id TEXT UNIQUE, digest TEXT NOT NULL,
        pool TEXT NOT NULL, expires INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS active_pool ON decisions(pool, released, expires);`);
    // Additive migration: old loaded clients retain their quota table and all lease/audit IDs.
    for (const row of this.db.prepare('SELECT data FROM quota').all()) this.putQuota(quotaSnapshot(JSON.parse(String(row.data))));
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  quotas(): Map<string, QuotaSnapshot> {
    const result = new Map<string, QuotaCache>();
    for (const row of this.db.prepare('SELECT data FROM quota_cache ORDER BY pool,binding').all()) {
      const cache = JSON.parse(String(row.data)) as QuotaCache, snapshot = cache.snapshot, prior = result.get(snapshot.pool);
      // Input bounds apply to individual observations, not the union of conflicting views.
      for (const sample of rawObservations(cache)) quotaSnapshot(sample.snapshot);
      const pool = this.config.pools.find(p => p.id === snapshot.pool);
      const matches = (q: QuotaSnapshot) => Boolean(pool && matchesBinding(pool, q));
      if (prior && matches(snapshot) && matches(prior.snapshot)) result.set(snapshot.pool, mergeQuota(prior, cache));
      else if (!prior || (matches(snapshot) && !matches(prior.snapshot)) ||
        (!matches(prior.snapshot) && Date.parse(snapshot.observedAt) > Date.parse(prior.snapshot.observedAt))) result.set(snapshot.pool, cache);
    }
    return new Map([...result].map(([pool, cache]) => [pool, quotaView(cache)]));
  }
  putQuota(snapshot: QuotaSnapshot, token = 0): void {
    const q = quotaSnapshot(snapshot), binding = q.binding ?? '';
    this.transaction(() => {
      const row = this.db.prepare('SELECT data FROM quota_cache WHERE pool=? AND binding=?').get(q.pool, binding);
      const views = q.gates?.map(gate => ({ gate, token })) ?? [];
      const cache = mergeQuota(row ? JSON.parse(String(row.data)) as QuotaCache : undefined,
        { snapshot: q, token, views, permissions: views.filter(f => f.gate.allowed !== null) });
      this.db.prepare(`INSERT INTO quota_cache VALUES(?,?,?) ON CONFLICT(pool,binding) DO UPDATE SET data=excluded.data`)
        .run(q.pool, binding, JSON.stringify(cache));
    });
  }
  evidence(): BenchmarkObservation[] {
    const row = this.db.prepare('SELECT data FROM benchmarks WHERE id=1').get();
    return row ? benchmarks(JSON.parse(String(row.data))) : [];
  }
  putEvidence(evidence: BenchmarkObservation[]): void {
    this.db.prepare('INSERT INTO benchmarks VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(benchmarks(evidence)));
  }
  active(now = Date.now()): Map<string, number> {
    return new Map(this.db.prepare('SELECT pool,count(*) AS n FROM decisions WHERE released=0 AND expires>? GROUP BY pool').all(now)
      .map(r => [String(r.pool), Number(r.n)]));
  }
  previous(requestId: string): { digest: string; active: boolean; decision: RouteDecision } | undefined {
    const row = this.db.prepare('SELECT * FROM decisions WHERE request_id=?').get(requestId);
    return row ? { digest: String(row.digest), active: !row.released && Number(row.expires) > Date.now(), decision: JSON.parse(String(row.data)) } : undefined;
  }
  reserve(decision: RouteDecision, digest: string, requestId?: string): void {
    this.db.prepare('INSERT INTO decisions(id,request_id,digest,pool,expires,data) VALUES(?,?,?,?,?,?)')
      .run(decision.id, requestId ?? null, digest, decision.pool, Date.parse(decision.expiresAt), JSON.stringify(decision));
  }
  claimRefresh(pool: string, cooldown: number): RefreshClaim | undefined {
    return this.transaction(() => {
      const now = Date.now(); // Admission time, after any writer-lock wait, never RPC completion time.
      const row = this.db.prepare('SELECT attempted FROM refresh WHERE pool=?').get(pool);
      if (row && Number(row.attempted) > now - cooldown) return;
      const claim = this.db.prepare(`INSERT INTO refresh_tokens VALUES(?,1) ON CONFLICT(pool) DO UPDATE SET token=token+1 RETURNING token`).get(pool)!;
      this.db.prepare("INSERT INTO refresh VALUES(?,?,'pending') ON CONFLICT(pool) DO UPDATE SET attempted=excluded.attempted,status='pending'").run(pool, now);
      return { token: Number(claim.token), attempted: now };
    });
  }
  refreshed(pool: string, status: string, claim: RefreshClaim): void {
    this.db.prepare(`UPDATE refresh SET status=? WHERE pool=? AND attempted=? AND
      EXISTS(SELECT 1 FROM refresh_tokens WHERE pool=? AND token=?)`).run(status, pool, claim.attempted, pool, claim.token);
  }
  refreshStatus(): unknown[] { return this.db.prepare('SELECT * FROM refresh').all(); }
}
