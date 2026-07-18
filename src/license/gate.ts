import type { LicenseGate } from "../contracts/types.js";
import { resolveLicense, type LicenseStatus } from "./verify.js";

/** A resolved gate that also exposes overall license status for entry-gating. */
export interface ResolvedGate extends LicenseGate {
  isActive(): boolean;
  status(): LicenseStatus;
}

/**
 * Build the SDK's structural {@link LicenseGate} from a signed license key.
 * Resolution happens once (offline) at layer creation: the token is verified and
 * its status frozen. `isActive()` is true while active or in grace; `isEntitled`
 * additionally requires the feature to be in the token's grant. This is the
 * object `createSavingsLayer({ licenseKey })` injects; the pipeline's entry gate
 * consults `isActive()`, and each managed feature consults `isEntitled(feature)`.
 */
export function gateFromKey(
  licenseKey: string,
  publicKeyPem: string,
  now?: () => number,
): ResolvedGate {
  const opts: { nowSeconds?: number } = {};
  if (now) opts.nowSeconds = Math.floor(now() / 1000);
  const resolved = resolveLicense(licenseKey, publicKeyPem, opts);
  const granted = resolved.status === "active" || resolved.status === "grace";
  const features = new Set(granted ? resolved.payload?.features ?? [] : []);
  return {
    isEntitled: (feature: string) => granted && features.has(feature),
    isActive: () => granted,
    status: () => resolved.status,
  };
}
