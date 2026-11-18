/**
 * LA FRANJA DE ARRIBA DURANTE EL LANZAMIENTO EN PRODUCT HUNT (noviembre de 2026).
 *
 * Savings Layer sale en Product Hunt el domingo 22 de noviembre de 2026 a las
 * 9:00 de Andorra, que es medianoche en el Pacífico (el día de PH empieza a las
 * 00:00 PT). Mientras dura, la franja negra de BiVelio cede el sitio a una de
 * Product Hunt, y vuelve sola cuando acaba. Tres ventanas, en UTC:
 *
 *   · antes de LANZAMIENTO              → "aviso"   (salimos el día X: avísame)
 *   · de LANZAMIENTO a FIN_CAMPANA      → "en-vivo" (ya estamos: apóyanos)
 *   · desde FIN_CAMPANA                 → "bivelio" (la franja de siempre)
 *
 * Las fronteras son instantes absolutos (ms desde la época), no fechas de
 * calendario: no dependen de la zona horaria del visitante ni del servidor.
 * Todo lo de aquí es puro para poder probar las fronteras al milisegundo.
 */

/** Domingo 22-11-2026, 09:00 en Andorra (CET, UTC+1) = 08:00Z = 00:00 PT. */
export const LANZAMIENTO = Date.UTC(2026, 10, 22, 8, 0, 0);
/** Una semana después: la franja de BiVelio vuelve el domingo 29 a la misma hora. */
export const FIN_CAMPANA = Date.UTC(2026, 10, 29, 8, 0, 0);

/**
 * La página de producto en Product Hunt, con UTM PROPIOS de la web. Los enlaces
 * con `utm_source=linkedin` / `twitter` son los de los posts de esas redes: si
 * se usaran aquí, las visitas de la franja se apuntarían a LinkedIn o a X.
 */
export const URL_PRODUCT_HUNT =
  "https://www.producthunt.com/products/bivelio-savings-layer?utm_source=savings-site&utm_medium=announcement-bar&utm_campaign=launch";

/** En el orden en que se suceden: el índice es el tiempo. */
export const VARIANTES = ["aviso", "en-vivo", "bivelio"] as const;
export type Variante = (typeof VARIANTES)[number];

const instante = (ahora: number | Date) => (typeof ahora === "number" ? ahora : ahora.getTime());

/** Qué franja toca en el instante `ahora`. Cada frontera pertenece a la ventana que EMPIEZA en ella. */
export function elegirVariante(ahora: number | Date): Variante {
  const t = instante(ahora);
  // Un reloj roto (NaN) no debe dejar la web anunciando un lanzamiento pasado.
  if (Number.isNaN(t)) return "bivelio";
  if (t < LANZAMIENTO) return "aviso";
  if (t < FIN_CAMPANA) return "en-vivo";
  return "bivelio";
}

/** El instante de la próxima frontera estrictamente posterior a `ahora`, o null si ya no quedan. */
export function siguienteFrontera(ahora: number | Date): number | null {
  const t = instante(ahora);
  if (Number.isNaN(t)) return null;
  if (t < LANZAMIENTO) return LANZAMIENTO;
  if (t < FIN_CAMPANA) return FIN_CAMPANA;
  return null;
}

/**
 * La más avanzada de dos variantes. El servidor renderiza con la hora del
 * BUILD (las páginas son estáticas), que siempre es anterior o igual a la hora
 * real: es una cota inferior fiable. Un navegador con el reloj atrasado no
 * debe, por eso, devolver la franja a una ventana que ya pasó.
 */
export function laMasAvanzada(a: Variante, b: Variante): Variante {
  return VARIANTES.indexOf(a) >= VARIANTES.indexOf(b) ? a : b;
}

/** Las variantes que esta página aún puede llegar a enseñar, desde `desde` en adelante. */
export function alcanzables(desde: Variante): readonly Variante[] {
  return VARIANTES.slice(VARIANTES.indexOf(desde));
}

/**
 * Al partir en dos líneas (móvil), «Product Hunt» no se separa y la raya se
 * queda con la palabra de antes: nada de «Product / Hunt» ni de una línea que
 * empieza por «—». Espacios de no separación, en todos los idiomas a la vez.
 */
export const atado = (texto: string) => texto.replace(/Product Hunt/g, "Product\u00A0Hunt").replace(/ ([—–])/g, "\u00A0$1");

/** setTimeout guarda el retraso en un int32: por encima de ~24,8 días dispara al instante. */
export const RETRASO_MAXIMO = 2 ** 31 - 1;

/**
 * Cuánto esperar para reevaluar la franja: justo hasta cruzar la siguiente
 * frontera (+1 ms, para caer ya dentro de la ventana nueva), recortado al
 * máximo que admite setTimeout. Null: no hay nada más que esperar.
 */
export function esperaHastaLaFrontera(ahora: number | Date): number | null {
  const frontera = siguienteFrontera(ahora);
  if (frontera === null) return null;
  return Math.min(Math.max(frontera - instante(ahora) + 1, 0), RETRASO_MAXIMO);
}

/**
 * La fecha del lanzamiento en el idioma de la página («Sunday, November 22»,
 * «domingo, 22 de noviembre», «22 Kasım Pazar»…), con el día de la semana que
 * le corresponde. Se formatea en hora de Andorra, que es donde son las 9:00;
 * en el Pacífico es la medianoche del MISMO día, así que no cambia de fecha.
 *
 * Se llama en el SERVIDOR y viaja como texto al cliente: si cada lado lo
 * formateara con su propio ICU (Node frente al navegador), una coma de más
 * bastaría para un error de hidratación.
 */
export function fechaDelLanzamiento(locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "Europe/Andorra",
  }).format(LANZAMIENTO);
}
