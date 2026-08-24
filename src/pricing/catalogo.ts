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
export const PRECIOS_AL_DIA = "2026-08-24";

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
  "claude-opus-4":     { inputPer1k: 0.015,  outputPer1k: 0.075, cachedInputPer1k: 0.0015  },
  "claude-sonnet-4":   { inputPer1k: 0.003,  outputPer1k: 0.015, cachedInputPer1k: 0.0003  },
  "claude-haiku-4-5":  { inputPer1k: 0.001,  outputPer1k: 0.005, cachedInputPer1k: 0.0001  },
  "claude-3-5-sonnet": { inputPer1k: 0.003,  outputPer1k: 0.015, cachedInputPer1k: 0.0003  },
  "claude-3-5-haiku":  { inputPer1k: 0.0008, outputPer1k: 0.004, cachedInputPer1k: 0.00008 },
  "claude-3-opus":     { inputPer1k: 0.015,  outputPer1k: 0.075, cachedInputPer1k: 0.0015  },
  // Caché a 0.00003 y NO al 10% de la entrada: Claude 3 Haiku era la excepción
  // documentada de Anthropic ($0.03/MTok). La cazó el vigía en su primera
  // corrida (2026-08-23) y se verificó contra la referencia histórica oficial.
  "claude-3-haiku":    { inputPer1k: 0.00025, outputPer1k: 0.00125, cachedInputPer1k: 0.00003 },

  // ── Google (Gemini) ───────────────────────────────────────────────────────
  // Gemini bills an implicit-cache read at 10% of the input rate, with no write
  // premium — checked 2026-08-24 against the AI Gateway's `/models` metadata
  // (`input_cache_read` = input/10 across the whole family). Prices are the
  // ≤200k-context tier; the long-context surcharge is out of scope here, same
  // as OpenAI's priority tiers.
  "gemini-3.7-flash":       { inputPer1k: 0.00075, outputPer1k: 0.00375, cachedInputPer1k: 0.000075 },
  "gemini-3.5-flash":       { inputPer1k: 0.0015,  outputPer1k: 0.009,   cachedInputPer1k: 0.00015  },
  "gemini-3.5-flash-lite":  { inputPer1k: 0.0003,  outputPer1k: 0.0025,  cachedInputPer1k: 0.00003  },
  "gemini-3.1-pro-preview": { inputPer1k: 0.002,   outputPer1k: 0.012,   cachedInputPer1k: 0.0002   },
  "gemini-2.5-pro":         { inputPer1k: 0.00125, outputPer1k: 0.01,    cachedInputPer1k: 0.000125 },
  "gemini-2.5-flash":       { inputPer1k: 0.0003,  outputPer1k: 0.0025,  cachedInputPer1k: 0.00003  },

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

  // Dated snapshots: `gpt-4o-2024-08-06`, `claude-sonnet-4-5-20250929`. The next
  // character must be a separator, or `gpt-4` would match `gpt-4o` — which costs
  // twelve times less — and nobody would notice.
  for (const clave of clavesPorLongitud) {
    if (desnudo.startsWith(clave)) {
      const siguiente = desnudo.charAt(clave.length);
      if (siguiente === "" || siguiente === "-" || siguiente === "." || siguiente === "_") {
        return catalogo[clave];
      }
    }
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
