# Agent Router

Authoritative worker identity selection: **task-fit guidance + Jev judgments + observed quotas + explicitly mapped benchmarks**. Node 24+, TypeScript declarations, no runtime dependencies. MIT.

The caller assigns work and permissions. This package selects an exact `provider/model` and reasoning effort, reserves local concurrency, and explains the decision. It does **not** launch agents, alter prompts, switch accounts, access project files, or change the current advisor model. The objective is the best feasible route under configured policy and observed evidence—not an optimality guarantee.

## Install and initialize

```sh
git clone https://github.com/nourhelmi/agent-router.git
cd agent-router
npm ci
npm test
npm link
agent-router init --codex
agent-router auth typesafe            # reads TYPESAFE_API_KEY, never prints it
agent-router quota refresh
agent-router status
```

`init` imports the union of `~/.pi/agent/intelligence-profiles/*.json`, including each declared model's `defaultThinking` and every recommended effort. It deduplicates exact model/effort pairs and preserves fit, character and profile provenance. Recommendations are guidance, not role eligibility: imported candidates support advisor/builder/checker (and any additional declared roles), while recommendations set role-specific tie-break ranks. Optional catalog models remain available even without recommendation rows. Operators may add supported models or explicitly restrict candidate roles in router config. Initial priors are neutral `0.7`; the ACTIVE guide only supplies tie-break preference. Subsequent profile switches do not rewrite router policy. No reasoning efforts, model aliases or benchmark mappings are inferred. Native Codex `max` and native Cursor transport are excluded.

Configuration defaults to `~/.config/agent-router/config.json`; override with `AGENT_ROUTER_CONFIG` or `--config`. `init` refuses to overwrite configuration. It sets `enabled: true` and an absolute `modulePath` to the built library. Inspect policy before enabling a caller integration. Credentials and SQLite quota/lease/audit state live alongside config, **outside the checkout**. Files are `0600`; the state directory is `0700`. Environment keys override the optional credentials file. Benchmark snapshots have a separate configurable path below.

`--codex` uses the installed Codex CLI directly: a bounded `codex app-server --stdio` subprocess, initialization, and `account/rateLimits/read`. It does not need CodexBar, a GUI, or a long-running router daemon. Codex owns its normal authentication; the router never reads/copies its tokens, starts login, switches accounts, consumes reset credits, or enables automatic reserve/paid fallback. It uses the active CLI account and `CODEX_HOME`, not a CodexBar account selector. See the [app-server protocol](https://developers.openai.com/codex/app-server).

Claude remains a separate adapter: ingest normalized snapshots from an authorized producer, or fresh Claude statusline data. Nothing installs or changes statusline/auth settings. Optional `--codexbar` instead configures the legacy fixed `usage --provider codex --source cli` and `usage --provider claude --source oauth` collectors, checked against CodexBar v0.60.5. Never `auto`/`web`, cookies, or all-account aggregation. **A failing CLI source does not prove the CodexBar GUI or Claude login is broken:** their source, fallback and credential-access paths can differ. Collector failure obeys configured unknown-quota policy, without attempting authentication repair.

**Account binding is a deployment assertion.** A pool's configured collector must observe the same account used by its workers. An optional CodexBar `account` binds an exact returned label. Cached snapshots carry an opaque digest of collector/provider/source/account, configured window scopes and acquisition-home environment. Evidence is retained separately for each `(pool, binding)`; only a matching binding can constrain current routing. Changing that binding makes old and in-flight snapshots ineligible until a matching observation arrives, even if refresh fails. A late previous collector cannot evict a current binding's denial. Unconfigured ambient account changes cannot be detected without credential access. The router does not authenticate workers or prove that Pi and native CLIs share credentials; separate their pools/configurations when they do not. It refuses multi-account merging.

## Library

```ts
import { route, renew, release } from '@nourhelmi/agent-router';

const decision = await route({
  role: 'builder',
  task: 'Implement the specified parser and verify malformed-input handling.',
  harness: 'pi',
  requestId: 'unique-attempt-id',
  // pin: { model: 'openai-codex/gpt-6-astra', thinking: 'xhigh' },
});

// Launch using decision.selected.model and decision.selected.thinking unchanged.
// Renew every 30s while live; release only after definite termination/failure.
await renew(decision.id);
await release(decision.id);
```

Exports `route(request, {configPath?, dryRun?})`, `renew(id, {configPath?})`, `release(id, {configPath?})` and public types. Decisions contain exact identity, strategy (`jev`, `fallback`, `pinned`), lease ID/expiry, task/catalog digests, policy and normalized quota snapshots, returned Jev version, per-candidate reasons/scores/distributions and benchmark provenance. A model-only pin permits effort selection for that exact model; no pin can override quota/capability constraints. `thinking` without `pin.model` is invalid. An unknown role fails unless configured; the compatibility roles `worker`/`freeform` consult builder guidance without changing the caller's role.

`AGENT_ROUTER_NO_FEASIBLE_ROUTE` is terminal for that launch, not permission for a caller to choose another model. Missing/disabled config is for the caller to handle; direct `route` requires an enabled valid config. Enabled-but-invalid routing must never silently bypass the router. Configuration/module paths belong to trusted installation settings, never task/tool arguments.

SQLite transactions serialize capacity reservation across local processes. The same request ID and identical task/constraints return the same live lease; changed inputs or settled IDs are rejected. Renewal never resurrects expired or released leases. Default TTL is five minutes. A caller that loses its lease must not pretend its worker is accounted for: stop/reconcile the worker or report the capacity uncertainty. Unmanaged sessions and other machines are **not** included in the local concurrency ledger. Reservations are slots, not prepaid provider quota; long tasks can still exhaust a provider after launch.

## Selection policy

The configured candidates are the operator's **currently supported subscription roster**. `init` seeds profile declarations, not account-entitlement discovery; disable or remove unavailable models. Benchmark rows are reference evidence only: collection never creates candidates, and appearing on a leaderboard grants no launch eligibility.

1. Filter disabled candidates, role/transport mismatches, user pins, reserve violations and pool concurrency caps.
2. Refresh stale configured collectors with a shared cooldown. Respect every applicable observed quota window; never average five-hour and weekly quotas. An expired reset is **unknown**, never an assumed fresh zero. A still-unexpired exhaustion observation remains a restriction even when another window is missing/stale. Missing windows are not synthesized. Explicit provider permission denials remain restrictive through null/missing updates, staleness and resets until the same binding reports recovery. Provider percentages above 100 remain exhausted.
3. Ask one batched TypeSafe request: independent per-candidate five-level task-fit Scores and a task-family Choice. Only the bounded task packet, role and supplied model-fit guidance leave the process—not environment, account identity, quotas, benchmark files or conversation history. **Do not put secrets/transcripts in the task packet.** Typed judgments are not proof of capability or safety.
4. Accept Scores above `jev.minConfidence` (default `0.35`); otherwise use that candidate's configured prior. On API/credential/response failure, use deterministic fallback inside this package. Record the actual reason. Version pins are checked against the response; `jev-latest` records the resolved model version.
5. Blend relevant, fresh, exactly mapped benchmark midrank percentiles into fit (default weight `0.15`, maximum `0.5`). Missing evidence is neutral—not zero. Coding benchmarks apply only when the task-family judgment confidently says coding. General intelligence evidence may inform other tasks. Different metrics/cohorts are normalized separately before averaging.
6. Combine quality with capacity utility (default capacity weight `0.2`), then tie-break by configured rank and ID. For known quota, capacity is minimum remaining percentage **after reserve**, divided by 100, multiplied by free local-slot fraction. Unknown capacity receives neutral utility `0.5`, not an invented observed percentage. `unknown: penalize` subtracts `0.2` utility; `allow` omits that penalty; `exclude` rejects it. Defaults: Codex/Claude penalize, Cursor exclude. Select `exclude` for strict measured-quota operation.
7. Recheck current quota/leases and reserve atomically after inference. No network operation holds the database writer lock.

Weights, neutral priors, unknown penalties and confidence threshold are **explicit heuristics**, not calibrated success probabilities, dollar costs or token budgets. Equal percentage headroom does not imply equal absolute provider capacity. Start with `route --dry-run`, compare representative tasks to expected choices, then pin an evaluated Jev version. A small smoke test is not an outcome-quality evaluation. Benchmark freshness currently means source-publication/cache age, not a claim that every model was recently reevaluated.

`collector.windowModels` maps named/tertiary windows to exact installed model IDs; `[]` explicitly marks an irrelevant scope. Unknown scoped limits constrain all candidates with diagnostics. Direct Codex uses bucket keys such as `codex` or a returned model-specific limit ID, with optional window-specific keys such as `codex:primary`; bucket mappings also scope its permission gates. `ordinary-usage` is always account-wide. No scope is guessed from model aliases or display names. Primary does **not** necessarily mean five hours: durations come from the provider. Spend-control percentages and explicit denials are enforced; credits are not treated as permission to overspend.

Synthetic placeholders are omitted; unavailable usage/permission data stays unknown. Direct Codex uses the read's **database-admitted start time**, sampled after acquiring the writer lock—not response completion time. This conservatively understates freshness for delayed replies. A monotonic per-binding refresh token distinguishes reads admitted in the same millisecond and fences completion status; delayed older responses cannot masquerade as newer recovery. Cooldown limits attempts, not their overlap. CodexBar preserves `usage.updatedAt`. Failed collection never freshens old evidence. The bounded read-only `initialize → initialized → account/rateLimits/read` exchange and process cleanup are unchanged (CLI protocol previously checked with `codex-cli 0.155.1`; ordering repairs are tested offline).

The cache keeps separate raw/window observations, the latest **per-gate observation** (including null/missing), and the newest **explicit permission fact per gate**, including both `true` and `false`. Windows use the latest snapshot timestamp. At an equal timestamp, incomparable observations retain every distinct window view, including exact model scopes, independent limits and unknown counters; conflicting IDs receive deterministic, noncolliding `quota-view:N` diagnostic IDs. Percentages are never averaged or synthesized, and missing windows are not invented. A genuinely newer snapshot replaces the older window observations; among same-time direct reads, a higher admitted token supersedes lower tokens. Unsequenced imports remain separate and cannot acquire token authority or erase a same-time restriction. Old cache JSON falls back to its stored raw snapshot.

Gate `observedAt`, not wrapper freshness, orders permissions: null(T5) in wrapper T5 supersedes true(T4) in wrapper T10 while windows remain at T10; true(T5) likewise supersedes null(T4) inside that newer wrapper. A late known denial still restricts a newer null/missing view; only a strictly newer explicit true recovers it. Equal-time contradictory permissions conservatively deny unless distinct admitted read tokens establish order. A later null/missing observation after a true remains unknown, while a late false older than that true cannot resurrect a denial. Denials retain their observation times and model scopes through staleness and resets.

For a pool with no collector, both its current binding digest and legacy unbound snapshots are accepted representations of that declared pool. Reads fold their complete raw, per-gate and explicit-fact histories—not just their exposed permission views—and neither representation outranks an applicable denial. Different collector bindings remain isolated. SQLite migration is additive: legacy quota rows are merged when a store opens, without replacing the legacy table or modifying lease/audit rows or IDs. Already-loaded old clients keep their original schema/behavior; reload them to use the repaired cache.

CodexBar does not expose every upstream control; its adapter cannot reconstruct unavailable fields. A percentage snapshot is not proof that a provider will accept a request. Freshness is policy, not which executable is used: defaults are a five-minute quota age and one-minute retry cooldown. For on-demand one-minute observations, set `quotaMaxAgeMs: 60000` and `refreshCooldownMs: 15000`. No background polling is required.

## Private benchmark snapshots

Benchmarks are reference data, **not live dependencies during routing**. `benchmarkFile` is an absolute path to a private JSON array of normalized observations. New configs default to `benchmarks.json` beside config. For a linked checkout, set it to `<checkout>/data/benchmarks.local.json`: `data/` is gitignored and excluded from npm artifacts. Do not force-add fetched data to public Git. Files are written atomically with mode `0600` and retain source URLs, observation times, exact model/effort labels, metric definitions and cohorts.

Refresh periodically when models/results change, running these commands **sequentially** (one manual updater; no daemon or automatic scraping schedule):

```sh
agent-router benchmarks refresh --source deepswe
agent-router benchmarks refresh --source artificial-analysis  # public page; no API key
agent-router benchmarks list
agent-router benchmarks export --file /private/backup/benchmarks.json
```

Routing reads the local file and caches validated observations in SQLite; it never fetches benchmark pages. Manual file edits are read on the next route. Missing files preserve legacy cached evidence. Malformed/empty files fail rather than erase the cache: repair the file or move it aside before refreshing/importing. Failed source refreshes preserve the last good snapshot. `benchmarks import --file ...` merges validated observations by source into the configured snapshot. Exports are copies, not a change to the active `benchmarkFile` path.

- **[DeepSWE / DataCurve](https://deepswe.datacurve.ai/)**: reads the page's public `artifacts/v1.1/leaderboard-live.json`. Preserves source model ID, harness/reasoning/configuration variant, pass@1 definition, publication date and sample count. Only rows covering all 113 tasks enter their harness **and reasoning-effort** cohort; unspecified effort remains separate. Pass@4 is not conflated with pass@1. A mini-swe-agent result is evidence, not a measurement of a Pi worker. Hosted result redistribution rights are not established by the repository's license; keep snapshots private.
- **[Artificial Analysis](https://artificialanalysis.ai/models)**: reads the published JSON-LD Intelligence Index chart, retaining its exact displayed variants and methodology version. This is the page's selected chart cohort, **not the complete model catalog**. Null scores are omitted; capture time is not evaluation time. Missing/ambiguous versions or changed chart structure fail closed. Optional `--api` retains the authenticated, paginated Free API adapter, with separate Intelligence/Coding/Agentic metrics; that mode still requires `ARTIFICIAL_ANALYSIS_API_KEY` or a saved `auth artificial-analysis` credential. Page snapshots require neither.

Public readability is not permission for collection or redistribution. AA's [website terms](https://artificialanalysis.ai/docs/legal/Terms-of-Use.pdf) restrict automated collection and redistribution; its Free API is internal-use-only. Private storage does not itself grant usage rights. This package distributes code and synthetic fixtures, **no fetched dataset**. Keep attribution/provenance with snapshots and obtain appropriate permission for the refresh workflow and any publication.

Mapping requires an exact cached row and explicit supporting evidence:

```sh
agent-router benchmarks map \
  --candidate 'openai-codex/gpt-6-astra@xhigh' \
  --source deepswe --model gpt-6-astra \
  --variant mini-swe-agent:xhigh:mini_swe_agent_gpt_6_astra_xhigh \
  --metric pass_at_1 --cohort v1.1:113:mini-swe-agent:xhigh \
  --evidence-url https://developers.openai.com/api/docs/models/gpt-6-astra
```

Verify the local provider's actual backend identity and matching effort before applying a mapping. Punctuation similarity is not a join rule; `gpt-5.6-sol` and `gpt-5-6-sol` are not automatically merged. Explicit mappings carry an evidence URL/date. Unmapped, stale or irrelevant data is visible and cannot quietly become a zero score. Do not map a measurement from one reasoning effort onto another.

## Other CLI operations

```sh
agent-router route --file request.json --dry-run
agent-router quota ingest --file snapshot.json
agent-router quota codexbar --pool codex --file previously-captured.json
# Feed a fresh Claude status-line stdin payload; leaves stdout empty:
agent-router quota statusline --pool claude
agent-router benchmarks import --file normalized-observations.json
agent-router release DECISION_ID
agent-router --help
```

Statusline ingestion does not install or replace a user's statusline. Only pipe a freshly observed payload; do not relabel an old file with a new observation time. Use normalized snapshot ingestion to preserve a saved timestamp. Keys come from environment or private credential storage, not CLI arguments. Audit decisions omit task text and credentials; task digests are pseudonymous, not guaranteed anonymization. Local audits have no automatic retention limit; remove/archive settled historical rows according to your own retention policy.

## Verification

`npm test` builds and runs offline `node:test` checks: hard eligibility, unknown/stale/over-limit/scoped quotas, authenticated-source boundaries, exact pins, Jev schema/failure handling, variant mappings, process-shared concurrency, idempotence, nonresurrectable leases, CLI behavior, private file permissions and package contents. No test needs provider credentials. Live telemetry/Jev/benchmark verification is separate from these fixtures.
