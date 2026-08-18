import type { CostModel } from "../tokenizer/accounting.js";

/**
 * LIST PRICES PER MODEL.
 *
 * The layer reports savings in money, and money needs a price. This is the
 * built-in catalogue of published list prices, so the dollar figures mean
 * something without any configuration.
 *
 * ⚠️ A WRONG PRICE HERE IS WORSE THAN NO CATALOGUE. A model that is ABSENT falls
 * back to the illustrative default AND warns, so the customer knows that column
 * is not their invoice. A model that is PRESENT with the wrong price silences
 * that warning and hands over a confident, wrong number. So only models whose
 * published price is known with certainty belong here, and {@link PRECIOS_AL_DIA}
 * records when they were last checked.
 *
 * Prices are USD per 1,000 tokens — the unit of `CostModel` — even though
 * providers publish per million: 1M to 1K is a division by a thousand.
 *
 * `costModels` on the layer config ALWAYS wins over this. A customer with volume
 * discounts, negotiated rates or a different region sets their own and this
 * catalogue stays out of the way.
 */

/** When these prices were last checked against the providers' public rates. */
export const PRECIOS_AL_DIA = "2026-08-13";

/**
 * Key = the model id as the provider publishes it, without a vendor prefix.
 * Lookup tries the exact id, then the id without its provider prefix, then the
 * LONGEST matching prefix — so `gpt-4o-2024-08-06` inherits `gpt-4o` without
 * having to enumerate every dated snapshot.
 */
export const CATALOGO: Readonly<Record<string, CostModel>> = {
  // ── OpenAI ────────────────────────────────────────────────────────────────
  // `cachedInputPer1k`: OpenAI bills cached input at 50% on the 4o/4.1 family.
  // Where it is not documented the field is omitted rather than guessed: without
  // it the accountant treats those tokens as normal input, which is the safe
  // side — it never inflates the reported saving.
  "gpt-4.1":       { inputPer1k: 0.002,   outputPer1k: 0.008,  cachedInputPer1k: 0.0005   },
  "gpt-4.1-mini":  { inputPer1k: 0.0004,  outputPer1k: 0.0016, cachedInputPer1k: 0.0001   },
  "gpt-4.1-nano":  { inputPer1k: 0.0001,  outputPer1k: 0.0004, cachedInputPer1k: 0.000025 },
  "gpt-4o":        { inputPer1k: 0.0025,  outputPer1k: 0.01,   cachedInputPer1k: 0.00125  },
  "gpt-4o-mini":   { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 },
  "gpt-4-turbo":   { inputPer1k: 0.01,    outputPer1k: 0.03 },
  "gpt-4":         { inputPer1k: 0.03,    outputPer1k: 0.06 },
  "gpt-3.5-turbo": { inputPer1k: 0.0005,  outputPer1k: 0.0015 },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  // Anthropic bills a cache read at 10% of the input rate.
  // La familia 4.5 va con SU precio, no heredado de la 4: cada versión menor es
  // otro modelo (Opus 4.5 cuesta 5/25 por MTok, no 15/75). Sonnet 4.5 y Haiku 4.5
  // coinciden en precio con sus 4, pero se listan explícitas para que una
  // instantánea fechada (`claude-sonnet-4-5-20250929`) herede de la 4.5 y no de la
  // 4 — la herencia laxa acertaba por casualidad donde el precio coincidía.
  "claude-opus-4-5":   { inputPer1k: 0.005,  outputPer1k: 0.025, cachedInputPer1k: 0.0005  },
  "claude-opus-4":     { inputPer1k: 0.015,  outputPer1k: 0.075, cachedInputPer1k: 0.0015  },
  "claude-sonnet-4-5": { inputPer1k: 0.003,  outputPer1k: 0.015, cachedInputPer1k: 0.0003  },
  "claude-sonnet-4":   { inputPer1k: 0.003,  outputPer1k: 0.015, cachedInputPer1k: 0.0003  },
  "claude-haiku-4-5":  { inputPer1k: 0.001,  outputPer1k: 0.005, cachedInputPer1k: 0.0001  },
  "claude-3-5-sonnet": { inputPer1k: 0.003,  outputPer1k: 0.015, cachedInputPer1k: 0.0003  },
  "claude-3-5-haiku":  { inputPer1k: 0.0008, outputPer1k: 0.004, cachedInputPer1k: 0.00008 },
  "claude-3-opus":     { inputPer1k: 0.015,  outputPer1k: 0.075, cachedInputPer1k: 0.0015  },
  "claude-3-haiku":    { inputPer1k: 0.00025, outputPer1k: 0.00125, cachedInputPer1k: 0.000025 },

  // Models whose published price is NOT known with certainty stay out on purpose:
  // they fall back to the illustrative default and warn, which is the honest answer.
};

/**
 * Busca una entrada por identificador de modelo: exacto, sin prefijo de
 * proveedor, y por último el prefijo MÁS LARGO que case.
 *
 * ES GENÉRICA PORQUE HAY DOS CATÁLOGOS POR MODELO, no porque quede elegante:
 * éste (precios) y el de deltas de salida medidos del codebook
 * (`constraints/codebook-evidencia.ts`). La segunda copia escrita a mano de esta
 * búsqueda divergiría de la primera —este repo ya pagó dos copias de una cuenta
 * que se separaron— y la divergencia aquí es cara: el corte por separador es lo
 * único que impide que `gpt-4` case con `gpt-4o`, que cuesta doce veces menos.
 *
 * @param model el id tal y como lo pasa el llamante, con o sin prefijo de vendor.
 */
export function buscarPorModelo<T>(
  catalogo: Readonly<Record<string, T>>,
  clavesPorLongitud: readonly string[],
  model: string,
): T | undefined {
  if (!model) return undefined;
  const exacto = catalogo[model];
  if (exacto) return exacto;

  // "openai/gpt-4o-mini" -> "gpt-4o-mini"
  const barra = model.lastIndexOf("/");
  const desnudo = barra >= 0 ? model.slice(barra + 1) : model;
  const porNombre = catalogo[desnudo];
  if (porNombre) return porNombre;

  // Dated snapshots: `gpt-4o-2024-08-06`, `claude-sonnet-4-5-20250929`. Dos cortes,
  // no uno. (1) El siguiente carácter debe ser un separador, o `gpt-4` casaría
  // `gpt-4o`, que cuesta doce veces menos. (2) Tras el separador tiene que empezar
  // un AÑO de cuatro dígitos: eso es una instantánea fechada y hereda; cualquier
  // otra cosa es una VERSIÓN MENOR —`claude-opus-4-5`, `gpt-4.5-preview`,
  // `gpt-4-32k`— que es OTRO modelo con otro precio y NO hereda. Sin el segundo
  // corte, `claude-opus-4-5` heredaba el precio de `claude-opus-4` (el triple del
  // real) en silencio, que es justo el «precio presente y equivocado» que la
  // cabecera declara peor que estar ausente. Es la misma regla que `porInstantanea`
  // en `economics/cascada-de-modelos.ts`, que ya la aplicaba para la cascada.
  for (const clave of clavesPorLongitud) {
    if (!desnudo.startsWith(clave)) continue;
    const siguiente = desnudo.charAt(clave.length);
    if (siguiente !== "-" && siguiente !== "." && siguiente !== "_") continue;
    if (/^\d{4}/.test(desnudo.slice(clave.length + 1))) return catalogo[clave];
  }
  return undefined;
}

/** Claves ordenadas de más larga a más corta, para que gane la más específica. */
export function clavesPorLongitud(catalogo: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(catalogo).sort((a, b) => b.length - a.length);
}

/** Keys longest-first, so the most specific prefix wins: `claude-haiku-4-5`
 *  before `claude-haiku`. */
const CLAVES_POR_LONGITUD = clavesPorLongitud(CATALOGO);

/**
 * The list price for a model, or `undefined` when it is not in the catalogue.
 *
 * @param model the id as the caller passes it, with or without a vendor prefix.
 */
export function precioDeLista(model: string): CostModel | undefined {
  return buscarPorModelo(CATALOGO, CLAVES_POR_LONGITUD, model);
}
