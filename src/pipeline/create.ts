import { defaultTokenizerRegistry } from "../tokenizer/registry.js";
import { MODELS_BY_ENCODING, registerExactTokenizer } from "../tokenizer/exact.js";
import { avisarUnaVez } from "../util/warn-once.js";
import type { SavingsRequest, SavingsResult } from "../contracts/types.js";
import { gateFromKey } from "../license/gate.js";
import { liveGateFromKey } from "../license/live-gate.js";
import { RevocationSnapshot } from "../license/revocation.js";
import { RevocationPoller } from "../license/poller.js";
import { LicenseRefresher } from "../license/refresher.js";
import { EMBEDDED_PUBLIC_KEY } from "../license/verify.js";
import { UsageEmitter } from "../metering/emitter.js";
import { deriveSeatId, detectCi } from "../metering/seat.js";
import { SavingsPipeline } from "./pipeline.js";
import type { SavingsLayerConfig } from "./config.js";

declare const __BV_SALA_ALLOW_DEV_OPEN__: boolean | undefined;

// Techo de frescura de la verja LIVE (72 h). Es un COMPROMISO puro: un cliente
// no distingue «un adversario me bloquea la salida para mantener viva una
// revocación» de «el control plane está caído», así que el único lever es el
// tiempo. Más corto cierra antes la ventana del egress bloqueado, pero apaga a
// clientes que PAGAN si NUESTRO control plane cae más de ese rato; más largo
// sobrevive a nuestras caídas a cambio de una ventana de evasión mayor. 72 h
// sobrevive a cualquier incidente realista y sigue muy por debajo de la
// caducidad natural (mensual = 30 d + 14 d de gracia), cuyo `expires_at` es el
// backstop último. Este comentario va en `//` a propósito: un JSDoc sobre el
// export viajaría al `dist/index.d.ts` público. Override:
// `licenseRevocation.maxStalenessSeconds`.
export const DEFAULT_MAX_STALENESS_SECONDS = 72 * 3600;

/**
 * El tokenizador EXACTO se carga UNA vez por proceso en el registro por defecto.
 *
 * Hasta hoy `registerExactTokenizer` existía, `gpt-tokenizer` era peer opcional
 * y el README lo anunciaba… y NADIE lo llamaba desde la fábrica: solo los
 * bancos y los tests. Un cliente que instalaba el peer seguía contando con el
 * heurístico, cada ahorro donde la capa quitó algo salía `estimated`, y
 * `estimated` nunca entra en el extracto. O sea que el peer "opcional" era, en
 * la práctica, inalcanzable desde `createSavingsLayer`.
 *
 * Memoizado a nivel de módulo porque el registro por defecto es un singleton:
 * cargar la codificación una vez por capa creada serían decenas de MB por capa.
 */
let cargaDelExacto: Promise<boolean> | undefined;

/** Modelos con tokenizador exacto disponible, con y sin prefijo `openai/`. */
const MODELOS_CON_EXACTO = new Set(
  Object.values(MODELS_BY_ENCODING).flatMap((ms) => ms.flatMap((m) => [m, `openai/${m}`])),
);

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
 * cache, a vector-backed semantic cache, a real tokenizer, a compressor sidecar,
 * XGrammar/llguidance backends, etc.).
 *
 * A `licenseKey` is not optional in practice: `generate()` is fail-closed and
 * throws {@link LicenseError} without one, so it belongs in the smallest example
 * there is.
 *
 * @example
 * // `licenseKey` is the signed token from savings.bivelio.com/dashboard/install,
 * // read from wherever you keep secrets (BIVELIO_LICENSE_KEY in the README).
 * const layer = createSavingsLayer({ provider, licenseKey });
 * const { text, report } = await layer.generate({
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
    // EN INGLÉS, como todo lo que ve el cliente. Salía en español a un paquete
    // publicado en npm y leído en cualquier parte del mundo: quien lo recibía no
    // sabía si era un aviso, un error o una traza, y encima llega justo cuando ya
    // está atascado con la licencia.
    console.warn(
      "[bvsala] Ignoring the injected `licenseGate`: in the published package a license is " +
        "only accepted as a `licenseKey` verified against BiVelio's embedded public key. " +
        "Get yours at https://savings.bivelio.com/dashboard/install",
    );
    config = { ...config, licenseGate: undefined };
  }

  const resolved: SavingsLayerConfig = {
    ...config,
    tokenizer: config.tokenizer ?? defaultTokenizerRegistry,
  };

  // Registro por defecto → intentamos el exacto. Un registro propio del
  // llamante se respeta tal cual: quien lo construye decide qué contiene.
  const exactoListo: Promise<boolean> =
    config.tokenizer == null && config.exactTokenizer !== false
      ? (cargaDelExacto ??= registerExactTokenizer(defaultTokenizerRegistry).catch(() => false))
      : Promise.resolve(true);

  let poller: RevocationPoller | undefined;
  let refresher: LicenseRefresher | undefined;

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
      const crearGate = (token: string) =>
        liveGateFromKey(token, publicKey, {
          revocation,
          ...(config.now ? { now: config.now } : {}),
          // Close the block-egress fail-open: stop granting after a max staleness with
          // no confirmed heartbeat. Only on this ONLINE path — the offline gate below
          // never sets it (zero-network deployments must omit licenseServerUrl).
          maxStalenessSeconds:
            config.licenseRevocation?.maxStalenessSeconds ?? DEFAULT_MAX_STALENESS_SECONDS,
        });
      // CONMUTABLE, no un gate congelado en la construcción. La renovación
      // mensual emite un token NUEVO y el viejo solo se supersede: muere en
      // expires_at + gracia. Con el gate atado al literal de la construcción,
      // todo cliente mensual que no re-pegara su token a mano se apagaba
      // fail-closed hacia el día ~45 de cada ciclo — pagando. El proxy delega en
      // el gate vigente y el refresher lo reemplaza al recoger (y verificar
      // contra la clave embebida) el token renovado.
      let gate = crearGate(config.licenseKey);
      resolved.licenseGate = {
        isEntitled: (feature: string) => gate.isEntitled(feature),
        isActive: () => gate.isActive(),
        status: () => gate.status(),
        reason: () => gate.reason(),
      };
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
        // Un solo interruptor para todos los avisos de la capa. Sin esto,
        // `silenceWarnings` callaría el pipeline y dejaría hablando al poller y
        // al emisor, que tienen el suyo propio y hasta aquí era inalcanzable
        // desde la configuración pública.
        ...(config.silenceWarnings != null ? { silenceWarnings: config.silenceWarnings } : {}),
        ...(config.licenseRevocation ?? {}),
      });
      poller.start();
      // Recogida automática del token renovado, autenticada con la clave de
      // servicio — la misma credencial de org que ya autentica el metering. Sin
      // clave de servicio no hay vía de recogida de máquina: queda el pull
      // manual del panel, como hasta ahora.
      if (config.serviceAccountKey && config.licenseRefresh?.enabled !== false) {
        refresher = new LicenseRefresher({
          url: `${config.licenseServerUrl.replace(/\/+$/, "")}/api/license/current`,
          serviceAccountKey: config.serviceAccountKey,
          publicKey,
          initialToken: config.licenseKey,
          // El MISMO snapshot que alimenta el gate, para que el refresher no
          // adopte un token ya revocado y tumbe una flota que funcionaba.
          revocados: revocation,
          onNewToken: (token) => {
            gate = crearGate(token);
          },
          ...(config.licenseFetch ? { fetchImpl: config.licenseFetch } : {}),
          ...(config.now ? { now: config.now } : {}),
          ...(config.licenseRefresh?.intervalMs != null
            ? { pollIntervalMs: config.licenseRefresh.intervalMs }
            : {}),
          ...(config.licenseRefresh?.leadSeconds != null
            ? { refreshLeadSeconds: config.licenseRefresh.leadSeconds }
            : {}),
        });
        refresher.start();
      }
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
    if (!meteringUrl && config.silenceWarnings !== true) {
      // Silently doing nothing was the failure mode: the customer pasted the
      // snippet, dropped `licenseServerUrl`, and got a layer that neither metered
      // nor picked up the renewed token — so the dashboard stayed empty and the
      // license died fail-closed at the end of the cycle, paid up. Say it once.
      console.warn(
        "[bvsala] `serviceAccountKey` is set but there is no `licenseServerUrl` (or `meteringUrl`): " +
          "seat metering and automatic license renewal are OFF, so nothing will reach your " +
          "dashboard and a renewed license will not be picked up. Add " +
          '`licenseServerUrl: "https://savings.bivelio.com"` — or drop `serviceAccountKey` for a ' +
          "zero-network deployment.",
      );
    }
    if (meteringUrl) {
      emitter = new UsageEmitter({
        url: meteringUrl,
        serviceAccountKey: config.serviceAccountKey,
        surface: "sdk",
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
        ...(config.silenceWarnings != null ? { silenceWarnings: config.silenceWarnings } : {}),
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
      // La primera petición espera a que el exacto esté (o no) cargado: sin esto
      // la primera medición de cada proceso saldría con el heurístico aunque el
      // peer estuviera instalado. Es un `import` local, sin red: milisegundos.
      const exacto = await exactoListo;
      const result = await pipeline.generate<T>(request);
      // Después de la petición, no antes: un llamante sin licencia debe ver el
      // error de licencia, no un aviso sobre el tokenizador.
      if (!exacto && config.silenceWarnings !== true && MODELOS_CON_EXACTO.has(request.model)) {
        avisarUnaVez(
          "tokenizador-exacto-ausente",
          "[bvsala] `gpt-tokenizer` is not installed, so token counts for OpenAI models are " +
            "ESTIMATED with a built-in heuristic and the reconstructed savings are less accurate. " +
            "Savings where the layer removed something are reported as `estimated` either way, " +
            "and estimated savings are never billed. Install it once (`npm i gpt-tokenizer`) and " +
            "the SDK loads it automatically.",
        );
      }
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
      refresher?.stop();
      emitter?.stop();
    },
  };
}
