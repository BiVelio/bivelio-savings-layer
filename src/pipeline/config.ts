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
   * Signed BiVelio license token (from your paid subscription). This is the
   * primary way to license the SDK: `createSavingsLayer` verifies it offline
   * against the embedded public key and builds a {@link licenseGate} from it.
   * Without a valid, active license (and without {@link devUnlicensed}), the
   * pipeline refuses to run — get a key at https://savings.bivelio.com.
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
   * Pre-built license gate. Usually you pass {@link licenseKey} instead and let
   * the SDK construct this. Advanced/self-managed callers can inject their own
   * gate (e.g. `@bivelio/license-client`'s `createLicenseGate()`). When both are
   * given, `licenseGate` wins.
   */
  licenseGate?: LicenseGate;

  /**
   * OPT-IN online revocation call-home. When set (alongside {@link licenseKey} and
   * with no explicit {@link licenseGate}), the SDK polls this base's
   * `GET /licenses/revocations` for a signed revocation list and enforces it via a
   * LIVE gate — a license cancelled mid-term stops working without a restart.
   *
   * NEVER-BRICK: the customer request path never blocks on the fetch; the warm poll
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
     * ONLINE staleness ceiling, seconds (default ~6h). If the SDK goes this long
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
   *  2. **DETECTIVE usage metering.** COUNTS-ONLY usage after each request —
   *     request id, model, cache outcome, and token/cost counts, tagged with an
   *     auto-derived machine seat id — NEVER prompts or completions. Disable with
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

  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable id generator for deterministic tests. */
  generateId?: () => string;
}

export const DEFAULT_COST_MODEL: CostModel = {
  // Illustrative default (USD per 1K tokens); override per model in production.
  inputPer1k: 0.0005,
  outputPer1k: 0.0015,
  cachedInputPer1k: 0.00005,
};
