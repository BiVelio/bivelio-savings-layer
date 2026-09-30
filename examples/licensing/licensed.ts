/**
 * Run the SDK with a REAL license key. Run:
 *   BIVELIO_LICENSE_KEY=<token> pnpm example:licensed
 *
 * Paste a token minted by the licensing service (`POST /licenses/issue`) or by
 * the dashboard's "Get a 14-day trial key" button. This example verifies it with
 * the committed project public key (`keys/license.pub.pem`) — the same key the
 * published SDK embeds — so it exercises the exact production verification path.
 *
 * With a valid key the request runs; without one (or with an expired/invalid
 * key) the SDK refuses with a LicenseError — the paid wall in action.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createSavingsLayer,
  createMockProvider,
  LicenseError,
} from "../../src/index.js";
import { resolveLicense } from "../../src/license/index.js";

const licenseKey = process.env.BIVELIO_LICENSE_KEY;
if (!licenseKey) {
  console.error("Set BIVELIO_LICENSE_KEY=<token>. Get one from the dashboard trial button or POST /licenses/issue.");
  process.exit(1);
}

// Prefer an explicit env key; else the committed project public key.
const publicKey =
  process.env.BV_SALA_LICENSE_PUBLIC_KEY ??
  readFileSync(fileURLToPath(new URL("../../keys/license.pub.pem", import.meta.url)), "utf8");

const resolved = resolveLicense(licenseKey, publicKey);
console.log(`\nlicense status: ${resolved.status}` + (resolved.payload ? ` · org=${resolved.payload.org_id} · plan=${resolved.payload.plan} · features=[${resolved.payload.features.join(", ")}]` : ` · ${resolved.reason ?? ""}`));

const layer = createSavingsLayer({
  provider: createMockProvider({ answer: "Paris." }),
  licenseKey,
  licensePublicKey: publicKey,
});

try {
  const res = await layer.generate({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "What is the capital of France?" }],
  });
  console.log(`✅ ALLOWED — answer="${res.text}" · cache=${res.report.cache.result}\n`);
} catch (err) {
  if (err instanceof LicenseError) {
    console.log(`⛔ DENIED — ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}
