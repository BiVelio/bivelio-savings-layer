// Verja económica cache-aware: ¿comprimir sale a cuenta, de verdad?
//
// Los comentarios de este fichero van en `//` a propósito, no en JSDoc: `CacheTier`
// viaja al `.d.ts` publicado (lo referencia la configuración de la capa), y ahí un
// bloque JSDoc se publica entero en npm. Lo que sigue es contexto interno.
//
// EL FALLO QUE ESTO CIERRA, medido contra el proveedor real en el escenario de
// la tabla de 50 filas:
//
//     naive   1212 tokens de entrada  ->  SÍ entra en la caché de prefijo
//     nuestro  780 tokens de entrada  ->  NO, cae por debajo del mínimo de 1024
//
//     quitamos    35,6% de los tokens
//     capturamos  18,5% del dinero
//
// La mitad del ahorro se evapora porque la compresión nos saca del tramo
// cacheable. Y el punto de equilibrio está en ~71% de aciertos de prefijo: por
// encima de eso, comprimir PIERDE dinero. Un cliente de alto volumen con un
// prefijo estable —justo el que más paga— es al que peor le iría.
//
// Contar tokens eliminados no es contar dinero. Esta es la diferencia entre un
// "compresor de prompts" y un plano de control económico.

/** What the layer needs to know about a provider's prefix cache to price a decision. */
export interface CacheTier {
  /**
   * Minimum prompt tokens before the provider caches the prefix at all;
   * `null` means it never does.
   *
   * The built-in tiers assume 1024 for every model. That is an ASSUMPTION, not a
   * verified figure: real minimums differ per model and family. Set your model's
   * own minimum here when you know it.
   */
  minimumCacheTokens: number | null;
  // El único número que se deja como está pese a saber que es una simplificación,
  // y la razón es que los dos errores no cuestan lo mismo:
  //
  //  - Si el mínimo REAL es mayor que el supuesto (2048 y suponemos 1024), la
  //    capa cree cacheable un prompt de 1500 que el proveedor no cachea: protege
  //    una caché que no existe y RENUNCIA a una compresión que salía a cuenta. Se
  //    pierde ahorro; no se inventa ninguno.
  //  - Si el mínimo real es MENOR, la capa comprime creyendo que el prompt ya
  //    estaba fuera del tramo cuando seguía dentro, y ahí sí rompe una caché real.
  //    Es el error caro, y es el que el valor alto evita.
  //
  // Inventarle un desglose por modelo que no se puede comprobar desde este repo
  // sería peor que la simplificación: un número inventado no avisa de que lo es.

  /** Price of a cache-read token as a fraction of a normal one (e.g. 0.5, 0.1). */
  cacheReadMultiplier: number;
  /** Surcharge for WRITING the cache the first time; some providers bill above 1. */
  cacheWriteMultiplier: number;
}

export const OPENAI_CACHE_TIER: CacheTier = {
  minimumCacheTokens: 1024,
  cacheReadMultiplier: 0.5,
  cacheWriteMultiplier: 1,
};

export const ANTHROPIC_CACHE_TIER: CacheTier = {
  minimumCacheTokens: 1024,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
};

// Mínimos cacheables REALES por modelo de Anthropic — la página oficial de
// prompt caching los publica por modelo (leída 2026-09-06) y dejan de ser el
// supuesto de 1024 de arriba. La cifra importa en las dos direcciones que
// documenta el comentario de `minimumCacheTokens`: con 512 real y 1024 supuesto,
// un prompt de 780 se creía fuera del tramo (el fallo medido de la cabecera:
// capturábamos 18,5% del dinero quitando 35,6% de los tokens); con 4096 real y
// 1024 supuesto, se protegía una caché que no existía. El emparejamiento es por
// prefijo MÁS LARGO primero, para que la instantánea fechada herede de su
// modelo y `claude-fable-5-1` no caiga en la fila de `claude-fable-5` (la misma
// trampa de herencia que el catálogo de precios ya paga en su propio test).
const MINIMOS_ANTHROPIC: [prefijo: string, minimo: number][] = [
  ["claude-fable-5-1", 512],
  ["claude-mythos-5-1", 512],
  ["claude-fable-5", 512],
  ["claude-mythos-5", 512],
  // Opus 5.5: 512 en la misma página (releída el 2026-09-27). Con fila propia y
  // no por herencia de `claude-opus-5-`: el mismo corte que el catálogo.
  ["claude-opus-5-5", 512],
  ["claude-opus-5", 512],
  ["claude-opus-4-7", 2048],
  ["claude-opus-4-6", 4096],
  ["claude-opus-4-5", 4096],
  ["claude-haiku-4-5", 4096],
  ["claude-3-5-haiku", 2048],
];

/** The Anthropic cache tier with the model's PUBLISHED minimum cacheable size
 *  (per-model figures from the official prompt-caching page, 2026-09-06);
 *  models without a published figure keep the conservative 1024 default. */
export function tramoAnthropicDelModelo(desnudo: string): CacheTier {
  for (const [prefijo, minimo] of MINIMOS_ANTHROPIC) {
    if (desnudo === prefijo || desnudo.startsWith(`${prefijo}-`)) {
      return { ...ANTHROPIC_CACHE_TIER, minimumCacheTokens: minimo };
    }
  }
  return ANTHROPIC_CACHE_TIER;
}

// Gemini: caché IMPLÍCITA (activada por defecto, sin `cache_control` ni campo
// alguno en la petición) con lectura al 10% de la entrada y SIN prima de
// escritura — verificado el 2026-08-24 contra el `/models` de la pasarela
// (`input_cache_read` = input/10 en toda la familia gemini-2.5…3.7). El mínimo
// documentado varía por modelo (1024 en los flash); se usa 1024 por la misma
// razón que en las otras dos familias: el valor bajo protege una caché que
// podría existir, y ese es el error barato.
export const GOOGLE_CACHE_TIER: CacheTier = {
  minimumCacheTokens: 1024,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1,
};

/** Ni cachea ni descuenta: la decisión se reduce a "menos tokens es mejor". */
export const NO_CACHE_TIER: CacheTier = {
  minimumCacheTokens: null,
  cacheReadMultiplier: 1,
  cacheWriteMultiplier: 1,
};

// El tramo que se usa cuando no se reconoce el proveedor del modelo. Las dos
// mitades tiran de lados distintos a propósito:
//
//  - multiplicadores a 1: de un proveedor desconocido NO se reclama ningún
//    descuento de caché, porque un descuento inventado es ahorro inventado.
//  - mínimo a 1024: se asume que PODRÍA cachear, así que la compresión no puede
//    sacar el prompt del tramo. Renunciar a una compresión cuesta un ahorro que
//    no se captura; romper una caché que sí existía cuesta dinero del cliente, y
//    esas dos no empatan.
//
// O sea: por defecto no se promete nada y no se rompe nada. Quien sepa lo que
// hace su proveedor lo declara en `compressionEconomics`.
export const UNKNOWN_PROVIDER_CACHE_TIER: CacheTier = {
  minimumCacheTokens: 1024,
  cacheReadMultiplier: 1,
  cacheWriteMultiplier: 1,
};

export interface EntradaDecision {
  /** Tokens del prompt SIN comprimir. */
  originalTokens: number;
  /** Tokens del prompt YA comprimido (lo que se enviaría). */
  compressedTokens: number;
  /**
   * Cuántos tokens del prompt original son PREFIJO ESTABLE — los que el
   * proveedor podría reutilizar entre peticiones. No es todo el prompt: la cola
   * específica de la consulta nunca se cachea.
   */
  stablePrefixTokens: number;
  /**
   * Fracción de peticiones que llegan con ese prefijo ya caliente. 0 en frío,
   * ->1 en tráfico repetitivo. Se mide, no se supone.
   */
  prefixHitRate: number;
  tier: CacheTier;
  /** Coste de ejecutar el compresor, en TOKENS equivalentes (0 si es local y determinista). */
  compressorCostTokens?: number;
}

export interface Decision {
  comprimir: boolean;
  /** Coste esperado en tokens equivalentes, comprimiendo. */
  costeComprimido: number;
  /** Coste esperado en tokens equivalentes, sin comprimir (con su descuento de caché). */
  costeSinComprimir: number;
  /** Ganancia neta en tokens equivalentes. Negativa = comprimir sale caro. */
  ganancia: number;
  /**
   * En INGLÉS, y no por gusto: este texto no se queda en el repo. El pipeline lo
   * copia tal cual a `detail.reason` de la traza de compresión, y `report.traces`
   * es contrato publicado — lo lee el cliente en su panel, en cada petición con
   * la palanca encendida. El resto de motivos de la capa («no output contract»,
   * «net saving N tokens») están en inglés; una frase en español aquí es la misma
   * fuga que el trinquete de `superficie-publica-limpia` persigue en el `.d.ts`,
   * solo que por la puerta grande, porque viaja en el payload y no en un tooltip.
   * El identificador se queda en español: ese no sale del repo.
   */
  razon: string;
}

/**
 * Coste esperado de un prompt en TOKENS EQUIVALENTES, contando el descuento de
 * la caché de prefijo cuando el prompt entra en el tramo.
 *
 * Se trabaja en tokens equivalentes y no en euros a propósito: el precio por
 * token se cancela en la comparación, así que la decisión no depende de acertar
 * la tarifa — solo de los multiplicadores de caché, que sí son estructurales.
 */
export function costeEsperado(
  totalTokens: number,
  stablePrefixTokens: number,
  prefixHitRate: number,
  tier: CacheTier,
): number {
  const min = tier.minimumCacheTokens;
  // Por debajo del mínimo el proveedor no cachea NADA: se paga todo a precio lleno.
  if (min == null || totalTokens < min) return totalTokens;

  // El prefijo cacheable nunca excede el prompt, ni la parte que de verdad es estable.
  const cacheable = Math.min(stablePrefixTokens, totalTokens);
  const resto = totalTokens - cacheable;
  const h = Math.min(1, Math.max(0, prefixHitRate));

  // Con acierto se lee barato; sin acierto se escribe, y escribir puede costar
  // MÁS que un token normal (Anthropic cobra prima de escritura).
  const costePrefijo = h * cacheable * tier.cacheReadMultiplier
    + (1 - h) * cacheable * tier.cacheWriteMultiplier;

  return resto + costePrefijo;
}

/**
 * ¿Compensa comprimir?
 *
 * La regla del funcional: comprimir solo si el ahorro del PROVEEDOR supera el
 * coste del compresor MÁS la penalización por romper la caché, y si el prompt
 * comprimido sigue en un tramo rentable.
 */
export function decidirCompresion(e: EntradaDecision): Decision {
  const costeSinComprimir = costeEsperado(
    e.originalTokens, e.stablePrefixTokens, e.prefixHitRate, e.tier,
  );
  // Comprimir reordena y reescribe, así que el prefijo estable deja de coincidir
  // byte a byte: el proveedor lo trata como nuevo. Se asume prefijo cacheable 0.
  // Es la hipótesis conservadora y es la que se observó: nuestro brazo recibió
  // CERO tokens cacheados en las 210 llamadas.
  const costeComprimido = costeEsperado(e.compressedTokens, 0, 0, e.tier)
    + (e.compressorCostTokens ?? 0);

  const ganancia = costeSinComprimir - costeComprimido;

  const min = e.tier.minimumCacheTokens;
  const caiaEnTramo = min != null && e.originalTokens >= min;
  const saleDelTramo = caiaEnTramo && e.compressedTokens < min;

  let razon: string;
  if (ganancia <= 0) {
    // La tercera razón existe porque las dos primeras mentían en el caso que más
    // importa: un prefijo caliente que se lee a 0,1x hace que el prompt SIN
    // comprimir salga más barato aunque el comprimido siga dentro del tramo. Ahí
    // no se sale de ningún tramo y el compresor puede ser gratis, así que decirle
    // al cliente "el ahorro no cubre el coste del compresor" le manda a mirar el
    // sitio equivocado.
    const pierdeElDescuento = costeSinComprimir < e.originalTokens;
    razon = saleDelTramo
      ? `compressing drops the prompt out of the cacheable tier (${e.compressedTokens} < ${min}) and costs more than it saves`
      : pierdeElDescuento
        ? `not compressing is cheaper: the provider's prefix cache already discounts ` +
          `this prompt (${costeSinComprimir.toFixed(0)} vs ${costeComprimido.toFixed(0)} ` +
          `equivalent tokens, at a ${(e.prefixHitRate * 100).toFixed(0)}% hit rate)`
        : `the saving does not cover the compressor's cost`;
  } else if (saleDelTramo) {
    razon = `pays off even after losing the prefix cache (${(e.prefixHitRate * 100).toFixed(0)}% hit rate)`;
  } else {
    razon = `pays off and does not touch the cache tier`;
  }

  return { comprimir: ganancia > 0, costeComprimido, costeSinComprimir, ganancia, razon };
}

/**
 * La tasa de aciertos de prefijo a partir de la cual comprimir DEJA de compensar.
 *
 * Sirve para avisar: "hoy te compensa, pero si tu tráfico se vuelve repetitivo
 * dejará de hacerlo". Devuelve `null` si compensa siempre o nunca.
 */
export function equilibrioPrefixHitRate(e: Omit<EntradaDecision, "prefixHitRate">): number | null {
  const gana = (h: number): number =>
    decidirCompresion({ ...e, prefixHitRate: h }).ganancia;
  if (gana(0) <= 0) return null;   // no compensa ni en frío
  if (gana(1) > 0) return null;    // compensa siempre
  // Monótona en h: búsqueda binaria.
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (gana(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
