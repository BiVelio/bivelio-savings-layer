import { describe, it, expect } from "vitest";
import { OpenAICompatibleProvider } from "../src/index.js";
import type { ToolDescriptor } from "../src/index.js";

function fakeFetch(capture: { body?: any }, responseJson: unknown): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    capture.body = JSON.parse(String(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => responseJson,
    } as Response;
  }) as unknown as typeof fetch;
}

const tools: ToolDescriptor[] = [
  { id: "get_weather", intents: ["weather"], risk: "read", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  { id: "send_email", intents: ["email"], risk: "write" },
];

describe("OpenAICompatibleProvider — tool transmission", () => {
  it("maps ToolDescriptors into the native OpenAI tools body field", async () => {
    const cap: { body?: any } = {};
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      fetchImpl: fakeFetch(cap, { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 42, completion_tokens: 7 } }),
    });
    await provider.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }], tools });

    expect(Array.isArray(cap.body.tools)).toBe(true);
    expect(cap.body.tools).toHaveLength(2);
    expect(cap.body.tools[0]).toMatchObject({
      type: "function",
      function: { name: "get_weather", parameters: { type: "object" } },
    });
    // A tool without an explicit schema still transmits a valid empty object schema.
    expect(cap.body.tools[1].function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("omits the tools field entirely when there are no tools", async () => {
    const cap: { body?: any } = {};
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      fetchImpl: fakeFetch(cap, { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    });
    await provider.generate({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect("tools" in cap.body).toBe(false);
  });
});

describe("OpenAICompatibleProvider — requireUsage guard", () => {
  it("throws when usage is absent and requireUsage is set (no silent 0→100% savings)", async () => {
    const cap: { body?: any } = {};
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      requireUsage: true,
      fetchImpl: fakeFetch(cap, { choices: [{ message: { content: "answer with no usage block" } }] }),
    });
    await expect(
      provider.generate({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/no usage tokens/i);
  });

  it("does not throw on absent usage when requireUsage is off (back-compat), coercing to 0", async () => {
    const cap: { body?: any } = {};
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      fetchImpl: fakeFetch(cap, { choices: [{ message: { content: "x" } }] }),
    });
    const res = await provider.generate({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(res.usage.inputTokens).toBe(0);
    expect(res.usage.outputTokens).toBe(0);
  });

  it("passes through real usage including provider-cached tokens", async () => {
    const cap: { body?: any } = {};
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      requireUsage: true,
      fetchImpl: fakeFetch(cap, {
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 800 } },
      }),
    });
    const res = await provider.generate({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(res.usage.inputTokens).toBe(1000);
    expect(res.usage.outputTokens).toBe(120);
    expect(res.usage.cachedInputTokens).toBe(800);
  });
});
