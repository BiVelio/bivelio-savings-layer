# BFCL A/B — 2026-09-29 (LIVE)

- **Dataset:** Berkeley Function Calling Leaderboard, `ShishirPatil/gorilla@f7cf7359b7ac615a0b294831c5ba2bc95ee4a000` (Apache-2.0), fetched at run time and sha256-checked per file (`benchmarks/publicados/bfcl/datos.ts`); not vendored.
- **Arm A:** direct provider call with native tools (Anthropic Messages `tool_use` / OpenAI Chat Completions `tools`), hand-written, no layer.
- **Arm B:** v0.4.31 (source of the tag, BVSALA_DEV_OPEN=1; npm = same commit, dist rebuilt from the tag byte-identical) — tag commit `00c99c8`, loaded from `git archive v0.4.31 src` (this tree differs from the tag in `src/version.ts`, so the tree was NOT measured); npm integrity `sha512-ePCN+dZr+VuMUSGm2…`, dist sha256 `b52f99cacf98…`. Default config: provider only (no licenseServerUrl, no service key, no exporters).
- **Hosts contacted during the run:** api.anthropic.com; refused by the host guard: none.
- **Sample:** 12 per AST category (simple, multiple, parallel, parallel_multiple), stratified, seed 20260928, round-robin order; 10 deliberate AST repeats; 10 multi_turn_base entries for the cache-isolation probe. Merged runs, each with its own sample (same seed: every part draws from the same seeded order): anthropic/claude-haiku-4-5: 12/category AST, 10 repeats, 10 multi-turn; anthropic/claude-sonnet-5: 12/category AST, 5 repeats, 1 multi-turn from position 1 of the seeded order. Budget per model (A+B, hard cap in code): anthropic/claude-haiku-4-5 1.2500 $, anthropic/claude-sonnet-5 1.2500 $; enforced before every call.

## Per model

| Model | n | AST acc. A | AST acc. B | B − A (paired) | same calls | layer changed a call | cost A | cost B | saving (measured, stratified) | spend (A+B, all parts) |
|---|---|---|---|---|---|---|---|---|---|---|
| anthropic/claude-haiku-4-5 | 48 | 89.6 % [77.8 %, 95.5 %] | 89.6 % [77.8 %, 95.5 %] | 0.0 pp [0.0, 0.0] | 48/48 | 0 | 0.0785 $ | 0.0784 $ | 0.1 % [0.0 %, 0.2 %] | 0.8116 $ |
| anthropic/claude-sonnet-5 | 48 | 91.7 % [80.4 %, 96.7 %] | 91.7 % [80.4 %, 96.7 %] | 0.0 pp [-6.3, 6.3] | 43/48 | 0 | 0.1794 $ | 0.1768 $ | 1.5 % [-1.6 %, 5.8 %] | 0.5993 $ |

Accuracy: Wilson 95 % interval. B − A: paired bootstrap of per-entry correctness (seed fixed). Saving: 1 − ΣB/ΣA over AST pairs, bootstrap stratified by category, both arms priced from the provider's own `usage` with the SDK catalogue list prices (`cable.ts`). Spend includes AST, repeats and the multi-turn probe.

## Accuracy by category (correct A / correct B / n)

| Model | simple | multiple | parallel | parallel_multiple |
|---|---|---|---|---|
| anthropic/claude-haiku-4-5 | 11 / 11 / 12 | 11 / 11 / 12 | 11 / 11 / 12 | 10 / 10 / 12 |
| anthropic/claude-sonnet-5 | 11 / 12 / 12 | 11 / 11 / 12 | 11 / 10 / 12 | 11 / 11 / 12 |

## Cost, cache and what the layer claims

| Model | input tok A / B | cache read A / B | cache write A / B | output tok A / B | cache_control marks in B | layer's own claimed saving (modelled) | B report basis | B exact-cache results |
|---|---|---|---|---|---|---|---|---|
| anthropic/claude-haiku-4-5 | 40612 / 40612 | 0 / 0 | 0 / 0 | 7573 / 7563 | 0 | 0.0000 $ | {"measured":48} | {"miss":48} |
| anthropic/claude-sonnet-5 | 39353 / 39353 | 0 / 0 | 0 / 0 | 10070 / 9805 | 0 | 0.0000 $ | {"measured":48} | {"miss":48} |

*Measured* = the two columns priced from each arm's provider `usage`. *Modelled* = Σ(`report.cost.baselineEstimate − report.cost.actual`) from the layer's own report; it is not a measurement and is shown only to compare with the measured delta.

## Deliberate repeats (AST, a tool-call turn must never be served from cache)

| Model | repeats | B cache result | B provider calls | cost A | cost B |
|---|---|---|---|---|---|
| anthropic/claude-haiku-4-5 | 10 | {"miss":10} | 10 | 0.0116 $ | 0.0116 $ |
| anthropic/claude-sonnet-5 | 5 | {"miss":5} | 5 | 0.0121 $ | 0.0121 $ |

## Multi-turn cache isolation (#368, live)

Per entry: step 0 (first user turn, all the entry's tools) in both arms; then five continuations built from the SAME tool call: V1 result ok; V2 same content with `isError: true`; V3 one argument changed; V4 exact repeat of V1 (fresh call ids); V5 exact repeat of V2. V2 and V3 must never be served from cache; V4/V5 may, but only with their own original's answer. Tool results are synthetic (the bench does not execute BFCL's Python classes), so this is NOT BFCL's multi-turn accuracy metric.

- **anthropic/claude-haiku-4-5 · multi_turn_base_157** (MathAPI+TravelAPI, 35 tools; on the wire A 35 / B 35) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-haiku-4-5 · multi_turn_base_78** (TwitterAPI+VehicleControlAPI, 36 tools; on the wire A 36 / B 36) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-haiku-4-5 · multi_turn_base_47** (GorillaFileSystem+MathAPI, 35 tools; on the wire A 35 / B 35) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-haiku-4-5 · multi_turn_base_183** (TwitterAPI+TravelAPI, 32 tools; on the wire A 32 / B 32) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: exact/0 calls · V5-repite-V2: exact/0 calls — no violation
- **anthropic/claude-haiku-4-5 · multi_turn_base_9** (GorillaFileSystem, 17 tools; on the wire A 17 / B 17) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-haiku-4-5 · multi_turn_base_37** (GorillaFileSystem, 18 tools; on the wire A 18 / B 18) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-haiku-4-5 · multi_turn_base_62** (MessageAPI+VehicleControlAPI, 32 tools; on the wire A 32 / B 32) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-haiku-4-5 · multi_turn_base_133** (TradingBot+TicketAPI, 29 tools; on the wire A 29 / B 29) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-haiku-4-5 · multi_turn_base_95** (MessageAPI+VehicleControlAPI, 32 tools; on the wire A 32 / B 32) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-haiku-4-5 · multi_turn_base_122** (TradingBot, 20 tools; on the wire A 20 / B 20) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-sonnet-5 · multi_turn_base_78** (TwitterAPI+VehicleControlAPI, 36 tools; on the wire A 36 / B 36) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation

| Model | entries | step 0: a call in BFCL's reference turn 1, A / B | step 0: no tool call at all, A / B | tools on the wire (A → B) |
|---|---|---|---|---|
| anthropic/claude-haiku-4-5 | 10 | 8 / 8 | 0 / 0 | 35→35, 36→36, 35→35, 32→32, 17→17, 18→18, 32→32, 29→29, 32→32, 20→20 |
| anthropic/claude-sonnet-5 | 1 | 1 / 1 | 0 / 0 | 36→36 |

## Findings about the layer (A≠B)

- None observed.

## 0.4.30 → 0.4.31: what changed

Previous run: `docs/benchmarks/2026-09-28/bfcl.json` (v0.4.30, tag commit `946f5d5`, 2026-09-28; 100/category AST, 10 multi-turn, seed 20260928). Same dataset commit, same seed, so the same AST entries and the same multi_turn_base entries. Arm A is re-measured in each run (the models are nondeterministic), so compare B against its own A first, then across versions.

### Multi-turn step 0 (the #382 fix: an untyped catalogue is no longer cut to 8 tools)

| Model | version | tools on the wire A → B | entries B sent fewer tools | step 0 in BFCL's reference turn 1, A / B | step 0 no tool call, A / B |
|---|---|---|---|---|---|
| anthropic/claude-haiku-4-5 | 0.4.31 | 35→35, 36→36, 35→35, 32→32, 17→17, 18→18, 32→32, 29→29, 32→32, 20→20 | 0/10 | 8 / 8 | 0 / 0 |
| anthropic/claude-sonnet-5 | 0.4.31 | 36→36 | 0/1 | 1 / 1 | 0 / 0 |

### AST

| Model | version | n | acc. A | acc. B | B − A (paired) | same calls | layer changed a call | saving (measured) |
|---|---|---|---|---|---|---|---|---|
| anthropic/claude-haiku-4-5 | 0.4.31 | 48 | 89.6 % [77.8 %, 95.5 %] | 89.6 % [77.8 %, 95.5 %] | 0.0 pp [0.0, 0.0] | 48/48 | 0 | 0.1 % [0.0 %, 0.2 %] |
| anthropic/claude-sonnet-5 | 0.4.31 | 48 | 91.7 % [80.4 %, 96.7 %] | 91.7 % [80.4 %, 96.7 %] | 0.0 pp [-6.3, 6.3] | 43/48 | 0 | 1.5 % [-1.6 %, 5.8 %] |

Not in the previous run (nothing to compare): anthropic/claude-haiku-4-5, anthropic/claude-sonnet-5.

## Spend

| Model | A | B | this run | earlier runs of this battery (pilot, aborted) | total | budget | calls A / B |
|---|---|---|---|---|---|---|---|
| anthropic/claude-haiku-4-5 | 0.4119 $ | 0.3997 $ | 0.8116 $ | 0.1125 $ | 0.9241 $ | 1.2500 $ | 118 / 116 |
| anthropic/claude-sonnet-5 | 0.2971 $ | 0.3021 $ | 0.5993 $ | 0.2704 $ | 0.8696 $ | 1.2500 $ | 59 / 59 |

The budget is enforced across every live run of this battery: before starting, the cost of every earlier live call (the cable log) is subtracted from the per-model cap.

## Limitations

- A stratified subsample, not the full BFCL categories; intervals are conditional on it.
- The AST checker is a TypeScript port of BFCL's Python checker (`ast.ts`, pinned by tests). On Anthropic both arms read `tool_use.input` through `JSON.parse`, so `5` and `5.0` are indistinguishable there (the int-vs-float check is slightly more lenient than BFCL's Python on that provider, equally for both arms).
- Multi-turn: only the first user turn and one synthetic tool round per entry; BFCL's state-based multi-turn scoring is not reproduced.
- Models are nondeterministic (sonnet-5 and gpt-5.4-mini reason and do not take temperature 0), so A≠B in *which* call was made is expected noise; a call the layer changed after the provider returned it is not, and is checked separately (`layer changed a call`).
- Costs use list prices from the SDK catalogue, not the invoice.

## Claude run: budget plan, pilot and what was found (hand-written, 2026-09-29)

The OpenAI run of this battery (`bfcl-0431.{json,md}`) could not measure Claude: the Anthropic key returned 401 on the free check. The key was renewed (200 on `GET /v1/models`) and this is the first live Claude measurement of the harness. Same seed (20260928), same dataset commit, same code path (`pnpm bench:bfcl`, arm B = source of tag v0.4.31 with `BVSALA_DEV_OPEN=1`, host guard on `fetch`).

**Why the sample is smaller than the OpenAI run (400 AST / 10 repeats / 10 multi-turn).** The cap is 1.25 $ per Claude model, A+B. A calibration pilot (1 per category, 1 repeat, 1 multi-turn; `bfcl-0431-claude-piloto.json`) measured, per A+B pair: AST ≈ 0.0037 $ (Haiku) / 0.009 $ (Sonnet 5); one multi-turn entry with 35 tools (12 calls, ~6.2k input tokens each on Haiku, ~7.9k on Sonnet 5) ≈ 0.095 $ / 0.227 $. The full OpenAI sample would cost ≈ 1.5 $ + 0.8 $ on Haiku and ≈ 3.6 $ + 1.9 $ on Sonnet 5. Following the instruction (reduce AST with the seed, prioritise multi-turn):

- **Haiku 4.5:** all 10 multi_turn_base entries (complete), all 10 repeats, AST reduced to 12/category (48, the first 12 rounds of the same seeded round-robin order as the 400).
- **Sonnet 5:** the multi-turn probe cannot be completed within the cap. The harness reserves the worst case of a whole multi-turn entry before starting it (12 calls × (input + `max_tokens` 4096 of output) ≈ 0.86 $ for a 35-tool entry on Sonnet 5), so after the pilot (0.27 $) only ONE more entry fits under the hard guard. It was spent on the next entry of the seeded order (`--multi-desde=1` → multi_turn_base_78), so Sonnet 5 has 2 distinct multi-turn entries in total: 157 (pilot) and 78 (this artifact). AST 12/category (48, same entries as Haiku) and 5 repeats.

**Real spend (provider `usage` × catalogue list price, both arms, all live calls of this battery including the pilot):** Haiku 4.5 **0.9241 $** (pilot 0.1125 + run 0.8116), Sonnet 5 **0.8696 $** (pilot 0.2704 + run 0.5993). 396 provider calls, all HTTP 200, no 429/529 retry. Hosts contacted: `api.anthropic.com` only (plus `raw.githubusercontent.com` for the dataset download, before the guard is installed); refused by the guard: none.

**Findings, with evidence in the JSON:**

1. **The layer changed no tool call (native `tool_use`).** `fiel` = true in 48/48 AST pairs per model (the calls B returned are exactly those in the raw Anthropic response B received), `layer changed a call` = 0, and the request B put on the wire is identical to arm A's (`diferenciasDelCable` empty in 96/96 AST and 11/11 multi-turn step 0). Haiku: same calls in A and B in 48/48, identical input tokens (40 612 / 40 612). Sonnet 5: same calls in 43/48; the 5 differences (`parallel_multiple_189`, `parallel_54`, `simple_python_162`, `parallel_92`, `simple_python_145`) are sampling noise — Sonnet 5 takes no temperature (`muestreo` = `{}`), `fiel` is true in all of them, and they cancel out (B wins 145, A wins 92; accuracy 44/48 in both arms).
2. **The whole catalogue reaches the provider in multi-turn (#382).** Tools on the wire A → B: 35→35, 36→36, 35→35, 32→32, 17→17, 18→18, 32→32, 29→29, 32→32, 20→20 (Haiku), 36→36 (Sonnet 5, entry 78) and 35→35 (both models, entry 157, pilot). Step 0 lands a call from BFCL's reference turn 1 in 8/10 entries in both arms (Haiku).
3. **Cache isolation holds (#368): 0 violations in 12 entries** (10 Haiku + 1 Sonnet 5 here + 157 on both in the pilot). V2 (`isError: true`) and V3 (changed argument) were always `miss`. On Haiku `multi_turn_base_183`, V4 and V5 were served `exact` with 0 provider calls, each with its own original's text (V4 = V1, V5 = V2), which is what the rule allows.
4. **The AST int/float caveat (`5` vs `5.0`) is real on this provider and equal for both arms.** Anthropic returns `tool_use.input` already parsed, and the cable log stores the parsed body too, so how many verdicts depend on it cannot be counted after the fact. None of the failed verdicts (Haiku 5 per arm, Sonnet 5 4 per arm) is of that kind: they are dataset ambiguity (`parallel_multiple_97` and `simple_python_145` expect a rate as a fraction, 0.04 / 0.05; the models sent 4 / 5 as a percentage), two Haiku replies asking for clarification instead of calling (`parallel_103`, `parallel_multiple_35`), and value choices (`multiple_91`, `parallel_54`, and `parallel_92` in Sonnet 5's arm B, which wrote "New York City, NY").
5. **No saving on this workload, measured.** Saving (1 − ΣB/ΣA, AST) is 0.1 % on Haiku and 1.5 % [−1.6 %, 5.8 %] on Sonnet 5 (noise); the layer's own claimed saving is 0 and its report basis is `measured` in every AST call. The AST repeats were all `miss` (a tool-call turn is not served from cache, by design). Worth noting for the product: neither arm wrote or read Anthropic prompt cache (0 cache_control marks in B, 0 cache tokens in both), although each multi-turn entry resends a 6–8k-token tool catalogue 12 times, above the 4 096-token cache minimum of Haiku 4.5. The layer, in its default configuration, does not add `cache_control` for these calls.

**Limitations specific to this run:** the AST sample is 48 per model, not 400 (Wilson intervals of ±9 pp); Sonnet 5 has only 2 multi-turn entries (one of them in the pilot artifact) and 5 repeats; the pilot's 4 AST entries are the same as the first round of this artifact's 48 and are not counted twice.
