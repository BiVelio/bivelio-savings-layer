#!/usr/bin/env node
/**
 * QUÉ REGLAS DE CSS SON SOLO DEL PANEL, Y EN QUÉ HOJA VIVE CADA UNA.
 *
 *   node scripts/hoja-del-panel.mjs          # informe del reparto
 *   node scripts/hoja-del-panel.mjs --check  # sale con 1 si panel.css tiene
 *                                            # una regla que lo público pinta
 *
 *   app/globals.css                    lo que puede pintar una página PÚBLICA
 *                                      (y lo común: tokens, base, @font-face,
 *                                      @keyframes). La importa
 *                                      `app/[locale]/layout.tsx`.
 *   app/[locale]/dashboard/panel.css   las reglas que solo pueden casar dentro
 *                                      del panel. La importa
 *                                      `dashboard/layout.tsx` (y las galerías
 *                                      de desarrollo que pintan sus piezas).
 *
 * POR QUÉ. `globals.css` era una hoja única de 475 kB (61 kB en gzip) que
 * bloqueaba el primer pintado de la portada con las reglas de tablas, raíl,
 * extracto y gráficas que solo existen tras iniciar sesión: con la red y la
 * CPU de un móvil (150 ms, 1,6 Mbps, CPU 4×) el primer pintado se iba a 2,4 s
 * frente a 1,3 s. Es el mismo reparto que `juntar-affectui.mjs` hace con las
 * piezas de affectUI, aplicado a las reglas propias.
 *
 * LA REGLA DE REPARTO. Una regla es «solo del panel» si TODOS los selectores
 * de su lista exigen al menos una clase que el código público no puede
 * producir. «Código público» sale del grafo de imports, no de las carpetas:
 * todo lo que alcanza una ruta que no cuelga de /dashboard ni importa la hoja
 * del panel, más `app/components/`, `lib/`, `i18n/`, los mensajes y el
 * middleware enteros (y lo que importan). Un componente de
 * `dashboard/components` que usa la portada es público. `app/components/app/`
 * —la cáscara del panel— cuenta como pública por estar en esa carpeta, aunque
 * hoy solo la monte el panel: es la lectura prudente, y sacarla de
 * `SIEMPRE_PUBLICO` movería otros ~23 kB de reglas.
 *
 * Y «puede producir» es deliberadamente generoso, porque el fallo que se evita
 * es mudo (una página pública sin su CSS no rompe ningún build):
 *   · la clase aparece como palabra en cualquier fuente pública —también en
 *     una cadena, un `data-*`, un `classList.add` o un mensaje—;
 *   · o empieza por un trozo que el código compone (`ui-bdgc--${tono}`,
 *     `"lp-" + x`): una palabra pegada a un `${` o a un `+`, o que cierra
 *     su cadena en `-`/`_`;
 *   · o acaba en un sufijo compuesto (`${base}-title`) sobre una raíz que
 *     también es pública.
 * Solo cuentan las clases que el selector EXIGE: las que van dentro de
 * `:not()`, `:is()`, `:where()` o `:has()` no obligan a nada y no se miran.
 * Ante la duda, la regla es pública y se queda en `globals.css`.
 *
 * `@keyframes`, `@font-face`, `:root` y todo selector sin clases se quedan en
 * la hoja global. Mover una regla NO es gratis para la cascada (la hoja del
 * panel carga después de `globals.css` y de `affectui.css`, y sin orden fijo
 * respecto a `affectui-panel.css`): quien mueva algo tiene que comprobar que
 * ningún estilo computado cambia. `dashboard/panel-css.test.ts` es la valla.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { alcanza, ficherosDeRuta } from "./juntar-affectui.mjs";

const WEB = fileURLToPath(new URL("../", import.meta.url));
export const HOJA_GLOBAL = "app/globals.css";
export const HOJA_PANEL = "app/[locale]/dashboard/panel.css";

const lee = (ruta) => readFileSync(WEB + ruta, "utf8");

// ── Trocear una hoja sin perder un carácter ──────────────────────────────────

const finDeComentario = (css, i) => {
  const j = css.indexOf("*/", i + 2);
  if (j < 0) throw new Error(`comentario sin cerrar en ${i}`);
  return j + 2;
};
const finDeCadena = (css, i) => {
  const q = css[i];
  for (i++; i < css.length && css[i] !== q; i++) if (css[i] === "\\") i++;
  return i + 1;
};

/** Primer carácter de `paradas` desde `i`, fuera de cadenas, comentarios, () y []. */
function busca(css, i, fin, paradas) {
  let prof = 0;
  for (; i < fin; i++) {
    const c = css[i];
    if (c === '"' || c === "'") i = finDeCadena(css, i) - 1;
    else if (c === "/" && css[i + 1] === "*") i = finDeComentario(css, i) - 1;
    else if (c === "(" || c === "[") prof++;
    else if (c === ")" || c === "]") prof--;
    else if (prof === 0 && paradas.includes(c)) return i;
  }
  return -1;
}

/** La `}` que cierra la `{` de `abre`. */
function cierre(css, abre, fin) {
  let prof = 0;
  for (let i = abre; i < fin; i++) {
    const c = css[i];
    if (c === '"' || c === "'") i = finDeCadena(css, i) - 1;
    else if (c === "/" && css[i + 1] === "*") i = finDeComentario(css, i) - 1;
    else if (c === "{") prof++;
    else if (c === "}" && --prof === 0) return i;
  }
  throw new Error(`llave sin cerrar en ${abre}`);
}

/** Las at-rules cuyo cuerpo son reglas (y no declaraciones o fotogramas). */
const GRUPOS = new Set(["media", "supports", "container", "layer", "scope", "starting-style"]);

/**
 * La hoja como lista de nodos, cada uno con su trozo exacto de texto
 * (`ini`…`fin`) y el blanco que lo precede (`antes`): pegar `antes + texto` de
 * todos, más la `cola`, devuelve el fichero byte a byte.
 *
 *   comentario · sentencia (`@import …;`) · regla (`selectores { … }`)
 *   opaca (`@keyframes`, `@font-face`…) · grupo (`@media`… con `hijos`)
 */
export function trocea(css, desde = 0, fin = css.length) {
  const nodos = [];
  let i = desde;
  for (;;) {
    let j = i;
    while (j < fin && /\s/.test(css[j])) j++;
    const antes = css.slice(i, j);
    if (j >= fin) return { nodos, cola: antes };
    let nodo;
    if (css.startsWith("/*", j)) nodo = { tipo: "comentario", fin: finDeComentario(css, j) };
    else {
      const p = busca(css, j, fin, "{;}");
      if (p < 0 || css[p] === "}") throw new Error(`no se entiende la hoja en ${j}: ${css.slice(j, j + 60)}`);
      if (css[p] === ";") nodo = { tipo: "sentencia", fin: p + 1 };
      else {
        const c = cierre(css, p, fin);
        const preludio = css.slice(j, p).trim();
        const nombre = /^@([\w-]+)/.exec(preludio)?.[1];
        if (!nombre) nodo = { tipo: "regla", preludio, abre: p, fin: c + 1 };
        else if (GRUPOS.has(nombre)) nodo = { tipo: "grupo", nombre, preludio, abre: p, fin: c + 1, ...(({ nodos: hijos, cola }) => ({ hijos, cola }))(trocea(css, p + 1, c)) };
        else nodo = { tipo: "opaca", nombre, preludio, abre: p, fin: c + 1 };
      }
    }
    nodo.antes = antes;
    nodo.ini = j;
    nodos.push(nodo);
    i = nodo.fin;
  }
}

/** Todas las reglas de una hoja, también las de dentro de @media/@supports/@container. */
export function reglas(css) {
  const acc = [];
  const baja = (nodos, grupos) => {
    for (const n of nodos) {
      if (n.tipo === "regla") acc.push({ ...n, grupos, linea: css.slice(0, n.ini).split("\n").length });
      else if (n.tipo === "grupo") baja(n.hijos, [...grupos, n.preludio]);
    }
  };
  baja(trocea(css).nodos, []);
  return acc;
}

// ── Selectores ───────────────────────────────────────────────────────────────

const sinComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** La lista de selectores de una regla, partida por las comas de primer nivel. */
export function selectores(preludio) {
  const s = sinComentarios(preludio);
  const lista = [];
  let i = 0;
  for (;;) {
    const p = busca(s, i, s.length, ",");
    lista.push(s.slice(i, p < 0 ? s.length : p).trim());
    if (p < 0) return lista.filter(Boolean);
    i = p + 1;
  }
}

/**
 * Las clases que un selector EXIGE para casar: las que están fuera de todo
 * paréntesis y corchete. `.a:not(.b) [class~="c"] .d` exige `a` y `d`.
 */
export function clasesQueExige(selector) {
  let fuera = "";
  let prof = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '"' || c === "'") i = finDeCadena(selector, i) - 1;
    else if (c === "\\") {
      // Un carácter escapado dentro de un nombre: se deja pasar como parte de él.
      if (prof === 0) fuera += "_";
      i++;
    } else if (c === "(" || c === "[") prof++;
    else if (c === ")" || c === "]") prof--;
    else if (prof === 0) fuera += c;
  }
  return [...fuera.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}

// ── Lo que el código público puede producir ──────────────────────────────────

/** Rutas a las que les llega la hoja del panel: cuelgan de /dashboard o la importan ellas. */
const EN_EL_PANEL = /^app\/\[locale\]\/dashboard\//;
const PIDE_LA_DEL_PANEL = /^import\s+["'](?:@\/app\/\[locale\]\/dashboard\/|\.\/|(?:\.\.\/)+dashboard\/)panel\.css["'];?\s*$/m;

export function rutas() {
  return ficherosDeRuta().map((ruta) => ({ ruta, conHojaDelPanel: EN_EL_PANEL.test(ruta) || PIDE_LA_DEL_PANEL.test(lee(ruta)) }));
}

const FUENTE = /\.(ts|tsx|mjs|js|json)$/;
function fuentes(dir, acc = []) {
  for (const e of readdirSync(WEB + dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const ruta = `${dir}/${e.name}`;
    if (e.isDirectory()) fuentes(ruta, acc);
    else if (FUENTE.test(e.name) && !/\.test\.tsx?$/.test(e.name)) acc.push(ruta);
  }
  return acc;
}

/** Carpetas que cuentan como públicas enteras, las use quien las use. */
const SIEMPRE_PUBLICO = ["app/components", "lib", "i18n", "messages"];

/** Los ficheros cuyo texto puede acabar en el `class` de una página pública. */
export function ficherosPublicos() {
  const visto = new Set();
  for (const r of rutas()) if (!r.conHojaDelPanel) alcanza(r.ruta, visto);
  for (const dir of SIEMPRE_PUBLICO) for (const f of fuentes(dir)) alcanza(f, visto);
  alcanza("middleware.ts", visto);
  // El grafo también alcanza hojas e imágenes: no son código que ponga clases.
  return [...visto].filter((f) => FUENTE.test(f)).sort();
}

/** Todo fichero de la aplicación: lo público y lo del panel. */
export function ficherosDeTodo() {
  const visto = new Set(ficherosPublicos());
  for (const dir of ["app", "vendor"]) for (const f of fuentes(dir)) visto.add(f);
  return [...visto].sort();
}

/**
 * Paquetes que no pintan nada con clases propias. Cualquier OTRO import de un
 * paquete (hoy, solo la visita guiada) mete el código del paquete en el
 * corpus de quien lo importa: sus clases las pone él en el DOM, no un `.tsx`.
 */
const NO_PINTAN = /^(react|react-dom|next|next-intl|@supabase\/[\w-]+|stripe|gpt-tokenizer|server-only)(\/|$)|^node:/;
const DE_PAQUETE = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"'./@][^"']*|@[\w-]+\/[^"']+)["']/g;

/**
 * El texto de una fuente sin los comentarios que no pueden ser código: los de
 * bloque que abren línea (o un `{` de JSX) y los `//` que ocupan la línea
 * entera. Los demás se quedan: un `/*` dentro de un patrón de ficheros o el
 * `//` de una URL no abren comentario, y quitar de más convertiría en «del
 * panel» una clase que lo público usa.
 */
function codigo(fichero) {
  const texto = lee(fichero);
  if (!/\.(ts|tsx|mjs|js)$/.test(fichero)) return texto;
  return texto.replace(/(^|\{)[ \t]*\/\*[\s\S]*?\*\//gm, "$1").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Palabras, prefijos y sufijos con los que un conjunto de fuentes puede componer una clase. */
export function vocabulario(ficheros) {
  const palabras = new Set();
  const prefijos = new Set();
  const sufijos = new Set();
  const anota = (texto) => {
    // Una palabra pegada a un `${`, o que cierra su cadena en guion o seguida
    // de un `+`, es el principio de un nombre que se termina de componer al
    // ejecutar. Las de una letra sin guion no cuentan: son las órdenes de un
    // trazado SVG (`M${x} L${y}`) y harían pública media hoja.
    for (const m of texto.matchAll(/([A-Za-z_][\w-]*)(\$\{|["'`](?:\s*\+)?)?/g)) {
      palabras.add(m[1]);
      if (!m[2]) continue;
      const enGuion = /[-_]$/.test(m[1]) && m[1].length > 1;
      if (enGuion || (m[2].length > 1 && m[1].length > 1)) prefijos.add(m[1]);
    }
    // `${base}-title`, `x + "-on"`: el final de un nombre compuesto.
    for (const m of texto.matchAll(/(?:\}|\+\s*["'`])([-_][\w-]*[A-Za-z0-9])/g)) sufijos.add(m[1]);
  };
  for (const f of ficheros) {
    const texto = codigo(f);
    anota(texto);
    for (const m of texto.matchAll(DE_PAQUETE)) {
      if (NO_PINTAN.test(m[1])) continue;
      const enDisco = `node_modules/${m[1]}`;
      for (const c of [enDisco, `${enDisco}.js`]) if (existsSync(WEB + c) && /\.(js|mjs|cjs)$/.test(c)) anota(lee(c));
    }
  }
  return { palabras, prefijos: [...prefijos], sufijos: [...sufijos] };
}

/** ¿Puede este vocabulario producir la clase? Ver la cabecera. */
export function laProduce(clase, voc) {
  const directa = (c) => voc.palabras.has(c) || voc.prefijos.some((p) => c.startsWith(p));
  if (directa(clase)) return true;
  return voc.sufijos.some((s) => clase.length > s.length && clase.endsWith(s) && directa(clase.slice(0, -s.length)));
}

let publico;
export const vocabularioPublico = () => (publico ??= vocabulario(ficherosPublicos()));

/** Las clases de un selector que lo público NO puede producir. Vacío = el selector es público. */
export const clasesSoloDelPanel = (selector, voc = vocabularioPublico()) => clasesQueExige(selector).filter((c) => !laProduce(c, voc));

/** Una regla es solo del panel si TODOS sus selectores exigen una clase que lo público no produce. */
export function esSoloDelPanel(preludio, voc = vocabularioPublico()) {
  const lista = selectores(preludio);
  return lista.length > 0 && lista.every((s) => clasesSoloDelPanel(s, voc).length > 0);
}

/** Los selectores de la hoja del panel que una página pública podría pintar. Tiene que salir vacío. */
export function publicasEnLaHojaDelPanel(css = lee(HOJA_PANEL)) {
  const voc = vocabularioPublico();
  const malas = [];
  for (const r of reglas(css)) {
    for (const s of selectores(r.preludio)) if (clasesSoloDelPanel(s, voc).length === 0) malas.push(`${HOJA_PANEL}:${r.linea}  ${s}`);
  }
  return malas;
}

/** Lo que no es regla ni comentario y aparece en la hoja del panel (@keyframes, @font-face…). Tiene que salir vacío. */
export function ajenasEnLaHojaDelPanel(css = lee(HOJA_PANEL)) {
  const acc = [];
  const baja = (nodos) => {
    for (const n of nodos) {
      if (n.tipo === "grupo") baja(n.hijos);
      else if (n.tipo !== "regla" && n.tipo !== "comentario") acc.push(n.preludio ?? css.slice(n.ini, n.fin));
    }
  };
  baja(trocea(css).nodos);
  return acc;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
  const malas = publicasEnLaHojaDelPanel();
  if (process.argv.includes("--check")) {
    if (malas.length) {
      console.error(`${malas.length} selector(es) de la hoja del panel que una página pública puede pintar; su regla vuelve a ${HOJA_GLOBAL}:\n${malas.join("\n")}`);
      process.exit(1);
    }
    console.log("al día: ninguna regla de la hoja del panel casa en una página pública");
  } else {
    const global = lee(HOJA_GLOBAL);
    const movibles = reglas(global).filter((r) => esSoloDelPanel(r.preludio));
    console.log(`${HOJA_GLOBAL}: ${kb(global.length)}, ${reglas(global).length} reglas`);
    console.log(`${HOJA_PANEL}: ${kb(lee(HOJA_PANEL).length)}, ${reglas(lee(HOJA_PANEL)).length} reglas (${malas.length} que lo público puede pintar)`);
    console.log(`reglas de ${HOJA_GLOBAL} que solo casan en el panel y siguen en ella: ${movibles.length} (${kb(movibles.reduce((a, r) => a + r.fin - r.ini, 0))})`);
    if (process.argv.includes("--lista")) for (const r of movibles) console.log(`  ${r.linea}  ${r.preludio.replace(/\s+/g, " ")}`);
  }
}
