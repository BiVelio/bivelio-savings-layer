import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";

import { signRevocationList, revocationEtag } from "../apps/web/lib/license/sign.js";
import { verifyRevocationList } from "../src/index.js";

/**
 * The Vercel route (`apps/web/app/licenses/revocations/route.ts`) signs the list
 * with these helpers. This proves the token it produces is byte-compatible with
 * the SDK's offline verifier — same typ, seq, asOf, and revoked set.
 */
describe("web revocation route — signing helper", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const BASE = 1_800_000_000;

  it("signs a list the SDK's verifyRevocationList accepts", () => {
    const token = signRevocationList({ asOf: BASE, seq: 3, revoked: ["a", "b"] }, privateKey);
    const v = verifyRevocationList(token, publicKey, { nowSeconds: BASE, minSeq: 0 });
    expect(v.ok).toBe(true);
    expect(v.seq).toBe(3);
    expect(v.asOf).toBe(BASE);
    expect([...v.revoked].sort()).toEqual(["a", "b"]);
  });

  it("is rejected by the SDK when seq rolls back (monotonic guard)", () => {
    const token = signRevocationList({ asOf: BASE, seq: 2, revoked: ["a"] }, privateKey);
    expect(verifyRevocationList(token, publicKey, { nowSeconds: BASE, minSeq: 5 }).ok).toBe(false);
  });

  it("emits the same ETag shape as the control-plane server", () => {
    expect(revocationEtag(0)).toBe('W/"revoc-0"');
    expect(revocationEtag(42)).toBe('W/"revoc-42"');
  });
});
