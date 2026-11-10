# BV-SALA Savings Layer

## Verifiable Measurement of Cost Savings in Large Language Model Applications — Open-Core Edition

Joan-Marc Fisa · Founder, BiVelio Inc · jmfisa@bivelio.com · https://savings.bivelio.com

**Preprint · November 2026 (v2.2, open-core release 1.1.0) · Technical report**

Supersedes the August 2026 edition ("BV-SALA Savings Layer: Verifiable Measurement of
Cost Savings in Large Language Model Applications",
[bivelio.com/es/research/papers/bv-sala-savings-layer](https://bivelio.com/es/research/papers/bv-sala-savings-layer)).
This document is the single source of the preprint; the web page at
[savings.bivelio.com/paper](https://savings.bivelio.com/paper) is generated from it, and
the arXiv-ready LaTeX source ships in `docs/paper/main.tex` of the repository.

---

## Abstract

Cost claims for large language model (LLM) optimizations are only interpretable when the
workload, the uncertainty, and the cost basis are stated explicitly. This paper evaluates
BV-SALA Savings Layer — an in-process SDK and a local gateway that combine
provider-reported usage with versioned list prices — in its **open-core** distribution,
where the entire local saving stack runs with no license key, arms every local lever,
and sends zero telemetry by default. We formalize the accounting object as a function
from a request to a vector of four mutually exclusive, never-summed ledgers
(`avoided_calls`, `eliminated_tokens`, `compressed_tokens`,
`provider_cached_tokens`) and an evidence label in the lattice
{measured, reference, estimated, unmeasured}; we prove, under three stated assumptions,
that the cost ratio decomposes additively over the ledgers (Proposition 1). Live
double-runs under a paired design with percentile cluster bootstrap (10,000 resamples,
family as the resampling unit) yield a **31.5 % reduction (95 % CI 25.7–36.7; 100
families, 200 requests per arm)** on `gpt-4o-mini`, and **75.1 % (95 % CI 69.3–79.6; 31
families, 62 requests per arm)** on `claude-sonnet-5`, of which approximately **41
percentage points** are attributable to a prefix-cache effect enabled by `cache_control`
in the instrumented arm rather than to a pre-existing provider discount. A
counterfactual replay of **19,779 gateway requests (51 sessions, 13 days)** estimates
**2.49 % (95 % CI 1.50–3.57)** and is reported as reference-valued, not measured. We add
three analyses that the August edition identified as missing: (i) a routing-economics
gradient at versioned list prices across DeepSeek, Qwen and GLM siblings, presented as
conditional arithmetic rather than as measured savings; (ii) a semantic-cache
positioning against the published AWS benchmark and GPTCache; and (iii) a preregistered
research roadmap specifying factorial and non-inferiority designs. No invoice
reconciliation is claimed. Every number in this paper is reproducible from artifacts in
the public repository or from the public bench.

**Keywords:** large language models; inference cost; provider-reported usage; prefix
caching; semantic caching; cluster bootstrap; evidence labels; open core; model routing;
measurement methodology.

---

## 1 · Introduction

### 1.1 Problem

The dominant cost of deploying a language model application is the provider invoice,
which is metered in tokens and priced by a commercial list that changes without notice.
A family of engineering interventions — response caching, prompt compression, prompt
restructuring, model routing, prompt-cache placement — can reduce that invoice. The
literature for these mechanisms is large (Section 2), but the *evidence* for their
economic effect in a specific deployment is usually absent: a vendor may report a
percentage without a workload, an interval, or a distinction between what the provider's
counter confirmed and what was reconstructed. This paper's thesis is that a cost claim is
a measurement claim, and therefore inherits the obligations of a measurement claim:
an explicit instrument, a stated workload, an uncertainty statement, and a separation
between what was observed and what was inferred.

### 1.2 Contributions

1. **A formal accounting object** (Section 3): the request→report function, the four
   ledgers, and the evidence lattice; Proposition 1 gives the conditions under which the
   cost ratio decomposes additively over the ledgers.
2. **An estimator and an uncertainty procedure** (Section 4): the ratio estimator over
   paired requests, with percentile cluster bootstrap whose resampling unit is the
   semantic family (SDK) or session (gateway), and stated seeds.
3. **Live evidence** (Section 6) for two providers under a paired design, with the
   attribution of the Anthropic effect separated from a pre-existing provider discount,
   and one counterfactual replay explicitly labelled as such.
4. **An open-core system contract** (Section 3.4): community mode as a structural gate
   with no control plane, which removes the adoption barrier of the August edition while
   preserving every auditable guarantee.
5. **A preregistered roadmap** (Section 9) that names the designs this edition does not
   run, including the factorial attribution and the non-inferiority tests.

### 1.3 Research questions

- **RQ1.** What cost reductions are observed in the specified live SDK double-runs when
  provider-reported usage is valued at versioned list prices?
- **RQ2.** How much uncertainty remains when dependence is handled by family- or
  session-level cluster bootstrap?
- **RQ3.** Which components are attributable to avoided calls, to token elimination or
  compression, and to cache effects enabled by the instrumented arm?
- **RQ4.** What quality and latency observations are available, and which claims remain
  unsupported?
- **RQ5.** How should a counterfactual replay and a provisional break-even calculation be
  interpreted relative to live evidence?

### 1.4 What changed since the August edition

The August edition evaluated a commercial, fail-closed distribution: the layer executed
only with a verified license key, and the gateway metered Anthropic and OpenAI traffic
but not Gemini. The November release changes the *system*, not the *measurement doctrine*:

1. **Community mode (open core).** `createSavingsLayer({ provider })` without a
   `licenseKey` runs the entire local saving stack with telemetry off, and the gateway
   starts with no keys and arms its local levers. A key that *is* present but invalid,
   expired or revoked still fails closed; only its absence stopped being an error.
2. **Three protocols, one meter.** The gateway reads provider-reported usage from the
   Gemini protocol, mapping `usageMetadata` onto the same usage shape as Anthropic and
   OpenAI, with implicit-cache tokens discounted from ordinary input and thinking tokens
   summed into output.
3. **Chinese providers at list price.** The versioned catalog adds DeepSeek (flash and
   v4-pro, at peak rates — the conservative direction, since off-peak is half), Qwen and
   GLM, with first-class upstream aliases in the gateway.
4. **Zero-telemetry default.** Community mode sends nothing to BiVelio; the optional
   cloud key sends only the per-request fields enumerated in the Cloud Services Terms.

Nothing in this release changes the four-ledger accounting, the evidence labels, or the
versioned list-price basis. The August results remain the primary evidence; this edition
adds analyses, not re-analysis.

### 1.5 What changed in the 1.1.0 release

The 1.1.0 release extends the open-core edition without touching the measurement doctrine,
the four ledgers or the evidence labels:

1. **Cache-break audit.** A deterministic, network-free detector scans the cacheable
   `system` prefix for per-request content — ISO 8601 and RFC 2822 timestamps, UUID v4 and
   epoch milliseconds/seconds — and reports it as a `cache-audit` trace plus a
   one-per-process warning. It diagnoses the most common silent cause of a prompt cache
   that never hits, and never rewrites the caller's prompt (Section 3.6).
2. **Levers inside the batch.** `layer.batches.submit()` now runs the same pure, lossless
   request-body levers as `generate()` — elision by supersession (default-on) and
   tool-output compaction (opt-in) — so a batch item's prompt byte-equals the prompt
   `generate()` sends for the same request and toggle (Section 3.7).
3. **Intra-batch deduplication** (opt-in). Requests whose final provider body is identical
   are sent once and replayed from the first result; the batch summary counts the money
   over the sent executions, never twice (Section 6.5).
4. **Cascade 2026.** The default model-cascade table now covers the current frontier's
   same-family cheap siblings (`gpt-5/5.2/5.4 → *-mini`, `claude-opus-5/-5-5 →
   claude-haiku-4-5`); `claude-sonnet-5/-5-5` remain without a default pair because
   r = 0.50 exactly leaves no quality margin (Section 6.3).

---

## 2 · Related work

Token pricing is a commercial decision, not a property of the Transformer architecture.
Against that background, one line of work reuses computation: PromptCache [4],
CachedAttention [5], SGLang [6] and CacheBlend [7] study attention or KV-cache reuse
under different serving assumptions, and Anthropic and OpenAI document provider-side
prompt caching [8, 9]. These mechanisms can lower usage charges, but an experiment must
distinguish caching already present in both arms from caching *enabled* by the
intervention — which is precisely the attribution problem of Section 4.4.

A second line reduces prompt tokens: LLMLingua [1], LLMLingua-2 [2] and gist tokens [3]
use distinct compression strategies. A third reuses responses: GPTCache [10], SCALM
[11], MeanCache [12] and vCache [24] address freshness, privacy and per-prompt error
bounds, and P-CHR AUC and Operational Retention Rate evaluate deployment [27]. Routing
systems such as FrugalGPT [13], RouteLLM [14] and RouteNLP [25] select among models and
calibrate escalation. Serving-efficiency work — vLLM [15], SGLang [6], speculative
decoding [16] — is orthogonal to this paper, which does not measure serving throughput.
OpenTelemetry's GenAI conventions [17] provide an observability vocabulary, not cost
attribution.

BV-SALA combines established mechanisms with request-identity guards, separate ledgers,
calibrated abstention and economic gating. Its differentiation is the integration of
*accounting and safety*, not any single cache, serialization or observability mechanism.
vCache is the closest comparator for semantic caching; the present work does not
establish equivalent guarantees, model coverage or hit rates. Structured-data rewriting
requires task- and model-specific quality evaluation: Notation Matters shows that token
reductions can reduce tool-calling accuracy and amplify multi-turn parsing failures
[26]. The uncertainty discussion uses established terminology [18, 19] without asserting
calibration-chain traceability. The evidence therefore supports a measurement-and-
guardrails contribution, not a claim of general optimization leadership.

---

## 3 · System model and accounting object

### 3.1 Notation

| Symbol | Meaning |
| --- | --- |
| `r` | A request: model, messages, tools, structured data, and constraints |
| `u(r) = (i, o, c)` | Provider-reported usage: input, output, and cache-read input tokens |
| `π_p = (π_in, π_out, π_cache)` | Provider `p`'s list prices, USD per million tokens, versioned |
| `C(π, u)` | Cost: `π_in·i + π_out·o + π_cache·c` divided by one million |
| `L` | The layer: a function from `r` to `(r', R)` where `R` is the report |
| `R = (C_base − C_opt) / C_base` | The cost ratio — the primary estimand |
| `F` | The semantic family (SDK) or session (gateway); the resampling unit |
| `B` | Bootstrap resamples, `B = 10,000` |

All amounts in this paper are *list-price* amounts: the provider's published price at the
catalog version that produced them, never a negotiated or reconciled invoice. Prices are
USD per million tokens; the internal catalog stores per-1,000 and a guard test rejects
per-million values written by mistake.

### 3.2 The layer

**Definition 1 (request transform).** The layer is a (possibly partial) function
`L: r → (r', R)` that returns a transformed request `r'` and a report `R`. The
transformation is *content-preserving* under an equivalence predicate `E(r, r')` that the
implementation must certify per mechanism: exact identity for cache hits, a declared
delimiter for structured-data rewriting, an output contract for constrained decoding, and
a header-identity check for upstream rewriting. Where `E` cannot be certified, `L` must
fall back to the identity transform and report the stage as failed-open.

**Definition 2 (report).** A report is a tuple
`R = (calls, tokens, ledgers, cost, traces)` where `ledgers` is a four-vector
`(A, E, K, P)` — avoided calls, eliminated tokens, compressed tokens, provider-cached
tokens — and `cost` carries `(baseline, actual, ratio, basis)` with `basis` an evidence
label.

**Definition 3 (evidence labels).** For a value `v`, its label is one of `measured`
(provider-reported usage plus a versioned list price), `reference` (an explicit matching
condition against a prior *executed* request whose provider counter is reused),
`estimated` (reconstructed: modeled, simulated, or extrapolated), or `unmeasured` (no
final provider counter, e.g. a stream that closed before usage). The labels form a
partial order by evidential strength:
`measured ≻ reference ≻ estimated ≻ unmeasured`, with no operation that promotes a value
across the order. In particular, a ratio whose numerator or denominator is `reference`
or `estimated` is never reported as an invoice fact.

### 3.3 Proposition 1 — ledger decomposition

**Assumption A1 (temperature-zero determinism of the counter).** For a fixed request and
model, the provider's usage counter is deterministic enough that two identical requests
produce the same `u` within the provider's reported precision.

**Assumption A2 (separability).** The mechanisms act on disjoint token populations: a
token avoided by a call-avoidance decision is not also counted as eliminated; a token
eliminated by rewriting is not also counted as cached.

**Assumption A3 (monotone pricing).** Prices are non-negative and the cost functional is
linear in `u`.

**Proposition 1.** Under A1–A3, the baseline-cost ratio decomposes additively:
`R = R_A + R_E + R_K + R_P + ε`, where `R_A`, `R_E`, `R_K`, `R_P` are the cost ratios
attributable to each ledger and `ε` accounts for interaction effects between mechanisms
applied to the same request.

*Proof sketch.* By A3, `C_base − C_opt = Σ_j Δ_j` over disjoint token populations
(A2), each `Δ_j` being the cost of the tokens attributable to mechanism `j`, valued at
the provider price of the token class they occupy. Dividing by `C_base` gives the
decomposition; `ε` collects the non-diagonal terms that A2 does not eliminate (for
example, a compressed prompt changing the cache-placement decision).

The proposition is deliberately conditional: it licenses reporting the four ledgers
*separately* and forbids summing them into a single unconditional figure unless `ε` is
bounded. The implementation never sums them; the UI shows the four ledgers and the
`basis` next to every amount.

### 3.4 The open-core contract

Community mode is a structural license gate (`src/license/community.ts`) that answers
"active, entitled to every local feature" with no network dependency, and a
corresponding entitlements channel in the gateway that grants the four local levers
without a service key. The contract is:

1. With no key configured, the layer runs the full local stack and sends nothing.
2. With a key configured but invalid, expired or revoked, the layer fails closed.
3. With a valid cloud key, the layer additionally reports the per-request fields
   enumerated in the Cloud Services Terms — never prompt content, completions or
   provider credentials.

This is a *design* contribution with an honest limitation (Section 8): without a cloud
key there is no revocation channel at all.

### 3.5 Metering the three protocols

The gateway reads usage from Anthropic Messages, OpenAI Chat Completions/Responses, and
the Gemini protocol. For Gemini, `:generateContent` (JSON) and `:streamGenerateContent`
(SSE, both `alt=sse` and newline-delimited JSON) are forwarded byte-for-byte; the
observer maps `usageMetadata` onto the internal usage shape, discounting implicit-cache
tokens from ordinary input and summing thinking tokens into output. A stream without a
final `usageMetadata` is reported `unmeasured`. These are operational (non-breakage and
fidelity) checks, not savings claims.

### 3.6 The cache-break audit

The dominant failure mode of prompt caching is not the provider's discount but the
hit-rate: a mutable token in the otherwise stable prefix forces a full miss on every
request. The layer therefore runs a deterministic, side-effect-free audit over the
cacheable `system` header that flags ISO 8601 and RFC 2822 timestamps, UUID v4, and epoch
milliseconds/seconds, and emits a `cache-audit` trace plus a one-per-process warning keyed
by the detected pattern. The audit is diagnostic, never rewriting: changing the `system`
prompt is a quality decision that belongs to the caller, and the layer's compaction
doctrine forbids changing an opinion about a block the provider has already cached. The
mechanism is unit-tested for determinism and for the absence of false positives on
ordinary numbers of other magnitudes.

### 3.7 Levers inside the batch

The batch surface (`layer.batches`) previously sent requests "as written", skipping the
layer's per-request levers; a batch item therefore missed the token reduction `generate()`
applies, on top of the batch discount. The 1.1.0 release runs the two lossless, pure
request-body levers on batch items before translation, reusing the exact same functions
the pipeline calls — elision by supersession (Section 3.2) and tool-output compaction —
so an item's provider body is byte-for-byte the body `generate()` produces for the same
request and toggle. Intra-batch deduplication collapses byte-identical bodies into one
execution, replaying the dropped items from the first result; it is opt-in because it
changes what the caller observes and is only sound when identical bodies imply identical
answers (deterministic sampling).

---

## 4 · Measurement methodology

### 4.1 Design

Each scenario runs **twice against the same live provider** on the same constructed
content: arm A without the layer, arm B instrumented. The unit of analysis is the
semantic family — a group of requests that share a template and differ only in fields —
so that repetition, which is what the mechanisms exploit, is represented realistically.
Both arms are valued with the provider-reported usage at the same catalog version.

### 4.2 Estimator

For family `f` with `n_f` requests per arm, let `C_base(f)` and `C_opt(f)` be the summed
costs; the per-family ratio is `R_f = (C_base(f) − C_opt(f)) / C_base(f)`, and the
estimand is `R = mean_f R_f` over families, treating each family as one independent
observation. This is a ratio-of-sums estimator per family and a mean across families; it
is not a pooled token average, which would overweight large families.

### 4.3 Uncertainty

**Percentile cluster bootstrap.** Resample families with replacement, `B = 10,000`
resamples, recompute `R` on each, and report the empirical 2.5th and 97.5th percentiles.
Resampling at family (SDK) or session (gateway) level respects dependence within a family
and avoids the anti-conservative intervals that a request-level bootstrap would produce.
The seeds and resample artifacts are published with the bench. The procedure is the one
described in Efron & Tibshirani [22] and Davison & Hinkley [23]; it is a percentile
interval, not a BCa interval, and that choice is stated as a limitation.

### 4.4 Attribution of the Anthropic effect

The `claude-sonnet-5` reduction contains a prefix-cache effect that arm B *enables* by
placing `cache_control` markers. To separate a pre-existing provider discount from an
effect of the intervention, the analysis compares arm A's cache-read tokens (the
provider's own behavior) with arm B's, and reports the difference as an *enabled* effect
— approximately 41 percentage points of the 75.1 %. This is an attribution within the
experiment, not a decomposition certified by the provider.

### 4.5 What the method cannot do

The method cannot establish invoice reconciliation (negotiated prices, credits, taxes and
rounding are out of scope), non-inferiority in quality or latency (no adequately powered
test is run), or generalization beyond the measured workloads. These are threats
(Section 7), not caveats to be buried.

---

## 5 · Experimental design

| Dimension | Live SDK double-run | Gateway replay |
| --- | --- | --- |
| Unit | semantic family (100 + 31) | session (51) |
| Requests per arm | 200 / 62 | 19,779 total |
| Traffic | GSM8K-derived, 30 % exact repeats + 20 % paraphrases | production sessions, one organization, 13 days |
| Models | `gpt-4o-mini`, `claude-sonnet-5` | Anthropic (Claude Code) |
| Cost basis | versioned list prices | versioned list prices, partially reconstructed baseline |
| Interval | percentile cluster bootstrap, B = 10,000 | same procedure at session level |
| Status | **measured** (live) | **reference** (counterfactual) |

Workload construction: GSM8K [21] questions are grouped into families by a template;
within a family, 30 % of requests repeat exactly and 20 % are paraphrases, which is the
regime in which the layer's mechanisms are expected to act. The benchmark publishes each
trial individually, with its raw CSV, and not only the aggregate.

---

## 6 · Results

### 6.1 Primary evidence (unchanged from the August edition)

| Evidence, system, model | Reduction | 95 % CI | Workload and basis |
| --- | --- | --- | --- |
| Live SDK A/B · `gpt-4o-mini` | **31.5 %** | [25.7; 36.7] | 100 families / 200 requests per arm; 30 % exact repeats + 20 % paraphrases; SDK 0.4.31; measured |
| Live SDK A/B · `claude-sonnet-5` | **75.1 %** | [69.3; 79.6] | 31 families / 62 requests per arm; `cache_control` enabled in B (≈41 pp of the effect); measured |
| Counterfactual gateway replay · Anthropic TTL | **2.49 %** | [1.50; 3.57] | 19,779 requests / 51 sessions / 13 days; partially reconstructed baseline; reference |

Reading the table: the OpenAI figure is the clean case — repetition-dominated traffic and
a saving that comes from calls never executed. The Anthropic figure is large mainly
because the instrumented arm enables a provider cache the baseline arm did not use; the
paper reports both the raw figure and the enabled share, because quoting 75.1 % as
"the layer's saving" would overstate the attribution. The gateway figure is small and
reference-valued; it shows where Anthropic spend is concentrated, not a validated
generalization.

### 6.2 New operational evidence (this edition)

- **Gemini protocol metering.** `:generateContent` and `:streamGenerateContent` (SSE with
  `alt=sse`, and newline-delimited JSON) forward byte-for-byte against a fake upstream
  and produce a `measured` record with the provider's `usageMetadata` mapped to the same
  ledger shape. Non-breakage and fidelity, not a savings interval.
- **DeepSeek Anthropic-format rewrite.** `/v1/messages` travels to
  `/anthropic/v1/messages` with client headers intact (test-locked). Operational.
- **Catalog guard.** The price guard test rejected a ×1000 per-million copy error during
  this edition's development, before publication — evidence that the "a wrong price is
  worse than no catalogue" doctrine is enforced mechanically, not by review.

### 6.3 Routing economics at list prices (conditional arithmetic)

| Model | Input | Output | Cached input | Note |
| --- | --- | --- | --- | --- |
| `claude-sonnet-5` | ~2.00 | ~10.00 | 0.20 | Anthropic 1-h cache writes 2× |
| `gpt-4o-mini` | 0.15 | 0.60 | 0.075 | OpenAI automatic caching |
| `deepseek-flash` | 0.30 (peak) | 1.20 | **0.003** | off-peak half; Anthropic-format endpoint |
| `qwen3.8-flash` | 0.15 | 0.47 | 0.015 | explicit cache, 1.25× writes |
| `glm-5.3-flash` | ~0.11 | ~0.39 | — | CNY→USD at 7.2; hit price not split per model |

*Conditional arithmetic, not a measurement.* For a workload whose prompts repeat within
the cache window, list prices make a cached input token **~66× cheaper** on
`deepseek-flash` than on `claude-sonnet-5` (0.20 / 0.003 ≈ 66.7), and off-peak DeepSeek
input is **~13× cheaper** than Sonnet input (2.00 / 0.15 ≈ 13.3). The cross-provider
quality gap is exactly what a cascade's deterministic gate must certify before any of
this becomes savings; until then the layer may route in shadow mode (measure-only) at
zero additional provider cost. The paper deliberately publishes the price gradient and
not a routing win-rate, because no win-rate has been measured yet.

### 6.4 Break-even (provisional)

At a list-price reduction `R` applied to a monthly list-price bill `B`, a seat with a
total monthly fee `F` pays off iff `R · B > F`. With `F = €15` per seat per month and the
live OpenAI figure `R = 0.315`, the break-even bill is `B* = F / R ≈ €47.6` per month.
This is conditional arithmetic on a measured ratio, not a forecast: the ratio is a
property of a workload, and a workload with less repetition has a smaller `R`.

### 6.5 Intra-batch dedup (deterministic)

Deduplication is an identity, not an estimate: two requests with byte-identical provider
bodies produce byte-identical results, so sending one and replaying the other avoids a
provider execution without changing any answer. A deterministic benchmark against a
counting batch adapter reports executions avoided exactly proportional to the duplicate
rate of the workload: 10 % duplicates → 10 % of executions and input tokens avoided;
30 % → 30 %; 50 % → 50 % (1,000 items; artifacts in
`benchmarks/evidencia/dedup-de-lote-2026-11-09.json`). The saving composes with the 50 %
batch discount and is never double-counted: the summary credits each sent execution once
and reports the deduplicated count separately.

---

## 7 · Threats to validity

| Threat | Statement | Mitigation in this paper |
| --- | --- | --- |
| Construct | List prices are not invoices: negotiated rates, credits, taxes and rounding are absent | Every figure is labelled `measured` at list prices; invoice reconciliation is out of scope |
| Internal | The Anthropic effect includes a cache the instrumented arm enables | The enabled share (≈41 pp) is reported separately; A-arm cache behavior is described |
| Internal | A mechanism applied to the same request interacts with another | Proposition 1 keeps the ledgers separate and states `ε`; no unconditional sum is reported |
| External | Two small constructed workloads, one gateway organization, two providers | Results are restricted to the measured regimes; the roadmap schedules replication |
| Statistical | Percentile intervals, B = 10,000, family-level resampling | Seeds and artifacts published; interval type stated; no BCa claim |
| Reliability | No independent replication | Stated as a limitation; the roadmap preregisters external replication |
| Conclusion | Vendor evaluation by the product's author | Conflict of interest declared; every claim is bounded to reported artifacts |

---

## 8 · Limitations

All August limitations stand: small constructed samples (100 + 31 families), one gateway
organization, no invoice reconciliation, no independent replication, no quality or
latency non-inferiority, an in-memory linear semantic store, and the authors' developer
role. Two additions for this edition:

1. The Chinese-provider rows rely on pricing pages consulted 2026-11-03, with DeepSeek at
   peak rates and GLM converted at 7.2 CNY/USD; per-model Kimi and MiniMax prices were
   not verifiable from official pages at review time and stay out of the catalog.
2. Community mode shifts the risk model: without the cloud key there is no revocation or
   entitlement channel at all (by design). A distribution with a present but invalid key
   remains fail-closed; a user who never configures one has an ungated local product —
   the intended open-core trade, and the reason the cloud remains the paid surface.

---

## 9 · Preregistered research roadmap

1. **Factorial design**: deduplication × `cache_control` (attribution of the 41 pp), with
   a per-cell power analysis.
2. **ρ sweep**: exact-repeat rate swept across families to estimate the response curve
   (replacing the single-point extrapolation).
3. **Hierarchical multi-day experiment**: families × sessions × days, multiple
   organizations; immutable resampling artifacts released.
4. **Non-inferiority tests**: answer quality, freshness and latency, preregistered and
   adequately powered; includes the routing gate and the TTL lever.
5. **Calibrated semantic cache at scale**: multi-tenant precision across cache
   utilization and Operational Retention Rate, against the AWS/GPTCache reference points
   of Section 6.3 and [27].
6. **Invoice reconciliation**: negotiated prices, credits, taxes, rounding — one real
   organization's provider invoices versus the layer's list-price ledger.
7. **External replication**: an independent team reproduces the live double-runs from the
   published branch and artifacts.

---

## 10 · Data and code availability

Public-bench summaries, each trial individually and its raw CSV, remain at
[savings.bivelio.com/benchmarks](https://savings.bivelio.com/en/benchmarks). The
open-core software ships on npm (`@bivelio/savings-layer`, Apache-2.0) and on PyPI
(`bivelio-savings-layer`); the gateway test suites — including the Gemini and DeepSeek
rewrites — run against fake upstreams with no network. This preprint's source is
`docs/PAPER.md` and its arXiv-ready LaTeX source is `docs/paper/main.tex`. Raw gateway
logs remain private; the counterfactual replay's aggregate artifacts are public.

---

## 11 · Conflict of interest

The author is the founder of BiVelio Inc, which develops the evaluated product. No
independent replication is reported.

---

## References

[1] Huiqiang Jiang, Qianhui Wu, Chin-Yew Lin, Yuqing Yang, Lili Qiu. LLMLingua:
Compressing prompts for accelerated inference of large language models. EMNLP, 2023.

[2] Zhuoshi Pan, Qianhui Wu, Huiqiang Jiang, et al. LLMLingua-2: Data distillation for
efficient and faithful task-agnostic prompt compression. Findings of ACL, 2024.

[3] Jesse Mu, Xiang Lisa Li, Noah Goodman. Learning to compress prompts with gist tokens.
NeurIPS 36, 2023.

[4] In Gim, Guojun Chen, Seung-seob Lee, et al. Prompt Cache: Modular attention reuse for
low-latency inference. arXiv:2311.04934, 2023.

[5] Bin Gao, Ziming He, Purushotham Sharma, et al. Cost-efficient large language model
serving for multi-turn conversations with CachedAttention. USENIX NSDI, 2024.

[6] Lianmin Zheng, Liangsheng Yin, Zhiqiang Xie, et al. SGLang: Efficient execution of
structured language model programs. arXiv:2312.07104, 2023.

[7] Jiayi Yao, Hanchen Li, Yuhan Liu, et al. CacheBlend: Fast large language model
serving for RAG with cached knowledge fusion. EuroSys, 2025.

[8] Anthropic. Prompt caching — documentation. https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching

[9] OpenAI. Prompt caching — API guide. https://platform.openai.com/docs/guides/prompt-caching

[10] Fu Bang. GPTCache: An open-source semantic cache for LLM applications enabling
faster answers and cost savings. NLP-OSS Workshop, 2023.

[11] Jiaxing Li, Chi Xu, Feng Wang, et al. SCALM: Towards semantic caching for automated
chat services with large language models. arXiv:2406.00025, 2024.

[12] Waris Gill, Mohamed Elidrisi, Pallavi Kalapatapu, et al. MeanCache: User-centric
semantic caching for LLM web services. arXiv:2403.02694, 2024.

[13] Lingjiao Chen, Matei Zaharia, James Zou. FrugalGPT: How to use large language models
while reducing cost and improving performance. arXiv:2305.05176, 2023.

[14] Isaac Ong, Amjad Almahairi, Vincent Wu, et al. RouteLLM: Learning to route LLMs
with preference data. ICLR, 2025. arXiv:2406.18665.

[15] Woosuk Kwon, Zhuohan Li, Siyuan Zhuang, et al. Efficient memory management for large
language model serving with PagedAttention. ACM SOSP, 2023.

[16] Yaniv Leviathan, Matan Kalman, Yossi Matias. Fast inference from transformers via
speculative decoding. ICML, 2023.

[17] OpenTelemetry Project. Generative AI semantic conventions.
https://opentelemetry.io/docs/specs/semconv/gen-ai/

[18] Joint Committee for Guides in Metrology. Guide to the expression of uncertainty in
measurement. JCGM 100:2008, 2008.

[19] Joint Committee for Guides in Metrology. International vocabulary of metrology
(VIM), 3rd ed. JCGM 200:2012, 2012.

[20] Anthropic. Claude Code — agentic coding tool documentation.
https://www.anthropic.com/claude-code

[21] Karl Cobbe, Vineet Kosaraju, Mohammad Bavarian, et al. Training verifiers to solve
math word problems. arXiv:2110.14168, 2021.

[22] Bradley Efron, Robert J. Tibshirani. An Introduction to the Bootstrap. Chapman and
Hall/CRC, 1993.

[23] A. C. Davison, D. V. Hinkley. Bootstrap Methods and Their Application. Cambridge
University Press, 1997.

[24] Luis Gaspar Schroeder, Aditya Desai, Alejandro Cuadron, et al. vCache: Verified
semantic prompt caching. ICLR, 2026. arXiv:2502.03771.

[25] Dongxin Guo, Jikun Wu, Siu Ming Yiu. RouteNLP: Closed-loop LLM routing with
conformal cascading and distillation co-optimization. arXiv:2604.23577, 2026.

[26] Bernhard C. Geiger. Notation matters: A benchmark study of token-optimized formats
in agentic AI systems. arXiv:2605.29676, 2026.

[27] Aditeya Baral. Closing the operational gap in semantic caching. arXiv:2606.19719,
2026.

[28] BiVelio. Calibrated semantic-cache evaluation and abstention report. Public
benchmark documentation, September 2026. https://savings.bivelio.com/benchmarks

---

## Appendix A · Notation and derivations

**A.1 Cost functional.** `C(π, u) = (π_in·i + π_out·o + π_cache·c) / 10^6`. The
catalog stores prices per 1,000 tokens; the division by 10^6 above assumes per-million
values, and the implementation divides by 10^3 after multiplying by per-1,000 prices; the
two conventions produce the same amount only when used consistently, which is why the
per-million copy error that the guard rejected was material.

**A.2 Ratio estimator.** With per-family ratios `R_f`, the mean-over-families estimator
`R̂ = (1/F) Σ_f R_f` is a ratio-of-sums per family and a simple mean across families. Its
bias is `O(1/F)` for the ratio component; the bootstrap interval captures the sampling
variability of the families, not the bias term — a stated limitation.

**A.3 Additivity residual.** In the notation of Proposition 1, `ε` is bounded in
practice by the largest single-request interaction observed in the traces: the
implementation reports every stage that ran, so a reader can audit which mechanisms
co-occurred on a request.

## Appendix B · Bootstrap procedure

1. For each family `f`, compute `R_f` from the paired arm totals.
2. Draw `B = 10,000` resamples of the family index set with replacement.
3. For each resample `b`, compute `R̂_b` as the mean over the drawn families.
4. Report the empirical 2.5th and 97.5th percentiles of `{R̂_b}`.
5. Publish the seed, the resample count, and the artifact hash.

The procedure is `O(B·F)`; with `F ≤ 100` and `B = 10^4` it runs in milliseconds and is
rerun inside the CI so that a red test blocks a release.

## Appendix C · Reproducibility

- Install the SDK: `pnpm add @bivelio/savings-layer` (or `npm i`), Node ≥ 20.19.
- Run the benchmark from source: `pnpm bench` with `BIVELIO_LICENSE_KEY` only when
  exercising the cloud; community mode requires no key.
- The gateway's live bench and the weekly live battery run in CI; their reports are
  published trial by trial at the public bench.
- The catalog version that produced every figure in this paper is recorded in
  `src/pricing/catalogo.ts` and echoed in each report as `versionPrecios`.

## Appendix D · Resumen en español

Esta edición extiende la evaluación de agosto a la distribución open core: la capa corre
sin clave en modo comunitario (todas las palancas locales, telemetría cero), mide tres
protocolos de proveedor —incluido el protocolo Gemini— y el endpoint en formato Anthropic
de DeepSeek, y añade al catálogo versionado los precios de lista de DeepSeek, Qwen y GLM
(DeepSeek a tarifa peak, el lado conservador). Las cifras primarias no cambian: 31,5 %
[25,7; 36,7] en OpenAI y 75,1 % [69,3; 79,6] en Anthropic, con ≈41 puntos porcentuales de
efecto de caché habilitado por el brazo instrumentado; el replay contrafactual del gateway
sigue en 2,49 % [1,50; 3,57]. Se añade un análisis económico del enrutamiento presentado
como aritmética condicional —no como ahorro medido—, una posición frente al benchmark de
caché semántica publicado, y un mapa de investigación prerregistrado para los diseños
factorial y de no inferioridad que la edición de agosto dejó como trabajo futuro.

La contribución metodológica es una descomposición formal del ahorro en cuatro libros
que nunca se suman, con una proposición que explicita las condiciones de aditividad y un
residuo de interacción que se declara, y una jerarquía de etiquetas de evidencia
(medido, referencia, estimado, no medido) que impide presentar una estimación como un
hecho de factura.
