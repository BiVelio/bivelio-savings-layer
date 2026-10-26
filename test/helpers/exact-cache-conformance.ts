import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import type { ExactCache } from "../../src/cache/exact.js";

export function describeExactCacheConformance(
  name: string,
  create: () => ExactCache | Promise<ExactCache>,
  key: (suffix: string) => string = (suffix) => `conformance-${suffix}-${randomUUID()}`,
): void {
  describe(name, () => {
    let cache: ExactCache;

    beforeEach(async () => {
      cache = await create();
    });

    it("returns a miss for an absent key and a complete value after set", async () => {
      const cacheKey = key("round-trip");
      const value = {
        text: "answer",
        data: { items: ["one"], nested: { valid: true } },
        rendered: "<p>answer</p>",
        storedAtMs: 123,
        meta: { reference: { cacheKey: "reference-key" } },
      };
      expect(await cache.get(cacheKey)).toBeNull();
      await cache.set(cacheKey, value);
      expect(await cache.get(cacheKey)).toEqual(value);
    });

    it("isolates mutations made by the writer and by each reader", async () => {
      const cacheKey = key("copies");
      const original = { text: "answer", data: { items: ["one"] }, storedAtMs: 123 };
      await cache.set(cacheKey, original);
      original.data.items.push("writer");
      const first = await cache.get<typeof original.data>(cacheKey);
      expect(first?.data).toEqual({ items: ["one"] });
      first!.data!.items.push("reader");
      expect((await cache.get(cacheKey))?.data).toEqual({ items: ["one"] });
    });

    it("expires entries and keeps entries without a TTL", async () => {
      const expiring = key("expiring");
      const persistent = key("persistent");
      await cache.set(expiring, { text: "short", storedAtMs: 1 }, 20);
      await cache.set(persistent, { text: "long", storedAtMs: 1 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await cache.get(expiring)).toBeNull();
      expect((await cache.get(persistent))?.text).toBe("long");
    });

    it("deletes only the requested key", async () => {
      const removed = key("removed");
      const preserved = key("preserved");
      await cache.set(removed, { text: "a", storedAtMs: 1 });
      await cache.set(preserved, { text: "b", storedAtMs: 1 });
      await cache.delete(removed);
      expect(await cache.get(removed)).toBeNull();
      expect((await cache.get(preserved))?.text).toBe("b");
    });
  });
}
