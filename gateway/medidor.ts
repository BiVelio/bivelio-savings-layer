import * as zlib from "node:zlib";

import { precioDeLista } from "../src/pricing/catalogo.js";
import type { CostModel } from "../src/tokenizer/accounting.js";
import type { SavingsReport } from "../src/contracts/types.js";
import { PRIMA_ESCRITURA_CACHE, PRIMA_ESCRITURA_CACHE_1H, primaDeEscritura } from "../src/pricing/primas.js";
import type { CambioDeModelo } from "./hermano.js";

export type { CambioDeModelo } from "./hermano.js";

/**
 * F1 · EL MEDIDOR — convierte el `usage` del proveedor (los eventos del stream
 * SSE, o el JSON de una respuesta `stream: false`) en un registro de uso con
 * `basis: "measured"`.
 *
 * Doctrina de la v1 (plan maestro): el gateway TODAVÍA no optimiza nada, así
 * que el baseline ES el coste real — netSavings 0, visibilidad 100%. Cuando en
 * F2 se enciendan palancas, su ahorro se medirá contra este mismo contador.
 * Nada se estima: si el proveedor no emitió usage, el registro no se produce.
 */

/** El `usage` acumulado de una respuesta SSE (message_start ∪ message_delta). */
export interface UsoSse {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /**
   * Desglose de la escritura de caché por TTL (catálogo F0: viene en
   * message_start). La 1h se factura a 2×, no a 1,25× — sin este desglose el
   * gateway infra-mide el tráfico de Claude Code, que negocia
   * `extended-cache-ttl-2025-04-11`.
   */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/**
 * Observa un stream SSE SIN tocarlo: se le dan los chunks tal cual pasan y al
 * final entrega el `usage` fusionado (message_delta pisa a message_start, que
 * es el orden en que Anthropic los emite — catálogo F0).
 */
export class ObservadorSse {
  private resto = "";
  private uso: UsoSse | null = null;
  private elisionObservada: ElisionAplicada | null = null;
  readonly eventos: Record<string, number> = {};

  observar(chunk: Buffer | string): void {
    this.resto += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = this.resto.indexOf("\n\n")) >= 0) {
      const bloque = this.resto.slice(0, idx);
      this.resto = this.resto.slice(idx + 2);
      const ev = /^event: (.+)$/m.exec(bloque)?.[1];
      if (ev) this.eventos[ev] = (this.eventos[ev] ?? 0) + 1;
      if (ev !== "message_start" && ev !== "message_delta") continue;
      const data = /^data: (.+)$/m.exec(bloque)?.[1];
      if (!data) continue;
      try {
        const d = JSON.parse(data) as {
          usage?: UsoSse;
          message?: { usage?: UsoSse };
          context_management?: unknown;
        };
        // S4a · el borrado del proveedor viaja en el evento message_delta
        // (sondeado en vivo el 04-09: en message_start va a null).
        const elision = elisionDeContextManagement(d.context_management);
        if (elision) this.elisionObservada = elision;
        const usage = d.usage ?? d.message?.usage;
        if (usage) {
          // El objeto anidado se FUSIONA, no se pisa: un delta que trajera un
          // cache_creation parcial (o null) borraría el desglose 1h de
          // message_start y la escritura 1h volvería a tarifarse a 1,25×.
          const cache_creation =
            usage.cache_creation || this.uso?.cache_creation
              ? { ...this.uso?.cache_creation, ...usage.cache_creation }
              : undefined;
          this.uso = { ...this.uso, ...usage, ...(cache_creation ? { cache_creation } : {}) };
        }
      } catch {
        /* un data ilegible no puede tumbar el passthrough */
      }
    }
  }

  usage(): UsoSse | null {
    return this.uso;
  }

  /** El usage solo si el proveedor emitió su evento FINAL (message_delta). */
  usageFinal(): UsoSse | null {
    return (this.eventos["message_delta"] ?? 0) > 0 ? this.uso : null;
  }

  /** Los borrados que el PROVEEDOR declaró para esta respuesta (S4a), si hubo. */
  elision(): ElisionAplicada | null {
    return this.elisionObservada;
  }
}

/**
 * Lo que la palanca de TARIFA hizo en el cuerpo saliente de esta petición.
 * Solo cuenta marcas: los TOKENS los declara el proveedor en el usage, y es
 * ese conteo —no una estimación nuestra— el que se tarifa a dos precios.
 */
export interface RebajaAplicada {
  /** Marcas `cache_control` de TTL 1h reescritas a 5m. */
  rebajadas: number;
  /** Marcas que YA pedían 5m: si hay alguna, la atribución no es limpia y no se cobra. */
  yaEran5m: number;
}

/** Lo que el proveedor declara haber borrado en una respuesta (su contador, no el nuestro). */
export interface ElisionAplicada {
  borrados: number;
  /** Tokens borrados por TODOS los applied_edits (el contador del proveedor, tal cual). */
  tokensLimpiados: number;
  /**
   * B2 · solo los de `clear_tool_uses_20250919`. El proveedor también borra
   * thinking (`clear_thinking_20251015`, que Claude Code manda de fábrica y la
   * palanca CONSERVA), y ese borrado es del cliente aunque nuestros diales
   * viajen en la misma petición. El dinero y B2-4 salen de ESTA cifra; el
   * conteo que viaja al panel sigue siendo el total.
   */
  tokensLimpiadosToolUses: number;
  /**
   * B2 · true cuando el borrado es ATRIBUIBLE a nuestros diales: la palanca
   * cambió el `clear_tool_uses` que traía el cliente (regla del delta). Lo pone
   * el SERVIDOR, no el observador — la respuesta del proveedor no sabe quién
   * puso los diales. Sin él no hay suelo: el conteo se reporta igual, el
   * dinero no.
   */
  atribuible?: boolean;
}

/**
 * B2 · EL SUELO DE LA ELISIÓN DEL PROVEEDOR, en USD: los tokens que su contador
 * declara borrados, a precio de LECTURA de caché del modelo. Tres reglas, y las
 * tres son de dinero:
 *
 *  · `cachedInputPer1k` y SOLO ese. Jamás `inputPer1k` ni el fallback
 *    `?? inputPer1k`: a precio de entrada se sobrevalora ×10 (opus/sonnet/
 *    fable-5) y ×40 (fable-5-1). Sin precio de lectura en el catálogo → 0.
 *    Es un SUELO: esos tokens se habrían pagado COMO MÍNIMO a precio de
 *    lectura en cada turno siguiente; tarifarlos una vez a ese precio se queda
 *    corto, nunca inventa de más. El ingest lo acota además con
 *    TECHO_PRECIO_LECTURA_PER_1K (apps/web/lib/metering/techo-precio-lectura.ts).
 *  · Solo si el borrado es ATRIBUIBLE (elision.atribuible): si el cliente ya
 *    mandaba nuestros diales, o los suyos habrían disparado igual sobre el
 *    prompt original, ese ahorro es suyo (regla del delta, palanca.ts y
 *    servidor.ts). Y solo los tokens de `clear_tool_uses`: el thinking que el
 *    proveedor borre es por la config del cliente.
 *  · Carril PROPIO (cost.eliminatedInputFloorCost → wire eliminatedInputFloorCost
 *    → usage_daily.eliminated_floor_cost, migración 0025): nunca toca
 *    baselineCost, netSavings ni measured_*, y no entra en la comisión hasta
 *    COMISIONAR_ELISION_SUELO (apps/web/lib/billing/tarifa.ts).
 */
export function sueloDeElision(precio: CostModel, elision: ElisionAplicada | null | undefined): number {
  if (!elision || elision.atribuible !== true) return 0;
  // SOLO tool_uses: el thinking que el proveedor borre lo borra por la config
  // del cliente (la palanca no la toca), así que jamás se tarifa como nuestro.
  if (!(elision.tokensLimpiadosToolUses > 0)) return 0;
  const lectura = precio.cachedInputPer1k;
  if (typeof lectura !== "number" || !Number.isFinite(lectura) || lectura <= 0) return 0;
  return (elision.tokensLimpiadosToolUses / 1_000) * lectura;
}

/** Extrae los applied_edits de un bloque context_management (forma sondeada en vivo). */
export function elisionDeContextManagement(cm: unknown): ElisionAplicada | null {
  if (cm === null || typeof cm !== "object") return null;
  const edits = (cm as { applied_edits?: unknown }).applied_edits;
  if (!Array.isArray(edits) || edits.length === 0) return null;
  let tokens = 0;
  let deToolUses = 0;
  for (const e of edits) {
    const t = (e as { cleared_input_tokens?: unknown }).cleared_input_tokens;
    if (typeof t === "number" && Number.isFinite(t) && t > 0) {
      tokens += t;
      if ((e as { type?: unknown }).type === "clear_tool_uses_20250919") deToolUses += t;
    }
  }
  return { borrados: edits.length, tokensLimpiados: tokens, tokensLimpiadosToolUses: deToolUses };
}

/** La elisión declarada en una respuesta JSON (stream:false): bloque top-level. */
export function elisionDeJson(cuerpo: Buffer | string): ElisionAplicada | null {
  try {
    const d = JSON.parse(typeof cuerpo === "string" ? cuerpo : cuerpo.toString("utf8")) as {
      context_management?: unknown;
    };
    return elisionDeContextManagement(d.context_management);
  } catch {
    return null;
  }
}

/** El `usage` de la Responses API de OpenAI (evento `response.completed`). */
interface UsoResponses {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

/**
 * Observa un stream SSE de la Responses API (Codex CLI) SIN tocarlo y entrega
 * el `usage` YA MAPEADO a `UsoSse`, para que `costeMedido` lo tarife sin saber
 * de qué proveedor viene. Clase hermana de `ObservadorSse`, no parametrización:
 * ni los eventos ni la forma del usage coinciden.
 *
 * Mapeo (fórmula OFICIAL de la guía de prompt caching de OpenAI:
 * `ordinaryInputTokens = inputTokens − cachedTokens − cacheWriteTokens`):
 *   · input_tokens ← input − cached − writes
 *   · cache_read_input_tokens ← cached_tokens (tarifa `cachedInputPer1k`)
 *   · cache_creation_input_tokens ← cache_write_tokens: cae en la rama 5m de
 *     `costeMedido` a 1,25×, que ES la prima oficial de OpenAI (gpt-5.6+).
 *     Jamás al bucket 1h — la prima 2× es exclusiva de Anthropic.
 *   · reasoning_tokens ya van dentro de output_tokens: no se suman.
 * Plausibilidad: si cached + writes > input (OpenAI reconoció contadores mal
 * en el arranque de 5.6), se recorta al lado que infra-mide — quedarse corto,
 * jamás inventar de más.
 */
export class ObservadorResponses {
  private resto = "";
  private uso: UsoSse | null = null;
  readonly eventos: Record<string, number> = {};

  observar(chunk: Buffer | string): void {
    this.resto += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = this.resto.indexOf("\n\n")) >= 0) {
      const bloque = this.resto.slice(0, idx);
      this.resto = this.resto.slice(idx + 2);
      const ev = /^event: (.+)$/m.exec(bloque)?.[1];
      if (ev) this.eventos[ev] = (this.eventos[ev] ?? 0) + 1;
      const data = /^data: (.+)$/m.exec(bloque)?.[1];
      if (!data) continue;
      try {
        const d = JSON.parse(data) as { type?: string; response?: { usage?: UsoResponses } };
        if ((ev ?? d.type) !== "response.completed") continue;
        const u = d.response?.usage;
        if (u) this.uso = mapearUsoResponses(u);
      } catch {
        /* un data ilegible no puede tumbar el passthrough */
      }
    }
  }

  usage(): UsoSse | null {
    return this.uso;
  }

  /** En Responses el usage solo existe en el evento final: es el mismo. */
  usageFinal(): UsoSse | null {
    return this.uso;
  }
}

function mapearUsoResponses(u: UsoResponses): UsoSse {
  const input = Math.max(0, u.input_tokens ?? 0);
  const cached = Math.min(Math.max(0, u.input_tokens_details?.cached_tokens ?? 0), input);
  const writes = Math.min(Math.max(0, u.input_tokens_details?.cache_write_tokens ?? 0), input - cached);
  return {
    input_tokens: input - cached - writes,
    output_tokens: Math.max(0, u.output_tokens ?? 0),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: writes,
  };
}

/**
 * Prima de ESCRITURA de caché de Anthropic (TTL 5m, el defecto): crear una
 * entrada de prompt cache se factura a 1,25× el precio de entrada (precio
 * público). La LECTURA usa `cachedInputPer1k` del catálogo.
 */
export { PRIMA_ESCRITURA_CACHE } from "../src/pricing/primas.js";

/**
 * Prima de escritura con TTL 1h: 2× el precio de entrada (precio público).
 * Claude Code la negocia vía `extended-cache-ttl-2025-04-11`; tarifarla a
 * 1,25× infra-medía el coste real.
 */
export { PRIMA_ESCRITURA_CACHE_1H } from "../src/pricing/primas.js";

export interface RegistroMedido {
  costeUsd: number;
  precio: CostModel;
  tokens: {
    entrada: number;
    salida: number;
    cacheLeida: number;
    /** Escritura de caché TOTAL (5m + 1h): es la cifra que viaja en el informe. */
    cacheEscrita: number;
    /** La parte de la escritura con TTL 1h (0 si el usage no trae desglose). */
    cacheEscrita1h: number;
  };
}

/**
 * El coste de un conteo de tokens a un precio de lista dado. Es la fórmula de
 * `costeMedido` sacada a una función PURA para que la palanca C pueda tarifar
 * el MISMO conteo a dos precios de catálogo (el del modelo solicitado y el del
 * servido): un solo sitio con la aritmética, imposible que diverjan.
 *
 * `model` solo decide la prima de escritura (Anthropic 1,25×, OpenAI/Gemini 1×).
 */
export function costeDeTokens(precio: CostModel, tokens: RegistroMedido["tokens"], model: string): number {
  const porCacheLeida = precio.cachedInputPer1k ?? precio.inputPer1k;
  return (
    (tokens.entrada / 1_000) * precio.inputPer1k +
    (tokens.cacheLeida / 1_000) * porCacheLeida +
    ((tokens.cacheEscrita - tokens.cacheEscrita1h) / 1_000) * precio.inputPer1k * primaDeEscritura(model) +
    (tokens.cacheEscrita1h / 1_000) * precio.inputPer1k * PRIMA_ESCRITURA_CACHE_1H +
    (tokens.salida / 1_000) * precio.outputPer1k
  );
}

/** El coste real de una respuesta, a precio de lista del modelo. */
export function costeMedido(model: string, uso: UsoSse): RegistroMedido | null {
  const precio = precioDeLista(model);
  if (!precio) return null;
  const entrada = uso.input_tokens ?? 0;
  const salida = uso.output_tokens ?? 0;
  const cacheLeida = uso.cache_read_input_tokens ?? 0;
  // El total manda; el desglose solo reparte. Sin `cache_creation_input_tokens`
  // (no debería pasar) el total se reconstruye del desglose. Cualquier token
  // que el desglose no cubra se tarifa a 1,25× — quedarse corto por defecto,
  // jamás inventar de más.
  const desglose = uso.cache_creation;
  const cacheEscrita =
    uso.cache_creation_input_tokens ??
    (desglose?.ephemeral_5m_input_tokens ?? 0) + (desglose?.ephemeral_1h_input_tokens ?? 0);
  const cacheEscrita1h = Math.min(desglose?.ephemeral_1h_input_tokens ?? 0, cacheEscrita);
  const tokens = { entrada, salida, cacheLeida, cacheEscrita, cacheEscrita1h };
  return { costeUsd: costeDeTokens(precio, tokens, model), precio, tokens };
}

/**
 * El `model` del cuerpo de una petición, leyendo a través de su
 * `content-encoding`: Codex CLI manda el cuerpo comprimido con zstd (validado
 * en mano el 30-08), y un JSON.parse a ciegas devolvía «sin modelo» — la
 * petición pasaba, pero jamás se medía. El passthrough no toca los bytes: esto
 * es solo lectura lateral. Devuelve "" si no se puede leer (nunca se inventa).
 */
export function modeloDelCuerpo(cuerpo: Buffer, codificacion?: string): string {
  const json = jsonDelCuerpo(cuerpo, codificacion);
  const model = (json as { model?: unknown } | null)?.model;
  return typeof model === "string" ? model : "";
}

/**
 * El JSON completo del cuerpo, a través de su `content-encoding` (misma
 * lectura lateral que `modeloDelCuerpo`, que delega aquí). Lo usa también el
 * carril sombra, que necesita los bloques del prompt y no solo el `model`.
 * Devuelve null si no se puede leer (nunca se inventa).
 */
export function jsonDelCuerpo(cuerpo: Buffer, codificacion?: string): unknown {
  try {
    let bytes = cuerpo;
    // Tope de salida: un cuerpo de 1 KB puede expandir a GB (bomba de
    // descompresión) y esto corre en el hilo del gateway. Mismo tope que la
    // captura; por encima, zlib lanza y no se mide.
    const opciones = { maxOutputLength: MAX_CUERPO_DESCOMPRIMIDO };
    switch ((codificacion ?? "").trim().toLowerCase()) {
      case "gzip":
      case "x-gzip":
        bytes = zlib.gunzipSync(cuerpo, opciones);
        break;
      case "deflate":
        bytes = zlib.inflateSync(cuerpo, opciones);
        break;
      case "br":
        bytes = zlib.brotliDecompressSync(cuerpo, opciones);
        break;
      case "zstd": {
        // Acceso dinámico: en Node < 22.15 no existe y un import nominal
        // reventaría el gateway entero al cargar.
        const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer, o: typeof opciones) => Buffer }).zstdDecompressSync;
        if (typeof zstd !== "function") return null;
        bytes = zstd(cuerpo, opciones);
        break;
      }
      default:
        break;
    }
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Tope del cuerpo descomprimido solo para leer el `model` (5 MB, como la captura). */
export const MAX_CUERPO_DESCOMPRIMIDO = 5 * 1024 * 1024;

/** ¿El gateway puede leer cuerpos zstd (los de Codex CLI) en este Node? */
export function soportaZstd(): boolean {
  return typeof (zlib as unknown as { zstdDecompressSync?: unknown }).zstdDecompressSync === "function";
}

/**
 * Prima de escritura de caché (TTL corto) según el proveedor del modelo:
 * Anthropic 1,25×; OpenAI solo la cobra en gpt-5.6+ (1,25×, la misma cifra);
 * el resto (gpt anteriores, Gemini) no tiene prima — cobrar 1,25× sería
 * inventar de más. La 1h (2×) es exclusiva de Anthropic: solo Anthropic emite
 * ese desglose.
 */
export { primaDeEscritura, primaDeEscritura1h } from "../src/pricing/primas.js";

/** El `usage` de una respuesta JSON no-SSE (`stream: false`). */
export function usoDeJson(cuerpo: Buffer | string): UsoSse | null {
  try {
    const d = JSON.parse(typeof cuerpo === "string" ? cuerpo : cuerpo.toString("utf8")) as { usage?: UsoSse };
    return d.usage ?? null;
  } catch {
    return null;
  }
}

/**
 * El informe con la forma que `UsageEmitter.toWire` lee. La v1 no optimiza:
 * baseline = actual, netSavings = 0, `basis: "measured"` — el contador del
 * propio proveedor es la fuente, no un estimador.
 *
 * Se construye COMPLETO para los campos que viajan; el cast final existe
 * porque `SavingsReport` documenta muchos más campos (los de las palancas) que
 * en un gateway sin palancas no tienen valor que reportar.
 */
/** Atribución de terminal: identidades opacas de sesión/subagente, jamás una persona. */
export interface Atribucion {
  sessionId?: string;
  agentId?: string;
}

export function informeMedido(
  requestId: string,
  model: string,
  medido: RegistroMedido,
  atribucion?: Atribucion,
  elision?: ElisionAplicada | null,
  rebaja?: RebajaAplicada | null,
  /**
   * Palanca C · si la petición pidió un modelo y viajó con su hermano más
   * barato en lectura de caché. `medido` ya está tarifado al SERVIDO; el
   * baseline se recalcula al SOLICITADO sobre el mismo conteo.
   */
  hermano?: CambioDeModelo | null,
): SavingsReport {
  return construirInforme(requestId, model, medido, false, atribucion, elision, rebaja, hermano);
}

/**
 * El informe de una GEMELA coalescida: la llamada nunca viajó, así que es una
 * llamada evitada con el coste de su primaria como baseline. `basis` queda en
 * "estimated" a propósito — ver la doctrina en gateway/coalescencia.ts — y por
 * tanto NUNCA entra en la base de la comisión.
 */
export function informeCoalescido(requestId: string, model: string, medidoPrimaria: RegistroMedido, atribucion?: Atribucion): SavingsReport {
  return construirInforme(requestId, model, medidoPrimaria, true, atribucion);
}

/**
 * El informe del CARRIL SOMBRA (S2): qué habría costado este turno con la
 * política de elisión encendida, contra el baseline del MISMO simulador.
 * `basis: "shadow"` — hipotético por construcción: la RPC 0021 lo acumula solo
 * en shadow_*, jamás en la base de la comisión ni en measured. Los contadores
 * de llamadas y tokens van a CERO a propósito: la sombra no evita ni ejecuta
 * nada. El requestId DEBE llegar ya sufijado con `:shadow` — sin el sufijo, la
 * idempotencia por (org, requestId) se tragaría en silencio este registro o el
 * medido de la misma petición.
 */
export function informeSombra(
  requestIdConSufijo: string,
  model: string,
  baselineUsd: number,
  politicaUsd: number,
  atribucion?: Atribucion,
): SavingsReport {
  const informe = {
    requestId: requestIdConSufijo,
    model,
    ...(atribucion && (atribucion.sessionId || atribucion.agentId) ? { attribution: atribucion } : {}),
    calls: { avoidedLlm: 0, actualLlm: 0 },
    tokens: {
      baselineInput: 0,
      actualInput: 0,
      eliminatedInput: 0,
      compressedInput: 0,
      baselineOutput: 0,
      actualOutput: 0,
      providerCachedInput: 0,
    },
    cache: { result: "miss" as const },
    cost: {
      baselineEstimate: baselineUsd,
      actual: politicaUsd,
      // PROPORCIÓN en [-100,1], jamás dólares (la cicatriz de la coalescencia:
      // un valor > 1 tumba el LOTE entero en la verja del ingest). Una política
      // puede PERDER dinero — v2 lo demostró — así que el negativo es legítimo,
      // pero acotado.
      netSavings: baselineUsd > 0 ? Math.max(-100, Math.min(1, (baselineUsd - politicaUsd) / baselineUsd)) : 0,
      basis: "shadow" as const,
    },
  };
  return informe as unknown as SavingsReport;
}

/**
 * Palanca C · lo que el cliente habría pagado de MÁS si su petición hubiera
 * viajado con el modelo que pidió, sobre el MISMO usage que el proveedor
 * declaró. Con el catálogo de hoy es exactamente
 * cacheLeida/1000 × (lectura del solicitado − lectura del servido) y CERO en
 * entrada, salida y escrituras (precios idénticos; la verja de hermano.ts lo
 * garantiza antes de reescribir). Nunca negativo: si el catálogo cambiara y el
 * servido saliera más caro, se mide 0 y no se cobra nada — y el test de la
 * verja de precios rompe en CI para avisar.
 */
export function ahorroDeHermano(hermano: CambioDeModelo, medido: RegistroMedido): number {
  const precioSolicitado = precioDeLista(hermano.solicitado);
  if (precioSolicitado === undefined) return 0;
  return Math.max(0, costeDeTokens(precioSolicitado, medido.tokens, hermano.solicitado) - medido.costeUsd);
}

function construirInforme(
  requestId: string,
  model: string,
  medido: RegistroMedido,
  coalescida: boolean,
  atribucion?: Atribucion,
  elision?: ElisionAplicada | null,
  rebaja?: RebajaAplicada | null,
  hermano?: CambioDeModelo | null,
): SavingsReport {
  const entradaTotal = medido.tokens.entrada + medido.tokens.cacheLeida + medido.tokens.cacheEscrita;
  // ── LA PALANCA DE TARIFA · el primer euro MEDIDO de verdad ──────────────
  //
  // Hasta aquí la rama medida escribía baseline == actual y netSavings 0. No
  // era un descuido: `accounting.ts` lo razona entero — el único baseline
  // medido de una llamada que se ejecutó es otra que se haya ejecutado
  // también (un A/B), así que cualquier ahorro de TOKENS solo cabe estimarlo.
  //
  // La rebaja de TTL escapa a ese nudo porque no cambia ni un token: cambia la
  // TARIFA de la misma escritura. El baseline es el usage que el proveedor YA
  // declaró, tarifado a la prima que el cliente había pedido (1h, 2×); el
  // actual es ese mismo usage a la prima que pagó (5m, 1,25×). No hay
  // contrafactual que imaginar — es una resta entre dos precios públicos sobre
  // el mismo conteo. Por eso, y solo por eso, esto se cobra como `measured`.
  //
  // La palanca C (modelo hermano, 2026-09-09) es la SEGUNDA excepción con la
  // misma forma: dos precios de catálogo sobre el mismo usage. El cliente
  // pidió fable-5 y el proveedor sirvió fable-5-1; entrada, salida y primas
  // son idénticas y solo la lectura de caché es más barata (0,00025 frente a
  // 0,001 por 1K, catalogo.ts). `medido` viene tarifado al SERVIDO (lo que se
  // pagó) y el baseline se recalcula al SOLICITADO sobre el mismo conteo. La
  // regla de accounting.ts (`basis = removed===0 ? measured : estimated`)
  // sigue siendo cierta: C no quita un token, cambia su precio.
  const escrita5m = medido.tokens.cacheEscrita - medido.tokens.cacheEscrita1h;
  const sobrecosteEvitado =
    !coalescida && rebaja && rebaja.rebajadas > 0 && rebaja.yaEran5m === 0 && escrita5m > 0
      ? (escrita5m / 1_000) * medido.precio.inputPer1k * (PRIMA_ESCRITURA_CACHE_1H - PRIMA_ESCRITURA_CACHE)
      : 0;
  const ahorroHermano = !coalescida && hermano ? ahorroDeHermano(hermano, medido) : 0;
  const baselineMedido = medido.costeUsd + sobrecosteEvitado + ahorroHermano;
  const ahorroMedido = sobrecosteEvitado + ahorroHermano;
  // B2 · el suelo de la elisión del proveedor (ver sueloDeElision). Una gemela
  // coalescida no viajó: no elidió nada y no tiene suelo.
  const sueloElision = coalescida ? 0 : sueloDeElision(medido.precio, elision);
  const informe = {
    requestId,
    model,
    ...(atribucion && (atribucion.sessionId || atribucion.agentId) ? { attribution: atribucion } : {}),
    calls: coalescida ? { avoidedLlm: 1, actualLlm: 0 } : { avoidedLlm: 0, actualLlm: 1 },
    tokens: {
      baselineInput: entradaTotal,
      actualInput: coalescida ? 0 : entradaTotal,
      // S4a · los tokens que el PROVEEDOR declaró borrados (su contador). Solo en
      // la rama medida: una gemela coalescida no viajó, así que no elidió nada.
      // Es un CONTEO (viaja por el campo wire eliminatedInputTokens); el DINERO
      // va aparte y a precio suelo: cost.eliminatedInputFloorCost (B2, abajo).
      eliminatedInput: coalescida ? 0 : elision?.tokensLimpiados ?? 0,
      compressedInput: 0,
      baselineOutput: medido.tokens.salida,
      actualOutput: coalescida ? 0 : medido.tokens.salida,
      providerCachedInput: coalescida ? 0 : medido.tokens.cacheLeida,
    },
    cache: { result: coalescida ? ("singleflight" as const) : ("miss" as const) },
    cost: coalescida
      ? {
          baselineEstimate: medido.costeUsd,
          actual: 0,
          // netSavings es una PROPORCIÓN [-100,1], no dólares: una coalescencia
          // evita la llamada entera, así que es 1 (100 %). Antes iba `costeUsd`,
          // y si la primaria costó > $1 (opus caro) el ingest rechazaba el LOTE
          // completo por `> 1` — se perdían hasta 50 registros. Ver el contrato
          // en src/tokenizer/accounting.ts y la verja en lib/metering/usage.ts.
          netSavings: 1,
          basis: "estimated" as const,
        }
      : {
          baselineEstimate: baselineMedido,
          actual: medido.costeUsd,
          // PROPORCIÓN en [-100,1], como el resto del contrato (ver la cicatriz
          // de la coalescencia más arriba). Sin rebaja ni hermano vale 0 y la
          // doctrina de siempre se mantiene intacta: sin palanca no hay ahorro
          // que enseñar.
          netSavings: baselineMedido > 0 ? Math.max(-100, Math.min(1, ahorroMedido / baselineMedido)) : 0,
          basis: "measured" as const,
          // B2 · solo cuando hay dinero: el campo AUSENTE es «no hubo borrado
          // atribuible», y un 0 explícito no añadiría nada.
          ...(sueloElision > 0 ? { eliminatedInputFloorCost: sueloElision } : {}),
        },
  };
  return informe as unknown as SavingsReport;
}
