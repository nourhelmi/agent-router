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
  benchmarks: BenchmarkMapping[];
}
export interface Pool {
  id: string;
  reservePercent: number;
  unknown: 'allow' | 'penalize' | 'exclude';
  /** User assertion: this collector observes the account used by this pool's workers. */
  collector?: {
    provider: 'codex' | 'claude';
    source: 'cli' | 'oauth' | 'app-server';
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
export interface RouteRequest {
  role: string;
  task: string;
  harness: Harness;
  pin?: { model: string; thinking?: Thinking };
  requestId?: string;
}
export interface RouteOptions { configPath?: string; dryRun?: boolean }
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
