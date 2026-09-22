#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultConfigPath, initialConfig, loadConfig, parseConfig, privateJson, readJson, check, object, benchmarks, quotaSnapshot } from './config.js';
import { importProfiles } from './profiles.js';
import { fetchBenchmarks } from './benchmarks.js';
import { parseClaudeStatusline, parseCodexBar, quotaBinding, refreshQuotas } from './quota.js';
import { route, release, renew } from './index.js';
import { Store } from './store.js';
import { RouterError, type RouteRequest, type BenchmarkSource } from './types.js';

const help = `agent-router commands (JSON on stdout; local state is private):
  init [--profiles DIR] [--codexbar] [--config FILE]   create config; never overwrite
  route --file REQUEST.json [--dry-run]              --file - reads stdin
  release ID | renew ID
  status                                             quotas, leases, evidence coverage
  quota refresh                                      configured explicit collectors only
  quota ingest --file SNAPSHOT.json
  quota codexbar --pool ID --file DATA.json            normalize existing JSON, preserve timestamp
  quota statusline --pool ID                          read fresh Claude statusline stdin, no stdout
  benchmarks refresh --source deepswe|artificial-analysis
  benchmarks import --file OBSERVATIONS.json
  benchmarks list
  benchmarks map --candidate ID --source SOURCE --model SOURCE_MODEL
    --variant VARIANT --metric METRIC --cohort COHORT --evidence-url HTTPS_URL
  auth typesafe|artificial-analysis                   save matching environment key privately
All commands accept --config FILE (default AGENT_ROUTER_CONFIG or ~/.config/agent-router/config.json).
No command changes provider authentication, browser settings, or Claude statusLine settings.`;

async function stdinJson(): Promise<unknown> {
  let data = '';
  for await (const chunk of process.stdin) { data += chunk; check(Buffer.byteLength(data) <= 8_000_000, 'stdin too large'); }
  return JSON.parse(data);
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, profiles: { type: 'string' }, codexbar: { type: 'boolean' },
    file: { type: 'string' }, pool: { type: 'string' }, source: { type: 'string' },
    candidate: { type: 'string' }, model: { type: 'string' }, variant: { type: 'string' }, metric: { type: 'string' },
    cohort: { type: 'string' }, 'evidence-url': { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const [command, sub] = positionals, path = resolve(values.config || defaultConfigPath());
  const output = (value: unknown) => console.log(JSON.stringify(value));
  const input = () => { check(values.file, '--file is required'); return values.file === '-' ? stdinJson() : readJson(values.file); };
  if (!command || values.help) { console.log(help); return; }
  if (command === 'init') {
    try { await access(path); throw new RouterError('CONFIG_EXISTS', 'Config already exists; refusing to overwrite'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const config = initialConfig(path);
    config.candidates = await importProfiles(values.profiles || join(homedir(), '.pi', 'agent', 'intelligence-profiles'));
    check(config.candidates.length, 'No profile candidates found');
    if (values.codexbar) for (const pool of config.pools) {
      if (pool.id === 'cursor') continue;
      pool.collector = { provider: pool.id === 'codex' ? 'codex' : 'claude', source: pool.id === 'codex' ? 'cli' : 'oauth', command: 'codexbar', windowModels: {} };
    }
    parseConfig(config);
    await privateJson(path, config, true);
    output({ config: path, candidates: config.candidates.length, enabled: true }); return;
  }
  if (command === 'route') { output(await route(await input() as RouteRequest, { configPath: path, dryRun: values['dry-run'] })); return; }
  if (command === 'release' || command === 'renew') {
    check(sub, 'Decision ID required'); await (command === 'release' ? release : renew)(sub, { configPath: path }); output({ [command]: sub }); return;
  }
  const config = await loadConfig(path);
  if (command === 'auth') {
    check(sub === 'typesafe' || sub === 'artificial-analysis', 'Unknown credential');
    const keyName = sub === 'typesafe' ? 'typesafe' : 'artificialAnalysis';
    const value = process.env[sub === 'typesafe' ? 'TYPESAFE_API_KEY' : 'ARTIFICIAL_ANALYSIS_API_KEY'];
    check(value !== undefined && value.trim(), 'Required credential environment variable is missing');
    let prior: Record<string, unknown> = {};
    try { prior = object(await readJson(config.credentialsFile)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await privateJson(config.credentialsFile, { ...prior, [keyName]: value.trim() }); output({ saved: sub }); return;
  }
  const store = new Store(config);
  try {
    if (command === 'status') {
      output({ version: 1, enabled: config.enabled, quotas: [...store.quotas().values()], active: Object.fromEntries(store.active()), refresh: store.refreshStatus(),
        benchmarks: { observations: store.evidence().length, candidates: config.candidates.map(c => ({ id: c.id, mapped: c.benchmarks.length })) } }); return;
    }
    if (command === 'quota') {
      if (sub === 'refresh') { await refreshQuotas(config, store, true); output({ refresh: store.refreshStatus(), quotas: [...store.quotas().values()] }); return; }
      const pool = config.pools.find(p => p.id === values.pool);
      let snapshot;
      if (sub === 'ingest') snapshot = quotaSnapshot(await input());
      else {
        check(pool, '--pool must name a configured pool');
        snapshot = sub === 'codexbar' ? parseCodexBar(await input(), pool) : sub === 'statusline' ? parseClaudeStatusline(await stdinJson(), pool.id, new Date().toISOString()) : undefined;
        check(snapshot, 'Unknown quota subcommand');
      }
      const boundPool = config.pools.find(p => p.id === snapshot.pool);
      check(boundPool, 'Unknown snapshot pool');
      const binding = quotaBinding(boundPool);
      check(snapshot.binding === undefined || snapshot.binding === binding, 'Snapshot belongs to an old/different collector binding');
      snapshot.binding = binding;
      store.putQuota(snapshot); if (sub !== 'statusline') output({ stored: snapshot.pool }); return;
    }
    if (command === 'benchmarks') {
      if (sub === 'list') { output(store.evidence()); return; }
      if (sub === 'map') {
        const candidate = config.candidates.find(c => c.id === values.candidate); check(candidate, 'Unknown candidate');
        const row = store.evidence().find(o => o.source === values.source && o.model === values.model && o.variant === values.variant && o.metric === values.metric && o.cohort === values.cohort);
        check(row && values['evidence-url'], 'Exact cached benchmark row and --evidence-url required');
        const { source, model, variant, metric, cohort } = row;
        const mapping = { source, model, variant, metric, cohort, evidenceUrl: values['evidence-url'], verifiedAt: new Date().toISOString() };
        check(new URL(mapping.evidenceUrl).protocol === 'https:', 'Mapping evidence must use HTTPS');
        candidate.benchmarks = candidate.benchmarks.filter(m => !(m.source === source && m.metric === metric));
        candidate.benchmarks.push(mapping);
        await privateJson(path, config); output({ mapped: candidate.id, mapping }); return;
      }
      let observations;
      if (sub === 'import') observations = benchmarks(await input());
      else {
        check(sub === 'refresh' && ['deepswe', 'artificial-analysis'].includes(values.source || ''), 'Unknown benchmark source/command');
        observations = await fetchBenchmarks(values.source as BenchmarkSource, config);
      }
      check(observations.length > 0, 'No benchmark observations; existing evidence preserved');
      const sources = new Set(observations.map(o => o.source));
      store.putEvidence([...store.evidence().filter(o => !sources.has(o.source)), ...observations]);
      output({ stored: observations.length, sources: [...sources] }); return;
    }
    throw new RouterError('UNKNOWN_COMMAND', 'Unknown command; use --help');
  } finally { store.close(); }
}
main().catch(error => {
  // Do not echo arbitrary subprocess/network errors or input documents.
  console.error(JSON.stringify({ code: error instanceof RouterError ? error.code : 'AGENT_ROUTER_ERROR',
    message: error instanceof RouterError ? error.message : 'Command failed; verify paths, JSON and configuration' }));
  process.exitCode = 1;
});
