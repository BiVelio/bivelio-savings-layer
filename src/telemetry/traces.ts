import type { TraceEvent } from "../contracts/types.js";

/**
 * Trace collector: an ordered log of pipeline decisions with elapsed timings.
 * Every stage records why it did what it did, so a SavingsReport can be audited
 * and so ablations can attribute savings to a specific module.
 */
export class TraceCollector {
  private readonly events: TraceEvent[] = [];
  private readonly start: number;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    this.start = now();
  }

  record(stage: string, outcome: string, detail?: Record<string, unknown>): void {
    this.events.push({
      stage,
      outcome,
      ...(detail ? { detail } : {}),
      atMs: this.now() - this.start,
    });
  }

  elapsed(): number {
    return this.now() - this.start;
  }

  all(): TraceEvent[] {
    return this.events;
  }
}
