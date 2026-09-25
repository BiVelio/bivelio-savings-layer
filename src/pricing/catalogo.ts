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
export const PRECIOS_AL_DIA = "2026-09-25";

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

  // La familia gpt-5 (checked 2026-08-24 against the AI Gateway's `/models`).
  // Cache reads bill at 10% of input here — not the 50% of the 4o family.
  // EVERY visible `gpt-5.x` is listed explicitly on purpose: the separator
  // guard treats `.` as a separator, so a missing `gpt-5.7` would silently
  // inherit `gpt-5`'s price instead of warning — and 5.2/5.4/5.5 already
  // proved the price MOVES between minor versions.
  "gpt-5":              { inputPer1k: 0.00125,  outputPer1k: 0.01,     cachedInputPer1k: 0.000125  },
  "gpt-5-codex":        { inputPer1k: 0.00125,  outputPer1k: 0.01,     cachedInputPer1k: 0.000125  },
  "gpt-5-mini":         { inputPer1k: 0.00025,  outputPer1k: 0.002,    cachedInputPer1k: 0.000025  },
  "gpt-5-nano":         { inputPer1k: 0.00005,  outputPer1k: 0.0004,   cachedInputPer1k: 0.000005  },
  "gpt-5.1-codex":      { inputPer1k: 0.00125,  outputPer1k: 0.01,     cachedInputPer1k: 0.000125  },
  "gpt-5.1-codex-max":  { inputPer1k: 0.00125,  outputPer1k: 0.01,     cachedInputPer1k: 0.000125  },
  "gpt-5.1-codex-mini": { inputPer1k: 0.00025,  outputPer1k: 0.002,    cachedInputPer1k: 0.000025  },
  "gpt-5.1-thinking":   { inputPer1k: 0.00125,  outputPer1k: 0.01,     cachedInputPer1k: 0.000125  },
  "gpt-5.2":            { inputPer1k: 0.00175,  outputPer1k: 0.014,    cachedInputPer1k: 0.000175  },
  "gpt-5.2-codex":      { inputPer1k: 0.00175,  outputPer1k: 0.014,    cachedInputPer1k: 0.000175  },
  "gpt-5.3-codex":      { inputPer1k: 0.00175,  outputPer1k: 0.014,    cachedInputPer1k: 0.000175  },
  "gpt-5.4":            { inputPer1k: 0.0025,   outputPer1k: 0.015,    cachedInputPer1k: 0.00025   },
  "gpt-5.4-mini":       { inputPer1k: 0.00075,  outputPer1k: 0.0045,   cachedInputPer1k: 0.000075  },
  "gpt-5.4-nano":       { inputPer1k: 0.0002,   outputPer1k: 0.00125,  cachedInputPer1k: 0.00002   },
  "gpt-5.5":            { inputPer1k: 0.005,    outputPer1k: 0.03,     cachedInputPer1k: 0.0005    },
  "gpt-5.6-luna":       { inputPer1k: 0.0002,   outputPer1k: 0.0012,   cachedInputPer1k: 0.00002   },
  // sol: la pasarela servía $2/$10 y la página oficial de OpenAI dice $4/$20 —
  // el vigía cazó el 2x en su segunda corrida (2026-08-24) y manda la oficial.
  "gpt-5.6-sol":        { inputPer1k: 0.004,    outputPer1k: 0.02,     cachedInputPer1k: 0.0004    },
  "gpt-5.6-terra":      { inputPer1k: 0.002,    outputPer1k: 0.012,    cachedInputPer1k: 0.0002    },

  // La serie o (razonamiento). Verificada el 2026-09-25 contra la página oficial
  // de precios de OpenAI (developers.openai.com/api/docs/pricing, tabla
  // «Standard», USD por 1M: o3 $2 / $0.50 / $8; o3-mini $1.10 / $0.55 / $4.40;
  // o4-mini $1.10 / $0.275 / $4.40; o3-pro $20 / sin precio cacheado / $80) y,
  // el mismo día, contra la referencia del vigía (scripts/vigia-precios.mjs:
  // model_prices_and_context_window.json de BerriAI/litellm), que da las mismas
  // cifras. o3-pro NO lleva precio de lectura porque la tabla oficial no lo
  // publica: sin él, sus tokens cacheados se tarifan a entrada, el lado que no
  // infla nada.
  //
  // Lo que se queda FUERA a propósito, aunque el tokenizador lo mapee a o200k:
  //   · o1: la tabla oficial dice $15 / $7.50 / $60, pero su lectura de caché
  //     (0,0075 por 1K) está por ENCIMA del techo con el que el ingest acota el
  //     dinero a precio de lectura (TECHO_PRECIO_LECTURA_PER_1K = 0,002,
  //     apps/web/lib/metering/techo-precio-lectura.ts). Meterla obliga a subir
  //     ese techo para TODOS los modelos —una verja más floja— o a degradar sus
  //     referencias legítimas. Es decisión del dueño, no de una fila.
  //   · o1-pro ($150 / $600): su salida supera el techo de salida del mismo
  //     ingest (0,08 por 1K). Mismo motivo.
  //   · o1-mini: ya no figura en la tabla oficial ni en la referencia del vigía.
  //     Sin fuente no hay fila.
  // Ninguna de las tres puede heredar de otra fila (no existe clave `o1`), así
  // que siguen sin precio y el gateway lo dice en su log.
  "o3":      { inputPer1k: 0.002,  outputPer1k: 0.008,  cachedInputPer1k: 0.0005   },
  "o3-mini": { inputPer1k: 0.0011, outputPer1k: 0.0044, cachedInputPer1k: 0.00055  },
  "o3-pro":  { inputPer1k: 0.02,   outputPer1k: 0.08 },
  "o4-mini": { inputPer1k: 0.0011, outputPer1k: 0.0044, cachedInputPer1k: 0.000275 },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  // Anthropic bills a cache read at 10% of the input rate.
  //
  // The 4.5+ Opus generation is listed EXPLICITLY because prefix inheritance
  // here is a 3x LIE: `claude-opus-4-5` would inherit `claude-opus-4`'s
  // $15/$75 while the whole 4.5–5 generation bills $5/$25 (checked 2026-08-24
  // against the AI Gateway's `/models`; matches Anthropic's published cut).
  // This is exactly the traffic a `bvsala claude` gateway meters, so the
  // wrong price would land straight on a customer's panel.
  "claude-opus-4-5":   { inputPer1k: 0.005,  outputPer1k: 0.025, cachedInputPer1k: 0.0005  },
  "claude-opus-4-6":   { inputPer1k: 0.005,  outputPer1k: 0.025, cachedInputPer1k: 0.0005  },
  "claude-opus-4-7":   { inputPer1k: 0.005,  outputPer1k: 0.025, cachedInputPer1k: 0.0005  },
  "claude-opus-4-8":   { inputPer1k: 0.005,  outputPer1k: 0.025, cachedInputPer1k: 0.0005  },
  "claude-opus-5":     { inputPer1k: 0.005,  outputPer1k: 0.025, cachedInputPer1k: 0.0005  },
  "claude-opus-4":     { inputPer1k: 0.015,  outputPer1k: 0.075, cachedInputPer1k: 0.0015  },
  "claude-sonnet-4-5": { inputPer1k: 0.003,  outputPer1k: 0.015, cachedInputPer1k: 0.0003  },
  "claude-sonnet-4-6": { inputPer1k: 0.003,  outputPer1k: 0.015, cachedInputPer1k: 0.0003  },
  "claude-sonnet-5":   { inputPer1k: 0.002,  outputPer1k: 0.01,  cachedInputPer1k: 0.0002  },
  "claude-fable-5":    { inputPer1k: 0.01,   outputPer1k: 0.05,  cachedInputPer1k: 0.001   },
  // La generación 5.1 de Fable/Mythos factura la LECTURA de caché a 0.025x de
  // la entrada, no al 10% de la casa ($0.25/MTok con entrada a $10) — verificado
  // 2026-09-06 contra la página oficial de prompt caching de Anthropic. Sin
  // estas filas el tráfico 5.1 caería al respaldo ilustrativo (la herencia por
  // versión menor corta a propósito), y con una fila «heredada» del 10% se
  // mediría la lectura 4x más cara de lo real — directo al panel del cliente.
  "claude-fable-5-1":  { inputPer1k: 0.01,   outputPer1k: 0.05,  cachedInputPer1k: 0.00025 },
  "claude-mythos-5-1": { inputPer1k: 0.01,   outputPer1k: 0.05,  cachedInputPer1k: 0.00025 },
  // Mythos 5 comparte lista con Fable 5 (misma tabla oficial): lectura al 10%.
  "claude-mythos-5":   { inputPer1k: 0.01,   outputPer1k: 0.05,  cachedInputPer1k: 0.001   },
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

  // Dated snapshots: `gpt-4o-2024-08-06`, `claude-sonnet-4-5-20250929`. DOS
  // cortes, no uno.
  //
  // (1) El siguiente carácter debe ser un separador, o `gpt-4` casaría `gpt-4o`,
  //     que cuesta doce veces menos, y nadie se enteraría.
  //
  // (2) Y lo que viene DESPUÉS del separador decide si esto es una instantánea
  //     de ESTE modelo o directamente OTRO modelo:
  //       · empieza por LETRA  → alias o variante (`-latest`, `-preview`): es el
  //         mismo modelo con otro nombre, hereda.
  //       · empieza por DÍGITO → o es una FECHA (cuatro o más dígitos seguidos:
  //         `20250929`, `2024-08-06`), que hereda, o es una VERSIÓN MENOR
  //         (`-4-9`, `.5-preview`, `-32k`), que es otro modelo con otro precio y
  //         NO puede heredar.
  //
  // Sin el corte (2), un `claude-opus-4-9` que Anthropic saque mañana heredaría
  // en silencio el 0,015/0,075 de `claude-opus-4` — el TRIPLE del precio real de
  // la familia 4.5 (0,005/0,025). Y un precio inflado no se cancela en el
  // cociente: el ahorro en euros sale 3x, y la comisión se calcula sobre euros.
  // Medido contra el catálogo de hoy: `claude-opus-4-9` → 0,015 antes de esto.
  //
  // Enumerar modelos (lo que hizo #116) tapa los que ya existen; esto tapa los
  // que aún no. La regla del PR #95 original exigía año SIEMPRE, y por eso
  // rompía `claude-3-5-sonnet-latest` y `gpt-5-chat-latest`, que hoy heredan
  // BIEN. Un modelo sin precio cae al respaldo ilustrativo, que se declara; un
  // modelo con precio EQUIVOCADO no se declara, y es lo que hay que evitar.
  for (const clave of clavesPorLongitud) {
    if (!desnudo.startsWith(clave)) continue;
    const siguiente = desnudo.charAt(clave.length);
    if (siguiente !== "" && siguiente !== "-" && siguiente !== "." && siguiente !== "_") continue;
    const resto = desnudo.slice(clave.length + 1);
    if (/^\d/.test(resto) && !/^\d{4}/.test(resto)) continue;
    return catalogo[clave];
  }
  return undefined;
}

/** Claves ordenadas de más larga a más corta, para que gane la más específica. */
export function clavesPorLongitud(catalogo: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(catalogo).sort((a, b) => b.length - a.length);
}

/**
 * Ids que NO pueden heredar la fila de un pariente por prefijo, aunque el
 * emparejador se la daría: son OTRO modelo con otro precio y ninguna fuente
 * citable lo publica hoy. Sin esta lista, `o3-deep-research` heredaría la fila
 * de `o3` (un sufijo de letra es «alias» para `buscarPorModelo`) y se tarifaría
 * a un quinto de lo que factura, con el aviso de «sin precio» callado. Aquí dan
 * `undefined`, que es la respuesta honesta: se reenvían y se dice que no se
 * miden. Interno: la tabla pública sigue siendo `CATALOGO`.
 */
const SIN_FILA_PROPIA: readonly string[] = ["o3-deep-research", "o4-mini-deep-research"];

/** El catálogo con las ids vetadas a null: lo que de verdad consulta la búsqueda. */
const TABLA_DE_BUSQUEDA: Readonly<Record<string, CostModel | null>> = {
  ...CATALOGO,
  ...Object.fromEntries(SIN_FILA_PROPIA.map((k) => [k, null])),
};

/** Keys longest-first, so the most specific prefix wins: `claude-haiku-4-5`
 *  before `claude-haiku`. */
const CLAVES_POR_LONGITUD = clavesPorLongitud(TABLA_DE_BUSQUEDA);

/**
 * The list price for a model, or `undefined` when it is not in the catalogue.
 *
 * @param model the id as the caller passes it, with or without a vendor prefix.
 */
export function precioDeLista(model: string): CostModel | undefined {
  return buscarPorModelo(TABLA_DE_BUSQUEDA, CLAVES_POR_LONGITUD, model) ?? undefined;
}

/** Catálogo de identidad: cada clave apuntando a sí misma (y las vetadas a null). Se calcula UNA vez. */
const CLAVES_IDENTIDAD: Readonly<Record<string, string | null>> = Object.fromEntries(
  Object.keys(TABLA_DE_BUSQUEDA).map((k) => [k, TABLA_DE_BUSQUEDA[k] === null ? null : k]),
);

/**
 * La CLAVE de catálogo de un modelo — no su precio.
 *
 * Existe para que cualquier tabla indexada POR MODELO (hoy la aptitud de
 * elisión, `pricing/aptitud-de-elision.ts`) use el mismo emparejador que los
 * precios en vez de escribir el suyo. Ya hay tres copias a mano de esta
 * búsqueda en el repo, y la cabecera de `buscarPorModelo` explica por qué la
 * cuarta sería cara: el corte por separador es lo único que impide que
 * `gpt-4` case con `gpt-4o`, que cuesta doce veces menos.
 *
 * Comportamiento que importa, y que los tests fijan:
 *   claveDeCatalogo("claude-haiku-4-5-20251001") === "claude-haiku-4-5"
 *   claveDeCatalogo("claude-fable-5-1")          === "claude-fable-5-1"  (NUNCA "claude-fable-5")
 *   claveDeCatalogo("claude-fable-6")            === undefined
 *
 * Ese segundo caso es el que evita repetir el error que ya costó dinero aquí:
 * las dos generaciones de la familia leen la caché a precios distintos
 * (0,001 frente a 0,00025) y confundirlas mueve el veredicto de una palanca.
 */
export function claveDeCatalogo(model: string): string | undefined {
  return buscarPorModelo(CLAVES_IDENTIDAD, CLAVES_POR_LONGITUD, model) ?? undefined;
}

/** Lo único que puede seguir a la clave para que el id sea el MISMO modelo:
 *  una fecha de instantánea, `2024-07-18` (OpenAI) o `20250929` (Anthropic). */
const FECHA_DE_INSTANTANEA = /^\d{4}-?\d{2}-?\d{2}$/;

/**
 * El precio de lista de un modelo SOLO si es SU fila del catálogo: el id es la
 * clave (con o sin prefijo de proveedor) o una instantánea con fecha de ella.
 *
 * `precioDeLista` deja que un id con sufijo de LETRA herede la fila de su
 * pariente (`-latest`, `-preview`), porque para TARIFAR un informe una cifra
 * aproximada vale más que el precio ilustrativo. Para la referencia no: el
 * sufijo también puede ser otro modelo más barato. `gemini-2.5-flash-lite`
 * heredaba la fila de `gemini-2.5-flash`, y una repetición suya se valoraba al
 * triple de su entrada cacheada real y a unas seis veces su salida: un crédito
 * 2,4 veces mayor que la llamada que reemplazaba, dentro de la base de
 * comisión. Una referencia es un suelo o no es nada, así que cualquier id que no
 * sea exactamente la fila da `undefined` y L6 lo rechaza (`no-cached-price`).
 * El alias legítimo que se pierde (`-latest`) solo cuesta que su repetición
 * siga `estimated`; el cliente lo recupera declarando `costModels`.
 *
 * Vive aquí, y no en src/pipeline/referencia.ts (que la reexporta), porque el
 * gateway valora su gemela coalescida con la MISMA regla (Parte G) y no puede
 * importar del pipeline. Interno: src/index.ts no la reexporta.
 */
export function precioDeListaPropio(model: string): CostModel | undefined {
  const clave = claveDeCatalogo(model);
  if (clave === undefined) return undefined;
  const barra = model.lastIndexOf("/");
  const desnudo = barra >= 0 ? model.slice(barra + 1) : model;
  if (clave !== model && clave !== desnudo) {
    // `buscarPorModelo` ya garantiza que tras la clave viene un separador.
    if (!FECHA_DE_INSTANTANEA.test(desnudo.slice(clave.length + 1))) return undefined;
  }
  return CATALOGO[clave];
}
