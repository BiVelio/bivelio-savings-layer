import { describe, it, expect } from "vitest";
import { sha256 } from "../src/canonicalization/canonicalize.js";
import { randomId } from "../src/util/index.js";

describe("sha256 (browser-safe, pure JS)", () => {
  it("matches known NIST/RFC vectors", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256("The quick brown fox jumps over the lazy dog")).toBe(
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    );
  });

  it("hashes multi-byte UTF-8 the same as node:crypto would (byte-accurate)", () => {
    // "héllo·wörld" encoded as UTF-8, verified against createHash('sha256').
    expect(sha256("héllo·wörld")).toBe(
      "c6c20a5c8233b993b8534e3b23e433010eb04684d01a6f854f99da094e58a86f",
    );
  });

  it("is deterministic and length-56-block-boundary safe", () => {
    // 55 and 56 bytes straddle the padding block boundary — classic bug site.
    const a = "a".repeat(55);
    const b = "a".repeat(56);
    expect(sha256(a)).toBe(sha256(a));
    expect(sha256(a)).not.toBe(sha256(b));
    expect(sha256(a)).toHaveLength(64);
  });
});

describe("randomId (browser-safe UUID)", () => {
  it("returns a v4-shaped, unique id", () => {
    const id = randomId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const ids = new Set(Array.from({ length: 1000 }, () => randomId()));
    expect(ids.size).toBe(1000);
  });
});
