/**
 * Revocation call-home demo (fail-closed, ZERO infrastructure). Run:
 *   pnpm example:revocation
 *
 * Shows a running SDK flip from ALLOWED to DENIED the moment the control plane
 * revokes a license mid-term — WITHOUT a restart and WITHOUT ever bricking on a
 * control-plane outage. It mints its own license + signed revocation lists
 * in-process (ephemeral keypair) and serves the list through an injected `fetch`,
 * so you see the exact production chain:
 *
 *   signed revocation list → poller → sticky snapshot → live gate → generate()
 *
 * In production you just pass `{ licenseKey, licenseServerUrl }` to
 * createSavingsLayer and the SDK runs this poller for you; here we build the same
 * pieces explicitly so the demo can trigger a poll on demand and stay deterministic.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import {
  createSavingsLayer,
  createMockProvider,
  LicenseError,
  RevocationSnapshot,
  RevocationPoller,
  liveGateFromKey,
} from "../../src/index.js";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function signCompact(header: object, payload: object, privateKeyPem: string): string {
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(`${head}.${body}`), privateKeyPem);
  return `${head}.${body}.${b64url(sig)}`;
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const now = Math.floor(Date.now() / 1000);
const jti = "lic_demo";
const license = signCompact(
  { alg: "EdDSA", typ: "BVL", v: 1 },
  { jti, org_id: "acme", plan: "pro", seats: 5, features: ["semantic_cache"], issued_at: now, expires_at: now + 30 * 86400, grace_days: 14 },
  privateKey,
);

// A mutable, in-memory "control plane" revocation list, served through fetch.
let seq = 0;
let revoked: string[] = [];
const signedList = (): string =>
  signCompact(
    { alg: "EdDSA", typ: "BVSALA-REVOC", v: 1 },
    { v: 1, asOf: Math.floor(Date.now() / 1000), seq, revoked },
    privateKey,
  );
const fetchImpl = (async () =>
  new Response(JSON.stringify({ list: signedList() }), { status: 200 })) as unknown as typeof fetch;

// The exact objects createSavingsLayer builds internally on the online path.
const snapshot = new RevocationSnapshot();
const gate = liveGateFromKey(license, publicKey, { revocation: snapshot });
const poller = new RevocationPoller({ url: "memory://revocations", publicKeyPem: publicKey, snapshot, fetchImpl });
const layer = createSavingsLayer({ provider: createMockProvider({ answer: "Paris." }), licenseGate: gate });

const request = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "What is the capital of France?" }],
};

async function attempt(label: string): Promise<void> {
  try {
    const res = await layer.generate(request);
    console.log(`  ✅ ALLOWED  | ${label.padEnd(30)} | status=${gate.status().padEnd(8)} | answer="${res.text}"`);
  } catch (err) {
    if (err instanceof LicenseError) {
      console.log(`  ⛔ DENIED   | ${label.padEnd(30)} | status=${gate.status().padEnd(8)} | ${err.message.split(".")[0]}`);
    } else {
      throw err;
    }
  }
}

console.log("\nBV-SALA — revocation call-home demo (never-brick, fail-closed)\n" + "─".repeat(84));
await poller.pollOnce();
await attempt("active license, poll #1");

// The control plane cancels the subscription mid-term.
seq = 1;
revoked = [jti];
await poller.pollOnce();
await attempt("after revoke, poll #2");

// Sticky + never-brick: even if the CP goes dark now, the known revocation holds.
poller.stop();
await attempt("CP offline after revoke");

console.log("─".repeat(84));
console.log("Production: pass { licenseKey, licenseServerUrl } — the SDK runs this poller for you.");
console.log("A failed/unreachable poll is a no-op (keeps last-known-good); expiry is enforced offline.\n");
