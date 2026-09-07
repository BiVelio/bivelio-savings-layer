/**
 * PRIMAS DE ESCRITURA DE CACHÉ — un solo domicilio.
 *
 * Estos dos números multiplican cada euro que se factura: la comisión sale de
 * `sobrecosteEvitado`, que es exactamente la diferencia entre ellos
 * (gateway/medidor.ts). Hasta hoy vivían DUPLICADOS y fuera de `src/pricing/`:
 * `PRIMA_ESCRITURA_CACHE`/`PRIMA_ESCRITURA_CACHE_1H` en gateway/medidor.ts y
 * otra vez, con otro nombre, como `PRIMA_5M`/`PRIMA_1H` en gateway/tarifa.ts.
 * Dos copias del mismo hecho es como este repositorio ya se quemó una vez: un
 * script tarifó el corpus con fable-5 al precio de Haiku y la factura salió
 * $279 en vez de $1.232,91.
 *
 * Viven aquí, y no en `gateway/`, porque `src/` no puede importar de `gateway/`
 * —la frontera está escrita en src/pipeline/elision.ts— y el punto de
 * equilibrio de la elisión (src/pricing/aptitud-de-elision.ts) las necesita.
 * Los ficheros de `gateway/` las re-exportan, así que ningún llamante cambia.
 *
 * HONESTIDAD: esto DEDUPLICA el literal; no lo mete bajo el vigía de precios,
 * que compara contra una referencia pública de precios por token y no publica
 * primas de escritura. Sigue siendo un número tecleado, pero ahora es UNO.
 */

/**
 * Prima de ESCRITURA de caché (TTL 5m, el defecto): crear una entrada de
 * prompt cache se factura a 1,25× el precio de entrada (precio público). La
 * LECTURA usa `cachedInputPer1k` del catálogo.
 */
export const PRIMA_ESCRITURA_CACHE = 1.25;

/**
 * Prima de escritura con TTL 1h: 2× el precio de entrada (precio público).
 * Claude Code la negocia vía `extended-cache-ttl-2025-04-11`; tarifarla a
 * 1,25× infra-medía el coste real.
 */
export const PRIMA_ESCRITURA_CACHE_1H = 2;

/**
 * Prima de escritura de caché por modelo. OpenAI cachea la entrada pero no
 * cobra por escribirla (gpt-5.6 en adelante sí); el resto (gpt anteriores,
 * Gemini) no tiene prima — cobrar 1,25× sería inventar de más.
 */
export function primaDeEscritura(model: string): number {
  const m = model.toLowerCase();
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return /^gpt-5\.6/.test(m) ? PRIMA_ESCRITURA_CACHE : 1;
  if (m.startsWith("gemini")) return 1;
  return PRIMA_ESCRITURA_CACHE;
}

/**
 * Prima de escritura con TTL de 1 HORA. Es EXCLUSIVA de Anthropic: solo
 * Anthropic ofrece ese TTL y solo Anthropic emite su desglose. Donde no existe
 * devuelve la prima normal del modelo, no un 2× inventado.
 *
 * Por qué importa y no es un detalle: el simulador de sombra cobraba 2× la
 * escritura de 1h a TODO el mundo. Sobre un modelo de OpenAI eso mueve el punto
 * de equilibrio de la elisión de 0,111111 a 0,052632 — más del doble de
 * estricto— y la verja cerraría donde debería abrir.
 */
export function primaDeEscritura1h(model: string): number {
  const m = model.toLowerCase();
  if (m.startsWith("claude") || m.startsWith("anthropic/")) return PRIMA_ESCRITURA_CACHE_1H;
  return primaDeEscritura(model);
}
