# bivelio-savings-layer (BV-SALA)

> **PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.**
> This software is the exclusive intellectual property of BiVelio Inc. No license
> is granted. Copying, distribution, modification, or use without the prior
> written authorization of BiVelio Inc. is strictly prohibited. See [LICENSE](./LICENSE).

**BV-SALA is a provider-neutral LLM execution optimizer** — a decision and
optimization layer that sits in front of any LLM provider and, for every single
request, chooses the cheapest execution that still meets the required quality.

It is **not** a prompt compressor and **not** a wrapper around TOON. Compression
is the *fourth* thing it tries, not the first.

## The optimization order (cheapest first)

1. **Avoid the call entirely** — reuse or compute the answer (resolvers, exact/semantic cache, singleflight).
2. **Avoid auxiliary calls** — retrieval, tools, planners, validators, reformatters, retries.
3. **Eliminate unnecessary context** before trying to compress it.
4. **Compress** the tokens that genuinely must be sent.
5. **Constrain generation** to emit only the structure and length required.

Provider prompt/KV caching is treated as a cost/latency saving — **never** as a
reduction of the logical prompt size.

## Four separate ledgers (never summed)

Mixing these produces misleading metrics, so BV-SALA keeps them apart:

| Ledger | Meaning |
| --- | --- |
| `avoided_calls` | LLM / RAG / tool calls that never executed |
| `eliminated_tokens` | information dropped because it was not needed |
| `compressed_tokens` | information kept, but encoded with fewer tokens |
| `provider_cached_tokens` | tokens still in the prompt, billed/processed differently by the provider |

A cache hit eliminates a whole call. TOON re-encodes a structured payload.
LLMLingua removes redundant words. A prefix cache makes tokens cheaper without
removing them. These are four different things.

## Quick start

```ts
import { createSavingsLayer, createMockProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: createMockProvider(), // swap for an OpenAI-compatible / self-hosted provider
});

const { data, text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});

console.log(text);                 // "8"  (computed locally, no LLM call)
console.log(report.cache.result);  // "deterministic"
console.log(report.calls.avoidedLlm); // 1
```

The only hard requirement is a `provider`. A heuristic tokenizer and in-memory
implementations of every other component are wired automatically, and each one
is independently swappable (Redis exact cache, pgvector/Qdrant semantic cache, a
real tokenizer, an LLMLingua sidecar, XGrammar/llguidance backends, …).

## The decision cascade

```
Request
  → Canonicalize + Policy (risk & freshness)
  → Deterministic resolvers ─────────────► answer (0 calls)
  → Exact cache ─────────────────────────► answer (0 calls)
  → Singleflight (coalesce in-flight)
      → Safe semantic cache ─────────────► answer (0 calls)
      → Execution router (NO / SINGLE / MULTI / TOOL)
      → Tool selector (drop irrelevant, gate writes)
      → Retrieval: retrieve → dedupe → rerank → adaptive-k
      → Context projection (memory deltas)
      → Compression (only when net-positive)
      → JSON / TOON / CSV selector (tokenizer-aware)
      → Output contract + constrained decoding
      → ONE primary LLM call
      → Structural + semantic validation (+ ≤1 repair)
      → Local render / transcode / cache write
  → SavingsReport + traces
```

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full design,
[`docs/ROADMAP.md`](./docs/ROADMAP.md) for the phased development plan, and
[`docs/COMMERCIALIZATION-PLAN.md`](./docs/COMMERCIALIZATION-PLAN.md) for the
master commercialization & platform-integration plan (control-plane/data-plane
split on Hetzner, licensing, per-seat billing via Hyperswitch, dashboards).

## What each subsystem does

| Package (`src/…`) | Responsibility |
| --- | --- |
| `contracts` | Request/result/report types; the typed `BivelioHandoff` for LLM→LLM handoffs |
| `tokenizer` | Pluggable estimator registry + the four-ledger `SavingsLedger` |
| `canonicalization` | Normalization + safe exact/inflight cache keys (tenant, scope, epoch, …) |
| `policy` | Risk & freshness gate — decides which savings are *safe* per request |
| `cache` | Exact cache, singleflight, safe-by-construction semantic cache |
| `resolvers` | Deterministic answers with zero LLM calls (e.g. arithmetic) |
| `router` | Adaptive-RAG-style execution classifier + tool selector |
| `retrieval` | dedupe → rerank → adaptive-k pruning |
| `memory` | Conversation state + `memory_delta` merge + context projection |
| `serialization` | JSON-compact / TOON / CSV + tokenizer-aware format selector |
| `constraints` | JSON-Schema validation, schema registry, constrained-decoding backends |
| `compression` | LLMLingua-style sidecar interface with protected spans + net-positive gate |
| `providers` | Provider-neutral interface, mock provider, OpenAI-compatible adapter |
| `telemetry` | Trace collector + `SavingsReport` builder |
| `pipeline` | The BV-SALA cascade and `createSavingsLayer` factory |

## Why formats are chosen, not assumed

TOON's strength is uniform arrays of flat objects; it can be *larger* than
compact JSON on nested/non-uniform data. The selector counts, with the
destination model's tokenizer:

```
tokens(encoded payload) + tokens(instruction to understand it) + quality penalty
```

…and only switches away from JSON when a challenger clears both an absolute
(`≥64` tokens) and a relative (`≥8%`) threshold. Example output:

```
big uniform table  → json 1716, toon 708  → chosen: toon (−58.7%)
small nested object → json 44,   toon 116  → chosen: json-compact
```

## Scripts

```bash
pnpm install
pnpm test          # 60+ unit + end-to-end tests
pnpm typecheck
pnpm build
pnpm example:basic
pnpm example:serialization
pnpm example:handoff
```

## Status

v0.1 implements Phase 0–2 of the roadmap end-to-end (measurement/baseline,
immediate low-risk savings, and the format/tool/memory layer), with pluggable
interfaces for Adaptive-RAG retrieval, LLMLingua compression, semantic cache,
and constrained-decoding backends. See [`docs/ROADMAP.md`](./docs/ROADMAP.md).

---

BiVelio Inc. — proprietary. For licensing inquiries: legal@bivelio.com
