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
