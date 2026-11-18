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

/**
 * La fecha, sin cortes de línea feos: ni «22 / listopada» ni «22 de /
 * novembre». Desde el día (el primer número) hasta el final, los espacios
 * pasan a ser de no separación; si el número es lo último («November 22»),
 * también el espacio de antes. El día de la semana queda libre: la línea puede
 * partir antes del día («domenica / 22 novembre», «domingo, / 22 de
 * noviembre»), que es donde parte un buen tipógrafo. Pegarlo todo alargaba el
 * aviso a 3 líneas a 390 px en fr e it.
 */
export function fechaAtada(fecha: string): string {
  const i = fecha.search(/\d/);
  if (i < 0) return fecha;
  const dia = fecha.slice(i);
  const antes = /^\d+\.?$/.test(dia) ? fecha.slice(0, i).replace(/ $/, "\u00A0") : fecha.slice(0, i);
  return antes + dia.replace(/ /g, "\u00A0");
}

/**
 * La última palabra, aparte: va con la flecha en un `white-space: nowrap`
 * para que la flecha nunca se quede sola en la última línea. Un espacio de no
 * separación no basta: Chrome parte igual delante de un SVG en línea.
 */
export function partirCola(texto: string): [string, string] {
  const i = texto.lastIndexOf(" ");
  return i < 0 ? ["", texto] : [texto.slice(0, i + 1), texto.slice(i + 1)];
}

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

/** Lo que necesita `programarFranja` del entorno: el reloj y los temporizadores (en los tests, falsos). */
export interface Reloj {
  ahora: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

/**
 * El motor del cliente, fuera del componente para poder probarlo con relojes
 * falsos. Reevalúa ya (al montar), y programa un temporizador que dispara justo
 * al cruzar la siguiente frontera; `reevaluar` se puede llamar también desde
 * fuera (al volver a la pestaña, por si el equipo durmió y el temporizador se
 * retrasó). La variante nunca retrocede de `inicial` ni de la última vista: un
 * reloj atrasado no devuelve una ventana que ya pasó. `alCambiar` solo se
 * llama cuando la variante cambia. `cancelar` limpia el temporizador.
 */
export function programarFranja(
  inicial: Variante,
  alCambiar: (v: Variante) => void,
  reloj: Reloj,
): { variante: () => Variante; reevaluar: () => void; cancelar: () => void } {
  let actual = inicial;
  let id: unknown;
  let cancelada = false;
  const limpiar = () => {
    if (id !== undefined) reloj.clearTimeout(id);
    id = undefined;
  };
  const reevaluar = () => {
    if (cancelada) return;
    limpiar();
    const ahora = reloj.ahora();
    const v = laMasAvanzada(actual, elegirVariante(ahora));
    if (v !== actual) {
      actual = v;
      alCambiar(v);
    }
    // Con la franja de BiVelio ya no queda nada que esperar, diga lo que diga
    // un reloj atrasado.
    const espera = actual === "bivelio" ? null : esperaHastaLaFrontera(ahora);
    if (espera !== null) id = reloj.setTimeout(reevaluar, espera);
  };
  reevaluar();
  return {
    variante: () => actual,
    reevaluar,
    cancelar: () => {
      cancelada = true;
      limpiar();
    },
  };
}

/*
 * EL PRIMER PINTADO DE LAS PÁGINAS SIN ISR.
 *
 * Solo la portada y precios se regeneran (revalidate = 3600). Las demás páginas
 * públicas (cómo funciona, privacidad, paper, resultados, migración, alta,
 * contraseña…) son estáticas sin revalidación: su HTML lleva la variante del
 * BUILD hasta el siguiente despliegue. No basta con corregirla al hidratar: del
 * 22 al 29 pintarían primero el aviso y lo cambiarían por «en vivo», y desde el
 * 29 pintarían el coral y saltarían al negro, en cada carga. Darles ISR desde
 * el layout no es seguro: resultados y migración leen ../../docs al
 * renderizar, fuera del trazado de ficheros de la función, y en Vercel la
 * regeneración fallaría.
 *
 * Así que un guion en línea, ANTES de la franja y antes del primer pintado,
 * mira el reloj del navegador y, si la ventana ya pasó de la del build, añade
 * una hoja de estilo construida (`document.adoptedStyleSheets`): esconde con
 * `display: none` las variantes que ya pasaron (la franja mide lo mismo que
 * medirá después de hidratar), enseña la que toca y, si toca la de BiVelio,
 * deshace el coral. No toca el DOM (ni clases ni atributos), así que React
 * hidrata sobre el marcado del servidor sin ninguna discrepancia; al montar,
 * el componente pinta lo mismo con su estado y retira la hoja
 * (`retirarHojaPrevia`). Sin soporte de hojas construidas (navegadores de antes
 * de 2023) el guion no hace nada y la franja se corrige al hidratar, como
 * antes. La CSP ya admite guiones en línea ('unsafe-inline', como gtag).
 */

/** Dónde deja el guion la hoja, para que el componente la retire. */
export const CLAVE_HOJA_PREVIA = "__franjaPrevia";

/**
 * Lo que deshace el coral de PH para enseñar la franja de BiVelio antes de
 * hidratar: los colores de `.announce`, `.announce a` y `.announce-close` en
 * globals.css (el test comprueba que son los mismos). Hover y foco no hacen
 * falta: la hoja vive lo que tarda en hidratar.
 */
export const DESHACER_PH =
  ".announce--ph{background:var(--ink);color:#fff}" +
  ".announce--ph a{color:rgba(255,255,255,.92);text-decoration:none}" +
  ".announce--ph .announce-close{color:rgba(255,255,255,.6)}";

/** La hoja que pasa una franja construida en `desde` a `hasta` sin tocar el DOM. Vacía si no avanza. */
export function hojaPrevia(desde: Variante, hasta: Variante): string {
  const i = VARIANTES.indexOf(desde);
  const j = VARIANTES.indexOf(hasta);
  if (j <= i) return "";
  const reglas = VARIANTES.slice(i, j).map((v) => `.announce-pila>[data-v="${v}"]{display:none}`);
  reglas.push(`.announce-pila>[data-v="${hasta}"]{visibility:visible}`);
  if (hasta === "bivelio") reglas.push(DESHACER_PH);
  return reglas.join("");
}

/**
 * El guion en línea para una página construida con la variante `inicial`, o
 * null si ya no puede cambiar (construida después de la campaña). La hoja de
 * cada ventana es la de la franja más la de la insignia y la tarjeta de
 * Product Hunt (`hojaDelGuion`). Repite
 * `elegirVariante` con las fronteras escritas como números; el test lo
 * ejecuta en cada frontera y lo compara con la función.
 */
export function guionPrevio(inicial: Variante): string | null {
  const i = VARIANTES.indexOf(inicial);
  const hojas: Record<number, string> = {};
  for (let j = i + 1; j < VARIANTES.length; j++) hojas[j] = hojaDelGuion(inicial, VARIANTES[j]!);
  if (Object.keys(hojas).length === 0) return null;
  return (
    `try{var t=Date.now(),v=t<${LANZAMIENTO}?0:t<${FIN_CAMPANA}?1:2,h=${JSON.stringify(hojas)}[v];` +
    `if(h){var s=new CSSStyleSheet();s.replaceSync(h);` +
    `document.adoptedStyleSheets=document.adoptedStyleSheets.concat(s);window.${CLAVE_HOJA_PREVIA}=s}}catch(e){}`
  );
}

/** Retira la hoja del guion, si la puso. Se llama después de que el componente pinte lo mismo con su estado. */
export function retirarHojaPrevia(
  doc: { adoptedStyleSheets: CSSStyleSheet[] } = document,
  win: Record<string, unknown> = window as unknown as Record<string, unknown>,
): void {
  const hoja = win[CLAVE_HOJA_PREVIA];
  if (!hoja) return;
  doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((h) => h !== hoja);
  delete win[CLAVE_HOJA_PREVIA];
}

/*
 * LA INSIGNIA Y LA TARJETA DE PRODUCT HUNT (mismas ventanas que la franja).
 *
 * · La INSIGNIA oficial (tema light) va en el PIE de todas las páginas desde
 *   el lanzamiento y para siempre, y en el HÉROE de la portada solo la semana
 *   del lanzamiento. Antes del 22 no aparece en ningún sitio y su imagen no se
 *   pide: el HTML de un build de antes no lleva <img>, solo un hueco vacío de
 *   250×54 escondido (`data-ph-espera`) que el guion previo enseña si el reloj
 *   ya cruzó; al montar, el componente pone la imagen dentro del hueco.
 * · La TARJETA nativa al final de la portada cambia el texto del botón: «avísame»
 *   antes, «échale un vistazo» después. Los dos textos se apilan en la misma
 *   celda (como la franja): la tarjeta mide lo mismo en las tres ventanas.
 */

/** La insignia, tal cual la da Product Hunt (tema light). */
export const INSIGNIA_PH = {
  href: "https://www.producthunt.com/products/bivelio-savings-layer?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-bivelio-savings-layer",
  src: "https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1321519&theme=light&t=1795000351842",
  width: 250,
  height: 54,
  alt: "BiVelio Savings Layer - Cut LLM costs with an open-source savings layer | Product Hunt",
} as const;

/** El enlace que da Product Hunt para su tarjeta («post embed»). */
export const URL_TARJETA_PH = "https://www.producthunt.com/products/bivelio-savings-layer?embed=true&utm_source=embed&utm_medium=post_embed";

/** La miniatura propia de la tarjeta (nada de imgix ni imágenes de PH). */
export const MINIATURA_PH = "/brand/product-hunt-thumb-2026-11.png";

export const LUGARES_INSIGNIA = ["heroe", "pie"] as const;
export type LugarInsignia = (typeof LUGARES_INSIGNIA)[number];

/** ¿Va la insignia en `lugar` durante la ventana `v`? Héroe: solo en vivo. Pie: desde el lanzamiento, siempre. */
export function tocaInsignia(lugar: LugarInsignia, v: Variante): boolean {
  return lugar === "heroe" ? v === "en-vivo" : v !== "aviso";
}

/** ¿Puede llegar a ir la insignia en `lugar` en una página construida en `desde`? */
export function insigniaAlcanzable(lugar: LugarInsignia, desde: Variante): boolean {
  return alcanzables(desde).some((v) => tocaInsignia(lugar, v));
}

/**
 * La variante con la que ARRANCA un componente cliente de Product Hunt:
 *   · al hidratar, la del servidor (`inicial`), para que el marcado coincida;
 *     si el build es viejo, el guion previo ya enseñó antes del primer pintado
 *     lo que toca y el componente lo alcanza al montar;
 *   · montado después (navegación dentro de la web), ya la del reloj del
 *     navegador: el guion no vuelve a actuar —su hoja se retiró en la primera
 *     carga— y el payload RSC puede ser de un build viejo, así que partir de
 *     `inicial` pintaría primero lo que ya pasó y lo cambiaría al montar.
 * Nunca retrocede de `inicial` (un reloj atrasado no devuelve una ventana pasada).
 */
export function varianteAlMontar(inicial: Variante, hidratando: boolean, ahora: number | Date): Variante {
  return hidratando ? inicial : laMasAvanzada(inicial, elegirVariante(ahora));
}

/** El texto del botón de la tarjeta: «avísame» antes del lanzamiento; «échale un vistazo» desde él. */
export const botonDeLaTarjeta = (v: Variante): "aviso" | "vivo" => (v === "aviso" ? "aviso" : "vivo");

/**
 * Lo que la hoja del guion previo añade para la insignia y la tarjeta al pasar
 * de `desde` a `hasta`: enseña el hueco de la insignia donde ya toca (vacío:
 * la imagen la pone el componente al montar), esconde la del héroe cuando la
 * semana acabó y cambia el texto visible del botón de la tarjeta.
 */
export function hojaProductHunt(desde: Variante, hasta: Variante): string {
  if (VARIANTES.indexOf(hasta) <= VARIANTES.indexOf(desde)) return "";
  const reglas: string[] = [];
  for (const lugar of LUGARES_INSIGNIA) {
    const antes = tocaInsignia(lugar, desde);
    const ahora = tocaInsignia(lugar, hasta);
    if (!antes && ahora) reglas.push(`.ph-insignia[data-ph-espera="${lugar}"]{display:block}`);
    if (antes && !ahora) reglas.push(`.ph-insignia[data-ph="${lugar}"]{display:none}`);
  }
  if (botonDeLaTarjeta(desde) !== botonDeLaTarjeta(hasta)) {
    reglas.push(
      `.ph-pila>[data-ph-boton="${botonDeLaTarjeta(desde)}"]{visibility:hidden}`,
      `.ph-pila>[data-ph-boton="${botonDeLaTarjeta(hasta)}"]{visibility:visible}`,
    );
  }
  return reglas.join("");
}

/** La hoja completa del guion previo: la franja y, detrás, la insignia y la tarjeta. */
export function hojaDelGuion(desde: Variante, hasta: Variante): string {
  return hojaPrevia(desde, hasta) + hojaProductHunt(desde, hasta);
}
