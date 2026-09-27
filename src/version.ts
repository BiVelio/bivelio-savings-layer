/**
 * The version the SDK reports for itself.
 *
 * Written by hand and deliberately NOT read from package.json: the published
 * bundle does not ship package.json, so a `require` here would fail at runtime
 * on the customer's machine. `test/version-declarada.test.ts` ties this
 * constant to package.json so the two can never drift.
 */
export const BV_SALA_VERSION = "0.4.25";

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

/**
 * Política A MANO: la primera versión que emite registros `basis: "reference"`
 * con la regla v2 (`reference-v2`). La etiqueta v0.4.23 se cortó con la regla v1
 * (formato de registro `v: 1`, sin guarda de razonamiento y sin el esquema
 * estricto), y la versión de la regla no viaja en el registro de uso: el
 * servidor sella la del extracto entero. Así que el ingest DEGRADA a
 * `estimated` toda referencia que venga de un proceso anterior a esta versión,
 * que no declare versión, o que declare `gateway/` (el gateway no pasa por el
 * pipeline que aplica la regla; apps/web/lib/metering/version.ts): el sello
 * «reference-v2» es cierto para todo lo que entra, publique quien publique
 * qué.
 *
 * Va por DELANTE de BV_SALA_VERSION hasta el PR de release que la publique, a
 * propósito: mientras tanto, lo que emita este código con la versión de ahora
 * también entra como estimado, que es el lado seguro. El espejo de la web
 * (apps/web/lib/metering/version.ts) lo ata `version.test.ts` leyendo este
 * fichero como texto.
 *
 * Casilla del PR de release: «¿cambia la regla de la referencia? → sube la
 * regla en tarifa.ts y esta MINIMA a la versión que la publica».
 */
export const VERSION_MINIMA_REFERENCIA = "0.4.24";
