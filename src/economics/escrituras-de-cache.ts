import type { CacheTier } from "./cache-tier.js";
import { PRECIOS_AL_DIA, precioDeListaPropio } from "../pricing/catalogo.js";
import { primaDeEscritura } from "../pricing/primas.js";
import {
  familiaDeTarifa,
  idDesnudo,
  type OrigenDeTarifa,
  type TarifaPlana,
} from "../pricing/tarifas-de-tier.js";
import { redondearHaciaAbajo } from "./tier-diferido.js";

// PETICIONES «STANDALONE»: DÓNDE ESCRIBE SU CACHÉ EL PROVEEDOR.
//
// Interno (comentarios en `//`, nadie lo reexporta). Fuentes, leídas el
// 2026-09-27:
//   · Guía de prompt caching de OpenAI
//     (developers.openai.com/api/docs/guides/prompt-caching):
//       «For GPT-5.6 and later, cache writes cost 1.25× the standard, uncached
//       input-token rate.»
//       Implícito (el defecto): «OpenAI places a breakpoint at the end of the
//       latest eligible message» — o sea, al final de la PREGUNTA.
//       Explícito: «When no explicit breakpoints are placed, the request does not
//       use prompt caching or create cache writes», y «Content after the last
//       selected breakpoint is processed at the uncached input-token rate without
//       a cache-write charge».
//       La cuenta que la propia guía publica: `ordinary_input_tokens =
//       input_tokens - cached_tokens - cache_write_tokens`.
//   · openai-node, src/resources/chat/completions/completions.ts: Chat
//     Completions acepta `prompt_cache_options: { mode: 'implicit' | 'explicit',
//     ttl?: '30m' }` («Supported for `gpt-5.6` and later models») y
//     `prompt_cache_breakpoint: { mode: 'explicit' }` en
//     `ChatCompletionContentPartText`; el uso trae
//     `prompt_tokens_details.cache_write_tokens`.
//
// ── EL HUECO ────────────────────────────────────────────────────────────────
//
// En modo implícito una petición de UN SOLO USO escribe TODO su prompt a 1,25x
// —el punto de ruptura cae al final de la pregunta— y nadie lo vuelve a leer.
// Con modo explícito y un punto en la frontera del prefijo estable, se escribe
// solo lo que sí se repite (el sistema compartido) y la pregunta va a tarifa
// normal sin prima.
//
// ── POR QUÉ ES DECLARADO Y NO INFERIDO ──────────────────────────────────────
//
// En una CONVERSACIÓN pierde dinero: el turno siguiente ya no encontraría
// escrita la pregunta de éste, y cada mensaje de usuario pagaría 1,0 (ahora) +
// 1,25 (reescrito en el turno siguiente) en vez de 1,25 + 0,10. El equilibrio de
// continuación está en p < 0,217 (el mismo 0,25/1,15 de la verja de prefijo).
// Solo el cliente sabe si va a continuar una petición, así que lo declara él
// (`savings.standalone`) y la capa nunca lo supone.
//
// ── POR QUÉ SIEMPRE `estimated` ─────────────────────────────────────────────
//
// Cambia QUÉ tokens se escriben —otro vector de uso— y el modo implícito no se
// ejecutó. No hay contador del proveedor del contrafactual, así que no hay
// resta de dos tarifas sobre el mismo conteo: hay una estimación. Tampoco resta
// las lecturas que el modo implícito habría podido dar en una repetición: es la
// PRIMA EVITADA, y el nombre del campo lo dice.

/** El mínimo cacheable de GPT-5.6 en adelante: «1,024 visible input tokens». */
export const MINIMO_CACHEABLE_EXPLICITO = 1024;

/**
 * ¿Actúa el modo explícito para este modelo en este origen? Solo en el API de
 * OpenAI atestiguado y solo con prima de escritura (> 1). Se extiende sola a
 * GPT-6 cuando `primaDeEscritura` (un solo domicilio: pricing/primas.ts) lo haga.
 *
 * El id se desnuda ANTES de preguntar la prima: `primaDeEscritura` no conoce el
 * prefijo `openai/` y le daría a `openai/gpt-5.4` la prima de Anthropic. Y se
 * exige la familia de OpenAI por el nombre, por la misma razón: la prima por
 * defecto de `primaDeEscritura` es la de Anthropic.
 */
export function explicitaAplicable(model: string, origen: OrigenDeTarifa | null | undefined): boolean {
  return (
    origen === "openai" &&
    familiaDeTarifa(idDesnudo(model)) === "openai" &&
    primaDeEscritura(idDesnudo(model)) > 1
  );
}

/**
 * El tramo con el que la verja de prefijo decide si poner el punto explícito:
 * lectura = cacheada/entrada de la fila PROPIA, escritura = la prima. `null` sin
 * fila propia: sin precio no se decide dinero.
 */
export function tramoParaDecidirExplicita(model: string): CacheTier | null {
  const fila = precioDeListaPropio(model);
  if (!fila || !(fila.inputPer1k > 0)) return null;
  const lectura = (fila.cachedInputPer1k ?? fila.inputPer1k) / fila.inputPer1k;
  return {
    minimumCacheTokens: MINIMO_CACHEABLE_EXPLICITO,
    cacheReadMultiplier: lectura,
    cacheWriteMultiplier: primaDeEscritura(idDesnudo(model)),
  };
}

/** Lo que vale la prima de escritura que el modo explícito no pagó. */
export interface PrimaEvitada {
  importe: number;
  /** Los tokens ordinarios a tarifa de escritura: lo que habría costado el implícito. */
  costeEstandar: number;
  /** Los mismos tokens a tarifa de entrada: lo que costaron. */
  costeAplicado: number;
  tokensOrdinarios: number;
  consultado: string;
}

/**
 * La prima evitada: tokens ordinarios (`input − cached − writes`) por
 * (escritura − entrada) de la fila APLICADA (la del tier servido si lo hubo, la
 * estándar si no). 0 por debajo del mínimo cacheable, donde el implícito
 * tampoco habría escrito nada.
 */
export function valorarEscriturasEvitadas(e: {
  uso: { inputTokens: number; cachedInputTokens?: number; cacheWriteInputTokens?: number };
  fila: Required<Pick<TarifaPlana, "inputPer1k" | "cacheWritePer1k">>;
  consultado?: string;
}): PrimaEvitada {
  const consultado = e.consultado ?? PRECIOS_AL_DIA;
  const entrada = Math.max(0, e.uso.inputTokens);
  const cacheados = Math.min(Math.max(0, e.uso.cachedInputTokens ?? 0), entrada);
  const escritos = Math.min(Math.max(0, e.uso.cacheWriteInputTokens ?? 0), entrada - cacheados);
  const ordinarios = entrada - cacheados - escritos;
  if (entrada < MINIMO_CACHEABLE_EXPLICITO || ordinarios <= 0) {
    return { importe: 0, costeEstandar: 0, costeAplicado: 0, tokensOrdinarios: Math.max(0, ordinarios), consultado };
  }
  const costeEstandar = (ordinarios / 1000) * e.fila.cacheWritePer1k;
  const costeAplicado = (ordinarios / 1000) * e.fila.inputPer1k;
  return {
    importe: redondearHaciaAbajo(costeEstandar - costeAplicado),
    costeEstandar,
    costeAplicado,
    tokensOrdinarios: ordinarios,
    consultado,
  };
}
