import type { ExecutionClass, ToolDescriptor } from "../contracts/types.js";

/**
 * Tool selector.
 *
 * Full tool schemas can dominate a prompt even when most tools are irrelevant.
 * The selector picks only the tools whose declared intents match the request,
 * and — critically — gates write/destructive tools behind explicit rules so a
 * read-only request can never be handed a mutating capability.
 */
export interface ToolSelection {
  tools: ToolDescriptor[];
  droppedIds: string[];
  reason: string;
}

export interface ToolSelectorOptions {
  /** Max tools to include (schema-token budget guard). */
  maxTools?: number;
  /** Tokenizer-aware scorer for tie-breaking (optional). */
  scoreIntentMatch?: (text: string, tool: ToolDescriptor) => number;
}

export class ToolSelector {
  private readonly maxTools: number;
  private readonly scoreIntentMatch: (text: string, tool: ToolDescriptor) => number;

  constructor(opts: ToolSelectorOptions = {}) {
    this.maxTools = opts.maxTools ?? 8;
    this.scoreIntentMatch = opts.scoreIntentMatch ?? defaultScore;
  }

  select(
    text: string,
    tools: ToolDescriptor[] | undefined,
    execution: ExecutionClass,
  ): ToolSelection {
    if (!tools || tools.length === 0) {
      return { tools: [], droppedIds: [], reason: "no tools provided" };
    }

    // A non-TOOL_ACTION request never receives write/destructive tools.
    const allowWrites = execution === "TOOL_ACTION";
    const eligible = tools.filter((t) => allowWrites || t.risk === "read");

    const scored = eligible
      .map((tool) => ({ tool, score: this.scoreIntentMatch(text, tool) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxTools);

    const selected = scored.map((s) => s.tool);
    const selectedIds = new Set(selected.map((t) => t.id));
    const droppedIds = tools.filter((t) => !selectedIds.has(t.id)).map((t) => t.id);

    return {
      tools: selected,
      droppedIds,
      reason: `selected ${selected.length}/${tools.length} by intent match (writes ${allowWrites ? "allowed" : "blocked"})`,
    };
  }
}

function defaultScore(text: string, tool: ToolDescriptor): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const intent of tool.intents) {
    const needle = intent.toLowerCase();
    if (haystack.includes(needle)) score += 2;
    else if (needle.split(/\s+/).some((w) => w.length > 3 && haystack.includes(w))) {
      score += 1;
    }
  }
  return score;
}
