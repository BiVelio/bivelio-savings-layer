/**
 * LAS PLATAFORMAS DE LANZAMIENTO (noviembre–diciembre de 2026).
 *
 * Savings Layer se presenta en varias plataformas a la vez (Product Hunt,
 * DevHunt y las que vengan). Este fichero es el ÚNICO sitio donde se declaran;
 * de él salen los dos huecos de la web que las enseñan:
 *
 *   · la FRANJA de arriba (AnnouncementBar), en todas las páginas;
 *   · la TARJETA del final de la portada (TarjetaLanzamiento), un carrusel.
 *
 * En cada carga de página el reparto es al azar: una plataforma en la franja y
 * OTRA en la tarjeta. Al avanzar el carrusel, la franja toma la que la tarjeta
 * acaba de soltar: nunca enseñan la misma, y con dos plataformas las dos están
 * siempre a la vista.
 *
 * ── CÓMO AÑADIR UNA PLATAFORMA ─────────────────────────────────────────────
 *   1. Añade una entrada a `PLATAFORMAS` (abajo): id, nombre, las URL de la
 *      ficha, `desde`/`hasta` en UTC, si se anuncia antes de abrir (`aviso`),
 *      los colores (texto sobre fondo ≥ 4,5:1: lo comprueba la prueba) y el
 *      icono (los trazos de su logotipo, en un viewBox).
 *   2. Si la plataforma da una insignia, guarda su SVG en public/brand/ y
 *      apúntalo en `insignia`.
 *   3. Nada más: ni componentes, ni estilos, ni traducciones. Los textos son
 *      plantillas con `{platform}` (messages/*.json: `nav.launchSoon`,
 *      `nav.launchLive` y `landing.launch.*`). Si en algún idioma el nombre
 *      pide otra forma, añade en ese idioma la clave con el id detrás
 *      (`launchLive_<id>`, `kicker_<id>`…): gana a la plantilla.
 *   `npx vitest run apps/web/lib/plataformas-de-lanzamiento.test.ts` lo revisa.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Todo lo de aquí es puro (sin React ni DOM) para probarlo al milisegundo.
 */

export interface Plataforma {
  /** Minúsculas, cifras y guiones. Va en atributos del HTML y en claves de texto. */
  id: string;
  /** El nombre, igual en todos los idiomas. */
  nombre: string;
  /** La ficha del producto en la plataforma: el enlace de la franja y el de la tarjeta (UTM propios si los admite). */
  ficha: { franja: string; tarjeta: string };
  /** Desde cuándo está publicada (instante UTC, ms). */
  desde: number;
  /** Hasta cuándo se anuncia en la franja. Después sigue en la tarjeta, sin fecha de salida. */
  hasta: number;
  /** ¿Se anuncia ANTES de `desde`? («Lanzamos el domingo — avísame»). Si no, no sale hasta `desde`. */
  aviso: boolean;
  /** El color de la plataforma: fondo de la franja y del botón, su texto, y el fondo al pasar el ratón. */
  color: { fondo: string; texto: string; realce: string };
  /** Su logotipo como trazos rellenos (`currentColor`), para la franja. */
  icono: { viewBox: string; trazos: readonly string[] };
  /** La insignia que da la plataforma, si la da: SVG local en public/ y de dónde salió. */
  insignia?: { claro: string; oscuro?: string; width: number; height: number; alt: string; origen: string };
}

/** Domingo 22-11-2026, 09:00 en Andorra (CET, UTC+1) = 08:00Z = 00:00 PT: el día de Product Hunt. */
const LANZAMIENTO_PH = Date.UTC(2026, 10, 22, 8, 0, 0);
/** Dos semanas después: domingo 6-12-2026 a la misma hora. La franja de BiVelio vuelve entonces. */
const FIN_DE_LA_CAMPANA = Date.UTC(2026, 11, 6, 8, 0, 0);

export const PLATAFORMAS: readonly Plataforma[] = [
  {
    id: "product-hunt",
    nombre: "Product Hunt",
    ficha: {
      // UTM PROPIOS de la web: los de `utm_source=linkedin`/`twitter` son de los
      // posts de esas redes y apuntarían las visitas a ellas.
      franja: "https://www.producthunt.com/products/bivelio-savings-layer?utm_source=savings-site&utm_medium=announcement-bar&utm_campaign=launch",
      // El enlace que da Product Hunt para su tarjeta («post embed»).
      tarjeta: "https://www.producthunt.com/products/bivelio-savings-layer?embed=true&utm_source=embed&utm_medium=post_embed",
    },
    desde: LANZAMIENTO_PH,
    hasta: FIN_DE_LA_CAMPANA,
    aviso: true,
    // Coral de PH con texto TINTA: 6,33:1 (el blanco daría 2,96:1 y no pasa AA).
    color: { fondo: "#FF6154", texto: "#0F1218", realce: "#FF7366" },
    icono: { viewBox: "0 0 24 24", trazos: ["M12 5.5 19.5 17.5h-15Z"] },
  },
  {
    id: "devhunt",
    nombre: "DevHunt",
    ficha: {
      franja: "https://devhunt.org/tool/bivelio-savings-layer",
      tarjeta: "https://devhunt.org/tool/bivelio-savings-layer",
    },
    // Ya publicada cuando se añadió (20-11-2026); acaba con la campaña.
    desde: Date.UTC(2026, 10, 20, 0, 0, 0),
    hasta: FIN_DE_LA_CAMPANA,
    aviso: false,
    // Los colores de su insignia oscura: pizarra con texto casi blanco (17:1).
    color: { fondo: "#0F172A", texto: "#F8FAFC", realce: "#1E293B" },
    icono: {
      viewBox: "0 0 107 107",
      trazos: [
        "M35.542 30.5714C52.191 15.1556 75.5192 0.0305717 102.985 0L106.809 3.82143C106.84 31.4352 91.7479 54.784 76.3359 71.4299V103.179L72.5191 107H49.6183L46.9235 105.884L39.2977 98.2488L39.2289 98.241L8.69452 67.6696L8.68674 67.6012L1.12211 60.0267L0 57.3214V34.3929L3.81679 30.5714H35.542ZM27.809 38.2143H7.63359V55.7467L10.8241 58.9261C15.97 51.614 21.6472 44.6915 27.809 38.2143ZM47.9389 96.1244L51.145 99.3571H68.664V79.1878C62.1846 85.3399 55.2572 91.0011 47.9389 96.1244ZM76.1182 39.7929C76.7122 42.7755 76.0988 45.8727 74.4121 48.4023H74.4044C72.7183 50.9309 70.0974 52.6851 67.1189 53.2793C64.1404 53.8735 61.0487 53.2587 58.5226 51.5701C55.9972 49.8814 54.245 47.2578 53.6516 44.2757C53.0581 41.2936 53.6721 38.1981 55.3587 35.6691C57.0453 33.1394 59.6663 31.384 62.6453 30.7893C65.6244 30.1945 68.7178 30.8088 71.2443 32.4974C73.7709 34.1861 75.5242 36.8102 76.1182 39.7929Z",
        "M22.9008 99.3571V107H0V84.0714H7.63359V99.3571H22.9008Z",
      ],
    },
    // Los dos SVG que sirve DevHunt, byte a byte. Hoy no se pintan en ninguna
    // página (el dueño los quitó del héroe y del pie el 20-11); quedan listos.
    insignia: {
      claro: "/brand/devhunt-featured-light.svg",
      oscuro: "/brand/devhunt-featured-dark.svg",
      width: 220,
      height: 54,
      alt: "BiVelio Savings Layer - Featured on DevHunt",
      origen: "https://devhunt.org/badge/bivelio-savings-layer.svg",
    },
  },
];

export const plataforma = (id: string, lista: readonly Plataforma[] = PLATAFORMAS): Plataforma | undefined => lista.find((p) => p.id === id);

/** `antes`: anunciada, aún sin abrir. `durante`: abierta, en campaña. `despues`: campaña acabada (solo tarjeta). */
export type EstadoPlataforma = "antes" | "durante" | "despues";

/** El estado de `p` en el instante `t`, o null si todavía no se enseña (sin aviso previo). Un reloj roto (NaN) no anuncia nada. */
export function estadoDe(p: Pick<Plataforma, "desde" | "hasta" | "aviso">, t: number): EstadoPlataforma | null {
  if (Number.isNaN(t)) return "despues";
  if (t < p.desde) return p.aviso ? "antes" : null;
  return t < p.hasta ? "durante" : "despues";
}

/** Todas las fronteras (aperturas y cierres), ordenadas y sin repetir. */
export function fronteras(lista: readonly Plataforma[] = PLATAFORMAS): number[] {
  return [...new Set(lista.flatMap((p) => [p.desde, p.hasta]))].sort((a, b) => a - b);
}

/** La próxima frontera estrictamente posterior a `t`, o null si no queda ninguna. */
export function siguienteFronteraDe(t: number, lista: readonly Plataforma[] = PLATAFORMAS): number | null {
  if (Number.isNaN(t)) return null;
  return fronteras(lista).find((f) => f > t) ?? null;
}

/** Cuándo acaba la última campaña: desde ahí la franja es la de BiVelio en cualquier carga. */
export const finDeTodas = (lista: readonly Plataforma[] = PLATAFORMAS): number => Math.max(...lista.map((p) => p.hasta));

/**
 * Las piezas que el HTML de una página renderizada en `construido` tiene que
 * llevar en la FRANJA: una por plataforma y estado que todavía pueda tocar.
 * Las que ya pasaron no se pintan (no ocupan sitio en la pila).
 */
export function piezasDeFranja(construido: number, lista: readonly Plataforma[] = PLATAFORMAS): { id: string; estado: "antes" | "durante" }[] {
  if (Number.isNaN(construido)) return [];
  const piezas: { id: string; estado: "antes" | "durante" }[] = [];
  for (const p of lista) {
    if (p.aviso && construido < p.desde) piezas.push({ id: p.id, estado: "antes" });
    if (construido < p.hasta) piezas.push({ id: p.id, estado: "durante" });
  }
  return piezas;
}

/**
 * Las diapositivas de la TARJETA para una página renderizada en `construido`:
 * todas las plataformas (después de su campaña siguen en la tarjeta), y si su
 * botón aún puede decir «avísame» (`conAviso`) además de «échale un vistazo».
 */
export function piezasDeTarjeta(construido: number, lista: readonly Plataforma[] = PLATAFORMAS): { id: string; conAviso: boolean }[] {
  return lista.map((p) => ({ id: p.id, conAviso: p.aviso && !Number.isNaN(construido) && construido < p.desde }));
}

/** Lo que `repartir` necesita de cada plataforma, en una fila plana (viaja dentro del guion en línea). */
export type Fila = [id: string, desde: number, hasta: number, aviso: 0 | 1, fondo: string, texto: string];
export const filasDe = (lista: readonly Plataforma[] = PLATAFORMAS): Fila[] =>
  lista.map((p) => [p.id, p.desde, p.hasta, p.aviso ? 1 : 0, p.color.fondo, p.color.texto]);

export interface Reparto {
  /** Las plataformas que la tarjeta enseña ahora, en el orden de esta carga. */
  enTarjeta: string[];
  /** La diapositiva visible de la tarjeta, o null si no hay ninguna. */
  tarjeta: string | null;
  /** Qué dice su botón: «avísame» o «échale un vistazo». */
  boton: "antes" | "vivo";
  /** La plataforma de la franja, o null: la franja de BiVelio. */
  franja: string | null;
  estadoFranja: "antes" | "durante";
  /** La hoja de estilo que deja la franja así ANTES de hidratar, sin tocar el DOM. */
  hojaFranja: string;
  /** Lo mismo para la tarjeta. */
  hojaTarjeta: string;
}

/**
 * EL REPARTO: qué enseña la franja y qué la tarjeta en el instante `t`, con las
 * plataformas en el orden `orden` (el de esta carga) y el carrusel en el paso `k`.
 *
 *   · La tarjeta rota entre las plataformas que tienen estado (antes, durante o
 *     después). En el paso k enseña la (k+1)-ésima.
 *   · La franja enseña la ANTERIOR a la de la tarjeta que siga en campaña
 *     (antes o durante): la que la tarjeta acaba de soltar. Solo coincide con
 *     la tarjeta si es la única en campaña; si no queda ninguna, null (BiVelio).
 *
 * AUTOCONTENIDA Y EN ES5, A PROPÓSITO: su código fuente (`toString()`) viaja
 * dentro del guion en línea que decide el primer pintado (`guionDeLanzamiento`),
 * así que no puede usar nada de fuera de sus parámetros ni sintaxis que el
 * compilador baje con funciones auxiliares (ni spread, ni for-of, ni
 * desestructuración). Los componentes llaman a ESTA misma función: el guion y
 * React no pueden discrepar.
 */
export function repartir(filas: Fila[], construido: number, t: number, orden: string[], k: number): Reparto {
  var porId: Record<string, Fila> = {};
  var i: number;
  for (i = 0; i < filas.length; i++) porId[filas[i][0]] = filas[i];
  // 0: aún no se enseña · 1: antes · 2: durante · 3: después. Un reloj roto (NaN) no anuncia nada.
  var estado = function (f: Fila, cuando: number): number {
    if (cuando !== cuando) return 3;
    if (cuando < f[1]) return f[3] ? 1 : 0;
    return cuando < f[2] ? 2 : 3;
  };
  var enTarjeta: string[] = [];
  for (i = 0; i < orden.length; i++) {
    if (porId[orden[i]] && estado(porId[orden[i]], t) > 0 && enTarjeta.indexOf(orden[i]) < 0) enTarjeta.push(orden[i]);
  }
  var n = enTarjeta.length;
  var tarjeta: string | null = null;
  var franja: string | null = null;
  if (n > 0) {
    var paso = ((Math.floor(k) % n) + n) % n;
    var c = (paso + 1) % n;
    tarjeta = enTarjeta[c];
    for (i = 1; i <= n && franja === null; i++) {
      var candidata = enTarjeta[(((c - i) % n) + n) % n];
      var e = estado(porId[candidata], t);
      if (e === 1 || e === 2) franja = candidata;
    }
  }
  var boton: "antes" | "vivo" = tarjeta !== null && estado(porId[tarjeta], t) === 1 ? "antes" : "vivo";
  var estadoFranja: "antes" | "durante" = franja !== null && estado(porId[franja], t) === 1 ? "antes" : "durante";

  // LAS HOJAS. Parten del HTML de una página renderizada en `construido`: sus
  // piezas son las que entonces aún podían tocar.
  var hf = "";
  var ht = "";
  for (i = 0; i < filas.length; i++) {
    var f = filas[i];
    // Piezas de la franja que ya pasaron: fuera de la pila (no ocupan sitio).
    if (f[3] && construido < f[1] && estado(f, t) !== 1) hf += '.announce-pila>[data-lz="' + f[0] + ':antes"]{display:none}';
    if (construido < f[2] && estado(f, t) === 3) hf += '.announce-pila>[data-lz="' + f[0] + ':durante"]{display:none}';
    // El botón de la tarjeta que aún decía «avísame» y ya no toca.
    if (f[3] && construido < f[1] && estado(f, t) !== 1) {
      ht += '.lz-diapo[data-lz-d="' + f[0] + '"] [data-lz-b="antes"]{visibility:hidden}';
      ht += '.lz-diapo[data-lz-d="' + f[0] + '"] [data-lz-b="vivo"]{visibility:inherit}';
    }
  }
  hf += ".announce-pila>*{visibility:hidden;opacity:0}";
  if (franja !== null) {
    hf += '.announce-pila>[data-lz="' + franja + ":" + estadoFranja + '"]{visibility:visible;opacity:1}';
    hf += ".announce{background:" + porId[franja][4] + ";color:" + porId[franja][5] + "}";
    hf += ".announce a,.announce .announce-close{color:" + porId[franja][5] + "}";
  } else {
    hf += ".announce-pila>:not([data-lz]){visibility:visible;opacity:1}";
    hf += ".announce{background:#0F1218;color:#fff}.announce a{color:rgba(255,255,255,.92)}.announce .announce-close{color:rgba(255,255,255,.6)}";
  }
  if (tarjeta !== null) {
    ht += ".lz-diapo>*{visibility:hidden;opacity:0}";
    ht += '.lz-diapo[data-lz-d="' + tarjeta + '"]>*{visibility:visible;opacity:1;transform:none}';
  } else {
    ht += ".lz-sec{display:none}";
  }
  return { enTarjeta: enTarjeta, tarjeta: tarjeta, boton: boton, franja: franja, estadoFranja: estadoFranja, hojaFranja: hf, hojaTarjeta: ht };
}

/** El orden sin azar: el del registro. Es el del HTML del servidor (y el de quien no tiene JavaScript): la primera, en la franja. */
export const ordenPorDefecto = (lista: readonly Plataforma[] = PLATAFORMAS): string[] => lista.map((p) => p.id);

/** Lo que pinta el servidor en `construido`: orden del registro, carrusel en su primer paso. */
export const repartoDelServidor = (construido: number, lista: readonly Plataforma[] = PLATAFORMAS): Reparto =>
  repartir(filasDe(lista), construido, construido, ordenPorDefecto(lista), 0);

/** Fisher–Yates con el azar que se le dé (en las pruebas, uno fijo). No toca `ids`. */
export function barajar(ids: readonly string[], azar: () => number): string[] {
  const o = ids.slice();
  for (let i = o.length - 1; i > 0; i--) {
    const j = Math.floor(azar() * (i + 1));
    const x = o[i]!;
    o[i] = o[j]!;
    o[j] = x;
  }
  return o;
}

/** ¿Es `orden` una permutación de las plataformas del registro? (Lo que deja el guion se comprueba antes de usarlo.) */
export function esOrdenValido(orden: unknown, lista: readonly Plataforma[] = PLATAFORMAS): orden is string[] {
  return (
    Array.isArray(orden) &&
    orden.length === lista.length &&
    lista.every((p) => orden.includes(p.id)) &&
    new Set(orden).size === orden.length
  );
}

/** Dónde deja el guion lo que decidió: el orden de la carga y las dos hojas, para que los componentes las retiren. */
export const CLAVE_LANZAMIENTO = "__lz";
/** sessionStorage: la franja cerrada con la ✕ sigue cerrada al recargar, mientras dure la pestaña. */
export const CLAVE_FRANJA_CERRADA = "bv-franja-cerrada";

/*
 * EL PRIMER PINTADO.
 *
 * Las páginas se sirven estáticas o cacheadas: el azar no puede decidirse en el
 * servidor (saldría el mismo reparto para todos hasta la siguiente
 * regeneración), y decidirlo al hidratar pintaría primero el reparto del
 * servidor y lo cambiaría a la vista. Así que el HTML lleva TODAS las piezas
 * (cada plataforma en la franja y en la tarjeta, apiladas en la misma celda) y
 * un guion en línea, antes de la franja y del primer pintado, baraja el orden,
 * mira el reloj del navegador y añade dos hojas de estilo construidas
 * (`document.adoptedStyleSheets`) que enseñan lo que toca. No toca el DOM, así
 * que React hidrata sobre el marcado del servidor sin discrepancias; al
 * montar, cada componente lee el mismo orden (`window.__lz.o`), pinta lo mismo
 * con su estado y retira su hoja. También esconde la franja si se cerró en esta
 * pestaña. Sin hojas construidas (navegadores de antes de 2023) no hace nada y
 * el reparto se corrige al hidratar. La CSP ya admite guiones en línea
 * ('unsafe-inline', como el de gtag): no se abre nada.
 */
export function guionDeLanzamiento(construido: number, lista: readonly Plataforma[] = PLATAFORMAS): string | null {
  // Sin nada que repartir (todas las campañas acabadas y, a lo sumo, una
  // plataforma en la tarjeta), el HTML del servidor ya es el definitivo.
  const conFranja = piezasDeFranja(construido, lista).length > 0;
  if (!conFranja && lista.length < 2) return null;
  return (
    `try{(function(F,C){var R=${repartir.toString()};` +
    "var o=[],i,j,x;for(i=0;i<F.length;i++)o.push(F[i][0]);" +
    "for(i=o.length-1;i>0;i--){j=Math.floor(Math.random()*(i+1));x=o[i];o[i]=o[j];o[j]=x}" +
    "var r=R(F,C,Date.now(),o,0),c=0;" +
    `try{c=sessionStorage.getItem(${JSON.stringify(CLAVE_FRANJA_CERRADA)})==="1"}catch(e){}` +
    `var f=new CSSStyleSheet(),t=new CSSStyleSheet();f.replaceSync(${conFranja ? "r.hojaFranja" : '""'}+(c?".announce{display:none}":""));t.replaceSync(r.hojaTarjeta);` +
    `document.adoptedStyleSheets=document.adoptedStyleSheets.concat(f,t);window.${CLAVE_LANZAMIENTO}={o:o,f:f,t:t}` +
    `})(${JSON.stringify(filasDe(lista))},${construido})}catch(e){}`
  );
}

/** Retira la hoja `cual` del guion, si la puso. La llama cada componente cuando ya pinta lo mismo con su estado. */
export function retirarHojaDeLanzamiento(
  cual: "f" | "t",
  doc: { adoptedStyleSheets: CSSStyleSheet[] } = document,
  win: Record<string, unknown> = window as unknown as Record<string, unknown>,
): void {
  const dejado = win[CLAVE_LANZAMIENTO] as Record<string, unknown> | undefined;
  const hoja = dejado?.[cual];
  if (!dejado || !hoja) return;
  doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((h) => h !== hoja);
  delete dejado[cual];
}

/** El nombre con espacios de no separación: «Product Hunt» no se parte en dos líneas. */
export const nombreAtado = (nombre: string): string => nombre.replace(/ /g, " ");

/** Lo mínimo de un traductor de next-intl: el texto de una clave y si existe. */
export interface Traductor {
  (clave: string, valores?: Record<string, string>): string;
  has(clave: string): boolean;
}

/** El texto `clave` para la plataforma `p`: la clave propia (`clave_<id>`) si el idioma la tiene; si no, la plantilla con `{platform}`. */
export function textoDe(t: Traductor, clave: string, p: Pick<Plataforma, "id" | "nombre">, valores: Record<string, string> = {}): string {
  const propia = `${clave}_${p.id}`;
  return t(t.has(propia) ? propia : clave, { platform: p.nombre, ...valores });
}

export interface TextosDeTarjeta {
  /** Nombre accesible del carrusel. */
  carrusel: string;
  pausar: string;
  reanudar: string;
  /** El lema del producto, el mismo en todas las diapositivas. */
  lema: string;
  nuevaPestana: string;
  porPlataforma: Record<string, { kicker: string; aviso: string; vivo: string; ver: string }>;
}

/** Los textos de la tarjeta, ya resueltos en el servidor (`t`: landing.launch; `nuevaPestana`: nav.newTab). */
export function textosDeTarjeta(t: Traductor, nuevaPestana: string, lista: readonly Plataforma[] = PLATAFORMAS): TextosDeTarjeta {
  const porPlataforma: TextosDeTarjeta["porPlataforma"] = {};
  for (const p of lista) {
    porPlataforma[p.id] = {
      kicker: textoDe(t, "kicker", p),
      aviso: textoDe(t, "notify", p),
      vivo: textoDe(t, "live", p),
      ver: textoDe(t, "show", p),
    };
  }
  return { carrusel: t("carousel"), pausar: t("pause"), reanudar: t("play"), lema: t("tagline"), nuevaPestana, porPlataforma };
}

/**
 * La fecha de apertura de una plataforma en el idioma de la página («Sunday,
 * November 22», «domingo, 22 de noviembre»…), en hora de Andorra. Se formatea
 * en el SERVIDOR y viaja como texto: si cada lado usara su propio ICU, una coma
 * de más bastaría para un error de hidratación.
 */
export function fechaDeApertura(p: Pick<Plataforma, "desde">, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric", timeZone: "Europe/Andorra" }).format(p.desde);
}

/** Las fechas de las plataformas que aún pueden anunciarse antes de abrir, por id. */
export function fechasDeAviso(construido: number, locale: string, lista: readonly Plataforma[] = PLATAFORMAS): Record<string, string> {
  const fechas: Record<string, string> = {};
  for (const p of lista) if (p.aviso && construido < p.desde) fechas[p.id] = fechaDeApertura(p, locale);
  return fechas;
}
