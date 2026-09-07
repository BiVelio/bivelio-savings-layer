/**
 * EL TECHO del suelo de la elisión, en USD por 1.000 tokens.
 *
 * El gateway (B2, desde 0.4.17) manda por registro `eliminatedInputFloorCost`:
 * los tokens que el proveedor borró (`applied_edits`) valorados al precio de
 * LECTURA de caché del modelo (`cachedInputPer1k` del catálogo, src/pricing/
 * catalogo.ts) — jamás a `inputPer1k`. El servidor no conoce precios y no puede
 * recomputar esa cifra; lo que SÍ puede es negarse a guardar un suelo que ningún
 * precio de lectura del catálogo justifica: un gateway viejo o manipulado que
 * tarifara a precio de ENTRADA (×10 en opus/sonnet/fable-5, ×40 en fable-5-1)
 * queda recortado aquí a `tokens × TECHO`.
 *
 * Es un TECHO, no un precio: vale ≥ el mayor `cachedInputPer1k` del catálogo
 * (hoy 0,0015, claude-opus-4 / claude-3-opus) y un test lo ata leyendo el
 * catálogo como texto — si el catálogo sube por encima, el test se pone rojo y
 * alguien sube el techo a conciencia. Hoy es inocuo (el suelo no se cobra:
 * COMISIONAR_ELISION_SUELO = false); el día que se encienda, es la precondición.
 *
 * RECORTE, NO RECHAZO: un throw en parseUsageRecord tumba el LOTE ENTERO del
 * cliente (400 sin reintento). Se recorta y se avisa por consola.
 */
export const TECHO_PRECIO_LECTURA_PER_1K = 0.002;

/**
 * El suelo admisible para un registro: 0 sin conteo («dinero sin conteo» no
 * existe), y nunca por encima de `tokens × techo`. Pura, compartida por la
 * verja del ingest y por sus tests.
 */
export function recortarSuelo(suelo: number, tokens: number): number {
  if (!(tokens > 0)) return 0;
  return Math.min(suelo, (tokens / 1_000) * TECHO_PRECIO_LECTURA_PER_1K);
}
