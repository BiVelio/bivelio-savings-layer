import type { ProviderUsage } from "./types.js";
import { extraDeCompactacion } from "./iteraciones-de-compactacion.js";

// EL CONTADOR DE LA API DE MENSAJES, EN FUNCIONES PURAS.
//
// Vivía dentro de `anthropic.ts` y ahora lo leen DOS sitios: el proveedor
// propio (`AnthropicProvider`) y el adaptador del SDK oficial de Anthropic
// (`src/adapters/anthropic-sdk.ts`), que ve las mismas respuestas pero no pasa
// por el proveedor. Dos copias de esta aritmética serían dos reglas: la misma
// factura se contaría de dos formas según por dónde entrase la petición, y una
// de las dos acabaría leyendo `input_tokens` a secas —el resto NO cacheado— como
// si fuera el prompt entero. Por eso se movió TAL CUAL y los dos importan de aquí.
//
// Módulo INTERNO: no se reexporta desde `providers/index.ts`.

/**
 * El `usage` de la API de Mensajes, tal como llega en `message_start`,
 * `message_delta` o la respuesta JSON.
 */
export interface UsoAnthropic {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  /** "standard" | "priority" | "batch" — se trata como conjunto abierto. */
  service_tier?: string;
  /**
   * Las iteraciones de una respuesta con compactación del servidor. El contador
   * de arriba es el de la ÚLTIMA; las anteriores también se facturan.
   */
  iterations?: unknown;
}

/** Lo que devuelve el cálculo: el uso neutro y qué contador faltó, para el mensaje de error. */
export interface UsoCalculado {
  usage: ProviderUsage;
  entradaAusente: boolean;
  salidaAusente: boolean;
}

/**
 * El uso neutro de UN mensaje ya completo.
 *
 * `salida` va aparte porque en un stream no sale del mismo sitio que la
 * entrada: `message_start` trae un `output_tokens` provisional y el definitivo
 * llega en `message_delta`. En la respuesta JSON es `uso.output_tokens`.
 *
 * `razono`: si la respuesta trajo un bloque `thinking` o `redacted_thinking`.
 */
export function usoDeMensajes(
  uso: UsoAnthropic | undefined,
  salida: number | undefined,
  razono: boolean,
): UsoCalculado {
  const u = uso ?? {};
  // LA COMPACTACIÓN DEL SERVIDOR NO ESTÁ EN EL PRIMER NIVEL. Con la beta de
  // compactación, `input_tokens`/`output_tokens` excluyen la iteración que
  // resume el historial, y la documentación oficial manda sumar
  // `usage.iterations` para tener lo facturado. Se suman SOLO las iteraciones
  // `compaction` (ver iteraciones-de-compactacion.ts: el primer nivel ya es la
  // suma de las demás). En un stream, `iterations` viaja en el `message_delta`
  // final y llega aquí dentro del uso ya fusionado.
  const compactacion = extraDeCompactacion(u.iterations);
  const lecturaCache = sumarSiHay(u.cache_read_input_tokens, compactacion?.cacheRead);
  const escrituraCache = sumarSiHay(u.cache_creation_input_tokens, compactacion?.cacheWrite);

  // EL ERROR QUE ESTO EVITA, Y VALE DINERO DEL CLIENTE.
  //
  // `usage.input_tokens` de Anthropic NO es el prompt entero: es SÓLO el resto
  // no cacheado. El total es
  //
  //     input_tokens + cache_creation_input_tokens + cache_read_input_tokens
  //
  // Mapear `inputTokens = usage.input_tokens` a secas haría que, en cuanto la
  // caché empiece a acertar, `ledger.actualInput` se desplome mientras el
  // baseline se reconstruye sobre él: un prompt de 100k servido al 96% desde
  // caché reportaría ~4k de entrada. El ahorro publicado NO vendría de la capa
  // sino de un contador leído a medias. Se suman los tres.
  const inputTokens =
    (u.input_tokens ?? 0) + (compactacion?.input ?? 0) + (escrituraCache ?? 0) + (lecturaCache ?? 0);
  const outputTokens = (salida ?? 0) + (compactacion?.output ?? 0);

  // La guardia comprueba AUSENCIA, no valor cero, y por separado en cada
  // contador: un cero legítimo (respuesta vacía, parada inmediata) es medible,
  // mientras que un contador ausente no se puede tarifar. Los dos de caché
  // pueden faltar sin más: significan "no hubo".
  const entradaAusente = typeof u.input_tokens !== "number";
  const salidaAusente = typeof salida !== "number";

  return {
    usage: {
      inputTokens,
      outputTokens,
      // Sólo el LEÍDO es libro 4. `cache_creation_input_tokens` es la prima de
      // escritura —se paga MÁS caro— y contarlo como ahorro publicaría un
      // sobrecoste como si fuera un descuento.
      ...(lecturaCache != null ? { cachedInputTokens: lecturaCache } : {}),
      ...(escrituraCache != null ? { cacheWriteInputTokens: escrituraCache } : {}),
      // RAZONAMIENTO OCULTO. La API de Mensajes no lo desglosa en `usage`: los
      // tokens de `thinking` van dentro de `output_tokens`. Lo que sí hace es
      // devolver SIEMPRE su bloque cuando lo hubo, así que sin bloque el
      // razonamiento es 0 —y se dice—, y con él no se sabe cuánto fue y no se
      // dice nada. Solo si hay contador de salida del que decirlo.
      // Con compactación tampoco: la salida incluye un resumen que no es la
      // respuesta servida, y un 0 afirmaría de más.
      ...(razono || salidaAusente || compactacion ? {} : { reasoningTokens: 0 }),
      // Un contador ausente se rellenó con 0: la petición sale `unmeasured`.
      // Con el usage completo la clave NO aparece.
      ...(entradaAusente || salidaAusente ? { complete: false } : {}),
    },
    entradaAusente,
    salidaAusente,
  };
}

// Un contador de primer nivel más lo que añade la compactación. Ausente y sin
// compactación sigue ausente (el adaptador distingue «no hubo» de «0»).
function sumarSiHay(primerNivel: number | undefined, extra: number | undefined): number | undefined {
  if (!extra) return primerNivel;
  return (primerNivel ?? 0) + extra;
}

/** El tier que el proveedor dice haber SERVIDO (va dentro de `usage` en esta API). */
export function tierServidoDe(uso: UsoAnthropic | undefined): string | undefined {
  const t = uso?.service_tier;
  return typeof t === "string" && t !== "" ? t : undefined;
}

// Fusiona dos `usage`: el segundo pisa los escalares que TRAE (un null no borra
// lo que dijo el primero) y `cache_creation` se fusiona clave a clave, igual que
// el observador SSE del gateway.
export function fusionarUso(a: UsoAnthropic | undefined, b: UsoAnthropic | undefined): UsoAnthropic {
  const presentes = Object.fromEntries(
    Object.entries(b ?? {}).filter(([, v]) => v !== null && v !== undefined),
  ) as UsoAnthropic;
  const cache_creation =
    a?.cache_creation || b?.cache_creation
      ? { ...(a?.cache_creation ?? {}), ...(b?.cache_creation ?? {}) }
      : undefined;
  return { ...(a ?? {}), ...presentes, ...(cache_creation ? { cache_creation } : {}) };
}

/** ¿Es un bloque de razonamiento (visible o redactado) de la API de Mensajes? */
export function esBloqueDeRazonamiento(tipo: string | undefined): boolean {
  return tipo === "thinking" || tipo === "redacted_thinking";
}

/** `stop_reason` de Anthropic -> el vocabulario neutro de `finishReason`. */
export function traducirParada(parada: string): string {
  switch (parada) {
    case "end_turn":
      return "stop";
    // `max_tokens` significa lo mismo que el `length` de OpenAI: la respuesta se
    // CORTÓ, no terminó. El pipeline distingue una respuesta mala de una cortada
    // por este campo —reintentar con el mismo tope vuelve a cortarla—, así que
    // el nombre tiene que ser el mismo en los dos adaptadores.
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return parada;
  }
}
