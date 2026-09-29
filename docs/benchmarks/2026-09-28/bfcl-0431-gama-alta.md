# BFCL A/B — 2026-09-29 (LIVE)

- **Dataset:** Berkeley Function Calling Leaderboard, `ShishirPatil/gorilla@f7cf7359b7ac615a0b294831c5ba2bc95ee4a000` (Apache-2.0), fetched at run time and sha256-checked per file (`benchmarks/publicados/bfcl/datos.ts`); not vendored.
- **Arm A:** direct provider call with native tools (Anthropic Messages `tool_use` / OpenAI Chat Completions `tools`), hand-written, no layer. Gemini is spoken through Google's OWN OpenAI-compatible endpoint (`generativelanguage.googleapis.com/v1beta/openai`, same origin and same bill as the native API): the harness has no native Gemini dialect, and neither does the layer's 0.4.31 (`OpenAICompatibleProvider`). Arm A echoes back each tool call's `extra_content` (Gemini 3's `thought_signature`) as an integrator must; arm B receives it too, as an extra field on each tool call.
- **Arm B:** v0.4.31 (source of the tag, BVSALA_DEV_OPEN=1; npm = same commit, dist rebuilt from the tag byte-identical) — tag commit `00c99c8`, loaded from `git archive v0.4.31 src` (this tree differs from the tag in `src/version.ts`, so the tree was NOT measured); npm integrity `sha512-ePCN+dZr+VuMUSGm2…`, dist sha256 `b52f99cacf98…`. Default config: provider only (no licenseServerUrl, no service key, no exporters).
- **Hosts contacted during the run:** api.anthropic.com, api.openai.com, generativelanguage.googleapis.com; refused by the host guard: none.
- **Sample:** 100 per AST category requested (a model whose budget runs out stops at the tail of the round-robin order, so its sample stays stratified; its real `n` is in the tables) (simple, multiple, parallel, parallel_multiple), stratified, seed 20260928, round-robin order; 10 deliberate AST repeats; 10 multi_turn_base entries for the cache-isolation probe. Budget per model (A+B, hard cap in code): anthropic/claude-opus-5-5 1.2500 $, anthropic/claude-sonnet-5-5 1.2500 $, openai/gpt-5.5 1.2500 $, google/gemini-3.8-flash 1.2500 $, google/gemini-3.1-pro-preview 1.2500 $; enforced before every call.

## Not measured

- **openai/gpt-5.6-sol**: every call failed in BOTH arms before any tokens were billed (spend 0.0000 $): `HTTP 400: {"error":{"message":"Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.","type":"invalid_`. Not a finding about the layer.

## Prices not in the SDK catalogue

- **anthropic/claude-sonnet-5-5** has no row in `src/pricing/catalogo.ts` (not touched). Both arms are priced with the official list price, cited: https://platform.claude.com/docs/en/about-claude/pricing (consultada 2026-09-29): Claude Sonnet 5.5 $2 / $2.50 (5m write) / $4 (1h write) / $0.20 (cache hit) / $10 per MTok. The layer's OWN report for it uses its illustrative fallback price, so its modelled figures for this model are meaningless.

## Per model

Order of work per model: the multi-turn probe first (the priority), then AST up to the last entry that is repeated, then the repeats, then the rest of AST. A model that runs out of budget therefore loses AST from the tail.

| Model | n | AST acc. A | AST acc. B | B − A (paired) | same calls | layer changed a call | cost A | cost B | saving (measured, stratified) | spend (A+B, all parts) |
|---|---|---|---|---|---|---|---|---|---|---|
| anthropic/claude-opus-5-5 | 0 | — | — | — | 0/0 | 0 | 0.0000 $ | 0.0000 $ | — | 1.0239 $ (stopped by budget) |
| anthropic/claude-sonnet-5-5 | 0 | — | — | — | 0/0 | 0 | 0.0000 $ | 0.0000 $ | — | 1.1418 $ (stopped by budget) |
| openai/gpt-5.5 | 0 | — | — | — | 0/0 | 0 | 0.0000 $ | 0.0000 $ | — | 0.8960 $ (stopped by budget) |
| google/gemini-3.8-flash | 324 | 93.5 % [90.3 %, 95.7 %] | 93.2 % [89.9 %, 95.5 %] | -0.3 pp [-2.2, 1.5] | 306/324 | 0 | 0.4539 $ | 0.5021 $ | -10.7 % [-27.8 %, 3.2 %] | 1.2147 $ (stopped by budget) |
| google/gemini-3.1-pro-preview | 97 | 89.7 % [82.1 %, 94.3 %] | 91.8 % [84.6 %, 95.8 %] | 2.1 pp [-5.2, 9.3] | 78/97 | 0 | 0.5400 $ | 0.5149 $ | 4.8 % [-6.6 %, 15.6 %] | 1.1238 $ (stopped by budget) |

Accuracy: Wilson 95 % interval. B − A: paired bootstrap of per-entry correctness (seed fixed). Saving: 1 − ΣB/ΣA over AST pairs, bootstrap stratified by category, both arms priced from the provider's own `usage` with the SDK catalogue list prices (`cable.ts`). Spend includes AST, repeats and the multi-turn probe.

## Accuracy by category (correct A / correct B / n)

| Model | simple | multiple | parallel | parallel_multiple |
|---|---|---|---|---|
| anthropic/claude-opus-5-5 | — | — | — | — |
| anthropic/claude-sonnet-5-5 | — | — | — | — |
| openai/gpt-5.5 | — | — | — | — |
| google/gemini-3.8-flash | 75 / 76 / 82 | 76 / 76 / 81 | 77 / 75 / 81 | 75 / 75 / 80 |
| google/gemini-3.1-pro-preview | 23 / 24 / 24 | 25 / 25 / 25 | 20 / 21 / 25 | 19 / 19 / 23 |

## Cost, cache and what the layer claims

| Model | input tok A / B | cache read A / B | cache write A / B | output tok A / B | cache_control marks in B | layer's own claimed saving (modelled) | B report basis | B exact-cache results |
|---|---|---|---|---|---|---|---|---|
| anthropic/claude-opus-5-5 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 | 0.0000 $ | {} | {} |
| anthropic/claude-sonnet-5-5 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 | 0.0000 $ | {} | {} |
| openai/gpt-5.5 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 | 0.0000 $ | {} | {} |
| google/gemini-3.8-flash | 99375 / 99375 | 0 / 0 | 0 / 0 | 101157 / 114007 | 0 | 0.0000 $ | {"measured":324} | {"miss":324} |
| google/gemini-3.1-pro-preview | 30849 / 30849 | 0 / 0 | 0 / 0 | 39857 / 37769 | 0 | 0.0000 $ | {"measured":97} | {"miss":97} |

*Measured* = the two columns priced from each arm's provider `usage`. *Modelled* = Σ(`report.cost.baselineEstimate − report.cost.actual`) from the layer's own report; it is not a measurement and is shown only to compare with the measured delta.

## Deliberate repeats (AST, a tool-call turn must never be served from cache)

| Model | repeats | B cache result | B provider calls | cost A | cost B |
|---|---|---|---|---|---|
| anthropic/claude-opus-5-5 | 0 | {} | 0 | 0.0000 $ | 0.0000 $ |
| anthropic/claude-sonnet-5-5 | 0 | {} | 0 | 0.0000 $ | 0.0000 $ |
| openai/gpt-5.5 | 0 | {} | 0 | 0.0000 $ | 0.0000 $ |
| google/gemini-3.8-flash | 10 | {"miss":10} | 10 | 0.0073 $ | 0.0069 $ |
| google/gemini-3.1-pro-preview | 10 | {"miss":10} | 10 | 0.0327 $ | 0.0309 $ |

## Multi-turn cache isolation (#368, live)

Per entry: step 0 (first user turn, all the entry's tools) in both arms; then five continuations built from the SAME tool call: V1 result ok; V2 same content with `isError: true`; V3 one argument changed; V4 exact repeat of V1 (fresh call ids); V5 exact repeat of V2. V2 and V3 must never be served from cache; V4/V5 may, but only with their own original's answer. Tool results are synthetic (the bench does not execute BFCL's Python classes), so this is NOT BFCL's multi-turn accuracy metric.

- **anthropic/claude-opus-5-5 · multi_turn_base_157** (MathAPI+TravelAPI, 35 tools; on the wire A 35 / B 35) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-opus-5-5 · multi_turn_base_78** (TwitterAPI+VehicleControlAPI, 36 tools; on the wire A 36 / B 36) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-opus-5-5 · multi_turn_base_47** (GorillaFileSystem+MathAPI, 35 tools; on the wire A 35 / B 35) — presupuesto agotado antes de V4-repite-V1 (3 variantes hechas) — no violation
- **anthropic/claude-sonnet-5-5 · multi_turn_base_157** (MathAPI+TravelAPI, 35 tools; on the wire A 35 / B 35) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-sonnet-5-5 · multi_turn_base_78** (TwitterAPI+VehicleControlAPI, 36 tools; on the wire A 36 / B 36) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-sonnet-5-5 · multi_turn_base_47** (GorillaFileSystem+MathAPI, 35 tools; on the wire A 35 / B 35) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-sonnet-5-5 · multi_turn_base_183** (TwitterAPI+TravelAPI, 32 tools; on the wire A 32 / B 32) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: exact/0 calls · V5-repite-V2: exact/0 calls — no violation
- **anthropic/claude-sonnet-5-5 · multi_turn_base_9** (GorillaFileSystem, 17 tools; on the wire A 17 / B 17) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-sonnet-5-5 · multi_turn_base_37** (GorillaFileSystem, 18 tools; on the wire A 18 / B 18) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **anthropic/claude-sonnet-5-5 · multi_turn_base_62** (MessageAPI+VehicleControlAPI, 32 tools; on the wire A 32 / B 32) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.5 · multi_turn_base_157** (MathAPI+TravelAPI, 35 tools; on the wire A 35 / B 35) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.5 · multi_turn_base_78** (TwitterAPI+VehicleControlAPI, 36 tools; on the wire A 36 / B 36) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.5 · multi_turn_base_47** (GorillaFileSystem+MathAPI, 35 tools; on the wire A 35 / B 35) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: exact/0 calls · V5-repite-V2: exact/0 calls — no violation
- **openai/gpt-5.5 · multi_turn_base_183** (TwitterAPI+TravelAPI, 32 tools; on the wire A 32 / B 32) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: exact/0 calls · V5-repite-V2: exact/0 calls — no violation
- **openai/gpt-5.5 · multi_turn_base_9** (GorillaFileSystem, 17 tools; on the wire A 17 / B 17) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.5 · multi_turn_base_37** (GorillaFileSystem, 18 tools; on the wire A 18 / B 18) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.5 · multi_turn_base_62** (MessageAPI+VehicleControlAPI, 32 tools; on the wire A 32 / B 32) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.5 · multi_turn_base_133** (TradingBot+TicketAPI, 29 tools; on the wire A 29 / B 29) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.5 · multi_turn_base_95** (MessageAPI+VehicleControlAPI, 32 tools; on the wire A 32 / B 32) — V1-base: miss/1 call · V2-isError: miss/1 call · V3-args: miss/1 call · V4-repite-V1: miss/1 call · V5-repite-V2: miss/1 call — no violation
- **openai/gpt-5.5 · multi_turn_base_122** (TradingBot, 20 tools; on the wire A 20 / B 20) — presupuesto agotado antes de V4-repite-V1 (3 variantes hechas) — no violation
- **google/gemini-3.8-flash · multi_turn_base_157** (MathAPI+TravelAPI, 35 tools; on the wire A 35 / B 35) — V1-base: error/1 call · V2-isError: error/1 call · V3-args: error/1 call · V4-repite-V1: error/1 call · V5-repite-V2: error/1 call — no violation
- **google/gemini-3.8-flash · multi_turn_base_78** (TwitterAPI+VehicleControlAPI, 36 tools; on the wire A 36 / B 36) — V1-base: error/1 call · V2-isError: error/1 call · V3-args: error/1 call · V4-repite-V1: error/1 call · V5-repite-V2: error/1 call — no violation
- **google/gemini-3.8-flash · multi_turn_base_47** (GorillaFileSystem+MathAPI, 35 tools; on the wire A 35 / B 35) — V1-base: error/1 call · V2-isError: error/1 call · V3-args: error/1 call · V4-repite-V1: error/1 call · V5-repite-V2: error/1 call — no violation
- **google/gemini-3.8-flash · multi_turn_base_183** (TwitterAPI+TravelAPI, 32 tools; on the wire A 32 / B 32) — V1-base: error/1 call · V2-isError: error/1 call · V3-args: error/1 call · V4-repite-V1: error/1 call · V5-repite-V2: error/1 call — no violation
- **google/gemini-3.8-flash · multi_turn_base_9** (GorillaFileSystem, 17 tools; on the wire A 17 / B 17) — V1-base: error/1 call · V2-isError: error/1 call · V3-args: error/1 call · V4-repite-V1: error/1 call · V5-repite-V2: error/1 call — no violation
- **google/gemini-3.8-flash · multi_turn_base_37** (GorillaFileSystem, 18 tools; on the wire A 18 / B 18) — V1-base: error/1 call · V2-isError: error/1 call · V3-args: error/1 call · V4-repite-V1: error/1 call · V5-repite-V2: error/1 call — no violation
- **google/gemini-3.8-flash · multi_turn_base_62** (MessageAPI+VehicleControlAPI, 32 tools; on the wire A 32 / B 32) — V1-base: error/1 call · V2-isError: error/1 call · V3-args: error/1 call · V4-repite-V1: error/1 call · V5-repite-V2: error/1 call — no violation
- **google/gemini-3.8-flash · multi_turn_base_133** (TradingBot+TicketAPI, 29 tools; on the wire A 29 / B 29) — V1-base: error/1 call · V2-isError: error/1 call · V3-args: error/1 call · V4-repite-V1: error/1 call · V5-repite-V2: error/1 call — no violation
- **google/gemini-3.8-flash · multi_turn_base_95** (MessageAPI+VehicleControlAPI, 32 tools; on the wire A 32 / B 32) — V1-base: error/1 call · V2-isError: error/1 call · V3-args: error/1 call · V4-repite-V1: error/1 call · V5-repite-V2: error/1 call — no violation
- **google/gemini-3.8-flash · multi_turn_base_122** (TradingBot, 20 tools; on the wire A 20 / B 20) — V1-base: error/1 call · V2-isError: error/1 call · V3-args: error/1 call · V4-repite-V1: error/1 call · V5-repite-V2: error/1 call — no violation
- **google/gemini-3.1-pro-preview · multi_turn_base_157** (MathAPI+TravelAPI, 35 tools; on the wire A 35 / B 35) — ningún brazo llamó a una herramienta en el paso 0: no hay turno de herramienta que variar — no violation
- **google/gemini-3.1-pro-preview · multi_turn_base_78** (TwitterAPI+VehicleControlAPI, 36 tools; on the wire A 36 / B 36) — ningún brazo llamó a una herramienta en el paso 0: no hay turno de herramienta que variar — no violation
- **google/gemini-3.1-pro-preview · multi_turn_base_47** (GorillaFileSystem+MathAPI, 35 tools; on the wire A 35 / B 35) — ningún brazo llamó a una herramienta en el paso 0: no hay turno de herramienta que variar — no violation
- **google/gemini-3.1-pro-preview · multi_turn_base_183** (TwitterAPI+TravelAPI, 32 tools; on the wire A 32 / B 32) — ningún brazo llamó a una herramienta en el paso 0: no hay turno de herramienta que variar — no violation
- **google/gemini-3.1-pro-preview · multi_turn_base_9** (GorillaFileSystem, 17 tools; on the wire A 17 / B 17) — ningún brazo llamó a una herramienta en el paso 0: no hay turno de herramienta que variar — no violation
- **google/gemini-3.1-pro-preview · multi_turn_base_37** (GorillaFileSystem, 18 tools; on the wire A 18 / B 18) — ningún brazo llamó a una herramienta en el paso 0: no hay turno de herramienta que variar — no violation
- **google/gemini-3.1-pro-preview · multi_turn_base_62** (MessageAPI+VehicleControlAPI, 32 tools; on the wire A 32 / B 32) — ningún brazo llamó a una herramienta en el paso 0: no hay turno de herramienta que variar — no violation
- **google/gemini-3.1-pro-preview · multi_turn_base_133** (TradingBot+TicketAPI, 29 tools; on the wire A 29 / B 29) — ningún brazo llamó a una herramienta en el paso 0: no hay turno de herramienta que variar — no violation
- **google/gemini-3.1-pro-preview · multi_turn_base_95** (MessageAPI+VehicleControlAPI, 32 tools; on the wire A 32 / B 32) — ningún brazo llamó a una herramienta en el paso 0: no hay turno de herramienta que variar — no violation
- **google/gemini-3.1-pro-preview · multi_turn_base_122** (TradingBot, 20 tools; on the wire A 20 / B 20) — ningún brazo llamó a una herramienta en el paso 0: no hay turno de herramienta que variar — no violation

| Model | entries | step 0: a call in BFCL's reference turn 1, A / B | step 0: no tool call at all, A / B | tools on the wire (A → B) |
|---|---|---|---|---|
| anthropic/claude-opus-5-5 | 3 | 3 / 3 | 0 / 0 | 35→35, 36→36, 35→35 |
| anthropic/claude-sonnet-5-5 | 7 | 5 / 5 | 0 / 0 | 35→35, 36→36, 35→35, 32→32, 17→17, 18→18, 32→32 |
| openai/gpt-5.5 | 10 | 8 / 8 | 0 / 0 | 35→35, 36→36, 35→35, 32→32, 17→17, 18→18, 32→32, 29→29, 32→32, 20→20 |
| google/gemini-3.8-flash | 10 | 7 / 8 | 0 / 0 | 35→35, 36→36, 35→35, 32→32, 17→17, 18→18, 32→32, 29→29, 32→32, 20→20 |
| google/gemini-3.1-pro-preview | 10 | 0 / 0 | 10 / 10 | 35→35, 36→36, 35→35, 32→32, 17→17, 18→18, 32→32, 29→29, 32→32, 20→20 |

## Findings about the layer (A≠B)

- openai/gpt-5.5: multi-turn continuation body differs from arm A in `messages[]` in 44/48 continuations (e.g. `multi_turn_base_157 V1-base → messages[2]: A={"content":"{\"status\":\"ok\",\"function\":\"list_all_airports\",\"result\":\"done\"}","role":"tool","tool_call_id":"call_bfcl_v1_0"} B={"content":"{\"status\":\"ok\",\"function\":\"list_all_airports\",\"result\":\"done\"}","name":"list_all_airports","ro`).
- **google/gemini-3.8-flash: in 50/50 multi-turn continuations arm B failed and arm A did not** (e.g. multi_turn_base_157 V1-base: `Error: provider 400: [{ "error": { "code": 400, "message": "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call `default_api:list_all_air`).
- google/gemini-3.8-flash: multi-turn continuation body differs from arm A in `messages[]` in 50/50 continuations (e.g. `multi_turn_base_157 V1-base → messages[1]: A={"content":null,"role":"assistant","tool_calls":[{"extra_content":{"google":{"thought_signature":"ErwCCrkCAWkUfRPT0YCGRR5+1q75PcWv56GCCGG2NYiG9LvtiGSCpkIYdGX... B={"content":null,"role":"assistant","tool_calls":[{"function":{"arguments":"{}","name":"list_`).
- google/gemini-3.1-pro-preview: harness error — `TimeoutError: The operation was aborted due to timeout`

## Warnings the layer printed

- `[bv-sala] no cost model configured for "anthropic/claude-sonnet-5-5"; falling back to the ILLUSTRATIVE default price. Dollar figures will not match your bill. Pass { costModels: { "anthropic/claude-sonnet-5-5": { inputPer1k, outputPer1k } } }.`

## Operator notes (with evidence)

- **Budget (1.25 $ per model, A+B) vs. protocol.** The multi-turn probe runs first, as instructed. On Anthropic neither arm caches (0 `cache_control` marks from the layer, 0 cache reads), and every step carries the entry's 17–36 tools (~7.5k input tokens per call): Opus 5.5 spent 1.0239 $ on 32 calls (3 entries, the third stopped before V4) and Sonnet 5.5 1.1418 $ on 82 calls (7 entries). gpt-5.5 finished the 10 entries for 0.8960 $ (the 10th stopped before V4) and the next AST unit's worst case (≤ 4096 output) no longer fit. So **these three models have NO AST and NO repeats** in this battery: nothing is cut silently, the budget stopped them.
- **gemini-3.1-pro-preview: multi-turn not measured.** Every step 0 of the 10 entries got HTTP 429 in BOTH arms after the harness's 6 backoff retries (`You exceeded your current quota … Quota exceeded for metr…`, https://ai.google.dev/gemini-api/docs/rate-limits); 429s are not billed (0 $). The key is shared with other batteries running in parallel. AST then ran and the budget stopped it at 97 pairs (24/25/25/23 per category, round-robin, seed 20260928), plus the 10 repeats. With 0.126 $ left, one multi-turn step's worst case (≈ 0.2 $) no longer fits, so it was not retried.
- **gpt-5.6-sol: not measurable with this protocol (0 $).** OpenAI rejects function tools on Chat Completions for the whole gpt-5.6 family unless `reasoning_effort` is `none`: `400 Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.` — in 840/840 calls, both arms. A free probe (400s are not billed) gave the same for gpt-5.6-terra and gpt-5.6-luna. Arm A could send `reasoning_effort: "none"`, but the layer's 0.4.31 `OpenAICompatibleProvider` has no way to send it (no `reasoning_effort`/extra-body option in `src/`) and only speaks `/chat/completions`, so the pair cannot be formed. **Consequence for the product:** a customer on gpt-5.6-* with tools cannot go through 0.4.31 at all.
- **FINDING (A≠B), gemini-3.8-flash: the layer drops Gemini 3's `thought_signature`, so every tool-result turn fails.** In 50/50 continuations arm B got `400 Function call is missing a thought_signature in functionCall parts` while arm A, sending the same history, got 200. Evidence on the wire (multi_turn_base_157 V1): A `tool_calls[0]` = `{id, type, function:{name:"list_all_airports",arguments:"{}"}, extra_content:{google:{thought_signature:…}}}` → 200; B = the same without `extra_content` → 400. The harness handed the layer the signature as an extra field on each tool call; neither 0.4.31 nor current main mentions `thought_signature`/`extra_content` anywhere in `src/` (git grep), and `SavingsResult.toolCalls` does not return it either, so an integrator cannot even pass it back. Any multi-turn tool conversation with Gemini 3 through the layer breaks at the second turn. The cache-isolation checks (#368) could not be exercised on Gemini for that reason (B never reached the model).
- **Gemini cost accounting.** Gemini's OpenAI-compatible endpoint leaves thinking out of `completion_tokens` (probe: prompt 46 + completion 16, total 105); the harness prices `total − prompt` as output. On gemini-3.8-flash AST, output is ≈ 50 % of all tokens (A 101k in / 103k out), and the largest single output was 10,175 tokens — above the 4096 the per-call worst case assumes; the per-model cap still held (1.2147 $ ≤ 1.25 $).
- **Anthropic multi-turn, no provider cache from the layer.** 0 `cache_control` marks in 56 B calls and 0 cache reads/writes, although each entry repeats a ≥ 7.5k-token tools prefix six times (above Anthropic's minimum cacheable prefix). B was cheaper on Sonnet 5.5 (0.5555 $ vs 0.5863 $) only because V4/V5 of multi_turn_base_183 were served from the layer's exact cache (2 provider calls avoided), which is allowed (they repeat V1/V2 and got their own originals' answers). No cache-isolation violation in any model.
- **Spend outside the battery ledger:** free `GET /v1/models` listings (Anthropic, OpenAI, Gemini), one Gemini flash probe (2 calls, ≈ 0.0003 $, for the usage/signature behaviour above) and one gpt-5.5 probe (1 call, 124 tokens, ≈ 0.0009 $). The gpt-5.6-* probes were 400s (not billed).

## Spend

| Model | A | B | this run | earlier runs of this battery (pilot, aborted) | total | budget | calls A / B | max output tokens in one call |
|---|---|---|---|---|---|---|---|---|
| anthropic/claude-opus-5-5 | 0.5109 $ | 0.5130 $ | 1.0239 $ | 0.0000 $ | 1.0239 $ | 1.2500 $ | 16 / 16 | 331 |
| anthropic/claude-sonnet-5-5 | 0.5863 $ | 0.5555 $ | 1.1418 $ | 0.0000 $ | 1.1418 $ | 1.2500 $ | 42 / 40 | 359 |
| openai/gpt-5.5 | 0.4802 $ | 0.4158 $ | 0.8960 $ | 0.0000 $ | 0.8960 $ | 1.2500 $ | 58 / 54 | 287 |
| google/gemini-3.8-flash | 0.6715 $ | 0.5432 $ | 1.2147 $ | 0.0000 $ | 1.2147 $ | 1.2500 $ | 394 / 344 | 10175 |
| google/gemini-3.1-pro-preview | 0.5726 $ | 0.5512 $ | 1.1238 $ | 0.0000 $ | 1.1238 $ | 1.2500 $ | 107 / 108 | 2019 |

The budget is enforced across every live run of this battery: before starting, the cost of every earlier live call (the cable log) is subtracted from the per-model cap.

## Limitations

- A stratified subsample, not the full BFCL categories; intervals are conditional on it.
- The AST checker is a TypeScript port of BFCL's Python checker (`ast.ts`, pinned by tests). On Anthropic both arms read `tool_use.input` through `JSON.parse`, so `5` and `5.0` are indistinguishable there (the int-vs-float check is slightly more lenient than BFCL's Python on that provider, equally for both arms).
- Multi-turn: only the first user turn and one synthetic tool round per entry; BFCL's state-based multi-turn scoring is not reproduced.
- Models are nondeterministic (reasoning models get no temperature/seed from either arm), so A≠B in *which* call was made is expected noise; a call the layer changed after the provider returned it is not, and is checked separately (`layer changed a call`).
- Costs use list prices (SDK catalogue, or the official page cited above), not the invoice.
- The per-call worst case reserved before sending assumes ≤ 4096 output tokens. Anthropic enforces it (`max_tokens` 4096 in both arms); OpenAI and Gemini get no output cap from either arm (the layer's adapter sends none), so there it is an estimate, not a bound — the largest output actually seen per call is in the spend table.
- Gemini's OpenAI-compatible endpoint leaves thinking tokens OUT of `completion_tokens` but counts them in `total_tokens`; Google bills them as output, so the harness prices `total − prompt` as output (`cable.ts`). The layer's own report reads `completion_tokens` only, so its modelled cost for Gemini understates the bill.

