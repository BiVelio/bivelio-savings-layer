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
export const PRECIOS_AL_DIA = "2026-09-27";

/**
 * Key = the model id as the provider publishes it, without a vendor prefix.
 * Lookup tries the exact id, then the id without its provider prefix, then the
 * LONGEST matching prefix — so `gpt-4o-2024-08-06` inherits `gpt-4o` without
 * having to enumerate every dated snapshot.
 *
 * These are the rows in force on {@link PRECIOS_AL_DIA}. A price change a
 * provider has already announced is applied by {@link precioDeLista} from its
 * effective date, so a request is always priced at the rate of its own day.
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

  // Revisión del 2026-09-27 contra la tabla «Standard» OFICIAL
  // (https://developers.openai.com/api/docs/pricing): gpt-4.1, 4.1-mini,
  // 4.1-nano, 4o, 4o-mini, gpt-4-turbo (-2024-04-09), gpt-4 (-0613),
  // gpt-3.5-turbo, gpt-5, 5-mini, 5-nano, 5.2, 5.3-codex, 5.4, 5.4-mini,
  // 5.4-nano, 5.5, la familia 5.6 y la serie o coinciden con sus filas. Las
  // codex de 5, 5.1 y 5.2 y gpt-5.1-thinking ya no figuran en esa tabla:
  // conservan su verificación anterior.
  //
  // Fuera a propósito, aunque la página los publica: los pro (gpt-5-pro a
  // gpt-5.5-pro, salida de $120 a $180 por 1M: pasan el techo de salida del
  // ingest, como o1-pro) y los de la tabla aparte «Cyber models» (gpt-5.5-cyber
  // y gpt-5.6-cyber, $12.50 / $1.25 / $75; el changelog oficial dice que su
  // acceso se aprueba aparte, por el programa Daybreak Red). Ninguno lleva fila
  // y los que heredarían la de su pariente están vetados en SIN_FILA_PROPIA,
  // más abajo: caen al respaldo ilustrativo, que avisa.
  //
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
  // (Revisadas el 2026-09-27 contra la tabla «Standard» oficial: 5.6-luna
  // $0.20 / $0.02 / $1.20, 5.6-terra $2 / $0.20 / $12, 5.6-sol $4 / $0.40 /
  // $20. El changelog de OpenAI dice que el precio de 5.6-sol es PROMOCIONAL
  // «at least through November 21, 2026» sin anunciar el siguiente: no hay
  // fecha de fin que poner en su vigencia, y cuando la haya se añade el tramo.)

  // La familia gpt-6. Verificada el 2026-09-27 contra la página OFICIAL de
  // precios de OpenAI (https://developers.openai.com/api/docs/pricing, tabla
  // «Standard», columnas de contexto corto, USD por 1M): astra $10 / $1.00 /
  // $50; sol $2 / $0.20 / $10; luna $0.10 / $0.01 / $0.50 (entrada / entrada
  // cacheada / salida). La misma tabla publica la escritura de caché a 1,25×
  // la entrada ($12.50 / $2.50 / $0.125), que NO va en la fila: la pone
  // `primaDeEscritura` (primas.ts), igual que en gpt-5.6. Lanzamientos según
  // el changelog oficial (https://developers.openai.com/api/docs/changelog,
  // consultado el 2026-09-27): astra el 2026-09-03, sol y luna el 2026-09-22.
  // Fuera de la fila, como en gpt-5.5: por encima de 272K tokens de entrada
  // OpenAI cobra la petición ENTERA a 2× entrada y caché y 1,5× salida
  // (https://developers.openai.com/api/docs/models/gpt-6-luna). Tarifar ese
  // tramo al precio corto infra-mide los dos lados por igual; no infla nada.
  "gpt-6-astra":        { inputPer1k: 0.01,     outputPer1k: 0.05,     cachedInputPer1k: 0.001     },
  "gpt-6-sol":          { inputPer1k: 0.002,    outputPer1k: 0.01,     cachedInputPer1k: 0.0002    },
  "gpt-6-luna":         { inputPer1k: 0.0001,   outputPer1k: 0.0005,   cachedInputPer1k: 0.00001   },

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
  //   · o1: la tabla oficial dice $15 / $7.50 / $60 (hay fuente), pero su
  //     lectura de caché (0,0075 por 1K) supera TECHO_PRECIO_LECTURA_PER_1K
  //     (0,002, apps/web/lib/metering/techo-precio-lectura.ts), y el invariante
  //     de techo-precio-lectura.test.ts exige que ese techo sea ≥ el MAYOR
  //     cachedInputPer1k de este catálogo. Ese techo es además el recorte del
  //     suelo de la elisión que impide tarifar un borrado de Anthropic a precio
  //     de entrada. Con la fila, o se sube el techo para TODOS (verja más
  //     floja) o se rompe el invariante. Sin subirlo, o1 se podría MEDIR igual
  //     (los registros medidos no tienen techo) y sus referencias fuera de techo
  //     se degradarían a estimated, no darían un 400: es decisión del dueño.
  //   · o1-pro ($150 / $600): su salida supera TECHO_PRECIO_SALIDA_PER_1K (0,08
  //     por 1K) y su invariante gemelo en el mismo test. Mismo motivo.
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
  // Toda fila de la generación 4.5 en adelante (Opus 4.5–5.5, Sonnet 4.5–5,
  // Haiku 4.5, Fable/Mythos 5 y 5.1) y Opus 4, Sonnet 4 y Haiku 3.5 se
  // revisaron el 2026-09-27 contra la tabla oficial
  // (https://platform.claude.com/docs/en/about-claude/pricing) y coinciden.
  // Sonnet 5 sigue a $2/$10: la nota 3 de esa tabla dice que el precio de
  // lanzamiento pasó a ser el estándar y la subida a $3/$15 del 2026-09-01 no
  // ocurre. Claude 3.5 Sonnet, 3 Opus y 3 Haiku ya no figuran en esa tabla:
  // conservan su verificación anterior.
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
  // Opus 5.5 NO comparte lista con Opus 5: $4 de entrada, $20 de salida y la
  // LECTURA de caché a 0,05× de la entrada ($0.20/MTok, nota 2 de la tabla),
  // ni el 10% de la casa ni el 0,025× de Fable 5.1. Verificado el 2026-09-27
  // contra la página OFICIAL de precios de Anthropic
  // (https://platform.claude.com/docs/en/about-claude/pricing: «Claude Opus
  // 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok»; las
  // escrituras de 5 min y 1 h son 1,25× y 2×, las de `primas.ts`). Sin esta
  // fila el tráfico de Opus 5.5 caía al respaldo ilustrativo (la herencia por
  // versión menor corta `claude-opus-5-5` → `claude-opus-5` a propósito), y
  // con la de Opus 5 se habría medido un 25% más cara de entrada y salida y
  // 2,5 veces más cara de lectura.
  "claude-opus-5-5":   { inputPer1k: 0.004,  outputPer1k: 0.02,  cachedInputPer1k: 0.0002  },
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
  //
  // Revisado el 2026-09-27 contra la página OFICIAL de precios de Gemini
  // (https://ai.google.dev/gemini-api/docs/pricing, tier de pago «Standard»,
  // USD por 1M, precio de texto): las filas de abajo coinciden, y la página
  // ANUNCIA que 3.6, 3.7 y 3.8 Flash doblan su precio el 2027-01-01 («$0.75
  // through December 31, 2026. $1.50 starting January 1, 2027»; salida $3.75 →
  // $7.50; caché $0.075 → $0.15). Esas tres filas llevan su `vigenteHasta` en
  // VIGENCIA_DE_FILA y el tramo nuevo en TRAMOS_ANUNCIADOS, más abajo: cada
  // petición se tarifa con el precio de SU fecha.
  //   · 3.8 Flash y 3.6 Flash: $0.75 / $3.75 / $0.075 hasta el 2026-12-31.
  //   · 3.1 Flash-Lite: $0.25 / $1.50 / $0.025 (texto; el audio va aparte).
  //   · 3 Flash Preview: $0.50 / $3.00 / $0.05 (texto; el audio va aparte).
  "gemini-3.8-flash":       { inputPer1k: 0.00075, outputPer1k: 0.00375, cachedInputPer1k: 0.000075 },
  "gemini-3.7-flash":       { inputPer1k: 0.00075, outputPer1k: 0.00375, cachedInputPer1k: 0.000075 },
  "gemini-3.6-flash":       { inputPer1k: 0.00075, outputPer1k: 0.00375, cachedInputPer1k: 0.000075 },
  "gemini-3.1-flash-lite":  { inputPer1k: 0.00025, outputPer1k: 0.0015,  cachedInputPer1k: 0.000025 },
  "gemini-3-flash-preview": { inputPer1k: 0.0005,  outputPer1k: 0.003,   cachedInputPer1k: 0.00005  },
  "gemini-3.5-flash":       { inputPer1k: 0.0015,  outputPer1k: 0.009,   cachedInputPer1k: 0.00015  },
  "gemini-3.5-flash-lite":  { inputPer1k: 0.0003,  outputPer1k: 0.0025,  cachedInputPer1k: 0.00003  },
  "gemini-3.1-pro-preview": { inputPer1k: 0.002,   outputPer1k: 0.012,   cachedInputPer1k: 0.0002   },
  "gemini-2.5-pro":         { inputPer1k: 0.00125, outputPer1k: 0.01,    cachedInputPer1k: 0.000125 },
  "gemini-2.5-flash":       { inputPer1k: 0.0003,  outputPer1k: 0.0025,  cachedInputPer1k: 0.00003  },

  // Models whose published price is NOT known with certainty stay out on purpose:
  // they fall back to the illustrative default and warn, which is the honest answer.
  //
  // DeepSeek (https://api-docs.deepseek.com/quick_start/pricing, consultada el
  // 2026-09-27) publica precio pero el catálogo no cubre la familia, y su
  // tarifa cambia por HORA del día: «Peak hours are 01:00 - 04:00 and 06:00 -
  // 10:00 UTC, Monday through Friday, excluding Chinese public holidays», y
  // «Off-peak rates are half of the peak rates». Una fila por modelo mentiría
  // en una de las dos franjas —a la mitad o al doble, según cuál se pusiera—.
  // Queda fuera hasta que la vigencia sepa de franjas horarias.
};

// ═══════════════════════════════════════════════════════════════════════════
// LA VIGENCIA DE CADA FILA — el precio de la FECHA de la petición.
// ═══════════════════════════════════════════════════════════════════════════
//
// Un precio no es de un modelo: es de un modelo EN UNA FECHA. Google ya ha
// anunciado que Gemini 3.6/3.7/3.8 Flash doblan su precio el 2027-01-01; sin
// fechas, el 1 de enero el catálogo seguiría tarifando a la mitad —baseline y
// real a la vez— y ninguna cifra del informe cuadraría con la factura. Y el día
// que se actualizara la fila, las peticiones de diciembre que aún estuvieran
// por valorar pasarían a tarifarse al precio de enero.
//
// Cada fila de CATALOGO es el precio en vigor el día PRECIOS_AL_DIA. Su
// vigencia vive aquí, en VIGENCIA_DE_FILA, y los precios que el proveedor ya
// ha ANUNCIADO para más adelante en TRAMOS_ANUNCIADOS, cada uno con su
// `vigenteDesde`. La resolución (`precioDeLista(model, at)`) busca el tramo que
// cubre el día de la petición:
//
//   · días UTC `AAAA-MM-DD`; `vigenteDesde` INCLUIDO, `vigenteHasta` EXCLUIDO
//     (el tramo siguiente empieza el mismo día en que el anterior acaba). Los
//     proveedores anuncian el día, no la hora ni el huso: se toma el día UTC, y
//     las pocas horas de desfase posibles el día del cambio quedan dichas aquí.
//   · sin entrada en VIGENCIA_DE_FILA la fila rige sin límite conocido. Las
//     fechas de LANZAMIENTO no se ponen: un modelo no recibe tráfico antes de
//     existir, y un `vigenteDesde` de lanzamiento solo serviría para que un
//     reloj de prueba (el `now` inyectable del pipeline) cayera en el respaldo.
//   · una fila con `vigenteHasta` y sin tramo detrás deja de tener precio ese
//     día: cae al respaldo ilustrativo, que AVISA. Es la respuesta honesta
//     cuando se sabe que el precio cambió y no a cuánto.
//
// Ni la vigencia ni los tramos se exportan desde el paquete: la tabla pública
// sigue siendo CATALOGO. `vigenciasIncoherentes()` es la verja del test.

/**
 * Un tramo de precio: el que rige en [vigenteDesde, vigenteHasta), días UTC
 * `AAAA-MM-DD`. Sin `vigenteDesde`, desde siempre; sin `vigenteHasta`, sin fin
 * conocido.
 */
export interface TramoDePrecio {
  readonly vigenteDesde?: string;
  readonly vigenteHasta?: string;
  readonly precio: CostModel;
}

/** Vigencia de las filas de CATALOGO que tienen fecha de fin anunciada. */
const VIGENCIA_DE_FILA: Readonly<Record<string, { readonly vigenteDesde?: string; readonly vigenteHasta?: string }>> = {
  // https://ai.google.dev/gemini-api/docs/pricing (consultada el 2026-09-27):
  // «$0.75 through December 31, 2026. $1.50 starting January 1, 2027».
  "gemini-3.8-flash": { vigenteHasta: "2027-01-01" },
  "gemini-3.7-flash": { vigenteHasta: "2027-01-01" },
  "gemini-3.6-flash": { vigenteHasta: "2027-01-01" },
};

/**
 * Precios ANUNCIADOS por el proveedor que aún no están en vigor, detrás de la
 * fila de CATALOGO de su modelo. Con la misma forma de fila (`inputPer1k`,
 * `outputPer1k`, `cachedInputPer1k`) para que las verjas que leen este fichero
 * como texto —los techos del ingest— también los vean.
 */
const TRAMOS_ANUNCIADOS: Readonly<Record<string, readonly TramoDePrecio[]>> = {
  // https://ai.google.dev/gemini-api/docs/pricing (consultada el 2026-09-27),
  // tier de pago «Standard», USD por 1M, «starting January 1, 2027»: entrada
  // $1.50, salida $7.50, caché $0.15 — el doble exacto de hoy en las tres.
  "gemini-3.8-flash": [
    { vigenteDesde: "2027-01-01", precio: { inputPer1k: 0.0015, outputPer1k: 0.0075, cachedInputPer1k: 0.00015 } },
  ],
  "gemini-3.7-flash": [
    { vigenteDesde: "2027-01-01", precio: { inputPer1k: 0.0015, outputPer1k: 0.0075, cachedInputPer1k: 0.00015 } },
  ],
  "gemini-3.6-flash": [
    { vigenteDesde: "2027-01-01", precio: { inputPer1k: 0.0015, outputPer1k: 0.0075, cachedInputPer1k: 0.00015 } },
  ],
};

/**
 * Los tramos de cada clave, en orden: la fila de CATALOGO —el MISMO objeto,
 * para que `precioDeLista(k)` siga siendo `CATALOGO[k]` mientras rija— con su
 * vigencia, y detrás los anunciados.
 */
const TRAMOS: Readonly<Record<string, readonly TramoDePrecio[]>> = Object.fromEntries(
  Object.keys(CATALOGO).map((k) => [
    k,
    [{ ...VIGENCIA_DE_FILA[k], precio: CATALOGO[k]! }, ...(TRAMOS_ANUNCIADOS[k] ?? [])] as const,
  ]),
);

/** Los tramos de una clave de catálogo (vacío si no es clave). Interno: para tests y diagnósticos. */
export function tramosDePrecio(clave: string): readonly TramoDePrecio[] {
  return TRAMOS[clave] ?? [];
}

/** El mayor instante que `Date` sabe representar, en ms (±8,64e15). */
const MAX_FECHA_MS = 8.64e15;

/**
 * El día UTC `AAAA-MM-DD` de un instante. Sin instante, o con uno que no es una
 * fecha representable (NaN, ±Infinity), el de ahora: el precio de hoy es el
 * único que se puede defender cuando no se sabe cuándo fue la petición.
 */
export function diaUtc(at?: Date | number): string {
  const ms = at instanceof Date ? at.getTime() : at;
  const t = typeof ms === "number" && Number.isFinite(ms) && Math.abs(ms) <= MAX_FECHA_MS ? ms : Date.now();
  return new Date(t).toISOString().slice(0, 10);
}

/** El precio de una CLAVE de catálogo el día `dia`, o `undefined` si ninguno de sus tramos lo cubre. */
function precioEnDia(clave: string, dia: string): CostModel | undefined {
  for (const t of TRAMOS[clave] ?? []) {
    if (t.vigenteDesde !== undefined && dia < t.vigenteDesde) continue;
    if (t.vigenteHasta !== undefined && dia >= t.vigenteHasta) continue;
    return t.precio;
  }
  return undefined;
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Lo que está mal en la vigencia, como lista de frases (vacía = coherente). La
 * verja del test: una fecha mal escrita o un tramo solapado no rompe nada en
 * tiempo de ejecución —simplemente tarifaría con el tramo equivocado—, así que
 * se para aquí.
 */
export function vigenciasIncoherentes(): string[] {
  const malas: string[] = [];
  for (const k of [...Object.keys(VIGENCIA_DE_FILA), ...Object.keys(TRAMOS_ANUNCIADOS)]) {
    if (!(k in CATALOGO)) malas.push(`${k}: tiene vigencia o tramos pero no es fila de CATALOGO`);
  }
  for (const [k, tramos] of Object.entries(TRAMOS)) {
    tramos.forEach((t, i) => {
      for (const f of [t.vigenteDesde, t.vigenteHasta]) {
        if (f !== undefined && (!DIA.test(f) || diaUtc(Date.parse(`${f}T00:00:00Z`)) !== f)) {
          malas.push(`${k}[${i}]: fecha no válida «${f}»`);
        }
      }
      if (t.vigenteDesde !== undefined && t.vigenteHasta !== undefined && t.vigenteDesde >= t.vigenteHasta) {
        malas.push(`${k}[${i}]: vigenteDesde ${t.vigenteDesde} no es anterior a vigenteHasta ${t.vigenteHasta}`);
      }
      const siguiente = tramos[i + 1];
      if (siguiente) {
        // Contiguos: el tramo siguiente empieza EXACTAMENTE donde acaba este. Un
        // hueco dejaría días sin precio; un solape, dos precios para un día.
        if (t.vigenteHasta === undefined || siguiente.vigenteDesde !== t.vigenteHasta) {
          malas.push(`${k}[${i}→${i + 1}]: los tramos no son contiguos (${t.vigenteHasta ?? "sin fin"} → ${siguiente.vigenteDesde ?? "sin inicio"})`);
        }
      }
    });
  }
  // La fila de CATALOGO es la que rige el día del catálogo: si no, la tabla
  // pública estaría enseñando un precio que ese día no se cobraba.
  for (const k of Object.keys(CATALOGO)) {
    if (precioEnDia(k, PRECIOS_AL_DIA) !== CATALOGO[k]) malas.push(`${k}: la fila de CATALOGO no rige el ${PRECIOS_AL_DIA}`);
  }
  return malas;
}

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
 * emparejador se la daría: son OTRO modelo con otro precio (un sufijo de letra
 * es «alias» para `buscarPorModelo`), y heredar callaría el aviso de «sin
 * precio» con una cifra equivocada. Aquí dan `undefined`, que es la respuesta
 * honesta: se reenvían y se dice que no se miden. El veto alcanza también a sus
 * alias y sus instantáneas (`gpt-5-pro-2025-10-06`, `…-latest`), porque la
 * clave vetada es la más larga que casa. Interno: la tabla pública sigue siendo
 * `CATALOGO`.
 */
const SIN_FILA_PROPIA: readonly string[] = [
  // OpenAI, sin precio publicado: la página oficial no los lista (comprobado el
  // 2026-09-25 y de nuevo el 2026-09-27; la referencia comunitaria del vigía
  // puede listarlos, pero no es la factura de nadie). Sin veto, `o3-deep-research`
  // heredaría `o3` y se tarifaría a un quinto de lo que factura.
  "o3-deep-research",
  "o4-mini-deep-research",

  // OpenAI, CON precio publicado pero distinto del de la fila que heredarían.
  // https://developers.openai.com/api/docs/pricing (consultada el 2026-09-27),
  // USD por 1M, entrada / entrada cacheada / salida:
  //   · tabla «Standard»: gpt-5.5-pro y gpt-5.4-pro $30 / — / $180 (contexto
  //     < 272K), gpt-5.2-pro $21 / — / $168, gpt-5-pro $15 / — / $120. Heredaban
  //     gpt-5.5 ($5 / $30), gpt-5.4, gpt-5.2 y gpt-5: seis y ocho veces por
  //     debajo. No llevan fila porque su salida (0,12–0,18 por 1K) pasa
  //     TECHO_PRECIO_SALIDA_PER_1K (0,08), como o1-pro.
  //   · tabla «Cyber models»: gpt-5.5-cyber $12.50 / $1.25 / $75. Heredaba
  //     gpt-5.5 al 40 %. (gpt-5.6-cyber, en la misma tabla, no hereda nada: la
  //     versión menor corta el emparejador y cae al respaldo ilustrativo.)
  "gpt-5.5-pro",
  "gpt-5.4-pro",
  "gpt-5.2-pro",
  "gpt-5-pro",
  "gpt-5.5-cyber",

  // Google: OTRA MODALIDAD con otro precio publicado, que heredaría la fila de
  // texto de su pariente. https://ai.google.dev/gemini-api/docs/pricing
  // (consultada el 2026-09-27), tier de pago «Standard», USD por 1M:
  //   · gemini-3.8-flash-tts: entrada $0.50 (texto), salida $9.00 (audio),
  //     caché $0.125 — heredaba gemini-3.8-flash ($0.75 / $3.75 / $0.075).
  //   · gemini-3.8-flash-lite-tts: $0.50 / $6.00 (audio) / $0.125 — heredaba
  //     la misma fila.
  //   · gemini-3.1-flash-lite-image: salida de IMAGEN a $30.00 — heredaba
  //     gemini-3.1-flash-lite ($1.50 de salida).
  // Con la herencia, la entrada del TTS salía 1,5× (y con ella el ahorro en
  // dólares de las palancas de entrada) y la salida de audio o imagen muy por
  // debajo de la factura. `gemini-3.1-flash-lite-preview` NO se veta: es alias
  // del mismo modelo y hereda con razón.
  "gemini-3.8-flash-tts",
  "gemini-3.8-flash-lite-tts",
  "gemini-3.1-flash-lite-image",
];

/** El catálogo con las ids vetadas a null: lo que de verdad consulta la búsqueda. */
const TABLA_DE_BUSQUEDA: Readonly<Record<string, CostModel | null>> = {
  ...CATALOGO,
  ...Object.fromEntries(SIN_FILA_PROPIA.map((k) => [k, null])),
};

/** Keys longest-first, so the most specific prefix wins: `claude-haiku-4-5`
 *  before `claude-haiku`. */
const CLAVES_POR_LONGITUD = clavesPorLongitud(TABLA_DE_BUSQUEDA);

/**
 * The list price for a model on the day of the request, or `undefined` when
 * the catalogue has no price for it in force that day.
 *
 * @param model the id as the caller passes it, with or without a vendor prefix.
 * @param at when the request was made (epoch ms or a `Date`); defaults to now.
 *   Prices resolve per UTC day, so a price change the provider has announced
 *   applies from its effective date.
 */
export function precioDeLista(model: string, at?: Date | number): CostModel | undefined {
  // La CLAVE sale del mismo emparejador de siempre (con las vetadas a null); el
  // PRECIO, del tramo de esa clave que cubre el día de la petición.
  const clave = claveDeCatalogo(model);
  return clave === undefined ? undefined : precioEnDia(clave, diaUtc(at));
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
export function precioDeListaPropio(model: string, at?: Date | number): CostModel | undefined {
  const clave = claveDeCatalogo(model);
  if (clave === undefined) return undefined;
  const barra = model.lastIndexOf("/");
  const desnudo = barra >= 0 ? model.slice(barra + 1) : model;
  if (clave !== model && clave !== desnudo) {
    // `buscarPorModelo` ya garantiza que tras la clave viene un separador.
    if (!FECHA_DE_INSTANTANEA.test(desnudo.slice(clave.length + 1))) return undefined;
  }
  // La fila PROPIA, al precio del día de la petición (ver la vigencia arriba).
  return precioEnDia(clave, diaUtc(at));
}
