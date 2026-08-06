# BV-SALA Benchmarks

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

## Prove it first: the savings demo (`pnpm demo`)

Before monetizing, prove the layer works and that we can demonstrate **real**
savings without breaking correctness. `benchmarks/run.ts` runs realistic
scenarios through the layer, verifies each answer is still correct, and reports
savings with **conservative accounting** (no phantom output savings; only what
we can defend — avoided calls + input reduction).

```bash
pnpm demo                     # MOCK mode: deterministic, no network, proves the mechanism
```

Example (MOCK): 2 of 7 calls avoided, ~1,342 input tokens saved, ~70% net cost
saved, **6/6 correctness checks passed**.

Run it **LIVE** against a real LLM for real provider tokens & dollars. Two ways:

```bash
# A) Vercel AI Gateway (one key, many providers; keep the "provider/model" prefix)
BVSALA_DEMO_BASE_URL=https://ai-gateway.vercel.sh/v1 \
BVSALA_DEMO_API_KEY=<AI_GATEWAY_KEY> \
BVSALA_DEMO_MODEL=openai/gpt-4o-mini \
BVSALA_DEMO_KEEP_PREFIX=1 \
pnpm demo

# B) A direct OpenAI-compatible endpoint (prefix stripped automatically)
BVSALA_DEMO_BASE_URL=https://api.openai.com/v1 \
BVSALA_DEMO_API_KEY=sk-... \
BVSALA_DEMO_MODEL=gpt-4o-mini \
pnpm demo
```

`BVSALA_DEMO_KEEP_PREFIX=1` keeps the `provider/` prefix on the model id (needed
by gateways); omit it for a direct provider endpoint. The same env applies to
`pnpm ablation`.

MOCK proves the mechanism (calls avoided, tokens compressed, quality preserved);
LIVE proves real dollars. Both refuse to pass if any correctness check fails —
savings without correctness do not count.

> **Honesty note on `pnpm demo`/`ablation`.** These compare a **measured**
> optimized call against a **modeled** baseline (the naive prompt is tokenized
> locally, never sent; baseline output is the `maxOutputTokens` ceiling). That is
> fine for a conservative mechanism demo, but it is *not* a defensible savings
> claim. For that, use the A/B benchmark below, where **both** arms are metered by
> the provider.

## The real metric: true A/B live benchmark (`pnpm ab`) ★

This is the **gold standard** and the only output that should ever back a savings
claim. For every scenario it sends **two real requests to the same provider/model**:

- **Arm A (naive)** — what a team *without* BV-SALA sends: full uncompressed JSON
  payload on the wire, all tools transmitted, no cache, no output cap, no schema.
- **Arm B (BV-SALA)** — the same task through the layer.

**Both** arms are priced from the provider's own `usage` — so no modeled baseline
can enter, and both are counted by the *same* tokenizer. Savings = the measured
paired dollar delta.

```bash
pnpm ab            # MOCK: exercises the whole A/B pipeline; dollars labeled ESTIMATED (not a claim)

# LIVE (real provider tokens & cost) — put the credentials in .env.bench once:
cp .env.bench.example .env.bench     # fill in BVSALA_DEMO_API_KEY
pnpm ab                              # the script loads .env.bench by itself

# …or pass them inline for a one-off:
BVSALA_DEMO_BASE_URL=https://ai-gateway.vercel.sh/v1 \
BVSALA_DEMO_API_KEY=<KEY> BVSALA_DEMO_MODEL=openai/gpt-4o-mini BVSALA_DEMO_KEEP_PREFIX=1 \
pnpm ab
```

`.env.bench` is gitignored and read via `--env-file-if-exists`, so the key never
reaches the shell history. The same file drives `pnpm demo` and `pnpm ablation`.

### Publishing the artifact (`pnpm ab:publish`)

The figure the landing shows **is** the product's commercial claim, so getting it
onto the site is not a `cp`. That is exactly how a `mode: "MOCK"` artifact came
to be served in the first place.

```bash
pnpm ab:publish --dry-run    # decide and print, write nothing
pnpm ab:publish              # benchmarks/out → apps/web/public/data
```

`publish-guard.ts` refuses to publish when:

- the artifact is not `LIVE` (override with `--allow-mock`, deliberately);
- it would **downgrade** an already-published `LIVE` to a MOCK — this one has no
  override, because losing the only defensible number by accident is silent;
- the model fingerprint changed mid-run (the two arms measured different models);
- the ledgers don't reconcile — a non-zero residual means double counting;
- savings exceed 100%, the interval is inverted, or the point estimate falls
  outside its own interval.

`proven: false` **is** publishable — under-claiming is honest — but it warns, and
the landing must not present it as demonstrated savings.

**Honesty rules built into the harness** (each closes a specific audited defect):

1. **Measured vs measured.** The naive baseline is *executed*, never modeled — no
   local-tokenizer estimate, no `maxOutputTokens ?? 256` output constant.
2. **Lower-bound headline.** We report the **95% bootstrap CI lower bound**
   (“verified ≥ X%”), never the flattering point estimate; a Wilcoxon signed-rank
   p-value is a secondary check. Raw paired trials export to
   `ab-live-trials.csv` so anyone can recompute the interval.
3. **Quality-gated.** A saving is **void** if its answer fails the gate
   (ground-truth where known; structural; or a blind LLM judge in LIVE). A cached
   answer must byte-match a verified miss answer.
4. **Cache = repeat traffic.** Cache savings are shown as an amortization curve
   with a **break-even K**, so caches honestly read ≈0% on a single cold call.
5. **No silent zeros.** Missing provider `usage` is a hard error (`requireUsage`),
   never a fabricated 0-token → 100% saving.
6. **MOCK never claims dollars.** Without a real endpoint every figure is labeled
   `ESTIMATED — not a savings claim`.

Output: `benchmarks/out/ab-live.json` (per-scenario + aggregate, with CI and
provenance) and `benchmarks/out/ab-live-trials.csv` (raw paired trials).

## Ablation: where the savings come from (`pnpm ablation`)

"Baseline vs everything on" hides which lever pays for itself. `pnpm ablation`
runs the batch under a ladder of configs, each enabling one more optimization,
and reports the **marginal** contribution of each:

```
stage                cost        vs baseline   marginal Δ
baseline (naive)     $0.000423        0.0%          —
+ exact cache        $0.000409        3.3%      $0.000014
+ resolvers          $0.000398        5.7%      $0.000010
+ router             $0.000398        5.7%      $0.000000   ← 0 here: scenarios have no retrieval to avoid
+ format selector    $0.000203       52.1%      $0.000196   ← the big lever on the table payload
```

Cost per rung is that config's real spend (actual input+output tokens priced;
avoided calls cost 0), with fresh caches per rung so stages are independent.

## Exportable reports

Both harnesses write machine-readable JSON to `benchmarks/out/` (gitignored):
`demo.json` (per-scenario + totals) and `ablation.json` (the ladder). This is the
same data that later feeds the dashboard and the "verify your savings" page.

## Full suite (production traces, golden tasks, conformance)

The demo/ablation above prove the mechanism on curated scenarios. The broader
suite below runs on real traffic segments and is measured, not assumed.

## Suites

| Suite | Purpose |
| --- | --- |
| `production-traces/` | Anonymized real traffic, segmented (see below) |
| `golden-tasks/` | Curated tasks with known-good answers for quality gates |
| `schema-conformance/` | 10k+ JSON schemas per constrained-decoding backend; declared support ≠ empirical coverage |
| `format-selector/` | JSON vs TOON vs CSV token counts across tokenizers/data shapes |
| `router-robustness/` | Paraphrase + typo variants; decision-drift is a production metric |
| `ablations/` | baseline → +each module → full stack |

## Trace segmentation

static/temporal · personal/public · no-RAG/single-hop/multi-hop ·
no-tools/read/write · short/medium/long context · flat/semi/nested data ·
free/structured output · language · model & tokenizer.

## Ablation ladder

```
baseline
+ exact cache
+ singleflight
+ strict output
+ local renderer
+ tool selector
+ Adaptive-RAG
+ retrieval pruning
+ TOON selector
+ LLMLingua
+ semantic cache
+ full stack
```

## Economic metric

```
net_savings = 1 - (provider + embeddings + compressor + retrieval + cache_infra) / baseline_total
cost_per_successful_task = total_cost / tasks_that_pass_quality_gate
```

The decision metric is `cost_per_successful_task`, so the suite never rewards
answers that are cheap but wrong.
