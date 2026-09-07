/**
 * El canal de versión, lado servidor (migración 0024).
 *
 * El emisor de uso declara la versión de su PROCESO en la cabecera
 * `x-bvsala-version` («gateway/0.4.16» o «sdk/0.4.16»), fuera del cuerpo y por
 * tanto fuera de la lista blanca de `usage.ts`: un servidor que no la conozca la
 * ignora y nada se rompe. Aquí se VALIDA con un patrón cerrado (superficie +
 * semver, jamás texto libre) y se SELLA en los registros YA validados como
 * `clientVersion`, que la RPC 0024 guarda por asiento-día.
 *
 * Tres reglas, todas con test:
 *   · `versionDeclarada` JAMÁS lanza: una cabecera rara (repetida «a, b», larga,
 *     con superficie desconocida) es «sin declarar», nunca un 400 — un 4xx
 *     descarta el lote sin reintento y eso sería perder facturación por un
 *     detalle de transporte.
 *   · `clientVersion` NO entra en USAGE_ALLOWED_FIELDS: un cuerpo que lo traiga
 *     por su cuenta sigue dando 400. Solo el servidor escribe la versión.
 *   · Se sella también en los registros `basis: "shadow"`; es inocuo porque la
 *     RPC hace `continue` en el carril sombra antes del upsert de seat_activity.
 *
 * Espejo de `src/version.ts` (la web no importa del SDK): `version.test.ts` lee
 * ese fichero como texto y afirma que el nombre de la cabecera no deriva.
 */

export const CABECERA_VERSION = "x-bvsala-version";

/** superficie/semver con sufijo opcional. El MISMO patrón que bvsala.semver_key (0024). */
const VERSION_PATTERN = /^(gateway|sdk)\/\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,16})?$/;
const VERSION_MAX_LEN = 40;

/**
 * La versión que declara la cabecera, o `null` si no hay cabecera o no casa el
 * patrón. Nunca lanza. Cabeceras repetidas llegan unidas («a, b») → no casan →
 * null: «sin declarar», que es lo honesto cuando dos procesos hablan a la vez.
 */
export function versionDeclarada(cabecera: string | null | undefined): string | null {
  if (!cabecera) return null;
  const v = cabecera.trim();
  return v.length <= VERSION_MAX_LEN && VERSION_PATTERN.test(v) ? v : null;
}

/**
 * Sella `clientVersion` en cada registro. Se llama SOLO sobre el array que
 * devuelve `parseUsageRecords` (nunca sobre el JSON crudo): así la lista blanca
 * ya rechazó cualquier `clientVersion` que viniera del cliente. Con `null` no
 * toca nada: la RPC lee `nullif(r->>'clientVersion','')` y cuenta el registro
 * como «sin versión».
 */
export function sellarVersion(records: Array<Record<string, unknown>>, version: string | null): void {
  if (!version) return;
  for (const r of records) r["clientVersion"] = version;
}
