# BV-SALA Architecture

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

BV-SALA is a gateway that answers, for every request:

- Can I avoid this call?
- Can I avoid retrieval?
- Can I send fewer tools?
- What context is actually necessary?
- Should I compress it?
- Which format costs least for this tokenizer?
- What is the minimal output contract?
- Is the saving still positive after all infrastructure is counted?

That combination — not "use TOON", "use a cache", or "compress prompts" — is the
differentiating property.

## Pipeline

```
                         ┌─────────────────────────┐
Request ────────────────▶│ Canonicalizer + Policy  │
                         └────────────┬────────────┘
                                      │
              ┌───────────────────────┼────────────────────────┐
              ▼                       ▼                        ▼
     Deterministic resolver     Exact cache             Singleflight
              │                       │                        │
              └─────────────── direct answer ─────────────────┘
                                      │ miss
                                      ▼
                             Safe semantic cache
                                      │ miss
                                      ▼
                        Retrieval / Tool Strategy Router
                       no-RAG | single | multi | tool
                                      │
                                      ▼
                     Tool schema & capability selector
                                      │
                                      ▼
                  Retrieve → dedupe → rerank → adaptive-k
                                      │
                                      ▼
                     Memory & context projection
                                      │
                                      ▼
                    LLMLingua compression (net-positive only)
                                      │
                                      ▼
                       JSON / TOON / CSV selector
                                      │
                                      ▼
                Output contract + constrained decoding
                                      │
                                      ▼
                          ONE primary LLM call
                                      │
                                      ▼
                 Structural & semantic validation
                                      │
                                      ▼
                    Local render / transcode / cache
                                      │
                                      ▼
                          SavingsReport + traces
```

## Design principles

### 1. The four ledgers are sacred

`avoided_calls`, `eliminated_tokens`, `compressed_tokens`,
`provider_cached_tokens` are tracked separately by `SavingsLedger` and reported
separately in `SavingsReport.tokens`. Never sum them.

### 2. Safety is a product requirement, not a nice-to-have

The worst failure is not a cache miss — it is confidently returning a wrong
answer. The `policy` engine gates every saving:

- Exact cache keys include tenant, scope, model family/version, system-prompt
  hash, contract/schema version, toolset, tool-loop fields (calls, the call each
  result answers, `isError`), locale, sampling, knowledge epoch, freshness
  bucket, and safety policy version. A hash of the user text is **not** a safe
  key.
- Semantic cache is read-only, non-personalized, non-fresh, deterministic-enough
  **and** must pass metadata filters + a verifier + a freshness check + a
  contract-compatibility check. Its headline metric is hit *precision*, not hit
  ratio.
- Write/destructive tools disable semantic cache and singleflight, and are never
  handed to a non-`TOOL_ACTION` request.

### 3. Formats are measured, not assumed

The serializer selector counts real tokens with the destination tokenizer and
includes instruction overhead and a per-(model,format) quality penalty. TOON is
a candidate behind a pinned adapter, never a default.

### 4. Constrained decoding removes repair round-trips

Provider-native structured output is preferred, then XGrammar, then llguidance,
then Outlines — as interchangeable backends, never run simultaneously. A schema
conformance suite must confirm that a backend which *claims* support actually
enforces every constraint.

### 5. Preprocessing must pay for itself

Embeddings, reranking, compression and verifiers can cost more than the tokens
they save on small prompts. Every policy computes a net figure; compression has
an explicit activation gate.

## LLM→LLM handoffs

Multi-agent systems re-explain system + tools + context in prose at every hop.
BV-SALA replaces that with a typed `BivelioHandoff`: each consumer receives a
projection (not the whole state), large documents are passed as refs/hashes, and
only the delta since the last turn is sent. The serializer then decides JSON vs
TOON for the wire.

## Extension points

The main extension points, with in-memory defaults where applicable:

- `Provider` — OpenAI-compatible, Anthropic-compatible, self-hosted.
- `ExactCache` — Redis / KV / LRU, or `@bivelio/persistence-postgres` for a
  customer-operated PostgreSQL database. The optional adapter preserves the
  canonical cache key and stores JSON-compatible answers with their TTL.
- `CacheBreakpointStore` — shared prompt-cache measurements. The PostgreSQL
  adapter also supports versioned compare-and-set; the pipeline reapplies an
  observation to the latest snapshot after a conflict, within a bounded retry
  and time budget, instead of overwriting another instance's measurement.
- `ConstraintMemoryStore` — optional durable value-constraint hints with a local
  write-through Set. Keys hash tenant, scope, provider, served model and contract;
  inserts are idempotent and store failures never trigger another provider call.
- `SemanticCacheStore` — in-memory by default, or `PgSemanticCache` in the
  optional customer-operated PostgreSQL + pgvector package. Both use the same
  deterministic guards and `SemanticCalibrationJournal`. PostgreSQL coordinates
  one calibration history with short transactions and idempotent observations;
  its candidate policy and backend identity are calibrated explicitly.
- `TokenEstimator` — tiktoken / provider tokenizer.
- `Compressor` — LLMLingua-2 / LongLLMLingua sidecar.
- `ConstraintBackend` — XGrammar / llguidance / Outlines / provider-native.
- `Retriever` / `Reranker` — any vector store + cross-encoder.
- `LocalClassifier` — a small local model for the router.
