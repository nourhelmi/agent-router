export type Thinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Harness = 'pi' | 'native';
export type BenchmarkSource = 'deepswe' | 'artificial-analysis';
export interface BenchmarkRef {
  source: BenchmarkSource;
  model: string;
  variant: string;
  metric: string;
  cohort: string;
}
export interface BenchmarkMapping extends BenchmarkRef {
  evidenceUrl: string;
  verifiedAt: string;
}
export interface Candidate {
  id: string;
  model: string;
  thinking: Thinking;
  roles: string[];
  harnesses: Harness[];
  pool: string;
  fit: string;
  prior: number;
  rank: number;
  roleRanks?: Record<string, number>;
  enabled: boolean;
  profiles: string[];
  /** Requires a fresh semantic scope judgment; pins and fallback cannot bypass it. */
  taskScope?: 'small-or-verification';
  benchmarks: BenchmarkMapping[];
  /** Relative quota burn of one assignment, 0 (cheapest) to 1 (dearest). Operator-set; see policy.costWeight. */
  cost?: number;
}
/**
 * One line of a hand-edited roster. `model` is `<host>/<model id>`; the host names the quota pool
 * unless `pool` says otherwise. File order is preference order within each role.
 */
export interface RosterEntry {
  model: string;
  effort: Thinking;
  roles: string[];
  /** 0 (cheapest) to 1 (dearest): the share of your limits one assignment burns. */
  cost: number;
  /** One phrase on what the model is, e.g. "the workhorse". */
  about?: string;
  /** When to pick it. Concrete kinds of work; this and `avoid` are what Jev judges. */
  use: string;
  /** When not to. Naming what a model is worse at is what lets the router tell models apart. */
  avoid?: string;
  scope?: 'small-or-verification';
  prior?: number;
  pool?: string;
  enabled?: boolean;
}
export interface Pool {
  id: string;
  reservePercent: number;
  unknown: 'allow' | 'penalize' | 'exclude';
  /** User assertion: this collector observes the account used by this pool's workers. */
  collector?: {
    provider: 'codex' | 'claude';
    /** `web` reads CodexBar's cached web session: ~2s, versus ~30s for Claude's CLI probe. */
    source: 'cli' | 'oauth' | 'web' | 'app-server';
    command: string;
    account?: string;
    /** Empty list explicitly marks a window irrelevant to this catalog. */
    windowModels: Record<string, string[]>;
  };
}
export interface Config {
  version: 1;
  enabled: boolean;
  modulePath: string;
  stateDir: string;
  credentialsFile: string;
  /** Private, manually refreshed observations. No network fetch during routing. */
  benchmarkFile?: string;
  /** A plain roster (see RosterEntry) that replaces `candidates` on every load. */
  rosterFile?: string;
  candidates: Candidate[];
  pools: Pool[];
  policy: {
    quotaMaxAgeMs: number;
    refreshCooldownMs: number;
    refreshTimeoutMs: number;
    leaseMs: number;
    benchmarkMaxAgeMs: number;
    benchmarkWeight: number;
    capacityWeight: number;
    unknownPenalty: number;
    /** Utility subtracted per unit of candidate cost; 0 ignores cost. */
    costWeight: number;
    /** How far reviewed outcomes may move task fit away from the candidate's prior; 0 ignores them. */
    outcomeWeight: number;
    /** Pseudo-observations at the candidate's prior: evidence needed before outcomes dominate. */
    outcomePrior: number;
    /** Age at which an outcome counts half. */
    outcomeHalfLifeMs: number;
  };
  jev: { model: string; timeoutMs: number; minConfidence: number; enabled: boolean };
}
export interface QuotaWindow {
  id: string;
  usedPercent: number;
  known?: boolean;
  resetAt?: string;
  windowMinutes?: number;
  models?: string[];
}
export interface QuotaGate {
  id: string;
  allowed: boolean | null;
  observedAt: string;
  models?: string[];
}
export interface QuotaSnapshot {
  version: 1;
  pool: string;
  source: string;
  observedAt: string;
  binding?: string;
  windows: QuotaWindow[];
  /** Explicit provider permissions; null must not clear a previous denial. */
  gates?: QuotaGate[];
  warnings: string[];
}
export interface BenchmarkObservation extends BenchmarkRef {
  value: number;
  higherIsBetter: boolean;
  observedAt: string;
  sourceUrl: string;
  methodology: string;
  sampleSize?: number;
}
/**
 * A reviewed result of work a model did in a role. `review`: a checker's verdict on that work;
 * `grade`: the dispatching parent's verdict. Recording an existing id replaces it.
 */
export interface Outcome {
  version: 1;
  id: string;
  at: string;
  /** `provider/model` or the bare model id; matched to candidates without the provider. */
  model: string;
  thinking: Thinking;
  role: string;
  signal: 'review' | 'grade';
  success: boolean;
  source: string;
  run?: string;
  note?: string;
}
export interface OutcomeScore { n: number; mean: number }
export interface RouteRequest {
  role: string;
  task: string;
  harness: Harness;
  pin?: { model: string; thinking?: Thinking };
  requestId?: string;
}
export interface RouteOptions { configPath?: string; dryRun?: boolean }
export interface TaskScopeAssessment { small: number; verification: number }
export interface CandidateDiagnostic {
  id: string;
  eligible: boolean;
  reasons: string[];
  quota: 'known' | 'unknown';
  headroom?: number;
  /** Informational live lease count; never an eligibility or scoring input. */
  active: number;
  benchmark?: number;
  benchmarkEvidence: BenchmarkObservation[];
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  taskScope?: TaskScopeAssessment;
  cost?: number;
  outcome?: OutcomeScore;
  utility?: number;
}
export interface RouteDecision {
  version: 1;
  id: string;
  selected: { model: string; thinking: Thinking };
  strategy: 'jev' | 'fallback' | 'pinned';
  at: string;
  expiresAt: string;
  reserved: boolean;
  candidateId: string;
  pool: string;
  taskDigest: string;
  reason: string;
  jevModel?: string;
  quotas: QuotaSnapshot[];
  policy: Config['policy'];
  catalogDigest: string;
  candidates: CandidateDiagnostic[];
}
export class RouterError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'RouterError'; }
}
