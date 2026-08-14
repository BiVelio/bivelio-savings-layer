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
  payload on the wire, all tools transmitted, no cache, no output cap. It **does**
  carry the caller's response contract when the request declares one: the contract
  is the caller's requirement, not something the layer adds, so an arm without it
  would be solving an easier task. Arm A's answers are validated against that
  contract too — the layer pays tokens to guarantee validity, so it only counts if
  the same is asked of the baseline.
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

### The opt-in levers of 0.3.0 ★

`outputCodebook`, `toolDiscovery`, `compression` and `semanticCache` appeared
**zero** times in `benchmarks/scenarios.ts`. The bench did not switch a single
one of them on, so a live run would have measured the same thing as the
2026-08-13 one and the conclusion — *"the new work saves nothing"* — would have
been a property of the bench, not of the product. That is the same failure the
prefix-cache scenario already cost us once.

Switching them on is not enough. Each has an **economic gate** that discards it —
correctly — when the request does not have the right shape, and a scenario that
switches the lever on without bringing that shape measures zero *with the lever
apparently on*, which is worse, because it looks measured.

| Scenario | Lever | What the gate demands |
| --- | --- | --- |
| `Triage decision (output codebook)` | `outputCodebook` | a contract with **long enums and long keys** — measured with o200k_base, the compact contract saves 29 input tokens — **and a measured output delta for the model**. See the warning below: this lever's sign depends on the model, and the gate refuses without a measurement. |
| `Big tool catalogue (schema-on-demand)` | `toolDiscovery` | a **large catalogue** — 8 read tools (the selector's `maxTools` ceiling), 470 schema tokens each, 3 762 in total. With five small ones the gate refuses, and it is right: two calls would cost more than one. **It carries no stable prefix on purpose**: this lever gives up the provider prefix cache on every request, so mixing them would measure the difference of two levers and attribute it to one. |
| `Forwarded support thread (compression)` | `compression` | an injected `compressor` **and** > 2000 compressible tokens **and** ≥ 200 net tokens removed **and** a compressed prompt that stays inside the cacheable tier. Measured: 3 770 → 1 765 tokens. |
| — | `semanticCache` | **not exercised, deliberately.** It needs an `EmbeddingFn` and there is no implementation in this repo. A ten-line word-hash "embedding" would measure lexical overlap — what the deterministic guard in `cache/semantic.ts` already checks — not semantic similarity, so the scenario would go green measuring something else. The report lists it as NOT EXERCISED with that reason. |

#### ⚠️ The output codebook: MOCK said +24.8%, LIVE said it depends on the model

This is the most expensive lesson in the bench, and it applies to every row of
it, not just this one.

In MOCK the output-codebook scenario reported **+24.8%**. That number is an
artefact of `src/providers/mock.ts`, which fabricates its answer **from the
schema it receives** — hand it a compact contract and it fabricates a compact
answer, every time, whatever model id is being simulated. The half of this lever
that actually decides the money is *how much a real model chooses to write*, and
the mock does not model it at all.

Measured live, same scenario, same prompts, 8 paired repetitions each:

| model | A (no layer) | B (codebook) | Δ output | net |
| --- | --- | --- | --- | --- |
| `gpt-4o` | 184 / 75 | 158 / 72 | **+3** | **+8.0%** (95% lo 4.8%) |
| `gpt-4o-mini` | 184 / 72 | 158 / 88 | **−16** | **−8.2%** |

Input falls identically on both (−26 tokens): that part is deterministic, it is
the smaller contract. **The output changes sign with the model.** A smaller model
appears to lose semantic guidance from short field names (`"d"` instead of
`"decision"`) and fills in more; a larger one does not.

With only the `gpt-4o-mini` run in hand the conclusion was *"this lever loses
money, retire it"* — and the `gpt-4o` run inverted it. **One run against one
model is not a result.** No claim about this lever, or any other, is meaningful
without the model attached to it.

So the layer no longer guesses: it applies the codebook only where the output
delta has been **measured** for that model (`src/constraints/codebook-evidencia.ts`),
and the scenario declares `gpt-4o` because that is the model with a measured
positive delta. Force `BVSALA_DEMO_MODELS=gpt-4o-mini` and the layer discards the
lever and says so in the trace — which is also the correct outcome, and the
report distinguishes it from *"applied and saved nothing"*.

The compressor is `benchmarks/compresor.ts`: it drops **only lines that already
appear verbatim earlier in the same text** (a forwarded thread repeats the order
card, the signature and the legal footer in every message). It rewrites nothing,
so there is no loss to argue about and the saving is defensible without a judge.

**A lever that did not fire says so.** A lever the gate discarded, one whose
probe degraded and one that genuinely saves nothing all produce the *same*
numbers. So every scenario declares its lever, the harness reads the layer's own
trace to see whether it actually fired, and both the console and the artifact
(`levers.exercised` / `levers.notExercised`) carry the verdict with the layer's
own reason. In MOCK two of them can never fire — the mock provider never returns
`tool_calls` and never reports `cached_tokens` — and the run prints exactly that
instead of letting you read a limitation of the mock as a result.

### Per model, without editing code ★

`BVSALA_DEMO_MODEL` overrides the model of **every** scenario and produces one
figure. `BVSALA_DEMO_MODELS` takes a comma-separated list and measures each model
**separately**, then prints one comparable table:

```bash
# one run per model, plus the comparison table
BVSALA_DEMO_MODELS="openai/gpt-4o-mini,openai/gpt-4o,anthropic/claude-sonnet-4-5" pnpm ab

# one model only (this is the one that writes ab-live.json, i.e. the publishable artifact)
BVSALA_DEMO_MODEL=openai/gpt-4o-mini pnpm ab
```

Scenarios that do not apply to a model are **skipped and declared**, never
measured badly. The Anthropic `cache_control` scenario served against an OpenAI
endpoint would measure the discount OpenAI applies *by itself* and book it under
ledger 4 as our contribution; it now says `n/a` in the table and carries its
reason in `scenariosNotApplicable`.

Artifacts: with one model, `out/ab-live.json` (+ trials CSV) exactly as before —
that is what `pnpm ab:publish` reads. With several, one
`out/ab-live--<model>.json` each plus `out/ab-live-por-modelo.{json,csv}`, and
**no** `ab-live.json`: a headline needs one model.

### What the run costs, before you pay for it ★

Every LIVE run prints an estimate first, per model, from the SDK's own list-price
catalogue (`src/pricing/catalogo.ts`) and the tokens of each scenario:

```
Coste estimado de la tirada (techo: salida al tope, brazo B como el A, reps a la cota dura)
  openai/gpt-4o-mini                    $0.0733 –    $0.2142   11 escenarios
  Estas llamadas se pagan. Corta ahora si la cifra no te cuadra.
```

It is a **ceiling** and says so: output counted at the declared cap, arm B priced
as if it spent as much as arm A, adaptive sampling counted at its hard cap. A
model missing from the catalogue is priced illustratively **and flagged**.

`BVSALA_AB_BUDGET_USD=2.50 pnpm ab` aborts before the first provider call if the
ceiling exceeds the budget.

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
- the two arms did not talk to the same **served model** (what actually makes a paired A/B comparable — `system_fingerprint` is recorded but never gated on, because through a gateway it is a per-request id);
- the ledgers don't reconcile — a non-zero residual means double counting;
- savings exceed 100%, the interval is inverted, or the point estimate falls
  outside its own interval.

`proven: false` **is** publishable — under-claiming is honest — but it warns, and
the landing must not present it as demonstrated savings.

**The raw trials ship with the artifact.** `ab-live-trials.csv` is copied next to
`ab-live.json` into `apps/web/public/data/`, so anyone can download it and
recompute the confidence interval themselves. This used to be a broken promise:
the README claimed it while `benchmarks/out/` sat in `.gitignore`, so the CSV
never left the machine that ran it. A product sold on "verify-don't-trust" cannot
ask you to take its confidence interval on faith.

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
7. **Same task, same sampling.** Both arms carry the caller's contract and the same
   `temperature`/`seed`. Quality gates assert the **answer**, never the layer's own
   ledger — a scenario that scored itself on `compressedInput > 0` was scoring the
   very number it had inflated.
8. **Warm knowledge, cold caches.** What the layer learns about a contract persists
   across reps (a deployed layer is not reborn per request); caches do not, so the
   headline never gets a pre-warmed hit.

Output: `benchmarks/out/ab-live.json` (per-scenario + aggregate, with CI and
provenance) and `benchmarks/out/ab-live-trials.csv` (raw paired trials).

## Ablation: where the savings come from (`pnpm ablation`)

"Baseline vs everything on" hides which lever pays for itself. `pnpm ablation`
runs the batch under a ladder of configs, each enabling one more optimization,
and reports the **marginal** contribution of each:

```
stage                cost        vs baseline   marginal Δ
baseline (naive)     $0.004784        0.0%          —
+ exact cache        $0.004768        0.4%      $0.000017
+ resolvers          $0.004757        0.6%      $0.000010
+ router             $0.004663        2.5%      $0.000094
+ format selector    $0.004468        6.6%      $0.000195   ← the big lever on the table payload
+ compression        $0.004016       16.1%      $0.000452   ← the forwarded-thread scenario
+ output codebook    $0.004003       16.3%      $0.000013   ← MOCK ONLY, and an artefact: the
                                                              mock fabricates from the schema, so
                                                              a compact contract always looks like
                                                              a smaller answer. Live it is +8.0% on
                                                              gpt-4o and −8.2% on gpt-4o-mini
+ tool discovery     $0.004084       14.6%     $-0.000082   ← negative in MOCK: the mock never
                                                              returns tool_calls, so the probe
                                                              always degrades and this rung
                                                              measures the pattern's worst case
```

The last three rungs are the 0.3.0 opt-in levers. They used to sit outside the
ladder because nothing switched them on, so their marginal contribution was zero
*by construction* and read as "they add nothing".

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
