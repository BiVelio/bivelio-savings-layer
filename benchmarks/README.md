# BV-SALA Benchmarks

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

Comparing "baseline" vs "everything on" is not enough. The benchmark suite runs
**ablations** so each module's marginal contribution — and the interactions
between modules — are measured, not assumed.

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
