# BFCL A/B — 2026-09-28 (LIVE)

- **Dataset:** Berkeley Function Calling Leaderboard, `ShishirPatil/gorilla@f7cf7359b7ac615a0b294831c5ba2bc95ee4a000` (Apache-2.0), fetched at run time and sha256-checked per file (`benchmarks/publicados/bfcl/datos.ts`); not vendored.
- **Arm A:** direct provider call with native tools (Anthropic Messages `tool_use` / OpenAI Chat Completions `tools`), hand-written, no layer.
- **Arm B:** v0.4.30 (source of the tag, BVSALA_DEV_OPEN=1; npm = same commit, verified identical) — tag commit `946f5d5`, `git diff v0.4.30 -- src/ packages/` empty; npm integrity `sha512-73eFHgLeCQnJlCzkD…`, dist sha256 `12c709712ee5…`. Default config: provider only (no licenseServerUrl, no service key, no exporters).
- **Hosts contacted during the run:** api.anthropic.com, api.openai.com; refused by the host guard: none.
- **Sample:** 100 per AST category (simple, multiple, parallel, parallel_multiple), stratified, seed 20260928, round-robin order; 10 deliberate AST repeats; 10 multi_turn_base entries for the cache-isolation probe. Budget 1.25 $ per model (A+B), enforced before every call.

## Not measured

- **anthropic/claude-haiku-4-5**: every call failed in BOTH arms before any tokens were billed (spend 0.0000 $): `HTTP 401: {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}`. Not a finding about the layer.
- **anthropic/claude-sonnet-5**: every call failed in BOTH arms before any tokens were billed (spend 0.0000 $): `HTTP 401: {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}`. Not a finding about the layer.

## Per model

| Model | n | AST acc. A | AST acc. B | B − A (paired) | same calls | layer changed a call | cost A | cost B | saving (measured, stratified) | spend (A+B, all parts) |
|---|---|---|---|---|---|---|---|---|---|---|
| openai/gpt-4o-mini | 400 | 89.5 % [86.1 %, 92.1 %] | 90.0 % [86.7 %, 92.6 %] | 0.5 pp [0.0, 1.3] | 398/400 | 0 | 0.0279 $ | 0.0279 $ | 0.1 % [0.0 %, 0.2 %] | 0.0767 $ |
| openai/gpt-5.4-mini | 400 | 88.0 % [84.4 %, 90.8 %] | 88.5 % [85.0 %, 91.3 %] | 0.5 pp [-1.8, 2.8] | 356/400 | 0 | 0.2074 $ | 0.2069 $ | 0.3 % [-0.5 %, 1.1 %] | 0.5170 $ |

Accuracy: Wilson 95 % interval. B − A: paired bootstrap of per-entry correctness (seed fixed). Saving: 1 − ΣB/ΣA over AST pairs, bootstrap stratified by category, both arms priced from the provider's own `usage` with the SDK catalogue list prices (`cable.ts`). Spend includes AST, repeats and the multi-turn probe.

## Accuracy by category (correct A / correct B / n)

| Model | simple | multiple | parallel | parallel_multiple |
|---|---|---|---|---|
| openai/gpt-4o-mini | 93 / 95 / 100 | 87 / 87 / 100 | 93 / 93 / 100 | 85 / 85 / 100 |
| openai/gpt-5.4-mini | 86 / 91 / 100 | 91 / 90 / 100 | 92 / 92 / 100 | 83 / 81 / 100 |

## Cost, cache and what the layer claims

| Model | input tok A / B | cache read A / B | cache write A / B | output tok A / B | cache_control marks in B | layer's own claimed saving (modelled) | B report basis | B exact-cache results |
|---|---|---|---|---|---|---|---|---|
| openai/gpt-4o-mini | 89956 / 89956 | 0 / 0 | 0 / 0 | 23975 / 23939 | 0 | 0.0000 $ | {"measured":400} | {"miss":400} |
| openai/gpt-5.4-mini | 122356 / 122356 | 0 / 0 | 0 / 0 | 25706 / 25580 | 0 | 0.0000 $ | {"measured":400} | {"miss":400} |

*Measured* = the two columns priced from each arm's provider `usage`. *Modelled* = Σ(`report.cost.baselineEstimate − report.cost.actual`) from the layer's own report; it is not a measurement and is shown only to compare with the measured delta.

## Deliberate repeats (AST, a tool-call turn must never be served from cache)

| Model | repeats | B cache result | B provider calls | cost A | cost B |
|---|---|---|---|---|---|
| openai/gpt-4o-mini | 10 | {"miss":10} | 10 | 0.0004 $ | 0.0004 $ |
| openai/gpt-5.4-mini | 10 | {"miss":10} | 10 | 0.0030 $ | 0.0030 $ |

## Multi-turn cache isolation (#368, live)

Per entry: step 0 (first user turn, all the entry's tools) in both arms; then five continuations built from the SAME tool call: V1 result ok; V2 same content with `isError: true`; V3 one argument changed; V4 exact repeat of V1 (fresh call ids); V5 exact repeat of V2. V2 and V3 must never be served from cache; V4/V5 may, but only with their own original's answer. Tool results are synthetic (the bench does not execute BFCL's Python classes), so this is NOT BFCL's multi-turn accuracy metric.

- **openai/gpt-4o-mini · multi_turn_base_157** (MathAPI+TravelAPI, 35 tools; on the wire A 35 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-4o-mini · multi_turn_base_78** (TwitterAPI+VehicleControlAPI, 36 tools; on the wire A 36 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-4o-mini · multi_turn_base_47** (GorillaFileSystem+MathAPI, 35 tools; on the wire A 35 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: exact/0 calls · V5-repite-V2: exact/0 calls — no violation
- **openai/gpt-4o-mini · multi_turn_base_183** (TwitterAPI+TravelAPI, 32 tools; on the wire A 32 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: exact/0 calls · V5-repite-V2: exact/0 calls — no violation
- **openai/gpt-4o-mini · multi_turn_base_9** (GorillaFileSystem, 17 tools; on the wire A 17 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: exact/0 calls · V5-repite-V2: exact/0 calls — no violation
- **openai/gpt-4o-mini · multi_turn_base_37** (GorillaFileSystem, 18 tools; on the wire A 18 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-4o-mini · multi_turn_base_62** (MessageAPI+VehicleControlAPI, 32 tools; on the wire A 32 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-4o-mini · multi_turn_base_133** (TradingBot+TicketAPI, 29 tools; on the wire A 29 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-4o-mini · multi_turn_base_95** (MessageAPI+VehicleControlAPI, 32 tools; on the wire A 32 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-4o-mini · multi_turn_base_122** (TradingBot, 20 tools; on the wire A 20 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.4-mini · multi_turn_base_157** (MathAPI+TravelAPI, 35 tools; on the wire A 35 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.4-mini · multi_turn_base_78** (TwitterAPI+VehicleControlAPI, 36 tools; on the wire A 36 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.4-mini · multi_turn_base_47** (GorillaFileSystem+MathAPI, 35 tools; on the wire A 35 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: exact/0 calls — no violation
- **openai/gpt-5.4-mini · multi_turn_base_183** (TwitterAPI+TravelAPI, 32 tools; on the wire A 32 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: exact/0 calls · V5-repite-V2: exact/0 calls — no violation
- **openai/gpt-5.4-mini · multi_turn_base_9** (GorillaFileSystem, 17 tools; on the wire A 17 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: exact/0 calls — no violation
- **openai/gpt-5.4-mini · multi_turn_base_37** (GorillaFileSystem, 18 tools; on the wire A 18 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.4-mini · multi_turn_base_62** (MessageAPI+VehicleControlAPI, 32 tools; on the wire A 32 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.4-mini · multi_turn_base_133** (TradingBot+TicketAPI, 29 tools; on the wire A 29 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.4-mini · multi_turn_base_95** (MessageAPI+VehicleControlAPI, 32 tools; on the wire A 32 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.4-mini · multi_turn_base_122** (TradingBot, 20 tools; on the wire A 20 / B 8) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation

| Model | entries | step 0: a call in BFCL's reference turn 1, A / B | step 0: no tool call at all, A / B | tools on the wire (A → B) |
|---|---|---|---|---|
| openai/gpt-4o-mini | 10 | 8 / 1 | 0 / 5 | 35→8, 36→8, 35→8, 32→8, 17→8, 18→8, 32→8, 29→8, 32→8, 20→8 |
| openai/gpt-5.4-mini | 10 | 6 / 2 | 0 / 5 | 35→8, 36→8, 35→8, 32→8, 17→8, 18→8, 32→8, 29→8, 32→8, 20→8 |

## Findings about the layer (A≠B)

- **openai/gpt-4o-mini: in 10/10 multi-turn entries the layer sent only 8 of the caller's tools** (catalogue without `intents`/`risk` → `ToolSelector.passthrough` capped at `maxTools=8`, the first 8 in declaration order). Step 0 hit a function of BFCL's reference first turn in 8/10 entries without the layer and 1/10 with it; with the layer the model made no tool call at all in 5/10. The layer printed NO warning for it on this provider (the console warning only fires where native tool search exists); the only trace is `report.traces` (`tool-selector`).
- **openai/gpt-5.4-mini: in 10/10 multi-turn entries the layer sent only 8 of the caller's tools** (catalogue without `intents`/`risk` → `ToolSelector.passthrough` capped at `maxTools=8`, the first 8 in declaration order). Step 0 hit a function of BFCL's reference first turn in 6/10 entries without the layer and 2/10 with it; with the layer the model made no tool call at all in 5/10. The layer printed NO warning for it on this provider (the console warning only fires where native tool search exists); the only trace is `report.traces` (`tool-selector`).

## Spend

| Model | A | B | this run | earlier runs of this battery (pilot, aborted) | total | budget | calls A / B |
|---|---|---|---|---|---|---|---|
| openai/gpt-4o-mini | 0.0419 $ | 0.0349 $ | 0.0767 $ | 0.0240 $ | 0.1008 $ | 1.25 $ | 470 / 464 |
| openai/gpt-5.4-mini | 0.2558 $ | 0.2612 $ | 0.5170 $ | 0.0176 $ | 0.5346 $ | 1.25 $ | 470 / 466 |

The budget is enforced across every live run of this battery: before starting, the cost of every earlier live call (the cable log) is subtracted from the per-model cap.

## Limitations

- A stratified subsample, not the full BFCL categories; intervals are conditional on it.
- The AST checker is a TypeScript port of BFCL's Python checker (`ast.ts`, pinned by tests). On Anthropic both arms read `tool_use.input` through `JSON.parse`, so `5` and `5.0` are indistinguishable there (the int-vs-float check is slightly more lenient than BFCL's Python on that provider, equally for both arms).
- Multi-turn: only the first user turn and one synthetic tool round per entry; BFCL's state-based multi-turn scoring is not reproduced.
- Models are nondeterministic (sonnet-5 and gpt-5.4-mini reason and do not take temperature 0), so A≠B in *which* call was made is expected noise; a call the layer changed after the provider returned it is not, and is checked separately (`layer changed a call`).
- Costs use list prices from the SDK catalogue, not the invoice.

