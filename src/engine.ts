import type { Candidate, CandidateDiagnostic, Config, Outcome, OutcomeScore, QuotaSnapshot, RouteRequest, BenchmarkObservation } from './types.js';
import type { Judgment } from './jev.js';
import { benchmarkScore } from './benchmarks.js';
import { matchesBinding } from './quota.js';

/** Compatibility roles consult builder guidance and evidence. */
export const roleKey = (role: string): string => ['worker', 'freeform'].includes(role) ? 'builder' : role;
const bare = (model: string) => model.slice(model.indexOf('/') + 1);
export const matchesOutcome = (candidate: Candidate, outcome: Outcome): boolean =>
  outcome.thinking === candidate.thinking && bare(outcome.model) === bare(candidate.model);
/**
 * Reviewed success of one candidate in one role: a Beta posterior centred on the candidate's prior,
 * each outcome decayed by age. Undefined without evidence, which leaves fit untouched.
 */
export function outcomeScore(candidate: Candidate, role: string, outcomes: Outcome[], policy: Config['policy'], now = Date.now()): OutcomeScore | undefined {
  let n = 0, wins = 0;
  for (const o of outcomes) {
    if (!matchesOutcome(candidate, o) || roleKey(o.role) !== role) continue;
    const weight = 0.5 ** (Math.max(0, now - Date.parse(o.at)) / policy.outcomeHalfLifeMs);
    n += weight; if (o.success) wins += weight;
  }
  return n ? { n, mean: (wins + policy.outcomePrior * candidate.prior) / (n + policy.outcomePrior) } : undefined;
}
export function evaluate(config: Config, request: RouteRequest, quotas: Map<string, QuotaSnapshot>, active: Map<string, number>, evidence: BenchmarkObservation[], judgment?: Judgment, now = Date.now(), phase: 'assessment' | 'admission' = 'admission', outcomes: Outcome[] = []): CandidateDiagnostic[] {
  const role = roleKey(request.role);
  return config.candidates.map(candidate => {
    const pool = config.pools.find(p => p.id === candidate.pool)!;
    const reasons: string[] = [], hard: string[] = [];
    if (!candidate.enabled) hard.push('disabled');
    if (!candidate.roles.includes(role)) hard.push('role');
    if (!candidate.harnesses.includes(request.harness)) hard.push('harness');
    if (request.pin && (candidate.model !== request.pin.model || (request.pin.thinking && candidate.thinking !== request.pin.thinking))) hard.push('pin');
    // Assessment only builds the Jev shortlist. Every actual admission requires positive scope evidence.
    const taskScope = candidate.taskScope ? judgment?.taskScope : undefined;
    if (candidate.taskScope && phase === 'admission' &&
      !(taskScope && Math.max(taskScope.small, taskScope.verification) >= 0.9)) hard.push('task-scope-unconfirmed');
    const count = active.get(pool.id) ?? 0;
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
    const blended = benchmark.score === undefined ? fit : fit * (1 - config.policy.benchmarkWeight) + benchmark.score * config.policy.benchmarkWeight;
    // Reviewed outcomes move fit by how far this candidate's record sits from its prior.
    const outcome = outcomeScore(candidate, role, outcomes, config.policy, now);
    const quality = outcome ? Math.min(1, Math.max(0, blended + config.policy.outcomeWeight * (outcome.mean - candidate.prior))) : blended;
    // An unpriced candidate is treated as the dearest, never as free.
    if (config.policy.costWeight > 0 && candidate.cost === undefined) reasons.push('cost-unset');
    // Unknown capacity gets neutral utility, never fabricated observed headroom.
    const capacity = headroom === undefined ? 0.5 : Math.max(0, headroom) / 100;
    const utility = quality * (1 - config.policy.capacityWeight) + capacity * config.policy.capacityWeight -
      (!known && pool.unknown === 'penalize' ? config.policy.unknownPenalty : 0) - config.policy.costWeight * (candidate.cost ?? 1);
    return { id: candidate.id, eligible: !hard.length, reasons: [...hard, ...reasons], quota: known ? 'known' : 'unknown',
      ...(headroom !== undefined ? { headroom } : {}), active: count,
      ...(taskScope ? { taskScope } : {}),
      benchmark: benchmark.score, benchmarkEvidence: benchmark.evidence, ...score,
      ...(candidate.cost !== undefined ? { cost: candidate.cost } : {}), ...(outcome ? { outcome } : {}), utility };
  });
}
export function ranked(config: Config, diagnostics: CandidateDiagnostic[], role = ''): CandidateDiagnostic[] {
  const key = roleKey(role);
  const rank = (id: string) => { const c = config.candidates.find(c => c.id === id)!; return c.roleRanks?.[key] ?? c.rank; };
  return diagnostics.filter(c => c.eligible).sort((a, b) => (b.utility! - a.utility!) || rank(a.id) - rank(b.id) || a.id.localeCompare(b.id, 'en'));
}
