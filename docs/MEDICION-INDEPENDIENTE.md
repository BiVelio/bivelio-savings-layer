# Independent measurement kit

How to check BiVelio's published savings figures yourself, or measure the SDK on your own traffic, without taking our word for anything.

This page contains no figures on purpose. Every number it talks about is named by its field in the published artefact (`https://savings.bivelio.com/data/ab-live.json`), so it cannot drift from what is published.

## 1. What BiVelio claims, and how it is measured

The bench runs the same scenarios, against the same model and provider, through four arms:

| Arm | Artefact key | What it sends |
|---|---|---|
| B0, naive | `arms.A` | The full request: compact JSON payload, every tool, no cache marks. Same contract, output cap and sampling as the other arms. |
| B1, reasonably optimized | `arms.A1` | B0 plus the provider's native cache on the stable prefix, and only the tools a diligent integrator would send. |
| B2, natively well-configured | `arms.A2` | B1 plus every setting the provider documents at no extra charge that applies to the request shape (reasoning effort, explicit cache mode, tool search over its threshold). Each decision, applied or not, is in `native.decisions` with the official page it follows. |
| B, BV-SALA | `arms.B` | The same task through the layer, with nothing the npm package does not ship (`sdk.asShipped`). The bench runs the SDK's source at the sealed `commit`, version `sdk.version`: compare it with the version you install. |

- **Cost** comes from the provider's own usage counters, priced at the list prices of the SDK's price catalogue (`pricing.table`, dated `pricing.catalogueDated`). Cache writes are priced at the model's write premium (`pricing.cacheWrites`).
- **The headline** is the lower bound of a stratified percentile bootstrap (two-sided, `alpha` 0.05, `config.resamples` resamples, seeded with `config.seed`): one stratum per scenario, equal weight per scenario. The point estimate is never the claim.
- **Any claim must fit under `floors.min`**, the lowest of the three lower bounds (against B0, B1 and B2). `floors.minAgainst` says which arm it is.
- `aggregateNativeVsB0` is what the provider's own settings save against B0. It is not a BV-SALA figure.

What it does not cover:

- The scenarios are synthetic and single-turn. The interval is conditional on this scenario set (see `honesty`): it covers per-scenario sampling noise, not how well these scenarios stand for your traffic.
- B2 is only as strong as the settings that apply to these request shapes. On single-turn requests with few tools, tool search and compaction do not apply, and `native.decisions` says so with the rule and its source.

## 2. Three ways to check us

1. **Recompute the published figures.** No key, no cost. Run `reproduce.mjs` (section 8) against the published artefact and its trials CSV. It re-runs the same seeded bootstrap on every paired trial and compares the result with what we publish.
2. **Measure the published npm package on your own traffic.** Turn on the SDK's `verification` option (`sampleRate`, optionally `onCheck`). For the sampled share of eligible requests, after the answer is returned, the layer sends the same request once more to your provider exactly as it would go without the layer, and reports both sides from your provider's usage counters. The pairs appear on the dashboard's «Your own bench» page, which exports them as CSV. They are informational: they never enter measured savings, your statement or any commission.
3. **Rerun BiVelio's bench** at the commit sealed in the artefact (`commit`, `sdk.version`). The bench's source is not public; to request access, write to the support address in the package README.

## 3. What to install

| Path | You need |
|---|---|
| 1 | Node 20 or later (it has the global `fetch`). Nothing else. |
| 2 | The npm package `@bivelio/savings-layer`, a license key (LICENSE sections 1 and 2) and your provider key. |
| 3 | A checkout of the repository at `commit`, `pnpm install --frozen-lockfile`, and provider keys. Path 3 runs from source, where the development open mode (`BVSALA_DEV_OPEN=1`) is honoured; the published package does not honour it (see `src/pipeline/config.ts`). |

## 4. Variables for path 3

Keep them in a gitignored file (`.env.bench`), never inline in a shell command or a script you share.

| Variable | Default | Effect |
|---|---|---|
| `BVSALA_DEMO_BASE_URL`, `BVSALA_DEMO_API_KEY` | none | An OpenAI-protocol gateway for every family. |
| `BVSALA_DEMO_KEEP_PREFIX` | off | Keep the `provider/` prefix of the model id on the gateway. |
| `BVSALA_DEMO_OPENAI_BASE_URL`, `BVSALA_DEMO_OPENAI_API_KEY` | none | Direct endpoint for the OpenAI family. |
| `BVSALA_DEMO_ANTHROPIC_BASE_URL`, `BVSALA_DEMO_ANTHROPIC_API_KEY` | none | Anthropic's Messages API (the only protocol with `cache_control` and `output_config.effort`). |
| `BVSALA_DEMO_GOOGLE_BASE_URL`, `BVSALA_DEMO_GOOGLE_API_KEY` | none | Gemini's OpenAI-compatible endpoint. |
| `BVSALA_DEMO_MODEL` / `BVSALA_DEMO_MODELS` | none | One model, or a comma-separated list. |
| `BVSALA_AB_PRESET` | none | `2026` (or `2026+optional`): the 2026 model set. Incompatible with `BVSALA_DEMO_MODEL(S)`. |
| `BVSALA_AB_BUDGET_USD` | none | Mandatory in a live run and in the probe. |
| `BVSALA_AB_B2` | on | `0` turns arm B2 off (a research run that cannot be published). |
| `BVSALA_AB_B2_EFFORT` | `low` | `none`, `minimal`, `low`, `medium` or `default` (the provider default). Validated per model before any call. |
| `BVSALA_AB_MARGEN_RAZONAMIENTO` | `0` | Output tokens added to the cap of every arm, on reasoning models only. |
| `BVSALA_AB_CON_COMPRESOR` | off | `1` injects a bench-only compressor the package does not ship: `sdk.asShipped` becomes false and the artefact cannot be published. |
| `BVSALA_AB_PERMITIR_PRECIO_ILUSTRATIVO` | off | `1` runs (never publishes) a model without a catalogue row. |
| `BVSALA_JUDGE_BASE_URL`, `BVSALA_JUDGE_API_KEY`, `BVSALA_JUDGE_MODEL` | none | Optional blind answer-versus-answer judge. |

Commands, from the repository root:

```bash
pnpm ab:sonda                  # probe: one minimal call per model, prints its ceiling first
pnpm ab                        # the run
node apps/web/public/measure/reproduce.mjs \
  --artifact benchmarks/out/ab-live.json --trials benchmarks/out/ab-live-trials.csv
```

## 5. What it costs

- Path 1 costs nothing.
- Path 2 costs roughly `sampleRate` times what the eligible traffic would cost without the layer, as the SDK's documentation of `verification` says. Every copy is a real provider call that you pay for.
- Path 3 prints a per-model ceiling before its first paid call and refuses to start if it is above `BVSALA_AB_BUDGET_USD`. It also keeps a running total of what it actually spends and stops as soon as that passes the budget. What the published run cost is in `cost.spentUsd`, next to the ceiling it printed (`cost.ceilingUsd`).

## 6. Reading the ledgers and the basis

- Each scenario maps to one ledger (`avoided_calls`, `eliminated_tokens`, `compressed_tokens`, `provider_cached`, `output_restriction`, `output_codebook`, or `none`), so the ledger deltas partition the total. `reconciliation.reconciled`, `reconciliationB1.reconciled` and `reconciliationB2.reconciled` must all be true.
- `levers.notExercised` (asked for, did not fire) is not the same as `levers.notMeasurable` (the configured transport cannot carry it) or `scenariosNotApplicable` (the scenario does not apply to this model). None of the three is a measured zero.
- The bench is an A/B instrument, never a billing basis. Commission applies only to savings labelled `measured` or `reference` in your own usage records (LICENSE section 6); `estimated`, `shadow` and `unmeasured` never carry commission.

Checklist before you trust an artefact:

- `sdk.asShipped` is true.
- `sdk.version` matches `npm view @bivelio/savings-layer version`, or you know why not.
- `modelStable` is true.
- `pricing.listPriceKnown` is true.
- `pricing.cacheWrites.metered` is true whenever `pricing.cacheWrites.premium` is above one.
- `native.degradedByTransport` is false, and `native.honored.promptCacheMode` is not false.
- `transport.endpointHost` names a provider, not a local server.

## 7. Publishing red rows

If you publish your own measurement, publish all of it:

- Every scenario in `scenarioSet`, including the ones whose `measured*.savings.point` is below zero («red») or whose `upper` is below zero («proven loss»).
- `scenariosNotApplicable`, `levers.notExercised` and `levers.notMeasurable`, with their reasons.
- The floor against the strongest baseline (`floors.min`, `floors.minAgainst`) and the quality per arm (`aggregate.qualityPassRate`, `scenarios[].naiveContractValid`, `scenarios[].nativeContractValid`, `scenarios[].truncated`).
- The raw trials CSV.

A table you can copy:

| Scenario | Floor vs B0 | Floor vs B1 | Floor vs B2 | Status | Reason |
|---|---|---|---|---|---|
| (name) | `measured.savings.lower` | `measuredB1.savings.lower` | `measuredB2.savings.lower` | measured / red / proven loss / not applicable | (from the artefact) |

`reproduce.mjs` lists the red rows for you.

## 8. `reproduce.mjs`

Published at `https://savings.bivelio.com/measure/reproduce.mjs`. It has no dependencies.

```bash
node reproduce.mjs                                  # the published artefact and CSV
node reproduce.mjs --artifact <path|url> --trials <path|url>
node reproduce.mjs --json                           # machine-readable report
```

It reads the trials CSV (RFC 4180), groups the paired trials by scenario in order of first appearance, and re-runs a line-by-line port of the bench's seeded bootstrap with the artefact's `config.seed` and `config.resamples`. It then compares, with exact equality:

- `aggregate`, `aggregateB1`, `aggregateB2` and `aggregateNativeVsB0` (stratified) and `aggregatePooled` (pooled), each against the CSV columns of its arms (`costA` for B0, `costA1` for B1, `costA2` for B2, `costB` for B);
- every scenario row (`measured`, `measuredB1`, `measuredB2`);
- `trials` against the number of CSV rows, and `aggregate.strata` against the number of scenarios;
- `scenarioSet` against the measured and not-applicable scenarios;
- `floors` against the lower bounds of their aggregates.

It also prints the seals from section 6 as warnings, and lists the red rows.

Exit codes: `0` every recomputation matches; `1` at least one does not; `2` input error (unreadable file, bad JSON or CSV, missing column).

## 9. Known limits

- The interval is conditional on the scenario set: it says how precisely each scenario was measured, not how representative the scenarios are.
- The scenarios are synthetic and single-turn.
- On reasoning models the provider counts hidden reasoning inside the same output cap, so an answer can be cut short. `config.reasoningHeadroomTokens` says how many tokens were added to every arm's cap, and `scenarios[].truncated` counts the cuts per arm.
- A gateway may not forward new provider settings. `native.honored` says whether the explicit cache mode was seen to reach the provider; `null` means it could not be observed, which is not a yes.
