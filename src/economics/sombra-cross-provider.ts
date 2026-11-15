// LA SOMBRA CROSS-PROVIDER (opt-in): lo que el MISMO uso medido costaría en los
// modelos baratos de OTRO proveedor, a precios de lista versionados.
//
// POR QUÉ EXISTE. El gradiente de precios entre proveedores es enorme (un token
// cacheado en deepseek-flash es ~66× más barato que en claude-sonnet-5, y el
// input off-peak ~13×), pero enrutar a otro proveedor NO es una decisión de
// coste: es cambiar de integración (otra credencial, otro dialecto, otra
// latencia), y hacerlo a espaldas del llamante es exactamente lo que la capa no
// hace. La sombra resuelve el dilema: MIDE lo que habría costado, sin enrutar
// nada. El llamante ve la cifra contra su propio contador y decide él.
//
// ES ARITMÉTICA PURA Y GRATUITA: se computa sobre el contador del proveedor
// (los mismos tokens de entrada, lectura y salida) a los precios de lista del
// catálogo versionado. Sin red, sin llamadas extra, sin riesgo: `basis:
// "shadow"` — nunca entra en `cost.*`, nunca en la comisión, nunca se factura.
// Igual que el informe del modo Measure, es un LÍMITE INFERIOR de la decisión:
// la calidad del modelo barato en ESTA tarea no se ha medido (eso es justo lo
// que la verja de la cascada certifica antes de enrutar de verdad).

import { claveDeCatalogo, precioDeLista } from "../pricing/catalogo.js";
import { roundUsd } from "../tokenizer/accounting.js";

/** Una alternativa evaluada: lo que habría costado el mismo uso. */
export interface AlternativaDeSombra {
  /** El modelo alternativo (id de catálogo, sin prefijo de proveedor). */
  model: string;
  /** El MISMO uso a los precios de lista de este modelo, USD. */
  listPriceUsd: number;
  /** `listPriceUsd / servidoUsd`. <1 ahorra; >1 dice que esta alternativa no es más barata. */
  ratio: number;
}

/** El informe de la sombra: el modelo servido, su coste y las alternativas. */
export interface SombraCrossProvider {
  servido: string;
  /** Lo que de verdad costó esta petición (el `cost.actual` medido de la capa). */
  servidoUsd: number;
  /** Las alternativas del catálogo, de más barata a más cara. */
  alternativas: AlternativaDeSombra[];
  basis: "shadow";
}

/** Los modelos baratos de otros proveedores que la sombra evalúa (id de catálogo). */
export const MODELOS_SOMBRA = ["deepseek-flash", "deepseek-v4-pro", "qwen3.8-flash", "glm-5.3-flash"] as const;

export interface UsoParaSombra {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  /** El coste medido de la petición servida (USD): el denominador de cada ratio. */
  servidoUsd: number;
}

/** El coste del mismo uso a los precios de lista de un modelo, USD. */
function costeDeLista(uso: UsoParaSombra, p: { inputPer1k: number; outputPer1k: number; cachedInputPer1k?: number }): number {
  const escritos = uso.cacheWriteInputTokens ?? 0;
  const leidos = Math.min(uso.cachedInputTokens ?? 0, Math.max(0, uso.inputTokens - escritos));
  const resto = Math.max(0, uso.inputTokens - escritos - leidos);
  return (
    (resto * p.inputPer1k + escritos * p.inputPer1k + leidos * (p.cachedInputPer1k ?? p.inputPer1k) + uso.outputTokens * p.outputPer1k) /
    1000
  );
}

/**
 * Evalúa lo que el uso medido de esta petición habría costado en los modelos
 * baratos de otros proveedores. `null` cuando no hay nada que decir: sin coste
 * servido, sin precios, o sin alternativa distinta del servido.
 *
 * Pura y determinista: misma entrada, mismo informe.
 */
export function sombraCrossProvider(servido: string, uso: UsoParaSombra): SombraCrossProvider | null {
  if (!Number.isFinite(uso.servidoUsd) || uso.servidoUsd <= 0) return null;
  if (uso.inputTokens < 0 || uso.outputTokens < 0) return null;

  // El id de catálogo, sin prefijo de proveedor: es con lo que se comparan las
  // alternativas (el informe se expresa en ids de catálogo).
  const claveServida = claveDeCatalogo(servido) ?? servido;

  const alternativas: AlternativaDeSombra[] = [];
  for (const m of MODELOS_SOMBRA) {
    if (m === claveServida) continue;
    const p = precioDeLista(m);
    if (!p) continue;
    const usd = costeDeLista(uso, p);
    if (!Number.isFinite(usd)) continue;
    alternativas.push({ model: m, listPriceUsd: roundUsd(usd), ratio: roundUsd(usd / uso.servidoUsd) });
  }
  if (alternativas.length === 0) return null;
  alternativas.sort((a, b) => a.listPriceUsd - b.listPriceUsd);

  return { servido: claveServida, servidoUsd: roundUsd(uso.servidoUsd), alternativas, basis: "shadow" };
}
