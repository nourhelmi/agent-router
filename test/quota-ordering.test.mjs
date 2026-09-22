import test from 'node:test';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, request } from './helpers.mjs';
import { Store } from '../dist/store.js';
import { parseCodexRateLimits, quotaBinding, refreshQuotas } from '../dist/quota.js';
import { evaluate } from '../dist/engine.js';
import { route, release } from '../dist/index.js';

const collector = () => ({ provider: 'codex', source: 'app-server', command: process.execPath, windowModels: {} });
const response = (allowed, usedPercent = 20) => ({ ordinaryUsageAllowed: allowed,
  rateLimits: { limitId: 'codex', primary: { usedPercent }, spendControlReached: false } });
const ordinary = q => q.gates.find(g => g.id === 'ordinary-usage');
const diagnostic = (f, s) => evaluate(f.config, request, s.quotas(), new Map(), [])[0];
function permutations(rows) {
  return rows.length ? rows.flatMap((row, i) => permutations(rows.filter((_, j) => j !== i)).map(rest => [row, ...rest])) : [[]];
}

test('permission history is arrival-independent, per-gate ordered, deny-on-ties, and separate from newest windows', async t => {
  const f = await fixture(t), pool = f.config.pools[0]; pool.collector = collector();
  const s = new Store(f.config); t.after(() => s.close());
  const base = Date.now() - 10000, at = n => new Date(base + n * 1000).toISOString();
  const sample = (allowed, wrapper, gate = wrapper) => {
    const q = parseCodexRateLimits(response(allowed, 20 + wrapper), pool, at(wrapper));
    ordinary(q).observedAt = at(gate); return q;
  };
  const missing = sample(null, 3); delete missing.gates;
  const lateMissing = sample(null, 5); delete lateMissing.gates;
  const cases = [
    ['older true in newer wrapper', [sample(false, 2), sample(true, 3, 1)], false, 2],
    ['false/null', [sample(false, 1), sample(null, 2)], false, 1],
    ['false/missing', [sample(false, 1), missing], false, 1],
    ['true/null/late old false', [sample(false, 1), sample(true, 2), sample(null, 3)], null, 3],
    ['true/missing/late old false', [sample(false, 1), sample(true, 2), missing], null, 3],
    ['equal-time contradictions', [sample(true, 2), sample(false, 2), sample(null, 2)], false, 2],
    ['new explicit recovery', [sample(false, 1), sample(true, 2)], true, 2],
    ['recovery after unknown', [sample(false, 1), sample(true, 2), sample(null, 3), sample(true, 4)], true, 4],
    ['newer true behind old gate in newer wrapper', [sample(false, 3, 1), sample(true, 2)], true, 2],
    ['newer null behind true in newer wrapper', [sample(true, 10, 4), sample(null, 5)], null, 5],
    ['newer true behind null in newer wrapper', [sample(null, 10, 4), sample(true, 5)], true, 5],
    ['newer missing behind true in newer wrapper', [sample(true, 10, 4), lateMissing], null, 5],
    ['late null and old false behind true wrapper', [sample(true, 10, 4), sample(null, 5), sample(false, 3)], null, 5],
    ['late null cannot clear newer explicit denial', [sample(true, 10, 4), sample(null, 5), sample(false, 6)], false, 6],
  ];
  for (const [name, rows, allowed, gateTime] of cases) {
    let expected;
    for (const sequence of permutations(rows)) {
      s.db.exec('DELETE FROM quota_cache');
      for (const q of sequence) s.putQuota(q);
      const q = s.quotas().get(pool.id);
      assert.equal(ordinary(q).allowed, allowed, name);
      assert.equal(ordinary(q).observedAt, at(gateTime), name);
      assert.equal(q.windows[0].usedPercent, Math.max(...rows.map(r => r.windows[0].usedPercent)), name);
      assert.equal(diagnostic(f, s).eligible, allowed !== false, name);
      if (allowed === null) assert.equal(diagnostic(f, s).quota, 'unknown', name);
      if (expected) assert.deepEqual(q, expected, `arrival permutation: ${name}`);
      expected = q;
    }
  }
  // Both the null view and the last true fact survive reopening independently of wrapper time.
  s.db.exec('DELETE FROM quota_cache');
  s.putQuota(sample(true, 10, 4)); s.putQuota(sample(null, 5));
  const reopened = new Store(f.config); t.after(() => reopened.close());
  reopened.putQuota(sample(false, 3));
  assert.equal(ordinary(reopened.quotas().get(pool.id)).allowed, null);
  assert.equal(ordinary(reopened.quotas().get(pool.id)).observedAt, at(5));
  assert.equal(reopened.quotas().get(pool.id).observedAt, at(10));
});

test('gate recovery and late denials preserve exact model scopes', async t => {
  const f = await fixture(t), pool = f.config.pools[0]; pool.collector = collector();
  pool.collector.windowModels.special = ['openai-codex/a'];
  const s = new Store(f.config); t.after(() => s.close());
  const at = offset => new Date(Date.now() - 10000 + offset).toISOString();
  const denied = parseCodexRateLimits({ ...response(true), rateLimitsByLimitId: {
    special: { limitId: 'special', spendControlReached: true },
  } }, pool, at(0));
  const unknown = parseCodexRateLimits(response(null), pool, at(1000));
  s.putQuota(unknown); s.putQuota(denied);
  assert.deepEqual(s.quotas().get('codex').gates.find(g => g.id === 'special:permission').models, ['openai-codex/a']);
  assert.ok(diagnostic(f, s).reasons.includes('provider-denied:special:permission'));
});

test('refresh claims sample time after writer admission, order same-ms attempts, and fence old statuses', async t => {
  const f = await fixture(t), pool = f.config.pools[0]; pool.collector = collector();
  const s = new Store(f.config); t.after(() => s.close());
  const base = Date.now(); let clock = base;
  t.mock.method(Date, 'now', () => clock);
  const transaction = s.transaction;
  const delayed = t.mock.method(s, 'transaction', function (fn) {
    return transaction.call(this, () => { clock = base + 200; return fn(); });
  });
  const key = `${pool.id}:${quotaBinding(pool)}`, first = s.claimRefresh(key, 0);
  assert.equal(first.attempted, base + 200);
  delayed.mock.restore();
  const second = s.claimRefresh(key, 0);
  assert.equal(second.attempted, first.attempted); assert.equal(second.token, first.token + 1);
  assert.equal(s.claimRefresh(key, 1), undefined);
  const old = parseCodexRateLimits(response(false), pool, new Date(first.attempted).toISOString());
  const newer = parseCodexRateLimits(response(true), pool, new Date(second.attempted).toISOString());
  for (const sequence of [[[old, first], [newer, second]], [[newer, second], [old, first]]]) {
    s.db.exec('DELETE FROM quota_cache');
    for (const [q, claim] of sequence) s.putQuota(q, claim.token);
    assert.equal(ordinary(s.quotas().get('codex')).allowed, true);
  }
  s.refreshed(key, 'new-status', second); s.refreshed(key, 'old-status', first);
  assert.equal(s.refreshStatus()[0].status, 'new-status');
});

test('unsequenced equal-time imports cannot erase explicit read ordering or suppress an ambiguous denial', async t => {
  const f = await fixture(t), pool = f.config.pools[0]; pool.collector = collector();
  const s = new Store(f.config); t.after(() => s.close());
  const now = new Date().toISOString();
  const readDenied = parseCodexRateLimits(response(false), pool, now);
  const readRecovered = parseCodexRateLimits(response(true), pool, now);
  for (const manualAllowed of [true, false]) {
    const imported = parseCodexRateLimits(response(manualAllowed), pool, now);
    for (const sequence of permutations([[imported, 0], [readDenied, 1], [readRecovered, 2]])) {
      s.db.exec('DELETE FROM quota_cache');
      for (const [q, token] of sequence) s.putQuota(q, token);
      assert.equal(ordinary(s.quotas().get('codex')).allowed, manualAllowed);
    }
  }
});

function signal(t, dir, name) {
  let close;
  const promise = new Promise((resolve, reject) => {
    const watcher = watch(dir, (_event, file) => { if (file === name) { close(); resolve(); } });
    const timer = setTimeout(() => { close(); reject(Error(`missing mock signal: ${name}`)); }, 5000);
    close = () => { watcher.close(); clearTimeout(timer); };
  });
  t.after(() => close());
  return promise;
}

for (const scenario of [
  { name: 'delayed old allow cannot clear newer deny', first: true, second: false, expected: false },
  { name: 'delayed old denial survives newer unknown', first: false, second: null, expected: false },
  { name: 'delayed old error cannot replace newer success status', first: 'error', second: true, expected: true },
  { name: 'delayed old success cannot replace newer error status', first: true, second: 'error', expected: true },
  { name: 'previous collector completion cannot evict current binding denial', first: true, second: false, expected: false, rebind: true },
]) test(`overlapping mock subprocess reads: ${scenario.name}`, async t => {
  const f = await fixture(t), pool = f.config.pools[0]; pool.collector = collector();
  f.config.policy.refreshCooldownMs = 1; f.config.policy.refreshTimeoutMs = 10000;
  const s = new Store(f.config), other = new Store(f.config); t.after(() => { other.close(); s.close(); });
  const sampled = join(f.dir, 'sampled'), release = join(f.dir, 'release');
  await writeFile(join(f.config.stateDir, 'app-server'), `
    const fs=require('node:fs'), rl=require('node:readline').createInterface({input:process.stdin});
    const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    rl.on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='initialize')send({id:1,result:{}});
      else if(m.method==='account/rateLimits/read') {
        const first=!fs.existsSync(${JSON.stringify(sampled)});
        const allowed=first?${JSON.stringify(scenario.first)}:${JSON.stringify(scenario.second)};
        const reply=()=>send(allowed==='error'?{id:2,error:{message:'synthetic failure'}}:
          {id:2,result:{...${JSON.stringify(response(true))},ordinaryUsageAllowed:allowed,
            rateLimits:{limitId:'codex',primary:{usedPercent:first?20:40},spendControlReached:false}}});
        if(first) {
          const watcher=fs.watch(${JSON.stringify(f.dir)},(_event,file)=>{if(file==='release'){watcher.close();reply();}});
          fs.writeFileSync(${JSON.stringify(sampled)},'sampled');
        } else reply();
      } else if(m.method!=='initialized')throw Error('unexpected RPC');
    });
  `);
  const started = signal(t, f.dir, 'sampled'), earlier = refreshQuotas(f.config, s, true);
  try {
    await started;
    const oldKey = `${pool.id}:${quotaBinding(pool)}`, firstStart = s.refreshStatus().find(r => r.pool === oldKey).attempted;
    if (scenario.rebind) {
      const alias = join(f.dir, 'node-alias'); await symlink(process.execPath, alias); pool.collector.command = alias;
    }
    await refreshQuotas(f.config, other, true);
    const newKey = `${pool.id}:${quotaBinding(pool)}`, secondStart = s.refreshStatus().find(r => r.pool === newKey).attempted;
    assert.ok(secondStart > firstStart);
    if (scenario.second !== 'error') {
      assert.equal(ordinary(s.quotas().get('codex')).allowed, scenario.second);
      assert.equal(s.quotas().get('codex').observedAt, new Date(secondStart).toISOString());
    }
    await writeFile(release, 'release older response'); await earlier;
    const q = s.quotas().get('codex');
    assert.equal(ordinary(q).allowed, scenario.expected);
    assert.equal(diagnostic(f, s).eligible, scenario.expected !== false);
    assert.equal(q.windows[0].usedPercent, scenario.second === 'error' ? 20 : 40);
    assert.equal(q.observedAt, new Date(scenario.second === 'error' ? firstStart : secondStart).toISOString());
    assert.equal(s.refreshStatus().find(r => r.pool === newKey).status, scenario.second === 'error' ? 'QUOTA_RPC_ERROR' : 'ok');
    if (scenario.rebind) {
      assert.equal(q.binding, quotaBinding(pool));
      assert.equal(s.db.prepare("SELECT count(*) AS n FROM quota_cache WHERE pool='codex' AND binding<>''").get().n, 2);
    }
  } finally { await writeFile(release, 'cleanup'); await earlier; }
});

test('binding-specific migration preserves legacy table, live leases, audit data and IDs', async t => {
  const f = await fixture(t), decision = await route({ ...request, requestId: 'migration-lease' }, f.options);
  const settled = await route({ ...request, requestId: 'settled-audit' }, f.options); await release(settled.id, f.options);
  const pool = f.config.pools[0]; pool.collector = collector();
  const legacy = new DatabaseSync(join(f.config.stateDir, 'router.sqlite')); t.after(() => legacy.close());
  legacy.exec('DROP TABLE quota_cache');
  const insert = legacy.prepare('INSERT INTO quota VALUES(?,?,?) ON CONFLICT(pool) DO UPDATE SET observed=excluded.observed,data=excluded.data');
  const base = Date.now() - 10000, at = n => new Date(base + n * 1000).toISOString();
  const denied = parseCodexRateLimits(response(false), pool, at(1));
  insert.run(pool.id, Date.parse(denied.observedAt), JSON.stringify(denied));
  const before = legacy.prepare('SELECT * FROM decisions ORDER BY id').all();
  const schema = legacy.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name IN ('quota','decisions') ORDER BY name").all();
  const s = new Store(f.config); t.after(() => s.close());
  assert.equal(ordinary(s.quotas().get('codex')).allowed, false);
  assert.equal(s.active().get('codex'), 1); assert.equal(s.previous('migration-lease').decision.id, decision.id);
  const oldPool = structuredClone(pool); oldPool.collector.command = 'previous-collector';
  s.putQuota(parseCodexRateLimits(response(true), oldPool, at(3)));
  assert.equal(ordinary(s.quotas().get('codex')).allowed, false);
  assert.equal(diagnostic(f, s).eligible, false);
  // A statement prepared by an already-loaded old client still works after migration.
  const recovered = parseCodexRateLimits(response(true), pool, at(4));
  insert.run(pool.id, Date.parse(recovered.observedAt), JSON.stringify(recovered));
  const reopened = new Store(f.config); t.after(() => reopened.close());
  assert.equal(ordinary(reopened.quotas().get('codex')).allowed, true);
  assert.deepEqual(legacy.prepare('SELECT * FROM decisions ORDER BY id').all(), before);
  assert.deepEqual(legacy.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name IN ('quota','decisions') ORDER BY name").all(), schema);
  assert.equal(JSON.parse(legacy.prepare('SELECT data FROM quota WHERE pool=?').get(pool.id).data).binding, denied.binding);
});
