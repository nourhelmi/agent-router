import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { check, object, quotaSnapshot } from './config.js';
import { RouterError, type Config, type Pool, type QuotaSnapshot, type QuotaWindow } from './types.js';
import { Store } from './store.js';

export function quotaBinding(pool: Pool): string {
  const c = pool.collector;
  const scopes = c ? Object.entries(c.windowModels).sort(([a], [b]) => a.localeCompare(b)).map(([key, models]) => [key, [...models].sort()]) : [];
  return createHash('sha256').update(JSON.stringify([pool.id, c?.provider, c?.source, c?.command, c?.account, scopes,
    homedir(), process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR, process.env.CODEXBAR_CONFIG, process.env.XDG_CONFIG_HOME])).digest('hex');
}
export function matchesBinding(pool: Pool, snapshot: QuotaSnapshot): boolean {
  return snapshot.binding === undefined ? !pool.collector : snapshot.binding === quotaBinding(pool);
}

/** Fixed argv, no shell and no raw provider error/identity persistence. */
export async function runJson(command: string, args: string[], cwd: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    let output = '', settled = false;
    const kill = () => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
    };
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); kill();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new RouterError('QUOTA_TIMEOUT', 'Quota collector timed out')), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 1_000_000) finish(new RouterError('QUOTA_OUTPUT_LIMIT', 'Quota collector output too large'));
    });
    child.on('error', () => finish(new RouterError('QUOTA_COLLECTOR_UNAVAILABLE', 'Quota collector unavailable')));
    child.on('close', code => {
      if (code !== 0) return finish(new RouterError('QUOTA_COLLECTOR_FAILED', 'Quota collector failed; check its configured source'));
      try { finish(undefined, JSON.parse(output)); }
      catch { finish(new RouterError('QUOTA_INVALID_JSON', 'Quota collector returned invalid JSON')); }
    });
  });
}
export function parseCodexBar(raw: unknown, pool: Pool): QuotaSnapshot {
  check(pool.collector, 'Pool has no CodexBar binding');
  const rows = (Array.isArray(raw) ? raw : [raw]).map(object).filter(v => v.provider === pool.collector!.provider);
  check(rows.length === 1, 'Expected exactly one configured provider/account; refusing account merging');
  const row = rows[0]!;
  check(!row.error, 'CodexBar provider unavailable');
  if (pool.collector.account) check(row.account === pool.collector.account, 'CodexBar account binding mismatch');
  const source = pool.collector.source;
  check(source === 'oauth' ? row.source === 'oauth' : ['cli', 'codex-cli', 'claude-cli'].includes(row.source), 'Unexpected CodexBar source');
  const usage = object(row.usage), warnings: string[] = [], windows: QuotaWindow[] = [];
  const add = (id: string, rawWindow: unknown, scoped: boolean, usageKnown = true) => {
    if (rawWindow === null || rawWindow === undefined) return;
    const w = object(rawWindow);
    if (w.isSyntheticPlaceholder === true) { warnings.push(`synthetic-window-omitted:${id}`); return; }
    const mapped = Object.hasOwn(pool.collector!.windowModels, id) ? pool.collector!.windowModels[id] : undefined;
    if (scoped && mapped === undefined) warnings.push(`unmapped-scoped-window:${id}:constrains-all`);
    check(typeof usageKnown === 'boolean', 'Invalid CodexBar usageKnown');
    windows.push({ id, usedPercent: w.usedPercent, known: usageKnown,
      ...(w.resetsAt != null ? { resetAt: w.resetsAt } : {}),
      ...(w.windowMinutes != null ? { windowMinutes: w.windowMinutes } : {}),
      ...(mapped !== undefined ? { models: mapped } : {}) });
  };
  add('primary', usage.primary, false); add('secondary', usage.secondary, false); add('tertiary', usage.tertiary, true);
  if (usage.extraRateWindows != null) {
    check(Array.isArray(usage.extraRateWindows), 'Invalid extra rate windows');
    for (const entry of usage.extraRateWindows) {
      const e = object(entry); check(e.window != null, 'Missing named quota window');
      add(e.id, e.window, true, e.usageKnown ?? true);
    }
  }
  return quotaSnapshot({ version: 1, pool: pool.id, binding: quotaBinding(pool), source: `codexbar:${row.source}`, observedAt: usage.updatedAt, windows, warnings });
}
/** Capture time belongs to the caller observing stdin, never an old statusline file's read time. */
export function parseClaudeStatusline(raw: unknown, pool: string, observedAt: string): QuotaSnapshot {
  const limits = object(object(raw).rate_limits), windows: QuotaWindow[] = [];
  for (const [id, minutes] of [['five_hour', 300], ['seven_day', 10080]] as const) {
    if (limits[id] == null) continue;
    const w = object(limits[id]);
    check(typeof w.resets_at === 'number' && Number.isFinite(w.resets_at), 'Invalid Claude reset time');
    windows.push({ id, usedPercent: w.used_percentage, resetAt: new Date(w.resets_at * 1000).toISOString(), windowMinutes: minutes });
  }
  return quotaSnapshot({ version: 1, pool, source: 'claude-code:statusline', observedAt, windows, warnings: [] });
}
export async function refreshQuotas(config: Config, store: Store, force = false): Promise<void> {
  const snapshots = store.quotas(), now = Date.now();
  await Promise.all(config.pools.filter(p => p.collector).map(async pool => {
    const prior = snapshots.get(pool.id);
    const fresh = prior && matchesBinding(pool, prior) && now - Date.parse(prior.observedAt) <= config.policy.quotaMaxAgeMs &&
      prior.windows.length > 0 && prior.windows.every(w => !w.resetAt || Date.parse(w.resetAt) > now);
    if (!force && fresh) return;
    const refreshKey = `${pool.id}:${quotaBinding(pool)}`;
    if (!store.claimRefresh(refreshKey, config.policy.refreshCooldownMs, now)) return;
    const c = pool.collector!;
    const args = ['usage', '--provider', c.provider, '--source', c.source, '--format', 'json', '--json-only', '--no-credits'];
    if (c.account) args.push('--account', c.account);
    try {
      const snapshot = parseCodexBar(await runJson(c.command, args, config.stateDir, config.policy.refreshTimeoutMs), pool);
      store.putQuota(snapshot); store.refreshed(refreshKey, 'ok');
    } catch (error) {
      store.refreshed(refreshKey, error instanceof RouterError ? error.code : 'QUOTA_COLLECTOR_FAILED');
    }
  }));
}
