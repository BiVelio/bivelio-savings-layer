/**
 * Typed intermediate representation for LLM -> LLM handoffs.
 *
 * In multi-agent systems the same system prompt, tool list and context tend to
 * be re-explained in free-form natural language at every hop. BV-SALA replaces
 * that with a compact, typed handoff object. Each consumer receives a
 * projection of the state, not the whole conversation. The serializer then
 * decides whether to send it as compact JSON or TOON.
 */
export interface HandoffFact {
  id: string;
  value: unknown;
  source?: string;
}

export interface BivelioHandoff {
  /** Schema version of the handoff envelope itself. */
  v: 1;
  task: string;
  goal: string;
  rules: string[];
  facts: HandoffFact[];
  /** References to large documents kept out of the prompt (id/hash pointers). */
  refs: string[];
  /** Only the delta since the previous turn, not the whole state. */
  delta?: Record<string, unknown>;
  /** Identifier of the output contract; not the full schema. */
  outputContract: string;
}

export function createHandoff(
  init: Omit<BivelioHandoff, "v"> & Partial<Pick<BivelioHandoff, "v">>,
): BivelioHandoff {
  return {
    v: 1,
    task: init.task,
    goal: init.goal,
    rules: init.rules ?? [],
    facts: init.facts ?? [],
    refs: init.refs ?? [],
    ...(init.delta ? { delta: init.delta } : {}),
    outputContract: init.outputContract,
  };
}
