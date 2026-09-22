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
agent-router init --codexbar
agent-router auth typesafe            # reads TYPESAFE_API_KEY, never prints it
agent-router quota refresh
agent-router status
```

`init` imports the union of `~/.pi/agent/intelligence-profiles/*.json`, including each declared model's `defaultThinking` and every recommended effort. It deduplicates exact model/effort pairs and preserves fit, character and profile provenance. Recommendations are guidance, not role eligibility: imported candidates support advisor/builder/checker (and any additional declared roles), while recommendations set role-specific tie-break ranks. Optional catalog models remain available even without recommendation rows. Operators may add supported models or explicitly restrict candidate roles in router config. Initial priors are neutral `0.7`; the ACTIVE guide only supplies tie-break preference. Subsequent profile switches do not rewrite router policy. No reasoning efforts, model aliases or benchmark mappings are inferred. Native Codex `max` and native Cursor transport are excluded.

Configuration defaults to `~/.config/agent-router/config.json`; override with `AGENT_ROUTER_CONFIG` or `--config`. `init` never intentionally overwrites an existing configuration. It sets `enabled: true` and an absolute `modulePath` to the built library. Inspect policy before enabling a caller integration. Private credentials and SQLite quota/lease/audit state live alongside that configuration, **outside the checkout**. Configuration/credentials/database files are `0600`; the state directory is `0700`. Environment keys override the optional credentials file. `auth artificial-analysis` similarly reads `ARTIFICIAL_ANALYSIS_API_KEY`.

CodexBar is optional. Without it, ingest normalized JSON snapshots from an explicitly authorized external collector. No provider authentication files are read by this package. `--codexbar` configures only fixed `usage --provider codex --source cli` and `usage --provider claude --source oauth` commands; never `auto`/`web`, browser cookies, account switching, or all-account aggregation. Install [CodexBar](https://github.com/steipete/CodexBar) separately. This adapter was checked against its v0.60.5 JSON schema. CodexBar owns its provider authentication behavior; expired Claude OAuth remains unavailable until its owner repairs it.

**Account binding is a deployment assertion.** A pool's configured collector must observe the same account used by its workers. An optional CodexBar `account` binds an exact returned label. Cached snapshots carry an opaque digest of collector/provider/source/account, configured window scopes and acquisition-home environment. Changing that binding makes old and in-flight snapshots ineligible until a matching observation arrives, even if refresh fails. Unconfigured ambient account changes cannot be detected without credential access. The router does not authenticate workers or prove that Pi and native CLIs share credentials; separate their pools/configurations when they do not. It refuses multi-account merging.

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

1. Filter disabled candidates, role/transport mismatches, user pins, reserve violations and pool concurrency caps.
2. Refresh stale configured collectors with a shared cooldown. Respect every applicable observed quota window; never average five-hour and weekly quotas. An expired reset is **unknown**, never an assumed fresh zero. A still-unexpired exhaustion observation remains a restriction even when another window is missing/stale. Missing five-hour windows are not synthesized. Provider percentages above 100 remain exhausted.
3. Ask one batched TypeSafe request: independent per-candidate five-level task-fit Scores and a task-family Choice. Only the bounded task packet, role and supplied model-fit guidance leave the process—not environment, account identity, quotas, benchmark files or conversation history. **Do not put secrets/transcripts in the task packet.** Typed judgments are not proof of capability or safety.
4. Accept Scores above `jev.minConfidence` (default `0.35`); otherwise use that candidate's configured prior. On API/credential/response failure, use deterministic fallback inside this package. Record the actual reason. Version pins are checked against the response; `jev-latest` records the resolved model version.
5. Blend relevant, fresh, exactly mapped benchmark midrank percentiles into fit (default weight `0.15`, maximum `0.5`). Missing evidence is neutral—not zero. Coding benchmarks apply only when the task-family judgment confidently says coding. General intelligence evidence may inform other tasks. Different metrics/cohorts are normalized separately before averaging.
6. Combine quality with capacity utility (default capacity weight `0.2`), then tie-break by configured rank and ID. For known quota, capacity is minimum remaining percentage **after reserve**, divided by 100, multiplied by free local-slot fraction. Unknown capacity receives neutral utility `0.5`, not an invented observed percentage. `unknown: penalize` subtracts `0.2` utility; `allow` omits that penalty; `exclude` rejects it. Defaults: Codex/Claude penalize, Cursor exclude. Select `exclude` for strict measured-quota operation.
7. Recheck current quota/leases and reserve atomically after inference. No network operation holds the database writer lock.

Weights, neutral priors, unknown penalties and confidence threshold are **explicit heuristics**, not calibrated success probabilities, dollar costs or token budgets. Equal percentage headroom does not imply equal absolute provider capacity. Start with `route --dry-run`, compare representative tasks to expected choices, then pin an evaluated Jev version. A small smoke test is not an outcome-quality evaluation. Benchmark freshness currently means source-publication/cache age, not a claim that every model was recently reevaluated.

`collector.windowModels` maps named/tertiary windows to exact installed model IDs; `[]` explicitly marks an irrelevant window. Unknown scoped windows conservatively constrain all candidates and produce a diagnostic until mapped. Synthetic placeholders are omitted; `usageKnown:false` stays unknown. Original `usage.updatedAt` survives collection/cache failures. CodexBar may not expose every upstream control (for example Codex's `ordinaryUsageAllowed`); this adapter does not reconstruct or claim to enforce unavailable fields. A percentage snapshot is not proof a provider will accept a request.

## Benchmarks and licensing

```sh
agent-router benchmarks refresh --source deepswe
agent-router benchmarks list
# Artificial Analysis requires a key, even on the Free data tier:
agent-router auth artificial-analysis
agent-router benchmarks refresh --source artificial-analysis
```

- **[DeepSWE / DataCurve](https://deepswe.datacurve.ai/)**: reads public `artifacts/v1.1/leaderboard-live.json`. Preserves source model ID, harness/reasoning/configuration variant, pass@1 definition, publication date and sample count. Only rows covering all 113 tasks enter their harness **and reasoning-effort** cohort; unspecified effort remains separate. Pass@1 is scored-attempt pass rate; pass@4 is not imported or conflated with it. Percentiles compare configurations under matching task/harness/effort conditions, not bare models. Evaluation date and task-level overlap/error counts are not reconstructed from the aggregate. A mini-swe-agent result is evidence, **not a measurement of a Pi worker**. Hosted result redistribution rights are not established by the repository's Apache license; keep fetched artifacts local.
- **[Artificial Analysis](https://artificialanalysis.ai/)**: authenticated, paginated `/api/v2/language/models/free`. Preserves source slug/name, numeric index methodology version and separate Intelligence/Coding/Agentic metrics. The API does not encode methodology patch versions or per-model evaluation dates; this limitation is recorded. Null scores are omitted. Data is attributed to Artificial Analysis. Free API rights are **internal use only**, with no redistribution; customer-facing redistribution needs appropriate commercial rights. This public package includes code and synthetic fixtures, **no licensed dataset**. [API docs](https://artificialanalysis.ai/data-api/docs), [OpenAPI](https://artificialanalysis.ai/api/v2/openapi), [terms](https://artificialanalysis.ai/docs/legal/Terms-of-Use.pdf).

Mapping requires an exact cached row and explicit supporting evidence:

```sh
agent-router benchmarks map \
  --candidate 'openai-codex/gpt-6-astra@xhigh' \
  --source deepswe --model gpt-6-astra \
  --variant mini-swe-agent:xhigh:mini_swe_agent_gpt_6_astra_xhigh \
  --metric pass_at_1 --cohort v1.1:113:mini-swe-agent:xhigh \
  --evidence-url https://developers.openai.com/api/docs/models/gpt-6-astra
```

Verify the local provider's actual backend identity and matching effort before applying a mapping. Punctuation similarity is not a join rule; `gpt-5.6-sol` and `gpt-5-6-sol` are not automatically merged. Explicit mappings carry an evidence URL/date. Unmapped, stale or irrelevant data is visible and cannot quietly become a zero score. Do not map a high-effort measurement onto a lower-effort candidate unless deliberately documenting that extrapolation.

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
