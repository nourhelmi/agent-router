import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { benchmarks, quotaSnapshot } from './config.js';
import type { Config, BenchmarkObservation, QuotaSnapshot, RouteDecision } from './types.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(config: Config) {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(config.stateDir, 0o700);
    const path = join(config.stateDir, 'router.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS quota (pool TEXT PRIMARY KEY, observed INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS benchmarks (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS refresh (pool TEXT PRIMARY KEY, attempted INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, request_id TEXT UNIQUE, digest TEXT NOT NULL,
        pool TEXT NOT NULL, expires INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS active_pool ON decisions(pool, released, expires);`);
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  quotas(): Map<string, QuotaSnapshot> {
    return new Map(this.db.prepare('SELECT pool,data FROM quota').all().map(r => [String(r.pool), quotaSnapshot(JSON.parse(String(r.data)))]));
  }
  putQuota(snapshot: QuotaSnapshot): void {
    const q = quotaSnapshot(snapshot);
    this.db.prepare(`INSERT INTO quota VALUES(?,?,?) ON CONFLICT(pool) DO UPDATE SET observed=excluded.observed,data=excluded.data
      WHERE excluded.observed >= quota.observed`).run(q.pool, Date.parse(q.observedAt), JSON.stringify(q));
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
  claimRefresh(pool: string, cooldown: number, now = Date.now()): boolean {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT attempted FROM refresh WHERE pool=?').get(pool);
      if (row && Number(row.attempted) > now - cooldown) return false;
      this.db.prepare("INSERT INTO refresh VALUES(?,?,'pending') ON CONFLICT(pool) DO UPDATE SET attempted=excluded.attempted,status='pending'").run(pool, now);
      return true;
    });
  }
  refreshed(pool: string, status: string): void { this.db.prepare('UPDATE refresh SET status=? WHERE pool=?').run(status, pool); }
  refreshStatus(): unknown[] { return this.db.prepare('SELECT * FROM refresh').all(); }
}
