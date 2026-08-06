import type { SavingsReport } from "../contracts/types.js";

/**
 * A counts-only usage record on the wire. Mirrors `@bivelio/protocol`'s
 * `UsageRecord` but is reimplemented here so the SDK stays dependency-free (the
 * published package must not pull in a workspace package). It carries ONLY counts
 * and cost — NEVER a prompt, completion, or any request content. That invariant is
 * enforced a second time server-side by the ingest allow-list.
 */
interface UsageWire {
  orgId: string;
  seatId?: string;
  ci?: boolean;
  requestId: string;
  model: string;
  at: number;
  avoidedLlm: number;
  actualLlm: number;
  baselineInputTokens: number;
  actualInputTokens: number;
  eliminatedInputTokens: number;
  compressedInputTokens: number;
  baselineOutputTokens: number;
  actualOutputTokens: number;
  providerCachedInputTokens: number;
  cacheResult: string;
  baselineCost: number;
  actualCost: number;
  netSavings: number;
  basis?: string;
}

export interface UsageEmitterOptions {
  /** Full ingest URL, e.g. `https://savings.bivelio.com/api/metering/usage`. */
  url: string;
  /** Service-account key (`bvk_…`) sent as a Bearer token; the server derives the org from it. */
  serviceAccountKey: string;
  /** Optional org hint; the server always derives the authoritative org from the key. */
  orgId?: string;
  /** Flush cadence in ms (default 15000). */
  flushIntervalMs?: number;
  /** Records per POST (default 50). */
  maxBatch?: number;
  /** Hard in-memory cap; oldest records are dropped past it (default 1000). */
  maxBuffer?: number;
  /** Injectable fetch (defaults to the global). */
  fetchImpl?: typeof fetch;
  /** Injectable clock. */
  now?: () => number;
  /** Whether this process is a CI/ephemeral runner (excluded from billable seats). */
  ci?: boolean;
}

interface Entry {
  report: SavingsReport;
  at: number;
}

/**
 * Buffers counts-only usage and flushes it to the control plane. DETECTIVE
 * metering: strictly best-effort and NON-BLOCKING. `record()` is O(1) and
 * `flush()` never throws, so a slow, unreachable, or erroring control plane can
 * neither block nor crash the customer's request path. The buffer is hard-capped
 * so a sustained outage can never grow memory without bound.
 */
export class UsageEmitter {
  private readonly options: UsageEmitterOptions;
  private readonly now: () => number;
  private readonly flushIntervalMs: number;
  private readonly maxBatch: number;
  private readonly maxBuffer: number;
  private buffer: Entry[] = [];
  private seatId: string | undefined;
  private ci: boolean;
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;

  constructor(options: UsageEmitterOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.flushIntervalMs = options.flushIntervalMs ?? 15_000;
    this.maxBatch = options.maxBatch ?? 50;
    this.maxBuffer = options.maxBuffer ?? 1_000;
    this.ci = options.ci ?? false;
  }

  /** Set the resolved seat identity (derivation is async; records emitted before
   *  it resolves are stamped at flush time, so none are lost). */
  setSeat(seatId: string | undefined, ci: boolean): void {
    if (seatId) this.seatId = seatId;
    this.ci = ci;
  }

  /** Record one request's usage. Never blocks; O(1). */
  record(report: SavingsReport): void {
    this.buffer.push({ report, at: this.now() });
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer); // drop oldest
    }
    if (this.buffer.length >= this.maxBatch) void this.flush();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    // Don't keep a Node process alive just for metering.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop the timer and attempt a final flush. Safe to call more than once. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    void this.flush();
  }

  /**
   * Flush one batch. Never throws. A transient server error (5xx) or network
   * failure re-queues the batch (capped); a 4xx (bad request / bad key) drops it,
   * since retrying a rejected payload would loop forever.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    const doFetch = this.options.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!doFetch) return; // no fetch → cannot emit; never throw
    this.flushing = true;
    const batch = this.buffer.splice(0, this.maxBatch);
    try {
      const records: UsageWire[] = batch.map((e) => this.toWire(e));
      const res = await doFetch(this.options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.serviceAccountKey}`,
        },
        body: JSON.stringify(records),
      });
      if (!res.ok && res.status >= 500) this.requeue(batch);
    } catch {
      this.requeue(batch);
    } finally {
      this.flushing = false;
    }
  }

  private requeue(batch: Entry[]): void {
    this.buffer = [...batch, ...this.buffer];
    if (this.buffer.length > this.maxBuffer) this.buffer.length = this.maxBuffer;
  }

  private toWire(e: Entry): UsageWire {
    const r = e.report;
    return {
      // The server derives the real org from the key; this is an ignored hint.
      orgId: this.options.orgId ?? "self",
      ...(this.seatId ? { seatId: this.seatId } : {}),
      ...(this.ci ? { ci: true } : {}),
      requestId: r.requestId,
      model: r.model,
      at: e.at,
      avoidedLlm: r.calls.avoidedLlm,
      actualLlm: r.calls.actualLlm,
      baselineInputTokens: r.tokens.baselineInput,
      actualInputTokens: r.tokens.actualInput,
      eliminatedInputTokens: r.tokens.eliminatedInput,
      compressedInputTokens: r.tokens.compressedInput,
      baselineOutputTokens: r.tokens.baselineOutput,
      actualOutputTokens: r.tokens.actualOutput,
      providerCachedInputTokens: r.tokens.providerCachedInput ?? 0,
      cacheResult: r.cache.result,
      baselineCost: r.cost.baselineEstimate,
      actualCost: r.cost.actual,
      netSavings: r.cost.netSavings,
      // Viaja para que el panel agregue el dinero MEDIDO aparte del estimado.
      ...(r.cost.basis ? { basis: r.cost.basis } : {}),
    };
  }
}
