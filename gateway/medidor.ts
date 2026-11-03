import * as zlib from "node:zlib";

import { veredictoDelTier } from "../src/economics/tier-diferido.js";
import { precioDeLista, precioDeListaPropio } from "../src/pricing/catalogo.js";
import { salidaNoRepetible } from "../src/pricing/razonamiento.js";
import { REFERENCE_OUTPUT_SHARE, type CostModel, type ReferenceCredit } from "../src/tokenizer/accounting.js";
import type { SavingsReport } from "../src/contracts/types.js";
import { PRIMA_ESCRITURA_CACHE, PRIMA_ESCRITURA_CACHE_1H, primaDeEscritura } from "../src/pricing/primas.js";
import { extraDeCompactacion } from "../src/providers/iteraciones-de-compactacion.js";
import { ahorroNativo } from "../src/economics/ahorro-nativo.js";
import { negativaNoCobrada } from "../src/providers/anthropic-uso.js";
import { negativaEnTexto } from "../src/providers/negativa-en-texto.js";
import { esParadaDeFiltro } from "../src/providers/parada-de-filtro.js";
import { salidaOculta } from "../src/providers/salida-oculta.js";
import { usoDeGemini, type UsoMetadataGemini } from "./gemini.js";
import { temaSensibleEnTextos, type TemaSensible } from "../src/policy/tema-sensible.js";
import { SseParser, type SseMessage } from "../src/providers/sse.js";
import type { HuellaDeLaPrimaria } from "./coalescencia.js";
import type { CambioDeModelo } from "./hermano.js";
import { costeDeFallo } from "./fallos-ttl.js";

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
  /**
   * Con la compactación del servidor (beta de Anthropic): una entrada por
   * iteración de muestreo. Los contadores de primer nivel NO incluyen la de
   * compactación; `costeMedido` la suma (src/providers/iteraciones-de-compactacion.ts).
   */
  iterations?: unknown;
}

/**
 * Observa un stream SSE SIN tocarlo: se le dan los chunks tal cual pasan y al
 * final entrega el `usage` fusionado (message_delta pisa a message_start, que
 * es el orden en que Anthropic los emite — catálogo F0).
 */
export class ObservadorSse {
  private readonly parser = new SseParser();
  private uso: UsoSse | null = null;
  private elisionObservada: ElisionAplicada | null = null;
  private paradaFinal: string | null = null;
  private detallesDeParada: unknown = undefined;
  private readonly texto = new InicioDelTexto();
  readonly eventos: Record<string, number> = {};

  private finalizado = false;

  observar(chunk: Buffer | string): void {
    this.procesar(this.parser.push(chunk));
  }

  private procesar(mensajes: SseMessage[]): void {
    for (const mensaje of mensajes) {
      const ev = mensaje.event;
      this.eventos[ev] = (this.eventos[ev] ?? 0) + 1;
      // E7-quater · el INICIO del texto, para ver una negativa escrita como
      // texto (`negativaEnTexto`). Solo hasta el techo: luego ni se parsea.
      if (ev === "content_block_delta" && !this.texto.lleno()) {
        try {
          const d = JSON.parse(mensaje.data) as { delta?: { type?: unknown; text?: unknown } };
          if (d.delta?.type === "text_delta") this.texto.sumar(d.delta.text);
        } catch {
          /* un data ilegible no puede tumbar el passthrough */
        }
        continue;
      }
      if (ev !== "message_start" && ev !== "message_delta") continue;
      try {
        const d = JSON.parse(mensaje.data) as {
          usage?: UsoSse;
          message?: { usage?: UsoSse };
          context_management?: unknown;
          delta?: { stop_reason?: unknown; stop_details?: unknown };
        };
        // E7 · el motivo de parada viaja en message_delta (en message_start va a
        // null). Solo se apunta: el passthrough no lo mira.
        if (ev === "message_delta" && typeof d.delta?.stop_reason === "string") this.paradaFinal = d.delta.stop_reason;
        if (ev === "message_delta" && d.delta && "stop_details" in d.delta) this.detallesDeParada = d.delta.stop_details;
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

  /** El usage solo si llegaron el contador y el cierre terminal completo. */
  usageFinal(): UsoSse | null {
    if (!this.finalizado) {
      this.finalizado = true;
      this.procesar(this.parser.end());
    }
    return (this.eventos["message_delta"] ?? 0) > 0 && (this.eventos["message_stop"] ?? 0) > 0 ? this.uso : null;
  }

  /** Los borrados que el PROVEEDOR declaró para esta respuesta (S4a), si hubo. */
  elision(): ElisionAplicada | null {
    return this.elisionObservada;
  }

  /** E7 · ¿cerró el stream con `stop_reason: "refusal"`? (ver `negativaEnJson`). */
  negativa(): boolean {
    return this.paradaFinal === "refusal";
  }

  /** E7-quater · el inicio del texto que escribió el modelo (ver `negativaEnTextoDeRespuesta`). */
  textoInicial(): string {
    return this.texto.valor();
  }

  /**
   * ¿Es una negativa que Anthropic documenta como NO cobrada? Antes de
   * cualquier salida (ningún `content_block_start` y `output_tokens` final 0) y
   * en una categoría que su tabla marca «no» (ver `negativaNoCobrada`). Solo con
   * el usage FINAL: sin él no hay nada que afirmar.
   */
  negativaNoCobrada(): boolean {
    const uso = this.usageFinal();
    return (
      uso !== null &&
      negativaNoCobrada({
        stopReason: this.paradaFinal,
        stopDetails: this.detallesDeParada,
        bloques: this.eventos["content_block_start"] ?? 0,
        outputTokens: uso.output_tokens,
        iterations: uso.iterations,
      })
    );
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
  /**
   * La petición declaraba herramientas de servidor: la API escribe a 5 min el
   * resultado de las que Claude use, pida el cliente el TTL que pida, y el usage
   * no separa esa escritura de la nuestra. Tampoco se cobra (tarifa.ts,
   * declaraHerramientaDeServidor).
   */
  herramientaDeServidor: boolean;
}

/**
 * El fallo de caché que la rebaja de TTL provocó en ESTE turno: tokens que con
 * la entrada de 1h se habrían leído y hubo que reescribir (fallos-ttl.ts).
 */
export interface FalloTtl {
  perdidos: number;
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

/** El `usage` de la Responses API de OpenAI (el de su evento terminal). */
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
 *
 * LOS TRES FINALES. Un stream de Responses termina en UNO de tres eventos, y
 * los tres traen el `response` entero con su `usage`:
 *   · `response.completed` — el normal.
 *   · `response.incomplete` — cortado por `max_output_tokens` o por el filtro
 *     de contenido. El proveedor lo FACTURA (la entrada entera y la salida que
 *     llegó a generar), y hasta 2026-09-25 el gateway lo reenviaba sin medir.
 *   · `response.failed` — se mide SOLO si trae usage (a veces viene a null).
 * En los dos últimos se exigen los dos contadores: un conteo a medias no es el
 * contador del proveedor y nada se completa con 0. Sin usage, null — nada se
 * inventa en su lugar.
 */
export class ObservadorResponses {
  private readonly parser = new SseParser();
  private uso: UsoSse | null = null;
  private final: EstadoFinalResponses | null = null;
  private negada = false;
  private readonly texto = new InicioDelTexto();
  readonly eventos: Record<string, number> = {};

  private finalizado = false;

  observar(chunk: Buffer | string): void {
    this.procesar(this.parser.push(chunk));
  }

  private procesar(mensajes: SseMessage[]): void {
    for (const mensaje of mensajes) {
      const ev = mensaje.event;
      this.eventos[ev] = (this.eventos[ev] ?? 0) + 1;
      try {
        const d = JSON.parse(mensaje.data) as { type?: string; response?: { usage?: UsoResponses | null } };
        const tipo = ev !== "message" ? ev : d.type;
        if (eventoDeNegativaResponses(tipo, d)) this.negada = true;
        if (tipo === "response.output_text.delta") this.texto.sumar((d as { delta?: unknown }).delta);
        // Object.hasOwn: el literal hereda de Object.prototype, y un evento
        // `constructor` o `toString` no puede pasar por un final.
        const final = tipo !== undefined && Object.hasOwn(FINALES_RESPONSES, tipo) ? FINALES_RESPONSES[tipo] : undefined;
        if (final === undefined) continue;
        this.final = final;
        const u = d.response?.usage;
        if (!u) continue;
        if (final === "completed") this.uso = mapearUsoResponses(u);
        else if (typeof u.input_tokens === "number" && typeof u.output_tokens === "number") this.uso = mapearUsoResponses(u);
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
    if (!this.finalizado) {
      this.finalizado = true;
      this.procesar(this.parser.end());
    }
    return this.uso;
  }

  /** Cómo terminó el stream, si llegó a su evento final (con o sin usage). */
  estadoFinal(): EstadoFinalResponses | null {
    return this.final;
  }

  /** E7 · ¿trajo el stream una parte `refusal`? (ver `negativaEnJson`). */
  negativa(): boolean {
    return this.negada;
  }

  /** E7-quater · el inicio del texto que escribió el modelo (ver `negativaEnTextoDeRespuesta`). */
  textoInicial(): string {
    return this.texto.valor();
  }
}

/**
 * E7 · ¿este evento del stream de la Responses API delata una negativa? La
 * negativa es una PARTE de contenido `{ type: "refusal", refusal }` dentro de un
 * item `message`, y el stream la anuncia de varias formas; basta una:
 *   · `response.refusal.delta` / `response.refusal.done` (su texto);
 *   · `response.content_part.added` / `.done` con `part.type: "refusal"`;
 *   · `response.output_item.added` / `.done` con esa parte en `item.content`;
 *   · el evento final (`response.completed`, …) con esa parte en `response.output`.
 * Referencia oficial de los eventos de stream de Responses, consultada el
 * 2026-09-28: https://developers.openai.com/api/reference/resources/responses/streaming-events
 */
function eventoDeNegativaResponses(tipo: string | undefined, d: unknown): boolean {
  if (tipo === "response.refusal.delta" || tipo === "response.refusal.done") return true;
  if (d === null || typeof d !== "object") return false;
  const o = d as { part?: unknown; item?: unknown; response?: unknown };
  if (esParteDeNegativa(o.part) || salidaConNegativa([o.item])) return true;
  return o.response !== null && typeof o.response === "object" && salidaConNegativa((o.response as { output?: unknown }).output);
}

/** `{ type: "refusal" }`: la parte de contenido con la que la Responses API niega. */
function esParteDeNegativa(p: unknown): boolean {
  return p !== null && typeof p === "object" && (p as { type?: unknown }).type === "refusal";
}

/** ¿Algún item de `output` (Responses API) trae una parte `refusal` en su `content`? */
function salidaConNegativa(output: unknown): boolean {
  return (
    Array.isArray(output) &&
    output.some((item) => {
      if (item === null || typeof item !== "object") return false;
      const contenido = (item as { content?: unknown }).content;
      return Array.isArray(contenido) && contenido.some(esParteDeNegativa);
    })
  );
}

/** El evento terminal de un stream de la Responses API. */
export type EstadoFinalResponses = "completed" | "incomplete" | "failed";

const FINALES_RESPONSES: Readonly<Record<string, EstadoFinalResponses>> = {
  "response.completed": "completed",
  "response.incomplete": "incomplete",
  "response.failed": "failed",
};

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

/** El `usage` de Chat Completions (último chunk de un stream, o el JSON de `stream: false`). */
interface UsoChat {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

/**
 * `usage` de Chat Completions → `UsoSse`, con el MISMO mapeo que la Responses
 * API (es la misma casa y la misma fórmula oficial: entrada ordinaria =
 * prompt − cached − writes). Null si falta cualquiera de los dos contadores:
 * un conteo a medias no es el contador del proveedor, y nada se completa con 0.
 *
 * La SALIDA es la facturada: `completion_tokens` más lo que `total_tokens` trae
 * de más (`salidaOculta`, src/providers/salida-oculta.ts). El endpoint
 * compatible de Gemini deja su pensamiento fuera de `completion_tokens` y lo
 * factura como salida; en OpenAI (y en cualquier servidor que ya cuente el
 * razonamiento dentro) `total_tokens = prompt + completion` y no se suma nada,
 * así que no hay doble conteo. Es la misma regla que el adaptador del SDK.
 */
export function mapearUsoChat(u: UsoChat | null | undefined): UsoSse | null {
  if (!u || typeof u.prompt_tokens !== "number" || typeof u.completion_tokens !== "number") return null;
  return mapearUsoResponses({
    input_tokens: u.prompt_tokens,
    output_tokens: u.completion_tokens + salidaOculta(u),
    input_tokens_details: {
      ...(u.prompt_tokens_details?.cached_tokens !== undefined ? { cached_tokens: u.prompt_tokens_details.cached_tokens } : {}),
      ...(u.prompt_tokens_details?.cache_write_tokens !== undefined
        ? { cache_write_tokens: u.prompt_tokens_details.cache_write_tokens }
        : {}),
    },
  });
}

/**
 * Observa un stream de Chat Completions (`chat.completion.chunk`) SIN tocar un
 * byte y entrega el `usage` ya mapeado a `UsoSse`. Tercera clase hermana: ni los
 * eventos ni la forma del usage casan con las otras dos.
 *
 * El usage solo cuenta como FINAL si el stream llegó a su cierre: el chunk de
 * uso con `choices: []` (lo que manda OpenAI con `include_usage`) o el
 * `data: [DONE]`. Eso cubre a la vez:
 *   · OpenAI con include_usage — chunk `choices: []` + usage, luego [DONE];
 *   · vLLM con uso continuo — el usage de cada chunk es parcial hasta [DONE];
 *   · un corte a mitad — null, aunque algún chunk trajera usage;
 *   · el primer chunk de Azure — `choices: []` con prompt_filter_results y SIN
 *     usage, que no marca nada.
 *
 * Usa el parser SSE del SDK (WHATWG: CRLF, CR, varias líneas data:, chunks
 * cortados en cualquier byte) en vez de otro `indexOf("\n\n")`.
 */
export class ObservadorChatCompletions {
  private readonly parser = new SseParser();
  private ultimoUso: UsoSse | null = null;
  private vioUsoFinal = false;
  private vioDone = false;
  private filtrada = false;
  private readonly texto = new InicioDelTexto();
  readonly eventos: Record<string, number> = {};

  observar(chunk: Buffer | string): void {
    for (const m of this.parser.push(chunk)) this.mensaje(m);
  }

  /** E7-quater · el inicio del texto que escribió el modelo (ver `negativaEnTextoDeRespuesta`). */
  textoInicial(): string {
    for (const m of this.parser.end()) this.mensaje(m);
    return this.texto.valor();
  }

  /**
   * E7 · ¿algún chunk cerró su elección con `finish_reason: "content_filter"` (con o
   * sin motivo: `"content_filter: OTHER"` de Gemini), o
   * trajo un `delta.refusal` no vacío (la negativa de salidas estructuradas)?
   */
  negativa(): boolean {
    return this.filtrada;
  }

  /**
   * La misma regla que usageFinal() (solo cuenta tras el chunk de uso con
   * `choices: []` o tras `[DONE]`), pero SIN vaciar el parser: se puede mirar a
   * mitad del stream sin despachar una línea a medio recibir.
   */
  usage(): UsoSse | null {
    return this.vioUsoFinal || this.vioDone ? this.ultimoUso : null;
  }

  /** Solo con el cuerpo ENTERO ya observado: vacía el parser antes de decidir. */
  usageFinal(): UsoSse | null {
    // Un `data: [DONE]` sin la línea en blanco final sigue siendo el cierre.
    for (const m of this.parser.end()) this.mensaje(m);
    return this.usage();
  }

  private mensaje(m: SseMessage): void {
    if (m.data === "[DONE]") {
      this.vioDone = true;
      this.eventos["done"] = (this.eventos["done"] ?? 0) + 1;
      return;
    }
    let d: { usage?: unknown; choices?: unknown };
    try {
      d = JSON.parse(m.data) as { usage?: unknown; choices?: unknown };
    } catch {
      return; // un data ilegible no puede tumbar el passthrough
    }
    if (d === null || typeof d !== "object") return;
    this.eventos["chunk"] = (this.eventos["chunk"] ?? 0) + 1;
    if (eleccionNegada(d.choices)) this.filtrada = true;
    if (Array.isArray(d.choices) && !this.texto.lleno()) {
      const primera = d.choices[0] as { delta?: { content?: unknown } } | undefined;
      this.texto.sumar(primera?.delta?.content);
    }
    if (d.usage === null || typeof d.usage !== "object") return;
    const mapeado = mapearUsoChat(d.usage as UsoChat);
    if (mapeado === null) return;
    this.ultimoUso = mapeado;
    if (Array.isArray(d.choices) && d.choices.length === 0) this.vioUsoFinal = true;
  }
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
  /**
   * El instante (epoch ms) con el que se resolvió `precio`: el de la petición.
   * Lo reutilizan las valoraciones que tarifan el MISMO conteo a otro precio
   * (palanca C, la gemela por referencia) para que las dos cifras sean del
   * mismo día. Ausente = ahora.
   */
  instante?: number;
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
 * `model` solo decide la prima de escritura (Anthropic 1,25×; OpenAI 1,25× de
 * gpt-5.6 en adelante —familia gpt-6 incluida— y 1× antes; Gemini 1×).
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

/**
 * El coste real de una respuesta, a precio de lista del modelo EL DÍA DE LA
 * PETICIÓN (`at`, epoch ms; por defecto ahora): un cambio de precio anunciado
 * se aplica desde su fecha (src/pricing/catalogo.ts, la vigencia por fila).
 */
export function costeMedido(model: string, uso: UsoSse, at?: number): RegistroMedido | null {
  const instante = at ?? Date.now();
  const precio = precioDeLista(model, instante);
  if (!precio) return null;
  // LA COMPACTACIÓN DEL SERVIDOR se factura fuera del primer nivel: se suman
  // sus iteraciones (solo las `compaction`, ver el módulo). Sin compactación,
  // `extra` es null y todo queda como estaba.
  const extra = extraDeCompactacion(uso.iterations);
  const entrada = (uso.input_tokens ?? 0) + (extra?.input ?? 0);
  const salida = (uso.output_tokens ?? 0) + (extra?.output ?? 0);
  const cacheLeida = (uso.cache_read_input_tokens ?? 0) + (extra?.cacheRead ?? 0);
  // El total manda; el desglose solo reparte. Sin `cache_creation_input_tokens`
  // (no debería pasar) el total se reconstruye del desglose. Cualquier token
  // que el desglose no cubra se tarifa a 1,25× — quedarse corto por defecto,
  // jamás inventar de más.
  const desglose = uso.cache_creation;
  const cacheEscritaPrimerNivel =
    uso.cache_creation_input_tokens ??
    (desglose?.ephemeral_5m_input_tokens ?? 0) + (desglose?.ephemeral_1h_input_tokens ?? 0);
  const cacheEscrita = cacheEscritaPrimerNivel + (extra?.cacheWrite ?? 0);
  const cacheEscrita1h = Math.min(
    Math.min(desglose?.ephemeral_1h_input_tokens ?? 0, cacheEscritaPrimerNivel) + (extra?.cacheWrite1h ?? 0),
    cacheEscrita,
  );
  const tokens = { entrada, salida, cacheLeida, cacheEscrita, cacheEscrita1h };
  return { costeUsd: costeDeTokens(precio, tokens, model), precio, tokens, instante };
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
 * Anthropic 1,25×; OpenAI solo la cobra de gpt-5.6 en adelante, familia gpt-6
 * incluida (1,25×, la misma cifra);
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
 * El `usage` de una respuesta JSON (`stream: false`) según el DIALECTO de la
 * ruta: `/v1/messages` es Anthropic, `…/chat/completions` es Chat Completions y
 * `…/responses` es la Responses API. Null si la ruta no tiene dialecto o la
 * respuesta no trae los dos contadores: un `usage` de otra forma jamás se lee
 * como si fuera el de Anthropic (el registro fantasma de 0 tokens).
 */
export function usoDeJsonPorRuta(path: string, cuerpo: Buffer | string): UsoSse | null {
  if (path === "/v1/messages") return usoDeJson(cuerpo);
  if (!tieneDialecto(path)) return null;
  try {
    const d = JSON.parse(typeof cuerpo === "string" ? cuerpo : cuerpo.toString("utf8")) as
      | { usage?: unknown; usageMetadata?: unknown }
      | null;
    if (d === null || typeof d !== "object") return null;
    if (path.endsWith("/chat/completions")) return mapearUsoChat(d.usage as UsoChat | undefined);
    // Gemini (`:generateContent` sin stream): el contador vive en `usageMetadata`.
    if (path.endsWith(":generateContent")) return usoDeGemini(d.usageMetadata as UsoMetadataGemini | undefined);
    const u = d.usage as UsoResponses | null | undefined;
    return u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number" ? mapearUsoResponses(u) : null;
  } catch {
    return null; // ilegible
  }
}

/**
 * Parte G · ¿una respuesta JSON (`stream: false`) de la Responses API dice
 * `status: "failed"`? La hermana de `ObservadorResponses.estadoFinal()` para el
 * camino sin stream: una respuesta 200 con `status: "failed"` y `usage` se mide,
 * pero su gemela no puede valorarse por referencia. Solo `…/responses`; lo
 * ilegible es false (no hay estado que leer).
 */
export function respuestaJsonFallida(path: string, cuerpo: Buffer | string): boolean {
  if (!path.endsWith("/responses")) return false;
  try {
    const d = JSON.parse(typeof cuerpo === "string" ? cuerpo : cuerpo.toString("utf8")) as { status?: unknown } | null;
    return d !== null && typeof d === "object" && d.status === "failed";
  } catch {
    return false;
  }
}

/**
 * ¿Alguna elección de Chat Completions es una negativa? `finish_reason:
 * "content_filter"` —también con motivo, `"content_filter: OTHER"`, que es como
 * cierra Gemini por su endpoint compatible (`esParadaDeFiltro`,
 * src/providers/parada-de-filtro.ts)—, o la negativa de salidas estructuradas: un `refusal` no
 * vacío en `message` (JSON) o en `delta` (stream), que llega con
 * `finish_reason: "stop"` y sin `content`. El `refusal: null` de toda respuesta
 * normal no cuenta, y un `content` vacío sin `refusal` tampoco.
 */
function eleccionNegada(choices: unknown): boolean {
  const conNegativa = (m: unknown): boolean => {
    const r = m !== null && typeof m === "object" ? (m as { refusal?: unknown }).refusal : undefined;
    return typeof r === "string" && r !== "";
  };
  return (
    Array.isArray(choices) &&
    choices.some((c) => {
      if (c === null || typeof c !== "object") return false;
      const e = c as { finish_reason?: unknown; message?: unknown; delta?: unknown };
      return esParadaDeFiltro(e.finish_reason) || conNegativa(e.message) || conNegativa(e.delta);
    })
  );
}

/**
 * E7 · ¿la respuesta JSON (`stream: false`) es una NEGATIVA del proveedor?
 *   · `/v1/messages`: `stop_reason: "refusal"` (llega con `content: []` y con
 *     `usage`);
 *   · `…/chat/completions`: `finish_reason: "content_filter"`, o un
 *     `message.refusal` no vacío (salidas estructuradas, con `finish_reason:
 *     "stop"`);
 *   · `…/responses`: una parte `{ type: "refusal" }` en el `content` de algún
 *     item de `output`, dentro de una respuesta `status: "completed"`.
 * Documentación oficial de OpenAI, consultada el 2026-09-28:
 * https://developers.openai.com/api/docs/guides/structured-outputs («Refusals
 * with Structured Outputs») y https://developers.openai.com/api/reference/resources/chat.
 *
 * La negativa se MIDE como cualquier petición —Anthropic cobra desde el
 * 24-09-2026 las de `bio`, `frontier_llm` y `reasoning_extraction`, y el
 * `usage` de OpenAI cuenta la negativa como salida—, pero la gemela coalescida de
 * una negativa no se valora por referencia (`primary-refused`): en las
 * categorías que no se cobran la repetición habría costado 0 $, y una negativa
 * no es una respuesta que valga la pena repetir. Lo ilegible es false.
 */
export function negativaEnJson(path: string, cuerpo: Buffer | string): boolean {
  if (path !== "/v1/messages" && !path.endsWith("/chat/completions") && !path.endsWith("/responses")) return false;
  try {
    const d = JSON.parse(typeof cuerpo === "string" ? cuerpo : cuerpo.toString("utf8")) as {
      stop_reason?: unknown;
      choices?: unknown;
      output?: unknown;
    } | null;
    if (d === null || typeof d !== "object") return false;
    if (path === "/v1/messages") return d.stop_reason === "refusal";
    return path.endsWith("/chat/completions") ? eleccionNegada(d.choices) : salidaConNegativa(d.output);
  } catch {
    return false;
  }
}

/**
 * E7-quater · lo que hace falta para ver una negativa ESCRITA COMO TEXTO: el
 * inicio del texto de la respuesta, sin tocar el passthrough. Un tope de
 * caracteres, porque la heurística solo mira el principio (o la respuesta
 * entera si es corta).
 */
const TOPE_DEL_TEXTO_INICIAL = 1200;
class InicioDelTexto {
  private t = "";
  sumar(trozo: unknown): void {
    if (typeof trozo === "string" && this.t.length < TOPE_DEL_TEXTO_INICIAL) this.t = (this.t + trozo).slice(0, TOPE_DEL_TEXTO_INICIAL);
  }
  lleno(): boolean {
    return this.t.length >= TOPE_DEL_TEXTO_INICIAL;
  }
  valor(): string {
    return this.t;
  }
}

/**
 * E7-quater · el texto de una respuesta JSON (`stream: false`), por ruta: los
 * bloques `text` de Mensajes, el `message.content` de la primera elección de
 * Chat Completions (cadena o partes `text`) y las partes `output_text` de la
 * Responses API. Lo ilegible, o una ruta sin dialecto, es "".
 */
export function textoDeRespuestaJson(path: string, cuerpo: Buffer | string): string {
  try {
    const d = JSON.parse(typeof cuerpo === "string" ? cuerpo : cuerpo.toString("utf8")) as Record<string, unknown> | null;
    if (d === null || typeof d !== "object") return "";
    const partes = (xs: unknown, tipo: string, campo: "text"): string =>
      Array.isArray(xs)
        ? xs
            .filter((p) => p !== null && typeof p === "object" && (p as { type?: unknown }).type === tipo)
            .map((p) => (p as Record<string, unknown>)[campo])
            .filter((t): t is string => typeof t === "string")
            .join("")
        : "";
    if (path === "/v1/messages") return partes(d["content"], "text", "text");
    if (path.endsWith("/chat/completions")) {
      const c = Array.isArray(d["choices"]) ? (d["choices"][0] as { message?: { content?: unknown } } | undefined) : undefined;
      const contenido = c?.message?.content;
      return typeof contenido === "string" ? contenido : partes(contenido, "text", "text");
    }
    if (path.endsWith("/responses") && Array.isArray(d["output"])) {
      return d["output"]
        .map((item) => (item !== null && typeof item === "object" ? partes((item as { content?: unknown }).content, "output_text", "text") : ""))
        .join("");
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * E7-quater · ¿la respuesta es una negativa que el modelo escribió como TEXTO
 * normal (`end_turn`/`stop`, sin señal del API)? La misma heurística
 * conservadora que el SDK (`negativaEnTexto`, src/providers/negativa-en-texto.ts):
 * solo el inicio del texto, o el texto entero si es corto. La gemela coalescida
 * de una primaria así no se valora por referencia (`primary-text-refusal`). Un
 * falso positivo cuesta una gemela `estimated` en vez de `reference`; la
 * respuesta llega igual al cliente.
 */
export function negativaEnTextoDeRespuesta(texto: string): boolean {
  return negativaEnTexto(texto) !== null;
}

/**
 * ¿La respuesta JSON (`stream: false`) de `/v1/messages` es una negativa que
 * Anthropic documenta como NO cobrada? `stop_reason: "refusal"`, `content`
 * vacío, `output_tokens` 0 y una categoría que la tabla oficial marca «no»
 * (`negativaNoCobrada`, src/providers/anthropic-uso.ts). Solo la API de
 * Mensajes: OpenAI cuenta sus negativas en `usage` como salida y las cobra. Lo
 * ilegible es false (se mide como siempre).
 */
export function negativaNoCobradaEnJson(path: string, cuerpo: Buffer | string): boolean {
  if (path !== "/v1/messages") return false;
  try {
    const d = JSON.parse(typeof cuerpo === "string" ? cuerpo : cuerpo.toString("utf8")) as {
      stop_reason?: unknown;
      stop_details?: unknown;
      content?: unknown;
      usage?: { output_tokens?: unknown; iterations?: unknown } | null;
    } | null;
    if (d === null || typeof d !== "object") return false;
    return negativaNoCobrada({
      stopReason: d.stop_reason,
      stopDetails: d.stop_details,
      bloques: Array.isArray(d.content) ? d.content.length : -1,
      outputTokens: d.usage?.output_tokens,
      iterations: d.usage?.iterations,
    });
  } catch {
    return false;
  }
}

/**
 * Parte G · el `service_tier` que el proveedor dice haber SERVIDO, leído de la
 * respuesta entera (la réplica que recibe la gemela), cada dialecto en su sitio:
 *   · `/v1/messages` (Anthropic): `usage.service_tier` — en el JSON, o en
 *     `message_start.message.usage` / `message_delta.usage` del stream.
 *   · `…/chat/completions`: `service_tier` en la raíz del JSON o de cada chunk.
 *   · `…/responses`: `service_tier` en la raíz del JSON, o en `response` de los
 *     eventos del stream.
 * Gana el ÚLTIMO que aparezca (el del evento final). undefined si la respuesta
 * no lo dice: no es «estándar», es no saberlo.
 */
export function tierServidoDeRespuesta(path: string, cuerpo: Buffer | string): string | undefined {
  const texto = typeof cuerpo === "string" ? cuerpo : cuerpo.toString("utf8");
  const deObjeto = (d: unknown): string | undefined => {
    if (d === null || typeof d !== "object") return undefined;
    const o = d as Record<string, unknown>;
    const deUso = (u: unknown): unknown =>
      u !== null && typeof u === "object" ? (u as Record<string, unknown>)["service_tier"] : undefined;
    let t: unknown;
    if (path === "/v1/messages") {
      t = deUso(o["usage"]);
      if (t === undefined && o["message"] !== null && typeof o["message"] === "object") {
        t = deUso((o["message"] as Record<string, unknown>)["usage"]);
      }
    } else if (path.endsWith("/chat/completions")) {
      t = o["service_tier"];
    } else if (path.endsWith("/responses")) {
      t = o["service_tier"];
      if (t === undefined && o["response"] !== null && typeof o["response"] === "object") {
        t = (o["response"] as Record<string, unknown>)["service_tier"];
      }
    }
    return typeof t === "string" && t !== "" ? t : undefined;
  };
  // JSON entero (stream: false)…
  try {
    return deObjeto(JSON.parse(texto));
  } catch {
    /* …o un stream SSE: cada línea `data:` por separado */
  }
  let ultimo: string | undefined;
  for (const linea of texto.split("\n")) {
    if (!linea.startsWith("data:")) continue;
    const data = linea.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    try {
      ultimo = deObjeto(JSON.parse(data)) ?? ultimo;
    } catch {
      /* un data ilegible no dice nada del tier */
    }
  }
  return ultimo;
}

/** ¿La ruta tiene un dialecto de `usage` que el gateway sabe leer? */
export function tieneDialecto(path: string): boolean {
  return (
    path === "/v1/messages" ||
    path.endsWith("/chat/completions") ||
    path.endsWith("/responses") ||
    path.endsWith(":generateContent") ||
    path.endsWith(":streamGenerateContent")
  );
}

/** El resultado de intentar pedir el usage final en un stream de Chat Completions. */
export type InyeccionDeUso =
  | { cuerpo: Buffer<ArrayBuffer>; motivo: "inyectado" }
  | { cuerpo: null; motivo: "comprimido" | "ilegible" | "no-stream" | "ya-lo-pide" | "cliente-decide" };

const INSERCION_INCLUDE_USAGE = Buffer.from('"stream_options":{"include_usage":true},', "utf8");

/**
 * Añade `"stream_options":{"include_usage":true},` justo tras la `{` inicial,
 * SIN reserializar: los números, el orden y los espacios del cliente viajan
 * intactos (un JSON.stringify redondearía un float largo o reordenaría nada que
 * el proveedor necesite, pero el principio del passthrough es no tocar lo que
 * no hace falta). Solo con el cuerpo sin comprimir, `stream === true` y sin
 * `stream_options` del cliente: cualquier objeto suyo —incluido `{}` o
 * `include_usage: false`— se respeta.
 *
 * La coma siempre es válida: el objeto contiene al menos `stream`.
 */
export function inyectarIncludeUsage(cuerpo: Buffer, codificacion?: string): InyeccionDeUso {
  const cod = (codificacion ?? "").trim().toLowerCase();
  if (cod !== "" && cod !== "identity") return { cuerpo: null, motivo: "comprimido" };
  let json: unknown;
  try {
    json = JSON.parse(cuerpo.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    return { cuerpo: null, motivo: "ilegible" };
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return { cuerpo: null, motivo: "ilegible" };
  const o = json as { stream?: unknown; stream_options?: { include_usage?: unknown } | null };
  if (o.stream !== true) return { cuerpo: null, motivo: "no-stream" };
  if (o.stream_options?.include_usage === true) return { cuerpo: null, motivo: "ya-lo-pide" };
  if (o.stream_options !== undefined) return { cuerpo: null, motivo: "cliente-decide" };
  // El primer byte que no sea espacio JSON ni el BOM (EF BB BF) tiene que ser `{`.
  let i = 0;
  while (i < cuerpo.length) {
    const b = cuerpo[i]!;
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) {
      i++;
      continue;
    }
    if (b === 0xef && cuerpo[i + 1] === 0xbb && cuerpo[i + 2] === 0xbf) {
      i += 3;
      continue;
    }
    break;
  }
  if (cuerpo[i] !== 0x7b) return { cuerpo: null, motivo: "ilegible" };
  return {
    cuerpo: Buffer.concat([cuerpo.subarray(0, i + 1), INSERCION_INCLUDE_USAGE, cuerpo.subarray(i + 1)]),
    motivo: "inyectado",
  };
}

/**
 * true / false: la petición es un stream y pide / no pide `include_usage`.
 * null: no es un stream, o el cuerpo no se puede leer.
 */
export function pideUsoEnStream(cuerpo: Buffer, codificacion?: string): boolean | null {
  const json = jsonDelCuerpo(cuerpo, codificacion);
  if (json === null || typeof json !== "object") return null;
  const o = json as { stream?: unknown; stream_options?: { include_usage?: unknown } | null };
  if (o.stream !== true) return null;
  return o.stream_options?.include_usage === true;
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

/**
 * Traffic with no per-token invoice (a Claude or ChatGPT subscription),
 * recognised only by protocol markers, never by credentials: an
 * `anthropic-beta` element starting with `oauth-`, a `/backend-api/` path, or
 * a chatgpt.com upstream.
 */
export function isSubscriptionTraffic(pathname: string, anthropicBeta: string | undefined, upstreamBase: string): boolean {
  // Las MARCAS del protocolo, jamás el valor de `Authorization` ni de
  // `x-api-key`: la beta oauth-* es obligatoria para el OAuth de Claude Code, y
  // el backend de ChatGPT solo se alcanza por /backend-api/ en chatgpt.com.
  if ((anthropicBeta ?? "").split(",").some((b) => b.trim().startsWith("oauth-"))) return true;
  if (pathname.startsWith("/backend-api/")) return true;
  try {
    const host = new URL(upstreamBase).hostname.toLowerCase();
    return host === "chatgpt.com" || host.endsWith(".chatgpt.com");
  } catch {
    return false;
  }
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
  /** true → no se acredita ahorro de rebaja ni de hermano: baseline == actual. */
  subscription?: boolean,
  /**
   * true → el gateway no habla con el origen oficial del proveedor (un proxy,
   * LiteLLM, un revendedor): tampoco se acredita dinero. Ver construirInforme.
   */
  upstreamNoOficial?: boolean,
  /**
   * true → la respuesta es una negativa que Anthropic documenta como NO
   * cobrada (`negativaNoCobradaEnJson`, `ObservadorSse.negativaNoCobrada`): se
   * mide a coste 0 y no se acredita nada. Ver construirInforme.
   */
  sinCobro?: boolean,
  /**
   * Los tokens que este turno reescribió porque la rebaja del turno anterior
   * dejó caducar su entrada de 5 min. Se RESTAN del ahorro: ver construirInforme.
   */
  falloTtl?: FalloTtl | null,
): SavingsReport {
  return construirInforme(
    requestId, model, medido, false, atribucion, elision, rebaja, hermano, subscription, upstreamNoOficial, sinCobro === true,
    falloTtl ?? null,
  );
}

/**
 * Los textos de USUARIO del cuerpo de una petición, en los tres dialectos:
 * `messages[].content` de Mensajes y Chat Completions (cadena o partes `text`)
 * y el `input` de la Responses API (cadena, o elementos con `role: "user"` y
 * partes `input_text`). Lo que no se entiende no aporta nada.
 */
export function textosDeUsuario(cuerpo: unknown): string[] {
  if (cuerpo === null || typeof cuerpo !== "object" || Array.isArray(cuerpo)) return [];
  const d = cuerpo as Record<string, unknown>;
  const deContenido = (c: unknown): string[] =>
    typeof c === "string"
      ? [c]
      : Array.isArray(c)
        ? c
            .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
            .filter((p) => p["type"] === "text" || p["type"] === "input_text")
            .map((p) => p["text"])
            .filter((t): t is string => typeof t === "string")
        : [];
  const deTurnos = (xs: unknown): string[] =>
    Array.isArray(xs)
      ? xs
          .filter((m): m is Record<string, unknown> => m !== null && typeof m === "object")
          .filter((m) => m["role"] === "user")
          .flatMap((m) => deContenido(m["content"]))
      : [];
  return [...deTurnos(d["messages"]), ...(typeof d["input"] === "string" ? [d["input"]] : deTurnos(d["input"]))];
}

/**
 * 2026-09-29 · el tema sensible del texto de usuario de una petición (ver
 * `textosDeUsuario`), o null: la misma heurística que la política del SDK.
 */
export function temaSensibleDelCuerpo(cuerpo: unknown): TemaSensible | null {
  return temaSensibleEnTextos(textosDeUsuario(cuerpo));
}

/**
 * Por qué una gemela coalescida NO se valora por referencia y sigue
 * `estimated`. ASCII inglés: va a la línea de log, que lee quien usa el gateway.
 *
 * - `no-primary-record` — la réplica no trae la huella de su primaria, o la
 *                         primaria no leyó el contador final en su respuesta
 *                         (no hay registro medido al que apuntar).
 * - `subscription`      — tráfico de suscripción: no hay factura por token.
 * - `unofficial-upstream` — el gateway no habla con el origen oficial del
 *                         proveedor (un mock, un proxy, un revendedor): el
 *                         precio de lista no está en ninguna factura.
 * - `layer-changed-request` — una palanca cambió el cuerpo, las cabeceras o el
 *                         modelo de la primaria (también la rebaja de TTL): su
 *                         contador no es el de la petición del cliente.
 * - `primary-failed`    — la primaria cerró con `response.failed` (o
 *                         `status: "failed"` en el JSON).
 * - `primary-refused`   — la primaria fue una NEGATIVA del proveedor (E7:
 *                         `stop_reason: "refusal"`, `finish_reason:
 *                         "content_filter"`, `message.refusal` o una parte
 *                         `refusal` de la Responses API). Se mide, pero no se
 *                         repite como llamada evitada: en las categorías que
 *                         Anthropic no cobra, la repetición habría costado 0 $.
 * - `primary-text-refusal` — la primaria fue una negativa que el MODELO escribió
 *                         como texto normal (`end_turn`/`stop`, sin señal del
 *                         API; heurística `negativaEnTexto`). Se mide, pero una
 *                         negativa no es una respuesta que repetir ni cobrar.
 * - `sensitive-topic`   — el texto de USUARIO de la petición toca un tema
 *                         sensible (autolesión/suicidio, crisis de salud mental,
 *                         emergencia médica; `temaSensible`,
 *                         src/policy/tema-sensible.ts). Se mide, pero la
 *                         respuesta a un tema así no se repite ni se cobra como
 *                         ahorro (decisión del dueño, 2026-09-29), igual que en
 *                         el SDK.
 * - `client-disconnected` — el cliente de la gemela se fue antes de recibir la
 *                         réplica entera: sin la capa se habría cortado igual,
 *                         y una llamada que nadie recibió no es una llamada
 *                         evitada que se pueda cobrar.
 * - `service-tier`      — el tier pedido o el servido no tiene precio por token
 *                         conocido (`scale`, uno nuevo…): no hay suelo que valga.
 * - `no-cached-price`   — el modelo no tiene precio de lectura documentado en SU
 *                         fila del catálogo (una fila heredada no vale).
 * - `no-credit`         — el contador no deja nada que acreditar.
 */
export type MotivoSinReferenciaGateway =
  | "no-primary-record"
  | "subscription"
  | "unofficial-upstream"
  | "layer-changed-request"
  | "primary-failed"
  | "primary-refused"
  | "primary-text-refusal"
  | "sensitive-topic"
  | "client-disconnected"
  | "service-tier"
  | "no-cached-price"
  | "no-credit";

/** Parte G · lo que se sabe de la GEMELA (lo de su primaria va en `HuellaDeLaPrimaria`). */
export interface HechosDeLaGemela {
  /** Tráfico de suscripción según las cabeceras de la PROPIA gemela. */
  suscripcion: boolean;
  /** La réplica llegó entera a su cliente (no cerró antes de recibirla). */
  entregada: boolean;
  /** `service_tier` que la respuesta de la primaria dice haber SERVIDO, si lo dice. */
  tierServido?: string | undefined;
}

/** Tiers que se facturan a la tarifa estándar o por ENCIMA: el suelo de lista vale. */
const TIERS_A_PRECIO_DE_LISTA = new Set(["auto", "default", "priority", "standard_only"]);

/**
 * El factor de precio que el cuerpo de la petición deja como MÁXIMO para la
 * repetición. Sin `service_tier`, o con uno que factura a lista o más caro, 1.
 * Con uno con descuento conocido (`flex`), su factor: la primaria se sirvió en
 * ese tier o en uno más caro, así que tomar el del tier pedido nunca excede lo
 * que la repetición habría costado. Cualquier otro valor (`scale`, cuya tarifa
 * no se publica, o uno nuevo) → null: sin precio conocido no hay suelo.
 *
 * OJO: aquí `veredictoDelTier` recibe el tier PEDIDO, y su módulo
 * (src/economics/tier-diferido.ts) dice que su única entrada es el SERVIDO. Se
 * usa solo como tabla de descuentos y el resultado actúa como TOPE: pedir
 * `flex` nunca sube el suelo por encima de lo que se habría pagado. El tier
 * servido se mira aparte (`factorDelTierServido`) y manda el menor de los dos.
 */
function factorDelTierPedido(tier: unknown): number | null {
  if (tier === undefined || tier === null) return 1;
  if (typeof tier !== "string") return null;
  if (TIERS_A_PRECIO_DE_LISTA.has(tier)) return 1;
  const v = veredictoDelTier(tier);
  return v !== null && v.conDescuento && v.factor !== null ? v.factor : null;
}

/**
 * El factor del tier que la respuesta de la primaria dice haber SERVIDO. Sin
 * dato, 1 (el pedido ya puso su tope). `scale` → null aunque la tabla le dé 1:
 * es capacidad PREPAGADA, sin tarifa por token publicada, y cobrar su
 * repetición a precio de lista sería comisión sobre dinero que la factura por
 * token no trae. Un tier que la tabla no conoce, también null.
 */
function factorDelTierServido(servido: string | undefined): number | null {
  if (servido === undefined) return 1;
  if (servido === "scale") return null;
  const v = veredictoDelTier(servido);
  return v !== null && v.factor !== null ? v.factor : null;
}

/**
 * PARTE G · ¿se valora esta gemela por referencia? La regla v1 del SDK
 * (src/pipeline/referencia.ts), en la forma que el gateway puede comprobar:
 *
 *   · Identidad byte a byte: la da la clave de coalescencia (cuerpo más
 *     cabeceras de identidad), así que no hay huella que recalcular.
 *   · La primaria viajó INTACTA (sin excepciones: tampoco la rebaja de TTL) y
 *     no es suscripción, ni suya ni de la gemela.
 *   · El contador es de un proveedor de verdad: el origen OFICIAL (la E0
 *     `simulated-provider` del SDK, en su forma de gateway).
 *   · La gemela RECIBIÓ la réplica: una llamada que nadie recibió no se cobra.
 *   · Precio de lectura documentado en la fila PROPIA del modelo pedido
 *     (`precioDeListaPropio`): la fila de un pariente puede ser otro modelo más
 *     barato, y entonces el «suelo» ya no lo sería.
 *
 * Y la valoración es el SUELO: TODA la entrada que el proveedor facturó
 * (normal, leída y escrita en caché) a precio de LECTURA, que es lo mínimo que
 * cobra por un token de entrada aunque la repetición hubiera acertado entera en
 * su caché de prefijo; sin primas de escritura; la salida solo con
 * `temperature: 0` en el cuerpo y al 95 % (REFERENCE_OUTPUT_SHARE), porque sin
 * muestreo determinista nada garantiza que la repetición escribiera lo mismo,
 * y solo si el modelo es una fila del catálogo que no razona y honra
 * `temperature: 0` (`salidaNoRepetible`, la guarda de modelo de la regla v2 del
 * SDK en src/pricing/razonamiento.ts): la longitud del razonamiento oculto
 * cambia de una llamada a otra y su contador no dice lo que la repetición habría
 * escrito. La otra mitad de la guarda v2 (el proveedor declaró 0 tokens de
 * razonamiento en la primaria) el gateway aún no la lee; por eso el ingest
 * sigue sin admitir `reference` de `gateway/` (apps/web/lib/metering/version.ts)
 * y estos registros entran como `estimated`;
 * y todo por el MENOR de los factores del tier pedido y del servido. La primera
 * condición que falla da el motivo; nunca se lanza nada y nunca se reclama de más.
 */
export function valorarGemelaPorReferencia(
  model: string,
  medidoPrimaria: RegistroMedido,
  primaria: HuellaDeLaPrimaria | null | undefined,
  cuerpo: unknown,
  gemela: HechosDeLaGemela,
): { ok: true; credit: ReferenceCredit } | { ok: false; reason: MotivoSinReferenciaGateway } {
  if (!primaria || !primaria.conContador) return { ok: false, reason: "no-primary-record" };
  if (primaria.suscripcion || gemela.suscripcion) return { ok: false, reason: "subscription" };
  if (!primaria.proveedorOficial) return { ok: false, reason: "unofficial-upstream" };
  if (!primaria.intacta) return { ok: false, reason: "layer-changed-request" };
  if (primaria.fallida) return { ok: false, reason: "primary-failed" };
  if (primaria.negativa === true) return { ok: false, reason: "primary-refused" };
  if (primaria.negativaEnTexto === true) return { ok: false, reason: "primary-text-refusal" };
  if (temaSensibleDelCuerpo(cuerpo) !== null) return { ok: false, reason: "sensitive-topic" };
  if (!gemela.entregada) return { ok: false, reason: "client-disconnected" };

  const json = cuerpo !== null && typeof cuerpo === "object" && !Array.isArray(cuerpo) ? (cuerpo as Record<string, unknown>) : {};
  const factorPedido = factorDelTierPedido(json["service_tier"]);
  const factorServido = factorDelTierServido(gemela.tierServido);
  if (factorPedido === null || factorServido === null) return { ok: false, reason: "service-tier" };
  const tierFactor = Math.min(factorPedido, factorServido);

  const precio = precioDeListaPropio(model, medidoPrimaria.instante);
  const c = precio?.cachedInputPer1k;
  if (
    !precio ||
    typeof c !== "number" ||
    !Number.isFinite(c) ||
    !(c > 0) ||
    !Number.isFinite(precio.inputPer1k) ||
    c > precio.inputPer1k ||
    !Number.isFinite(precio.outputPer1k) ||
    precio.outputPer1k < 0
  ) {
    return { ok: false, reason: "no-cached-price" };
  }

  const t = medidoPrimaria.tokens;
  const entrada = t.entrada + t.cacheLeida + t.cacheEscrita;
  const esEntero = (n: number): boolean => Number.isInteger(n) && n >= 0;
  if (!esEntero(t.entrada) || !esEntero(t.cacheLeida) || !esEntero(t.cacheEscrita) || !esEntero(t.salida) || !(entrada > 0)) {
    return { ok: false, reason: "no-credit" };
  }
  // La salida, solo con muestreo determinista pedido Y un modelo cuya salida se
  // puede repetir (la misma guarda de modelo que la regla v2 del SDK).
  const determinista = json["temperature"] === 0 && salidaNoRepetible(model) === undefined;
  return {
    ok: true,
    credit: {
      requestId: primaria.requestId,
      at: primaria.at,
      inputTokens: entrada,
      outputTokens: t.salida,
      // El gateway no inserta mensajes en una primaria intacta: nada que descontar.
      creditedInputTokens: entrada,
      creditedOutputTokens: determinista ? Math.floor(REFERENCE_OUTPUT_SHARE * t.salida) : 0,
      cachedInputPer1k: c,
      outputPer1k: precio.outputPer1k,
      tierFactor,
    },
  };
}

/** El suelo en USD de un crédito por referencia: la fórmula que publica `ReferenceCredit`. */
export function sueloDeReferencia(r: ReferenceCredit): number {
  return r.tierFactor * ((r.creditedInputTokens / 1_000) * r.cachedInputPer1k + (r.creditedOutputTokens / 1_000) * r.outputPer1k);
}

/**
 * El informe de una GEMELA coalescida: la llamada nunca viajó, así que es una
 * llamada evitada (coste real 0, netSavings 1).
 *
 * Con `referencia` (Parte G, ver `valorarGemelaPorReferencia`) su baseline es el
 * SUELO por referencia y viaja con `basis: "reference"`, el puntero a la
 * primaria (`cache.reference` → wire `referenceRequestId`/`referenceAt`) y los
 * tokens ACREDITADOS como baseline: lo que el ingest comprueba con
 * `referenciaCoherente` (apps/web/lib/metering/usage.ts).
 *
 * Sin ella, como siempre: el coste de la primaria como baseline y
 * `basis: "estimated"`, que NUNCA entra en la base de la comisión.
 */
export function informeCoalescido(
  requestId: string,
  model: string,
  medidoPrimaria: RegistroMedido,
  atribucion?: Atribucion,
  referencia?: ReferenceCredit | null,
  /**
   * true → la primaria fue una negativa que Anthropic no cobra: la llamada
   * evitada habría costado 0 $ y la gemela no acredita nada (ni por referencia,
   * que `primary-refused` ya descarta, ni estimado).
   */
  sinCobro?: boolean,
): SavingsReport {
  const suelo = referencia ? sueloDeReferencia(referencia) : 0;
  if (sinCobro === true || !referencia || !(suelo > 0) || !Number.isFinite(suelo)) {
    return construirInforme(
      requestId, model, medidoPrimaria, true, atribucion, undefined, undefined, undefined, false, false, sinCobro === true,
    );
  }
  const informe = {
    requestId,
    model,
    ...(atribucion && (atribucion.sessionId || atribucion.agentId) ? { attribution: atribucion } : {}),
    calls: { avoidedLlm: 1, actualLlm: 0 },
    tokens: {
      baselineInput: referencia.creditedInputTokens,
      actualInput: 0,
      eliminatedInput: 0,
      compressedInput: 0,
      baselineOutput: referencia.creditedOutputTokens,
      actualOutput: 0,
      providerCachedInput: 0,
    },
    cache: { result: "singleflight" as const, reference: referencia },
    cost: {
      baselineEstimate: suelo,
      actual: 0,
      // PROPORCIÓN en [-100,1]: la llamada entera se evitó. Desde la 0.5 se llama
      // `netSavingsRatio` (el `netSavings` de la 0.4 se fue) y va con su importe.
      netSavingsRatio: 1,
      netSavingsUsd: suelo,
      basis: "reference" as const,
    },
  };
  return informe as unknown as SavingsReport;
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
      netSavingsRatio: baselineUsd > 0 ? Math.max(-100, Math.min(1, (baselineUsd - politicaUsd) / baselineUsd)) : 0,
      netSavingsUsd: baselineUsd - politicaUsd,
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
  const precioSolicitado = precioDeLista(hermano.solicitado, medido.instante);
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
  subscription = false,
  upstreamNoOficial = false,
  sinCobro = false,
  falloTtl: FalloTtl | null = null,
): SavingsReport {
  // UNA NEGATIVA QUE ANTHROPIC NO COBRA (decisión del dueño, 2026-09-28): una
  // negativa antes de cualquier salida en `cyber`, `general_harms` o categoría
  // nula trae `usage` con tokens, pero la factura es 0 $ (documentación oficial,
  // «How refusals are billed»). Se mide a coste 0 —los tokens siguen contados:
  // es lo que dijo el proveedor— y no acredita NINGÚN ahorro: ni la rebaja de
  // TTL, ni el hermano, ni el suelo de la elisión, ni, en una gemela, la
  // llamada evitada. Sin esto, una palanca podía acreditar ahorro `measured`
  // sobre una petición que no se cobró.
  if (sinCobro) medido = { ...medido, costeUsd: 0 };
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
  //
  // Tráfico de suscripción: sin factura por tokens no hay nada contra lo que
  // defender el ahorro; se aplica la palanca, no se acredita el dinero. Las dos
  // restas de arriba son entre precios de LISTA, y un suscriptor no paga lista:
  // acreditarlas sería cobrar comisión sobre una diferencia que no aparece en
  // ninguna factura suya. Con `subscription`, baseline == actual por diseño.
  //
  // Upstream NO OFICIAL (decisión del dueño, 2026-09-28): la misma razón. Las
  // restas son entre precios de lista, y el precio de lista solo está en la
  // factura del ORIGEN del proveedor (esUpstreamOficial). Detrás de LiteLLM, un
  // revendedor o un modelo propio, esa diferencia no aparece en ninguna factura
  // que podamos defender: se aplica la palanca, se mide el coste y no se
  // acredita nada. Es lo que la Parte G ya hace con la gemela coalescida
  // (`unofficial-upstream`), ahora también con la rebaja de TTL, el hermano y el
  // suelo de la elisión, que es dinero a precio de lectura de caché de lista.
  const acreditable = !coalescida && !subscription && !upstreamNoOficial;
  // Y una negativa que no se cobró tampoco acredita palanca alguna (arriba).
  const acreditaPalancas = acreditable && !sinCobro;
  const escrita5m = medido.tokens.cacheEscrita - medido.tokens.cacheEscrita1h;
  // ── EL NETO (2026-10-03) · el fallo de caché que la rebaja provocó ───────
  //
  // Hasta la 0.5.0 esto acreditaba el BRUTO: la prima de cada escritura
  // rebajada, sin restar que la entrada de 5 min caduca antes y el turno
  // siguiente tiene que reescribir lo que con 1h habría leído. El banco de TTL
  // (docs/benchmarks/2026-10-03/ttl.md) midió que esos fallos se comen
  // alrededor de un 30 % del bruto. Ahora el turno que SUFRE el fallo lo resta:
  // `falloTtl.perdidos` son los tokens que este turno reescribió por culpa de
  // la rebaja del turno anterior (fallos-ttl.ts). Sin la palanca se habrían
  // leído, así que
  //  · el baseline los cuenta a precio de LECTURA, no a lo que se pagó
  //    (`costeFalloTtl` baja el baseline: este turno puede salir en NEGATIVO);
  //  · y si este turno también va rebajado, no acreditan prima: sin la palanca
  //    no se habrían escrito a 1h, se habrían leído.
  // Solo donde la palanca acredita dinero (`acreditaPalancas`): donde no se
  // enseña el ahorro tampoco se enseña su coste.
  const perdidos = acreditaPalancas && falloTtl ? Math.max(0, Math.min(falloTtl.perdidos, medido.tokens.cacheEscrita)) : 0;
  const rebajaAcreditable =
    acreditaPalancas && rebaja && rebaja.rebajadas > 0 && rebaja.yaEran5m === 0 && !rebaja.herramientaDeServidor;
  const sobrecosteEvitado =
    rebajaAcreditable && escrita5m - perdidos > 0
      ? ((escrita5m - perdidos) / 1_000) * medido.precio.inputPer1k * (PRIMA_ESCRITURA_CACHE_1H - PRIMA_ESCRITURA_CACHE)
      : 0;
  // La prima a la que se reescribió lo perdido: la media de las escrituras de
  // ESTE turno (1,25× si todo fue a 5 min, 2× si todo fue a 1h).
  const primaPagada =
    medido.tokens.cacheEscrita > 0
      ? (Math.max(0, escrita5m) * PRIMA_ESCRITURA_CACHE + medido.tokens.cacheEscrita1h * PRIMA_ESCRITURA_CACHE_1H) /
        medido.tokens.cacheEscrita
      : PRIMA_ESCRITURA_CACHE_1H;
  const costeFalloTtl = Math.min(
    medido.costeUsd,
    costeDeFallo({
      perdidos,
      inputPer1k: medido.precio.inputPer1k,
      cachedInputPer1k: medido.precio.cachedInputPer1k,
      primaEscritura: primaPagada,
    }),
  );
  const ahorroHermano = acreditaPalancas && hermano ? ahorroDeHermano(hermano, medido) : 0;
  // Nunca por debajo de 0: el baseline es un importe (la verja del ingest).
  const baselineMedido = Math.max(0, medido.costeUsd + sobrecosteEvitado + ahorroHermano - costeFalloTtl);
  const ahorroMedido = baselineMedido - medido.costeUsd;
  // B2 · el suelo de la elisión del proveedor (ver sueloDeElision). Una gemela
  // coalescida no viajó: no elidió nada y no tiene suelo.
  const sueloElision = coalescida || upstreamNoOficial || sinCobro ? 0 : sueloDeElision(medido.precio, elision);
  // EL AHORRO NATIVO (report.nativeSavings): lo que la caché de prefijo DEL
  // PROVEEDOR le quitó a esta factura, neto de la prima de escritura. Carril
  // propio: no toca baseline, actual, netSavings ni basis, y jamás entra en la
  // comisión. Solo donde hay una factura por tokens a precio de lista que lo
  // respalde: ni gemela (no viajó), ni suscripción, ni upstream no oficial, ni
  // negativa no cobrada.
  const nativo = acreditaPalancas
    ? ahorroNativo(model, medido.precio, {
        leidos: medido.tokens.cacheLeida,
        escritos: medido.tokens.cacheEscrita,
        escritos1h: medido.tokens.cacheEscrita1h,
        contadorCompleto: true,
      })
    : undefined;
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
    ...(nativo ? { nativeSavings: nativo } : {}),
    cost: coalescida
      ? {
          baselineEstimate: medido.costeUsd,
          actual: 0,
          // netSavingsRatio es una PROPORCIÓN [-100,1], no dólares: una coalescencia
          // evita la llamada entera, así que es 1 (100 %). Antes iba `costeUsd`,
          // y si la primaria costó > $1 (opus caro) el ingest rechazaba el LOTE
          // completo por `> 1` — se perdían hasta 50 registros. Ver el contrato
          // en src/tokenizer/accounting.ts y la verja en lib/metering/usage.ts.
          // Sin cobro no hubo nada que evitar: 0, no el 100 %.
          netSavingsRatio: sinCobro ? 0 : 1,
          netSavingsUsd: medido.costeUsd,
          basis: "estimated" as const,
        }
      : {
          baselineEstimate: baselineMedido,
          actual: medido.costeUsd,
          // PROPORCIÓN en [-100,1], como el resto del contrato (ver la cicatriz
          // de la coalescencia más arriba). Sin rebaja ni hermano vale 0 y la
          // doctrina de siempre se mantiene intacta: sin palanca no hay ahorro
          // que enseñar.
          netSavingsRatio: baselineMedido > 0 ? Math.max(-100, Math.min(1, ahorroMedido / baselineMedido)) : 0,
          netSavingsUsd: baselineMedido - medido.costeUsd,
          basis: "measured" as const,
          // B2 · solo cuando hay dinero: el campo AUSENTE es «no hubo borrado
          // atribuible», y un 0 explícito no añadiría nada.
          ...(sueloElision > 0 ? { eliminatedInputFloorCost: sueloElision } : {}),
        },
  };
  return informe as unknown as SavingsReport;
}
