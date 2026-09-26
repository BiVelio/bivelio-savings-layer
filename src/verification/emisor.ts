import type { VerificationCheck } from "../contracts/verification.js";
import { avisarUnaVez } from "../util/warn-once.js";
import { randomId } from "../util/id.js";
import { BV_SALA_VERSION, CABECERA_VERSION } from "../version.js";

// EL EMISOR DE LOS PARES. Mismo patrón que `UsageEmitter` (buffer acotado,
// flush que nunca lanza, reintento de 5xx) y SIN tocarlo: un canal propio,
// `POST /api/metering/verification`, con su propio sobre. Un 404 de este
// endpoint (un servidor que aún no lo tiene) no afecta en nada a la medición de
// uso: solo se pierden pares, con aviso.
//
// Solo cuentas: ids, modelos, tokens, costes, tarifas y resultados. Jamás un
// prompt ni una respuesta.

/** Una muestra en el cable. Las claves `naive*` van si y solo si `outcome === "paired"`. */
export interface MuestraEnElCable {
  basis: "verification";
  requestId: string;
  at: number;
  stratum: string;
  outcome: string;
  requestedModel: string;
  servedModel: string;
  cacheResult: string;
  optimizedCost: number;
  optimizedInputTokens: number;
  optimizedCachedInputTokens: number;
  optimizedOutputTokens: number;
  naiveCost?: number;
  naiveInputTokens?: number;
  naiveCachedInputTokens?: number;
  naiveOutputTokens?: number;
  naiveFinishReason?: string;
  naiveContract?: string;
  inputPer1k: number;
  cachedInputPer1k?: number;
  outputPer1k: number;
}

export interface ConteoEnElCable {
  day: string;
  category: string;
  requests: number;
}

export interface SobreDeVerificacion {
  batchId: string;
  samples: MuestraEnElCable[];
  counts: ConteoEnElCable[];
}

export const MAX_PENDIENTES = 2000;
export const MUESTRAS_POR_SOBRE = 200;
export const CONTEOS_POR_SOBRE = 200;
export const MAX_REINTENTOS = 10;
/** El tope por conteo que admite el servidor; el sobrante se queda para el siguiente sobre. */
export const MAX_PETICIONES_POR_CONTEO = 10_000_000;
/** Sobres por flush, como mucho: `stop()` y el reposo vacían algo más que uno. */
const SOBRES_POR_FLUSH = 5;
/** El tope de futuro del servidor (wire.ts, `FUTURO_MAXIMO_MS`): un `at` más allá tumbaría el lote entero. */
const FUTURO_MAXIMO_MS = 48 * 3600 * 1000;

const ID = /^[A-Za-z0-9._:/-]{1,128}$/;
const contable = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
// El mismo tope que el servidor: ningún lado de un par ni ninguna tarifa por 1K
// pasa de 1000 USD; por encima no es un coste, es un número roto.
const dinero = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1000;

// Del check al cable, con las MISMAS reglas que el validador del servidor
// (apps/web/lib/verificacion/wire.ts): una muestra que el servidor rechazaría
// tumbaría el lote entero (400, sin reintento, y con él los conteos), así que se
// descarta AQUÍ, sola. `onCheck` la recibe igual; lo que no viaja es solo esta
// copia al panel. `ahora` es el reloj del emisor: un `now` inyectado o un reloj
// adelantado más de 48 h no puede tumbar el sobre.
export function muestraEnElCable(c: VerificationCheck, opciones: { ahora?: number } = {}): MuestraEnElCable | null {
  if (!ID.test(c.requestId) || !ID.test(c.requestedModel) || !ID.test(c.servedModel)) return null;
  if (typeof c.at !== "number" || !Number.isFinite(c.at) || c.at < 1e12) return null;
  const ahora = typeof opciones?.ahora === "number" ? opciones.ahora : Date.now();
  if (c.at > ahora + FUTURO_MAXIMO_MS) return null;
  const o = c.optimized;
  if (!dinero(o.cost)) return null;
  if (!contable(o.inputTokens) || !contable(o.cachedInputTokens) || !contable(o.outputTokens)) return null;
  const p = c.prices;
  if (!dinero(p.inputPer1k) || !dinero(p.outputPer1k)) return null;
  if (p.cachedInputPer1k !== undefined && !dinero(p.cachedInputPer1k)) return null;
  const m: MuestraEnElCable = {
    basis: "verification",
    requestId: c.requestId,
    at: Math.floor(c.at),
    stratum: c.stratum,
    outcome: c.outcome,
    requestedModel: c.requestedModel,
    servedModel: c.servedModel,
    cacheResult: c.cacheResult,
    optimizedCost: o.cost,
    optimizedInputTokens: o.inputTokens,
    // El servidor exige cached ≤ input; el precio ya los trata así (min).
    optimizedCachedInputTokens: Math.min(o.cachedInputTokens, o.inputTokens),
    optimizedOutputTokens: o.outputTokens,
    inputPer1k: p.inputPer1k,
    ...(p.cachedInputPer1k !== undefined ? { cachedInputPer1k: p.cachedInputPer1k } : {}),
    outputPer1k: p.outputPer1k,
  };
  if (c.outcome === "paired") {
    const n = c.naive;
    if (!n) return null;
    if (!dinero(n.cost) || !contable(n.inputTokens) || !contable(n.cachedInputTokens) || !contable(n.outputTokens)) {
      return null;
    }
    if (n.cachedInputTokens > n.inputTokens) return null;
    m.naiveCost = n.cost;
    m.naiveInputTokens = n.inputTokens;
    m.naiveCachedInputTokens = n.cachedInputTokens;
    m.naiveOutputTokens = n.outputTokens;
    if (n.finishReason !== undefined) {
      if (!/^[a-z_]{1,32}$/.test(n.finishReason)) return null;
      m.naiveFinishReason = n.finishReason;
    }
    m.naiveContract = n.contract;
  }
  return m;
}

export interface OpcionesDelEmisorDeVerificacion {
  /** URL completa, p. ej. `https://savings.bivelio.com/api/metering/verification`. */
  url: string;
  serviceAccountKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  flushIntervalMs?: number;
  silenceWarnings?: boolean;
  randomId?: () => string;
}

export class EmisorDeVerificacion {
  private readonly o: OpcionesDelEmisorDeVerificacion;
  private readonly flushIntervalMs: number;
  private pendientes: MuestraEnElCable[] = [];
  private readonly conteos = new Map<string, number>();
  private reintentos: SobreDeVerificacion[] = [];
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private fallosSeguidos = 0;
  /** Cuándo falló el último envío reintentable (5xx o red). */
  private ultimoFallo = Number.NEGATIVE_INFINITY;

  constructor(o: OpcionesDelEmisorDeVerificacion) {
    this.o = o;
    this.flushIntervalMs = o.flushIntervalMs ?? 15_000;
  }

  private ahora(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Un check decidido. O(1), nunca lanza. */
  encolar(c: VerificationCheck): void {
    let m: MuestraEnElCable | null;
    try {
      m = muestraEnElCable(c, { ahora: this.ahora() });
    } catch {
      m = null;
    }
    if (!m) return;
    this.pendientes.push(m);
    if (this.pendientes.length > MAX_PENDIENTES) {
      this.pendientes.splice(0, this.pendientes.length - MAX_PENDIENTES);
    }
    if (this.pendientes.length >= MUESTRAS_POR_SOBRE) void this.flushSiToca();
  }

  /**
   * El flush que NO marca el intervalo (el umbral de 200 y el reposo tras la
   * última copia). Con un reintento pendiente de un fallo reciente, espera al
   * intervalo: si no, durante un 5xx sostenido cada comprobación dispararía un
   * POST (invocaciones y filas de `verification_batches_seen` que pagamos
   * nosotros), al ritmo del tráfico y no al del reloj. Nunca lanza.
   */
  flushSiToca(): Promise<void> {
    if (this.reintentos.length > 0 && this.ahora() - this.ultimoFallo < this.flushIntervalMs) return Promise.resolve();
    return this.flush();
  }

  /** Una petición contada en su estrato o su exclusión. */
  contar(dia: string, categoria: string): void {
    const k = `${dia}|${categoria}`;
    this.conteos.set(k, (this.conteos.get(k) ?? 0) + 1);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    void this.flush();
  }

  /** Nunca lanza. Un flush en vuelo se espera, no se salta. */
  async flush(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.hacerFlush();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private hayAlgo(): boolean {
    return this.reintentos.length > 0 || this.pendientes.length > 0 || this.conteos.size > 0;
  }

  private siguienteSobre(): SobreDeVerificacion | null {
    const reintento = this.reintentos.shift();
    if (reintento) return reintento;
    if (this.pendientes.length === 0 && this.conteos.size === 0) return null;
    const samples = this.pendientes.splice(0, MUESTRAS_POR_SOBRE);
    const counts: ConteoEnElCable[] = [];
    for (const [k, n] of this.conteos) {
      if (counts.length >= CONTEOS_POR_SOBRE) break;
      const [day = "", category = ""] = k.split("|");
      const va = Math.min(n, MAX_PETICIONES_POR_CONTEO);
      counts.push({ day, category, requests: va });
      if (n > va) this.conteos.set(k, n - va);
      else this.conteos.delete(k);
    }
    return { batchId: (this.o.randomId ?? randomId)(), samples, counts };
  }

  private async hacerFlush(): Promise<void> {
    const doFetch = this.o.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!doFetch) return;
    for (let i = 0; i < SOBRES_POR_FLUSH && this.hayAlgo(); i++) {
      const sobre = this.siguienteSobre();
      if (!sobre) return;
      const seguir = await this.enviar(doFetch, sobre);
      if (!seguir) return;
    }
  }

  /** Envía un sobre. Devuelve si tiene sentido seguir con el siguiente. */
  private async enviar(doFetch: typeof fetch, sobre: SobreDeVerificacion): Promise<boolean> {
    try {
      const res = await doFetch(this.o.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.o.serviceAccountKey}`,
          "content-type": "application/json",
          [CABECERA_VERSION]: `sdk/${BV_SALA_VERSION}`,
        },
        body: JSON.stringify(sobre),
      });
      if (res.ok) {
        this.fallosSeguidos = 0;
        return true;
      }
      if (res.status >= 500) {
        this.fallosSeguidos++;
        this.ultimoFallo = this.ahora();
        this.reencolar(sobre);
        this.avisarDeFallo(`the server responded ${res.status}`);
        return false;
      }
      if (res.status === 401 || res.status === 403) {
        if (!this.o.silenceWarnings) {
          avisarUnaVez(
            `verification-auth-${res.status}`,
            `[bvsala] verification reporting is being rejected with HTTP ${res.status} at ${this.o.url}. ` +
              "Check `serviceAccountKey`. Pairs are not reaching your dashboard; your requests and " +
              "your usage reporting are not affected.",
          );
        }
        return false;
      }
      // Otro 4xx: un sobre rechazado no se reintenta (sería un bucle).
      this.fallosSeguidos++;
      this.avisarDeFallo(
        res.status === 404 || res.status === 405
          ? `HTTP ${res.status}: the reporting URL looks wrong, or the server does not have this feature yet`
          : `the server rejected the batch with HTTP ${res.status}`,
      );
      return false;
    } catch (err) {
      this.fallosSeguidos++;
      this.ultimoFallo = this.ahora();
      this.reencolar(sobre);
      this.avisarDeFallo(err instanceof Error ? err.message : "network error");
      return false;
    }
  }

  // El MISMO sobre (mismo batchId) vuelve al frente: el servidor lo deduplica por
  // `verification_batches_seen`. Con más de MAX_REINTENTOS se descarta el más
  // antiguo, que es el del FONDO (el recién fallado acaba de entrar por delante).
  private reencolar(sobre: SobreDeVerificacion): void {
    this.reintentos.unshift(sobre);
    while (this.reintentos.length > MAX_REINTENTOS) this.reintentos.pop();
  }

  // W5 · el 3.º fallo seguido y luego cada 12, como el emisor de uso.
  private avisarDeFallo(motivo: string): void {
    if (this.o.silenceWarnings) return;
    const n = this.fallosSeguidos;
    if (n < 3 || (n - 3) % 12 !== 0) return;
    console.warn(
      `[bvsala] verification reporting has failed ${n} times in a row against ${this.o.url} (${motivo}). ` +
        "Your requests and usage reporting keep working; the pairs are not arriving.",
    );
  }

  /** Solo para tests: lo que queda por enviar. */
  get estado(): { pendientes: number; conteos: number; reintentos: number } {
    return { pendientes: this.pendientes.length, conteos: this.conteos.size, reintentos: this.reintentos.length };
  }
}
