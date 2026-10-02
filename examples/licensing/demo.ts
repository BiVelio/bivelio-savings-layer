/**
 * License enforcement demo (fail-closed). Run: pnpm license:demo
 *
 * Proves the paid model end-to-end, with ZERO infrastructure: it mints its own
 * license tokens in-process (ephemeral keypair) and runs the real SDK against
 * each, so you can see exactly when `generate()` is allowed vs refused.
 *
 *   • no license key   → DENIED (LicenseError)   ← the "download ⇒ must pay" wall
 *   • valid license    → ALLOWED, features unlocked
 *   • expired license  → DENIED
 *   • tampered token   → DENIED (bad signature)
 *
 * The signing here mirrors the control-plane's `@bivelio/license-client`
 * `signLicense`; the SDK verifies it offline with the embedded/overridden public
 * key. (Mid-term revocation is enforced by the online call-home follow-up.)
 */
import { generateKeyPairSync, sign } from "node:crypto";
import {
  createSavingsLayer,
  createMockProvider,
  LicenseError,
} from "../../src/index.js";
import { resolveLicense } from "../../src/license/index.js";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Mint a signed BV-SALA license token (same wire format as the licensing service). */
function signToken(payload: Record<string, unknown>, privateKeyPem: string): string {
  const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "BVL", v: 1 }));
  const body = b64url(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(`${head}.${body}`), privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const now = Math.floor(Date.now() / 1000);
const base = {
  org_id: "acme-inc",
  plan: "pro",
  seats: 5,
  features: ["semantic_cache", "dashboards"],
  issued_at: now,
  iss: "bivelio-demo",
};
const validToken = signToken({ ...base, jti: "lic_valid", expires_at: now + 30 * 86400, grace_days: 14 }, privateKey);
const expiredToken = signToken({ ...base, jti: "lic_expired", expires_at: now - 86400, grace_days: 0 }, privateKey);
const tamperedToken = `${validToken.slice(0, -6)}AAAAAA`; // corrupt the signature segment

const request = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "What is 2 + 2 * 3?" }],
};

async function attempt(label: string, licenseKey?: string): Promise<void> {
  const layer = createSavingsLayer({
    provider: createMockProvider({ answer: "unused — resolver answers locally" }),
    licensePublicKey: publicKey,
    ...(licenseKey ? { licenseKey } : {}),
  });
  const status = licenseKey ? resolveLicense(licenseKey, publicKey).status : "none";
  try {
    const { text } = await layer.generate(request);
    console.log(`  ✅ ALLOWED  | ${label.padEnd(22)} | status=${status.padEnd(8)} | answer="${text}"`);
  } catch (err) {
    if (err instanceof LicenseError) {
      console.log(`  ⛔ DENIED   | ${label.padEnd(22)} | status=${status.padEnd(8)} | ${err.message.split(".")[0]}`);
    } else {
      throw err;
    }
  }
}

console.log("\nBV-SALA — fail-closed license enforcement demo\n" + "─".repeat(78));
await attempt("no license key"); // undefined → wall
await attempt("valid pro (30d)", validToken);
await attempt("expired (−1d, 0 grace)", expiredToken);
await attempt("tampered signature", tamperedToken);
console.log("─".repeat(78));
console.log("Dev escape hatch: { devUnlicensed: true } or BVSALA_DEV_OPEN=1 → ungated (dev/CI/web demo).");
console.log("Revocation (cancel mid-term) lands with the online call-home follow-up.\n");
