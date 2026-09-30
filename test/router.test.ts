import { describe, it, expect } from "vitest";
import {
  ExecutionRouter,
  ToolSelector,
} from "../src/index.js";
import { canonicalize } from "../src/canonicalization/index.js";
import type {
  SavingsRequest,
  ToolDescriptor,
} from "../src/index.js";

function classify(text: string, tools?: ToolDescriptor[]) {
  const request: SavingsRequest = { model: "m", messages: [{ role: "user", content: text }], ...(tools ? { tools } : {}) };
  return new ExecutionRouter().classify(canonicalize(request));
}

describe("ExecutionRouter", () => {
  it("routes self-contained transformations to NO_RETRIEVAL", () => {
    expect(classify("summarize the following text: ...").executionClass).toBe("NO_RETRIEVAL");
    expect(classify("translate this text to spanish").executionClass).toBe("NO_RETRIEVAL");
  });

  it("routes single factual lookups to SINGLE_RETRIEVAL", () => {
    expect(classify("who invented the telephone?").executionClass).toBe("SINGLE_RETRIEVAL");
  });

  it("routes comparisons to MULTI_HOP_RETRIEVAL", () => {
    expect(classify("compare the gdp of france and germany").executionClass).toBe("MULTI_HOP_RETRIEVAL");
  });

  it("routes imperative + write tool to TOOL_ACTION", () => {
    const decision = classify("please send the invoice", [
      { id: "send", intents: ["send invoice"], risk: "write" },
    ]);
    expect(decision.executionClass).toBe("TOOL_ACTION");
  });

  it("honors an explicit caller mode over a conflicting keyword (no silent downgrade)", () => {
    // "which" matches the SINGLE_LOOKUP regex, but the caller explicitly asked for
    // multi-hop — the explicit intent must win instead of being downgraded to 1 round.
    const req: SavingsRequest = {
      model: "m",
      messages: [{ role: "user", content: "which plan is best for a 50 seat team?" }],
      retrieval: { mode: "multi" },
    };
    const decision = new ExecutionRouter().classify(canonicalize(req));
    expect(decision.executionClass).toBe("MULTI_HOP_RETRIEVAL");
  });

  it("is stable across simple paraphrases of a comparison", () => {
    const forms = [
      "compare product a and product b",
      "which is better, product a or product b?",
      "what is the difference between product a and product b",
    ];
    const classes = forms.map((f) => classify(f).executionClass);
    expect(new Set(classes).size).toBe(1);
    expect(classes[0]).toBe("MULTI_HOP_RETRIEVAL");
  });
});

describe("ToolSelector", () => {
  const tools: ToolDescriptor[] = [
    { id: "get_weather", intents: ["weather forecast"], risk: "read" },
    { id: "delete_account", intents: ["delete account"], risk: "destructive" },
    { id: "search_docs", intents: ["search documentation"], risk: "read" },
  ];

  it("never hands write/destructive tools to a non-TOOL_ACTION request", () => {
    const selection = new ToolSelector().select("delete account now", tools, "NO_RETRIEVAL");
    expect(selection.tools.some((t) => t.risk === "destructive")).toBe(false);
  });

  it("selects only intent-matching tools (when maxTools opts in to pruning)", () => {
    const selection = new ToolSelector({ maxTools: 8 }).select("what is the weather forecast", tools, "SINGLE_RETRIEVAL");
    expect(selection.tools.map((t) => t.id)).toEqual(["get_weather"]);
    expect(selection.droppedIds).toContain("search_docs");
  });

  it("allows destructive tools only under TOOL_ACTION", () => {
    const selection = new ToolSelector().select("delete account", tools, "TOOL_ACTION");
    expect(selection.tools.map((t) => t.id)).toContain("delete_account");
  });
});
