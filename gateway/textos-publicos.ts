/**
 * LAS FRASES QUE SE REPITEN EN TODOS LOS MEDIOS DEL PAQUETE (1.2.4).
 *
 * La auditoría de medios (m17, m01, m03) encontró la misma idea escrita de
 * cinco maneras, tres de ellas falsas: «every local saving lever on» en el
 * cartel del gateway (con tres OFF debajo), en `--help`, en `doctor`, en `init`
 * y en los dos README. Aquí vive UNA redacción de cada una, y
 * `test/textos-del-paquete.test.ts` comprueba que el README de npm, el de PyPI,
 * la guía de terminales y la salida del CLI dicen exactamente estas.
 *
 * Solo texto: este módulo no decide nada del tráfico.
 */

// ── La sombra opcional: LOS DOS NOMBRES, EN UN SOLO SITIO ──────────────────
//
// Los pone la rama `fix/measure-ahorra-de-verdad` (la que hace que la licencia
// Measure ahorre y deja el «solo observar» como opción). Comprobados contra
// origin/fix/measure-ahorra-de-verdad: `src/pipeline/config.ts` → `observeOnly`
// y `gateway/bin.ts` → `BVSALA_GATEWAY_OBSERVE_ONLY`. Si cambian allí, se
// cambian AQUÍ y en las dos menciones literales del README (el test las compara
// con estas constantes).

/** La opción del SDK que deja la capa en «solo observar» (no aplica ninguna palanca). */
export const OPCION_SDK_SOLO_OBSERVAR = "observeOnly";
/** La variable del gateway que hace lo mismo en `bvsala`. */
export const VARIABLE_GATEWAY_SOLO_OBSERVAR = "BVSALA_GATEWAY_OBSERVE_ONLY";

// ── m17 · qué va encendido y qué no ────────────────────────────────────────

/**
 * El SDK. Seis palancas por defecto, medidas con proveedores falsos (informe
 * a-sdk y revisión e): caché exacta, deduplicación de simultáneas, resolutores
 * locales, colocación de la caché del proveedor, elisión de resultados de
 * herramientas sustituidos y serialización compacta de `structuredData`.
 */
export const FRASE_PALANCAS_SDK =
  "Every lever is included and free, with no key. On by default: exact cache, deduplication, local resolvers, " +
  "prompt-cache placement, trimming of superseded tool results and compact serialization of the structured data " +
  "you pass. The rest you switch on, one line each.";

/** El gateway: una de cuatro. */
export const FRASE_PALANCAS_GATEWAY =
  "Every gateway lever is free, with no key; one is on by default (cache TTL tuning) and the others you switch on.";

// ── m01 · qué añade una clave ──────────────────────────────────────────────

/** Qué es lo de pago. Sin «shared caches»: BiVelio no aloja ninguna caché (m03). */
export const LO_QUE_ANADE_LA_NUBE = "the team dashboard, shared measurement, seats and license management";

/**
 * La clave solo añade. Decisiones del dueño (21-11-2026): la licencia gratuita
 * Measure aplica EXACTAMENTE las mismas palancas que sin clave (21:45 UTC, también
 * el recorte); la única excepción en el SDK es de las licencias de pago: con
 * ellas, el recorte de resultados de herramientas sustituidos solo actúa dentro
 * del bucle de herramientas en Anthropic. README, PyPI e `init`.
 */
export const FRASE_LA_CLAVE_SOLO_ANADE =
  "In the SDK, a BiVelio key only adds the cloud: the free Measure license applies exactly the same levers as no key. " +
  "A paid license (Pro, Team, Enterprise) does too, except trimming of superseded tool results, which with a paid " +
  "license only acts inside a tool loop on Anthropic.";

/**
 * Los adaptadores de marco (AI SDK, Mastra, LangChain, Anthropic SDK) no tienen
 * ese recorte ni ninguna palanca que reescriba la petición, así que en ellos la
 * clave solo añade la nube, sin excepción. `init` en esas pilas.
 */
export const FRASE_LA_CLAVE_SOLO_ANADE_ADAPTADOR =
  "A BiVelio key only adds the cloud: with the free Measure license or a paid one, the adapter applies the same " +
  "levers as no key.";

/**
 * Qué hace un adaptador sin clave (auditoría de lo gratis, 21-11-2026: `init`
 * prometía a los adaptadores la colocación de caché, el recorte, la
 * serialización y `observeOnly`, que no tienen). Lo mismo que el README en
 * «Inside your framework». Mastra no comparte las peticiones idénticas en vuelo.
 */
export function frasePalancasAdaptador(enMastra: boolean): string {
  return (
    "Every lever is included and free, with no key. The adapter answers exact repeats, " +
    (enMastra ? "" : "identical requests already in flight, ") +
    "and the questions the layer computes locally, without calling the model; it never rewrites what your framework " +
    "sends (prompt-cache placement, trimming of superseded tool results and serialization run in `createSavingsLayer`)."
  );
}

/** El README lo dice igual («Inside your framework» y el párrafo de solo observar). */
export const FRASE_ADAPTADOR_SIN_SOLO_OBSERVAR =
  "The framework adapters have no observe-only mode: switch their levers off with `savings`.";

/**
 * Lo mismo para el gateway (`--help`), que no tiene ese recorte. Decisiones del
 * dueño (21-11-2026): Medir = sin clave; con una licencia de pago, el gateway
 * como en la 1.2.3 de pago (cada palanca pide su feature en la licencia de la
 * org, fail-closed). Por eso aquí no se dice «switches no lever off» a secas.
 */
export const FRASE_LA_CLAVE_SOLO_ANADE_GATEWAY =
  "A BiVelio key adds the cloud. The free Measure license applies the same levers as no key; with a paid license " +
  "the gateway works as in 1.2.3: each lever also needs your organization's license to include it, checked " +
  "fail-closed.";

/** `doctor` y la guía de terminales: qué hace la clave de servicio con las palancas del gateway. */
export const FRASE_CLAVE_DE_SERVICIO_Y_PALANCAS =
  "With the free Measure license it switches no lever off; with a paid license the levers follow that license, " +
  "as in 1.2.3 (checked fail-closed: with no service key, or while savings.bivelio.com cannot confirm it, " +
  "requests travel untouched).";

/**
 * LA DEPENDENCIA QUE TRAE UNA CLAVE (verificación final de la 1.2.4, bloqueante 3).
 *
 * «La clave solo añade la nube» es cierto para las palancas, pero con una clave
 * la capa pasa a depender de savings.bivelio.com y el README no lo contaba. Dos
 * frases porque son dos dependencias distintas (SECURITY.md, «Availability»):
 *
 *  · el SDK con `licenseServerUrl` (la receta del README, de `init` y del
 *    panel): 72 h sin respuesta confirmada → `LicenseError` `stale` en cada
 *    llamada, hasta que vuelva a contestar o se quite la clave
 *    (src/pipeline/create.ts `DEFAULT_MAX_STALENESS_SECONDS`; el test compara
 *    la cifra con esa constante). Vale también para la clave gratuita Measure.
 *  · el gateway con `BIVELIO_SERVICE_KEY`: necesita el servidor para ARRANCAR
 *    (o un `BIVELIO_LICENSE_KEY` válido de respaldo); ya en marcha no tiene
 *    límite de 72 h (gateway/license.ts, SECURITY.md).
 *
 * Sin clave no hay ninguna de las dos.
 */
export const FRASE_DEPENDENCIA_SDK =
  "One dependency comes with a key, the free Measure key included: with `licenseServerUrl` set (as in the recipe " +
  "your dashboard and `init` print), a layer that goes 72 hours without an answer from savings.bivelio.com fails " +
  "closed with `LicenseError` on every call until it gets one or you remove the key. With no key there is no such " +
  "dependency.";

/** La del gateway (`bvsala`): el arranque, no las 72 h. */
export const FRASE_DEPENDENCIA_GATEWAY =
  "One dependency comes with a key, the free Measure key included: with BIVELIO_SERVICE_KEY set, the gateway needs " +
  "savings.bivelio.com to start (or a valid BIVELIO_LICENSE_KEY as a fallback); once running it keeps serving " +
  "without it. With no key there is no such dependency.";

/** Donde se cuenta entero: SECURITY.md no viaja en el paquete, así que el enlace es absoluto. */
export const URL_DISPONIBILIDAD =
  "https://github.com/BiVelio/bivelio-savings-layer/blob/main/SECURITY.md#availability-what-happens-if-our-servers-do-not-respond";

// ── El cartel de arranque del gateway ──────────────────────────────────────

/**
 * La primera línea sin claves. Sustituye en pantalla a la de
 * `gateway/license.ts` («every local saving lever on»), que otra rama tiene
 * abierta y aquí no se toca: `bin.ts` imprime esta cuando el arranque es
 * comunitario.
 */
export const LINEA_MODO_COMUNITARIO =
  "COMMUNITY MODE (open core): no BiVelio keys set - free, zero telemetry, nothing sent to BiVelio";

/**
 * La línea de las palancas sin claves: qué actúa por defecto, que con
 * suscripción solo se mide, y la variable exacta de cada una de las demás.
 */
export const LINEA_PALANCAS_SIN_CLAVE =
  "savings levers (community mode: free, no key needed): cache TTL tuning is the only one ON by default and it " +
  "only acts on Anthropic API-key traffic that asks for the 1-hour cache - on a Claude or ChatGPT subscription " +
  "the default lever changes nothing and this run only measures · BVSALA_GATEWAY_ELISION=0 turns it off · opt-in: BVSALA_GATEWAY_SIBLING_MODEL=1, " +
  "BVSALA_GATEWAY_EFFORT=low|medium";

/**
 * La línea de las palancas en modo SOLO-OBSERVAR (`BVSALA_GATEWAY_OBSERVE_ONLY=1`).
 * Sustituye a la de arriba y a las del modelo hermano y el esfuerzo: hasta la
 * verificación final de la 1.2.4 el cartel decía «cache TTL tuning is the only
 * one ON by default» justo encima del aviso de OBSERVE-ONLY, que no aplica ninguna.
 */
export const LINEA_PALANCAS_SOLO_OBSERVAR =
  "savings levers: OBSERVE-ONLY (BVSALA_GATEWAY_OBSERVE_ONLY=1) - no lever is applied, not cache TTL tuning nor " +
  "any opt-in one; what cache TTL tuning and the sibling model would have saved goes to the per-request " +
  "`measure (shadow)` lines, never counted as a saving. Unset the variable to save.";

/**
 * La línea de `BVSALA_GATEWAY_COALESCE=1` al arrancar (e2e del 22-11: era la
 * única opción sin línea). En solo-observar la coalescencia no actúa
 * (servidor.ts, `coalescible` exige `!enMedicion`), y la línea lo dice.
 */
export function lineaDeCoalescencia(soloObservar: boolean): string {
  return soloObservar
    ? "duplicate-request coalescing: OFF in observe-only mode (BVSALA_GATEWAY_COALESCE=1 is ignored: every request " +
        "travels as sent)"
    : "duplicate-request coalescing: ON (BVSALA_GATEWAY_COALESCE=1, experimental) - a request identical to one " +
        "still in flight (messages, chat/completions, responses, embeddings) gets that request's answer instead of " +
        "a second upstream call; its log line says COALESCED (call avoided)";
}

/**
 * `BVSALA_GATEWAY_SHADOW=1` sin clave de servicio: el carril sombra solo existe
 * con emisor (servidor.ts, `carrilSombra`), así que se ignora. Hasta la 1.2.4
 * no lo decía nada (e2e del 22-11). No cambia ninguna palanca.
 */
export const LINEA_SOMBRA_SIN_CLAVE =
  "shadow lane: ignored - BVSALA_GATEWAY_SHADOW=1 needs BIVELIO_SERVICE_KEY (its estimates only go to the cloud " +
  "dashboard); nothing else changes";

/**
 * Parte una frase en líneas de `ancho` columnas como mucho, con `sangria`
 * delante de cada una: para imprimir las frases de arriba en la ayuda, en
 * `doctor` y en `init` sin reescribirlas a mano en cada sitio.
 */
export function enLineas(texto: string, ancho: number, sangria = ""): string[] {
  const lineas: string[] = [];
  let actual = "";
  for (const palabra of texto.split(/\s+/).filter((p) => p.length > 0)) {
    if (actual !== "" && sangria.length + actual.length + 1 + palabra.length > ancho) {
      lineas.push(sangria + actual);
      actual = palabra;
    } else {
      actual = actual === "" ? palabra : `${actual} ${palabra}`;
    }
  }
  if (actual !== "") lineas.push(sangria + actual);
  return lineas;
}
