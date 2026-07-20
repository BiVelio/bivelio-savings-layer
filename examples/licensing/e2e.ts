/**
 * BV-SALA — end-to-end licensing demo (real HTTP, zero external infra). Run:
 *   pnpm demo:e2e
 *
 * This is the full paid lifecycle over a REAL localhost control plane + the REAL
 * SDK, so you can watch the whole thing work before Stripe drives issuance:
 *
 *   1. BiVelio control plane comes online
 *   2. A customer subscribes  → a license is issued
 *   3. The customer app runs  → BV-SALA optimizes the request (ALLOWED)
 *   4. The customer cancels    → BiVelio revokes the license
 *   5. The app calls home on its timer and stops working (DENIED)
 *   6. Never-brick: even if BiVelio is unreachable, a valid license keeps running
 *
 * It reveals NOTHING about how BV-SALA optimizes internally — only that a paid,
 * active license is required to run it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLicensingService } from "../../services/licensing/src/service.js";
import { createRequestHandler } from "../../services/licensing/src/app.js";
import { createSavingsLayer, createMockProvider, LicenseError } from "../../src/index.js";

const ADMIN = "demo-admin-token";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = () => console.log("─".repeat(78));
const step = (n: number, t: string) => console.log(`\nSTEP ${n} · ${t}`);

/** A neutral request — the point is licensing, not what BV-SALA does with it. */
const request = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "What is the capital of France?" }],
};

async function api(base: string, path: string, body: unknown, auth = false): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${ADMIN}` } : {}) },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function tryGenerate(layer: { generate: (r: typeof request) => Promise<unknown> }): Promise<string> {
  try {
    await layer.generate(request);
    return "✅ ALLOWED — BV-SALA optimized the request";
  } catch (err) {
    if (err instanceof LicenseError) return `⛔ DENIED  — ${err.message.split(".")[0]}`;
    throw err;
  }
}

async function main(): Promise<void> {
  console.log("\nBV-SALA — end-to-end licensing demo (real HTTP control plane)");
  line();

  // ── STEP 1: the BiVelio control plane comes online ────────────────────────
  step(1, "BiVelio licensing control plane comes online");
  const service = createLicensingService({}); // ephemeral signing key for the demo
  const server: Server = createServer(createRequestHandler(service, { adminToken: ADMIN }));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const publicKey = service.publicKey; // the SDK verifies offline with this key
  const health = await (await fetch(`${base}/health`)).json();
  console.log(`   ${base}  ·  GET /health → ${JSON.stringify(health)}`);

  // ── STEP 2: a customer subscribes → a license is issued ───────────────────
  step(2, "A customer subscribes → BiVelio issues a license  (POST /licenses/issue)");
  const issued = await api(base, "/licenses/issue", { orgId: "acme-inc", plan: "pro", seats: 5, termDays: 30, graceDays: 14 }, true);
  const licenseKey: string = issued.token;
  console.log(`   org=acme-inc · plan=pro · seats=5 · jti=${issued.payload.jti}`);
  console.log(`   license key: ${licenseKey.slice(0, 34)}…  (${licenseKey.length} chars)`);

  // ── STEP 3: the customer app runs → ALLOWED ───────────────────────────────
  step(3, "The customer app runs BV-SALA with that license");
  const layer = createSavingsLayer({
    provider: createMockProvider({ answer: "Paris." }),
    licenseKey,
    licensePublicKey: publicKey,
    licenseServerUrl: base, // the SDK calls home here on a timer
    licensePollIntervalSeconds: 1, // fast cadence for the demo (prod default: 15 min)
    licenseRevocation: { floorSeconds: 1 },
  });
  await sleep(150); // let the first automatic call-home settle
  console.log(`   layer.generate() → ${await tryGenerate(layer)}`);

  // ── STEP 4: the customer cancels → BiVelio revokes ────────────────────────
  step(4, "The customer cancels → BiVelio revokes the license  (POST /licenses/revoke)");
  const revoked = await api(base, "/licenses/revoke", { jti: issued.payload.jti }, true);
  console.log(`   ${JSON.stringify(revoked)}`);

  // ── STEP 5: the app calls home on its timer ───────────────────────────────
  step(5, "The app calls home on its timer (no restart)…");
  console.log("   waiting ~2.5s for the SDK's automatic revocation poll…");
  await sleep(2500);

  // ── STEP 6: license no longer valid → app refuses to run ──────────────────
  step(6, "License no longer active → the app refuses to run");
  console.log(`   layer.generate() → ${await tryGenerate(layer)}`);
  layer.close();

  // ── STEP 7: never-brick under a control-plane outage ──────────────────────
  step(7, "Never-brick: a valid license keeps working even if BiVelio is unreachable");
  const safe = await api(base, "/licenses/issue", { orgId: "beta-inc", plan: "team", seats: 3 }, true);
  const layer2 = createSavingsLayer({
    provider: createMockProvider({ answer: "Paris." }),
    licenseKey: safe.token,
    licensePublicKey: publicKey,
    licenseServerUrl: base,
    licensePollIntervalSeconds: 1,
    licenseRevocation: { floorSeconds: 1 },
  });
  await sleep(150);
  await new Promise<void>((r) => server.close(() => r())); // BiVelio goes dark
  console.log("   control plane STOPPED (network to BiVelio is down)…");
  await sleep(300);
  console.log(`   layer.generate() → ${await tryGenerate(layer2)}   (production never goes down)`);
  layer2.close();

  line();
  console.log("Result: pay → license → runs; cancel → stops in seconds; CP down → still runs.");
  console.log("Next: Stripe drives POST /licenses/issue automatically on a successful checkout.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
