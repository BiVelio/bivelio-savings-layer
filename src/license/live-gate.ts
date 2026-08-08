import type { LicenseGate } from "../contracts/types.js";
import {
  verifyLicenseToken,
  deriveStatus,
  type LicenseStatus,
  type LicenseTokenPayload,
  type LicenseKeyset,
} from "./verify.js";
import type { RevocationSnapshot } from "./revocation.js";

/** A resolved gate that also exposes overall status + a refresh horizon. */
export interface ResolvedGate extends LicenseGate {
  isActive(): boolean;
  status(): LicenseStatus;
  /** Unix seconds after which the online status should be re-checked (poller anchor). */
  refreshAfter?(): number | undefined;
}

/**
 * Build a LIVE license gate from a signed key. The token is verified + decoded
 * ONCE (no per-request Ed25519 verify — hot-path safe); each `isActive()` /
 * `status()` / `isEntitled()` then re-derives the status from the cached payload +
 * the LIVE clock + the (mutable, sticky) {@link RevocationSnapshot}. This is what
 * lets a revocation — or an expiry crossed mid-process — take effect without a
 * restart, while the customer request path never touches the network (it reads an
 * in-memory Set).
 *
 * The offline path passes a fresh, never-updated snapshot (live clock, zero
 * network); the online path passes a snapshot a {@link RevocationPoller} feeds.
 */
export function liveGateFromKey(
  licenseKey: string,
  publicKey: string | LicenseKeyset,
  opts: {
    revocation: RevocationSnapshot;
    now?: () => number;
    /** Online staleness ceiling, seconds. If the gate goes this long without a
     *  confirmed authorized heartbeat, it stops granting (closes the block-egress
     *  fail-open). Undefined = check disabled (the offline path never sets it). */
    maxStalenessSeconds?: number;
    /** Freshness anchor (unix seconds); defaults to construction time (boot). */
    startedAt?: number;
  },
): ResolvedGate {
  const nowSeconds = (): number => Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const startedAt = opts.startedAt ?? nowSeconds();
  const v = verifyLicenseToken(licenseKey, publicKey);
  const payload: LicenseTokenPayload | undefined = v.signatureValid ? v.payload : undefined;
  const features = new Set<string>(payload?.features ?? []);

  const status = (): LicenseStatus => {
    if (!payload) return "invalid";
    const s = deriveStatus(payload, nowSeconds(), opts.revocation.snapshot());
    // Online staleness gate: without a confirmed authorized heartbeat for longer
    // than maxStalenessSeconds, stop granting — closing the fail-open window where
    // an adversary blocks egress to keep a revoked license alive until it naturally
    // expires. Anchored to boot so the fire-and-forget warm poll has a full window.
    // Reuses "expired" so the LicenseStatus union and every consumer are unchanged.
    if (opts.maxStalenessSeconds != null && (s === "active" || s === "grace")) {
      // El ancla de arranque da margen al primer sondeo, pero NO puede ser un
      // cheque en blanco: en serverless cada invocación es un proceso nuevo, así
      // que `startedAt` valía siempre "ahora" y la resta daba ~0 — la puerta no
      // podía dispararse jamás, que es justo el fail-open que venía a cerrar.
      //
      // Se acota con `issued_at`, que va FIRMADO dentro del token y por tanto no
      // se puede empujar hacia adelante: el arranque solo ayuda mientras la
      // licencia sea reciente. Una licencia vieja que nunca ha conseguido
      // contactar queda obsoleta por muchas veces que se reinicie el proceso.
      const techoPorEmision = payload.issued_at + opts.maxStalenessSeconds;
      const anclaArranque = Math.min(startedAt, techoPorEmision);
      const lastFresh = Math.max(opts.revocation.lastContactAt, anclaArranque);
      if (nowSeconds() - lastFresh > opts.maxStalenessSeconds) return "expired";
    }
    return s;
  };
  const granted = (): boolean => {
    const s = status();
    return s === "active" || s === "grace";
  };

  return {
    isEntitled: (feature: string) => granted() && features.has(feature),
    isActive: () => granted(),
    status,
    refreshAfter: () => {
      if (!payload) return undefined;
      // Anchor cadence to the token's own refresh horizon (mirrors
      // Entitlements.refreshAfter): re-check within a day, tightening near expiry.
      return Math.min(payload.expires_at, nowSeconds() + 86400);
    },
  };
}
