# Migrating from 0.4 to 0.5

> **Status: draft.** 0.5 is not released. This page is the single place where
> every breaking change of 0.5 is listed; nothing breaks in a 0.4.x release.
> Items marked **(proposed)** are still being decided and may change before
> 0.5 ships. The list is checked by a test against the package's published
> types, so a change that is not on this page cannot ship in 0.5.

0.5 freezes the public API of `@bivelio/savings-layer`. After 0.5, anything
listed as stable changes only in a major release. To get there, 0.5 renames a
few things, removes exports that were never meant to be public, and changes two
defaults.

## Summary

| # | What changes | Kind | Deprecated in 0.4.x? |
|---|---|---|---|
| 1 | `CATALOGO`, `precioDeLista`, `PRECIOS_AL_DIA`, `embebedorLocal`, `UMBRAL_LOCAL` get English names | rename | yes, from 0.4.33 (the new names are already there) |
| 2 | `createSavingsLayer({ semanticCache })` becomes `semanticCacheStore` | rename | documented, no alias yet |
| 3 | `report.cost.netSavings` becomes `netSavingsRatio`, plus a new `netSavingsUsd` | rename | documented |
| 4 | `result.finishReason` becomes a closed, normalised set; the provider's own value moves to `finishReasonDetail` | changed value | no |
| 5 | Tool selection on a typed catalogue no longer caps at 8 tools by default (`maxTools`) **(proposed)** | changed default | no |
| 6 | `licenseGate`, `devUnlicensed` and `licensePublicKey` leave `SavingsLayerConfig` | removal | yes, from 0.4.33 |
| 7 | Internal helpers and licensing internals leave the package root | removal | partly |
| 8 | Already-deprecated aliases are removed | removal | yes |
| 9 | CLI: Spanish flag spellings and two environment variables are renamed **(proposed)** | rename | no |

## How to find what affects you

1. **Upgrade to the latest 0.4.x first** and build. Everything that 0.4.x can
   deprecate carries a `@deprecated` tag, so your editor strikes it through.
   To list them in CI, turn on the `@typescript-eslint/no-deprecated` rule
   (typescript-eslint 8+) for files that import `@bivelio/savings-layer`.
2. **Search your code** for the names in this page:

   ```sh
   grep -rnE "CATALOGO|precioDeLista|PRECIOS_AL_DIA|embebedorLocal|UMBRAL_LOCAL|netSavings|finishReason|semanticCache:|licenseGate|devUnlicensed|licensePublicKey|maxTools" src/
   ```

3. **Anything else you import from the package root** is checked against the
   table in [section 7](#7-internal-exports-leave-the-package-root). If you use
   one of those names, tell us at support@bivelio.com before 0.5 ships: an
   export with a real user can be kept.

---

## 1. English names for the price catalogue and the local embedder

The Spanish names were exported by accident of history. The English names
exist from 0.4.33 and are the same objects; the Spanish ones are removed in
0.5.

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
const cache = new InMemorySemanticCache({ embed: localEmbedding, similarityThreshold: LOCAL_EMBEDDING_THRESHOLD });
```

**Detect:** your editor marks the old names as deprecated; the `grep` above
finds them.

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

// After (0.5)
const layer = createSavingsLayer({
  provider,
  semanticCacheStore: new InMemorySemanticCache({ calibration: { maxErrorRate: 0.01 } }),
  semanticCacheDefault: "safe-only",
});
```

`savings: { semanticCache: … }` on a request does **not** change.

**Detect:** TypeScript reports `semanticCache` as an unknown property of
`SavingsLayerConfig` after upgrading. In JavaScript, 0.5 warns once when it
receives the old key.

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

// After (0.5)
totalUsd += result.report.cost.netSavingsUsd;
const pct = result.report.cost.netSavingsRatio * 100;
```

Only sum `netSavingsUsd` within one `cost.basis`: measured and estimated money
stay apart, as today. The span attributes written by the OpenTelemetry and
Datadog exporters already call the ratio `net_savings_ratio`; their names do not
change.

**Detect:** TypeScript flags every read of `cost.netSavings`. If you store
reports as JSON, update the consumers of that column too.

## 4. `finishReason` is normalised; the provider's value moves to `finishReasonDetail`

The adapters already translate the common reasons (Anthropic's `end_turn`
becomes `stop`, `max_tokens` becomes `length`, `tool_use` becomes
`tool_calls`), but anything else passes through as the provider wrote it:
`content_filter: OTHER` from Gemini's OpenAI-compatible endpoint,
`stop_sequence`, `pause_turn`, and so on. In 0.5 `result.finishReason` is one of
a closed set, the same for every provider:

`"stop" | "length" | "tool_calls" | "content_filter" | "other"`

The provider's own value (the Gemini block reason, Anthropic's refusal
category, an unmapped stop reason) is in `result.finishReasonDetail`, which a
0.4.x release adds before 0.5.

```ts
// Before (0.4)
if (result.finishReason?.startsWith("content_filter")) { … }

// After (0.5)
if (result.finishReason === "content_filter") {
  log(result.finishReasonDetail); // e.g. "OTHER", "SAFETY", "cyber"
}
```

**Detect:** search for `finishReason` comparisons against provider-specific
strings (`content_filter: …`, `stop_sequence`, `pause_turn`) or with
`startsWith`.

## 5. Tool selection keeps the whole catalogue by default (proposed)

Since 0.4.31, a tool catalogue without `intents` or `risk` reaches the model
whole. A *typed* catalogue (tools that declare `intents`/`risk`) is still
pruned by relevance to `maxTools` (default 8). The proposal for 0.5 is that
relevance pruning becomes opt-in: by default every read tool travels, and write
or destructive tools are still withheld from requests that are not actions.

```ts
// 0.5, to keep the 0.4 behaviour on a typed catalogue:
const layer = createSavingsLayer({
  provider,
  toolSelector: new ToolSelector({ maxTools: 8 }),
});
```

**Detect:** only affects you if your tools declare `intents` or `risk` and you
never set `maxTools`. `report.traces` shows the selection on every request.

## 6. Licensing options that do nothing in the published package are removed

`licenseGate`, `devUnlicensed` and `licensePublicKey` only work when the SDK is
built from source. In the package you install from npm they are ignored
(`licenseGate` already prints a warning saying so). 0.5 removes them from
`SavingsLayerConfig`.

```ts
// Before (0.4): accepted, but ignored by the published package
createSavingsLayer({ provider, licenseGate: myGate, devUnlicensed: true });

// After (0.5)
createSavingsLayer({
  provider,
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY, // renewal pickup and usage
});
```

**Detect:** deprecated from 0.4.33 (strike-through in your editor); a type
error in 0.5.

## 7. Internal exports leave the package root

These names are building blocks of the pipeline or of license verification.
They have no role in the configuration and none of our documentation uses them.
Exporting them froze their signatures for no one. In 0.5 they are no longer
exported. If you rely on one, write to support@bivelio.com.

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

**Detect:** TypeScript reports a missing export on upgrade.

## 8. Deprecated aliases are removed

| Removed in 0.5 | Use |
|---|---|
| `MODELOS_POR_CODIFICACION` | `MODELS_BY_ENCODING` |
| `registrarTokenizadorExacto` | `registerExactTokenizer` |
| `report.deferred.estimatedTierSaving` | `report.deferred.tierSaving.amount` |
| `RevocationPollerOptions.silenciarAvisos` | (the whole type leaves the root; see section 7) |

## 9. CLI (`bvsala`) (proposed)

| 0.4 | 0.5 |
|---|---|
| `--puerto`, `--proyecto`, `--forzar` | `--port`, `--project`, `--force` (the English spellings already work) |
| `BVSALA_GATEWAY_ESFUERZO` | `BVSALA_GATEWAY_EFFORT` |
| `BVSALA_GATEWAY_MODELO_HERMANO` | `BVSALA_GATEWAY_SIBLING_MODEL` |

Commands (`gateway`, `claude`, `codex`, `goose`, `qwen`, `opencode`, `kilo`,
`copilot`, `aider`, `doctor`, `skill`, `init`) and the other environment
variables do not change.

---

## What does not change

These are stable in 0.5 as they behave in 0.4.32. They are listed because
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
- **Gemini:** a native adapter (`GoogleProvider`) arrives in 0.4.x and is the
  recommended way to use Gemini in 0.5. Gemini through
  `OpenAICompatibleProvider` keeps working.
- **The provider's own cache saving** (`report.nativeSavings`) is reported
  apart from `cost` and never enters the commission.
- The four framework adapters (`/ai-sdk`, `/mastra`, `/langchain`,
  `/anthropic-sdk`) keep their exports.
