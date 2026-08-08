import { RevocationSnapshot, verifyRevocationList } from "./revocation.js";
import type { LicenseKeyset } from "./verify.js";

/**
 * Browser-safe revocation call-home. Uses only Web-standard globals (`fetch`,
 * `setTimeout`, `AbortController`) — NO `node:` imports — exactly like
 * src/providers/openai-compatible.ts, so it runs in the browser demo bundle too.
 *
 * FAIL-OPEN by construction: a failed / non-200 / tampered / rolled-back / stale
 * poll is a NO-OP that keeps the sticky {@link RevocationSnapshot} last-known-good.
 * The customer request path never awaits a poll — the warm poll on `start()` is
 * fired but never awaited, so a control plane that is down at boot cannot brick or
 * even delay the first `generate()`. Enforcement of expiry (offline, from the
 * token) and of already-known revocations continues regardless.
 */

const DEFAULTS = {
  pollIntervalSeconds: 900, // steady-state ceiling → ~15 min worst-case propagation
  floorSeconds: 300, // hard floor → CP self-DoS protection + busy-loop guard
  maxIntervalSeconds: 3600, // backoff ceiling during an outage
  jitterRatio: 0.1, // ±10% de-syncs fleet instances
  maxSkewSeconds: 300,
  requestTimeoutMs: 30_000,
} as const;

export type RevocationPollEvent =
  | { type: "applied"; seq: number; size: number }
  | { type: "unchanged"; seq: number }
  | { type: "rejected"; reason: string }
  | { type: "error"; error: unknown }
  | { type: "no-fetch" };

export interface RevocationPollerOptions {
  /** Absolute URL of GET /licenses/revocations. */
  url: string;
  /** SPKI PEM (or a kid-addressed {@link LicenseKeyset}) used to verify the signed
   *  list — the same key/keyset that verifies license tokens. */
  publicKeyPem: string | LicenseKeyset;
  /** The sticky snapshot to feed. */
  snapshot: RevocationSnapshot;
  /** Anchor cadence to the license refresh horizon (unix seconds). */
  getRefreshAfter?: () => number | undefined;
  /** Injectable clock (unix seconds). */
  nowSeconds?: () => number;
  /** Injectable fetch (defaults to the global). */
  fetchImpl?: typeof fetch;
  pollIntervalSeconds?: number;
  floorSeconds?: number;
  maxIntervalSeconds?: number;
  jitterRatio?: number;
  maxSkewSeconds?: number;
  requestTimeoutMs?: number;
  /** Injectable RNG in [0,1) for jitter. Default Math.random. */
  random?: () => number;
  /** Optional observer (telemetry/tests). */
  onEvent?: (e: RevocationPollEvent) => void;
}

/**
 * PURE, unit-testable next-delay policy (seconds). Steady state anchors to the
 * license refresh horizon, clamped to [floor, ceiling] and jittered. After a
 * failure it backs off exponentially (a revocation can't land during an outage
 * anyway), capped, still jittered, never below the floor.
 */
export function computeNextDelay(opts: {
  refreshAfter?: number;
  nowSeconds: number;
  consecutiveFailures: number;
  floorSeconds: number;
  pollIntervalSeconds: number;
  maxIntervalSeconds: number;
  jitterRatio: number;
  random?: () => number;
}): number {
  const rnd = opts.random ?? Math.random;
  let base: number;
  if (opts.consecutiveFailures > 0) {
    const factor = Math.pow(2, Math.min(opts.consecutiveFailures, 4));
    base = Math.min(opts.maxIntervalSeconds, opts.floorSeconds * factor);
  } else {
    const untilRefresh =
      opts.refreshAfter != null ? opts.refreshAfter - opts.nowSeconds : opts.pollIntervalSeconds;
    // A past/elapsed horizon (e.g. the license already expired mid-process) must NOT
    // pin the cadence to the floor forever — fall back to the steady interval. A
    // positive horizon still tightens the cadence as the refresh moment approaches.
    const horizon = untilRefresh < 0 ? opts.pollIntervalSeconds : untilRefresh;
    base = Math.min(opts.pollIntervalSeconds, Math.max(opts.floorSeconds, horizon));
  }
  const jitter = 1 + (rnd() * 2 - 1) * opts.jitterRatio;
  return Math.max(opts.floorSeconds, base * jitter);
}

/** Cuántos 304 seguidos se aceptan antes de exigir la lista firmada entera. */
const MAX_304_ANTES_DE_REVALIDAR = 10;

export class RevocationPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private consecutiveFailures = 0;
  private stopped = false;
  private started = false;
  private warnedNoFetch = false;
  /** ETag of the last 200; sent as If-None-Match so an unchanged list 304s (cheap no-op). */
  private lastEtag: string | null = null;
  /** 304 seguidos; al llegar al tope se fuerza una descarga firmada. */
  private consecutive304 = 0;

  constructor(private readonly opts: RevocationPollerOptions) {}

  private now(): number {
    return this.opts.nowSeconds ? this.opts.nowSeconds() : Math.floor(Date.now() / 1000);
  }

  private resolveFetch(): typeof fetch | undefined {
    if (this.opts.fetchImpl) return this.opts.fetchImpl;
    return typeof fetch !== "undefined" ? fetch : undefined;
  }

  /**
   * One poll cycle: fetch → verify → apply. NEVER throws (fail-open). A reachable
   * CP resets the failure backoff even if the returned list is rejected — we keep
   * last-known-good. Only a transport/abort/parse error counts as a failure.
   */
  async pollOnce(): Promise<void> {
    const f = this.resolveFetch();
    if (!f) {
      if (!this.warnedNoFetch) {
        this.warnedNoFetch = true;
        console.warn(
          "[bv-sala] no global fetch available; revocation call-home disabled (offline). License expiry is still enforced from the token.",
        );
      }
      this.opts.onEvent?.({ type: "no-fetch" });
      return;
    }

    const ctrl = new AbortController();
    this.controller = ctrl;
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    (to as unknown as { unref?: () => void }).unref?.();

    const headers: Record<string, string> = { accept: "application/json" };
    if (this.lastEtag) headers["if-none-match"] = this.lastEtag;
    try {
      const res = await f(this.opts.url, { signal: ctrl.signal, headers });
      if (res.status === 304) {
        // Unchanged since our last ETag — a SUCCESS: reset backoff, keep snapshot,
        // and record the authorized heartbeat (feeds the online staleness gate).
        this.consecutiveFailures = 0;
        this.opts.snapshot.markContact(this.now());
        this.opts.onEvent?.({ type: "unchanged", seq: this.opts.snapshot.seq });

        // Un 304 es una CABECERA: sin cuerpo, sin firma Ed25519, sin `seq`. Vale
        // como prueba de alcanzabilidad, pero no prueba nada sobre el contenido
        // de la lista, así que no puede sostener el latido para siempre — quien
        // controle el endpoint podría devolver 304 indefinidamente y mantener
        // viva una licencia revocada hasta su expiración natural.
        //
        // Cada N respuestas 304 seguidas se tira el ETag, de modo que el
        // siguiente sondeo pide la lista COMPLETA y vuelve a verificar la firma.
        // Coste: una descarga cada N ciclos. A cambio, la ventana en la que un
        // servidor tonto puede sostener el latido queda acotada.
        this.consecutive304 += 1;
        if (this.consecutive304 >= MAX_304_ANTES_DE_REVALIDAR) {
          this.consecutive304 = 0;
          this.lastEtag = null;
        }
        return;
      }
      this.consecutive304 = 0;
      if (!res.ok) throw new Error(`revocations HTTP ${res.status}`);

      // Remember the ETag so the next poll can send If-None-Match and short-circuit
      // to a bodiless 304 when nothing changed (saves transfer + Ed25519 re-verify).
      const et = res.headers.get("etag");
      if (et) this.lastEtag = et;

      const data = (await res.json()) as { list?: string };
      if (!data.list) throw new Error("response missing `list`");

      // The CP is reachable → the failure backoff resets even if the payload is
      // rejected below (tampered/rolled-back). Fail-open on the payload: keep the
      // sticky snapshot, never drop a known revocation.
      this.consecutiveFailures = 0;

      const v = verifyRevocationList(data.list, this.opts.publicKeyPem, {
        minSeq: this.opts.snapshot.seq,
        nowSeconds: this.now(),
        maxSkewSeconds: this.opts.maxSkewSeconds ?? DEFAULTS.maxSkewSeconds,
      });
      if (!v.ok) {
        this.opts.onEvent?.({ type: "rejected", reason: v.reason ?? "rejected" });
        return;
      }
      // A verified, authorized list → record the heartbeat for the staleness gate.
      this.opts.snapshot.markContact(this.now());
      const changed = this.opts.snapshot.apply(v);
      this.opts.onEvent?.(
        changed
          ? { type: "applied", seq: v.seq, size: this.opts.snapshot.snapshot().size }
          : { type: "unchanged", seq: v.seq },
      );
    } catch (error) {
      // Transport/abort/parse error → CP effectively unreachable. Fail-open: keep
      // the sticky snapshot and back off. Enforcement never blocks on this.
      this.consecutiveFailures++;
      this.opts.onEvent?.({ type: "error", error });
    } finally {
      clearTimeout(to);
      this.controller = null;
    }
  }

  /** Fire one non-blocking warm poll, then self-schedule. Idempotent. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.pollOnce().finally(() => this.schedule());
  }

  private schedule(): void {
    if (this.stopped) return;
    const delaySec = computeNextDelay({
      refreshAfter: this.opts.getRefreshAfter?.(),
      nowSeconds: this.now(),
      consecutiveFailures: this.consecutiveFailures,
      floorSeconds: this.opts.floorSeconds ?? DEFAULTS.floorSeconds,
      pollIntervalSeconds: this.opts.pollIntervalSeconds ?? DEFAULTS.pollIntervalSeconds,
      maxIntervalSeconds: this.opts.maxIntervalSeconds ?? DEFAULTS.maxIntervalSeconds,
      jitterRatio: this.opts.jitterRatio ?? DEFAULTS.jitterRatio,
      ...(this.opts.random ? { random: this.opts.random } : {}),
    });
    this.timer = setTimeout(() => {
      void this.pollOnce().finally(() => this.schedule());
    }, delaySec * 1000);
    // A background poll must never keep the process alive.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop polling and abort any in-flight request. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
  }
}
