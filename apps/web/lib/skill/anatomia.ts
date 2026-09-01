/**
 * LA ANATOMÍA MEDIDA DEL GASTO — la única fuente de las cifras que la landing
 * publica junto al skill savings-mode.
 *
 * Salen del corpus real del medidor (contadores del proveedor, tráfico
 * Sonnet-clase de Claude Code), ponderadas por DINERO a precio de lista:
 * lectura de caché a tarifa cacheada, escritura 1h a 2×, salida a tarifa de
 * salida. No suman 100 exacto porque las partidas menores (entrada sin caché,
 * escritura 5m) quedan fuera del relato — el test ancla que lo publicado
 * cubre casi todo y no se inventa nada.
 *
 * La doctrina de siempre: estas cifras describen DÓNDE se va el gasto; el
 * efecto del propio skill NO tiene cifra hasta que esté medido en A/B.
 */
export const ANATOMIA_MEDIDA = {
  /** Cuándo y sobre cuántas peticiones se midió. */
  fecha: "2026-09-01",
  peticiones: 959,
  /** Fracciones del gasto total, ponderadas por dinero. */
  lecturaCache: 0.682,
  escritura1h: 0.196,
  salida: 0.116,
} as const;
