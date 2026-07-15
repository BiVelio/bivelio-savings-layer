import { describe, it, expect } from "vitest";
import {
  InMemoryExactCache,
  Singleflight,
  InMemorySemanticCache,
  cosine,
  canonicalize,
} from "../src/index.js";
import type { SavingsRequest } from "../src/index.js";

describe("InMemoryExactCache", () => {
  it("stores and retrieves; honors TTL", async () => {
    let now = 1000;
    const cache = new InMemoryExactCache({ now: () => now });
    await cache.set("k", { text: "v", storedAtMs: now }, 100);
    expect((await cache.get("k"))?.text).toBe("v");
    now = 1101;
    expect(await cache.get("k")).toBeNull();
  });

  it("evicts oldest beyond maxEntries", async () => {
    const cache = new InMemoryExactCache({ maxEntries: 2 });
    await cache.set("a", { text: "a", storedAtMs: 0 });
    await cache.set("b", { text: "b", storedAtMs: 0 });
    await cache.set("c", { text: "c", storedAtMs: 0 });
    expect(await cache.get("a")).toBeNull();
    expect((await cache.get("c"))?.text).toBe("c");
  });
});

describe("Singleflight", () => {
  it("coalesces concurrent calls onto a single execution", async () => {
    const sf = new Singleflight();
    let executions = 0;
    const fn = async () => {
      executions++;
      await new Promise((r) => setTimeout(r, 10));
      return "result";
    };
    const results = await Promise.all([
      sf.run("k", fn),
      sf.run("k", fn),
      sf.run("k", fn),
    ]);
    expect(executions).toBe(1);
    expect(results.filter((r) => r.coalesced).length).toBe(2);
    expect(results.every((r) => r.value === "result")).toBe(true);
  });
});

describe("cosine", () => {
  it("is 1 for identical vectors and 0 for orthogonal", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
});

describe("InMemorySemanticCache — safety filters", () => {
  const embed = (t: string) =>
    // toy embedding: char-code histogram over a few buckets
    Array.from({ length: 8 }, (_, i) =>
      [...t].filter((c) => c.charCodeAt(0) % 8 === i).length,
    );

  function canon(text: string, tenantId: string): ReturnType<typeof canonicalize> {
    const request: SavingsRequest = { model: "m", messages: [{ role: "user", content: text }], context: { tenantId } };
    return canonicalize(request);
  }

  it("never returns a hit from another tenant", async () => {
    const cache = new InMemorySemanticCache({ embed, similarityThreshold: 0, acceptThreshold: 0 });
    await cache.store(canon("capital of france", "t1"), { text: "Paris", storedAtMs: 0 });
    const hit = await cache.find(canon("capital of france", "t2"));
    expect(hit).toBeNull();
  });

  it("returns a verified hit within the same tenant", async () => {
    const cache = new InMemorySemanticCache({ embed, similarityThreshold: 0.5, acceptThreshold: 0.5 });
    await cache.store(canon("capital of france", "t1"), { text: "Paris", storedAtMs: 0 });
    const hit = await cache.find(canon("capital of france", "t1"));
    expect(hit?.record.answer.text).toBe("Paris");
  });

  it("invalidates an entire knowledge epoch", async () => {
    const cache = new InMemorySemanticCache({ embed, similarityThreshold: 0, acceptThreshold: 0 });
    const request: SavingsRequest = { model: "m", messages: [{ role: "user", content: "x" }], context: { tenantId: "t", knowledgeEpoch: "e1" } };
    await cache.store(canonicalize(request), { text: "v", storedAtMs: 0 });
    expect(cache.invalidateEpoch("e1")).toBe(1);
    expect(cache.size).toBe(0);
  });
});
