import { createHash, randomUUID } from 'node:crypto';
import { check, loadConfig, text, validateRequest } from './config.js';
import { evaluate, ranked } from './engine.js';
import { judge, type Judgment } from './jev.js';
import { refreshQuotas } from './quota.js';
import { readBenchmarkFile } from './benchmarks.js';
import { Store } from './store.js';
import { RouterError, type RouteDecision, type RouteOptions, type RouteRequest } from './types.js';

export * from './types.js';
export { parseCodexBar, parseCodexRateLimits, parseClaudeStatusline, quotaBinding } from './quota.js';
export { parseDeepSWE, parseArtificialAnalysis, parseArtificialAnalysisPage } from './benchmarks.js';

export async function route(input: RouteRequest, options: RouteOptions = {}): Promise<RouteDecision> {
  const request = validateRequest(input), config = await loadConfig(options.configPath);
  check(config.enabled, 'Router is disabled');
  if (options.dryRun !== undefined) check(typeof options.dryRun === 'boolean', 'Invalid dryRun option');
  const digest = createHash('sha256').update(JSON.stringify([request.role, request.task, request.harness, request.pin?.model, request.pin?.thinking])).digest('hex');
  const store = new Store(config);
  const previous = (): RouteDecision | undefined => {
    if (!request.requestId || options.dryRun) return;
    const prior = store.previous(request.requestId);
    if (!prior) return;
    if (prior.digest !== digest) throw new RouterError('AGENT_ROUTER_REQUEST_CONFLICT', 'Request ID reused with different task or constraints');
    if (!prior.active) throw new RouterError('AGENT_ROUTER_REQUEST_SETTLED', 'Request ID belongs to an expired or released lease; use a new request ID');
    return prior.decision;
  };
  const noRoute = (diagnostics: ReturnType<typeof evaluate>): never => {
    const error = new RouterError('AGENT_ROUTER_NO_FEASIBLE_ROUTE', 'No candidate satisfies identity, capability, quota, and concurrency constraints');
    Object.assign(error, { candidates: diagnostics });
    throw error;
  };
  try {
    const prior = previous(); if (prior) return prior;
    await refreshQuotas(config, store);
    const snapshot = await readBenchmarkFile(config);
    if (snapshot) store.putEvidence(snapshot);
    const evidence = store.evidence();
    const first = evaluate(config, request, store.quotas(), store.active(), evidence);
    const eligible = config.candidates.filter(c => first.some(d => d.id === c.id && d.eligible));
    if (!eligible.length) {
      const concurrent = previous(); if (concurrent) return concurrent;
      noRoute(first);
    }
    const judgment: Judgment = request.pin ? { reason: 'explicit-pin', scores: new Map() } : await judge(request, eligible, config);
    // No network await while holding the shared writer transaction.
    return store.transaction(() => {
      const previousDecision = previous(); if (previousDecision) return previousDecision;
      const now = Date.now();
      const quotas = store.quotas();
      const diagnostics = evaluate(config, request, quotas, store.active(now), store.evidence(), judgment, now);
      const selected = ranked(config, diagnostics, request.role)[0];
      if (!selected) return noRoute(diagnostics);
      const candidate = config.candidates.find(c => c.id === selected.id)!;
      const usedJev = selected.confidence !== undefined && selected.confidence >= config.jev.minConfidence;
      const decision: RouteDecision = {
        version: 1, id: randomUUID(), selected: { model: candidate.model, thinking: candidate.thinking },
        strategy: request.pin ? 'pinned' : usedJev ? 'jev' : 'fallback',
        at: new Date(now).toISOString(), expiresAt: new Date(now + config.policy.leaseMs).toISOString(),
        reserved: !options.dryRun, candidateId: candidate.id, pool: candidate.pool, taskDigest: digest,
        reason: !request.pin && judgment.reason === 'jev-scored' && !usedJev ? 'jev-low-confidence-or-newly-feasible' : judgment.reason,
        quotas: [...quotas.values()], policy: config.policy,
        catalogDigest: createHash('sha256').update(JSON.stringify(config.candidates)).digest('hex'),
        ...(judgment.model ? { jevModel: judgment.model } : {}), candidates: diagnostics,
      };
      if (!options.dryRun) store.reserve(decision, digest, request.requestId);
      return decision;
    });
  } finally { store.close(); }
}
export async function release(decisionId: string, options: Pick<RouteOptions, 'configPath'> = {}): Promise<void> {
  text(decisionId, 256);
  const store = new Store(await loadConfig(options.configPath));
  try { store.db.prepare('UPDATE decisions SET released=1 WHERE id=?').run(decisionId); }
  finally { store.close(); }
}
export async function renew(decisionId: string, options: Pick<RouteOptions, 'configPath'> = {}): Promise<void> {
  text(decisionId, 256);
  const config = await loadConfig(options.configPath), store = new Store(config);
  try {
    store.transaction(() => {
      // Sample time only after acquiring the writer lock: a waiting renewal must not resurrect an expired slot.
      const now = Date.now(), expires = now + config.policy.leaseMs;
      const result = store.db.prepare("UPDATE decisions SET expires=?,data=json_set(data,'$.expiresAt',?) WHERE id=? AND released=0 AND expires>?")
        .run(expires, new Date(expires).toISOString(), decisionId, now);
      if (result.changes !== 1) throw new RouterError('AGENT_ROUTER_LEASE_EXPIRED', 'Cannot renew an absent, released, or expired lease');
    });
  } finally { store.close(); }
}
