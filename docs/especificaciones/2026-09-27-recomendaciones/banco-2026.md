# Spec: unit «banco-2026» (recommendations 3 and 4): arm B2 «natively well-configured», asShipped by default, 2026 models, independent measurement kit

Branch `feat/banco-2026-brazo-nativo`. Worktree `/Users/fisagol/bsl-banco-2026`. It did not exist when I designed this, and as the read-only designer I did not create it. Everything was read from `origin/main` at `f157462`, plus the report at `origin/docs/bitacora-2026-09-26:docs/COMPETENCIA-2026-09-26.md` (§1, §3, §4, §8 and §9).

## 0. Summary

The unit touches no file under `src/` and does not change the package's public surface. Everything lives in `benchmarks/`, tests, docs and three static files served by the web. This keeps superficie-publica-limpia, dx-empaquetado, parity, tarifa-en-parametros and referencia-es-suelo green by construction. It also avoids collisions with the units for rec. 1 (`feat/catalogo-2026`), rec. 8 (adapters) and rec. 9 (native price levers), which do touch `src/`.

What gets delivered:

1. **Arm B2 «natively well-configured».** It runs alongside B0, B1 and B, and the artifact publishes the CI floor against B0, B1 and B2 plus the minimum of the three.
2. **asShipped is the default.** The bench compressor now needs an explicit `BVSALA_AB_CON_COMPRESOR=1`. The guard refuses any artifact without `sdk.asShipped: true`, MOCK included.
3. **Parameterised 2026 models** (`BVSALA_AB_PRESET=2026`), direct endpoints per family, a mandatory budget in LIVE with a running cap, and a paid probe that costs cents.
4. **Dry tests** (fake `fetch` plus a MOCK subprocess with a clean environment) and the exact commands for the owner.
5. **Independent measurement kit.** `docs/MEDICION-INDEPENDIENTE.md` is in English and published on the web, together with `reproduce.mjs`, a zero-dependency script. Prototyped: it recomputes **bit for bit** the B0 and B1 floors of the currently published artifact from its public CSV.

---

## 1. Findings that shape the design

All verified on 2026-09-27. Sources are in §11.

| # | Finding | Consequence |
|---|---|---|
| H1 | Claude Sonnet 5 rejects any non-default `temperature` (400). The gpt-5 family only accepts the default (the repo already says so in `src/pricing/razonamiento.ts`). The bench sends `temperature: 0, seed: 7` in every arm (`MUESTREO_PAREADO`, and `runScenario` hard-codes `?? 0` / `?? 7`). | Without a per-model sampling policy, a 2026 run fails on its first call. B2 cannot be measured without fixing this first. |
| H2 | On GPT-5.6+ and GPT-6, Chat Completions defaults to `prompt_cache_options.mode = "implicit"`. It writes the cache at **1.25×** with a minimum of 1,024 tokens. `mode: "explicit"` with no `prompt_cache_breakpoint` means *«the request does not use prompt caching»*. Usage reports `prompt_tokens_details.cache_write_tokens`. | This is the report's «remainder» in §3: well-configured B2 = explicit mode, with a breakpoint only on a prefix that actually repeats. The `OpenAICompatibleProvider` adapter **does not read** `cache_write_tokens`, and the bench's `cost()` **ignores the write premium** for every provider, Anthropic included (it bills `cache_creation` at 1×). Without fixing the cost, B2's advantage is invisible. |
| H3 | gpt-6-luna: default effort `medium`. Accepts `none/low/medium/high/xhigh/max`. Chat Completions supported. | B2 uses `reasoning_effort: "low"`, which is at or below the default. |
| H4 | Anthropic effort (`output_config.effort`) is GA for Sonnet 5 among others, but **not for Haiku 4.5**. The Sonnet 5 guide puts `low` «for high-volume or latency-sensitive workloads… chat and non-coding». | B2 effort `low` for Claude only where the docs support it. That is why the preset picks Sonnet 5 and not Haiku. |
| H5 | Anthropic tool search is recommended only with **10 or more tools or more than 10k tokens of definitions**. It is not metered separately. `defer_loading` cannot coexist with `cache_control`. | No scenario reaches the threshold (the big catalogue has 8 tools). B2 declares it «not applicable» with the rule and its source. The branch is implemented and dry-tested for future scenarios. |
| H6 | Anthropic threshold compaction: minimum trigger **50,000** input tokens, default 150,000. When it fires, top-level `usage` excludes the `usage.iterations` entries. | The scenarios are single-turn and far below that. B2 **does not send it** (a parameter that can never fire only adds risk) and declares why. The same applies to context editing: there are no earlier tool results to clear. |
| H7 | OpenAI Chat Completions has no tool search and no compaction (both are Responses API features; neither appears in openai-node's chat types). | B2 declares both «not available on the bench's transport». |
| H8 | Gemini 3.x Flash: implicit caching is on by default, with a 4,096-token minimum. Explicit caching needs `generateContent` (outside the OpenAI-compatible transport). `reasoning_effort` maps to `thinking_level`, and reasoning cannot be turned off on Gemini 3. | B2 on Gemini = `reasoning_effort: "low"`, with implicit caching declared as already active in every arm. |
| H9 | Gateway ids, all present on `https://ai-gateway.vercel.sh/v1/models`: `openai/gpt-6-luna`, `anthropic/claude-sonnet-5`, `google/gemini-3.8-flash`, `openai/gpt-oss-120b`. | These are the preset ids. |
| H10 | On `main` the catalogue has `claude-sonnet-5` and `gemini-3.7-flash`, but **not** `gpt-6-luna` or `gemini-3.8-flash`. `primaDeEscritura` only covers `gpt-5.6`. | The preset depends on rec. 1 being merged. Until then, the preflight refuses to spend (§3.4). No price is duplicated in the bench. |
| H11 | The repo is **private**. The LICENSE is fail-closed with a key (§2) and contains no clause against publishing benchmarks. The SDK already exposes `verification` / `onCheck`, a public A/B on the customer's own traffic. | The kit offers three paths: (1) recompute the published figures, which is public and free; (2) measure on your own traffic with the npm package; (3) rerun our bench with access to the source on request (§9). |
| H12 | Prototype run: a 20-line standalone mulberry32 plus stratified bootstrap recomputes `aggregate.savings` and `aggregateB1.savings` of `apps/web/public/data/ab-live.json` **identically** from `ab-live-trials.csv` (point, lower and upper). | `reproduce.mjs` is viable and can be a permanent gate. |
| H13 | Side note for rec. 1, outside this unit: the official Gemini page says «Context Caching (read): Not available» for `gemini-3.5-flash-lite`, while the catalogue has `cachedInputPer1k: 0.00003`. | Pass it to the rec. 1 unit. |

---

## 2. Decisions and why

**D1. B2 is B1 plus the provider's documented free settings for *this* request shape. It is not «everything switched on».**
«Realistic» means what a diligent integrator would do after reading the documentation. Every feature has an applicability rule with an official source, and the artifact publishes each decision (`native.decisions`). If a feature does not apply (tool search under 10 tools, compaction under 50k), B2 does not send it and says why. Sending inert features would add risk (beta headers, 400s) without measuring anything. A critic can check each rule against its source.

**D2. B2 contents on today's scenario set:**
- OpenAI GPT-5.6+/6: `prompt_cache_options: {mode:"explicit"}`, plus `prompt_cache_breakpoint:{mode:"explicit"}` on the last message of the stable prefix *only* when B1 would mark it (same rule `mensajesDePrefijoRazonable`: never on cold-salted scenarios), plus `reasoning_effort` on reasoning models.
- Anthropic, native transport: B1's cache (explicit breakpoint at the end of the stable prefix, because the docs recommend explicit over automatic for unique tails), plus `output_config.effort` on models in the official list.
- Gemini: `reasoning_effort`.
- In every case `prompt_cache_key` stays as in B1, because B2 is a superset of B1.

**D3. B2 effort defaults to `low`,** overridable with `BVSALA_AB_B2_EFFORT` (`none|minimal|low|medium|default`). `low` exists on all three families, is at or below every default (gpt-6-luna `medium`, Sonnet 5 `high`), and the official Sonnet 5 guidance lists it for non-coding work. It is **not free in quality**, so B2 publishes contract validity, truncations and reasoning tokens per arm, as A already does. If B2 gets cheaper by answering worse, its savings count against us, which is the conservative direction. `default` gives a B2 without that trade-off, for anyone who wants it.

**D4. The B2 wire changes happen in a bench-only `fetch` rewriter,** after the adapter has built the body. `ProviderRequest` has no fields for effort, tool search or cache mode, and adding them would change the public API. Rewriting at the wire keeps the contract encoding the same across arms, because every arm goes through the same adapter.

**D5. Cost honest against the invoice.** Every arm pays for cache writes at the model's premium (`primaDeEscritura` from `src/pricing/primas.ts`). Writes are read from `usage.cacheWriteInputTokens` (Anthropic adapter) or from the raw response (`raw.usage.prompt_tokens_details.cache_write_tokens`, OpenAI chat). If a premium model's responses do not report the counter, the artifact says `pricing.cacheWrites.metered: false` and cannot be published. If `usage.iterations` appears with a `compaction` entry, the call fails with an explicit error: no arm sends compaction, so its presence means an unexpected configuration.

**D6. Per-model sampling policy.** `muestreoPareadoPara(model)` sends `temperature: 0, seed: 7` only when `salidaNoRepetible(model) === undefined`. Otherwise it sends nothing, and all arms get the provider default. The pairing stays honest because every arm gets the same.

**D7. The headline is not replaced, it is completed.** `aggregate` (vs B0) stays as it is, for compatibility with the web. New additions:
- `aggregateB2`, `ledgersB2`, `reconciliationB2`.
- `aggregateNativeVsB0`: what the provider alone saves (B2 against B0), not a BV-SALA figure.
- `floors`: the three floors and the minimum.

The hero gate (`cifra-del-heroe`) now requires fitting under **min(B0, B1, B2)** when B2 is present. It already did this with B0 and B1: «promising only against the most favourable baseline was choosing the comparison that shows the most savings».

**D8. The adaptive sampler stops on the *widest* comparison.** It uses max(half-width vs B0, vs B1, vs B2). The published claim is the minimum floor, so its precision must not depend on the stopping rule. The estimate still uses `MAX_REPS`, so the ceiling does not change.

**D9. Direct endpoints per family, optional.** `BVSALA_DEMO_OPENAI_BASE_URL/_API_KEY` and `BVSALA_DEMO_GOOGLE_BASE_URL/_API_KEY`, alongside the existing Anthropic ones. The gateway remains the fallback. Two reasons: a third party will have provider keys, not ours; and the gateway may not forward `prompt_cache_options` or return `cache_write_tokens`, which the probe checks. The model id always goes to a direct endpoint without the `provider/` prefix.

**D10. Budget is mandatory in LIVE, and capped while running.** The estimate's ceiling is not a ceiling for scenarios without `maxOutputTokens`, where reasoning is unbounded. The run keeps an accumulated spend. If it passes the budget, it cuts off, marks the model as failed (`budget`) and writes nothing publishable for it.

**D11. The probe pays cents to avoid wasting dollars.** `pnpm ab:sonda` checks per model: credentials and model id; that the adapter's body is accepted (`max_tokens`, sampling); which counters come back (`cached_tokens`, `cache_write_tokens`); and whether `prompt_cache_options` actually reaches the provider (implicit gives writes > 0, explicit without a breakpoint gives 0). The bench's credentials currently return «invalid model ID» (bitácora 26‑09).

**D12. Reasoning margin, declared by the owner, never invented.** The scenario caps (232, 220, 500, 600) were tuned for gpt-4o-mini. On reasoning models the provider counts hidden reasoning inside the same cap, so truncations are to be expected. `BVSALA_AB_MARGEN_RAZONAMIENTO=<tokens>` adds the same margin to every arm on reasoning models only. It defaults to 0, and the owner sets it after the calibration run. The artifact records it.

**D13. The kit is public and has no dependencies; recomputation is bit-exact.** `reproduce.mjs` lives in `apps/web/public/measure/` and is served at `/measure/reproduce.mjs` (the middleware excludes paths with a dot). The canonical doc is `docs/MEDICION-INDEPENDIENTE.md`, with a byte-identical copy served at `/measure/independent-measurement.md`, enforced by a test. File names on the web are in English because they are public.

**D14. Explicitly out of scope** (owner decision or other unit):
- Scenarios that trigger tool search (10+ tools) or compaction (50k+ tokens per call). They change the headline's strata and cost more.
- The OpenAI adapter sending `max_completion_tokens` (product change; the probe detects it).
- Showing B2 on web surfaces beyond the gate.
- An own-traffic recompute tool (path 2 already has the dashboard and its CSV).

---

## 3. Public API and surfaces (in English)

### 3.1 Environment variables (bench)

| Variable | Default | Effect |
|---|---|---|
| `BVSALA_AB_PRESET` | — | `2026` (or `2026+optional`). Incompatible with `BVSALA_DEMO_MODEL(S)`: if both are set, abort. |
| `BVSALA_AB_B2` | on | `0` disables B2 (research run; cannot be published). |
| `BVSALA_AB_B2_EFFORT` | `low` | `none\|minimal\|low\|medium\|default`. Validated per model in the preflight. |
| `BVSALA_AB_CON_COMPRESOR` | off | `1` injects the bench compressor → `sdk.asShipped:false`, cannot be published. |
| `BVSALA_AB_SIN_COMPRESOR` | — | Deprecated. `1` prints «already the default»; any other value aborts with the new instruction. |
| `BVSALA_AB_BUDGET_USD` | — | **Mandatory in LIVE** (and in the probe). |
| `BVSALA_AB_MARGEN_RAZONAMIENTO` | 0 | Tokens added to the cap in every arm on reasoning models. |
| `BVSALA_AB_PERMITIR_PRECIO_ILUSTRATIVO` | off | `1` allows running (never publishing) a model without a catalogue row. |
| `BVSALA_AB_OUT_DIR` | `benchmarks/out` | Output directory (tests). |
| `BVSALA_DEMO_OPENAI_BASE_URL` / `_API_KEY` | — | Direct endpoint for the openai family. |
| `BVSALA_DEMO_GOOGLE_BASE_URL` / `_API_KEY` | — | Direct endpoint for the google family (OpenAI-compatible, `…/v1beta/openai`). |

Mode: LIVE if *any* endpoint is declared (gateway or per family). In LIVE, a model with no endpoint for its family makes the preflight abort.

### 3.2 New and changed artifact fields (`ab-live*.json`, public, English strings)

```jsonc
{
  "arms": { "A": "...", "A1": "...", "A2": "B2 · natively well-configured: B1 plus every setting the provider documents at no extra charge that applies to this request shape — reasoning effort where the model accepts it, explicit cache mode on GPT-5.6+ (breakpoint only on a prefix that repeats, no cache writes otherwise), tool search when the request carries 10+ tools or 10k+ schema tokens (Anthropic), compaction/context editing only where the conversation can reach their triggers. Each decision and its source is in `native.decisions`.", "B": "..." },
  "native": {
    "effort": "low", "transport": "openai-compatible", "simulated": false, "degradedByTransport": false,
    "decisions": [ { "feature": "reasoningEffort|promptCacheMode|promptCacheBreakpoint|anthropicCacheBreakpoint|toolSearch|compaction|contextEditing|implicitCache", "applied": true, "value": "low", "reason": "...", "source": { "url": "...", "checked": "2026-09-27" } } ],
    "honored": { "promptCacheMode": true }          // null if not observable
  },
  "scenarios": [ { "armA2": { "meanInputTokens": 0, "meanOutputTokens": 0, "meanCost": 0 },
                   "measuredB2": { "inputTokenDeltaMean": 0, "outputTokenDeltaMean": 0, "savings": {}, "wilcoxonP": 0 },
                   "native": { "applied": ["reasoningEffort"], "skipped": [ { "feature": "toolSearch", "reason": "..." } ] },
                   "nativeContractValid": { "valid": 0, "total": 0 },
                   "cacheWrites": { "naive": 0, "razonable": 0, "nativo": 0, "optimizado": 0 },
                   "reasoningTokens": { "naive": 0, "razonable": 0, "nativo": 0, "optimizado": 0 },
                   "truncated": { "naive": 0, "razonable": 0, "nativo": 0, "optimizado": 0 },
                   "cacheDePrefijo": { "naive": 0, "razonable": 0, "nativo": 0, "optimizado": 0 } } ],
  "aggregateB2": { "savings": {}, "estimator": "stratified-by-scenario", "wilcoxonP": 0, "qualityPassRate": 1, "proven": true, "headline": "verified ≥ …% beyond a natively well-configured integration (95% CI lower bound)" },
  "ledgersB2": [], "reconciliationB2": {},
  "aggregateNativeVsB0": { "savings": {}, "estimator": "stratified-by-scenario", "note": "What the provider's own settings (arm B2) save against the naive request (B0). Not a BV-SALA figure." },
  "floors": { "vsB0": 0, "vsB1": 0, "vsB2": 0, "min": 0, "minAgainst": "B2", "note": "95% CI lower bounds of the same stratified estimator against each control arm. Any claim must fit under `min`." },
  "sampling": { "temperature": null, "seed": null, "reason": "model rejects a non-default temperature: every arm uses the provider default" },
  "transport": { "kind": "openai-compatible|anthropic-native|mock", "endpointHost": "api.openai.com" },
  "cost": { "ceilingUsd": 0, "spentUsd": 0, "budgetUsd": 0, "note": "spentUsd = every provider call of this run, all arms, probe and amortization; the judge is excluded and says so" },
  "scenarioSet": { "size": 11, "names": ["..."] },
  "pricing": { "table": { "<catalogue key>": {} }, "catalogueDated": "...", "listPriceKnown": true,
               "cacheWrites": { "premium": 1.25, "metered": true, "source": "adapter|raw-usage|none" } },
  "config": { "resamples": 10000, "b2": true, "b2Effort": "low", "reasoningHeadroomTokens": 0 }
}
```

- `pricing.table` stays because the web reads it (`dashboard/verify/page.tsx` looks up `table["gpt-4o-mini"]`). It is now filled from the **catalogue** (`precioDeLista`) with the measured model's row. The bench's local `PRICES` table is **removed**: it duplicated the catalogue and must not become a second source.
- CSV `ab-live-trials*.csv`: adds `costA2` and `savedFractionB2` columns, keeping the existing ones.
- `ab-live-por-modelo.json`: each `comparison[]` entry adds `aggregateB2`, `aggregateNativeVsB0`, `floors`, `cost` and `native`. The console table adds «AGREGADO vs B2» and «B2 vs B0 (native)» rows.

### 3.3 CLIs

- `pnpm ab:publish [--model <id>] [--dry-run] [--allow-mock]`. `--model` publishes `out/ab-live--<slug>.json` together with its `ab-live-trials--<slug>.csv` from a multi-model run, so you never pay twice. The slug comes from `babosaDeModelo` in `publish-guard.ts`. Its `model` must equal the one requested.
- `pnpm ab:sonda`: probe (§D11). Requires a budget, prints its ceiling first, writes `out/sonda.json`, never prints keys or URLs with credentials.
- `node apps/web/public/measure/reproduce.mjs [--artifact <path|url>] [--trials <path|url>] [--json]`. Defaults to `https://savings.bivelio.com/data/ab-live.json` and `/data/ab-live-trials.csv`. Exit codes: 0 all recomputations match; 1 at least one mismatch; 2 input error. English output.

### 3.4 Publication guard (`decidePublish`, stays dependency-free)

New blockers:
1. `sdk.asShipped !== true` → blocked **also in MOCK** (it used to apply only to LIVE). The message now suggests `pnpm ab` (the default) and mentions `BVSALA_AB_CON_COMPRESOR` only as the research path.
2. LIVE without a numeric `aggregateB2.savings` CI → «without B2 there is no comparison against what the provider gives for free».
3. `pricing.listPriceKnown === false`.
4. `pricing.cacheWrites.premium > 1 && metered !== true`.
5. `native.degradedByTransport === true`, or `native.honored.promptCacheMode === false`.
6. `transport.endpointHost` missing in LIVE, or loopback/private (`localhost`, `127.*`, `10.*`, `192.168.*`, `172.16–31.*`, `::1`). Our site publishes provider measurements only.
7. `cost.aborted` present.
8. `scenarioSet.size !== scenarios.length + scenariosNotApplicable.length`, so a red row cannot be dropped in silence.
9. `floors.min !== min(vsB0, vsB1?, vsB2)`, or any floor that does not match its `aggregate*`.

New warning: `floors.min < 0.05` → «report §8 rec. 3: if the floor against B2 is below 5%, rewrite the message towards the accounting». The threshold and its source are the report's.

---

## 4. Changes by file

The base is the worktree. Internal code and comments are in Spanish; whatever the customer sees is in English.

### 4.1 `benchmarks/scenarios.ts`
- New `export function muestreoPareadoPara(model: string): Partial<typeof MUESTREO_PAREADO>`: returns `MUESTREO_PAREADO` if `salidaNoRepetible(model) === undefined` (import from `../src/pricing/razonamiento.js`), otherwise `{}`.
- `conMuestreoPareado(req)` keeps its signature but uses `muestreoPareadoPara(req.model)`.
- `TransporteDelBanco`: add `"anthropic-nativo"`, which already exists, and keep `"openai-compatible"` for direct OpenAI and Google endpoints. The endpoint goes into a separate structure (§4.4).

### 4.2 `benchmarks/brazos.ts`
- `construirBrazoNaive` uses `...muestreoPareadoPara(model)` instead of `...MUESTREO_PAREADO`, and applies `margenRazonamiento` (new optional parameter) to `maxOutputTokens` when `esModeloDeRazonamiento(model)`.
- `construirBrazoRazonable` inherits both.
- New `export function construirBrazoNativo(req, model, opts: OpcionesB1 & { busquedaDeHerramientas?: boolean; margenRazonamiento?: number }): ProviderRequest`:
  - Equals `construirBrazoRazonable`.
  - Except when `busquedaDeHerramientas` is set: then it sends **all** tools (as B0), and the rewriter will defer them all except those in `toolsB1`, because a team using tool search does not hand-pick.
- `DEFINICION_DE_BRAZOS.A2` holds the English text from §3.2.

### 4.3 `benchmarks/nativo.ts` (new, pure, no env)
- Types: `FuncionNativa`, `EsfuerzoB2`, `FuenteOficial {url, consultado}`, `DecisionNativa`, `PlanNativo { modelo, transporte, simulado, degradadoPorTransporte, decisiones, cable: { openai?: {reasoningEffort?, promptCacheMode?: "explicit", breakpointEnMensaje?: number}, anthropic?: {effort?, busqueda?: {noDiferidas: string[]}} } }`.
- `planNativo({ modelo, transporte, peticion: ProviderRequest, esfuerzo, numHerramientas, tokensDeEsquemas })`. Rules, each carrying its `FuenteOficial` constant (URL plus 2026-09-27):
  - `promptCacheMode/Breakpoint`: bare id matches `/^gpt-(5\.(6|[7-9])|[6-9])(\.|-|$)/` and the transport is `openai-compatible`. Breakpoint on message `stablePrefixMessages - 1` if `> 0`.
  - `reasoningEffort` (openai-compatible): `esModeloDeRazonamiento(modelo)`. Value validated per family: OpenAI rejects `minimal` on gpt-6-luna; Gemini accepts `minimal|low|medium|high`.
  - `effort` (anthropic-nativo): a local `EFFORT_ANTHROPIC` set copied from the doc's `supportedModels`, with an explicit prefix match. `claude-haiku-4-5` and `claude-sonnet-4-5` → declared unsupported.
  - `toolSearch` (anthropic-nativo only): `numHerramientas >= 10 || tokensDeEsquemas > 10000`. On openai-compatible → declared «Responses API only».
  - `compaction` and `contextEditing`: always `applied:false` for these scenarios, with their reasons (minimum trigger of 50,000 input tokens; no earlier tool results in history).
  - `implicitCache` (google): declared active in every arm.
  - Claude model over `openai-compatible` → `degradedByTransport: true`.
  - MOCK → the plan for the transport it *would* use (`anthropic-nativo` if the family is anthropic, else `openai-compatible`), with `simulado:true`.
- `reescribirCuerpo(plan, url, cuerpo)`, pure:
  - OpenAI (`/chat/completions`): set `reasoning_effort`, set `prompt_cache_options = {mode:"explicit"}`, and turn the breakpoint message's `content` string into `[{type:"text", text, prompt_cache_breakpoint:{mode:"explicit"}}]`. The text is unchanged.
  - Anthropic (`/messages`): `output_config = {...output_config, effort}`. For tool search, prepend `{type:"tool_search_tool_bm25_20251119", name:"tool_search_tool_bm25"}` and add `defer_loading:true` to every tool that is not in `noDiferidas`, is not `bvsala_contract`, and is not the search tool; also remove `cache_control` from deferred tools.
  - It never removes messages or touches text, `temperature`, `max_tokens` or `tools` outside those cases.
- `conAjustesNativos(plan, base: typeof fetch): typeof fetch`: parses the JSON body, applies `reescribirCuerpo`, reserialises, and delegates.

### 4.4 `benchmarks/transporte.ts`
- `ConfigDeTransporte` gains `openaiBaseUrl?, openaiApiKey?, googleBaseUrl?, googleApiKey?`.
- New `endpointDeModelo(model, cfg) → { transporte, baseUrl, apiKey, quitarPrefijo, host } | null`:
  - Precedence: native anthropic → direct per family → gateway → `null`.
  - `mock` if there are no endpoints at all.
  - `host` is the URL's hostname only.
- `proveedorDelBanco` uses it, always stripping the prefix on direct endpoints.
- New `proveedorDelBrazoNativo(model, cfg, planPara: (req) => PlanNativo): Provider`: its `generate(req)` computes the plan, builds `proveedorDelBanco(model, {...cfg, fetchImpl: conAjustesNativos(plan, cfg.fetchImpl ?? fetchConPlazo())})` and calls it. It is wrapped in `conReintentos`. **The `fetchImpl` must always wrap `fetchConPlazo`**, never replace it.

### 4.5 `benchmarks/coste.ts` (new, pure)
- `usoCrudo(raw): { escrituraCache: number; escrituraInformada: boolean; razonamiento?: number; iteracionesDeCompactacion: boolean }`. It reads `raw.usage.prompt_tokens_details.cache_write_tokens` (OpenAI chat), `raw.usage.cache_creation_input_tokens` (Anthropic) and `raw.usage.iterations[].type === "compaction"`.
- `costeDeLlamada(precio: CostModel, prima: number, uso: {inputTokens, outputTokens, cachedInputTokens?}, escrituras: number)` = (input − cached − writes)·in + cached·cachedIn + writes·in·prima + out·out.
  - Assumption to document in a comment: writes are part of `prompt_tokens` / `inputTokens`. For Anthropic this is certain, because the adapter adds `cache_creation` into `inputTokens`. For OpenAI it is inferred from «unadjusted number of prompt tokens written to cache»; the probe confirms it (`cache_write_tokens ≤ prompt_tokens`).
- `precioYPrima(model) → { precio, conocido: boolean, prima }` using `precioDeLista` plus `primaDeEscritura` (import from `../src/pricing/primas.js`) and a `FALLBACK` flagged as illustrative.

### 4.6 `benchmarks/modelos.ts` (new)
- `PRESETS`:

```ts
export const PRESETS = {
  "2026": {
    modelos: [
      // Fuente: https://developers.openai.com/api/docs/models/gpt-6-luna (consultado 2026-09-27)
      { id: "openai/gpt-6-luna", familia: "openai" },
      // Fuente: https://platform.claude.com/docs/en/build-with-claude/effort (consultado 2026-09-27)
      { id: "anthropic/claude-sonnet-5", familia: "anthropic", exigeNativo: true },
      // Fuente: https://ai.google.dev/gemini-api/docs/pricing (act. 2026-09-24, consultado 2026-09-27)
      { id: "google/gemini-3.8-flash", familia: "google" },
    ],
    opcionales: [
      { id: "anthropic/claude-haiku-4-5", motivo: "sin `effort` (no figura en supportedModels): su B2 queda en B1 + caché" },
      { id: "openai/gpt-oss-120b", motivo: "pesos abiertos servidos por la pasarela (id en https://ai-gateway.vercel.sh/v1/models, 2026-09-27); sin fila de catálogo no se publica" },
    ],
  },
} as const;
```

- `resolverModelos(env)`: preset / `DEMO_MODELS` / `DEMO_MODEL`, mutually exclusive.
- `veredictoDePrevuelo({ modelos, modo, cfg, presupuesto, esfuerzo, permitirIlustrativo }) → { aborta: boolean; motivos: string[]; avisos: string[] }`. It aborts in LIVE when:
  - there is no budget;
  - a model has no endpoint;
  - a model has no catalogue row (unless `permitirIlustrativo`);
  - a `gpt-5.6+/6` model has `primaDeEscritura !== 1.25` («missing the GPT-5.6+/GPT-6 premium, which is rec. 1»);
  - the effort is invalid for the model;
  - an `exigeNativo` model has no native endpoint.
  - It warns about reasoning models with margin 0 and about scenarios without a cap («the estimate is not a ceiling here»).

### 4.7 `benchmarks/sonda-del-banco.ts` (new) plus the `ab:sonda` script
For each resolved model, using the same `endpointDeModelo`:
- (a) A minimal B0-shaped request (short prompt, `maxOutputTokens` of 16) → HTTP status, provider error message (never headers), served model, and which usage fields are present.
- (b) Only for `gpt-5.6+/6`: two requests with `politicaEstable` as a system message, one implicit (B0) and one explicit without a breakpoint (the B2 rewriter), with a different salt each. Result: `promptCacheModeHonored = writes(implicit) > 0 && writes(explicit) === 0`.

It prints its ceiling before spending and requires `BVSALA_AB_BUDGET_USD`. It writes `out/sonda.json` in English.

### 4.8 `benchmarks/ab-live.ts`
- Environment block:
  - `CON_COMPRESOR`, `SDK_TAL_COMO_SE_INSTALA = !CON_COMPRESOR`, handling of the deprecated `SIN_COMPRESOR`.
  - `B2_ACTIVO`, `ESFUERZO_B2`, `MARGEN_RAZONAMIENTO`.
  - The config with per-family endpoints; `mode` per §3.1.
  - `modelosAMedir` via `resolverModelos`.
- Remove `PRICES`. `priceFor` / `precioConocido` → `coste.ts`. `cost()` → `costeDeLlamada` with that call's writes.
- `runScenario`:
  - `req` uses `...muestreoPareadoPara(model)` instead of `?? 0 / ?? 7`.
  - Arm A2 goes between A1 and B, with its own salt `${t}-b2`, via `proveedorDelBrazoNativo` created once per scenario.
  - Contract validity for B2, truncations, writes and reasoning read with `usoCrudo(resp.raw)` for A/A1/A2. For B, the spy accumulates `usoCrudo` from every layer call in that rep.
  - `paired` adds `costA2`.
  - `ciHalf` = max over the active comparisons.
  - Running spend: every call (probe, arms, amortization) adds to `gastado`. If `gastado > presupuesto`, throw `PresupuestoAgotado`.
- `medirModelo`:
  - `aggB2`, `ledgerRollupB2` and `reconciliationB2` (same partition), `aggNativoVsB0` (stratified A2 vs A), `floors`, `native` (the model's plan plus `honored`: true if every cold scenario had B2 writes = 0 and B0 writes > 0, false if B2 wrote with explicit mode and no breakpoint, otherwise null).
  - `sampling`, `transport`, `cost`, `scenarioSet` (all scenarios before the per-model split), `pricing.cacheWrites`, `config.*`.
  - A new English entry in `honesty` for B2 and another for the cost with writes.
  - The console gains the «vs B2 (95% lo)» and «B2 vs B0» columns and a «B2 nativo» block listing decisions (✓ applied / – not applicable, with reason and URL).
- `estimarEscenario`: add 1 call per rep if B2 is on, apply the margin to the output, and mark scenarios without a cap as `sinTope`.
- `main`:
  - Run `veredictoDePrevuelo` before estimating.
  - Budget is mandatory in LIVE.
  - Catch `PresupuestoAgotado` → `modelsFailed[{modelo, error:"budget"}]`, skip the remaining models, exit 1.
  - The multi-model table and CSV get the B2 columns.
- Any other env reading stays confined to this file, as today.

### 4.9 `benchmarks/report.ts`
`outDir = process.env.BVSALA_AB_OUT_DIR ?? join(here, "out")`.

### 4.10 `benchmarks/publish-guard.ts` and `benchmarks/publish.ts`
- Guard: the rules in §3.4, plus `export function babosaDeModelo(m)`, moved from `ab-live.ts` (which imports it from here). No imports, so `sello-de-procedencia.test.ts` keeps copying only two files.
- `publish.ts`: `--model`, with a message that points to `--model` when `ab-live.json` does not exist.

### 4.11 Documentation and other files
- `benchmarks/README.md`: new sections «Arm B2 — natively well-configured» (with the decisions table), «asShipped is the default», «2026 preset, direct endpoints and budget», «Probe before you pay (`pnpm ab:sonda`)», «Publishing one model from a multi-model run», «Independent measurement». Update the publishing section that cites `BVSALA_AB_SIN_COMPRESOR=1`.
- `benchmarks/titular-como-se-instala.ts`: comment only (the variable's name changes).
- `scripts/luz-verde.sh`:
  - Floor = min(B0, B1, B2 if present).
  - Messages «re-measure with `pnpm ab` (asShipped is the default)».
  - New check: `node apps/web/public/measure/reproduce.mjs --json --artifact apps/web/public/data/ab-live.json --trials apps/web/public/data/ab-live-trials.csv` → `ok` if it matches, `mal` if not.
- `package.json` scripts:
  - `"ab:sonda": "BVSALA_DEV_OPEN=1 tsx --env-file-if-exists=.env.bench benchmarks/sonda-del-banco.ts"`
  - `"medicion:reproducir": "node apps/web/public/measure/reproduce.mjs"`
  - Do not bump `version`.
- `apps/web/messages/cifra-del-heroe.test.ts`: read `aggregateB2.savings.lower` if present and use `Math.min(b0, b1 ?? b0, b2 ?? b1 ?? b0)`. Nothing else changes on the web.
- `apps/web/public/measure/reproduce.mjs` (new, §7.2), `apps/web/public/measure/independent-measurement.md` (byte-identical copy of the doc) and `docs/MEDICION-INDEPENDIENTE.md` (new, §7.1).
- **Not touched:** `src/**`, `gateway/**`, `LICENSE`, the root `README.md`, `apps/web/messages/*.json`, `apps/web/public/vendor/bv-sala.js`, `.env.bench.example` (its update is an owner step, per rule 0c).

---

## 5. Dependencies

None added. `reproduce.mjs` uses only Node built-ins and global `fetch`. The tests use `node:child_process` and `vitest`, which are already present. `pnpm-lock.yaml` does not change.

---

## 6. Tests (all dry: no network, no keys)

Every spawned test builds its `env` **by hand** (`PATH`, `HOME`, `BVSALA_DEV_OPEN=1`, plus whatever it needs) **without inheriting `BVSALA_*`**, and asserts `mode === "MOCK"`. A dry test must never be able to turn into a paid run because of a variable in the shell.

1. **`test/brazo-nativo-b2.test.ts`** (new)
   - `construirBrazoNativo` ⊇ B1: same messages, schema, cap, sampling and cache marks. With `busquedaDeHerramientas`, all tools.
   - `planNativo`, one case each: gpt-6-luna (effort low, explicit mode, breakpoint only with a stable prefix, tool search / compaction declared «Responses API only»); gpt-4o-mini (no adjustments, «B2 = B1» declared); claude-sonnet-5 over native (effort low; tool search not applied with 8 tools; compaction not applied under 50,000); claude-haiku-4-5 (effort unsupported); claude-sonnet-5 over the gateway (`degradedByTransport`); gemini-3.8-flash (effort low; implicit caching declared); invalid effort per family → error.
   - Every decision carries `source.url` and `checked === "2026-09-27"`.
   - Wire with a spy `fetch` (the `transporte-del-banco.test.ts` pattern), comparing B0 and B2 bodies:
     - OpenAI, `Stable-prefix agent turn` against gpt-6-luna: the B2 body carries `prompt_cache_options.mode:"explicit"`, `reasoning_effort:"low"` and a breakpoint on message 0 only; B0 carries none of that.
     - A salted scenario: explicit mode with **no** breakpoint.
     - Neither arm sends `temperature` / `seed` to gpt-6-luna.
     - Anthropic native, `Anthropic stable-prefix` against sonnet-5: `output_config.effort:"low"`, `cache_control` identical to B1, no `temperature`.
     - A synthetic request with 12 tools: search tool present, `defer_loading` on all except `toolsB1` and `bvsala_contract`, no `cache_control` on deferred tools.
   - Invariant: `reescribirCuerpo` never changes any message's text or the length of `messages`.
2. **`test/banco-coste-con-escrituras.test.ts`** (new): `costeDeLlamada` with the premium; `usoCrudo` over OpenAI chat and Anthropic bodies; `escrituraInformada:false` when the field is missing; a `compaction` iteration → an error in the call site that uses it.
3. **`test/banco-muestreo-por-modelo.test.ts`** (new): `muestreoPareadoPara` gives gpt-4o-mini / claude-sonnet-4-5 / claude-haiku-4-5 → `{0,7}`, and claude-sonnet-5 / gpt-6-luna / gemini-3.8-flash / an unclassified id → `{}`.
   - Update the text guard in `test/banco-regresion-estructurado.test.ts`: `construirBrazoNaive` contains `muestreoPareadoPara(`, and `runScenario` does not contain `?? 0` for temperature.
4. **`test/banco-modelos-2026.test.ts`** (new): `resolverModelos` (preset, conflict with `DEMO_MODELS`); `veredictoDePrevuelo`, one case per abort reason in §4.6, using a fake catalogue injected as a parameter (the function takes `precioYPrima` by injection so it does not depend on whether rec. 1 has landed); `endpointDeModelo` precedence; `mode` LIVE with a family endpoint only.
5. **`test/publish-guard.test.ts`** (update): the `live()` fixture gets `aggregateB2`, `floors`, `transport`, `cost`, `scenarioSet`, `pricing.listPriceKnown` and `pricing.cacheWrites`. One case per new blocker. The MOCK case «without a seal» now **blocks**, replacing the current test at line 146. The warning for a floor under 5%. `babosaDeModelo`.
6. **`test/sello-de-procedencia.test.ts`** (update): new fixture; case `--model openai/gpt-6-luna`, which reads `ab-live--openai-gpt-6-luna.json` and its CSV; case `--model` with a mismatched `model` → rejected.
7. **`test/banco-seco-extremo-a-extremo.test.ts`** (new, timeout of about 90 s):
   - Spawn `npx tsx benchmarks/ab-live.ts` with `BVSALA_AB_OUT_DIR=<tmp>`, `BVSALA_AB_REPS=2`, `BVSALA_AB_MAX_REPS=2`.
   - Assert `mode:"MOCK"`, `sdk.asShipped:true` with no environment variable, `arms.A2`, `aggregateB2`, `aggregateNativeVsB0`, `floors.min === min(...)`, `native.simulated:true`, the `costA2` column, `scenarioSet.size === scenarios + notApplicable`, and `decidePublish(null, art, {allowMock:true})` passing only the MOCK warning.
   - Then `reproduce.mjs --json` on that output → exit 0, all three comparisons `match`.
   - Text guard for `CON_COMPRESOR` (`asShipped` depends only on `BVSALA_AB_CON_COMPRESOR`).
8. **`test/medicion-independiente.test.ts`** (new):
   - (a) `node reproduce.mjs --json` on the **published** artifact and CSV → B0 and B1 `match` bit for bit, plus the `asShipped` warning (today's artifact has no seal). This is permanent: whatever gets published must be recomputable with the public script.
   - (b) Importing the `.mjs` with a **variable** specifier (so TS does not resolve it): its `bootstrapEstratificado` equals `benchmarks/stats.ts:bootstrapRatioCIEstratificado` bit for bit on 50 random synthetic sets.
   - (c) Red rows detected on a synthetic artifact.
   - (d) Exit codes 0/1/2.
   - (e) `docs/MEDICION-INDEPENDIENTE.md` and `apps/web/public/measure/independent-measurement.md` are identical.
   - (f) **No figures:** the doc does not match `/\d+(?:[.,]\d+)?\s*%/`, `/[$€]\s*\d/` or `/\d+\s*(?:USD|EUR)\b/`.
9. **`apps/web/messages/cifra-del-heroe.test.ts`** (update, §4.11).

---

## 7. Documentation

### 7.1 `docs/MEDICION-INDEPENDIENTE.md` (English, public, **no numeric figures**)

Every figure is referenced by the name of its field in the published artifact, never written out.

1. **What BiVelio claims and how.** Four arms (B0 naive, B1 reasonably optimized, B2 natively well-configured, B = BV-SALA) on the same scenarios, model and provider. Cost from the provider's own usage counters at the list prices of the SDK catalogue (`pricing.catalogueDated`), cache writes included at their premium. Headline = 95% CI **lower** bound of a stratified bootstrap. Any claim must fit under `floors.min`.
   - What it does not cover: single-turn scenarios; an interval conditional on this set (`honesty`); B2 is only as strong as the settings that apply to these request shapes (`native.decisions`).
2. **Three ways to check us:**
   - (1) Recompute the published figures: no key, no cost.
   - (2) Measure the published npm package on your own traffic: the SDK's `verification` option (`sampleRate`, `onCheck`), as the public JSDoc says: one extra provider call per sampled request, informational, never billed. The dashboard's «Verify» page documents the method and exports the CSV.
   - (3) Rerun BiVelio's bench at the commit sealed in the artifact (`commit`, `sdk.version`). The harness source is shared on request, through the support contact already public in the README, with anyone who agrees to publish every row. **The owner confirms this sentence** (§10).
3. **What to install** for each path: Node with global `fetch` (1); the npm package, a license key (LICENSE §1–2) and a provider key (2); a repo checkout at `commit`, `pnpm install --frozen-lockfile` and provider keys (3). Path 3 runs from source, where the dev-open mode is honoured (`src/pipeline/config.ts`); the published package does not honour it.
4. **Variables** for path 3: the table in §3.1 plus `BVSALA_DEMO_BASE_URL`, `BVSALA_DEMO_API_KEY`, `BVSALA_DEMO_KEEP_PREFIX`, `BVSALA_DEMO_ANTHROPIC_BASE_URL`, `BVSALA_DEMO_ANTHROPIC_API_KEY`, `BVSALA_JUDGE_*`. Keep them in a gitignored file, never inline.
5. **What it costs:** the run prints a per-model ceiling before its first paid call and aborts if it exceeds `BVSALA_AB_BUDGET_USD`; it also stops if actual spend passes it. What the published run cost is in `cost.spentUsd`. Path 2 costs about `sampleRate` times the unoptimized cost of the eligible traffic, as the SDK documents.
6. **Reading the ledgers and the basis:**
   - Ledgers (`avoided_calls`, `eliminated_tokens`, `compressed_tokens`, `provider_cached`, `output_restriction`, `output_codebook`, `none`) partition the total, so `reconciliation*.reconciled` must be true.
   - `levers.notExercised` (asked for, did not fire) is not the same as `levers.notMeasurable` (the transport cannot carry it) or `scenariosNotApplicable`.
   - The bench is an A/B instrument and **never** a billing basis. Commission only applies to `measured` / `reference` records of your own traffic (LICENSE §6); `estimated`, `shadow` and `unmeasured` never carry commission.
   - Checklist: `sdk.asShipped`, `sdk.version` against `npm view @bivelio/savings-layer version`, `modelStable`, `pricing.listPriceKnown`, `pricing.cacheWrites.metered`, `native.degradedByTransport`, `transport.endpointHost`.
7. **Publishing red rows:**
   - Publish every scenario in `scenarioSet`, including those with `measured*.savings.point < 0` («red») or `upper < 0` («proven loss»), plus `scenariosNotApplicable`, `levers.notExercised` and `levers.notMeasurable`.
   - Report the floor against the **strongest** baseline (`floors.min` and `floors.minAgainst`) and the quality per arm.
   - Publish the raw CSV.
   - Include a template table with columns scenario, B0/B1/B2 floors, status, reason.
   - `reproduce.mjs` lists red rows for you.
8. **`reproduce.mjs`:** usage, output, exit codes; the checks listed in 7.2.
9. **Known limits:** conditional interval; synthetic single-turn set; reasoning models with hidden reasoning inside the cap (`config.reasoningHeadroomTokens`); a gateway may not forward new settings (`native.honored`).

### 7.2 `apps/web/public/measure/reproduce.mjs`

About 250 lines, zero dependencies, English output.
- Reads JSON and CSV from a path or URL; RFC 4180 CSV parser with quotes.
- Groups trials by scenario in order of first appearance.
- Recomputes with mulberry32 and a stratified percentile bootstrap (a line-by-line port of `stats.ts`), using `config.seed`, `config.resamples ?? 10000` and alpha 0.05, for each column present (`costA` → B0, `costA1` → B1, `costA2` → B2).
- Compares with `===` against `aggregate`, `aggregateB1` and `aggregateB2`.
- Checks `trials`, `aggregate.strata`, `scenarioSet`, the seals from 7.1 §6 and `floors`.
- Lists red rows.
- Exits 0/1/2.
- Exports its pure functions for test 8(b).

---

## 8. Owner steps (exact commands; no command here touches production)

Run them in the unit's worktree once its PR has been reviewed and merged, with `main` including **rec. 1 (`feat/catalogo-2026`)**: without the rows for `gpt-6-luna` and `gemini-3.8-flash` and the GPT-6 premium, the preflight refuses to spend.

1. **Credentials** (they currently fail with «invalid model ID»). In `.env.bench` (gitignored), fill in the names from §3.1. Direct endpoints are recommended:
   `BVSALA_DEMO_OPENAI_BASE_URL=https://api.openai.com/v1`,
   `BVSALA_DEMO_ANTHROPIC_BASE_URL=https://api.anthropic.com/v1`,
   `BVSALA_DEMO_GOOGLE_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`,
   plus their `_API_KEY`. Optionally add the new names (without values) to `.env.bench.example` as well.
2. **Probe (cents):**
   `BVSALA_AB_PRESET=2026 BVSALA_AB_BUDGET_USD=<ceiling the probe prints, rounded up> pnpm ab:sonda`
   Every model must show OK, the counters present, and `promptCacheModeHonored: true` for gpt-6-luna. If OpenAI rejects `max_tokens` or `temperature`, **stop**: the fix belongs in the product (`src/providers/openai-compatible.ts`) and needs its own PR; or retry through the gateway.
3. **Calibration run** (few reps; see truncations):
   `BVSALA_AB_PRESET=2026 BVSALA_AB_REPS=2 BVSALA_AB_MAX_REPS=2 BVSALA_AB_BUDGET_USD=<ceiling printed> pnpm ab`
   If `truncated.*` is above zero on reasoning models, choose a `BVSALA_AB_MARGEN_RAZONAMIENTO` and repeat the calibration.
4. **Full run:**
   `BVSALA_AB_PRESET=2026 BVSALA_AB_MARGEN_RAZONAMIENTO=<calibrated> BVSALA_AB_BUDGET_USD=<ceiling printed> pnpm ab`
   For reference, the bitácora of 26‑09 used `BUDGET=3` for a single model; this preset has three models and four arms, so use the printed ceiling.
5. **Check before publishing:**
   `node apps/web/public/measure/reproduce.mjs --artifact benchmarks/out/ab-live--openai-gpt-6-luna.json --trials benchmarks/out/ab-live-trials--openai-gpt-6-luna.csv` (exit 0).
6. **Publish one model:**
   `pnpm ab:publish --model openai/gpt-6-luna --dry-run`, then without `--dry-run`.
   Update `landing.hero.proofs.0.modelo` and `.cifra` in all 12 languages to the integer below `floors.min` (the `cifra-del-heroe` gate enforces it).
   Review the surfaces tied to `gpt-4o-mini` (`apps/web/app/[locale]/dashboard/verify/page.tsx` reads `pricing.table["gpt-4o-mini"]`).
   Then `pnpm luz-verde`, and a PR.
7. **If `floors.min` against B2 is below 5%:** report rec. 3 says to rewrite the message towards the accounting. That is a business decision.

---

## 9. Risks and mitigations

- **R1:** The OpenAI adapter sends `max_tokens` and the bench sends `temperature` to reasoning models; either could return 400 on api.openai.com. D6 fixes temperature. `max_tokens` is caught by the probe (step 2), and its fix is a product change outside this unit.
- **R2:** The gateway may not forward `prompt_cache_options` / `reasoning_effort`, or may not return `cache_write_tokens`. The probe detects it; `native.honored` and `pricing.cacheWrites.metered` block publication; direct endpoints avoid it.
- **R3:** Truncation on reasoning models → D12 plus calibration.
- **R4:** B2 at `low` may answer worse. Quality per arm is published, and the direction is conservative against us.
- **R5:** Dependency on rec. 1 → the preflight aborts with an explicit message; the dry tests use an injected catalogue.
- **R6:** On today's set, B2 differs from B1 only by effort and cache mode (and only on GPT-5.6+). Tool search, compaction and context editing are «not applicable» by official rule. The artifact and the doc say so; adding scenarios where they do apply is the owner's decision (§10).
- **R7:** Without `temperature: 0`, variance goes up and reps go up. The ceiling already counts `MAX_REPS`, and the running cap protects the budget.

## 10. Decisions left to the owner (they do not block the PR)

1. Offering access to the harness source to independent measurers (the sentence in §7.1 point 2). If you prefer not to, path 3 is removed and only paths 1 and 2 remain.
2. Adding scenarios with 10+ tools and multi-turn above 50k tokens so that B2 exercises tool search and compaction. They change the headline's strata and cost more per rep.
3. The product PR for `max_completion_tokens` if the probe shows the 400.
4. How to show B2 on the web beyond the hero gate.

## 11. Sources (checked on 2026-09-27)

- OpenAI Chat Completions types (openai-node `master`), covering `prompt_cache_options` (default `implicit`, «explicit… no breakpoints → no prompt caching», «Supported for gpt-5.6 and later»), `prompt_cache_breakpoint`, the `reasoning_effort` values, and `max_tokens` being deprecated: https://raw.githubusercontent.com/openai/openai-node/master/src/resources/chat/completions/completions.ts
- The `prompt_tokens_details.cache_write_tokens` usage field: https://raw.githubusercontent.com/openai/openai-node/master/src/resources/completions.ts
- OpenAI prompt caching (GPT-5.6+: writes 1.25×, reads 0.1×, minimum 1,024; «explicit-only mode to avoid unnecessary cache writes»): https://developers.openai.com/api/docs/guides/prompt-caching
- gpt-6-luna (default effort `medium`; `none/low/medium/high/xhigh/max`; Chat Completions): https://developers.openai.com/api/docs/models/gpt-6-luna. Per-model reasoning defaults: https://developers.openai.com/api/docs/guides/reasoning
- Anthropic effort (`supportedModels`, Sonnet 5 guidance): https://platform.claude.com/docs/en/build-with-claude/effort
- Anthropic tool search (10+ tools or more than 10k tokens; no separate metering; `defer_loading` vs `cache_control`): https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Anthropic threshold compaction (minimum 50,000, default 150,000, `usage.iterations`): https://platform.claude.com/docs/en/build-with-claude/compaction-threshold
- Gemini OpenAI compatibility (updated 2026-09-02): https://ai.google.dev/gemini-api/docs/openai
- Gemini pricing (updated 2026-09-24): https://ai.google.dev/gemini-api/docs/pricing
- Gemini caching (updated 2026-09-02): https://ai.google.dev/gemini-api/docs/caching
- Gateway ids: https://ai-gateway.vercel.sh/v1/models
- Internal: `docs/COMPETENCIA-2026-09-26.md` §3, §4.3 and §8 recs. 3–4; `docs/BITACORA-2026-09-26.md` §2.3 and §6 (branch `origin/docs/bitacora-2026-09-26`).

## 12. Commits (one per step, `git commit -F <file> --only -- <paths>`)

1. `feat(banco): muestreo por modelo y coste con escrituras de caché — el banco deja de romperse con los modelos de 2026 y cobra la prima a todos los brazos`
2. `feat(banco): brazo B2 «nativo bien configurado» — lo que el proveedor da gratis, con su fuente, y el suelo frente a B0, B1 y B2`
3. `feat(banco): asShipped por defecto y una verja que ya no publica sin B2, sin precio de lista ni con filas quitadas`
4. `feat(banco): modelos de 2026, endpoints por familia, presupuesto obligatorio y sonda`
5. `docs(medición): kit de medición independiente y reproduce.mjs, que recalcula lo publicado bit a bit`

Verification before each push: `pnpm -s build:all && git checkout -- apps/web/public/vendor/bv-sala.js`; `pnpm -s run typecheck:all`; `pnpm --dir apps/web run typecheck`; `pnpm -s exec vitest run --reporter=dot`; `pnpm --dir apps/web run build` (because `apps/web/public/measure/` and the hero gate change).