/**
 * Verja económica cache-aware: ¿comprimir sale a cuenta, de verdad?
 *
 * EL FALLO QUE ESTO CIERRA, medido contra el proveedor real en el escenario de
 * la tabla de 50 filas:
 *
 *     naive   1212 tokens de entrada  ->  SÍ entra en la caché de prefijo
 *     nuestro  780 tokens de entrada  ->  NO, cae por debajo del mínimo de 1024
 *
 *     quitamos    35,6% de los tokens
 *     capturamos  18,5% del dinero
 *
 * La mitad del ahorro se evapora porque la compresión nos saca del tramo
 * cacheable. Y el punto de equilibrio está en ~71% de aciertos de prefijo: por
 * encima de eso, comprimir PIERDE dinero. Un cliente de alto volumen con un
 * prefijo estable —justo el que más paga— es al que peor le iría.
 *
 * Contar tokens eliminados no es contar dinero. Esta es la diferencia entre un
 * "compresor de prompts" y un plano de control económico.
 */

/** Lo que hay que saber del proveedor para decidir. Sale del registro de precios. */
export interface CacheTier {
  /**
   * Tokens mínimos de prompt para que el proveedor cachee el prefijo.
   * OpenAI: 1024. Anthropic: 1024-2048 según modelo. `null` = no cachea.
   */
  minimumCacheTokens: number | null;
  /** Precio de un token leído de caché, como fracción del normal. OpenAI 0,5; Anthropic 0,1. */
  cacheReadMultiplier: number;
  /** Sobrecoste de ESCRIBIR la caché la primera vez. Anthropic cobra 1,25x-2x; OpenAI no. */
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

/** Ni cachea ni descuenta: la decisión se reduce a "menos tokens es mejor". */
export const NO_CACHE_TIER: CacheTier = {
  minimumCacheTokens: null,
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
    razon = saleDelTramo
      ? `comprimir saca el prompt del tramo cacheable (${e.compressedTokens} < ${min}) y cuesta más de lo que ahorra`
      : `el ahorro no cubre el coste del compresor`;
  } else if (saleDelTramo) {
    razon = `compensa pese a perder la caché de prefijo (aciertos ${(e.prefixHitRate * 100).toFixed(0)}%)`;
  } else {
    razon = `compensa y no toca el tramo de caché`;
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
