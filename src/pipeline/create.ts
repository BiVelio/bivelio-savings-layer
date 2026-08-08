import { defaultTokenizerRegistry } from "../tokenizer/registry.js";
import type { SavingsRequest, SavingsResult } from "../contracts/types.js";
import { gateFromKey } from "../license/gate.js";
import { liveGateFromKey } from "../license/live-gate.js";
import { RevocationSnapshot } from "../license/revocation.js";
import { RevocationPoller } from "../license/poller.js";
import { EMBEDDED_PUBLIC_KEY } from "../license/verify.js";
import { UsageEmitter } from "../metering/emitter.js";
import { deriveSeatId, detectCi } from "../metering/seat.js";
import { SavingsPipeline } from "./pipeline.js";
import type { SavingsLayerConfig } from "./config.js";

declare const __BV_SALA_ALLOW_DEV_OPEN__: boolean | undefined;

/**
 * Default online-staleness ceiling for the LIVE gate (6h). Well above the poll
 * cadence + backoff (max ~1h) so a transient CP/network outage never trips it,
 * but bounded so blocking egress can't keep a revoked license alive for its full
 * remaining term. Override via `licenseRevocation.maxStalenessSeconds`.
 */
const DEFAULT_MAX_STALENESS_SECONDS = 6 * 3600;

/** The public handle returned by {@link createSavingsLayer}. */
export interface SavingsLayer {
  generate<T = unknown>(request: SavingsRequest): Promise<SavingsResult<T>>;
  /**
   * Stop the background revocation poller (when the online call-home was enabled
   * via `licenseServerUrl`) and abort any in-flight request. Always safe to call —
   * a no-op when there is no poller. Call it when shutting down a long-running
   * process so the interval timer and any pending fetch are released.
   */
  close(): void;
}

/**
 * Create a savings layer. The only hard requirement is a `provider`; a default
 * heuristic tokenizer and in-memory implementations of every other component
 * are wired automatically. Replace any of them for production (Redis exact
 * cache, pgvector/Qdrant semantic cache, a real tokenizer, an LLMLingua sidecar,
 * XGrammar/llguidance backends, etc.).
 *
 * @example
 * const layer = createSavingsLayer({ provider: createMockProvider() });
 * const { data, report } = await layer.generate({
 *   model: "openai/gpt-4o-mini",
 *   messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
 * });
 */
export function createSavingsLayer(
  config: Omit<SavingsLayerConfig, "tokenizer"> &
    Partial<Pick<SavingsLayerConfig, "tokenizer">>,
): SavingsLayer {
  // En el paquete PUBLICADO se descarta cualquier `licenseGate` inyectado por el
  // llamante. Era la vía MÁS FÁCIL de saltarse el pago —más aún que la clave
  // falsa que ya cerramos, porque no exige ni firmar un token—: bastaba
  // `createSavingsLayer({ provider, licenseGate: { isActive: () => true } })`.
  // El único camino de licencia válido en el paquete publicado es un `licenseKey`
  // verificado contra la clave EMBEBIDA. Desde el fuente (tests, benchmarks) la
  // bandera es undefined → se respeta el gate inyectado, que es como los tests
  // montan sus escenarios.
  const buildPublicado =
    typeof __BV_SALA_ALLOW_DEV_OPEN__ !== "undefined" && __BV_SALA_ALLOW_DEV_OPEN__ === false;
  if (buildPublicado && config.licenseGate) {
    console.warn(
      "[bvsala] Se ignora el `licenseGate` inyectado: en el paquete publicado la " +
        "licencia solo se acepta vía `licenseKey` verificado contra la clave de BiVelio.",
    );
    config = { ...config, licenseGate: undefined };
  }

  const resolved: SavingsLayerConfig = {
    ...config,
    tokenizer: config.tokenizer ?? defaultTokenizerRegistry,
  };

  let poller: RevocationPoller | undefined;

  // Ergonomic path: a raw `licenseKey` string is verified offline and turned into
  // a gate here. An explicitly-provided `licenseGate` takes precedence (advanced).
  if (config.licenseKey && !config.licenseGate) {
    // La clave EMBEBIDA gana siempre que exista. Antes era
    // `config.licensePublicKey ?? EMBEDDED`, así que un atacante pasaba su propia
    // clave pública, firmaba una licencia con su privada y el layer la aceptaba:
    // el paywall roto con un campo de configuración. En el paquete publicado la
    // clave va embebida (tsup define), así que el override queda ignorado. Solo
    // cuando NO hay clave embebida —un build de desarrollo sin fijarla— se admite
    // que el llamante pase una, que es lo que necesitan los tests con su par de
    // prueba. Un cliente que de verdad quiera su propia autoridad de licencias es
    // un caso enterprise, fuera de v0.1.
    const publicKey = EMBEDDED_PUBLIC_KEY || config.licensePublicKey || "";
    if (config.licenseServerUrl) {
      // ONLINE path: a LIVE gate over a sticky snapshot fed by a background poller.
      // The customer request path never touches the network; the warm poll is fired
      // (not awaited) so a control plane that is down at boot cannot brick or delay
      // the first generate().
      const revocation = new RevocationSnapshot();
      const gate = liveGateFromKey(config.licenseKey, publicKey, {
        revocation,
        ...(config.now ? { now: config.now } : {}),
        // Close the block-egress fail-open: stop granting after a max staleness with
        // no confirmed heartbeat. Only on this ONLINE path — the offline gate below
        // never sets it (zero-network deployments must omit licenseServerUrl).
        maxStalenessSeconds:
          config.licenseRevocation?.maxStalenessSeconds ?? DEFAULT_MAX_STALENESS_SECONDS,
      });
      resolved.licenseGate = gate;
      // `licenseServerUrl` is a BASE url (e.g. https://savings.bivelio.com); the SDK
      // owns the endpoint path so callers never hardcode it.
      const revocationsUrl = `${config.licenseServerUrl.replace(/\/+$/, "")}/licenses/revocations`;
      poller = new RevocationPoller({
        url: revocationsUrl,
        publicKeyPem: publicKey,
        snapshot: revocation,
        getRefreshAfter: () => gate.refreshAfter?.(),
        ...(config.now ? { nowSeconds: () => Math.floor(config.now!() / 1000) } : {}),
        ...(config.licenseFetch ? { fetchImpl: config.licenseFetch } : {}),
        ...(config.licensePollIntervalSeconds != null
          ? { pollIntervalSeconds: config.licensePollIntervalSeconds }
          : {}),
        ...(config.licenseRevocation ?? {}),
      });
      poller.start();
    } else {
      // OFFLINE path: live-clock gate, zero network. Still enforces expiry
      // mid-process (no restart needed), just with no revocation source.
      resolved.licenseGate = gateFromKey(config.licenseKey, publicKey, config.now);
    }
  }

  const pipeline = new SavingsPipeline(resolved);

  // DETECTIVE usage metering (opt-in via `serviceAccountKey`). Counts-only,
  // best-effort, and NON-BLOCKING — it can neither block nor break `generate()`.
  let emitter: UsageEmitter | undefined;
  if (config.serviceAccountKey && config.metering?.enabled !== false) {
    const meteringUrl =
      config.meteringUrl ??
      (config.licenseServerUrl
        ? `${config.licenseServerUrl.replace(/\/+$/, "")}/api/metering/usage`
        : undefined);
    if (meteringUrl) {
      emitter = new UsageEmitter({
        url: meteringUrl,
        serviceAccountKey: config.serviceAccountKey,
        ...(config.metering?.orgId ? { orgId: config.metering.orgId } : {}),
        ...(config.metering?.flushIntervalMs != null
          ? { flushIntervalMs: config.metering.flushIntervalMs }
          : {}),
        ...(config.metering?.maxBatch != null ? { maxBatch: config.metering.maxBatch } : {}),
        ...(config.metering?.maxBuffer != null ? { maxBuffer: config.metering.maxBuffer } : {}),
        ...(config.meteringFetch
          ? { fetchImpl: config.meteringFetch }
          : config.licenseFetch
            ? { fetchImpl: config.licenseFetch }
            : {}),
        ...(config.now ? { now: config.now } : {}),
        ...(config.metering?.ci != null ? { ci: config.metering.ci } : {}),
      });
      const ci = config.metering?.ci ?? detectCi();
      if (config.metering?.seatId) {
        emitter.setSeat(config.metering.seatId, ci);
      } else {
        // Async, universal seat derivation. Records buffered before it resolves
        // are stamped at flush time, so none are lost.
        const em = emitter;
        void deriveSeatId(config.serviceAccountKey)
          .then((sid) => em.setSeat(sid, ci))
          .catch(() => {});
      }
      emitter.start();
    }
  }

  return {
    // `pipeline` NO se expone: layer.pipeline.generateOptimized() corría el
    // optimizador entero saltándose assertLicensed(). El único punto de entrada
    // público es generate(), que sí gatea.
    generate: async <T = unknown>(request: SavingsRequest): Promise<SavingsResult<T>> => {
      const result = await pipeline.generate<T>(request);
      if (emitter) {
        try {
          emitter.record(result.report);
        } catch {
          /* metering must never affect the caller */
        }
      }
      return result;
    },
    close: () => {
      poller?.stop();
      emitter?.stop();
    },
  };
}
