/**
 * Demonstration scenarios for BV-SALA.
 *
 * Each scenario exercises one savings lever and (where possible) carries a
 * quality check, so the harness proves TWO things at once: that we save money
 * AND that the answer is still correct. The point is to demonstrate *real*
 * savings — not to flatter the numbers.
 */
import type { SavingsRequest, SavingsResult, ToolDescriptor } from "../src/index.js";

/** Which of the four ledgers a scenario's saving is attributed to (for the
 * per-ledger A/B rollup). "none" = a plain call used as setup, not a lever. */
export type LedgerTag =
  | "avoided_calls"
  | "eliminated_tokens"
  | "compressed_tokens"
  | "output_restriction"
  | "none";

export interface Scenario {
  name: string;
  /** Which savings lever this demonstrates. */
  lever: string;
  /** Which ledger the measured A/B delta is attributed to. */
  ledger: LedgerTag;
  request: SavingsRequest;
  /** Optional correctness check on the result. */
  expect?: (r: SavingsResult) => boolean;
  /** Run once before measuring, to populate the cache (for cache-hit demos). */
  warm?: boolean;
}

// Real argument schemas: a tool's JSON schema travels in the prompt, so the
// tool selector's savings are only measurable when tools carry realistic
// parameters (an empty {} would make the dropped-tool token delta ~0).
const tools: ToolDescriptor[] = [
  {
    id: "get_weather", intents: ["weather forecast"], risk: "read",
    description: "Get the weather forecast for a city on a given date.",
    parameters: { type: "object", required: ["city", "date"], properties: {
      city: { type: "string", description: "City name, e.g. 'Madrid'" },
      date: { type: "string", description: "ISO date (YYYY-MM-DD)" },
      units: { type: "string", enum: ["celsius", "fahrenheit"] },
    } },
  },
  {
    id: "search_docs", intents: ["search documentation"], risk: "read",
    description: "Full-text search over the product documentation.",
    parameters: { type: "object", required: ["query"], properties: {
      query: { type: "string", description: "Search query" },
      top_k: { type: "integer", minimum: 1, maximum: 20 },
      section: { type: "string", enum: ["billing", "api", "guides", "faq"] },
    } },
  },
  {
    id: "delete_account", intents: ["delete account"], risk: "destructive",
    description: "Permanently delete a user account and all associated data.",
    parameters: { type: "object", required: ["user_id", "confirm"], properties: {
      user_id: { type: "string" }, confirm: { type: "boolean" },
    } },
  },
  {
    id: "get_invoices", intents: ["list invoices billing"], risk: "read",
    description: "List invoices for an account within a date range.",
    parameters: { type: "object", required: ["account_id"], properties: {
      account_id: { type: "string" },
      from: { type: "string", description: "ISO date" },
      to: { type: "string", description: "ISO date" },
      status: { type: "string", enum: ["paid", "open", "void"] },
    } },
  },
  {
    id: "send_email", intents: ["send email"], risk: "write",
    description: "Send a transactional email to a recipient.",
    parameters: { type: "object", required: ["to", "subject", "body"], properties: {
      to: { type: "string" }, subject: { type: "string" }, body: { type: "string" },
      cc: { type: "array", items: { type: "string" } },
    } },
  },
];

const answerContract = {
  contractId: "demo-answer:v1",
  schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["answer"],
    properties: {
      answer: { type: "string" as const, maxLength: 400 },
      refs: { type: "array" as const, maxItems: 3, items: { type: "string" as const, maxLength: 24 } },
    },
  },
  maxOutputTokens: 180,
};

export const scenarios: Scenario[] = [
  {
    name: "Local arithmetic",
    lever: "avoided_calls (deterministic resolver)",
    ledger: "avoided_calls",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is (2 + 2) * 3?" }],
    },
    expect: (r) => r.text.trim() === "12" && r.report.calls.actualLlm === 0,
  },
  {
    name: "FAQ (first ask)",
    lever: "baseline (populates cache)",
    ledger: "none",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is the standard refund window in days?" }],
      response: answerContract,
      context: { tenantId: "acme", knowledgeEpoch: "kb-2026-07" },
    },
  },
  {
    name: "FAQ (repeat ask)",
    lever: "avoided_calls (exact cache hit)",
    ledger: "avoided_calls",
    warm: true,
    request: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is the standard refund window in days?" }],
      response: answerContract,
      context: { tenantId: "acme", knowledgeEpoch: "kb-2026-07" },
    },
    expect: (r) => r.report.cache.result === "exact" && r.report.calls.actualLlm === 0,
  },
  {
    name: "Summarize provided text",
    lever: "avoided retrieval (NO_RETRIEVAL routing)",
    ledger: "eliminated_tokens",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize the following text: our Q2 report shows steady growth in EU markets with rising retention." }],
      response: answerContract,
    },
    expect: (r) => r.report.routing.executionClass === "NO_RETRIEVAL",
  },
  {
    name: "Tool-heavy request",
    lever: "fewer tool tokens (tool selector)",
    ledger: "eliminated_tokens",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "what is the weather forecast for tomorrow?" }],
      tools,
      response: answerContract,
    },
    expect: (r) => r.report.calls.actualTools <= 1,
  },
  {
    name: "Large uniform table",
    lever: "compressed_tokens (TOON/CSV format selector)",
    ledger: "compressed_tokens",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize the attached user table." }],
      response: answerContract,
      structuredData: {
        users: Array.from({ length: 50 }, (_, i) => ({
          id: 1000 + i,
          name: `user_${i}`,
          role: i % 3 === 0 ? "admin" : "member",
          plan: i % 2 ? "pro" : "free",
          active: i % 4 !== 0,
        })),
      },
    },
    expect: (r) => r.report.tokens.compressedInput > 0,
  },
  {
    name: "Constrained structured answer",
    lever: "output restriction (schema + maxOutputTokens)",
    ledger: "output_restriction",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Give a one-line summary of BV-SALA with up to three references." }],
      response: answerContract,
    },
    expect: (r) => r.report.constraints.structurallyValid,
  },
];
