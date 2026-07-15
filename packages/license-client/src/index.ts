/**
 * @bivelio/license-client
 * PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
 *
 * Offline license verification + entitlements for the BV-SALA SDK. Verifies a
 * signed token against the licensing service's public key, applies the
 * grace-period degrade policy, and exposes a LicenseGate the SDK pipeline uses
 * to gate managed features (semantic cache, learned thresholds, …).
 */
export * from "./token.js";
export * from "./client.js";
export type {
  Entitlements,
  Feature,
  LicensePayload,
  LicenseStatus,
  Plan,
} from "@bivelio/protocol";
