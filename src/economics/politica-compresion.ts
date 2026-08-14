import {
  decidirCompresion,
  ANTHROPIC_CACHE_TIER,
  OPENAI_CACHE_TIER,
  UNKNOWN_PROVIDER_CACHE_TIER,
  type CacheTier,
  type Decision,
} from "./cache-tier.js";

// La política con la que el PIPELINE usa la verja económica de `cache-tier.ts`.
//
// (Los comentarios de este fichero van en `//`: `CompressionEconomics` viaja al
// `.d.ts` publicado, y ahí un bloque JSDoc se publica entero en npm.)
//
// `decidirCompresion()` sabe decidir cuando le dan los datos completos, y esos
// datos incluyen dos que solo el cliente puede medir: cuánto de su prompt es
// prefijo estable y con qué frecuencia le llega caliente. En una petición
// cualquiera no los tenemos, y ahí es donde se decide si el producto miente.
//
// Hay dos regímenes, y la diferencia entre ellos es TODO lo que este fichero
// añade:
//
//  1. EL CLIENTE LO MIDIÓ (`prefix` presente). Se le cree y se resuelve la
//     cuenta entera: puede salir "comprime aunque pierdas la caché" o "no
//     comprimas aunque quites tokens", según su tráfico. Su dato manda.
//
//  2. NO SE SABE, que es lo normal. Entonces no se puede afirmar que comprimir
//     salga a cuenta cuando la compresión SACA el prompt del tramo cacheable —
//     el caso medido en la cabecera de `cache-tier.ts`: 35,6% de tokens fuera,
//     18,5% de dinero. Esa compresión concreta no se aplica. Las demás sí: si el
//     prompt ya estaba por debajo del mínimo, o si sigue por encima después de
//     comprimir, no hay caché que romper y la decisión vuelve a ser la de
//     siempre —menos tokens es mejor—, que es la que el cliente ya tenía.
//
// Lo que NO se hace es suponerle una tasa de aciertos al cliente. Suponerla baja
// acredita ahorro que su factura no va a ver; suponerla alta apaga la palanca que
// ha pagado. Se bloquea solo el caso en el que la pérdida está demostrada, y se
// dice por qué en la traza.

/** Tunes when compression is worth its money. Every field is optional. */
export interface CompressionEconomics {
  /**
   * The provider's prefix-cache tier. Derived from the request's model when
   * omitted; set it to state your model's real cache minimum and multipliers.
   */
  cacheTier?: CacheTier;
  /**
   * YOUR MEASURED prefix-cache economics: how many prompt tokens are a stable
   * prefix across requests, and how often that prefix arrives already warm
   * (`report.tokens.providerCachedInput` is the numerator for the rate).
   *
   * Both are required together — a hit rate over an unknown prefix says nothing
   * about how much money is at stake. Declaring them unlocks the full decision,
   * including knowingly trading the prefix cache for a smaller prompt when that
   * is the cheaper side. Left out, the layer refuses to compress a prompt out of
   * a cacheable tier rather than assume a rate on your behalf.
   */
  prefix?: { stableTokens: number; hitRate: number };
  /**
   * What running the compressor costs, in equivalent tokens (default 0, which
   * fits a local deterministic compressor). A compressor that is itself another
   * model call is not free, and unaccounted spend shows up nowhere else.
   */
  compressorCostTokens?: number;
  /** Do not compress contexts below this many tokens (default 2000). */
  minimumContextTokens?: number;
  /** Do not apply a compression that saves fewer net tokens than this (default 200). */
  minimumNetTokens?: number;
}

/**
 * El tramo de caché que le corresponde a un modelo.
 *
 * Los multiplicadores de las dos familias conocidas no son inventados: son los
 * mismos que ya factura el catálogo de precios (`pricing/catalogo.ts`), donde
 * `cachedInputPer1k` de `gpt-4o` es la mitad de su `inputPer1k` y el de
 * `claude-sonnet-4` es la décima parte. Lo que no se reconoce cae en
 * {@link UNKNOWN_PROVIDER_CACHE_TIER}, que no reclama descuento ninguno.
 */
export function tramoDeCache(model: string, econ?: CompressionEconomics): CacheTier {
  if (econ?.cacheTier) return econ.cacheTier;

  const id = model.toLowerCase();
  const barra = id.indexOf("/");
  const proveedor = barra > 0 ? id.slice(0, barra) : "";
  const desnudo = barra >= 0 ? id.slice(barra + 1) : id;

  if (proveedor === "openai" || proveedor === "azure-openai") return OPENAI_CACHE_TIER;
  if (proveedor === "anthropic") return ANTHROPIC_CACHE_TIER;
  // Sin prefijo de proveedor se mira el nombre, que en estas dos familias es
  // inconfundible. Un modelo servido por un tercero (OpenRouter, Bedrock…) con
  // el nombre del original hereda el tramo del original, que es lo correcto:
  // el que decide si hay caché de prefijo es el modelo, no quien lo revende.
  if (/^(gpt-|o[1-9](-|$)|chatgpt)/.test(desnudo)) return OPENAI_CACHE_TIER;
  if (desnudo.startsWith("claude")) return ANTHROPIC_CACHE_TIER;

  return UNKNOWN_PROVIDER_CACHE_TIER;
}

export interface EntradaPolitica {
  /** Tokens del prompt COMPLETO tal y como saldría sin comprimir. */
  originalTokens: number;
  /** Tokens del prompt COMPLETO ya comprimido: lo que recibiría el proveedor. */
  compressedTokens: number;
  tier: CacheTier;
  /** Ausente = el cliente no lo ha medido, y no se lo vamos a suponer. */
  prefix?: { stableTokens: number; hitRate: number };
  compressorCostTokens?: number;
}

/**
 * ¿Se aplica esta compresión concreta? Ver la nota de cabecera: con `prefix`
 * declarado manda la cuenta completa; sin él se bloquea únicamente la
 * compresión que saca el prompt del tramo cacheable.
 */
export function politicaDeCompresion(e: EntradaPolitica): Decision {
  const medido = e.prefix != null;
  const decision = decidirCompresion({
    originalTokens: e.originalTokens,
    compressedTokens: e.compressedTokens,
    stablePrefixTokens: e.prefix?.stableTokens ?? 0,
    prefixHitRate: e.prefix?.hitRate ?? 0,
    tier: e.tier,
    ...(e.compressorCostTokens != null
      ? { compressorCostTokens: e.compressorCostTokens }
      : {}),
  });
  if (medido) return decision;

  const min = e.tier.minimumCacheTokens;
  const cruzaElTramo =
    min != null && e.originalTokens >= min && e.compressedTokens < min;
  if (!cruzaElTramo) return decision;

  return {
    ...decision,
    comprimir: false,
    razon:
      `comprimir sacaría el prompt del tramo cacheable (${e.compressedTokens} < ${min}) ` +
      `y nadie ha medido la tasa de aciertos de prefijo: no se puede afirmar que salga a ` +
      `cuenta. Declárala en \`compressionEconomics.prefix\` y se resuelve la cuenta entera`,
  };
}
