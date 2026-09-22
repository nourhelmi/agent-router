import type { CandidateDiagnostic, Config, QuotaSnapshot, RouteRequest, BenchmarkObservation } from './types.js';
import type { Judgment } from './jev.js';
import { benchmarkScore } from './benchmarks.js';
import { matchesBinding } from './quota.js';

export function evaluate(config: Config, request: RouteRequest, quotas: Map<string, QuotaSnapshot>, active: Map<string, number>, evidence: BenchmarkObservation[], judgment?: Judgment, now = Date.now()): CandidateDiagnostic[] {
  const role = ['worker', 'freeform'].includes(request.role) ? 'builder' : request.role;
  return config.candidates.map(candidate => {
    const pool = config.pools.find(p => p.id === candidate.pool)!;
    const reasons: string[] = [], hard: string[] = [];
    if (!candidate.enabled) hard.push('disabled');
    if (!candidate.roles.includes(role)) hard.push('role');
    if (!candidate.harnesses.includes(request.harness)) hard.push('harness');
    // Native transport constraints cannot be bypassed by an over-broad catalog.
    if (request.harness === 'native' && (!/^(openai-codex|anthropic|claude-bridge)\//.test(candidate.model) ||
      (candidate.model.startsWith('openai-codex/') && candidate.thinking === 'max'))) hard.push('native-capability');
    if (request.pin && (candidate.model !== request.pin.model || (request.pin.thinking && candidate.thinking !== request.pin.thinking))) hard.push('pin');
    const count = active.get(pool.id) ?? 0;
    if (count >= pool.maxConcurrent) hard.push('concurrency');
    const cached = quotas.get(pool.id);
    const snapshot = cached && matchesBinding(pool, cached) ? cached : undefined;
    if (cached && !snapshot) reasons.push('quota-binding-changed');
    const windows = snapshot?.windows.filter(w => !w.models || w.models.includes(candidate.model)) ?? [];
    const gates = snapshot?.gates?.filter(g => !g.models || g.models.includes(candidate.model)) ?? [];
    for (const g of gates) if (g.allowed === false) hard.push(`provider-denied:${g.id}`);
    const permissionUnknown = gates.some(g => g.allowed === null);
    const unexpired = windows.filter(w => !w.resetAt || Date.parse(w.resetAt) > now);
    const isFresh = snapshot && now - Date.parse(snapshot.observedAt) <= config.policy.quotaMaxAgeMs;
    const known = Boolean(isFresh && !permissionUnknown && windows.length && windows.length === unexpired.length && windows.every(w => w.known !== false));
    // A still-unexpired exhaustion report remains a hard restriction even if another window expired.
    const restricted = unexpired.filter(w => w.known !== false && 100 - w.usedPercent <= pool.reservePercent);
    if (restricted.length) hard.push(...restricted.map(w => `reserve:${w.id}`));
    if (!known) {
      reasons.push(!snapshot ? 'quota-missing' : !isFresh ? 'quota-stale' : permissionUnknown ? 'quota-permission-unknown' : windows.some(w => w.known === false) ? 'quota-usage-unknown' : windows.length ? 'quota-reset-unobserved' : 'quota-no-applicable-windows');
      if (pool.unknown === 'exclude') hard.push('unknown-quota-excluded');
    }
    if (snapshot) reasons.push(...snapshot.warnings);
    const headroom = known ? Math.min(...unexpired.map(w => 100 - w.usedPercent - pool.reservePercent)) : undefined;
    const benchmark = benchmarkScore(candidate, evidence, config.policy.benchmarkMaxAgeMs, judgment?.family, now);
    if (candidate.benchmarks.length && !benchmark.evidence.length) reasons.push('benchmark-missing-stale-or-inapplicable');
    if (!candidate.benchmarks.length) reasons.push('benchmark-unmapped');
    const score = judgment?.scores.get(candidate.id);
    const accepted = score && score.confidence >= config.jev.minConfidence;
    if (score && !accepted) reasons.push('jev-low-confidence');
    const fit = accepted ? score.score : candidate.prior;
    const quality = benchmark.score === undefined ? fit : fit * (1 - config.policy.benchmarkWeight) + benchmark.score * config.policy.benchmarkWeight;
    // Unknown capacity gets neutral utility, never fabricated observed headroom.
    const capacity = (headroom === undefined ? 0.5 : Math.max(0, headroom) / 100) * (1 - count / pool.maxConcurrent);
    const utility = quality * (1 - config.policy.capacityWeight) + capacity * config.policy.capacityWeight -
      (!known && pool.unknown === 'penalize' ? config.policy.unknownPenalty : 0);
    return { id: candidate.id, eligible: !hard.length, reasons: [...hard, ...reasons], quota: known ? 'known' : 'unknown',
      ...(headroom !== undefined ? { headroom } : {}), active: count,
      benchmark: benchmark.score, benchmarkEvidence: benchmark.evidence, ...score, utility };
  });
}
export function ranked(config: Config, diagnostics: CandidateDiagnostic[], role = ''): CandidateDiagnostic[] {
  const key = ['worker', 'freeform'].includes(role) ? 'builder' : role;
  const rank = (id: string) => { const c = config.candidates.find(c => c.id === id)!; return c.roleRanks?.[key] ?? c.rank; };
  return diagnostics.filter(c => c.eligible).sort((a, b) => (b.utility! - a.utility!) || rank(a.id) - rank(b.id) || a.id.localeCompare(b.id, 'en'));
}
