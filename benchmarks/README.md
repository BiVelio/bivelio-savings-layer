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
- **Arm A1 (reasonably optimized, "B1")** — the *same* integration a diligent
  team would run **without** BV-SALA after reading its provider's docs: identical
  to Arm A except that (1) the native prompt cache is configured on the stable
  prefix (`cache_control` on Anthropic through `stablePrefixMessages`, a
  `prompt_cache_key` hint on OpenAI-compatible endpoints) **only where that prefix
  really repeats** — cold-salted scenarios are never marked, because a client
  would pay the 1.25× write premium for a hit that cannot happen — and (2) only
  the tools a diligent integrator would send, **when the scenario declares them
  by hand** (`toolsB1`; without a declaration it sends all tools, like Arm A).
  This is the research guide's second baseline: the headline against Arm A says
  what the layer saves versus an unoptimized integration; the headline against
  Arm A1 (`aggregateB1`) says what is *genuinely attributable to the layer*, once
  the provider's own discount and compact JSON are taken out. Both are published.
  `BVSALA_AB_B1=0` runs the old two-arm bench. Definitions live in
  `benchmarks/brazos.ts`, pinned by `test/brazos-del-banco.test.ts`.
- **Arm A2 (natively well-configured, "B2")** — B1 plus every setting the
  provider documents at no extra charge that *applies to this request shape*:
  reasoning effort, explicit cache mode on GPT-5.6+, tool search over its
  documented threshold. It is the comparison a technical buyer will run against
  us. See [Arm B2](#arm-b2--natively-well-configured-) below.
- **Arm B (BV-SALA)** — the same task through the layer, **as installed from
  npm** (`sdk.asShipped: true`, the default since 2026-09-27).

**All** arms are priced from the provider's own `usage` — so no modeled baseline
can enter, and both are counted by the *same* tokenizer. Savings = the measured
paired dollar delta.

**All arms are also timed end to end** with the monotonic `performance.now()` clock,
under the [B2-F0 protocol](b2/README.md): per-scenario and aggregate p50/p95/max,
plus provider time and layer overhead. Publication requires **total p95 ≤ 3000 ms
and max ≤ 5000 ms** for every active arm, both per scenario and in the aggregate.
The CSV keeps total/provider durations for every paired rep. MOCK durations are
`estimated` and **instrumental only — never a production SLA**.

```bash
pnpm ab            # MOCK: exercises the whole A/B pipeline; dollars labeled ESTIMATED (not a claim)

# LIVE (real provider tokens & cost) — put the credentials in .env.bench once:
cp .env.bench.example .env.bench     # fill in BVSALA_DEMO_API_KEY
pnpm ab                              # the script loads .env.bench by itself

# …or pass them inline for a one-off (the budget is mandatory in LIVE: use the
# ceiling the run prints, rounded up):
BVSALA_DEMO_BASE_URL=https://ai-gateway.vercel.sh/v1 \
BVSALA_DEMO_API_KEY=<KEY> BVSALA_DEMO_MODEL=openai/gpt-4o-mini BVSALA_DEMO_KEEP_PREFIX=1 \
BVSALA_AB_BUDGET_USD=<ceiling> pnpm ab
```

`.env.bench` is gitignored and read via `--env-file-if-exists`, so the key never
reaches the shell history. The same file drives `pnpm demo` and `pnpm ablation`.

### Anthropic needs its own endpoint, or its lever is not measurable ★

`BVSALA_DEMO_BASE_URL` almost always points at a **gateway that speaks the OpenAI
protocol**. `cache_control` — the *only* thing that makes Anthropic cache, because
it does not cache on its own — does not exist in that protocol: there is no field
to put it in. So a `claude-*` model served through the gateway can never exercise
the prefix-cache lever, and the run that pretended otherwise published **0 cached
tokens on both arms over a 7,287-token stable prefix**, which reads as a measured
failure and was not one: the adapter was never instantiated.

Two things changed, and both are needed:

```bash
# the native Messages API, declared separately — it is a different dialect,
# not another URL for the same thing
BVSALA_DEMO_ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
BVSALA_DEMO_ANTHROPIC_API_KEY=<your Anthropic key>   # put it in .env.bench, never inline
```

1. **With it declared**, every model of that family is served by
   `AnthropicProvider`: `cache_control` travels, the cached read is billed at 0.1x,
   and ledger 4 gets a delta that is genuinely attributable to the layer (the naive
   arm does not mark anything, because almost nobody does).
2. **Without it**, the scenario is **not run at all**. Its lever is declared in
   `levers.notMeasurable` with the reason *and* with what to configure, and the
   console prints `⊘ NO MEDIBLE`. There is no zero to misread, and no money is
   spent on a scenario that cannot measure what it exists to measure.

The model id sent to the native endpoint is always stripped of its `provider/`
prefix (`anthropic/claude-sonnet-4-5` → `claude-sonnet-4-5`): `BVSALA_DEMO_KEEP_PREFIX`
is a property of the gateway, and that same id is a 404 against the native API.

`test/transporte-del-banco.test.ts` holds this down with a fake `fetch`: it asserts
the request lands on `/messages`, that `cache_control` sits at the end of the stable
prefix, and that the same model through the gateway carries no `cache_control` at
all. Proving this live costs money, and that cannot be the only way to know.

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

**And a lever the *transport* cannot carry is a third thing.** `notExercised`
means "it was asked for and it did not fire", which is a measurement.
`levers.notMeasurable` means "with this endpoint it cannot even be asked for" —
the scenario does not run, so there is no figure at all, and the entry carries
`comoMedirla`, the configuration that would produce one. Folding the two together
is exactly how a 0 from the Anthropic cache scenario got published as if someone
had measured a failure.

#### A bare `cached_tokens = 0` is never published on its own

The same run measured **5,120 cached tokens on `gpt-4o` and 0 on `gpt-4o-mini`**
for `Stable-prefix agent turn` — the same prompt, byte for byte, ~5,258 tokens
(and 5,120 is 40 × 128, OpenAI's caching granularity). So the **tier minimum does
not explain that zero**: both prompts clear 1,024 by a factor of five. The bench
now says which of the three possible causes it is, because they lead to opposite
decisions:

| what the report says | cause |
| --- | --- |
| *"…no llega al mínimo de tramo"* | the prompt is below the tier minimum — the provider caches nothing there, and the zero **is** explained |
| *"la capa NO marcó el prefijo: `<reason>`"* | our own gate declined to mark; the zero says nothing about the provider |
| *"el tamaño del prompt NO explica este cero"* | prompt over the minimum **and** prefix marked: what is left is the endpoint not reporting `cached_tokens`, or the requests not landing on a warm instance (through a gateway, routing is not ours). **Not** a measurement that the lever does not save |

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
reason in `scenariosNotApplicable` — with `causa: "familia"` when the model is of
the other family, and `causa: "transporte"` when the model is right but the
configured endpoint cannot speak its protocol (see the Anthropic section above).

Artifacts: with one model, `out/ab-live.json` (+ trials CSV) exactly as before —
that is what `pnpm ab:publish` reads. With several, one
`out/ab-live--<model>.json` (+ `out/ab-live-trials--<model>.csv`) each plus
`out/ab-live-por-modelo.{json,csv}`, and **no** `ab-live.json`: a headline needs
one model. To publish one of them without paying for another run, see
[Publishing one model from a multi-model run](#publishing-one-model-from-a-multi-model-run).

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

`BVSALA_AB_BUDGET_USD` is **mandatory in LIVE** since 2026-09-27: the run aborts
before the first provider call if it is missing or below the ceiling. The
ceiling is not a ceiling for scenarios without `maxOutputTokens` (a reasoning
model can write as much as it likes there; the estimate says how many there
are), so the run also keeps a **running spend** of every provider call —
classification probe, all four arms, cache amortization; the judge is excluded
and says so — and stops as soon as it passes the budget. The model in progress
is marked `modelsFailed: [{ error: "budget" }]`, nothing publishable is written
for it, the remaining models are not started, and the exit code is 1. What a
model actually cost is in `cost.spentUsd`, next to `cost.ceilingUsd`.

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
- the run does not declare `sdk.asShipped: true` — **MOCK included** since
  2026-09-27. `false` means it measured the bench-only compressor; a missing
  seal means it predates the seal, and until then the bench measured **with**
  that compressor by default (the 2026-09-12 artifact has exactly that shape).
  The npm package ships `noopCompressor` only, so a headline measured with
  `benchmarks/compresor.ts` promises a lever the customer does not have. No
  override: the publishable run is plain `pnpm ab` (see
  [asShipped is the default](#asshipped-is-the-default)), and its compression
  scenario is still measured (it is traffic a customer sends) with the lever
  declared in `levers.notExercised`;
- a LIVE run has no numeric `aggregateB2` interval: without arm B2 there is no
  comparison against what the provider gives for free (`BVSALA_AB_B2=0` is a
  research run);
- `pricing.listPriceKnown` is false (the model has no row in the SDK price
  catalogue, so its dollars are illustrative);
- the model pays a cache-write premium (`pricing.cacheWrites.premium > 1`) and
  not every call carried the provider's write counter (`metered` is not true):
  unmetered writes would be priced at zero;
- `native.degradedByTransport` is true (a Claude model through an
  OpenAI-protocol endpoint cannot carry `cache_control` or
  `output_config.effort`), or `native.honored.promptCacheMode` is false (the
  provider wrote cache under explicit mode with no breakpoint: the endpoint does
  not forward `prompt_cache_options`);
- a LIVE run does not name its endpoint (`transport.endpointHost`), or names a
  loopback / private-network host: the site publishes measurements against a
  provider, not against a local server;
- `cost.aborted` is present;
- `scenarioSet.size` is not the number of measured plus not-applicable
  scenarios (dropping a red row is choosing the figure), or a LIVE run does not
  declare `scenarioSet`;
- `floors` does not match its aggregates, `floors.min` is not the lowest of
  them, or a LIVE run has no `floors`;
- the B2-F0 latency report is missing/malformed, any active arm has total
  `p95 > 3000 ms` or `max > 5000 ms` in the aggregate or a scenario, or its
  `measured`/`estimated` and MOCK-instrumental labels are wrong. The exact
  reasons are stored in `latency.gate.reasons` and recomputed by the publisher;
- savings exceed 100%, the interval is inverted, or the point estimate falls
  outside its own interval.

`proven: false` **is** publishable — under-claiming is honest — but it warns, and
the landing must not present it as demonstrated savings. So is a `floors.min`
below 5%, with a warning that quotes the competition report (§8 rec. 3): below
that against the strongest baseline, the message should turn towards the
accounting. That is a business decision, not a blocker.

**What `sdk.asShipped: true` does and does not say.** It says arm B carried no
piece the bench injects and npm does not ship. It does *not* say the run
measured the published tarball: the bench imports `../src/index.js`, so it
measures `src/` at the sealed commit (`sdk.version`). If `main` is ahead of
npm, compare `sdk.version` with `npm view @bivelio/savings-layer version`
before publishing. `sdk.tokenizer` says whether the exact tokenizer
(`gpt-tokenizer`, an optional dependency of the package) was registered — a
default install without it uses the heuristic estimator.

### Publishing one model from a multi-model run

```bash
pnpm ab:publish --model openai/gpt-6-luna --dry-run
pnpm ab:publish --model openai/gpt-6-luna
```

`--model <id>` (or `--model=<id>`) publishes `out/ab-live--<slug>.json` together
with its own `out/ab-live-trials--<slug>.csv`, so a multi-model run never has to
be paid for twice. The slug is `babosaDeModelo` in `publish-guard.ts`, the same
function the bench uses to write the files, and the artifact's `model` must be
exactly the requested id: the file name does not decide what gets published.
Without `--model` and without `ab-live.json`, the publisher lists the per-model
artifacts it found.

### Arm B2 — natively well-configured ★

B2 answers the question a technical buyer will ask first: *what is left once I
switch on everything my provider already gives me for free?* It is **B1 plus
every setting the provider documents at no extra charge that applies to this
request shape** — not «everything on». A setting that cannot fire here measures
nothing and adds risk (beta headers, 400s), so each one has an applicability
rule with its official source, and the artifact publishes every decision in
`native.decisions` (and per scenario in `scenarios[].native`) so anyone can
check it against the documentation. The Fase 0 protocol in
[`benchmarks/b2/README.md`](b2/README.md) adds the hard latency budget without
creating another harness: it reuses these scenarios, paired reps, seed and CIs.
Non-inferiority still means passing the existing quality/contract/truncation
gates and keeping every savings claim under `floors.min`; a faster or cheaper
answer never compensates a quality regression.

| Setting | B2 applies it when | Source (checked 2026-09-27) |
|---|---|---|
| Reasoning effort, OpenAI (`reasoning_effort`) | the model reasons; value validated per model (gpt-6-luna has no `minimal`) | [gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Chat Completions types](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/chat/completions/completions.ts) |
| Reasoning effort, Anthropic (`output_config.effort`) | the model is in the parameter's `supportedModels` (Claude Sonnet 5 is; Haiku 4.5 and Sonnet 4.5 are not) | [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) |
| Reasoning effort, Gemini (`reasoning_effort` → `thinking_level`) | Gemini reasons (it cannot be turned off on Gemini 3, so `none` is rejected) | [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) |
| Explicit cache mode (`prompt_cache_options.mode: "explicit"`) | GPT-5.6 and later over Chat Completions; a `prompt_cache_breakpoint` only at the end of a prefix B1 already marks (never on cold-salted scenarios) | [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) |
| Anthropic cache breakpoint | kept from B1 (B2 is a superset) | [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| Tool search (Anthropic, BM25) | native Anthropic endpoint, 10 or more tools or more than 10k tokens of definitions, model in the compatibility table; every tool is sent, deferred except B1's hand-picked ones | [Tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) |
| Threshold compaction / context editing | never on today's single-turn scenarios (compaction's lowest trigger is 50,000 input tokens; there are no earlier tool results to clear) | [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold), [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) |
| Implicit cache (Gemini, pre-5.6 OpenAI) | already on in every arm, B0 included; declared, nothing to send | [Gemini caching](https://ai.google.dev/gemini-api/docs/caching), [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) |

How it travels: `ProviderRequest` has no fields for effort, tool search or cache
mode, and adding them would change the package's public API. So B2 goes through
the **same adapter** as every other arm and a bench-only `fetch` rewriter
(`benchmarks/nativo.ts`, `reescribirCuerpo`) adds the settings to the body the
adapter built. It never removes messages, never touches their text, and never
changes `temperature`, `max_tokens` or `tools` outside the cases above.

What B2 costs in quality: its effort defaults to `low` (`BVSALA_AB_B2_EFFORT`:
`none|minimal|low|medium|default`), below the documented default of gpt-6-luna
(`medium`) and Claude Sonnet 5 (`high`), and the level the Sonnet 5 guidance
lists for chat and non-coding work.
It is not free: `scenarios[].nativeContractValid`, `truncated.nativo` and
`reasoningTokens.nativo` show what it cost. If B2 is cheaper because it answers
worse, that counts **against** BV-SALA's savings. `default` gives a B2 without
that trade-off.

What gets published: `aggregateB2` (B against B2, same stratified estimator),
`ledgersB2` / `reconciliationB2`, `aggregateNativeVsB0` (what the provider alone
saves — **not** a BV-SALA figure), and `floors`: the lower bounds against B0,
B1 and B2 and their minimum. **Any claim must fit under `floors.min`**, and the
`cifra-del-heroe` gate enforces it for the landing. Cache writes are priced at
the model's write premium in **every** arm (`benchmarks/coste.ts`): until
2026-09-27 the bench billed them at 1×, which hid exactly what explicit cache
mode saves. The adaptive sampler stops on the *widest* of the three intervals.

On today's scenario set B2 differs from B1 only by effort and, on GPT-5.6+, by
cache mode. Adding scenarios where tool search or compaction apply (10+ tools,
50k+ tokens per call) is an owner decision: it changes the headline's strata and
costs more per rep.

### asShipped is the default

`pnpm ab` measures the SDK **exactly as installed from npm** (`sdk.asShipped:
true`). The bench-only compressor now has to be asked for, with
`BVSALA_AB_CON_COMPRESOR=1`: a research run that `pnpm ab:publish` refuses.
`BVSALA_AB_SIN_COMPRESOR` is deprecated: `1` only prints that it is already the
default; any other value aborts with the new instruction, because guessing what
it meant is worse than stopping.

### 2026 preset, direct endpoints and budget

```bash
BVSALA_AB_PRESET=2026 BVSALA_AB_BUDGET_USD=<ceiling printed> pnpm ab
```

`BVSALA_AB_PRESET=2026` measures `openai/gpt-6-luna`, `anthropic/claude-sonnet-5`
(native endpoint required) and `google/gemini-3.8-flash`; `2026+optional` adds
`anthropic/claude-haiku-4-5` and `openai/gpt-oss-120b`. The preset is
incompatible with `BVSALA_DEMO_MODEL(S)`: if both are set (check `.env.bench`),
the run aborts instead of guessing. Ids and their sources are in
`benchmarks/modelos.ts`.

Each family can have its **own direct endpoint**, and the gateway stays as the
fallback: a third party will have provider keys, not ours, and a gateway may not
forward `prompt_cache_options` or return `cache_write_tokens`.

| Variable | Default | Effect |
|---|---|---|
| `BVSALA_AB_PRESET` | — | `2026` or `2026+optional`. |
| `BVSALA_AB_B2` | on | `0` disables B2 (research; cannot be published). |
| `BVSALA_AB_B2_EFFORT` | `low` | `none\|minimal\|low\|medium\|default`, validated per model before any call. |
| `BVSALA_AB_CON_COMPRESOR` | off | `1` injects the bench compressor → `sdk.asShipped: false`. |
| `BVSALA_AB_BUDGET_USD` | — | **Mandatory in LIVE** (and in the probe). |
| `BVSALA_AB_MARGEN_RAZONAMIENTO` | `0` | Tokens added to the output cap of **every** arm, on reasoning models only. Set it after the calibration run, never before. |
| `BVSALA_AB_PERMITIR_PRECIO_ILUSTRATIVO` | off | `1` runs (never publishes) a model without a catalogue row. |
| `BVSALA_AB_OUT_DIR` | `benchmarks/out` | Output directory (the dry tests use a temporary one). |
| `BVSALA_DEMO_OPENAI_BASE_URL` / `_API_KEY` | — | Direct endpoint for the OpenAI family. |
| `BVSALA_DEMO_GOOGLE_BASE_URL` / `_API_KEY` | — | Direct endpoint for Gemini (OpenAI-compatible, `…/v1beta/openai`). |

The run is LIVE as soon as **any** endpoint is declared. Before estimating, a
**preflight** (`veredictoDePrevuelo`, `benchmarks/modelos.ts`) aborts without a
single call when: there is no budget; a model has no endpoint for its family; a
model has no catalogue row (unless the illustrative override is set); a
GPT-5.6+/GPT-6 model's cache-write premium is not 1.25 (the catalogue unit for
2026 has not landed); the B2 effort is invalid for a model; or a model that
needs the native Anthropic endpoint does not have it. It warns about reasoning
models with no reasoning headroom and about scenarios without an output cap.

Sampling is now **per model** (`muestreoPareadoPara`): `temperature: 0` and
`seed: 7` where the model honours them, the provider default where
`src/pricing/razonamiento.ts` classifies the model as reasoning or unclassified
(Claude Sonnet 5 returns 400 to a non-default temperature; the gpt-5 family
accepts only the default). Every arm gets the same, so the pairing stays
honest; the artifact says which in `sampling`.

On gpt-6-luna, Chat Completions supports function calling only with
`reasoning_effort: "none"`. Arm B0 sends the provider default and the SDK cannot
send another, so scenarios with tools are declared **not measurable** on that
transport (with the source) instead of failing mid-run.

### Probe before you pay (`pnpm ab:sonda`)

```bash
BVSALA_AB_PRESET=2026 BVSALA_AB_BUDGET_USD=<ceiling the probe prints, rounded up> pnpm ab:sonda
```

One minimal B0-shaped request per model (cap of 16 output tokens) checks the
credentials and the model id, that the provider accepts the body the adapter
builds (`max_tokens`, the bench's sampling), and which usage counters come back.
On GPT-5.6+/GPT-6 it adds an implicit vs explicit-without-breakpoint pair on the
bench's long stable prefix: `promptCacheModeHonored: true` means the explicit
mode reaches the provider. It prints its ceiling before spending, requires the
budget, writes `out/sonda.json` in English and never prints headers, keys or
URLs — only the endpoint host and the provider's error text, truncated. If the
provider rejects `max_tokens` or `temperature`, **stop**: the fix belongs in
the product (`src/providers/openai-compatible.ts`) and needs its own PR.

### Independent measurement

`docs/MEDICION-INDEPENDIENTE.md` (published byte for byte at
`/measure/independent-measurement.md`) tells a third party how to check us: by
recomputing the published figures (no key, no cost), by measuring the npm
package on their own traffic (the SDK's `verification` option), or by rerunning
this bench. `apps/web/public/measure/reproduce.mjs` (served at
`/measure/reproduce.mjs`, `pnpm medicion:reproducir`) has no dependencies: it
re-runs the seeded stratified bootstrap on the published trials CSV and
compares every aggregate, every scenario row, `trials`, `scenarioSet` and
`floors` with exact equality. `test/medicion-independiente.test.ts` keeps it
honest: whatever is published must be recomputable with the public script.

### The floor the npm package actually delivers (`benchmarks/titular-como-se-instala.ts`)

An artifact measured **with** the bench compressor (the 2026-09-12 one: the
compression scenario saved 15.1 % with a piece npm does not ship) cannot back
the promise on its own. Dropping that scenario is not the fix — it *raises* the
floors (27.2 % / 26.4 %), because it saved less than the average. Instead, with
no network and the published trials, the tool gives back to arm B the input
tokens the compressor removed, keeps B's measured output and repairs, and
reruns the same stratified estimator with the same seed.

How many tokens go back: the **larger** of `attribution.compressedInputTokens`
(what the layer's own report says the compressor removed: 2,005) and
`measured.inputTokenDeltaMean` (the net A − B difference: 1,654). The net
difference already subtracts arm B's own extra input — its output-contract
repairs, which an npm install still pays — so using it alone overstated the
package. The repair call (pipeline stage 11) sends only the invalid reply and
its errors, never the source thread, so it carries nothing the compressor would
have removed: 2,005 per trial is what the first call loses, not a lower bound
to multiply. On the 2026-09-12 artifact: B0 ≥ 10.68 %, B1 ≥ 10.37 % (with the
net difference it read 12.87 % / 12.57 %).

It is a **reconstruction, not a measurement**: its figure is never published,
it only checks that the web's promise also fits under what npm delivers
(`test/titular-como-se-instala.test.ts`, `pnpm luz-verde`). Keeping arm B's
output and repairs as measured is the conservative reading of the data, not a
bound: without the compressor the model sees a different prompt. An artifact
with `sdk.asShipped: true` switches the reconstruction off, and while it is
missing the web never presents that artifact's floor as what a customer gets
(`apps/web/lib/bench/sdk-instalado.ts`).

```bash
pnpm -s exec tsx benchmarks/titular-como-se-instala.ts          # human-readable
pnpm -s exec tsx benchmarks/titular-como-se-instala.ts --json   # for scripts
```

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
2b. **Stratified by scenario, equal weight.** The headline is
   `f = 1 − Σ_s mean(costB_s) / Σ_s mean(costA_s)` — one stratum per scenario,
   bootstrap resampled *within* each scenario (`bootstrapRatioCIEstratificado`
   in `stats.ts`). It used to be the pooled `1 − ΣcostB/ΣcostA` over every
   trial, which weights a scenario by **reps × cost**; since the adaptive
   sampler pours reps into the noisy scenarios, the pooled headline
   moved with the rep split, not with the layer: 20.8% (REPS=16), 16.5% (REPS=8,
   two near-zero scenarios and one with a bimodal arm-B output at 24 reps), 19.1%
   (next run) — while the equal-weight figure stayed within two points:
   21.3 / 19.4 / 20.5. The pooled number is still
   written as `aggregatePooled` for comparison with older artefacts, but it is
   not the claim. Per-ledger CIs remain pooled over the ledger's trials, since a
   ledger's `deltaCost` is a sum by construction (reconciliation rule).
   **Read the interval for what it is:** it is conditional on this fixed set of
   scenarios and covers per-scenario sampling noise only — which is why it is
   much narrower than the pooled one (≈ ±0.7 pt vs ≈ ±5 pt on the same trials).
   It does not cover the uncertainty of which scenarios stand for a customer's
   traffic; the pooled interval did, but weighted by the sampler's rep split.
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

## Effort, lever D (`pnpm esfuerzo`)

The gateway's per-turn effort lever (`gateway/esfuerzo.ts`) is the only one that
can make an answer worse, and it targets the only spend billed at list price:
output, where thinking is billed. `pnpm esfuerzo` measures it on the ring-1
corpus (15 agentic tasks with a programmatic verifier: no judge) with four arms
per task and rep, run back to back:

| Arm | What travels |
|---|---|
| `control` | no effort field: the model's default (`high`; `medium` on `claude-opus-5-5`) |
| `dial-final` | **the lever as shipped**: the control body through the gateway's own `aplicarEsfuerzo`, byte for byte, plus its beta |
| `dial-inicial` | the same dial as the first entry of `messages` (a candidate placement, not the product) |
| `raiz` | top-level `output_config.effort`, constant for the whole task |

The history the harness keeps is the client's: the dial is applied per request,
as the gateway does, and never stays in the next one. Automatic caching is on,
with one salt per run, so the bench also checks the lever's promise of no cache
toll instead of assuming it. Only levels below the model's default are
measured: the lever never raises effort.

```bash
pnpm esfuerzo --humo                  # DRY (default): simulated provider, no network, no key read
BVSALA_ESFUERZO_NIVELES=low BVSALA_ESFUERZO_BUDGET_USD=<ceiling> pnpm esfuerzo --en-vivo --humo
BVSALA_ESFUERZO_BUDGET_USD=<ceiling> pnpm esfuerzo --en-vivo    # 4 reps = 60 pairs per arm and level
pnpm esfuerzo --decidir=benchmarks/out/<effort artifact>.json    # re-run the criterion, no network
```

**The criterion** (`decidir`, `benchmarks/esfuerzo/nucleo.ts`) switches a level
on only when all of these hold: at least 3 tasks; the 95 % CI of the success
difference (resampling whole tasks) has its floor above −margin *and* the
one-sided Clopper-Pearson bound on the loss rate among the pairs control solved
(control solved it, the arm did not) is under the margin (5 points by default,
`BVSALA_ESFUERZO_MARGEN`: with no losses that takes 59 pairs control solved, 29
at 10 points); no truncated answer on either side;
the floor of the output-spend reduction is above zero on all pairs and on pairs
both sides solved; the total bill does not go up; and the share of input read
from cache does not fall more than 2 points. The gateway takes one level for
all traffic, so the global level must also leave no class with a success drop
whose whole CI is below zero. A simulated run never switches anything on.

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

## Muestreo pareado y memoria de contratos fría (2026-09-12)

- **Both arms sample the same way**: `temperature: 0, seed: 7` (`MUESTREO_PAREADO` in
  `scenarios.ts`; Anthropic ignores `seed`). Until 2026-09-12 only the naive arm did;
  arm B went out with the provider's default sampling, so part of its output variance
  was sampling, not the layer. Artefacts before that date are not comparable rep by rep.
- **Fresh contract memory per measured call**, like the cold cache. The layer's limits
  hint (`JSON limits (not API-enforced): …`, ~30 input tokens plus a longer answer, paid
  only by arm B) can now only appear inside a within-call repair; `scenarios[].pistaDeLimites`
  counts the reps where it travelled. Before, one module-level memory served the whole
  run, and eight scenarios share the same contract, so when the hint switched on depended
  on what the model had answered earlier in the run.


## Semantic cache precision (`pnpm cache-semantica`)

The savings bench has no semantic-cache scenario (see `PALANCAS_SIN_ESCENARIO` in
`scenarios.ts`). What it cannot say, whether a reused answer was **right** to reuse,
is measured here, against public datasets and without calling any model. It is a
precision bench, not a savings bench: it computes no money.

**Protocol.** The cache as it ships (built-in lexical embedder, default floors,
deterministic guard, policy) is driven through the whole layer, `createSavingsLayer`
with a stand-in provider, and every figure is read from the `SavingsReport`
(`report.cache.result`, `report.qualityLedger`), not from a re-implementation. The
floors and the record limit in the artifact are probed from the code, not copied.

- **Triplets**: GPTCache `reuse_compatibility` at a pinned commit, arm `arena` only.
  Each case runs in its own tenant (independent cases, Wilson 95 % intervals);
  `uncertain` labels are left out of precision and recall and reported apart.
- **Stream**: SemBenchmarkLmArena at a pinned revision, first `--n` prompts in dataset
  order, one tenant, the default record limit. A hit is correct when it serves the
  prompt's class (`ID_Set`). Hits depend on the cache state, so intervals come from a
  bootstrap over whole classes (B = 2000, fixed seed).
- **Scorer self-check**: `--verificar-puntuador` recomputes the project's published
  figures for its own evaluator from its files; publishing requires it to match exactly.
- No threshold is tuned here. If one ever is, tune on `split=calibration` and report
  on `split=test`.

```bash
pnpm cache-semantica --seco                 # synthetic fixture, no network (what CI covers)
pnpm cache-semantica --descargar            # pinned revisions, verified by sha256 / LFS oid
pnpm cache-semantica --verificar-puntuador
pnpm cache-semantica --conjunto todos --n 20000
pnpm cache-semantica:publicar --dry-run && pnpm cache-semantica:publicar
```

Other flags: `--conjunto tripletas|lmarena`, `--max-registros <N>`, `--datos <dir>`,
`--embebedor dataset:<column>` (precomputed vectors from the stream dataset, about
1 GB of download; a diagnostic the publisher refuses to publish) and `--incluir-orcas`.

**Licenses.** The two triplet arms `search_llama` / `search_gpt` and
SemBenchmarkSearchQueries derive from ORCAS, which is for non-commercial research only.
They are excluded unless `--incluir-orcas` is passed, and the publisher refuses any
artifact that carries them unless `--permitir-origen-no-comercial` is passed, which is
the owner's legal call. Downloads go to `benchmarks/out/cache-semantica/datos/`
(git-ignored): no dataset text is redistributed from this repository.

**Evidence.** `pnpm cache-semantica:publicar` only accepts a live artifact measured on a
clean tree at a recorded commit, with a revision and a fingerprint for every source. It
writes `docs/SEMANTIC-CACHE-PRECISION.md` and copies the artifact, which holds ids,
decisions and similarity scores and no text, to
`benchmarks/evidencia/cache-semantica-<date>.json`; the page cites it by sha256.

### Calibrated semantic cache (`pnpm cache-semantica:calibrada`)

The same stream, driven through the whole layer, with the opt-in `calibration` of
`InMemorySemanticCache` against the cache as it ships. The judge is the dataset's own
definition of a correct hit (same `ID_Set`); the provider is the same stand-in, so no
model is called. Audits use a fixed seed.

- **Stream labels**: every candidate the calibration would label, with its score and
  the dataset's verdict, tabulated by score band (does the score separate right from
  wrong reuses at all?), and `calibrateSemanticFloor()` run on them for each `--delta`.
- **Arms**: the shipped cache, then the calibrated cache per `--delta` with and without
  per-record floors: reuses, precision (class bootstrap), wrong reuses, the certified
  floor, where the first reuse was served and why candidates were not.
- **Triplets**: the `arena` arm as offline labels, calibrated on `split=calibration`
  and checked on `split=test`.

```bash
pnpm cache-semantica --descargar                        # once
pnpm cache-semantica:calibrada --n 20000                # --delta 0.15,0.12,0.1,0.05,0.02 by default
pnpm cache-semantica:calibrada --solo-etiquetas --embebedor dataset:emb_e5_large_v2
```

It writes `benchmarks/out/cache-semantica/calibrada.json` (git-ignored). It is a
diagnostic: nothing here is published as a figure of the product.
