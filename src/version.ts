/**
 * The version the SDK reports for itself.
 *
 * Written by hand and deliberately NOT read from package.json: the published
 * bundle does not ship package.json, so a `require` here would fail at runtime
 * on the customer's machine. `test/version-declarada.test.ts` ties this
 * constant to package.json so the two can never drift.
 */
export const BV_SALA_VERSION = "0.4.31";

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
 * con la regla v2 (`reference-v2`) y que ya no repite una negativa del proveedor
 * como `reference`. Tres subidas:
 *
 *   · 0.4.24 (#323): la etiqueta v0.4.23 se cortó con la regla v1 (abajo).
 *   · 0.4.29 (decisión del dueño, BITACORA-2026-09-26 §8): de la 0.4.24 a la
 *     0.4.28 el SDK podía guardar en caché una negativa y repetirla por
 *     referencia, comisionable. #356 (E7, en la 0.4.27) lo cerró para
 *     `finish_reason: "content_filter"` / `stop_reason: "refusal"`; #367 (en la
 *     0.4.29) para la negativa de salidas estructuradas de OpenAI
 *     (`message.refusal` con `finish_reason: "stop"`), que la 0.4.27 y la 0.4.28
 *     todavía guardaban y repetían. La mínima es la primera que cierra las dos.
 *     El coste, aceptado: las referencias honestas de 0.4.24-0.4.28 también
 *     entran como `estimated`.
 *   · 0.4.31 (decisión del dueño, 2026-09-28): hasta la 0.4.30 el SDK guardaba
 *     en caché y repetía como `reference` una negativa que el modelo escribe
 *     como TEXTO normal («I'm sorry, but I can't help with that.» con
 *     `end_turn`/`stop`), sin ninguna señal del API: ni `refusal`, ni
 *     `message.refusal`, ni `content_filter`. #356, #367 y #374 solo excluían
 *     las que señala el API. #384 (commit edb168c, que no está en la v0.4.30)
 *     las detecta con una heurística conservadora y ni las guarda ni las
 *     acredita; sale en la 0.4.31. Mismo criterio que la subida anterior: la
 *     primera versión que cierra el agujero, y el coste aceptado —las
 *     referencias honestas de 0.4.29 y 0.4.30 también entran como `estimated`.
 *
 * La etiqueta v0.4.23 se cortó con la regla v1
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
 * regla en tarifa.ts y esta MINIMA a la versión que la publica». Y «¿cierra un
 * caso en que el SDK emitía una referencia que no debía? → esta MINIMA sube a
 * la versión que lo publica, o se deja escrito por qué no».
 */
export const VERSION_MINIMA_REFERENCIA = "0.4.31";
