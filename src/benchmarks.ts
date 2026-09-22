import { benchmarks, check, credential, object, text, timestamp } from './config.js';
import { responseJson } from './jev.js';
import type { BenchmarkObservation, Candidate, Config } from './types.js';

export const DEEPSWE_URL = 'https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json';
export const AA_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';
export function parseDeepSWE(raw: unknown): BenchmarkObservation[] {
  const data = object(raw); check(Array.isArray(data.rows), 'Invalid DeepSWE rows');
  timestamp(data.generated_at); text(data.unit); check(data.n_tasks_in_set === 113, 'DeepSWE task set changed; review adapter');
  return benchmarks(data.rows.flatMap((item: unknown) => {
    const row = object(item);
    // Incomplete coverage does not enter the full-task-set cohort.
    if (row.pass_at_1 == null || row.n_tasks_attempted !== data.n_tasks_in_set) return [];
    text(row.model); text(row.harness); text(row.config);
    check(typeof row.pass_at_1 === 'number' && row.pass_at_1 >= 0 && row.pass_at_1 <= 1, 'Invalid DeepSWE pass rate');
    const reasoning = row.reasoning_effort == null ? 'unspecified' : row.reasoning_effort;
    text(reasoning);
    return [{ source: 'deepswe', model: row.model,
      variant: `${row.harness}:${reasoning}:${row.config}`,
      metric: 'pass_at_1', cohort: `v1.1:113:${row.harness}:${reasoning}`,
      value: row.pass_at_1, higherIsBetter: true, observedAt: data.generated_at,
      sourceUrl: DEEPSWE_URL, methodology: `${data.unit} Reasoning: ${reasoning}. Configuration: ${row.config}. Publication time, not individual evaluation date.`,
      sampleSize: row.n_attempted }];
  }));
}
export function parseArtificialAnalysis(raw: unknown, observedAt = new Date().toISOString()): BenchmarkObservation[] {
  const data = object(raw); check(Array.isArray(data.data), 'Invalid Artificial Analysis rows');
  check(typeof data.intelligence_index_version === 'number' && Number.isFinite(data.intelligence_index_version), 'Missing AA methodology version');
  return benchmarks(data.data.flatMap((item: unknown) => {
    const row = object(item); text(row.slug); text(row.name);
    const evaluations = object(row.evaluations);
    return ['artificial_analysis_intelligence_index', 'artificial_analysis_coding_index', 'artificial_analysis_agentic_index']
      .filter(metric => evaluations[metric] != null).map(metric => ({
        source: 'artificial-analysis', model: row.slug, variant: row.name, metric,
        cohort: `index-v${data.intelligence_index_version}`, value: evaluations[metric], higherIsBetter: true,
        observedAt, sourceUrl: AA_URL,
        methodology: `Artificial Analysis index API version ${data.intelligence_index_version}; patch version and per-model evaluation date unspecified. Source name preserves the reported model variant. Internal-use cache; attribution required.`,
      }));
  }));
}
export async function fetchBenchmarks(source: 'deepswe' | 'artificial-analysis', config: Config): Promise<BenchmarkObservation[]> {
  if (source === 'deepswe') {
    const response = await fetch(DEEPSWE_URL, { signal: AbortSignal.timeout(20000), redirect: 'error' });
    check(response.ok, `DeepSWE returned HTTP ${response.status}`);
    return parseDeepSWE(await responseJson(response, 8_000_000));
  }
  const key = await credential(config, 'artificialAnalysis'); check(key, 'ARTIFICIAL_ANALYSIS_API_KEY required; no public data API');
  const rows: BenchmarkObservation[] = [];
  let version: number | undefined;
  for (let page = 1; page <= 30; page++) {
    const response = await fetch(`${AA_URL}?page=${page}`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(20000), redirect: 'error' });
    check(response.ok, `Artificial Analysis returned HTTP ${response.status}`);
    const data = object(await responseJson(response, 8_000_000));
    if (version !== undefined) check(version === data.intelligence_index_version, 'AA methodology changed during pagination');
    version = data.intelligence_index_version;
    rows.push(...parseArtificialAnalysis(data));
    const pagination = object(data.pagination);
    check(pagination.page === page && typeof pagination.has_more === 'boolean', 'Invalid AA pagination');
    if (!pagination.has_more) return benchmarks(rows);
  }
  throw new Error('Artificial Analysis pagination exceeded bounded request budget');
}
export function benchmarkScore(candidate: Candidate, observations: BenchmarkObservation[], maxAge: number, family: string | undefined, now = Date.now()): { score?: number; evidence: BenchmarkObservation[] } {
  const fresh = observations.filter(o => Date.parse(o.observedAt) <= now + 60000 && now - Date.parse(o.observedAt) <= maxAge);
  const evidence = fresh.filter(o => candidate.benchmarks.some(r =>
    r.source === o.source && r.model === o.model && r.variant === o.variant && r.metric === o.metric && r.cohort === o.cohort) &&
    (family === 'coding' || (o.source === 'artificial-analysis' && o.metric === 'artificial_analysis_intelligence_index')));
  const scores = evidence.flatMap(o => {
    const cohort = fresh.filter(c => c.source === o.source && c.metric === o.metric && c.cohort === o.cohort && c.higherIsBetter === o.higherIsBetter);
    if (cohort.length < 2) return [];
    const less = cohort.filter(c => o.higherIsBetter ? c.value < o.value : c.value > o.value).length;
    const tied = cohort.filter(c => c.value === o.value).length;
    // Midrank percentile of configurations in this metric/cohort, not a calibrated success probability.
    return [(less + (tied - 1) / 2) / (cohort.length - 1)];
  });
  return { ...(scores.length ? { score: scores.reduce((a, b) => a + b, 0) / scores.length } : {}), evidence };
}
