import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';
import { check, number, object, quotaSnapshot, text } from './config.js';
import { RouterError, type Config, type Pool, type QuotaGate, type QuotaSnapshot, type QuotaWindow } from './types.js';
import type { Store } from './store.js';

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
export async function runJson(command: string, args: string[], cwd: string, timeoutMs: number, protocol: 'json' | 'codex-app-server' = 'json'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const rpc = protocol === 'codex-app-server';
    const child = spawn(command, args, { cwd, stdio: [rpc ? 'pipe' : 'ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    const decoder = new StringDecoder('utf8');
    let output = '', settled = false, bytes = 0, initialized = false;
    const kill = () => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
    };
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); kill();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new RouterError('QUOTA_TIMEOUT', 'Quota collector timed out')), timeoutMs);
    const send = (value: unknown) => child.stdin?.write(JSON.stringify(value) + '\n');
    child.stdin?.on('error', () => finish(new RouterError('QUOTA_COLLECTOR_UNAVAILABLE', 'Quota collector input unavailable')));
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_000_000) return finish(new RouterError('QUOTA_OUTPUT_LIMIT', 'Quota collector output too large'));
      output += decoder.write(chunk);
      if (!rpc || settled) return;
      try {
        for (let end; !settled && (end = output.indexOf('\n')) >= 0;) {
          const line = output.slice(0, end); output = output.slice(end + 1);
          if (!line.trim()) continue;
          const message = object(JSON.parse(line));
          if (message.method !== undefined) {
            check(message.id === undefined, 'Quota-only client does not accept server requests');
            continue;
          }
          if (message.error) return finish(new RouterError('QUOTA_RPC_ERROR', 'Codex quota RPC failed; no authentication changes attempted'));
          if (message.id === 1 && !initialized) {
            object(message.result); initialized = true;
            send({ method: 'initialized', params: {} });
            send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true, supportsLunaReserve: false } });
          } else if (message.id === 2 && initialized) finish(undefined, object(message.result));
          else throw new Error('Unexpected quota RPC response');
        }
      } catch { finish(new RouterError('QUOTA_INVALID_JSON', 'Invalid Codex quota RPC response')); }
    });
    child.on('error', () => finish(new RouterError('QUOTA_COLLECTOR_UNAVAILABLE', 'Quota collector unavailable')));
    child.on('close', code => {
      if (rpc) return finish(new RouterError('QUOTA_RPC_INCOMPLETE', 'Codex exited before its quota response'));
      if (code !== 0) return finish(new RouterError('QUOTA_COLLECTOR_FAILED', 'Quota collector failed; check its configured source'));
      try { finish(undefined, JSON.parse(output)); }
      catch { finish(new RouterError('QUOTA_INVALID_JSON', 'Quota collector returned invalid JSON')); }
    });
    if (rpc) send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_router', version: '0.1.0' } } });
  });
}
export function parseCodexBar(raw: unknown, pool: Pool): QuotaSnapshot {
  check(pool.collector && pool.collector.source !== 'app-server', 'Pool has no CodexBar binding');
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
/** Normalize the official Codex CLI read using its admitted start time; never read credentials. */
export function parseCodexRateLimits(raw: unknown, pool: Pool, observedAt: string): QuotaSnapshot {
  check(pool.collector?.provider === 'codex' && pool.collector.source === 'app-server', 'Pool has no direct Codex binding');
  const data = object(raw), legacy = object(data.rateLimits), indexed = data.rateLimitsByLimitId == null ? {} : object(data.rateLimitsByLimitId);
  const legacyId = legacy.limitId ?? 'codex'; text(legacyId);
  const windows: QuotaWindow[] = [], warnings: string[] = [];
  const gates: QuotaGate[] = [{ id: 'ordinary-usage', allowed: data.ordinaryUsageAllowed ?? null, observedAt }];
  const rows = Object.entries(indexed).map(([id, value]) => ({ id, scope: id, value }));
  if (!Object.hasOwn(indexed, legacyId)) rows.unshift({ id: legacyId, scope: legacyId, value: legacy });
  else if (!isDeepStrictEqual(legacy, indexed[legacyId])) {
    // Conflicting legacy/multi-bucket views both constrain admission; neither is silently discarded.
    rows.unshift({ id: `legacy:${legacyId}`, scope: legacyId, value: legacy }); warnings.push('overlapping-codex-bucket-views');
  }
  check(rows.length <= 30, 'Too many Codex quota buckets');
  const models = (id: string) => Object.hasOwn(pool.collector!.windowModels, id) ? pool.collector!.windowModels[id] : undefined;
  for (const { id, scope, value } of rows) {
    text(id); const row = object(value), scopedModels = models(scope);
    if (row.limitId != null) check(row.limitId === scope, 'Codex quota bucket identity mismatch');
    if (scope !== 'codex' && scopedModels === undefined) warnings.push(`unmapped-scoped-bucket:${scope}:constrains-all`);
    check(row.spendControlReached == null || typeof row.spendControlReached === 'boolean', 'Invalid Codex spend-control state');
    if (row.rateLimitReachedType != null) text(row.rateLimitReachedType, 128);
    const allowed = row.rateLimitReachedType != null || row.spendControlReached === true ? false : row.spendControlReached === false ? true : null;
    const gateId = `${scope}:permission`, priorGate = gates.find(g => g.id === gateId);
    if (priorGate) {
      if (allowed === false || (allowed === null && priorGate.allowed === true)) priorGate.allowed = allowed;
    } else gates.push({ id: gateId, allowed, observedAt, ...(scopedModels !== undefined ? { models: scopedModels } : {}) });
    for (const name of ['primary', 'secondary', 'individualLimit'] as const) {
      if (row[name] == null) continue;
      const w = object(row[name]), modelScope = models(`${scope}:${name}`) ?? scopedModels;
      if (name === 'individualLimit') number(w.remainingPercent, -999900, 100);
      if (w.resetsAt != null) number(w.resetsAt, 0, 253402300799);
      windows.push({ id: `${id}:${name}`, usedPercent: name === 'individualLimit' ? 100 - w.remainingPercent : w.usedPercent,
        ...(w.resetsAt != null ? { resetAt: new Date(w.resetsAt * 1000).toISOString() } : {}),
        ...(w.windowDurationMins != null ? { windowMinutes: w.windowDurationMins } : {}),
        ...(modelScope !== undefined ? { models: modelScope } : {}) });
    }
  }
  return quotaSnapshot({ version: 1, pool: pool.id, binding: quotaBinding(pool), source: 'codex:app-server', observedAt, windows, gates, warnings });
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
  await Promise.all(config.pools.filter(p => p.collector).map(async configuredPool => {
    const pool = structuredClone(configuredPool); // Keep an in-flight read attached to its admitted binding.
    const prior = snapshots.get(pool.id);
    const fresh = prior && matchesBinding(pool, prior) && now - Date.parse(prior.observedAt) <= config.policy.quotaMaxAgeMs &&
      prior.windows.length > 0 && prior.windows.every(w => !w.resetAt || Date.parse(w.resetAt) > now);
    if (!force && fresh) return;
    const binding = quotaBinding(pool), refreshKey = `${pool.id}:${binding}`;
    const claim = store.claimRefresh(refreshKey, config.policy.refreshCooldownMs);
    if (!claim) return;
    const c = pool.collector!;
    const direct = c.source === 'app-server';
    const args = direct ? ['app-server', '--stdio'] : ['usage', '--provider', c.provider, '--source', c.source, '--format', 'json', '--json-only', '--no-credits'];
    if (c.account) args.push('--account', c.account);
    try {
      const raw = await runJson(c.command, args, config.stateDir, config.policy.refreshTimeoutMs, direct ? 'codex-app-server' : 'json');
      const snapshot = direct ? parseCodexRateLimits(raw, pool, new Date(claim.attempted).toISOString()) : parseCodexBar(raw, pool);
      store.putQuota({ ...snapshot, binding }, direct ? claim.token : 0); store.refreshed(refreshKey, 'ok', claim);
    } catch (error) {
      store.refreshed(refreshKey, error instanceof RouterError ? error.code : 'QUOTA_COLLECTOR_FAILED', claim);
    }
  }));
}
