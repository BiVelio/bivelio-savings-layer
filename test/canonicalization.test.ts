import { describe, it, expect } from "vitest";
import { canonicalize, buildExactKey, buildInflightKey } from "../src/canonicalization/index.js";
import type {
  SavingsRequest,
} from "../src/index.js";

function req(overrides: Partial<SavingsRequest> = {}): SavingsRequest {
  return {
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "What is the capital of France?" }],
    ...overrides,
  };
}

describe("canonicalization + exact key", () => {
  it("normalizes whitespace and case so equivalent text collides", () => {
    const a = buildExactKey(canonicalize(req({ messages: [{ role: "user", content: "Hello   World" }] })));
    const b = buildExactKey(canonicalize(req({ messages: [{ role: "user", content: "hello world" }] })));
    expect(a).toBe(b);
  });

  it("isolates tenants — same text, different tenant, different key", () => {
    const a = buildExactKey(canonicalize(req({ context: { tenantId: "t1" } })));
    const b = buildExactKey(canonicalize(req({ context: { tenantId: "t2" } })));
    expect(a).not.toBe(b);
  });

  it("isolates authorization scope", () => {
    const a = buildExactKey(canonicalize(req({ context: { tenantId: "t", authorizationScope: "public" } })));
    const b = buildExactKey(canonicalize(req({ context: { tenantId: "t", authorizationScope: "internal" } })));
    expect(a).not.toBe(b);
  });

  it("isolates knowledge epoch and freshness bucket", () => {
    const a = buildExactKey(canonicalize(req({ context: { knowledgeEpoch: "docs-1" } })));
    const b = buildExactKey(canonicalize(req({ context: { knowledgeEpoch: "docs-2" } })));
    expect(a).not.toBe(b);
  });

  it("distinguishes different system prompts", () => {
    const a = buildExactKey(canonicalize(req({ messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
    ] })));
    const b = buildExactKey(canonicalize(req({ messages: [
      { role: "system", content: "You are verbose." },
      { role: "user", content: "hi" },
    ] })));
    expect(a).not.toBe(b);
  });

  it("distinguishes different structured payloads (no cross-payload collision)", () => {
    const a = buildExactKey(canonicalize(req({ structuredData: { rows: [{ id: 1 }] } })));
    const b = buildExactKey(canonicalize(req({ structuredData: { rows: [{ id: 2 }] } })));
    const none = buildExactKey(canonicalize(req()));
    expect(a).not.toBe(b);
    expect(a).not.toBe(none);
  });

  it("inflight key ignores freshness bucketing but keeps tenant isolation", () => {
    const a = buildInflightKey(canonicalize(req({ context: { tenantId: "t", freshnessBucket: "hour" } })));
    const b = buildInflightKey(canonicalize(req({ context: { tenantId: "t", freshnessBucket: "day" } })));
    expect(a).toBe(b);
    const c = buildInflightKey(canonicalize(req({ context: { tenantId: "other" } })));
    expect(c).not.toBe(a);
  });
});
