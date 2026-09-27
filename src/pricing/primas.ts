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

/** El id en minúsculas y sin prefijo de pasarela (`openai/gpt-6-luna` → `gpt-6-luna`). */
function desnudo(model: string): string {
  const m = model.toLowerCase();
  const barra = m.lastIndexOf("/");
  return barra >= 0 ? m.slice(barra + 1) : m;
}

/**
 * ¿Es un GPT de OpenAI de la 5.6 en adelante (5.6, 5.7…, toda la familia 6 y
 * las que vengan)? Son los que cobran la escritura de caché a 1,25×.
 *
 * Fuente: https://developers.openai.com/api/docs/guides/prompt-caching
 * (consultada el 2026-09-27): «For GPT-5.6 and later, cache writes cost 1.25×
 * the standard, uncached input-token rate». La guía describe dos modos
 * (`prompt_cache_options.mode`: `implicit`, con el breakpoint al final del
 * último mensaje elegible, y `explicit`, sin escrituras si no hay breakpoints)
 * y NO dice cuál rige cuando la petición no pide ninguno; la tarifa de la
 * escritura es la misma en los dos. La tabla oficial de precios lo confirma
 * fila a fila con su columna «Cache
 * writes» (gpt-6-astra $12.50, gpt-6-sol $2.50, gpt-6-luna $0.125, la familia
 * 5.6 igual, sobre entradas de $10, $2 y $0.10). Antes de esto el patrón era
 * `^gpt-5\.6` y la familia gpt-6 salía a 1×: el gateway medía sus escrituras
 * un 20% por debajo de la factura.
 *
 * Por VERSIÓN, no por nombre, para que un gpt-6.1 o un gpt-7 no caigan en el
 * 1× por no estar en una lista: `gpt-4o`, `gpt-4.1`, `gpt-5`, `gpt-5-mini`,
 * `gpt-5.5` y `gpt-oss-*` siguen fuera.
 */
function esGptConPrimaDeEscritura(m: string): boolean {
  const v = /^gpt-(\d+)(?:\.(\d+))?(?![\d.])/.exec(m);
  if (!v) return false;
  const mayor = Number(v[1]);
  const menor = v[2] === undefined ? 0 : Number(v[2]);
  return mayor > 5 || (mayor === 5 && menor >= 6);
}

/**
 * Prima de escritura de caché por modelo. OpenAI cachea la entrada pero no
 * cobra por escribirla hasta la 5.5 (de la 5.6 en adelante sí, 1,25×); el
 * resto de OpenAI y Gemini no tienen prima — cobrar 1,25× sería inventar de
 * más. Se mira el id SIN prefijo de pasarela: `openai/gpt-4o` no es Anthropic.
 */
export function primaDeEscritura(model: string): number {
  const m = desnudo(model);
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) {
    return esGptConPrimaDeEscritura(m) ? PRIMA_ESCRITURA_CACHE : 1;
  }
  if (m.startsWith("gemini")) return 1;
  return PRIMA_ESCRITURA_CACHE;
}

/**
 * La prima de escritura que el proveedor cobra POR SU CUENTA, marque o no
 * marque nadie la caché: 1,25× en los GPT de la 5.6 en adelante, 1 en el
 * resto.
 *
 * Es otra pregunta que `primaDeEscritura`, y la diferencia vale dinero. En
 * Anthropic la escritura la PROVOCA quien pone `cache_control`: si la pone la
 * capa, la prima es coste de la capa y va solo al `actual`. En OpenAI la caché
 * es implícita: el proveedor escribe el prefijo en cada fallo, y la
 * `prompt_cache_key` que manda la capa solo enruta. Esa prima la habría pagado
 * igual la petición sin capa, así que va a los DOS lados (baseline y real): el
 * `actual` cuadra con la factura y el ahorro no se mueve ni un céntimo.
 */
export function primaDeEscrituraAutomatica(model: string): number {
  return esGptConPrimaDeEscritura(desnudo(model)) ? PRIMA_ESCRITURA_CACHE : 1;
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
  if (m.startsWith("claude") || m.startsWith("anthropic/") || desnudo(m).startsWith("claude")) return PRIMA_ESCRITURA_CACHE_1H;
  return primaDeEscritura(model);
}
