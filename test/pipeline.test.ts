import { describe, it, expect } from "vitest";
import {
  createSavingsLayer,
  createMockProvider,
  InMemorySemanticCache,
  type JsonSchema,
  type SavingsRequest,
} from "../src/index.js";

let counter = 0;
const deterministicId = () => `req-${counter++}`;

describe("SavingsPipeline end-to-end", () => {
  it("answers arithmetic via a deterministic resolver — zero LLM calls", async () => {
    const layer = createSavingsLayer({ provider: createMockProvider(), generateId: deterministicId });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
    });
    expect(res.text).toBe("8");
    expect(res.report.calls.actualLlm).toBe(0);
    expect(res.report.calls.avoidedLlm).toBe(1);
    expect(res.report.cache.result).toBe("deterministic");
  });

  it("serves a repeated request from the exact cache", async () => {
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "Paris" }),
      generateId: deterministicId,
    });
    const request: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "capital of france" }],
    };
    const first = await layer.generate(request);
    expect(first.report.cache.result).toBe("miss");
    expect(first.report.calls.actualLlm).toBe(1);

    const second = await layer.generate(request);
    expect(second.report.cache.result).toBe("exact");
    expect(second.report.calls.actualLlm).toBe(0);
    expect(second.report.calls.avoidedLlm).toBe(1);
    expect(second.text).toBe("Paris");
  });

  it("coalesces concurrent identical requests via singleflight", async () => {
    let providerCalls = 0;
    const provider = {
      id: "counting",
      async generate() {
        providerCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return { text: "shared", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const layer = createSavingsLayer({ provider, generateId: deterministicId });
    const request: SavingsRequest = {
      model: "m",
      messages: [{ role: "user", content: "expensive unique question xyz" }],
    };
    const [a, b, c] = await Promise.all([
      layer.generate(request),
      layer.generate(request),
      layer.generate(request),
    ]);
    expect(providerCalls).toBe(1);
    const outcomes = [a, b, c].map((r) => r.report.cache.result).sort();
    expect(outcomes.filter((o) => o === "singleflight").length).toBe(2);
  });

  it("produces a schema-valid structured output and marks it valid", async () => {
    const schema: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["answer", "refs"],
      properties: {
        answer: { type: "string", maxLength: 600 },
        refs: { type: "array", maxItems: 5, items: { type: "string", maxLength: 32 } },
      },
    };
    const layer = createSavingsLayer({ provider: createMockProvider(), generateId: deterministicId });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "research question about widgets" }],
      response: { contractId: "research-answer:v3", schema, maxOutputTokens: 220 },
    });
    expect(res.report.constraints.structurallyValid).toBe(true);
    expect(typeof (res.data as { answer: string }).answer).toBe("string");
  });

  it("records compression ledger when a large table is serialized as TOON", async () => {
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "ok" }), generateId: deterministicId });
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      role: i % 2 ? "admin" : "user",
    }));
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "summarize the attached table" }],
      structuredData: { users: rows },
    });
    expect(res.report.serialization.chosen).toBe("toon");
    expect(res.report.tokens.compressedInput).toBeGreaterThan(0);
  });

  it("sends structured data as JSON when the format selector is disabled (never drops it)", async () => {
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "ok" }), generateId: deterministicId });
    const rows = { users: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `u${i}` })) };
    const withData = await layer.generate({
      model: "m",
      messages: [{ role: "user", content: "analyze payload alpha" }],
      structuredData: rows,
      savings: { serialization: false },
    });
    const withoutData = await layer.generate({
      model: "m",
      messages: [{ role: "user", content: "analyze payload beta" }],
      savings: { serialization: false },
    });
    // Payload was sent (not dropped) → more input tokens than the no-data request.
    expect(withData.report.tokens.actualInput).toBeGreaterThan(withoutData.report.tokens.actualInput);
    expect(withData.report.serialization.chosen).toBe("json-compact");
    expect(withData.report.tokens.compressedInput).toBe(0); // no compression when disabled
  });

  it("keeps the four ledgers separate in the report", async () => {
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "hi", cachedInputTokens: 30 }),
      generateId: deterministicId,
    });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "a neutral factual question about history" }],
    });
    expect(res.report.tokens).toHaveProperty("eliminatedInput");
    expect(res.report.tokens).toHaveProperty("compressedInput");
    expect(res.report.tokens.providerCachedInput).toBe(30);
  });

  it("does not use the exact cache for high-temperature stochastic requests", async () => {
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "creative" }), generateId: deterministicId });
    const request: SavingsRequest = {
      model: "m",
      messages: [{ role: "user", content: "write a poem" }],
      temperature: 0.9,
    };
    await layer.generate(request);
    const second = await layer.generate(request);
    expect(second.report.cache.result).not.toBe("exact");
  });

  it("respects tenant isolation on the semantic cache", async () => {
    const embed = (t: string) => Array.from({ length: 4 }, (_, i) => [...t].filter((c) => c.charCodeAt(0) % 4 === i).length);
    const semanticCache = new InMemorySemanticCache({ embed, similarityThreshold: 0.5, acceptThreshold: 0.5 });
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "tenant-1-answer" }),
      semanticCache,
      generateId: deterministicId,
    });
    const base: SavingsRequest = {
      model: "m",
      messages: [{ role: "user", content: "what is the standard refund window in days" }],
      savings: { semanticCache: "safe-only" },
      context: { tenantId: "t1", knowledgeEpoch: "e1" },
    };
    await layer.generate(base);
    const other = await layer.generate({ ...base, context: { tenantId: "t2", knowledgeEpoch: "e1" } });
    // Different tenant must not receive tenant-1's cached answer.
    expect(other.report.cache.result).not.toBe("semantic");
  });

  it("injects the retrieved evidence into the prompt (RAG grounding — regression for the docs-discarded bug)", async () => {
    let captured: { role: string; content: string }[] = [];
    const provider = {
      id: "capturing",
      async generate(req: { messages: { role: string; content: string }[] }) {
        captured = req.messages;
        return { text: "Alexander Graham Bell", usage: { inputTokens: 30, outputTokens: 5 } };
      },
    };
    const retriever = {
      async retrieve() {
        return [
          {
            id: "doc-1",
            text: "PATENT-1876: Alexander Graham Bell was granted the telephone patent.",
            score: 0.9,
          },
        ];
      },
    };
    const layer = createSavingsLayer({ provider, retriever, generateId: deterministicId });
    await layer.generate({
      model: "m",
      messages: [{ role: "user", content: "who invented the telephone?" }],
    });
    // The kept evidence must actually reach the model — not just the ledger/report.
    const promptText = captured.map((m) => m.content).join("\n");
    expect(promptText).toContain("PATENT-1876");
  });
});
