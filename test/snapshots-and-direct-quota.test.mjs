import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, request, candidate, benchmark } from './helpers.mjs';
import { parseConfig, privateJson } from '../dist/config.js';
import { parseCodexRateLimits, refreshQuotas, runJson } from '../dist/quota.js';
import { parseArtificialAnalysisPage, fetchBenchmarks, AA_PAGE_URL } from '../dist/benchmarks.js';
import { evaluate } from '../dist/engine.js';
import { route } from '../dist/index.js';
import { Store } from '../dist/store.js';

const exec = promisify(execFile), cli = new URL('../dist/cli.js', import.meta.url).pathname;
const collector = () => ({ provider: 'codex', source: 'app-server', command: process.execPath, windowModels: {} });
const bucket = (extra = {}) => ({ limitId: 'codex', primary: { usedPercent: 39, windowDurationMins: 10080, resetsAt: Math.floor(Date.now()/1000) + 3600 }, secondary: null, spendControlReached: false, rateLimitReachedType: null, ...extra });
const response = (extra = {}) => { const b = bucket(); return { ordinaryUsageAllowed: true, accountId: 'private-account', credits: { balance: 'private-balance' }, rateLimits: b, rateLimitsByLimitId: { codex: b }, ...extra }; };
const page = (data = [{ label: 'Synthetic A (max with fallback)', intelligenceIndex: 42.5, detailsUrl: '/models/synthetic-a' }, { label: 'Missing', intelligenceIndex: null }]) =>
  `Artificial Analysis Intelligence Index v4.3.2<script type="application/ld+json">${JSON.stringify({ '@type': 'Dataset', name: 'Artificial Analysis Intelligence Index', data })}</script>`;

async function directFixture(t) {
  const f = await fixture(t); f.config.pools[0].collector = collector(); return f;
}
const diagnostics = (f, snapshot) => evaluate(f.config, request, new Map([['codex', snapshot]]), new Map(), []);

test('direct Codex preserves actual window duration, scopes and provider permissions without identity or billing data', async t => {
  const f = await directFixture(t), p = f.config.pools[0], now = new Date().toISOString();
  const q = parseCodexRateLimits(response(), p, now);
  assert.equal(q.source, 'codex:app-server'); assert.equal(q.observedAt, now);
  assert.equal(q.windows.length, 1); assert.equal(q.windows[0].windowMinutes, 10080);
  assert.equal(q.windows[0].usedPercent, 39); assert.equal(q.gates[0].allowed, true);
  assert.equal(diagnostics(f, q)[0].quota, 'known');
  assert.doesNotMatch(JSON.stringify(q), /private-account|private-balance|accountId|credits/);
  const noWindows = parseCodexRateLimits(response({ rateLimits: {}, rateLimitsByLimitId: null, ordinaryUsageAllowed: null }), p, now);
  assert.deepEqual(noWindows.windows, []); assert.equal(diagnostics(f, noWindows)[0].quota, 'unknown');
  assert.throws(() => parseCodexRateLimits(response({ ordinaryUsageAllowed: 'yes' }), p, now));
  assert.throws(() => parseCodexRateLimits(response({ rateLimitsByLimitId: { wrong: bucket() } }), p, now), /identity mismatch/);
  const bad = structuredClone(f.config); bad.pools[0].collector.account = 'not-a-selector';
  assert.throws(() => parseConfig(bad), /App-server/);
  delete bad.pools[0].collector.account; bad.pools[0].collector.provider = 'claude';
  assert.throws(() => parseConfig(bad), /App-server/);
});

test('named bucket denials are scoped only by explicit operator mappings, and spend limits constrain admission', async t => {
  const f = await directFixture(t), p = f.config.pools[0], now = new Date().toISOString();
  f.config.candidates.push(candidate('c')); p.collector.windowModels.special = ['openai-codex/a'];
  const raw = response(); raw.rateLimitsByLimitId.special = bucket({ limitId: 'special', spendControlReached: true });
  let q = parseCodexRateLimits(raw, p, now), ds = diagnostics(f, q);
  assert.equal(ds[0].eligible, false); assert.equal(ds[2].eligible, true);
  assert.ok(ds[0].reasons.includes('provider-denied:special:permission'));
  delete p.collector.windowModels.special;
  q = parseCodexRateLimits(raw, p, now); ds = diagnostics(f, q);
  assert.equal(ds[2].eligible, false); assert.match(q.warnings.join(), /unmapped-scoped-bucket/);
  p.collector.windowModels.special = [];
  assert.equal(diagnostics(f, parseCodexRateLimits(raw, p, now))[0].eligible, true);
  const spend = bucket({ individualLimit: { remainingPercent: 5, resetsAt: Math.floor(Date.now()/1000) + 3600, used: 'not persisted', limit: 'not persisted' } });
  q = parseCodexRateLimits(response({ rateLimits: spend, rateLimitsByLimitId: null }), p, now);
  assert.equal(q.windows[1].usedPercent, 95); assert.ok(diagnostics(f, q)[0].reasons.includes('reserve:codex:individualLimit'));
  const conflict = response(); conflict.rateLimitsByLimitId = { codex: bucket({ primary: { usedPercent: 100 } }) };
  q = parseCodexRateLimits(conflict, p, now);
  assert.equal(q.windows.length, 2); assert.equal(diagnostics(f, q)[0].eligible, false);
});

test('explicit denials survive null, missing, stale and reset updates until explicit recovery; binding changes isolate accounts', async t => {
  const f = await directFixture(t), p = f.config.pools[0], s = new Store(f.config); t.after(() => s.close());
  const base = Date.now(), at = offset => new Date(base + offset).toISOString(), old = at(-10000);
  s.putQuota(parseCodexRateLimits(response({ ordinaryUsageAllowed: false }), p, old));
  s.putQuota(parseCodexRateLimits(response({ ordinaryUsageAllowed: null }), p, at(-9000)));
  let q = s.quotas().get('codex'); assert.equal(q.gates[0].allowed, false); assert.equal(q.gates[0].observedAt, old);
  assert.equal(diagnostics(f, q)[0].eligible, false);
  s.putQuota(parseCodexRateLimits(response({ ordinaryUsageAllowed: true }), p, at(-20000)));
  assert.equal(s.quotas().get('codex').gates[0].allowed, false);
  const reset = parseCodexRateLimits(response({ ordinaryUsageAllowed: null }), p, at(-8000));
  reset.windows[0].resetAt = old; delete reset.gates;
  s.putQuota(reset); assert.equal(diagnostics(f, s.quotas().get('codex'))[0].eligible, false);
  s.putQuota(parseCodexRateLimits(response(), p, at(-7000)));
  assert.equal(diagnostics(f, s.quotas().get('codex'))[0].eligible, true);
  const inconsistent = response(); inconsistent.rateLimits = bucket({ spendControlReached: true });
  s.putQuota(parseCodexRateLimits(inconsistent, p, at(-6000)));
  assert.equal(diagnostics(f, s.quotas().get('codex'))[0].eligible, false);
  s.putQuota(parseCodexRateLimits(response(), p, at(-5000)));
  assert.equal(diagnostics(f, s.quotas().get('codex'))[0].eligible, true);
  s.putQuota(parseCodexRateLimits(response({ ordinaryUsageAllowed: false }), p, at(-4000)));
  p.collector.command = 'different-account-home-wrapper';
  s.putQuota(parseCodexRateLimits(response({ ordinaryUsageAllowed: null }), p, at(-3000)));
  assert.equal(s.quotas().get('codex').gates[0].allowed, null);
  p.unknown = 'exclude'; assert.equal(diagnostics(f, s.quotas().get('codex'))[0].eligible, false);
});

test('direct RPC performs only initialization and quota read; refresh caches a normalized snapshot', async t => {
  const f = await directFixture(t), log = join(f.dir, 'rpc.jsonl');
  await writeFile(join(f.config.stateDir, 'app-server'), `
    const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
    if(process.argv.at(-1)!=='--stdio')throw Error('wrong argv');
    const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    rl.on('line',s=>{const m=JSON.parse(s);fs.appendFileSync(${JSON.stringify(log)},s+'\\n');
      if(m.method==='initialize'){send({method:'notice',params:{}});send({id:1,result:{}});}
      else if(m.method==='account/rateLimits/read')send({id:2,result:${JSON.stringify(response())}});
      else if(m.method!=='initialized')throw Error('unexpected method');
    });`);
  const s = new Store(f.config); t.after(() => s.close());
  await refreshQuotas(f.config, s, true);
  assert.equal(s.refreshStatus()[0].status, 'ok'); assert.equal(s.quotas().get('codex').source, 'codex:app-server');
  const messages = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(messages.map(m=>m.method), ['initialize','initialized','account/rateLimits/read']);
  assert.deepEqual(messages[2].params, { excludeResetCreditDetails: true, supportsLunaReserve: false });
  await refreshQuotas(f.config, s); assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 3);
});

test('quota RPC rejects protocol errors, server requests, malformed/oversized output, early exit and timeout', async t => {
  const f = await fixture(t);
  for (const [body, code, timeout] of [
    ['console.log(JSON.stringify({id:1,error:{message:"synthetic-secret"}}))', 'QUOTA_RPC_ERROR', 3000],
    ['console.log(JSON.stringify({id:1,method:"approval/request"}))', 'QUOTA_INVALID_JSON', 3000],
    ['console.log("not JSON")', 'QUOTA_INVALID_JSON', 3000],
    ['process.stdout.write(" ".repeat(1000001))', 'QUOTA_OUTPUT_LIMIT', 3000],
    ['', 'QUOTA_RPC_INCOMPLETE', 3000],
    ['setInterval(()=>{},1000)', 'QUOTA_TIMEOUT', 150],
  ]) await assert.rejects(runJson(process.execPath, ['-e', body], f.dir, timeout, 'codex-app-server'), e => {
    assert.equal(e.code, code); assert.doesNotMatch(e.message, /synthetic-secret/); return true;
  });
});

test('public page snapshots preserve exact variant, metric/version and missing scores', () => {
  const rows = parseArtificialAnalysisPage(page());
  assert.equal(rows.length, 1); assert.equal(rows[0].variant, 'Synthetic A (max with fallback)');
  assert.equal(rows[0].model, 'synthetic-a'); assert.equal(rows[0].cohort, 'page-index-v4.3.2');
  assert.equal(rows[0].metric, 'artificial_analysis_intelligence_index'); assert.equal(rows[0].value, 42.5);
  assert.match(rows[0].methodology, /not the full catalog/);
  assert.throws(()=>parseArtificialAnalysisPage(page().replace('v4.3.2','unknown')));
  assert.throws(()=>parseArtificialAnalysisPage(page()+page()), /dataset changed/);
  assert.throws(()=>parseArtificialAnalysisPage(page()+'Artificial Analysis Intelligence Index v5.0'), /ambiguous/);
  assert.throws(()=>parseArtificialAnalysisPage(page([{label:'Synthetic',intelligenceIndex:1,detailsUrl:'https://different.test/models/fake'}])));
});

test('default AA refresh uses page data with no API key or credential read', async t => {
  const f = await fixture(t); await writeFile(f.config.credentialsFile, 'intentionally invalid: must not be read');
  const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, AA_PAGE_URL); assert.equal(options.headers, undefined); return new Response(page());
  });
  assert.equal((await fetchBenchmarks('artificial-analysis', f.config)).length, 1); assert.equal(mock.mock.callCount(), 1);
});

test('routing consumes edited private snapshots offline, while malformed files do not erase cached evidence', async t => {
  const f = await fixture(t), rows = [benchmark('private-only', .75)];
  const mock = t.mock.method(globalThis, 'fetch', async()=>{ throw Error('unexpected network'); });
  await privateJson(f.config.benchmarkFile, rows);
  await route(request, { ...f.options, dryRun: true });
  let s = new Store(f.config); assert.deepEqual(s.evidence(), rows); s.close(); assert.equal(mock.mock.callCount(), 0);
  rows[0].value = .8; await privateJson(f.config.benchmarkFile, rows);
  await route(request, { ...f.options, dryRun: true });
  s = new Store(f.config); assert.equal(s.evidence()[0].value, .8); s.close();
  await writeFile(f.config.benchmarkFile, 'broken'); await assert.rejects(route(request, f.options));
  s = new Store(f.config); assert.equal(s.evidence()[0].value, .8); assert.deepEqual([...s.active()], []); s.close();
});

test('CLI import/export stores private JSON and failed page refresh preserves the last good snapshot', async t => {
  const f = await fixture(t), input = join(f.dir,'input.json'), output = join(f.dir,'export.json'), preload = join(f.dir,'fetch.mjs');
  const rows = [benchmark('private-test', .7)]; await privateJson(input, rows);
  await exec(process.execPath, [cli,'benchmarks','import','--file',input,'--config',f.path]);
  assert.deepEqual(JSON.parse(await readFile(f.config.benchmarkFile,'utf8')), rows);
  await exec(process.execPath, [cli,'benchmarks','export','--file',output,'--config',f.path]);
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')), rows);
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
  const before = await readFile(f.config.benchmarkFile,'utf8');
  await writeFile(preload, 'globalThis.fetch=async()=>new Response("site markup changed");');
  await assert.rejects(exec(process.execPath, ['--import',preload,cli,'benchmarks','refresh','--source','artificial-analysis','--config',f.path]));
  assert.equal(await readFile(f.config.benchmarkFile,'utf8'), before);
});
