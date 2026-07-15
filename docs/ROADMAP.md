# BV-SALA Development Roadmap

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

Percentages multiply, they do not add. Eliminating 25% of calls, halving the
input on the rest, and cutting output to 70% (with an 80/20 input/output split)
leaves `0.75 × (0.8×0.5 + 0.2×0.7) = 0.405` — a ~59.5% reduction, even though no
single technique reaches that. That is why call-elimination + input-reduction +
output-restriction compound.

## Phase 0 — Measurement & baseline  ✅ (implemented in v0.1)

Provider-neutral gateway, token counter per model/tokenizer, LLM/RAG/tool call
traces, cost estimation, retry/reformat detection, initial `SavingsReport`.

**Exit:** ≥95% of requests carry input/output tokens, model, cost, latency,
auxiliary calls, and a quality result. *Without a baseline there is no reliable
way to claim savings.*

## Phase 1 — Immediate, low-risk savings  ✅ (implemented in v0.1)

Canonicalization, exact cache, singleflight, deterministic resolvers, output
budgets, strict JSON Schema, local renderer, elimination of "reformat this"
calls, compiled-grammar cache.

**Exit:** 100% structural validity on supported contracts, 0 cross-tenant leaks,
100% exact-hit correctness, measurable retry reduction, non-regressive latency.

## Phase 2 — TOON, context & tools  ✅ (implemented in v0.1)

Pinned TOON adapter, JSON/TOON/CSV selector with real tokenizer counting +
instruction overhead, local tool selector, tool-result cache interface,
structured memory + `memory_delta`, per-consumer context projection.

**Exit:** no format choice increases tokens, no significant per-model/format
degradation, demonstrated tool-schema input reduction, deterministic JSON↔TOON
round-trip.

## Phase 3 — Adaptive-RAG  ◐ (router implemented; retrieval pluggable)

NO/SINGLE/MULTI/TOOL router (deterministic rules + local classifier hook),
adaptive-k, dedupe, reranking, max two rounds, shadow mode + replay, paraphrase
& typo suite.

**Exit:** reduced retrieval rounds & documents, NO_RETRIEVAL false-negatives
within budget, paraphrase stability, quality within budget. *Small rewrites can
flip retrieval decisions by up to ~55%; paraphrase stability is a production
metric.*

## Phase 4 — LLMLingua  ◐ (sidecar interface + protected spans implemented)

Python sidecar, LLMLingua-2 for general context, LongLLMLingua for long RAG,
protected spans, benefit-based activation, fidelity verification, fallback to
original.

**Exit:** no protected span lost, net saving after sidecar compute, semantic
regression within limit, acceptable p95 latency.

## Phase 5 — Safe semantic cache  ◐ (safe-by-construction cache implemented)

Local/low-cost embeddings, vector store, metadata + permission filters,
cross-encoder verifier, TTL + knowledge_epoch, version invalidation,
**precision-first** metrics, audit mode.

**Exit:** semantic-hit precision ≥99%, 0 cross-tenant answers, 0 hits on
side-effecting actions, stale-hit rate within limit, net-positive after
embeddings/infra. For high-risk domains the precision target is higher, or the
semantic cache stays off.

## Phase 6 — Constrained-decoding backends & hardening  ◐ (backend interface implemented)

Provider-native structured outputs, XGrammar adapter, llguidance adapter,
optional Outlines, compilation/generation benchmark, JSON Schema conformance
suite, unsupported-feature fallback policy, engine versioning/pinning.

Full Self-RAG stays on an experimental branch (used for principles, not as a
production dependency).

## Benchmark that must ship with the project

Segment traces by static/temporal, personal/public, no-RAG/single/multi,
no-tools/read/write, short/medium/long context, flat/semi/nested data,
free/structured output, language, model & tokenizer.

Run **ablations** (baseline → +exact cache → +singleflight → +strict output →
+local renderer → +tool selector → +Adaptive-RAG → +retrieval pruning → +TOON →
+LLMLingua → +semantic cache → full stack) to measure marginal contribution.

Key metrics: `llm_calls / successful_task`, `retrieval_rounds / task`,
`tool_calls / task`, input/output tokens, `cost / successful_task`, exact-hit
rate, semantic-hit precision, retry rate, schema validity, task accuracy,
freshness accuracy, p50/p95 latency, preprocessing latency, paraphrase
stability, cross-tenant incidents.

```
net_savings = 1 - (provider + embeddings + compressor + retrieval + cache_infra) / baseline_total
cost_per_successful_task = total_cost / tasks_that_pass_quality_gate
```
