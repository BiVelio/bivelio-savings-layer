/**
 * EL COSTE DE UNA LLAMADA DEL BANCO, HONESTO FRENTE A LA FACTURA.
 * ---------------------------------------------------------------------------
 * Puro, sin entorno ni red: lo usan `ab-live.ts`, la sonda y sus verjas.
 *
 * Lo que cambia respecto al `cost()` de antes, y por qué vale dinero: la
 * ESCRITURA de caché se cobra a una prima (1,25× la entrada en Anthropic y en
 * GPT-5.6 y posteriores; `src/pricing/primas.ts`), y el banco la cobraba a 1×
 * en TODOS los brazos. Con eso la ventaja del brazo B2 —el modo de caché
 * explícito de GPT-5.6+, que no escribe un prefijo que nunca se va a leer— era
 * invisible: el banco no veía el sobrecoste que B2 evita. Ahora cada brazo paga
 * sus escrituras a la prima de su modelo, leídas del contador del proveedor.
 *
 * DE DÓNDE SALE CADA NÚMERO:
 *   · El precio de lista, del CATÁLOGO del SDK (`precioDeListaPropio`): la fila
 *     del propio modelo, nunca la de un pariente. La tabla local `PRICES` que
 *     tenía `ab-live.ts` desaparece: duplicaba el catálogo y no puede llegar a
 *     ser una segunda fuente.
 *   · La prima, de `primaDeEscritura` sobre el id sin prefijo.
 *   · Las escrituras, del adaptador (`usage.cacheWriteInputTokens`) o, si el
 *     adaptador no las lee, de la respuesta cruda del proveedor.
 */
import type { CostModel } from "../src/index.js";
import { CATALOGO, precioDeListaPropio, claveDeCatalogo } from "../src/pricing/catalogo.js";
import { primaDeEscritura } from "../src/pricing/primas.js";
import type { ProviderResponse } from "../src/providers/types.js";

type Objeto = Record<string, unknown>;
const obj = (v: unknown): Objeto | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Objeto) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Lo que dice la respuesta CRUDA del proveedor sobre escrituras, razonamiento y compactación. */
export interface UsoCrudo {
  escrituraCache: number;
  /** El proveedor declaró el contador de escritura (aunque sea 0). */
  escrituraInformada: boolean;
  razonamiento?: number;
  /** `usage.iterations` trae una entrada `compaction`: el uso de arriba NO es el total. */
  iteracionesDeCompactacion: boolean;
}

/**
 * Lee la respuesta cruda de Chat Completions (OpenAI) o de Mensajes (Anthropic).
 *
 *   · OpenAI: `usage.prompt_tokens_details.cache_write_tokens` (GPT-5.6+) y
 *     `usage.completion_tokens_details.reasoning_tokens`.
 *   · Anthropic: `usage.cache_creation_input_tokens`.
 *   · Compactación: `usage.iterations[].type === "compaction"` — cuando aparece,
 *     el `usage` de arriba no incluye esas iteraciones
 *     (https://platform.claude.com/docs/en/build-with-claude/compaction-threshold,
 *     consultado 2026-09-27), y ningún brazo la manda.
 */
export function usoCrudo(raw: unknown): UsoCrudo {
  const usage = obj(obj(raw)?.["usage"]);
  const detallesEntrada = obj(usage?.["prompt_tokens_details"]);
  const detallesSalida = obj(usage?.["completion_tokens_details"]);
  const escrituraOpenAI = num(detallesEntrada?.["cache_write_tokens"]);
  const escrituraAnthropic = num(usage?.["cache_creation_input_tokens"]);
  const escritura = escrituraOpenAI ?? escrituraAnthropic;
  const razonamiento = num(detallesSalida?.["reasoning_tokens"]);
  const iteraciones = usage?.["iterations"];
  return {
    escrituraCache: escritura ?? 0,
    escrituraInformada: escritura !== undefined,
    ...(razonamiento !== undefined ? { razonamiento } : {}),
    iteracionesDeCompactacion:
      Array.isArray(iteraciones) && iteraciones.some((it) => obj(it)?.["type"] === "compaction"),
  };
}

/** Las escrituras de caché de una respuesta, y de dónde salió el dato. */
export interface EscriturasDeLlamada {
  escrituras: number;
  informada: boolean;
  fuente: "adapter" | "raw-usage" | "none";
}

/**
 * El adaptador manda (`cacheWriteInputTokens`: el de Anthropic lo lee; el de
 * OpenAI lo leerá con la unidad del catálogo de 2026); si no lo trae, la
 * respuesta cruda. Una respuesta con iteraciones de compactación es un ERROR:
 * ningún brazo manda compactación, así que su presencia es una configuración
 * inesperada y el coste de arriba no sería el total.
 */
export function escriturasDeLlamada(resp: Pick<ProviderResponse, "usage" | "raw">): EscriturasDeLlamada {
  const { compactacion, ...escrituras } = leerEscrituras(resp);
  if (compactacion) throw new Error(MENSAJE_DE_COMPACTACION);
  return escrituras;
}

export const MENSAJE_DE_COMPACTACION =
  "the provider reported a compaction iteration (usage.iterations): no arm sends compaction, and the top-level " +
  "usage would not be the billed total. The run stops instead of pricing it.";

/**
 * Lo mismo sin lanzar: para el contador de gasto, que vive DENTRO de la capa
 * (brazo B) y no debe convertir un fallo del banco en un error del proveedor
 * que la capa podría tratar a su manera. Quien lo usa comprueba `compactacion`
 * fuera de la capa y para la tirada allí.
 */
export function leerEscrituras(resp: Pick<ProviderResponse, "usage" | "raw">): EscriturasDeLlamada & { compactacion: boolean } {
  const crudo = usoCrudo(resp.raw);
  const compactacion = crudo.iteracionesDeCompactacion;
  const delAdaptador = resp.usage.cacheWriteInputTokens;
  if (typeof delAdaptador === "number") return { escrituras: delAdaptador, informada: true, fuente: "adapter", compactacion };
  if (crudo.escrituraInformada) return { escrituras: crudo.escrituraCache, informada: true, fuente: "raw-usage", compactacion };
  return { escrituras: 0, informada: false, fuente: "none", compactacion };
}

export interface UsoFacturable {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/**
 * (entrada − leída − escrita)·in + leída·inCacheada + escrita·in·prima + salida·out
 *
 * SUPUESTO, y se dice: las escrituras van DENTRO de la entrada total. En
 * Anthropic es seguro: el adaptador suma `cache_creation_input_tokens` a
 * `inputTokens`. En OpenAI se infiere de «unadjusted number of prompt tokens
 * written to cache» y lo confirma la sonda (`cache_write_tokens ≤ prompt_tokens`).
 */
export function costeDeLlamada(precio: CostModel, prima: number, uso: UsoFacturable, escrituras: number): number {
  const leidos = uso.cachedInputTokens ?? 0;
  const escritos = Math.max(0, escrituras);
  const normales = Math.max(0, uso.inputTokens - leidos - escritos);
  return (
    (normales / 1000) * precio.inputPer1k +
    (leidos / 1000) * (precio.cachedInputPer1k ?? precio.inputPer1k) +
    (escritos / 1000) * precio.inputPer1k * prima +
    (uso.outputTokens / 1000) * precio.outputPer1k
  );
}

/**
 * El precio ILUSTRATIVO para un modelo sin fila: la fila de gpt-4o-mini del
 * catálogo, no una cifra tecleada aquí. Solo sirve para correr en seco con
 * `BVSALA_AB_PERMITIR_PRECIO_ILUSTRATIVO=1`; nunca para publicar.
 */
export const PRECIO_ILUSTRATIVO: CostModel = CATALOGO["gpt-4o-mini"]!;

export interface PrecioYPrima {
  precio: CostModel;
  /** El precio sale de la fila del propio modelo en el catálogo. */
  conocido: boolean;
  prima: number;
  /** La clave de catálogo, para publicar la fila en `pricing.table`. */
  clave?: string;
}

/** El precio de lista y la prima de escritura de un modelo. */
export function precioYPrima(model: string): PrecioYPrima {
  const barra = model.lastIndexOf("/");
  const desnudo = barra >= 0 ? model.slice(barra + 1) : model;
  const propio = precioDeListaPropio(model);
  const clave = propio ? claveDeCatalogo(model) : undefined;
  return {
    precio: propio ?? PRECIO_ILUSTRATIVO,
    conocido: propio !== undefined,
    prima: primaDeEscritura(desnudo),
    ...(clave ? { clave } : {}),
  };
}
