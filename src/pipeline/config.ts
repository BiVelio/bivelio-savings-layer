import type { CostModel } from "../tokenizer/accounting.js";
import type { TokenizerRegistry } from "../tokenizer/registry.js";
import type { ExactCache } from "../cache/exact.js";
import type { InMemorySemanticCache } from "../cache/semantic.js";
import type { Singleflight } from "../cache/singleflight.js";
import type { ResolverRegistry } from "../resolvers/resolvers.js";
import type { ExecutionRouter } from "../router/router.js";
import type { ToolSelector } from "../router/tool-selector.js";
import type { FormatSelector } from "../serialization/format-selector.js";
import type { SchemaRegistry } from "../constraints/schema-registry.js";
import type { ConstraintBackend } from "../constraints/backends.js";
import type { Compressor } from "../compression/compression.js";
import type { CompressionEconomics } from "../economics/politica-compresion.js";
import type { Retriever, Reranker } from "../retrieval/retrieval.js";
import type { Provider } from "../providers/types.js";
import type { LicenseGate } from "../contracts/types.js";
import type { VerificationSettings } from "../contracts/verification.js";
import type { LicenseKeyset } from "../license/verify.js";

/**
 * Everything the pipeline depends on. All fields except `provider` and
 * `tokenizer` are optional; sensible in-memory defaults are wired by
 * {@link createSavingsLayer} so the layer works out of the box and every
 * component is independently swappable.
 */
export interface SavingsLayerConfig {
  /**
   * Contratos a los que ya se les incumplió una restricción de valor.
   *
   * La capa lo aprende sola, pero lo aprendido muere con la instancia. En
   * serverless —una instancia por petición— eso significa no aprender NUNCA:
   * cada llamada estrena y paga su reparación. Pasar aquí un conjunto
   * compartido (o respaldado por Redis, con la API de Set) hace que se aprenda
   * una vez para todo el despliegue.
   *
   * Solo guarda identificadores de contrato, nunca contenido de peticiones.
   */
  constraintMemory?: Set<string>;

  provider: Provider;
  tokenizer: TokenizerRegistry;

  exactCache?: ExactCache;
  semanticCache?: InMemorySemanticCache;
  singleflight?: Singleflight;
  resolvers?: ResolverRegistry;
  router?: ExecutionRouter;
  toolSelector?: ToolSelector;
  formatSelector?: FormatSelector;
  schemaRegistry?: SchemaRegistry;
  constraintBackends?: ConstraintBackend[];
  compressor?: Compressor;
  /**
   * The numbers behind "compress only when it pays for itself" — in money, not
   * in tokens.
   *
   * All optional, and the default never invents a saving: the layer compresses
   * when the net token saving justifies it, and holds back when compressing
   * would push the prompt below the provider's cacheable minimum — where fewer
   * tokens can mean a larger bill. Declare {@link CompressionEconomics.prefix}
   * with your own measurements to unlock the full decision in both directions.
   */
  compressionEconomics?: CompressionEconomics;
  retriever?: Retriever;
  reranker?: Reranker;

  /**
   * Tuning for the model cascade (`savings.modelCascade`). All optional; the
   * defaults measure and never spend.
   */
  modelCascade?: ModelCascadeSettings;

  /**
   * Layer-wide defaults for the provider price levers (`savings.deferrable`,
   * `savings.standalone`) and what to do when the cheaper tier has no capacity.
   * All off by default; a request's own `savings` value always wins.
   */
  priceLevers?: PriceLeverSettings;

  /**
   * Signed BiVelio license token (from your paid subscription). This is the
   * primary way to license the SDK: `createSavingsLayer` verifies it offline
   * against the embedded public key and builds a {@link licenseGate} from it.
   * Without a valid, active license (and without {@link devUnlicensed}), the
   * pipeline refuses to run — get a key at https://savings.bivelio.com.
   *
   * Surrounding whitespace (the trailing newline of a file or mounted secret),
   * wrapping quotes and a `Bearer ` prefix are stripped before verification, so
   * a key read with `readFileSync` works as-is. Anything INSIDE the key is not
   * touched: a key with a space in the middle is a broken key.
   */
  licenseKey?: string;

  /**
   * Override the public key used to verify {@link licenseKey}. An SPKI PEM string,
   * or a kid-addressed {@link LicenseKeyset} (`{ keys: {kid: pem}, defaultKid }`)
   * to support signing-key rotation — legacy no-kid tokens use `defaultKid`, and
   * an unknown kid fails closed. For self-hosting/self-testing; defaults to the
   * build-embedded BiVelio key.
   */
  licensePublicKey?: string | LicenseKeyset;

  /**
   * Pre-built license gate. **Ignored in the published npm package**, where a
   * {@link licenseKey} verified against the embedded BiVelio public key is the
   * only accepted license — passing a gate there logs a warning and changes
   * nothing. It exists for builds from source (this repo's own tests and
   * benchmarks), where it takes precedence over {@link licenseKey}.
   */
  licenseGate?: LicenseGate;

  /**
   * OPT-IN online revocation call-home. When set (alongside {@link licenseKey} and
   * with no explicit {@link licenseGate}), the SDK polls this base's
   * `GET /licenses/revocations` for a signed revocation list and enforces it via a
   * LIVE gate — a license cancelled mid-term stops working without a restart.
   *
   * NON-BLOCKING: the customer request path never blocks on the fetch; the warm poll
   * is fired but not awaited, and any failed/unreachable poll is a no-op that keeps
   * the last-known-good snapshot. Leaving this unset keeps the fully-offline,
   * zero-network default path. Pass the base URL of the licensing service, e.g.
   * `https://savings.bivelio.com`.
   */
  licenseServerUrl?: string;

  /**
   * Steady-state ceiling between revocation polls, in seconds (default 900 = 15 min).
   * The effective cadence tightens near license expiry and has a hard floor.
   */
  licensePollIntervalSeconds?: number;

  /** Injectable `fetch` for the revocation poller (defaults to the global). Testing/proxy. */
  licenseFetch?: typeof fetch;

  /** Advanced tuning of the revocation poller cadence + skew tolerance. */
  licenseRevocation?: {
    /** Hard floor between polls, seconds (default 300). */
    floorSeconds?: number;
    /** Backoff ceiling during a control-plane outage, seconds (default 3600). */
    maxIntervalSeconds?: number;
    /** Jitter fraction ± (default 0.1). */
    jitterRatio?: number;
    /** Reject a signed list whose `asOf` is more than this far in the future, seconds (default 300). */
    maxSkewSeconds?: number;
    /**
     * ONLINE staleness ceiling, seconds (default 72h, `DEFAULT_MAX_STALENESS_SECONDS`). If the SDK goes this long
     * without a CONFIRMED authorized heartbeat (a 304 or a verified list), the LIVE
     * gate stops granting — closing the fail-open window where blocking egress keeps
     * a revoked license alive until natural expiry. Must exceed the poll cadence
     * with margin. Applies ONLY on the online path ({@link licenseServerUrl} set);
     * it is NOT a zero-network opt-out — use the offline path for that.
     */
    maxStalenessSeconds?: number;
  };

  /**
   * Service-account key (`bvk_…`) — your machine credential. It does TWO things,
   * and the second one is why a long-running deployment needs it:
   *
   *  1. **Licence renewal pickup.** Each billing period mints a NEW licence token;
   *     the one you deployed expires at the end of the period (+ grace). With this
   *     key the SDK fetches the renewed token from the control plane and swaps it
   *     in without a restart. WITHOUT it there is no machine pickup, so somebody
   *     must paste the new token by hand every cycle or the deployment stops with
   *     `LicenseError` once the grace period ends — while the subscription is paid
   *     and current. Disable with {@link licenseRefresh}`.enabled = false`.
   *  2. **DETECTIVE usage metering.** Usage figures after each request —
   *     request id, model id, cache outcome, token counts and cost figures, tagged
   *     with an opaque machine seat id (section 5 of the LICENSE lists every field) —
   *     NEVER prompts, completions or provider credentials. Disable with
   *     {@link metering}`.enabled = false` (which does NOT disable renewal pickup).
   *
   * Both are best-effort and non-blocking: a slow or unreachable control plane
   * never blocks or breaks `generate()`. Get the key from your dashboard.
   */
  serviceAccountKey?: string;

  /**
   * Automatic licence-renewal pickup (on by default when {@link serviceAccountKey}
   * and {@link licenseServerUrl} are both set).
   *
   * Turning it OFF means you take responsibility for deploying the renewed token
   * each billing period; if nobody does, the SDK stops at the end of the grace
   * period even though the subscription is paid.
   */
  licenseRefresh?: {
    enabled?: boolean;
    /** Check cadence in ms (default 3600000 = 1 h). */
    intervalMs?: number;
    /** How long before expiry to start looking, seconds (default 7 days). */
    leadSeconds?: number;
  };

  /**
   * Usage-ingest URL. Defaults to `${licenseServerUrl}/api/metering/usage`. Set
   * explicitly to point metering at a different host than the revocation poller.
   */
  meteringUrl?: string;

  /** Injectable `fetch` for metering (defaults to {@link licenseFetch}, then global). */
  meteringFetch?: typeof fetch;

  /** DETECTIVE metering tuning (all optional). */
  metering?: {
    /**
     * Off switch for USAGE REPORTING even when {@link serviceAccountKey} is set
     * (default: on). It does NOT disable licence-renewal pickup — that has its
     * own switch, {@link licenseRefresh}`.enabled`, because turning off telemetry
     * must not silently stop your licence from renewing.
     */
    enabled?: boolean;
    /** Flush cadence in ms (default 15000). */
    flushIntervalMs?: number;
    /** Records per POST (default 50). */
    maxBatch?: number;
    /** Hard in-memory cap; oldest records dropped past it (default 1000). */
    maxBuffer?: number;
    /** Override the auto-derived machine seat id. */
    seatId?: string;
    /** Override CI auto-detection (CI/ephemeral seats are excluded from billable seats). */
    ci?: boolean;
    /** Optional org hint; the server derives the authoritative org from the key. */
    orgId?: string;
  };

  /** Opt-in A/B verification on your own traffic. Off by default. See VerificationSettings. */
  verification?: VerificationSettings;

  /**
   * Development-only escape hatch to run ungated, honored ONLY when building from
   * source (local dev, CI, benchmarks) — also via the `BVSALA_DEV_OPEN=1`
   * environment variable.
   *
   * IMPORTANT: this flag is **disabled in the published npm package**. The
   * distributed build hard-codes the licensing check on, so setting
   * `devUnlicensed` (or `BVSALA_DEV_OPEN`) there has NO effect — the layer still
   * requires a valid `licenseKey`. It is not a way to run the product for free.
   */
  devUnlicensed?: boolean;

  /** Per-model cost models; falls back to `defaultCostModel`. */
  costModels?: Record<string, CostModel>;
  defaultCostModel?: CostModel;

  /** TTL for exact-cache writes, in ms. */
  exactCacheTtlMs?: number;

  /**
   * Refuse the single repair retry when paying for it would push this request's
   * cost above what it would have cost WITHOUT the layer. The invalid answer is
   * then returned as-is with `constraints.structurallyValid: false`, plus a
   * warning naming the three figures.
   *
   * OFF by default, and the default is a deliberate, measured choice rather than
   * caution — read this before turning it on.
   *
   * The bound sounds narrow ("only the worst case") and is not. The baseline of
   * a call that ran is reconstructed EXCLUDING the repair (see `estimateCost`:
   * `actualInput - repairInput`), precisely so a retry cannot pay for itself in
   * the report. That makes the threshold unreachable by construction: the repair
   * only ever moves `actual`, never the baseline, so ANY repair breaches it
   * whenever the layer's other books came out flat. On a request where nothing
   * was compressed, cached or eliminated, `baseline === actual` exactly and the
   * gate suppresses every repair, however cheap.
   *
   * So this is not "cap the tail", it is "stop repairing unless the layer has
   * already banked more than the repair will cost". That is a real quality
   * policy, not a rounding rule, and it is the caller's contract to decide on —
   * hence opt-in.
   *
   * There is no threshold that fires on the pathological case and spares the
   * flat one; they are the same arithmetic at different magnitudes. And there is
   * a genuine argument on the other side: an answer that misses its contract is
   * a MODEL failure, so the no-layer path would have had to pay for its own
   * second call too — charging the whole retry against the layer compares one
   * valid answer to one invalid answer.
   *
   * Turn it on when a hard per-request ceiling matters more than contract
   * compliance — a batch backfill, a cost-capped tenant. Leave it off when the
   * caller relies on the shape being right.
   */
  skipRepairAboveBaseline?: boolean;

  /**
   * Reliability contract. When true (the default), ANY internal optimizer error
   * (a resolver, cache, format selector, compressor, or accounting bug) is
   * caught and the request falls open to a plain provider call — BV-SALA must
   * never add a crash point to the customer's request path. Set to `false` only
   * in tests/benchmarks that want internal errors to surface.
   */
  failOpen?: boolean;

  /**
   * Silence BV-SALA's console warnings. They are ON by default, and they only
   * ever report a condition whose symptom is otherwise invisible: a saving knob
   * asked for but not wired up, usage that stops reaching the control plane, a
   * revocation list going stale. Nothing here throws and nothing here changes
   * what the layer does — turning it on only removes the console noise, so set
   * it when you have your own observability. Applies to the pipeline, the usage
   * emitter and the revocation poller alike.
   */
  silenceWarnings?: boolean;
  /**
   * Load the exact OpenAI tokenizer (`gpt-tokenizer`, optional peer) into the
   * default registry when it is installed. ON by default: without it, every
   * saving where the layer removed something is reported as `estimated` and
   * never billed, and the SDK warns once. Set to `false` to keep the built-in
   * heuristic even when the package is present (tests calibrated on the
   * heuristic, or a process that must not spend the encoding's memory). Ignored
   * when you pass your own `tokenizer` registry: you decide what it contains.
   */
  exactTokenizer?: boolean;

  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable id generator for deterministic tests. */
  generateId?: () => string;
}

/**
 * Tuning for the model cascade. Everything here is optional, and the defaults
 * cost nothing: with no settings at all, `modelCascade: "shadow"` measures what
 * it can measure for free and makes no extra provider call.
 */
export interface ModelCascadeSettings {
  /**
   * Your own strong → cheap pairs, replacing the built-in table.
   *
   * Keys and values are model ids WITHOUT a vendor prefix (`"gpt-4o"`, not
   * `"openai/gpt-4o"`); the caller's prefix is carried over automatically, and a
   * dated snapshot inherits from its base id. A pair whose economics do not work
   * out at your prices is refused with a reason in the report — declaring it here
   * does not override the arithmetic.
   */
  pairs?: Record<string, string>;

  /**
   * How many requests of a workload are routed before the automatic shut-off
   * judges the measured escalation rate (default 20).
   *
   * The rate is only observable on requests that were actually routed, so there
   * is no way to know without spending a bounded amount to find out. Worst case
   * (every one of them escalates) that exploration costs `n x r` requests'
   * worth of extra spend, once per workload per process — with a ratio of 0.06
   * and the default, about 1.2 requests.
   */
  exploration?: number;

  /**
   * PRICED OPT-IN, default 0 (off). Fraction of `"shadow"` requests on which the
   * layer also calls the cheap model, purely to measure.
   *
   * Shadow mode is free precisely because it does not run the cheap model: it
   * reports eligibility, the arithmetic, and what the swap would have been worth.
   * What it cannot know for free is the one number that decides everything — how
   * often the deterministic gate would have REJECTED the cheap answer. That
   * answer does not exist until the cheap model writes one.
   *
   * So this buys it, and the price is exact: each sampled request costs one extra
   * cheap call, i.e. `r` of what the request already cost — about 6% for
   * gpt-4o → gpt-4o-mini. At `0.05` that is roughly 0.3% on top of your bill, and
   * every sampled request reports its own `modelCascade.sampleCost`. It also
   * DOUBLES that request's provider latency, because the extra call is sequential.
   *
   * The sampled request's tokens count as spend and are held out of the baseline,
   * exactly like the repair retry: measurement must never pay for itself.
   *
   * Which requests get sampled is derived from the request's own cache key, so it
   * is deterministic and stable — the same request is always sampled or always
   * not, and no `Math.random` decides how your money is spent.
   */
  shadowSampleRate?: number;
}

/**
 * Defaults for the provider price levers. Everything here is off unless you set it,
 * and a request's own `savings` value always wins over it.
 */
export interface PriceLeverSettings {
  /** Default for `savings.deferrable` on every request of this layer. A request's own value wins. Defaults to false. */
  deferrable?: boolean;
  /** Default for `savings.standalone`. A request's own value wins. Defaults to false. */
  standalone?: boolean;
  /**
   * When a deferrable request finds no capacity on the cheaper tier (HTTP 429 or 503):
   * "throw" (default) surfaces the error unchanged; "standard" repeats it once at the
   * standard tier and price.
   */
  onCapacityError?: "throw" | "standard";
}

export const DEFAULT_COST_MODEL: CostModel = {
  // Illustrative default (USD per 1K tokens); override per model in production.
  inputPer1k: 0.0005,
  outputPer1k: 0.0015,
  cachedInputPer1k: 0.00005,
};
