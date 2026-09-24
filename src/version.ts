/**
 * The version the SDK reports for itself.
 *
 * Written by hand and deliberately NOT read from package.json: the published
 * bundle does not ship package.json, so a `require` here would fail at runtime
 * on the customer's machine. `test/version-declarada.test.ts` ties this
 * constant to package.json so the two can never drift.
 */
export const BV_SALA_VERSION = "0.4.23";

// ---------------------------------------------------------------------------
// Lo de abajo es INTERNO: no sale por src/index.ts (la superficie pública solo
// reexporta BV_SALA_VERSION). Este fichero no importa nada, a propósito: lo
// importa el emisor de metering, y el emisor lo reexporta metering/index.ts →
// index.ts, así que cualquier import aquí sería un ciclo.
// ---------------------------------------------------------------------------

/**
 * La cabecera HTTP con la que el emisor de uso declara la versión del PROCESO
 * («gateway/0.4.17» o «sdk/0.4.17»). Cabecera y no campo del cuerpo: un campo
 * nuevo en el cuerpo tumba el lote entero contra un servidor que no lo conozca
 * (lista blanca del ingest → 400 → sin reintento); una cabecera la ignora.
 * Espejo en la web (apps/web/lib/metering/version.ts), atado por test que lee
 * este fichero como texto.
 */
export const CABECERA_VERSION = "x-bvsala-version";

/**
 * Política A MANO: la primera versión PUBLICADA con la palanca facturable de
 * tarifa (#229/#230 → 0.4.16, commit 56069f0). El panel la usa solo para
 * EXPLICAR por qué una máquina no ahorra («esta versión no lleva la palanca»);
 * la verja REAL del aviso es el dinero medido por asiento
 * (seat_activity.measured_*, migración 0024), nunca esta constante.
 *
 * Casilla del PR de release: «¿cambia qué versión tiene la palanca? → sube
 * MINIMA». Nada la ata al código de la palanca por construcción; el test de
 * paridad de la web (apps/web/lib/version/minima.test.ts) solo garantiza que
 * el espejo no derive y que no sea mayor que la versión publicada.
 */
export const VERSION_MINIMA_PALANCA_TARIFA = "0.4.16";
