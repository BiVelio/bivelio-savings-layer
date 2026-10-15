import { sha256 } from "../util/hash.js";
import { stableStringify } from "../canonicalization/canonicalize.js";
import {
  LibroDeRecibos,
  idDeIntento,
  reciboDeIntento,
  tarifarIntento,
  type AttemptKind,
  type AttemptUsage,
  type ReciboDeIntento,
  type TotalDeLlamada,
} from "./intento.js";

// ═══════════════════════════════════════════════════════════════════════════
// RESERVAR Y LIQUIDAR (plan Caveman 2026-10-14, p. 8 · D07).
// ═══════════════════════════════════════════════════════════════════════════
//
// El objetivo NO es controlar el gasto del proveedor —un tope interno no para
// un usage tardío ni lo que ya se facturó—: es no ADMITIR trabajo que exceda el
// tope por una carrera evitable, y enseñar la exposición que sigue abierta.
//
// La máquina de estados de un intento (cada solicitud que pudo generar coste):
//
//   (planned) ──reservar──▶ reserved ──marcarEnviado──▶ dispatched ──liquidar──▶ settled
//                              │  │                           │
//                              │  └─liberar (con PRUEBA)──▶ released
//                              │                              │
//                              └──marcarIncierto──▶ uncertain ◀┘ (cancelación, stream
//                                                     │          cortado, usage ausente,
//                                                     │          timeout local, sin precio)
//                                                     ├─liquidar (uso completo y precio)──▶ settled
//                                                     └─estimar (etiquetado)──────────────▶ estimated
//
// Las reglas, que los tests fijan una a una:
//   · Reservar es UN paso condicional y atómico: gastado + estimado + exposición
//     pendiente + importe <= tope. Cien reservas a la vez no pasan del tope.
//   · `marcarEnviado` se llama ANTES del primer byte del cuerpo. Así `reserved`
//     significa «no salió» y `dispatched` «pudo salir»; un timeout local después
//     de enviar NO es prueba de nada, y un intento enviado nunca se libera.
//   · Liquidar exige usage completo del proveedor y precio propio del catálogo
//     (`tarifarIntento` de D02). Si no, el intento pasa a `uncertain` y CONSERVA
//     su exposición: lo desconocido nunca cuesta 0.
//   · El recibo liquidado se apunta en el `LibroDeRecibos` de D02 (no hay una
//     segunda contabilidad): repetir el MISMO recibo es un no-op; otro cuerpo
//     para el mismo intento es `ConflictoDeRecibo`.
//   · Un reintento al proveedor es un intento NUEVO (otro ordinal) con su propia
//     reserva. Reservar dos veces el mismo intento con el mismo sobre no suma.
//   · `estimated` es una liquidación ETIQUETADA: cuenta para el tope pero nunca
//     es coste verificado (ni ahorro verificado).
//   · Dinero en micro-USD ENTEROS y moneda explícita; sin FX, sin coma flotante.
//
// Cada transición deja un evento en la outbox DENTRO de la misma sección
// crítica (aquí, en memoria; en la base, en la misma transacción de la RPC de
// db/migrations/0036_presupuesto_intentos.sql). Entrega al menos una vez,
// deduplicada por `eventId`, ordenada por proyecto + llamada lógica; el
// agregador tolera la llegada fuera de orden.
//
// SIN CABLEAR: ni el gateway ni el pipeline ni el ingest lo usan todavía, y no
// toca `USAGE_ALLOWED_FIELDS`. Interno: src/index.ts no lo reexporta.

export const MONEDA = "USD" as const;
export type Moneda = typeof MONEDA;

const ATTO_POR_MICRO = 1_000_000_000_000n;
const PATRON_DE_PROYECTO = /^[A-Za-z0-9._:/-]{1,96}$/;

function enteroSeguro(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

// ── El sobre: la cota superior de un intento ─────────────────────────────────

/**
 * Lo que un intento PUEDE llegar a costar, dicho en contadores. Es lo que se
 * reserva antes de enviar; la reserva es su cota, no una predicción.
 */
export interface SobreDePresupuesto {
  model: string;
  /** Tokens de entrada como máximo (estimación por exceso de la petición ya proyectada). */
  maxInputTokens: number;
  /** El `max_tokens` de la petición. Ausente = la salida no está acotada. */
  maxOutputTokens?: number;
  /**
   * El razonamiento oculto:
   *   · `dentro_de_salida`: lo cubre `max_tokens` (Anthropic, Chat, Responses);
   *   · `{ maxTokens }`: se factura APARTE y la petición lo acota;
   *   · `sin_control`: se factura y nada lo acota → no hay cota fiable.
   */
  razonamiento: "dentro_de_salida" | { maxTokens: number } | "sin_control";
  /** Si la petición puede escribir caché (cache_control, breakpoint implícito): se cota a la prima más cara. */
  escriturasDeCache: boolean;
  /** Intentos que admite la llamada lógica, primaria incluida (reintentos + reparaciones + recuperaciones). */
  maxIntentos: number;
}

export type MotivoSinCota =
  | "envelope-invalid"
  | "output-unbounded"
  | "reasoning-uncontrolled"
  | "no-catalog-price"
  | "inherited-price"
  | "long-context-tier"
  | "price-not-representable";

export type CotaDeSobre =
  | {
      state: "acotada";
      /** La cota en micro-USD, redondeada HACIA ARRIBA. */
      amountMicroUsd: number;
      currency: Moneda;
      priceVersion: string;
    }
  | { state: "sin_cota"; reason: MotivoSinCota; detail: string };

function sobreInvalido(s: SobreDePresupuesto): string | undefined {
  if (typeof s.model !== "string" || s.model === "") return "model is empty";
  if (!enteroSeguro(s.maxInputTokens) || s.maxInputTokens === 0) return "maxInputTokens must be a positive safe integer";
  if (s.maxOutputTokens !== undefined && (!enteroSeguro(s.maxOutputTokens) || s.maxOutputTokens === 0)) {
    return "maxOutputTokens must be a positive safe integer";
  }
  if (typeof s.razonamiento === "object" && !enteroSeguro(s.razonamiento.maxTokens)) {
    return "razonamiento.maxTokens must be a safe non-negative integer";
  }
  if (!Number.isSafeInteger(s.maxIntentos) || s.maxIntentos < 1) return "maxIntentos must be an integer >= 1";
  return undefined;
}

/**
 * La cota superior de un sobre con el catálogo versionado, reutilizando la
 * tarifa de D02: se tarifa el PEOR reparto posible de la entrada (toda sin
 * caché, toda leída, toda escrita a 5 min, toda escrita a 1 h) con la salida
 * al máximo, y se queda el mayor. Lo que la tarifa no da por `priced` (modelo
 * sin precio, precio heredado, tramo de contexto largo) no es una cota.
 */
export function cotaDeSobre(sobre: SobreDePresupuesto, at: number): CotaDeSobre {
  const invalido = sobreInvalido(sobre);
  if (invalido) return { state: "sin_cota", reason: "envelope-invalid", detail: invalido };
  if (sobre.maxOutputTokens === undefined) {
    return { state: "sin_cota", reason: "output-unbounded", detail: "the request has no max_tokens" };
  }
  if (sobre.razonamiento === "sin_control") {
    return { state: "sin_cota", reason: "reasoning-uncontrolled", detail: "billable reasoning with no bound on the request" };
  }
  const salida = sobre.maxOutputTokens + (typeof sobre.razonamiento === "object" ? sobre.razonamiento.maxTokens : 0);
  if (!Number.isSafeInteger(salida)) return { state: "sin_cota", reason: "envelope-invalid", detail: "output bound overflows" };
  const n = sobre.maxInputTokens;
  const repartos = [
    { inputUncached: n, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    { inputUncached: 0, cacheRead: n, cacheWrite5m: 0, cacheWrite1h: 0 },
    ...(sobre.escriturasDeCache
      ? [
          { inputUncached: 0, cacheRead: 0, cacheWrite5m: n, cacheWrite1h: 0 },
          { inputUncached: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: n },
        ]
      : []),
  ];
  let maximo = -1n;
  let version = "";
  for (const r of repartos) {
    const uso: AttemptUsage = {
      ...r,
      output: salida,
      reasoningIncludedInOutput: true,
      basis: "provider_reported",
      completeness: "complete",
    };
    const p = tarifarIntento(sobre.model, uso, at);
    if (p.state !== "priced") {
      const reason: MotivoSinCota =
        p.state === "unpriced"
          ? "no-catalog-price"
          : p.reason === "inherited-price" || p.reason === "long-context-tier" || p.reason === "price-not-representable"
            ? p.reason
            : "price-not-representable";
      return { state: "sin_cota", reason, detail: p.detail };
    }
    const atto = BigInt(p.exactAttoUsd);
    if (atto > maximo) maximo = atto;
    version = p.priceVersion;
  }
  const micro = (maximo + ATTO_POR_MICRO - 1n) / ATTO_POR_MICRO;
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { state: "sin_cota", reason: "price-not-representable", detail: "the bound does not fit a safe integer of micro-USD" };
  }
  return { state: "acotada", amountMicroUsd: Number(micro), currency: MONEDA, priceVersion: version };
}

// ── El presupuesto y los intentos ────────────────────────────────────────────

/** El tope de un proyecto. */
export interface Presupuesto {
  projectId: string;
  capMicroUsd: number;
  currency: Moneda;
  /** Tope estricto: un sobre sin cota fiable se RECHAZA. */
  estricto: boolean;
  /**
   * Solo sin `estricto`: lo que se reserva para un sobre sin cota fiable (la
   * política conservadora). Ausente → ese sobre se rechaza igual.
   */
  reservaConservadoraMicroUsd?: number;
}

/** Quién es un intento. `attemptId` sale de `idDeIntento(logicalCallId, attempt)` (D02). */
export interface ClaveDeIntento {
  projectId: string;
  logicalCallId: string;
  /** Ordinal dentro de la llamada lógica (0 = la primaria). Un reintento al proveedor es OTRO ordinal. */
  attempt: number;
  kind: AttemptKind;
  experimentRunId?: string;
  armId?: string;
}

export const ESTADOS_DE_INTENTO = ["reserved", "dispatched", "settled", "released", "uncertain", "estimated"] as const;
export type EstadoDeIntento = (typeof ESTADOS_DE_INTENTO)[number];

/** Las transiciones permitidas. La base las repite en un trigger (0036). */
export const TRANSICIONES: Readonly<Record<EstadoDeIntento, readonly EstadoDeIntento[]>> = {
  reserved: ["dispatched", "released", "uncertain"],
  dispatched: ["settled", "uncertain"],
  uncertain: ["settled", "estimated", "uncertain"],
  settled: [],
  released: [],
  estimated: [],
};

/** Lo único que prueba que un intento reservado NO salió hacia el proveedor. */
export const MOTIVOS_DE_NO_ENVIO = ["abortado_antes_de_enviar", "rechazado_localmente", "sin_conexion"] as const;
export interface PruebaDeNoEnvio {
  tipo: "no_enviado";
  /**
   * · `abortado_antes_de_enviar`: se canceló antes de `marcarEnviado`;
   * · `rechazado_localmente`: una verja local (Privacy, tamaño) lo paró;
   * · `sin_conexion`: la conexión nunca se estableció (DNS, ECONNREFUSED), ni un byte salió.
   * Un timeout local NO está: tras enviar, no demuestra que no se facturó.
   */
  motivo: (typeof MOTIVOS_DE_NO_ENVIO)[number];
  detalle?: string;
}

export const MOTIVOS_DE_INCERTIDUMBRE = [
  "cancelado",
  "stream_truncado",
  "uso_ausente",
  "uso_parcial",
  "timeout_local",
  "sin_precio",
  "precio_incierto",
  "estado_desconocido",
] as const;
export type MotivoDeIncertidumbre = (typeof MOTIVOS_DE_INCERTIDUMBRE)[number];

/** Un intento tal como lo guarda el libro (copias: no se puede tocar desde fuera). */
export interface IntentoDePresupuesto extends ClaveDeIntento {
  attemptId: string;
  model: string;
  state: EstadoDeIntento;
  /** Lo reservado, fijado al reservar. Nunca cambia. */
  reservedMicroUsd: number;
  reservationBasis: "upper_bound" | "conservative_policy";
  /** Lo que este intento ocupa AHORA del tope sin estar liquidado (0 en estados terminales). */
  exposureMicroUsd: number;
  /** El coste verificado, solo en `settled`. */
  costMicroUsd?: number;
  /** La estimación etiquetada, solo en `estimated`. */
  estimatedMicroUsd?: number;
  /** Suelo conocido del coste (de un usage parcial), si lo hay. */
  lowerBoundMicroUsd?: number;
  /** El recibo de D02 que lo liquidó. */
  receiptEventId?: string;
  /** El coste verificado superó la reserva (la cota no aguantó: es un hallazgo, no se esconde). */
  exceededReservation?: boolean;
  priceVersion?: string;
  reservedAt: number;
  dispatchedAt?: number;
  providerCorrelation?: string;
  closedAt?: number;
  releaseProof?: PruebaDeNoEnvio;
  uncertainReason?: MotivoDeIncertidumbre;
  estimateSource?: string;
  /** La huella del sobre reservado: reservar otra vez con el mismo sobre es idempotente. */
  envelopeFingerprint: string;
}

/** Lo que el proyecto tiene comprometido. `available` puede ser negativo (un coste real que superó la reserva). */
export interface EstadoDePresupuesto {
  projectId: string;
  currency: Moneda;
  capMicroUsd: number;
  /** Liquidado y verificado. */
  spentMicroUsd: number;
  /** Liquidado por estimación (etiquetado; nunca verificado). */
  estimatedMicroUsd: number;
  /** Reservado o enviado, sin respuesta aún. */
  reservedMicroUsd: number;
  /** Retenido en intentos `uncertain`. */
  uncertainMicroUsd: number;
  /** La exposición pendiente: `reserved + uncertain`. Lo que la interfaz debe enseñar. */
  pendingExposureMicroUsd: number;
  availableMicroUsd: number;
  openAttempts: number;
}

export type ResultadoDeReserva =
  | {
      ok: true;
      attemptId: string;
      amountMicroUsd: number;
      basis: "upper_bound" | "conservative_policy";
      /** `true` si el intento ya estaba reservado con el mismo sobre: no sumó nada. */
      repeated: boolean;
      budget: EstadoDePresupuesto;
    }
  | {
      ok: false;
      reason: "no_budget" | "cap_exceeded" | "unbounded_envelope" | "attempt_limit" | "envelope_invalid";
      detail: string;
      budget?: EstadoDePresupuesto;
    };

export type ResultadoDeLiquidacion =
  | { state: "settled"; repeated: boolean; costMicroUsd: number; receiptEventId: string; exceededReservation: boolean }
  | { state: "uncertain"; reason: MotivoDeIncertidumbre; exposureMicroUsd: number; lowerBoundMicroUsd?: number };

/** Un evento de la outbox. Sin contenido: ids, estado y dinero. */
export interface EventoDePresupuesto {
  eventId: string;
  projectId: string;
  logicalCallId: string;
  attemptId: string;
  /** Monótono por proyecto + llamada lógica, desde 1. */
  seq: number;
  state: EstadoDeIntento;
  at: number;
  /** El importe de la transición: lo reservado, el coste, la exposición retenida, la estimación o 0. */
  amountMicroUsd: number;
  /** La exposición del intento tras la transición. */
  exposureMicroUsd: number;
  currency: Moneda;
  label: "verified" | "estimated" | "exposure" | "released";
  experimentRunId?: string;
  armId?: string;
  receiptEventId?: string;
}

/** Una transición que la máquina no admite (liquidar un liberado, liberar un enviado…). */
export class TransicionInvalida extends Error {
  readonly attemptId: string;
  constructor(attemptId: string, desde: EstadoDeIntento | "absent", hacia: string) {
    super(`invalid transition for ${attemptId}: ${desde} → ${hacia}`);
    this.name = "TransicionInvalida";
    this.attemptId = attemptId;
  }
}

/** Liberar sin una prueba de no-envío válida. */
export class PruebaInsuficiente extends Error {
  constructor(attemptId: string, motivo: string) {
    super(`release of ${attemptId} needs proof it was not sent: ${motivo}`);
    this.name = "PruebaInsuficiente";
  }
}

/** El mismo intento reservado con OTRO sobre u otra clave: dos reservas para un intento serían contar dos veces. */
export class ConflictoDeIntento extends Error {
  constructor(attemptId: string, motivo: string) {
    super(`attempt conflict on ${attemptId}: ${motivo}`);
    this.name = "ConflictoDeIntento";
  }
}

// ── La outbox ────────────────────────────────────────────────────────────────

/**
 * El contrato de la outbox duradera. Al menos una vez: lo no confirmado se
 * vuelve a entregar. `encolar` es idempotente por `eventId` (mismo cuerpo →
 * no-op; otro cuerpo → error). La implementación en memoria es la de
 * referencia; la duradera es `bvsala.presupuesto_outbox` (0036).
 */
export interface OutboxDePresupuesto {
  encolar(evento: EventoDePresupuesto): "encolado" | "repetido";
  /** Lo no confirmado, en orden por (proyecto, llamada lógica, seq). */
  pendientes(limite?: number): EventoDePresupuesto[];
  confirmar(eventIds: readonly string[]): number;
}

export class OutboxEnMemoria implements OutboxDePresupuesto {
  private readonly eventos = new Map<string, { huella: string; evento: EventoDePresupuesto; entregado: boolean }>();

  encolar(evento: EventoDePresupuesto): "encolado" | "repetido" {
    const huella = sha256(stableStringify(evento));
    const previo = this.eventos.get(evento.eventId);
    if (previo) {
      if (previo.huella === huella) return "repetido";
      throw new ConflictoDeIntento(evento.attemptId, `outbox event ${evento.eventId} with a different body`);
    }
    this.eventos.set(evento.eventId, { huella, evento: structuredClone(evento), entregado: false });
    return "encolado";
  }

  pendientes(limite = Number.POSITIVE_INFINITY): EventoDePresupuesto[] {
    return [...this.eventos.values()]
      .filter((e) => !e.entregado)
      .map((e) => e.evento)
      .sort(
        (a, b) =>
          (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0) ||
          (a.logicalCallId < b.logicalCallId ? -1 : a.logicalCallId > b.logicalCallId ? 1 : 0) ||
          a.seq - b.seq,
      )
      .slice(0, limite)
      .map((e) => structuredClone(e));
  }

  confirmar(eventIds: readonly string[]): number {
    let n = 0;
    for (const id of eventIds) {
      const e = this.eventos.get(id);
      if (e && !e.entregado) {
        e.entregado = true;
        n += 1;
      }
    }
    return n;
  }
}

/**
 * El id determinista de un evento: el mismo intento, estado y `seq` dan siempre
 * el mismo id. El separador es `|`, que ni el patrón de proyecto ni el de
 * intento admiten (así no hay dos tuplas con la misma cadena), y no `\u0000`
 * como en D02: un `text` de Postgres no puede llevar NUL, y la RPC de 0036
 * calcula este MISMO id con `sha256()` dentro de la base.
 */
export function idDeEventoDePresupuesto(projectId: string, attemptId: string, state: EstadoDeIntento, seq: number): string {
  return `bud_${sha256(`bvsala/presupuesto/v1|${projectId}|${attemptId}|${state}|${seq}`).slice(0, 32)}`;
}

/** Lo que el agregador sabe de un proyecto. */
export interface AgregadoDePresupuesto {
  spentMicroUsd: number;
  estimatedMicroUsd: number;
  pendingExposureMicroUsd: number;
  attempts: number;
}

/**
 * El lado del agregador. Tolera duplicados (dedup por `eventId`) y la llegada
 * fuera de orden: de cada intento vale el evento de mayor `seq`, y uno más
 * viejo que llega tarde se descarta (`obsoleto`). El resultado no depende del
 * orden de entrega.
 */
export class AgregadorDePresupuesto {
  private readonly vistos = new Set<string>();
  private readonly ultimo = new Map<string, EventoDePresupuesto>();

  aplicar(e: EventoDePresupuesto): "aplicado" | "repetido" | "obsoleto" {
    if (this.vistos.has(e.eventId)) return "repetido";
    this.vistos.add(e.eventId);
    const clave = `${e.projectId}\u0000${e.attemptId}`;
    const previo = this.ultimo.get(clave);
    if (previo && previo.seq > e.seq) return "obsoleto";
    this.ultimo.set(clave, structuredClone(e));
    return "aplicado";
  }

  resumen(projectId: string): AgregadoDePresupuesto {
    const r: AgregadoDePresupuesto = { spentMicroUsd: 0, estimatedMicroUsd: 0, pendingExposureMicroUsd: 0, attempts: 0 };
    for (const e of this.ultimo.values()) {
      if (e.projectId !== projectId) continue;
      r.attempts += 1;
      if (e.state === "settled") r.spentMicroUsd += e.amountMicroUsd;
      else if (e.state === "estimated") r.estimatedMicroUsd += e.amountMicroUsd;
      r.pendingExposureMicroUsd += e.exposureMicroUsd;
    }
    return r;
  }
}

// ── El libro de presupuesto ──────────────────────────────────────────────────

/**
 * El contrato. Asíncrono porque la implementación de verdad es una RPC de la
 * base (0036); la de memoria lo es igual para que los tests de carrera
 * ejerzan el mismo intercalado.
 */
export interface BudgetLedger {
  definirPresupuesto(p: Presupuesto): Promise<void>;
  reservar(clave: ClaveDeIntento, sobre: SobreDePresupuesto): Promise<ResultadoDeReserva>;
  /** Llamar ANTES del primer byte del cuerpo hacia el proveedor. */
  marcarEnviado(projectId: string, attemptId: string, d?: { providerCorrelation?: string }): Promise<void>;
  liquidar(projectId: string, attemptId: string, uso: AttemptUsage, d?: { providerCorrelation?: string }): Promise<ResultadoDeLiquidacion>;
  liberar(projectId: string, attemptId: string, prueba: PruebaDeNoEnvio): Promise<void>;
  marcarIncierto(projectId: string, attemptId: string, motivo: MotivoDeIncertidumbre, d?: { uso?: AttemptUsage }): Promise<void>;
  estimar(projectId: string, attemptId: string, d: { amountMicroUsd: number; source: string }): Promise<void>;
  estado(projectId: string): Promise<EstadoDePresupuesto | undefined>;
  intento(projectId: string, attemptId: string): Promise<IntentoDePresupuesto | undefined>;
  /** Intentos abiertos (reserved / dispatched / uncertain) más viejos que `edadMs`: el gancho de la alerta por antigüedad. */
  abiertosMasViejosQue(projectId: string, edadMs: number): Promise<IntentoDePresupuesto[]>;
  totalDeLlamada(projectId: string, logicalCallId: string): Promise<TotalDeLlamada | undefined>;
}

export interface OpcionesDelLibro {
  reloj?: () => number;
  outbox?: OutboxDePresupuesto;
  /**
   * Un punto de espera DENTRO de la sección crítica de `reservar`, entre leer
   * el estado y escribir la reserva: simula la latencia de una base para que
   * las pruebas de carrera intercalen de verdad. Producción no lo pasa.
   */
  latenciaSimulada?: () => Promise<void>;
  /** Avisado por `revisarAntiguedad` con los intentos abiertos más viejos que `umbralMs`. */
  alertaDeAntiguedad?: { umbralMs: number; avisar: (abiertos: IntentoDePresupuesto[]) => void };
}

interface CuentaDeProyecto {
  presupuesto: Presupuesto;
  gastado: number;
  estimado: number;
  reservado: number;
  incierto: number;
  libro: LibroDeRecibos;
  intentos: Map<string, IntentoDePresupuesto>;
  seqPorLlamada: Map<string, number>;
}

const ABIERTOS: ReadonlySet<EstadoDeIntento> = new Set(["reserved", "dispatched", "uncertain"]);

/**
 * Implementación en memoria, atómica por proyecto: cada operación corre en
 * exclusiva dentro de la cola de su proyecto (un mutex por proyecto), así que
 * leer-comprobar-escribir es una sola sección crítica, como el UPDATE
 * condicional de la RPC.
 */
export class BudgetLedgerEnMemoria implements BudgetLedger {
  private readonly cuentas = new Map<string, CuentaDeProyecto>();
  private readonly colas = new Map<string, Promise<void>>();
  private readonly reloj: () => number;
  readonly outbox: OutboxDePresupuesto;
  private readonly latencia: (() => Promise<void>) | undefined;
  private readonly alerta: OpcionesDelLibro["alertaDeAntiguedad"];

  constructor(opciones: OpcionesDelLibro = {}) {
    this.reloj = opciones.reloj ?? Date.now;
    this.outbox = opciones.outbox ?? new OutboxEnMemoria();
    this.latencia = opciones.latenciaSimulada;
    this.alerta = opciones.alertaDeAntiguedad;
  }

  private async enExclusiva<T>(projectId: string, f: () => Promise<T> | T): Promise<T> {
    const previa = this.colas.get(projectId) ?? Promise.resolve();
    let soltar!: () => void;
    const turno = new Promise<void>((r) => (soltar = r));
    const cola = previa.then(() => turno);
    this.colas.set(projectId, cola);
    await previa;
    try {
      return await f();
    } finally {
      soltar();
      if (this.colas.get(projectId) === cola) this.colas.delete(projectId);
    }
  }

  private cuenta(projectId: string): CuentaDeProyecto | undefined {
    return this.cuentas.get(projectId);
  }

  private intentoVivo(projectId: string, attemptId: string, hacia: string): { c: CuentaDeProyecto; i: IntentoDePresupuesto } {
    const c = this.cuenta(projectId);
    const i = c?.intentos.get(attemptId);
    if (!c || !i) throw new TransicionInvalida(attemptId, "absent", hacia);
    return { c, i };
  }

  private foto(c: CuentaDeProyecto): EstadoDePresupuesto {
    const pendiente = c.reservado + c.incierto;
    let abiertos = 0;
    for (const i of c.intentos.values()) if (ABIERTOS.has(i.state)) abiertos += 1;
    return {
      projectId: c.presupuesto.projectId,
      currency: MONEDA,
      capMicroUsd: c.presupuesto.capMicroUsd,
      spentMicroUsd: c.gastado,
      estimatedMicroUsd: c.estimado,
      reservedMicroUsd: c.reservado,
      uncertainMicroUsd: c.incierto,
      pendingExposureMicroUsd: pendiente,
      availableMicroUsd: c.presupuesto.capMicroUsd - c.gastado - c.estimado - pendiente,
      openAttempts: abiertos,
    };
  }

  /** Quita la exposición del intento de su cubo (reservado o incierto). */
  private soltarExposicion(c: CuentaDeProyecto, i: IntentoDePresupuesto): void {
    if (i.state === "uncertain") c.incierto -= i.exposureMicroUsd;
    else c.reservado -= i.exposureMicroUsd;
  }

  private emitir(c: CuentaDeProyecto, i: IntentoDePresupuesto, amountMicroUsd: number, label: EventoDePresupuesto["label"]): void {
    const seq = (c.seqPorLlamada.get(i.logicalCallId) ?? 0) + 1;
    c.seqPorLlamada.set(i.logicalCallId, seq);
    this.outbox.encolar({
      eventId: idDeEventoDePresupuesto(i.projectId, i.attemptId, i.state, seq),
      projectId: i.projectId,
      logicalCallId: i.logicalCallId,
      attemptId: i.attemptId,
      seq,
      state: i.state,
      at: this.reloj(),
      amountMicroUsd,
      exposureMicroUsd: i.exposureMicroUsd,
      currency: MONEDA,
      label,
      ...(i.experimentRunId !== undefined ? { experimentRunId: i.experimentRunId } : {}),
      ...(i.armId !== undefined ? { armId: i.armId } : {}),
      ...(i.receiptEventId !== undefined ? { receiptEventId: i.receiptEventId } : {}),
    });
  }

  async definirPresupuesto(p: Presupuesto): Promise<void> {
    if (!PATRON_DE_PROYECTO.test(p.projectId)) throw new TypeError(`invalid projectId: ${JSON.stringify(p.projectId)}`);
    if (p.currency !== MONEDA) throw new TypeError(`unsupported currency ${String(p.currency)}: only USD, no FX`);
    if (!enteroSeguro(p.capMicroUsd)) throw new TypeError("capMicroUsd must be a safe non-negative integer");
    if (p.reservaConservadoraMicroUsd !== undefined) {
      if (p.estricto) throw new TypeError("a strict cap has no conservative reserve: an unbounded envelope is rejected");
      if (!enteroSeguro(p.reservaConservadoraMicroUsd) || p.reservaConservadoraMicroUsd === 0) {
        throw new TypeError("reservaConservadoraMicroUsd must be a positive safe integer");
      }
    }
    await this.enExclusiva(p.projectId, () => {
      const previa = this.cuentas.get(p.projectId);
      if (previa) {
        // Cambiar el tope no toca lo comprometido: un tope por debajo de lo ya
        // gastado deja `available` negativo y rechaza lo siguiente.
        previa.presupuesto = { ...p };
        return;
      }
      this.cuentas.set(p.projectId, {
        presupuesto: { ...p },
        gastado: 0,
        estimado: 0,
        reservado: 0,
        incierto: 0,
        libro: new LibroDeRecibos(),
        intentos: new Map(),
        seqPorLlamada: new Map(),
      });
    });
  }

  async reservar(clave: ClaveDeIntento, sobre: SobreDePresupuesto): Promise<ResultadoDeReserva> {
    const attemptId = idDeIntento(clave.logicalCallId, clave.attempt);
    const huella = sha256(stableStringify({ clave, sobre }));
    return this.enExclusiva(clave.projectId, async () => {
      const c = this.cuenta(clave.projectId);
      if (!c) return { ok: false, reason: "no_budget", detail: `no budget for project ${clave.projectId}` };
      const previo = c.intentos.get(attemptId);
      if (previo) {
        if (previo.envelopeFingerprint !== huella) {
          throw new ConflictoDeIntento(attemptId, "already reserved with a different key or envelope");
        }
        return { ok: true, attemptId, amountMicroUsd: previo.reservedMicroUsd, basis: previo.reservationBasis, repeated: true, budget: this.foto(c) };
      }
      const ahora = this.reloj();
      const invalido = sobreInvalido(sobre);
      if (invalido) return { ok: false, reason: "envelope_invalid", detail: invalido, budget: this.foto(c) };
      if (clave.attempt >= sobre.maxIntentos) {
        return {
          ok: false,
          reason: "attempt_limit",
          detail: `attempt ${clave.attempt} exceeds the envelope's limit of ${sobre.maxIntentos} attempts`,
          budget: this.foto(c),
        };
      }
      const cota = cotaDeSobre(sobre, ahora);
      let importe: number;
      let basis: "upper_bound" | "conservative_policy";
      if (cota.state === "acotada") {
        importe = cota.amountMicroUsd;
        basis = "upper_bound";
      } else if (!c.presupuesto.estricto && c.presupuesto.reservaConservadoraMicroUsd !== undefined) {
        importe = c.presupuesto.reservaConservadoraMicroUsd;
        basis = "conservative_policy";
      } else {
        return {
          ok: false,
          reason: "unbounded_envelope",
          detail: `${cota.reason}: ${cota.detail}${c.presupuesto.estricto ? " (strict cap)" : " (no conservative policy)"}`,
          budget: this.foto(c),
        };
      }
      // LEER … (la latencia simulada cae aquí, entre leer y escribir) … ESCRIBIR.
      const comprometido = c.gastado + c.estimado + c.reservado + c.incierto;
      if (this.latencia) await this.latencia();
      if (comprometido + importe > c.presupuesto.capMicroUsd) {
        return {
          ok: false,
          reason: "cap_exceeded",
          detail: `${comprometido} committed + ${importe} > cap ${c.presupuesto.capMicroUsd} micro-USD`,
          budget: this.foto(c),
        };
      }
      const i: IntentoDePresupuesto = {
        ...structuredClone(clave),
        attemptId,
        model: sobre.model,
        state: "reserved",
        reservedMicroUsd: importe,
        reservationBasis: basis,
        exposureMicroUsd: importe,
        ...(cota.state === "acotada" ? { priceVersion: cota.priceVersion } : {}),
        reservedAt: ahora,
        envelopeFingerprint: huella,
      };
      c.reservado += importe;
      c.intentos.set(attemptId, i);
      this.emitir(c, i, importe, "exposure");
      return { ok: true, attemptId, amountMicroUsd: importe, basis, repeated: false, budget: this.foto(c) };
    });
  }

  async marcarEnviado(projectId: string, attemptId: string, d: { providerCorrelation?: string } = {}): Promise<void> {
    await this.enExclusiva(projectId, () => {
      const { c, i } = this.intentoVivo(projectId, attemptId, "dispatched");
      if (i.state !== "reserved") throw new TransicionInvalida(attemptId, i.state, "dispatched");
      i.state = "dispatched";
      i.dispatchedAt = this.reloj();
      if (d.providerCorrelation !== undefined) i.providerCorrelation = d.providerCorrelation;
      this.emitir(c, i, i.exposureMicroUsd, "exposure");
    });
  }

  async liquidar(
    projectId: string,
    attemptId: string,
    uso: AttemptUsage,
    d: { providerCorrelation?: string } = {},
  ): Promise<ResultadoDeLiquidacion> {
    return this.enExclusiva(projectId, () => {
      const { c, i } = this.intentoVivo(projectId, attemptId, "settled");
      if (i.state !== "dispatched" && i.state !== "uncertain" && i.state !== "settled") {
        throw new TransicionInvalida(attemptId, i.state, "settled");
      }
      const recibo: ReciboDeIntento = reciboDeIntento({
        logicalCallId: i.logicalCallId,
        attempt: i.attempt,
        kind: i.kind,
        model: i.model,
        // El tramo de precio lo decide el instante de la petición, no el de la
        // liquidación. Un incierto que nunca se marcó enviado usa el de la reserva.
        at: i.dispatchedAt ?? i.reservedAt,
        usage: uso,
      });
      if (i.state === "settled") {
        // Un recibo reintentado: el libro de D02 dice si es el mismo (no-op) o
        // otro cuerpo (ConflictoDeRecibo). Nunca suma dos veces.
        c.libro.registrar(recibo);
        return {
          state: "settled",
          repeated: true,
          costMicroUsd: i.costMicroUsd!,
          receiptEventId: i.receiptEventId!,
          exceededReservation: i.exceededReservation === true,
        };
      }
      if (d.providerCorrelation !== undefined) i.providerCorrelation = d.providerCorrelation;
      const p = recibo.price;
      if (p.state === "priced") {
        c.libro.registrar(recibo);
        this.soltarExposicion(c, i);
        c.gastado += p.amountMicroUsd;
        i.state = "settled";
        i.exposureMicroUsd = 0;
        i.costMicroUsd = p.amountMicroUsd;
        i.receiptEventId = recibo.eventId;
        i.exceededReservation = p.amountMicroUsd > i.reservedMicroUsd;
        i.priceVersion = p.priceVersion;
        i.closedAt = this.reloj();
        delete i.uncertainReason;
        this.emitir(c, i, p.amountMicroUsd, "verified");
        return {
          state: "settled",
          repeated: false,
          costMicroUsd: p.amountMicroUsd,
          receiptEventId: recibo.eventId,
          exceededReservation: i.exceededReservation,
        };
      }
      // Sin precio verificable: incierto, CONSERVANDO la exposición (y subiéndola
      // al suelo si lo que ya se sabe supera la reserva). Nada va al libro de
      // recibos: un parcial apuntado bloquearía la conciliación posterior con el
      // uso completo (mismo eventId, otro cuerpo).
      const motivo: MotivoDeIncertidumbre =
        p.state === "unpriced"
          ? p.reason === "usage-absent"
            ? "uso_ausente"
            : "sin_precio"
          : p.reason === "usage-partial"
            ? "uso_parcial"
            : "precio_incierto";
      const suelo = p.state === "uncertain" ? p.lowerBoundMicroUsd : undefined;
      this.pasarAIncierto(c, i, motivo, suelo);
      return {
        state: "uncertain",
        reason: motivo,
        exposureMicroUsd: i.exposureMicroUsd,
        ...(i.lowerBoundMicroUsd !== undefined ? { lowerBoundMicroUsd: i.lowerBoundMicroUsd } : {}),
      };
    });
  }

  private pasarAIncierto(c: CuentaDeProyecto, i: IntentoDePresupuesto, motivo: MotivoDeIncertidumbre, suelo: number | undefined): void {
    if (suelo !== undefined) i.lowerBoundMicroUsd = Math.max(i.lowerBoundMicroUsd ?? 0, suelo);
    const exposicion = Math.max(i.exposureMicroUsd, i.reservedMicroUsd, i.lowerBoundMicroUsd ?? 0);
    this.soltarExposicion(c, i);
    i.state = "uncertain";
    i.exposureMicroUsd = exposicion;
    i.uncertainReason = motivo;
    c.incierto += exposicion;
    this.emitir(c, i, exposicion, "exposure");
  }

  async liberar(projectId: string, attemptId: string, prueba: PruebaDeNoEnvio): Promise<void> {
    await this.enExclusiva(projectId, () => {
      const { c, i } = this.intentoVivo(projectId, attemptId, "released");
      if (i.state !== "reserved") throw new TransicionInvalida(attemptId, i.state, "released");
      const motivos: readonly string[] = MOTIVOS_DE_NO_ENVIO;
      if (
        prueba === null ||
        typeof prueba !== "object" ||
        prueba.tipo !== "no_enviado" ||
        !motivos.includes(prueba.motivo as string)
      ) {
        throw new PruebaInsuficiente(attemptId, `unaccepted proof ${JSON.stringify(prueba ?? null)}`);
      }
      this.soltarExposicion(c, i);
      i.state = "released";
      i.exposureMicroUsd = 0;
      i.releaseProof = structuredClone(prueba);
      i.closedAt = this.reloj();
      this.emitir(c, i, 0, "released");
    });
  }

  async marcarIncierto(projectId: string, attemptId: string, motivo: MotivoDeIncertidumbre, d: { uso?: AttemptUsage } = {}): Promise<void> {
    if (!(MOTIVOS_DE_INCERTIDUMBRE as readonly string[]).includes(motivo)) throw new TypeError(`unknown uncertainty reason ${String(motivo)}`);
    await this.enExclusiva(projectId, () => {
      const { c, i } = this.intentoVivo(projectId, attemptId, "uncertain");
      if (!TRANSICIONES[i.state].includes("uncertain")) throw new TransicionInvalida(attemptId, i.state, "uncertain");
      let suelo: number | undefined;
      if (d.uso) {
        const p = tarifarIntento(i.model, d.uso, i.dispatchedAt ?? i.reservedAt);
        suelo = p.state === "priced" ? p.amountMicroUsd : p.state === "uncertain" ? p.lowerBoundMicroUsd : undefined;
      }
      this.pasarAIncierto(c, i, motivo, suelo);
    });
  }

  async estimar(projectId: string, attemptId: string, d: { amountMicroUsd: number; source: string }): Promise<void> {
    // Una estimación de 0 sobre un intento que pudo facturar es justo el «coste
    // desconocido como cero» que este módulo existe para impedir.
    if (!enteroSeguro(d.amountMicroUsd) || d.amountMicroUsd === 0) {
      throw new TypeError("an estimate must be a positive safe integer of micro-USD");
    }
    if (typeof d.source !== "string" || d.source === "") throw new TypeError("an estimate must name its source");
    await this.enExclusiva(projectId, () => {
      const { c, i } = this.intentoVivo(projectId, attemptId, "estimated");
      if (i.state !== "uncertain") throw new TransicionInvalida(attemptId, i.state, "estimated");
      // Nunca por debajo de lo que ya se sabe que costó.
      const importe = Math.max(d.amountMicroUsd, i.lowerBoundMicroUsd ?? 0);
      this.soltarExposicion(c, i);
      c.estimado += importe;
      i.state = "estimated";
      i.exposureMicroUsd = 0;
      i.estimatedMicroUsd = importe;
      i.estimateSource = d.source;
      i.closedAt = this.reloj();
      this.emitir(c, i, importe, "estimated");
    });
  }

  async estado(projectId: string): Promise<EstadoDePresupuesto | undefined> {
    return this.enExclusiva(projectId, () => {
      const c = this.cuenta(projectId);
      return c ? this.foto(c) : undefined;
    });
  }

  async intento(projectId: string, attemptId: string): Promise<IntentoDePresupuesto | undefined> {
    return this.enExclusiva(projectId, () => {
      const i = this.cuenta(projectId)?.intentos.get(attemptId);
      return i ? structuredClone(i) : undefined;
    });
  }

  async abiertosMasViejosQue(projectId: string, edadMs: number): Promise<IntentoDePresupuesto[]> {
    return this.enExclusiva(projectId, () => {
      const c = this.cuenta(projectId);
      if (!c) return [];
      const ahora = this.reloj();
      return [...c.intentos.values()]
        .filter((i) => ABIERTOS.has(i.state) && ahora - i.reservedAt > edadMs)
        .sort((a, b) => a.reservedAt - b.reservedAt)
        .map((i) => structuredClone(i));
    });
  }

  /** Corre la alerta por antigüedad (si se configuró) y devuelve lo que avisó. */
  async revisarAntiguedad(projectId: string): Promise<IntentoDePresupuesto[]> {
    if (!this.alerta) return [];
    const viejos = await this.abiertosMasViejosQue(projectId, this.alerta.umbralMs);
    if (viejos.length > 0) this.alerta.avisar(viejos);
    return viejos;
  }

  async totalDeLlamada(projectId: string, logicalCallId: string): Promise<TotalDeLlamada | undefined> {
    return this.enExclusiva(projectId, () => this.cuenta(projectId)?.libro.total(logicalCallId));
  }
}
