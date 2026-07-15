import type { ChatMessage } from "../contracts/types.js";

/**
 * Conversational memory by deltas.
 *
 * A major source of wasted input tokens is resending the entire chat history
 * every turn. Instead we keep a compact structured state and, each turn, apply a
 * small delta produced BY THE MAIN GENERATION (not a separate summarization
 * call). The next prompt receives: compact relevant state + the last 1-3 raw
 * turns + the current message — never the whole conversation.
 */
export interface ConversationState {
  goals: string[];
  confirmedFacts: Record<string, unknown>;
  userPreferences: Record<string, unknown>;
  decisions: string[];
  openItems: string[];
  evidenceRefs: string[];
}

export interface MemoryDelta {
  set?: Record<string, unknown>;
  append?: Record<string, unknown[]>;
  remove?: string[];
}

export function emptyState(): ConversationState {
  return {
    goals: [],
    confirmedFacts: {},
    userPreferences: {},
    decisions: [],
    openItems: [],
    evidenceRefs: [],
  };
}

/**
 * Merge a delta into state locally. `set` updates confirmedFacts/preferences,
 * `append` pushes onto list fields, `remove` deletes fact keys or list entries.
 * The merge is deterministic and side-effect-free (returns a new object).
 */
export function mergeDelta(
  state: ConversationState,
  delta: MemoryDelta,
): ConversationState {
  const next: ConversationState = {
    goals: [...state.goals],
    confirmedFacts: { ...state.confirmedFacts },
    userPreferences: { ...state.userPreferences },
    decisions: [...state.decisions],
    openItems: [...state.openItems],
    evidenceRefs: [...state.evidenceRefs],
  };

  for (const [key, value] of Object.entries(delta.set ?? {})) {
    if (key === "userPreferences" && isRecord(value)) {
      Object.assign(next.userPreferences, value);
    } else {
      next.confirmedFacts[key] = value;
    }
  }

  for (const [key, values] of Object.entries(delta.append ?? {})) {
    const list = listField(next, key);
    if (list) list.push(...values.map(String));
    else next.confirmedFacts[key] = values;
  }

  for (const key of delta.remove ?? []) {
    delete next.confirmedFacts[key];
    delete next.userPreferences[key];
    stripFromLists(next, key);
  }

  return next;
}

/**
 * Project the state + recent turns into the minimal message set to send. Only
 * relevant, non-empty state is serialized, then the last `rawTurns` messages,
 * then the current message.
 */
export function projectContext(opts: {
  state: ConversationState;
  history: ChatMessage[];
  current: ChatMessage;
  rawTurns?: number;
}): ChatMessage[] {
  const rawTurns = opts.rawTurns ?? 3;
  const messages: ChatMessage[] = [];

  const stateText = renderState(opts.state);
  if (stateText) {
    messages.push({ role: "system", content: `Conversation state:\n${stateText}` });
  }

  const recent = opts.history.slice(-rawTurns);
  messages.push(...recent, opts.current);
  return messages;
}

export function renderState(state: ConversationState): string {
  const parts: string[] = [];
  if (state.goals.length) parts.push(`goals: ${state.goals.join("; ")}`);
  if (Object.keys(state.confirmedFacts).length) {
    parts.push(`facts: ${JSON.stringify(state.confirmedFacts)}`);
  }
  if (Object.keys(state.userPreferences).length) {
    parts.push(`preferences: ${JSON.stringify(state.userPreferences)}`);
  }
  if (state.decisions.length) parts.push(`decisions: ${state.decisions.join("; ")}`);
  if (state.openItems.length) parts.push(`open: ${state.openItems.join("; ")}`);
  return parts.join("\n");
}

function listField(state: ConversationState, key: string): string[] | null {
  switch (key) {
    case "goals": return state.goals;
    case "decisions": return state.decisions;
    case "openItems": return state.openItems;
    case "evidenceRefs": return state.evidenceRefs;
    default: return null;
  }
}

function stripFromLists(state: ConversationState, value: string): void {
  for (const key of ["goals", "decisions", "openItems", "evidenceRefs"] as const) {
    const idx = state[key].indexOf(value);
    if (idx >= 0) state[key].splice(idx, 1);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
