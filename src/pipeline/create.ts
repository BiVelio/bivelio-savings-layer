import { defaultTokenizerRegistry } from "../tokenizer/registry.js";
import type { SavingsRequest, SavingsResult } from "../contracts/types.js";
import { gateFromKey } from "../license/gate.js";
import { liveGateFromKey } from "../license/live-gate.js";
import { RevocationSnapshot } from "../license/revocation.js";
import { RevocationPoller } from "../license/poller.js";
import { EMBEDDED_PUBLIC_KEY } from "../license/verify.js";
import { SavingsPipeline } from "./pipeline.js";
import type { SavingsLayerConfig } from "./config.js";

/** The public handle returned by {@link createSavingsLayer}. */
export interface SavingsLayer {
  generate<T = unknown>(request: SavingsRequest): Promise<SavingsResult<T>>;
  readonly pipeline: SavingsPipeline;
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
  const resolved: SavingsLayerConfig = {
    ...config,
    tokenizer: config.tokenizer ?? defaultTokenizerRegistry,
  };

  let poller: RevocationPoller | undefined;

  // Ergonomic path: a raw `licenseKey` string is verified offline and turned into
  // a gate here. An explicitly-provided `licenseGate` takes precedence (advanced).
  if (config.licenseKey && !config.licenseGate) {
    const publicKey = config.licensePublicKey ?? EMBEDDED_PUBLIC_KEY;
    if (config.licenseServerUrl) {
      // ONLINE path: a LIVE gate over a sticky snapshot fed by a background poller.
      // The customer request path never touches the network; the warm poll is fired
      // (not awaited) so a control plane that is down at boot cannot brick or delay
      // the first generate().
      const revocation = new RevocationSnapshot();
      const gate = liveGateFromKey(config.licenseKey, publicKey, {
        revocation,
        ...(config.now ? { now: config.now } : {}),
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
  return {
    pipeline,
    generate: (request) => pipeline.generate(request),
    close: () => poller?.stop(),
  };
}
