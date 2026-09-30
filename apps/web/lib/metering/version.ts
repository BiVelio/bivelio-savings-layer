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

import { parsearVersion } from "@/lib/version/semver";

export const CABECERA_VERSION = "x-bvsala-version";

/**
 * Espejo de `VERSION_MINIMA_REFERENCIA` (src/version.ts): la primera versión
 * del proceso emisor cuyos registros `basis: "reference"` siguen la regla que
 * sella el extracto (`REGLA_REFERENCIA.version`, lib/billing/tarifa.ts) y que
 * ya no repiten una negativa del proveedor como referencia. Se cambia aquí y en
 * el SDK a la vez; `version.test.ts` ata los dos.
 *
 * 0.4.35 (antes 0.4.33, 0.4.32, 0.4.31, 0.4.29 y 0.4.24): de la 0.4.24 a la 0.4.28 el SDK
 * podía guardar una negativa en caché y repetirla como `reference`. #356
 * (0.4.27) cerró la de `content_filter`/`refusal`; #367 (0.4.29) la de salidas
 * estructuradas de OpenAI (`message.refusal`). Decisión del dueño
 * (BITACORA-2026-09-26 §8): el coste —las referencias honestas de 0.4.24-0.4.28
 * también entran como `estimated`— se acepta. Y hasta la 0.4.30 seguía
 * repitiendo la negativa que el modelo escribe como TEXTO normal, sin señal del
 * API; #384 la cierra en la 0.4.31 (decisión del dueño, 2026-09-28: mismo
 * criterio, mismo coste para 0.4.29 y 0.4.30). Y la 0.4.31 todavía repetía
 * negativas que ni el API ni #384 señalaban: el `content_filter: OTHER` de
 * Gemini (#402), «I'm sorry, but … is illegal», «I can't determine / argue…»,
 * la redirección a ayuda profesional (#393, #401) y las respuestas a temas
 * sensibles (#393). Salen en la 0.4.32 (decisión del dueño, 2026-09-29: mismo
 * criterio, mismo coste para 0.4.31). Y la 0.4.32 todavía repetía las
 * negativas PARCIALES (la respuesta empieza cumpliendo y se niega después:
 * «If you mean harming someone, I can't help locate targets») y la carencia
 * tras una disculpa («I'm sorry, but I don't have access to personal data…»),
 * que vio el primer banco semanal en vivo. #422 las cierra en la 0.4.33
 * (decisión del dueño, 2026-09-29: «arreglar primero siempre»; mismo criterio,
 * mismo coste para 0.4.32). Y hasta la 0.4.34 repetía la negativa escrita
 * DENTRO de una salida estructurada: con un contrato de salida estricto,
 * gpt-4o-mini no usa `message.refusal` y escribe la negativa en el JSON
 * (`{"steps":["This request cannot be fulfilled as it involves illegal
 * activities…"]}`), y el detector leía el JSON como prosa. La vio una sonda en
 * vivo; #431 la cierra en la 0.4.35 (decisión del dueño, 2026-09-30:
 * «arreglar primero siempre»; mismo criterio, mismo coste para 0.4.33 y
 * 0.4.34). El detalle, en src/version.ts.
 */
export const VERSION_MINIMA_REFERENCIA = "0.4.35";

/**
 * ¿Puede entrar como `reference` un registro de un proceso que declara esta
 * versión? Solo si la declara, es del SDK (`sdk/`) y es la mínima o posterior.
 *
 * `gateway/` NO, a propósito: la regla v2 vive en el pipeline del SDK
 * (src/pipeline/referencia.ts) y el gateway no pasa por él. La gemela
 * coalescida del gateway (Parte G, PR #322) emite referencias con su propio
 * código: acredita salida con `temperature: 0` y la guarda de MODELO de la v2
 * (`salidaNoRepetible`), pero no lee los tokens de razonamiento que declaró la
 * primaria, que la v2 también exige. Si se admitieran con una versión ≥ la
 * mínima, sus referencias entrarían bajo el sello «reference-v2» sin cumplirla
 * entera. El PR que lleve al gateway la regla v2 completa abre aquí `gateway/`
 * con su propia mínima, en el mismo cambio.
 *
 * Por qué hace falta: la regla con la que el SDK valoró una repetición NO viaja
 * en el registro de uso, y el cierre sella la del servidor para el extracto
 * entero. La etiqueta v0.4.23 lleva la regla v1 (salida acreditada sin guarda
 * de razonamiento, esquema admitido sin modo estricto): si alguien la publica,
 * sus referencias no pueden sellarse como «reference-v2». Y de la 0.4.24 a la
 * 0.4.34 una referencia puede ser la repetición de una negativa, que no es una
 * respuesta. Entran como `estimated`, que siguen contando en los totales pero
 * no en la base.
 *
 * El lado seguro en cada duda: sin versión declarada → no; una preliminar de la
 * propia mínima (`0.4.35-rc.1`, que en semver va ANTES de `0.4.35`) → no.
 */
export function admiteReferencia(version: string | null): boolean {
  const v = parsearVersion(version);
  if (!v || v.superficie !== "sdk") return false;
  const minima = parsearVersion(VERSION_MINIMA_REFERENCIA)!;
  for (let i = 0; i < 3; i++) {
    const d = v.partes[i]! - minima.partes[i]!;
    if (d !== 0) return d > 0;
  }
  // Igual a la mínima en los tres números: solo la final, no una preliminar.
  return !/-/.test(version!.slice(version!.indexOf("/") + 1));
}

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
