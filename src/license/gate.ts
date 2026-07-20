import { liveGateFromKey, type ResolvedGate } from "./live-gate.js";
import { RevocationSnapshot } from "./revocation.js";

/**
 * Build the SDK's structural {@link import("../contracts/types.js").LicenseGate}
 * from a signed license key — the object `createSavingsLayer({ licenseKey })`
 * injects on the OFFLINE path (no `licenseServerUrl`).
 *
 * It is a LIVE gate over an EMPTY, never-updated revocation snapshot: zero network,
 * but the clock is LIVE, so a license that crosses its expiry (past grace) stops
 * working mid-process instead of only after a restart — closing the frozen-clock
 * hole the old one-shot resolution left open. `isActive()` is true while active or
 * in grace; `isEntitled` additionally requires the feature in the token's grant.
 * Online revocation is added by pairing {@link liveGateFromKey} with a
 * poller-fed snapshot (see src/pipeline/create.ts + poller.ts).
 */
export function gateFromKey(
  licenseKey: string,
  publicKeyPem: string,
  now?: () => number,
): ResolvedGate {
  return liveGateFromKey(licenseKey, publicKeyPem, {
    revocation: new RevocationSnapshot(),
    ...(now ? { now } : {}),
  });
}
