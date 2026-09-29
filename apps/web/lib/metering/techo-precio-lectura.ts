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

/**
 * EL TECHO DE SALIDA del carril medido por referencia (0029), en USD por 1.000
 * tokens: ≥ el mayor `outputPer1k` del catálogo (hoy 0,075, claude-opus-4 /
 * claude-3-opus). Un test lo ata leyendo el catálogo como texto.
 *
 * Con TECHO_PRECIO_LECTURA_PER_1K acota el `baselineCost` de un registro
 * basis "reference": la entrada acreditada, como mucho, al mayor precio de
 * LECTURA y la salida acreditada al mayor precio de salida. Un registro por
 * encima NO se rechaza (un throw tumba el lote entero del cliente): se DEGRADA
 * a "estimated" en la verja del ingest (usage.ts, `referenciaCoherente`).
 */
export const TECHO_PRECIO_SALIDA_PER_1K = 0.08;

/**
 * EL TECHO DE ENTRADA del carril del AHORRO NATIVO (0032), en USD por 1.000
 * tokens: ≥ el mayor `inputPer1k` del catálogo y de las tablas de tier (hoy
 * 0,03). Un test lo ata leyendo el catálogo como texto.
 *
 * Acota las dos cifras que el cliente manda por registro: el descuento de
 * lectura (`nativeCacheReadSavings` ≤ leídos × techo: el descuento nunca pasa
 * del precio de entrada entero) y la prima de escritura
 * (`nativeCacheWritePremium` ≤ entrada × techo: la prima más cara, la de una
 * hora, es 1× la entrada extra, y las escrituras están dentro de la entrada).
 * RECORTE, NO RECHAZO, como el suelo: un throw tumba el lote entero. Y es
 * inocuo para el dinero: este carril jamás entra en la comisión.
 */
export const TECHO_PRECIO_ENTRADA_PER_1K = 0.04;

/** Una cifra del ahorro nativo recortada a `tokens × techo de entrada` (0 sin conteo). */
export function recortarNativo(usd: number, tokens: number): number {
  if (!(tokens > 0)) return 0;
  return Math.min(usd, (tokens / 1_000) * TECHO_PRECIO_ENTRADA_PER_1K);
}
