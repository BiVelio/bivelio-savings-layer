/**
 * SALIDA QUE DEBE VARIAR, O QUE DEPENDE DEL RELOJ (auditoría del 2026-11-19, N6).
 *
 * «Dame una contraseña aleatoria», «Generate a new UUID», «Roll a dice», «What
 * time is it in Tokyo?»: la respuesta CORRECTA a la segunda petición idéntica no
 * es la de la primera. Sin `temperature` (lo normal) la caché exacta las
 * guardaba 24 h y le daba la misma contraseña a todo el que la pidiera, apuntada
 * como llamada evitada.
 *
 * Esto es lo MÍNIMO: una lista corta de frases, en inglés y en español, que
 * apaga la caché exacta y la semántica para esas peticiones. No toca cómo se
 * trata la ausencia de `temperature` (esa decisión es del dueño), ni lo
 * creativo en general («escribe un poema», «cuéntame un chiste»).
 *
 * Es una heurística LÉXICA y CONSERVADORA, como `tema-sensible.ts`: se equivoca
 * hacia el lado barato. Un falso positivo cuesta un acierto de caché —la
 * petición va al proveedor y se mide como siempre—; un falso negativo deja el
 * comportamiento de antes. Solo mira los turnos de USUARIO.
 *
 * Los textos llegan NORMALIZADOS (`normalizeText`): minúsculas, sin tildes y
 * sin puntuación de frase, así que «¿Qué hora es?» es «que hora es».
 */

/** Lo que se pide generar y nadie quiere recibir repetido. */
const SECRETO = "uuid|guid|password|passphrase|passcode|contrasena|token|nonce|salt|otp";

/** Pide algo AL AZAR. Sin efecto con `seed`: quien fija la semilla pide que se repita. */
const AZAR = new RegExp(
  [
    // «random», salvo los términos técnicos que se EXPLICAN, no se sortean.
    "\\brandom(?:ly|i[sz]e|i[sz]ed)?\\b(?!\\s+(?:forests?|access|variables?|walks?|effects?))",
    "\\bat random\\b",
    "\\bshuffle\\b",
    // es: «aleatorio/a», «al azar», salvo «variable aleatoria», «bosque aleatorio», «acceso aleatorio».
    "(?<!\\b(?:variables?|bosques?|acceso|efectos?)\\s)\\baleatori[oa]s?\\b",
    "\\baleatoriamente\\b",
    "\\bal azar\\b",
    "\\bbaraja(?:r)?\\b",
    // Un identificador o un secreto NUEVO: el verbo y el objeto en la misma frase.
    `\\b(?:generate|create|make|give me|new|another|genera|generame|generar|crea|creame|crear|dame|nuevo|nueva|otro|otra)\\b[^\\n]{0,40}\\b(?:${SECRETO})\\b`,
    // Dados y monedas.
    "\\broll (?:a |the |an? |\\d+ )?(?:dice|die|d\\d+)\\b",
    "\\b(?:flip|toss) (?:a |the )?coin\\b",
    "\\bheads or tails\\b",
    "\\b(?:tira|tirar|lanza|lanzar) (?:un |una |el |la |los |\\d+ )?(?:dados?|moneda)\\b",
    "\\bcara o cruz\\b",
    // «Sorpréndeme».
    "\\bsurprise me\\b",
    "\\bsorprendeme\\b",
  ].join("|"),
  "i",
);

/** Pregunta por el reloj o el calendario de AHORA. Ni `seed` ni `temperature: 0` la hacen cacheable. */
const RELOJ = new RegExp(
  [
    "\\bwhat time is it\\b",
    "\\bwhat(?:'s| is) the (?:time|date|current time|current date)\\b",
    "\\bwhat(?:'s| is) today'?s date\\b",
    "\\bwhat (?:day|date|month|year) is (?:it|today)\\b",
    "\\bcurrent (?:time|date|timestamp)\\b",
    "\\bque hora (?:es|son|tienes|tiene)\\b",
    "\\bque (?:dia|fecha|mes|ano) es\\b",
    "\\ba que (?:dia|fecha) estamos\\b",
    "\\ben que (?:dia|mes|ano) estamos\\b",
    "\\b(?:hora|fecha) actual\\b",
  ].join("|"),
  "i",
);

/** Por qué la respuesta no debe salir de una caché, o `null` si no hay motivo. */
export type SalidaVariable = "random" | "clock";

/**
 * ¿Pide el texto (ya normalizado) de algún turno de usuario una salida que debe
 * variar o que depende del reloj?
 *
 * @param textos los turnos de usuario, pasados por `normalizeText`.
 * @param conSemilla `true` si la petición fija `seed`: lo aleatorio se repite a propósito.
 */
export function salidaVariableEnTextos(textos: readonly string[], conSemilla: boolean): SalidaVariable | null {
  for (const texto of textos) {
    if (RELOJ.test(texto)) return "clock";
  }
  if (conSemilla) return null;
  for (const texto of textos) {
    if (AZAR.test(texto)) return "random";
  }
  return null;
}
