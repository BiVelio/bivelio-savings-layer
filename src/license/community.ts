import type { LicenseGate } from "../contracts/types.js";

/**
 * THE COMMUNITY GATE — the open-core default.
 *
 * BV-SALA runs on this gate when `createSavingsLayer` is called WITHOUT a
 * `licenseKey` (and no gate is injected). It grants every LOCAL capability:
 * exact and semantic caching, request coalescing, model cascade, prompt and
 * tool-output compression, prompt-cache placement, resolvers, output contracts
 * and the four savings ledgers. Nothing is metered to BiVelio and nothing
 * phones home: usage metering, license renewal and team features only exist
 * when a `serviceAccountKey` is configured.
 *
 * What a license key still adds (the paid product, when you want it):
 *   - cloud dashboard + team-shared savings (metering ingest),
 *   - automatic license renewal and revocation checks,
 *   - org-wide entitlements (shared semantic caches, central policy),
 *   - Enterprise support contracts.
 *
 * The gate answers exactly like an active license so that the pipeline's
 * fail-closed entry check, which throws without an ACTIVE gate, keeps its
 * teeth for the paid paths: an invalid or expired `licenseKey` still throws
 * `LicenseError` — only the ABSENCE of a key is now a fully working product,
 * not an error. This is deliberate: the free tier must be the whole savings
 * layer, or there is nothing to adopt.
 *
 * This module is internal: it is never exported from the package root.
 */
export function communityGate(): LicenseGate {
  return {
    isActive: () => true,
    status: () => "active",
    reason: () => undefined,
    isEntitled: () => true,
    plan: () => "community",
  };
}
