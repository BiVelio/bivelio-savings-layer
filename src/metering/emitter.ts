import type { SavingsReport } from "../contracts/types.js";
import { avisarUnaVez } from "../util/warn-once.js";
import { BV_SALA_VERSION, CABECERA_VERSION } from "../version.js";

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
  /**
   * B2 (0.4.17) · el suelo de la elisión del proveedor: tokens borrados por su
   * contador a precio de LECTURA de caché. OPCIONAL y solo cuando es > 0 con
   * conteo: el servidor lo acepta desde el 2026-09-07 (lista blanca opcional +
   * migración 0025), ANTES de que este emisor lo mandara — el orden servidor-
   * primero del bloque de toWire, cumplido.
   */
  eliminatedInputFloorCost?: number;
  /** Atribución de sesión/subagente del gateway (identidades opacas, nunca una persona). */
  sessionId?: string;
  agentId?: string;
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
  /**
   * Which surface owns this process: the local gateway (`bvsala claude` and
   * friends) or the in-process SDK. Sent with the version in the batch's
   * `x-bvsala-version` header (`gateway/0.4.16`, `sdk/0.4.16`) so the control
   * plane can tell a gateway that lacks a lever from an SDK that never had it.
   * Defaults to `"sdk"`; the gateway sets `"gateway"`.
   */
  surface?: "gateway" | "sdk";
  /**
   * Se llama cuando el ingest rechaza la credencial (401/403). Existe para que un
   * despliegue con observabilidad pueda ENTERARSE: el aviso por consola sirve en
   * un portátil, pero en producción los `console.warn` no despiertan a nadie, y
   * este fallo concreto es invisible por definición —deja de llegar uso, que es
   * exactamente lo mismo que se ve cuando no hay tráfico—.
   */
  onAuthError?: (status: number) => void;
  /**
   * Silence the console warnings. They are ON by default, exactly as in the
   * revocation poller: metering is best-effort, so a broken ingest breaks
   * nothing visible — usage simply stops arriving, silently, and the customer's
   * dashboard stays empty forever.
   */
  silenceWarnings?: boolean;
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
  // La promesa del flush EN VUELO (null si no hay ninguno). Antes era un booleano
  // `flushing` y flush() salía en seco si estaba puesto; eso hacía que un cierre
  // limpio (stopAndDrain) que caía sobre un auto-flush en curso creyera que no
  // avanzaba y cortara. Ahora un flush concurrente se ESPERA en vez de saltarse.
  private inflight: Promise<void> | null = null;
  /**
   * CONSECUTIVE failed flushes. Warn on the third and then every twelfth: one
   * lost batch is normal, a whole hour is not. Same cadence as the revocation
   * poller on purpose — two different rhythms for the same class of failure
   * only confuse whoever reads the logs.
   */
  private fallosSeguidos = 0;

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

  /** Stop the timer and attempt a final flush. Safe to call more than once.
   *  Fire-and-forget: for a CLEAN shutdown that must not lose the last batch,
   *  use `stopAndDrain` and await it. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    void this.flush();
  }

  /** Clean shutdown: stop the timer and DRAIN the buffer, awaiting each POST.
   *  Unlike `stop()` (fire-and-forget), this resolves only once the final batch
   *  has actually been sent, so a graceful exit doesn't lose the last session's
   *  usage. Bounded, so an unreachable control plane can't block shutdown. */
  // Antes `stop()` disparaba el flush sin esperarlo y el exit del gateway mataba
  // el POST en vuelo: el último lote de CADA sesión de `bvsala claude` se perdía
  // (caza del 27-08). Acotado: si un 5xx re-encola y no se avanza, se corta.
  async stopAndDrain(maxIntentos?: number): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Por defecto, suficientes vueltas para drenar el buffer LLENO (un lote por
    // vuelta) más un margen para las iteraciones que solo esperan un flush en
    // vuelo: si no, con el buffer cerca del tope un cierre grácil dejaría la
    // mitad sin enviar. Sigue acotado: el break por 2 sin-avance corta un 5xx.
    const tope = maxIntentos ?? Math.ceil(this.maxBuffer / this.maxBatch) + 4;
    // Se corta tras DOS iteraciones seguidas sin avance (un 5xx que re-encola),
    // no tras una: la primera puede limitarse a esperar un flush YA en vuelo que
    // drenó otro lote, y el buffer actual aún no ha bajado — la siguiente sí lo
    // envía. Así no se cuelga con el control plane caído ni se corta a medias.
    let sinAvance = 0;
    for (let i = 0; i < tope && this.buffer.length > 0; i++) {
      const antes = this.buffer.length;
      await this.flush();
      sinAvance = this.buffer.length >= antes ? sinAvance + 1 : 0;
      if (sinAvance >= 2) break;
    }
  }

  /**
   * Flush one batch. Never throws. A transient server error (5xx) or network
   * failure re-queues the batch (capped); a 4xx (bad request / bad key) drops it,
   * since retrying a rejected payload would loop forever.
   */
  async flush(): Promise<void> {
    // Un flush ya en curso se ESPERA (no se salta): así el drenaje del cierre no
    // lo confunde con "no hay nada que enviar".
    if (this.inflight) return this.inflight;
    if (this.buffer.length === 0) return;
    this.inflight = this.hacerFlush();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async hacerFlush(): Promise<void> {
    const doFetch = this.options.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!doFetch) return; // no fetch → cannot emit; never throw
    const batch = this.buffer.splice(0, this.maxBatch);
    try {
      const records: UsageWire[] = batch.map((e) => this.toWire(e));
      const res = await doFetch(this.options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.serviceAccountKey}`,
          // Versión del PROCESO, no de la petición: CABECERA del lote a
          // propósito. Un campo nuevo en el cuerpo tumba el lote entero en un
          // servidor que no lo conozca (lista blanca → 400 → sin reintento, ver
          // toWire); una cabecera la ignora. El servidor la valida y la sella
          // por asiento (seat_activity, 0024). Es la ÚNICA excepción al canal
          // cerrado, y test/metering-emitter.test.ts fija el conjunto EXACTO de
          // cabeceras (nunca «contiene»): la siguiente que alguien quiera
          // añadir tiene que venir a discutirla aquí.
          [CABECERA_VERSION]: `${this.options.surface ?? "sdk"}/${BV_SALA_VERSION}`,
        },
        body: JSON.stringify(records),
      });
      if (res.ok) {
        this.fallosSeguidos = 0;
      } else if (res.status >= 500) {
        this.fallosSeguidos++;
        this.requeue(batch);
        this.avisarDeFallo(`the server responded ${res.status}`);
      } else if (res.status === 401 || res.status === 403) {
        // UNA CREDENCIAL MALA NO SE CURA SOLA, a diferencia de un 5xx, y hasta
        // ahora este lote se descartaba SIN log, sin excepción y sin callback.
        // Consecuencia: rotar la `bvk_` y olvidar actualizarla dejaba de reportar
        // uso para siempre, en silencio — y el panel, al no llegarle filas, le
        // decía al cliente «aún no estamos midiendo tu tráfico: instala el SDK»
        // a alguien que lo tenía instalado y funcionando. El síntoma apuntaba al
        // sitio opuesto de la causa.
        avisarUnaVez(
          `metering-auth-${res.status}`,
          `[bv-sala] usage reporting is being rejected with HTTP ${res.status} at ${this.options.url}. ` +
            `Check 'serviceAccountKey' (rotated? revoked? from another organization?). Until it ` +
            `works, no usage is reported: the dashboard will say it sees no traffic and billable seats ` +
            `will show zero.`,
        );
        this.options.onAuthError?.(res.status);
      } else {
        // EL HUECO QUE FALTABA, y el más fácil de pisar: un 404 o un 405 no es
        // 5xx ni es 401/403, así que el lote se descartaba SIN UNA SOLA SEÑAL.
        //
        // Es exactamente lo que pasa con la `meteringUrl` mal puesta: por defecto
        // es `${licenseServerUrl}/api/metering/usage`, y quien la fija "para ser
        // explícito" olvidando la ruta apunta a la raíz del sitio, que contesta
        // con una página. El uso se pierde entero y el panel dice, durante meses,
        // que no ve tráfico — a alguien que lo tiene todo funcionando.
        this.fallosSeguidos++;
        this.avisarDeFallo(
          res.status === 404 || res.status === 405
            ? `HTTP ${res.status}: the reporting URL looks wrong`
            : `the server rejected the batch with HTTP ${res.status}`,
        );
      }
    } catch (err) {
      this.fallosSeguidos++;
      this.requeue(batch);
      this.avisarDeFallo(err instanceof Error ? err.message : "network error");
    }
  }

  /**
   * THE INGEST HAS BEEN FAILING FOR A WHILE AND NOBODY NOTICED.
   *
   * Metering is best-effort by design — it must never take down the customer's
   * request — and that turns every failure into SILENT data loss. Without this,
   * the only symptom is an empty dashboard, which is indistinguishable from
   * "you haven't sent anything yet": the symptom points the opposite way from
   * the cause.
   *
   * Warns on the third consecutive failure and then every twelfth. Not the
   * first — a lost request is normal — and not every one, which becomes noise.
   */
  private avisarDeFallo(motivo: string): void {
    if (this.options.silenceWarnings) return;
    const n = this.fallosSeguidos;
    if (n < 3 || (n - 3) % 12 !== 0) return;
    console.warn(
      `[bv-sala] usage reporting has failed ${n} times in a row against ${this.options.url} ` +
        `(${motivo}). Requests keep working, but usage is not arriving: the dashboard will say ` +
        `it sees no traffic and billable seats will show zero. Check 'meteringUrl' — by default ` +
        `it is \`\${licenseServerUrl}/api/metering/usage\`.`,
    );
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
      // B2 · el suelo de la elisión del proveedor, SOLO con dinero y con conteo
      // (el ingest recorta «dinero sin conteo» a 0 de todas formas). Ausente en
      // el resto: un gateway que nunca borra manda el wire de siempre.
      ...(r.cost.eliminatedInputFloorCost !== undefined &&
      Number.isFinite(r.cost.eliminatedInputFloorCost) &&
      r.cost.eliminatedInputFloorCost > 0 &&
      r.tokens.eliminatedInput > 0
        ? { eliminatedInputFloorCost: r.cost.eliminatedInputFloorCost }
        : {}),
      // `report.qualityStatus` NO viaja todavía, y es a propósito. El ingest
      // valida con LISTA BLANCA y rechaza el registro entero ante un campo
      // desconocido —ese rechazo es el cortafuegos que impide que se cuele
      // contenido del cliente—, así que un SDK que lo mandara antes de que el
      // servidor lo conozca recibiría un 4xx, el lote se descarta (un 4xx no se
      // reintenta: reintentar un payload rechazado es un bucle) y ese cliente
      // deja de reportar uso hasta que actualice otra vez. npm es inmutable, o
      // sea que no habría vuelta atrás. El orden obligatorio es SERVIDOR
      // PRIMERO, SDK DESPUÉS; hasta entonces la etiqueta vive en el informe por
      // petición, que es donde el cliente ya puede leerla.
      //
      // LA EXCEPCIÓN, declarada: la versión del proceso NO va en el cuerpo sino
      // en la cabecera `x-bvsala-version` del POST (hacerFlush). Una cabecera
      // no pasa por la lista blanca —un servidor viejo la ignora y nada se
      // rompe—, y ESO es precisamente lo que la hace peligrosa como precedente:
      // el mismo argumento valdría para colar cualquier campo futuro esquivando
      // el cortafuegos. Por eso la excepción es una sola, lleva un valor con
      // patrón cerrado (superficie/semver, validado en el servidor, jamás texto
      // libre) y el conjunto de cabeceras queda atado por test EXACTO. Lo que
      // describa una PETICIÓN sigue yendo en el cuerpo y sigue esperando al
      // servidor. `eliminatedInputFloorCost` (arriba) es la regla cumplida al
      // pie de la letra: lista blanca + migración 0025 desplegadas el 07-09,
      // emisor en 0.4.17 — y aun así OPCIONAL y solo cuando hay dinero.
      baselineCost: r.cost.baselineEstimate,
      actualCost: r.cost.actual,
      netSavings: r.cost.netSavings,
      // Viaja para que el panel agregue el dinero MEDIDO aparte del estimado.
      ...(r.cost.basis ? { basis: r.cost.basis } : {}),
      // Atribución del gateway (0019): el servidor ya la acepta — el orden
      // servidor-primero del comentario de arriba se cumplió antes de emitirla.
      ...(r.attribution?.sessionId ? { sessionId: r.attribution.sessionId } : {}),
      ...(r.attribution?.agentId ? { agentId: r.attribution.agentId } : {}),
    };
  }
}
