import type { LicenseGate } from "../contracts/types.js";
import {
  verifyLicenseToken,
  deriveStatus,
  type LicenseStatus,
  type LicenseTokenPayload,
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
  publicKeyPem: string,
  opts: { revocation: RevocationSnapshot; now?: () => number },
): ResolvedGate {
  const nowSeconds = (): number => Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const v = verifyLicenseToken(licenseKey, publicKeyPem);
  const payload: LicenseTokenPayload | undefined = v.signatureValid ? v.payload : undefined;
  const features = new Set<string>(payload?.features ?? []);

  const status = (): LicenseStatus => {
    if (!payload) return "invalid";
    return deriveStatus(payload, nowSeconds(), opts.revocation.snapshot());
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
