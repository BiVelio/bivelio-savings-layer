#!/usr/bin/env node
/**
 * JUNTA LAS HOJAS DE affectUI EN DOS FICHEROS, UNO POR SUPERFICIE.
 *
 *   node scripts/juntar-affectui.mjs          # los regenera
 *   node scripts/juntar-affectui.mjs --check  # sale con 1 si están desfasados
 *
 *   vendor/affectui/affectui.css        las piezas que alcanza alguna página
 *                                       PÚBLICA (o la 404). La importa
 *                                       `app/[locale]/layout.tsx`.
 *   vendor/affectui/affectui-panel.css  el resto: piezas que solo usa el panel.
 *                                       La importa `dashboard/layout.tsx` (y
 *                                       las galerías de desarrollo que pintan
 *                                       componentes del panel fuera de él).
 *
 * Cada pieza vendorizada conserva su `<pieza>.css` —es lo que se edita y lo
 * que se compara con upstream—; este guion las copia TAL CUAL, con su aviso de
 * licencia, una detrás de otra y en orden alfabético. Los dos resultados se
 * versionan y son lo único que importa la aplicación.
 *
 * EL REPARTO NO SE ESCRIBE A MANO: SALE DE LOS `import`. Se recorre el grafo
 * desde cada fichero de ruta (`page`, `layout`, `not-found`, `loading`,
 * `error`…) y una pieza es «pública» si la alcanza alguna ruta que no cuelga
 * de `/dashboard` ni importa ella misma la hoja del panel. Usar en la portada
 * una pieza que era del panel la cambia de fichero al regenerar; olvidarse de
 * regenerar lo caza `hojas-en-una-entrada.test.ts`. Así una página pública no
 * puede quedarse sin el CSS de un componente —el fallo mudo de siempre— y
 * tampoco carga el CSS de tablas, diálogos y gráficas que no pinta.
 *
 * POR QUÉ FICHEROS FÍSICOS Y NO UNA LISTA DE `@import`. Next trata cada
 * `@import` como un módulo de CSS aparte y su troceador no junta módulos por
 * encima de 100 kB: con la lista salían cuatro hojas que bloquean el pintado
 * (probado el 2026-11-16). Un fichero es un módulo y sale en una hoja.
 * La razón de fondo —la 404 en blanco— está en la cabecera de lo generado.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const DIR = "vendor/affectui/";
export const HOJA_PUBLICA = "affectui.css";
export const HOJA_PANEL = "affectui-panel.css";

const lee = (ruta) => readFileSync(WEB + ruta, "utf8");
const esFichero = (ruta) => existsSync(WEB + ruta) && statSync(WEB + ruta).isFile();

/** Las hojas de las piezas: todo `.css` de la carpeta menos los dos generados. */
export function piezas() {
  return readdirSync(WEB + DIR)
    .filter((f) => f.endsWith(".css") && f !== HOJA_PUBLICA && f !== HOJA_PANEL)
    .sort();
}

// ── El grafo de imports ──────────────────────────────────────────────────────

const IMPORT = /(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resuelve(desde, spec) {
  let base;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = normalize(join(dirname(desde), spec)).replaceAll("\\", "/");
  else return null;
  for (const c of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) if (esFichero(c)) return c;
  return null;
}

const importsDe = new Map();
function imports(fichero) {
  let v = importsDe.get(fichero);
  if (v) return v;
  v = new Set();
  importsDe.set(fichero, v);
  // Sin comentarios de bloque: los JSDoc citan `import "./pieza.css"` como ejemplo.
  const fuente = lee(fichero).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of fuente.matchAll(IMPORT)) {
    if (/^import\s+type\s/.test(m[0])) continue;
    const r = resuelve(fichero, m[1] ?? m[2]);
    if (r) v.add(r);
  }
  return v;
}

function alcanza(fichero, visto = new Set()) {
  if (visto.has(fichero)) return visto;
  visto.add(fichero);
  if (/\.tsx?$/.test(fichero)) for (const d of imports(fichero)) alcanza(d, visto);
  return visto;
}

const RUTA = /^(page|layout|not-found|loading|error|template|default|global-error)\.tsx$/;
function ficherosDeRuta(dir = "app", acc = []) {
  for (const e of readdirSync(WEB + dir, { withFileTypes: true })) {
    if (e.isDirectory()) ficherosDeRuta(`${dir}/${e.name}`, acc);
    else if (RUTA.test(e.name)) acc.push(`${dir}/${e.name}`);
  }
  return acc.sort();
}

const EN_EL_PANEL = /^app\/\[locale\]\/dashboard\//;
// Por el texto y no por el grafo: la hoja del panel la genera este guion y la
// primera vez todavía no existe.
const PIDE_LA_DEL_PANEL = /^import\s+["']@\/vendor\/affectui\/affectui-panel\.css["'];?\s*$/m;

/**
 * Por cada fichero de ruta: las piezas que alcanza y si le llega la hoja del
 * panel (cuelga de /dashboard, cuyo layout la importa, o la importa él mismo).
 */
export function rutas() {
  return ficherosDeRuta().map((ruta) => {
    const todo = [...alcanza(ruta)];
    return {
      ruta,
      piezas: todo.filter((f) => f.startsWith(DIR) && f.endsWith(".tsx")).map((f) => f.slice(DIR.length).replace(/\.tsx$/, ".css")).sort(),
      conHojaDelPanel: EN_EL_PANEL.test(ruta) || PIDE_LA_DEL_PANEL.test(lee(ruta)),
    };
  });
}

/** Qué pieza va a qué fichero. */
export function reparto() {
  const publicas = new Set();
  for (const r of rutas()) if (!r.conHojaDelPanel) for (const p of r.piezas) publicas.add(p);
  const todas = piezas();
  return { publicas: todas.filter((p) => publicas.has(p)), panel: todas.filter((p) => !publicas.has(p)) };
}

// ── Lo que se escribe ────────────────────────────────────────────────────────

const AVISO = `/*
 * GENERADO por scripts/juntar-affectui.mjs — NO EDITAR A MANO.
 * Edita la hoja de la pieza (\`<pieza>.css\`) y vuelve a ejecutar el guion.
 *`;

const CABECERA_PUBLICA = `${AVISO}
 * LAS HOJAS DE affectUI QUE USA EL SITIO PÚBLICO, EN UNA. La importa una sola
 * vez \`app/[locale]/layout.tsx\`, justo después de \`globals.css\`; los \`.tsx\`
 * de las piezas NO importan CSS. Así una página pública espera dos hojas antes
 * de pintar (esta y la global) y ninguna ruta genera trozos de CSS propios.
 * Las piezas que solo usa el panel van en \`affectui-panel.css\`.
 *
 * POR QUÉ. Con un \`import "./pieza.css"\` por componente, Next partía el CSS
 * en 43 ficheros y una página esperaba hasta 15 hojas antes del primer pintado.
 * Y peor: la 404 se quedaba EN BLANCO en una de cada tres cargas directas.
 * La 404 la pinta el cliente con \`createRoot(document)\` sobre el cascarón
 * \`<html id="__next_error__">\`. Las hojas que solo conocía el árbol de «no
 * encontrado» no venían anunciadas por Next, así que React creaba él mismo sus
 * \`<link rel="preload" as="style">\`; su primer commit vaciaba el <head>
 * (\`clearContainerSparingly\` conserva los \`rel="stylesheet"\`, no los
 * \`preload\`), el navegador cancelaba esas descargas (net::ERR_ABORTED) y el
 * commit siguiente se quedaba esperando un \`load\` que ya no podía llegar,
 * hasta el tope de 60 s de React. Si las descargas terminaban antes de ese
 * primer commit, la página salía bien: de ahí lo intermitente. Las hojas del
 * layout sí las anuncia Next antes de que React empiece, y con todo el CSS de
 * la 404 en ellas su árbol no necesita ninguna más.
 *
 * El orden entre piezas no altera nada: cada hoja solo toca las clases de su
 * prefijo (\`ui-…\`) y los nombres de @keyframes y @property no se repiten
 * (lo comprueba \`hojas-en-una-entrada.test.ts\`). Cada pieza conserva debajo
 * su aviso de licencia; las hay MIT y las hay affectUI Pro (ver VENDOR.md).
 */
`;

const CABECERA_PANEL = `${AVISO}
 * LAS HOJAS DE affectUI QUE SOLO USA EL PANEL, EN UNA. La importa
 * \`app/[locale]/dashboard/layout.tsx\` (y las galerías de desarrollo que pintan
 * componentes del panel fuera de él). Ninguna página pública alcanza estas
 * piezas —el reparto sale del grafo de imports—, así que la portada no carga
 * el CSS de tablas, diálogos y gráficas que no pinta. El porqué de juntarlas,
 * en la cabecera de \`affectui.css\`.
 */
`;

/** La marca que separa una pieza de la siguiente. */
const marca = (fichero) => `\n/* ===== ${fichero} ===== */\n`;

function pega(cabecera, lista) {
  let css = cabecera;
  for (const f of lista) {
    const hoja = lee(DIR + f);
    if (/@(import|charset|namespace)\b/.test(hoja)) {
      throw new Error(`${f}: @import, @charset y @namespace solo valen al principio de una hoja y aquí quedarían en medio`);
    }
    css += marca(f) + (hoja.endsWith("\n") ? hoja : `${hoja}\n`);
  }
  return css;
}

/** El contenido exacto de los dos ficheros generados. */
export function juntar() {
  const { publicas, panel } = reparto();
  return { [HOJA_PUBLICA]: pega(CABECERA_PUBLICA, publicas), [HOJA_PANEL]: pega(CABECERA_PANEL, panel) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const hojas = juntar();
  const { publicas, panel } = reparto();
  if (process.argv.includes("--check")) {
    const desfasadas = Object.entries(hojas).filter(([f, css]) => !esFichero(DIR + f) || lee(DIR + f) !== css).map(([f]) => f);
    if (desfasadas.length) {
      console.error(`${desfasadas.map((f) => DIR + f).join(", ")}: desfasada(s). Ejecuta node scripts/juntar-affectui.mjs`);
      process.exit(1);
    }
    console.log(`al día: ${publicas.length} piezas públicas, ${panel.length} del panel`);
  } else {
    for (const [f, css] of Object.entries(hojas)) writeFileSync(WEB + DIR + f, css);
    console.log(`${DIR}${HOJA_PUBLICA}: ${publicas.length} piezas, ${hojas[HOJA_PUBLICA].length} caracteres`);
    console.log(`${DIR}${HOJA_PANEL}: ${panel.length} piezas, ${hojas[HOJA_PANEL].length} caracteres`);
  }
}
