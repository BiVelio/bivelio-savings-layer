// LA AUDITORÍA DE CACHE BREAKS: decirle al developer POR QUÉ su prompt cache
// no acierta, antes de que pague la escritura entera.
//
// El mercado (informe de noviembre de 2026) es unánime en el leverage real del
// prompt caching: a un 80% de hit-rate, el «90% de descuento» del proveedor se
// queda en ~31-32% de ahorro real, porque la salida domina la factura y cada
// escritura cuesta. Lo que decide es el HIT-RATE, y el hit-rate lo rompen tres
// patrones SILENCIOSOS que nadie arregla automáticamente:
//
//   1. system prompt mutable: un timestamp «ahora», un UUID por petición o una
//      fecha formateada hacen que el prefijo cambie en cada llamada → 0% de hit.
//   2. serialización no determinista de herramientas (orden de un Map/Set).
//   3. ventana deslizante de historial que desplaza el prefijo.
//
// La capa ya cubre el 2 (orden determinista por `tool_id`) y el 3 (colocación
// fija + memoria append-only). Este módulo cubre el 1: una función PURA, sin red
// y sin estado que, sobre el texto del prefijo cacheable (la cabecera de
// `system`), detecta lo que va a cambiar en la próxima petición y lo dice.
//
// ES DIAGNÓSTICO, NO REWRITING. No reescribimos el `system` por dos motivos: (a)
// cambiar el texto que el modelo lee es una decisión de calidad que solo el
// llamante puede tomar, y (b) la doctrina de la capa (ver compression/cola.ts)
// prohíbe opinar dos veces sobre el mismo bloque ya cacheado. Lo que hacemos es
// señalarlo en `report.traces` (`cache-audit`), que es gratis y no toca la
// petición. El developer ve la pista y arregla SU prompt.

export interface CacheAuditFinding {
  /** El patrón detectado: `iso-timestamp`, `epoch-millis`, `epoch-seconds`, `uuid-v4`, `rfc2822-date`. */
  patron: string;
  /** El fragmento (recortado) que lo delata. Nunca sale del propio texto del cliente. */
  muestra: string;
  /** Por qué rompe la caché. */
  razon: string;
}

/** Límite de longitud de la muestra, para no volcar el prompt del cliente a la traza. */
const MUESTRA_MAX = 48;

/** Timestamps ISO 8601 con o sin zona: «2026-11-09T10:00:00Z», «2026-11-09 10:00:00». */
const ISO = /\b20\d{2}-\d{2}-\d{2}[T\s]\d{1,2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

/** UUID v4: `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`. */
const UUID_V4 = /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

/** Fechas RFC 2822: «Mon, 09 Nov 2026» / «09 Nov 2026 10:00:00 GMT». */
const RFC2822 = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\b/gi;

/** Época en milisegundos (13 cifras): inequívoco, es un «Date.now()». */
const EPOCH_MS = /\b1[5-9]\d{11}\b/g;

/** Época en segundos (10 cifras) dentro del rango 2020-2033. Más ambiguo: se marca como posible. */
const EPOCH_S = /\b(?:1[5-9]|20)\d{8}\b/g;

function recorte(s: string): string {
  return s.length <= MUESTRA_MAX ? s : `${s.slice(0, MUESTRA_MAX)}…`;
}

/**
 * Encuentra en el prefijo cacheable el contenido que cambia en cada petición.
 *
 * Pura y determinista: el mismo texto devuelve el mismo informe, en orden de
 * aparición y sin duplicados por patrón. Pensada para el prefijo ESTABLE (la
 * cabecera de `system`), no para la cola de la petición, que cambia por diseño.
 */
export function detectarContenidoMutable(texto: string): CacheAuditFinding[] {
  if (!texto) return [];
  const vistos = new Set<string>();
  const hallazgos: CacheAuditFinding[] = [];

  const anotar = (patron: string, muestra: string, razon: string) => {
    const clave = `${patron}:${muestra}`;
    if (vistos.has(clave)) return;
    vistos.add(clave);
    hallazgos.push({ patron, muestra: recorte(muestra), razon });
  };

  for (const m of texto.matchAll(ISO)) {
    anotar("iso-timestamp", m[0], "an ISO timestamp in the system prompt changes every request, so the provider cache can never hit on the prefix");
  }
  for (const m of texto.matchAll(UUID_V4)) {
    anotar("uuid-v4", m[0], "a per-request UUID in the system prompt forces a full cache miss every call");
  }
  for (const m of texto.matchAll(RFC2822)) {
    anotar("rfc2822-date", m[0], "a formatted current date in the system prompt changes daily and breaks the prefix");
  }
  for (const m of texto.matchAll(EPOCH_MS)) {
    anotar("epoch-millis", m[0], "a millisecond epoch (Date.now()) in the system prompt changes on every call — move it to the query tail");
  }
  for (const m of texto.matchAll(EPOCH_S)) {
    // 10 cifras puede ser un id cualquiera; se marca como posible, no como seguro.
    anotar("epoch-seconds", m[0], "a 10-digit number that looks like a Unix epoch may change per request and break the prefix");
  }

  return hallazgos;
}
