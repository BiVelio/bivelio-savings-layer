# Migrating from 0.4 to 0.5

> **Status: final for 0.5.0.** This page is the single place where every
> breaking change of 0.5 is listed. A test checks it against the package's
> published types: every name 0.5 removes or renames is on this page, and none
> of them can come back into the package. Everything on it was announced with
> `@deprecated` and run-time notices in 0.4.34.

0.5 establishes the compatibility baseline of `@bivelio/savings-layer`. Existing
exports are stable and change or disappear only in a major release; a minor such
as 0.6 may only add deliberately reviewed APIs. To get there, 0.5 renames a few
things, removes exports that were never meant to be public, normalises
`finishReason`, and keeps one default that changed in 0.4.33.

## Summary

| # | What changes | Kind | Announced in |
|---|---|---|---|
| 1 | `CATALOGO`, `precioDeLista`, `PRECIOS_AL_DIA`, `embebedorLocal`, `UMBRAL_LOCAL` are gone; use the English names | rename | 0.4.33 (the new names were already there) |
| 2 | `createSavingsLayer({ semanticCache })` is gone; use `semanticCacheStore` | rename | 0.4.33 (the old key warned once) |
| 3 | `report.cost.netSavings` is gone; use `netSavingsRatio` (same value) or `netSavingsUsd` | rename | 0.4.33 (both new fields were already in the report) |
| 4 | `result.finishReason` (and `qualityLedger.truncation.finishReason`, and each batch item's `finishReason`) is one of five values; the provider's own value is in `finishReasonDetail` | changed value | 0.4.33 (`finishReasonDetail`; on `truncation` from 0.4.34; on batch items new in 0.5) |
| 5 | Tool selection keeps the whole catalogue unless you set `maxTools` | changed default | already the behaviour since 0.4.33 |
| 6 | `licenseGate`, `devUnlicensed` and `licensePublicKey` are no longer in `SavingsLayerConfig` | removal | 0.4.33; run-time notices in 0.4.34 |
| 7 | 66 internal helpers and licensing internals are no longer exported from the package root | removal | every one `@deprecated` in 0.4.34 |
| 8 | Already-deprecated aliases are gone | removal | 0.4.x |
| 9 | CLI: the Spanish flag spellings and two environment variables are gone and now fail with an error | rename | 0.4.33 (the old spellings warned once) |

In numbers: 73 exports leave the package root (68 removed, 5 renamed), and 7
fields leave the public types (5 removed, 2 renamed).

## Upgrade to the latest 0.4 first

0.4.34 and later (the last 0.4 is 0.4.36) change nothing you rely on, and they
tell you everything 0.5 breaks before you get there:

```sh
npm i @bivelio/savings-layer@0.4   # the latest 0.4.x
```

- **The compiler.** Every export and option that 0.5 removes or renames is
  marked `@deprecated` in the 0.4.34 types, with what to use instead. Your
  editor strikes each use through; `@typescript-eslint/no-deprecated`
  (typescript-eslint 8+) lists them in CI.
- **The console.** What the types cannot catch warns once per process:
  `semanticCache`, `licensePublicKey` and `licenseGate` in
  `createSavingsLayer`, and the Spanish CLI flags and variables.

When your build on 0.4.34 or later shows no deprecation and your logs show no notice,
the only change left is the value of `finishReason`
([section 4](#4-finishreason-is-normalised-the-providers-value-moves-to-finishreasondetail)),
which no tool can flag for you.

## How to find what affects you

1. **Build against the latest 0.4** and fix every deprecation (see above).
2. **Search your code** for the names on this page:

   ```sh
   grep -rnE "CATALOGO|precioDeLista|PRECIOS_AL_DIA|embebedorLocal|UMBRAL_LOCAL|MODELOS_POR_CODIFICACION|registrarTokenizadorExacto|vectorLocal|quitarPrefijoDeProveedor|netSavings\b|estimatedTierSaving|finishReason|semanticCache:|licenseGate|devUnlicensed|licensePublicKey|maxTools|silenciarAvisos|--puerto|--proyecto|--forzar|BVSALA_GATEWAY_ESFUERZO|BVSALA_GATEWAY_MODELO_HERMANO|BVSALA_SILENCE_DEPRECATIONS" src/
   ```

3. **Anything else you import from the package root** is checked against the
   list in [section 7](#7-internal-exports-leave-the-package-root). On 0.5, a
   missing export is a TypeScript error (`has no exported member`).
4. **Install 0.5** and build:

   ```sh
   npm i @bivelio/savings-layer@^0.5
   ```

   Every error the compiler reports is on this page. Then check
   `finishReason` by hand (section 4).

---

## 1. English names for the price catalogue and the local embedder

The Spanish names were exported by accident of history. The English names
exist since 0.4.33 and are the same objects; 0.5 removes the Spanish ones, with
no alias.

| 0.4 | 0.5 |
|---|---|
| `CATALOGO` | `PRICE_CATALOG` |
| `precioDeLista(model, at?)` | `listPrice(model, at?)` |
| `PRECIOS_AL_DIA` | `PRICES_AS_OF` |
| `embebedorLocal(text)` | `localEmbedding(text)` |
| `UMBRAL_LOCAL` | `LOCAL_EMBEDDING_THRESHOLD` |

```ts
// Before (0.4)
import { precioDeLista, embebedorLocal, UMBRAL_LOCAL } from "@bivelio/savings-layer";
const price = precioDeLista("gpt-4o-mini");
const cache = new InMemorySemanticCache({ embed: embebedorLocal, similarityThreshold: UMBRAL_LOCAL });

// After (0.4.33+ and 0.5)
import { listPrice, localEmbedding, LOCAL_EMBEDDING_THRESHOLD } from "@bivelio/savings-layer";
const price = listPrice("gpt-4o-mini");
const cache = new InMemorySemanticCache({
  embed: localEmbedding,
  similarityThreshold: LOCAL_EMBEDDING_THRESHOLD,
  calibration: { maxErrorRate: 0.02 },
});
```

Without `calibration`, the cache only stores in shadow mode and never serves a semantic hit.

The same goes for the exact-tokenizer helpers: see [section 8](#8-deprecated-aliases-are-removed).

**Detect:** on 0.4.34 your editor marks the old names as deprecated; on 0.5
TypeScript reports `has no exported member 'embebedorLocal'` (and so on); for
`CATALOGO`, `precioDeLista` and `PRECIOS_AL_DIA` the message reads
`declares 'CATALOGO' locally, but it is not exported`. The `grep`
above finds them.

## 2. `semanticCache` in the constructor becomes `semanticCacheStore`

In 0.4 the same word means two things: in `createSavingsLayer` it is the
*store*, and in a request's `savings` it is the *decision to use it*. Passing a
store never turned reuse on, and that surprised people. In 0.5 the store has
its own name; turning reuse on is unchanged (`semanticCacheDefault` for the
whole layer, `savings.semanticCache` per request, the request winning).

```ts
// Before (0.4)
const layer = createSavingsLayer({
  provider,
  semanticCache: new InMemorySemanticCache({ calibration: { maxErrorRate: 0.01 } }),
  semanticCacheDefault: "safe-only",
});

// After (0.4.33+ and 0.5)
const layer = createSavingsLayer({
  provider,
  semanticCacheStore: new InMemorySemanticCache({ calibration: { maxErrorRate: 0.01 } }),
  semanticCacheDefault: "safe-only",
});
```

`savings: { semanticCache: … }` on a request does **not** change.

**Detect:** in 0.5 TypeScript reports `semanticCache` as an unknown property
of `SavingsLayerConfig`. From JavaScript, the layer **ignores** the old key (it
is no longer a store) and warns once:
`` `createSavingsLayer({ semanticCache })` was removed in 0.5 and is ignored ``
(silenced by `silenceWarnings`). In 0.4.x the old key still worked.

## 3. `report.cost.netSavings` becomes `netSavingsRatio`, and `netSavingsUsd` is new

`netSavings` has always been a **ratio** (`1 − actual / baselineEstimate`,
six decimals), not an amount of money. Summing it across requests, or showing
it with a `$`, gives a meaningless number. 0.5 names it for what it is and adds
the amount in dollars.

| 0.4 | 0.5 |
|---|---|
| `report.cost.netSavings` (ratio) | `report.cost.netSavingsRatio` (same value) |
| — | `report.cost.netSavingsUsd` (= `baselineEstimate − actual`) |

```ts
// Before (0.4): a ratio, easy to misuse
total += result.report.cost.netSavings;               // wrong: adds ratios
const usd = result.report.cost.baselineEstimate - result.report.cost.actual;

// After (0.4.33+ and 0.5): `cost.netSavings` no longer exists
totalUsd += result.report.cost.netSavingsUsd;
const pct = result.report.cost.netSavingsRatio * 100;
```

Only sum `netSavingsUsd` within one `cost.basis`: measured and estimated money
stay apart, as today. The span attributes written by the OpenTelemetry and
Datadog exporters already call the ratio `net_savings_ratio`; their names do not
change.

**Detect:** in 0.5 TypeScript flags every read of `cost.netSavings`; from
JavaScript it reads `undefined`. If you store reports as JSON, update the
consumers of that column too. The usage record the SDK sends to BiVelio for
metering is a different object and keeps its own field names.

## 4. `finishReason` is normalised; the provider's value moves to `finishReasonDetail`

Up to 0.4, the adapters translated the common reasons (Anthropic's `end_turn`
became `stop`, `max_tokens` became `length`, `tool_use` became `tool_calls`),
but anything else passed through as the provider wrote it:
`content_filter: OTHER` from Gemini's OpenAI-compatible endpoint,
`stop_sequence`, `pause_turn`, `MALFORMED_FUNCTION_CALL`, and so on. In 0.5
`result.finishReason` is one of a closed set, the same for every provider and
every mode (JSON and stream):

```ts
finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "other";
```

The provider's own value, when it adds something, is in
`result.finishReasonDetail` (there since 0.4.33): the refusal category, the
Gemini block reason, or the literal stop reason. The quality ledger carries the
same pair: `report.qualityLedger.truncation.finishReason` is the same value as
`result.finishReason`, and `truncation.finishReasonDetail` holds the provider's
value. So do batch results: each `BatchItemResult` from
`layer.batches.results()` has `finishReason` in the same closed set (it was an
open `string` in 0.4) and the provider's value in the new
`finishReasonDetail`, read with the same rule on Anthropic's Message Batches and
on OpenAI's Batch API. The verification pair (`VerificationCheck.naive.finishReason`,
the `naive_finish_reason` column of the export) uses the same five values too.

| The provider says | `finishReason` (0.5) | `finishReasonDetail` |
|---|---|---|
| `stop`, `end_turn`, `STOP` | `stop` | — |
| `stop_sequence`, `eos`, `eos_token` | `stop` | the literal |
| `length`, `max_tokens`, `MAX_TOKENS` | `length` | — |
| `model_context_window_exceeded` | `length` | the literal |
| `tool_calls`, `tool_use` (and Gemini `STOP` with tool calls) | `tool_calls` | — |
| `function_call` (legacy OpenAI) | `tool_calls` | the literal |
| `content_filter` | `content_filter` | — |
| `content_filter: OTHER` (and any `content_filter: X`) | `content_filter` | `OTHER` (the `X`) |
| Anthropic `refusal` | `content_filter` | the refusal category, or `refusal` |
| Gemini `SAFETY`, `PROHIBITED_CONTENT`, `RECITATION`, … and `promptFeedback.blockReason` | `content_filter` | the Gemini value |
| anything else (`pause_turn`, `MALFORMED_FUNCTION_CALL`, an unknown value) | `other` | the literal |

```ts
// Before (0.4)
if (result.finishReason?.startsWith("content_filter")) { … }
if (result.finishReason === "stop_sequence") { … }

// After (0.5)
if (result.finishReason === "content_filter") {
  log(result.finishReasonDetail); // e.g. "OTHER", "SAFETY", "cyber"
}
if (result.finishReason === "stop" && result.finishReasonDetail === "stop_sequence") { … }
```

A `finishReason` of `"length"` still means the answer was cut and is never
cached. The framework adapters (`/anthropic-sdk` and the rest) keep handing
your framework the provider's own stop reason; only the layer's result and
report are normalised (see [What does not change](#what-does-not-change)).

**Detect:** search for `finishReason` compared against provider-specific
strings (`content_filter: …`, `stop_sequence`, `end_turn`, `pause_turn`, Gemini
upper-case values) or with `startsWith`, in `result`, in
`qualityLedger.truncation` and in the items of `layer.batches.results()`. In 0.5 the type is the union above, so TypeScript
flags a comparison with any other literal.

## 5. Tool selection keeps the whole catalogue by default

**This is already the behaviour since 0.4.33**, and 0.5 freezes it. Without
`maxTools`, the tool selector no longer prunes by relevance: every read tool
travels, and write or destructive tools are still withheld from requests that
are not actions. Up to 0.4.32 a *typed* catalogue (tools that declare
`intents`/`risk`) was pruned to 8 by relevance; a catalogue without them already
travelled whole since 0.4.31. Tools that are not pruned are not credited as a
saving.

```ts
// 0.4.33+ and 0.5, to keep the 0.4.32 behaviour on a typed catalogue:
const layer = createSavingsLayer({
  provider,
  toolSelector: new ToolSelector({ maxTools: 8 }),
});
```

**Detect:** only affects you if your tools declare `intents` or `risk` and you
never set `maxTools`, and you have already seen it on 0.4.33.
`report.traces` shows the selection on every request.

## 6. Licensing options that do nothing in the published package are removed

`licenseGate`, `devUnlicensed` and `licensePublicKey` only ever worked when the
SDK was built from source. In the package you install from npm they were
ignored. 0.5 removes them from `SavingsLayerConfig`.

```ts
// Before (0.4): accepted, but ignored by the published package
createSavingsLayer({ provider, licenseGate: myGate, devUnlicensed: true, licensePublicKey: pem });

// After (0.5)
createSavingsLayer({
  provider,
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY, // renewal pickup and usage
});
```

**Detect:** in 0.5 each of the three is a type error (unknown property of
`SavingsLayerConfig`). From JavaScript, the published package still ignores
them: `licenseGate` and `licensePublicKey` print a one-time notice that says
the option was removed in 0.5 (silenced by `silenceWarnings`), and
`devUnlicensed` is ignored silently. The `grep` above finds all three.

## 7. Internal exports leave the package root

These names are building blocks of the pipeline or of license verification.
They have no role in the configuration and none of our documentation uses them.
Exporting them froze their signatures for no one. In 0.5 they are no longer
exported, and the package root is a closed list: nothing reaches it by
accident any more. If you relied on one, write to support@bivelio.com.

**Pipeline internals:** `buildExactKey`, `buildInflightKey`, `canonicalize`,
`CanonicalRequest`, `cosine`, `words`, `normalizeText`, `numericTokens`,
`negationCount`, `keyTokensMatch`, `multisetEqual`, `sameAnswer`, `dedupe`,
`adaptiveK`, `executeRetrievalPlan`, `projectContext`, `evaluatePolicy`,
`shouldCompress`, `withProtectedSpans`, `evalArithmetic`, `uniformColumns`,
`isStrictCompatible`, `resolveDependencies`, `ResolvedDeps`, `modelFamilyOf`,
`stableStringify`, `sha256`, `randomId`, `SavingsLedger`, `TraceCollector`,
`verifyCompactSignature`, `CompactVerification`, `resolveConstraintBackend`,
`compresionFiel`, `quitarPrefijoDeProveedor` (use the adapter option
`stripProviderPrefix`), `vectorLocal` (use `localEmbedding`).

**Reference-commission constants** (the rule is documented in prose, not as
API): `REFERENCE_MAX_AGE_MS`, `REFERENCE_MESSAGE_ALLOWANCE`,
`REFERENCE_OUTPUT_SHARE`.

**Licensing and metering internals** (the published package is licensed only
through `licenseKey` and `serviceAccountKey`): `gateFromKey`,
`liveGateFromKey`, `resolveLicense`, `ResolvedGate`, `ResolvedLicense`,
`verifyLicenseToken`, `verifyRevocationList`, `RevocationPoller`,
`RevocationPollerOptions`, `RevocationPollEvent`, `RevocationSnapshot`,
`RevocationListBody`, `RevocationListVerification`, `EMBEDDED_PUBLIC_KEY`,
`UsageEmitter`, `UsageEmitterOptions`, `deriveSeatId`, `detectCi`,
`licenseKeyShape`, `LicenseKeyShape`, `normalizeLicenseKey`,
`computeNextDelay`, `deriveStatus`, `isKeyset`, `LicenseTokenPayload`,
`LicenseStatus`, `DEFAULT_MAX_STALENESS_SECONDS` (its value is documented under
`licenseRevocation.maxStalenessSeconds`).

`LicenseError`, `LicenseGate` (the type) and `LicenseKeyset` stay.

Where there is a replacement:

| Removed | Use instead |
|---|---|
| `randomId()` | `crypto.randomUUID()` |
| `sha256(text)` | `createHash("sha256").update(text).digest("hex")` from `node:crypto` |
| `TraceCollector` | `report.traces` on every result |
| `SavingsLedger` | the four ledgers in the `SavingsReport` of each call |
| `evalArithmetic` | `arithmeticResolver` / `createDefaultResolvers()` |
| `quitarPrefijoDeProveedor` | the adapter option `stripProviderPrefix` |
| `vectorLocal` | `localEmbedding` |
| `DEFAULT_MAX_STALENESS_SECONDS` | `licenseRevocation.maxStalenessSeconds` (default 72 h) |
| the licensing internals | `licenseKey` and `serviceAccountKey` |

```ts
// Before (0.4)
import { randomId, sha256 } from "@bivelio/savings-layer";

// After (0.5)
import { createHash, randomUUID } from "node:crypto";
```

**Detect:** on 0.4.34 every name above is marked `@deprecated`; on 0.5
TypeScript reports `has no exported member`.

## 8. Deprecated aliases are removed

| Removed in 0.5 | Use |
|---|---|
| `MODELOS_POR_CODIFICACION` | `MODELS_BY_ENCODING` |
| `registrarTokenizadorExacto` | `registerExactTokenizer` |
| `report.deferred.estimatedTierSaving` | `report.deferred.tierSaving.amount` (same value) |
| `RevocationPollerOptions.silenciarAvisos` | `silenceWarnings` (the whole type leaves the root; see section 7) |

```ts
// Before (0.4)
await registrarTokenizadorExacto(registry);
const saving = report.deferred?.estimatedTierSaving;

// After (0.5)
await registerExactTokenizer(registry);
const saving = report.deferred?.tierSaving?.amount;
```

## 9. CLI (`bvsala`)

| 0.4 | 0.5 |
|---|---|
| `--puerto`, `--proyecto`, `--forzar` | `--port`, `--project`, `--force` |
| `BVSALA_GATEWAY_ESFUERZO` | `BVSALA_GATEWAY_EFFORT` |
| `BVSALA_GATEWAY_MODELO_HERMANO` | `BVSALA_GATEWAY_SIBLING_MODEL` |

The English spellings work since 0.4.33. In 0.5 the Spanish ones are not
aliases any more: using one is an error that names the new spelling, and
`bvsala` exits with status 1 before doing anything else.

```sh
# Before (0.4)
bvsala gateway --puerto 8787
BVSALA_GATEWAY_ESFUERZO=low bvsala claude

# After (0.5)
bvsala gateway --port 8787
BVSALA_GATEWAY_EFFORT=low bvsala claude
```

```text
$ bvsala gateway --puerto 8787
[bvsala] --puerto was removed in 0.5: use --port.
$ BVSALA_GATEWAY_ESFUERZO=low bvsala gateway
[bvsala] BVSALA_GATEWAY_ESFUERZO was removed in 0.5 and is no longer read: rename it to BVSALA_GATEWAY_EFFORT (same values), or unset it.
```

The environment variables are checked only by the commands that read them
(`gateway` and the terminal wrappers such as `claude` or `codex`); `doctor`,
`init` and `skill` still run with an old variable set in your shell.
Arguments after a wrapped terminal (`bvsala claude …`) belong to that terminal
and are passed through untouched. `BVSALA_SILENCE_DEPRECATIONS` is no longer
read: there is nothing deprecated left to silence.

Commands (`gateway`, `claude`, `codex`, `goose`, `qwen`, `opencode`, `kilo`,
`copilot`, `aider`, `doctor`, `skill`, `init`) and the other environment
variables do not change.

---

## What does not change

These are stable in 0.5 as they behave in 0.4.33. They are listed because
their behaviour changed recently and people ask:

- **`maxOutputTokens` on the request** and on the output contract: when both
  are set, the smaller one is sent. A cap you set is never credited as a
  saving.
- **`reasoningEffort`** travels as written (`reasoning_effort` on OpenAI;
  mapped to the thinking level on Gemini). The layer never picks one for you.
- **`temperature`** is dropped, with a one-time warning, on models that reject
  non-default values.
- **The provider's prompt cache on turn 2** is marked only when the
  conversation shows signs of continuing.
- **`sendPromptCacheKey`** and **`maxTokensParam`** on
  `OpenAICompatibleProvider` stay as escape hatches for proxies.
- **`toolSearch`** and **`toolDiscovery`** keep their names, modes and defaults
  (off).
- **Gemini:** a native adapter (`GoogleProvider`) arrived in 0.4.33 and is the
  recommended way to use Gemini in 0.5. Gemini through
  `OpenAICompatibleProvider` keeps working.
- **The provider's own cache saving** (`report.nativeSavings`) is reported
  apart from `cost` and never enters the commission.
- The four framework adapters (`/ai-sdk`, `/mastra`, `/langchain`,
  `/anthropic-sdk`) keep their exports.
- **`/anthropic-sdk` hands your code Anthropic's own `stop_reason`.** The
  middleware speaks the official SDK's protocol, so the `Message` (JSON or
  stream) keeps `stop_reason` and `stop_details` exactly as Anthropic sent them:
  `end_turn`, `max_tokens`, `stop_sequence`, `pause_turn`, `refusal`… That is
  the SDK's contract, and code written against it keeps working. What is
  normalised is the layer's report: `savings.reportFor(message)` gives
  `qualityLedger.truncation.finishReason` in the closed set of section 4 and
  Anthropic's value in `truncation.finishReasonDetail`.
