/**
 * El distintivo del NVIDIA Inception Program, pinado a la guía de marca de
 * NVIDIA y a los tres sitios pedidos (héroe bajo los botones, banda «Compañía
 * y ecosistema» antes del pie, columna de marca del pie).
 *
 * Nada de esto es gusto. El logotipo de un tercero trae reglas — solo el
 * fichero oficial, desnudo sobre fondo claro y sobre tarjeta blanca solo en
 * fondo oscuro o en la banda (donde la caja es la de bivelio.com), nunca por
 * debajo de 120 px, siempre «NVIDIA Inception Program» con «Program», siempre
 * pertenencia y nunca aval — y el fallo es silencioso: una edición posterior
 * cambia el fichero por una copia recoloreada, vuelve a meter el distintivo
 * del héroe en una tarjeta (el «marco dentro de otro» que la revisión del
 * 2026-09-14 rechazó), pinta la caja de la banda con un token que una paleta
 * oscura invertiría, o acorta el nombre en un catálogo, y nada más se pone
 * rojo. Y la banda es la MISMA que la de bivelio.com (captura aprobada el
 * 2026-09-15): medidas, colores y copy verbatim en 12 idiomas. Por eso las
 * reglas se leen del SVG, del componente, de la página, del pie, de la hoja de
 * estilos y de los doce catálogos.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { partirMarca } from "./NvidiaInception";

const AQUI = dirname(fileURLToPath(import.meta.url));
const WEB = join(AQUI, "..", "..");
const leer = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

const COMPONENTE = leer("app", "components", "NvidiaInception.tsx");
const PIE = leer("app", "components", "Footer.tsx");
const PAGINA = leer("app", "[locale]", "page.tsx");
const CSS = leer("app", "globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"];
const CLAVES_BANDA = ["kicker", "title", "sub", "cta"];

const escapar = (s: string) => s.replace(/[.*+?^()|[\]\\]/g, "\\$&");

/** Cuerpo de la primera regla que empieza línea con exactamente `.lp <sel> {`:
 *  `.nvi-badge` no casa con `.nvi-badge img`, `.nvi-badge:hover` ni
 *  `.nvi-badge--card`, y las reglas sangradas dentro de un @media quedan fuera. */
function regla(selector: string): string {
  const re = new RegExp("(?:^|\\n)\\.lp " + escapar(selector) + " \\{([^}]*)\\}");
  const m = re.exec(CSS);
  expect(m, `regla .lp ${selector}`).not.toBeNull();
  return m![1]!;
}

/** Cuerpo de la regla `.lp <sel> { … }` que vive DENTRO de `@media (<query>) { … }`
 *  en una sola línea, como se escriben aquí los puntos de corte. */
function reglaEnMedia(query: string, selector: string): string {
  const re = new RegExp("@media \\(" + escapar(query) + "\\) \\{[^\\n]*\\.lp " + escapar(selector) + " \\{([^}]*)\\}");
  const m = re.exec(CSS);
  expect(m, `@media (${query}) .lp ${selector}`).not.toBeNull();
  return m![1]!;
}

const catalogo = (locale: string) =>
  (JSON.parse(leer("messages", `${locale}.json`)) as { landing: { nvidia?: Record<string, string> } }).landing.nvidia;

describe("el logotipo es el de NVIDIA, servido desde este dominio", () => {
  const svg = leer("public", "nvidia-inception-program.svg");

  it("es el distintivo oficial, sin tocar", () => {
    // El fichero que envía NVIDIA: este viewBox, este verde, este grupo. Un
    // recoloreado, un recorte o un redibujado cambia al menos uno de los tres.
    expect(svg).toContain('viewBox="0 0 500.4288 216"');
    expect(svg).toContain("#76b900");
    expect(svg).toContain('data-name="Inception Program"');
    // Y trae su propio marco: el negro empieza a 25 unidades del borde. Es la
    // razón de que no lleve tarjeta sobre fondo claro y de que la caja de la
    // banda lleve 6 px de aire y no los 12 de bivelio.com (que lo recorta).
    expect(svg).toMatch(/M25\.49926,25\.4052V190\.5948H474\.9307V25\.4052/);
  });

  it("no trae nada que la CSP tuviera que permitir", () => {
    expect(svg).not.toMatch(/<script|<image|xlink:href|url\(/i);
  });

  it("se referencia por ruta del propio dominio, nunca por CDN, y en un solo <img>", () => {
    expect(COMPONENTE).toContain('NVIDIA_BADGE_SRC = "/nvidia-inception-program.svg"');
    expect(COMPONENTE).not.toMatch(/https?:\/\/[^"]*\.svg/);
    // Un único <img> (NvidiaInceptionArt) que comparten el distintivo desnudo y
    // la caja de la banda: no hay dos formas de pintar el logotipo.
    expect(COMPONENTE.match(/<img\s/g)?.length).toBe(1);
    expect(COMPONENTE.match(/<NvidiaInceptionArt width=/g)?.length).toBe(2);
    // `img-src 'self'` en next.config.mjs — el distintivo no necesita más.
    expect(leer("next.config.mjs")).toMatch(/img-src 'self'/);
  });
});

describe("el distintivo sigue la guía de marca", () => {
  it("cada enlace al programa abre en pestaña nueva y con noopener", () => {
    expect(COMPONENTE).toContain('NVIDIA_INCEPTION_URL = "https://www.nvidia.com/en-us/startups/"');
    const anclas = COMPONENTE.match(/<a\s[\s\S]*?href=\{NVIDIA_INCEPTION_URL\}[\s\S]*?>/g) ?? [];
    // El distintivo desnudo, el CTA de la banda y la caja de la banda.
    expect(anclas.length).toBe(3);
    for (const a of anclas) {
      expect(a).toContain('target="_blank"');
      expect(a).toMatch(/rel="[^"]*noopener[^"]*"/);
    }
    // Ni el pie ni la página enlazan por su cuenta: los <a> al programa son los del componente.
    expect(PIE).not.toContain("NVIDIA_INCEPTION_URL");
    expect(PAGINA).not.toContain("NVIDIA_INCEPTION_URL");
    expect(PAGINA).not.toContain("nvidia.com");
  });

  it("el alt nombra el programa completo, y la imagen declara ancho, alto y proporción", () => {
    expect(COMPONENTE).toContain('alt="NVIDIA Inception Program"');
    expect(COMPONENTE).toMatch(/width=\{width\}/);
    expect(COMPONENTE).toMatch(/height=\{Math\.round\(width \* RATIO\)\}/);
    expect(COMPONENTE).toContain("216 / 500.4288");
    for (const sel of [".nvi-badge img", ".nvi-band-box img"]) {
      const img = regla(sel);
      expect(img).toMatch(/height:\s*auto/);
      expect(img).toMatch(/max-width:\s*100%/);
    }
  });

  it("nunca se pinta por debajo de 120 px de ancho — en el marcado ni en la hoja de estilos", () => {
    const anchos = [
      ...[...COMPONENTE.matchAll(/width = (\d+)/g)].map((m) => Number(m[1])),
      ...[...COMPONENTE.matchAll(/<NvidiaInceptionArt width=\{(\d+)\}/g)].map((m) => Number(m[1])),
      ...[...PAGINA.matchAll(/<NvidiaInceptionBadge width=\{(\d+)\}/g)].map((m) => Number(m[1])),
      ...[...PIE.matchAll(/<NvidiaInceptionBadge width=\{(\d+)\}/g)].map((m) => Number(m[1])),
      // La regla que acota el logotipo en portátil corto.
      ...[...CSS.matchAll(/\.nvi-badge img \{ width: (\d+)px; \}/g)].map((m) => Number(m[1])),
    ];
    // Componente (por defecto) + banda + héroe + pie + la acotación de CSS.
    expect(anchos.length).toBeGreaterThanOrEqual(5);
    for (const w of anchos) expect(w).toBeGreaterThanOrEqual(120);
  });

  it("va desnudo sobre el fondo claro: ni fondo, ni borde, ni padding, ni sombra alrededor del logotipo", () => {
    // El SVG ya trae su campo blanco, su marco negro y su aire. Cualquiera de
    // estas cuatro propiedades en el enlace dibuja un marco dentro de otro.
    const enlace = regla(".nvi-badge");
    expect(enlace).not.toMatch(/background/);
    expect(enlace).not.toMatch(/border:/);
    expect(enlace).not.toMatch(/padding/);
    expect(enlace).not.toMatch(/box-shadow/);
    // Lo que sí conserva: sin altura de línea fantasma, en fila, sin encoger,
    // radio pequeño solo para el anillo de foco y un hover sutil.
    expect(enlace).toMatch(/line-height:\s*0/);
    expect(enlace).toMatch(/display:\s*inline-flex/);
    expect(enlace).toMatch(/flex:\s*none/);
    expect(enlace).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(regla(".nvi-badge:hover")).toMatch(/translateY\(-1px\)/);
  });

  it("conserva la tarjeta blanca que la guía exige sobre fondo oscuro, sea cual sea el tema", () => {
    const tarjeta = regla(".nvi-badge--card");
    // Blanco y borde LITERALES, no tokens: una paleta oscura no puede invertirla.
    expect(tarjeta).toMatch(/background:\s*#FFFFFF\b/i);
    expect(tarjeta).toMatch(/border:\s*1px solid #DEE4E7\b/i);
    const padding = /padding:\s*(\d+)px/.exec(tarjeta);
    expect(padding, "padding").not.toBeNull();
    expect(Number(padding![1])).toBeGreaterThanOrEqual(12);
    // Radio pequeño — el «ligeramente redondeado» de la guía, no una píldora.
    expect(tarjeta).toMatch(/border-radius:\s*var\(--radius-(sm|md)\)/);
    // Y solo el componente la pone, con `onDark`.
    expect(COMPONENTE).toMatch(/onDark = false/);
    expect(COMPONENTE).toContain('onDark ? "nvi-badge nvi-badge--card" : "nvi-badge"');
    // Hoy nada en la home es oscuro: ningún uso la pide.
    expect(PAGINA).not.toContain("onDark");
    expect(PIE).not.toContain("onDark");
  });
});

describe("los doce catálogos lo dicen como pertenencia, completo y con «Program»", () => {
  it.each(LOCALES)("%s", (locale) => {
    const n = catalogo(locale);
    expect(n, "landing.nvidia").toBeDefined();
    // La frase corta del héroe más las cuatro de la banda (el copy aprobado de
    // bivelio.com): el rótulo «Ecosistema» de la banda anterior se fue con ella.
    expect(Object.keys(n!).sort()).toEqual(["cta", "kicker", "miembro", "sub", "title"]);
    for (const v of Object.values(n!)) expect(v.trim().length).toBeGreaterThan(0);
    // Siempre el nombre completo, nunca «NVIDIA Inception» a secas — en la
    // frase del héroe y en el título de la banda, que son las que lo nombran.
    for (const k of ["miembro", "title"]) {
      expect(n![k], k).toContain("NVIDIA Inception Program");
    }
    for (const v of Object.values(n!)) expect(v).not.toMatch(/NVIDIA Inception(?! Program)/);
    // Héroe: cinco palabras, no un anuncio: sin coma ni segunda oración.
    expect(n!.miembro).not.toMatch(/[,.:;—–]/);
    // Banda: el título nombra a BiVelio tal cual (es lo que `partirMarca`
    // pinta en azul) y termina en punto; el sub es una sola frase.
    expect(partirMarca(n!.title!), "title nombra a BiVelio").not.toBeNull();
    expect(n!.title).toMatch(/\.$/);
    expect(n!.sub).toMatch(/\.$/);
    expect(n!.sub).toContain("NVIDIA");
    // Pertenencia, nunca aval — en las lenguas que un revisor puede leer.
    for (const v of Object.values(n!)) {
      expect(v).not.toMatch(/respald|aval|partner|endors|backed|certif|sponsor|patrocin/i);
    }
  });

  it("los doce dicen exactamente lo mismo que bivelio.com en la banda: mismas claves, sin huérfanas", () => {
    // Toda clave de landing.nvidia la pide alguien (la página, con `t("nvidia.…")`);
    // una clave que nadie pide es copy muerto que ya nadie revisa.
    const claves = Object.keys(catalogo("es")!);
    for (const k of claves) {
      expect(PAGINA, `nvidia.${k} sin uso`).toContain(`t("nvidia.${k}")`);
    }
    for (const k of CLAVES_BANDA) expect(claves).toContain(k);
    // Y nadie pide lo que ya no existe.
    for (const vieja of ["nvidia.rotulo", "nvidia.frase", "nvidia.pie"]) {
      expect(PAGINA).not.toContain(vieja);
      expect(PIE).not.toContain(vieja);
      expect(COMPONENTE).not.toContain(vieja);
    }
  });
});

describe("partirMarca: la marca en azul sin tocar el copy", () => {
  it("parte por la PRIMERA aparición de «BiVelio» y conserva el resto tal cual", () => {
    expect(partirMarca("BiVelio es miembro del NVIDIA Inception Program.")).toEqual([
      "",
      "BiVelio",
      " es miembro del NVIDIA Inception Program.",
    ]);
    // Con texto delante (pt: «A BiVelio é membro…»).
    expect(partirMarca("A BiVelio é membro do NVIDIA Inception Program.")).toEqual([
      "A ",
      "BiVelio",
      " é membro do NVIDIA Inception Program.",
    ]);
    // Solo la primera: una segunda mención se queda en el «después».
    expect(partirMarca("BiVelio y BiVelio")).toEqual(["", "BiVelio", " y BiVelio"]);
  });

  it("si la frase no nombra la marca (o la escribe distinto) devuelve null y se pinta tal cual", () => {
    expect(partirMarca("Miembro del NVIDIA Inception Program")).toBeNull();
    expect(partirMarca("bivelio es miembro")).toBeNull();
    expect(partirMarca("")).toBeNull();
  });

  it("las tres partes reconstruyen el original, en los 12 títulos", () => {
    for (const locale of LOCALES) {
      const title = catalogo(locale)!.title!;
      const partes = partirMarca(title);
      expect(partes, locale).not.toBeNull();
      expect(partes!.join("")).toBe(title);
      expect(partes![1]).toBe("BiVelio");
    }
  });

  it("y el componente la usa sobre el título, con <strong> en el azul de acento", () => {
    expect(COMPONENTE).toMatch(/const partes = partirMarca\(title\)/);
    expect(COMPONENTE).toMatch(/<strong>\{partes\[1\]\}<\/strong>/);
    // Sin marca en la frase, el título va tal cual: nada se inventa.
    expect(COMPONENTE).toMatch(/\) : \(\s*title\s*\)/);
    const marca = regla(".nvi-band-t strong");
    expect(marca).toMatch(/color:\s*var\(--accent\)/);
    expect(marca).toMatch(/font-weight:\s*inherit/);
  });
});

describe("está en los tres sitios pedidos, y solo ahí", () => {
  it("héroe: una línea más bajo los botones, detrás de «Se instala en minutos…» y antes de «Compatible con», APILADA", () => {
    const cta = PAGINA.indexOf('className="hero-cta"');
    const nota = PAGINA.indexOf('className="hero-note"');
    const linea = PAGINA.indexOf('className="hero-nvidia"');
    const compat = PAGINA.indexOf('className="hero-compat"');
    expect(cta).toBeGreaterThan(-1);
    expect(nota).toBeGreaterThan(cta);
    expect(linea).toBeGreaterThan(nota);
    expect(compat).toBeGreaterThan(linea);
    // La línea es el distintivo desnudo a 150 y la frase de pertenencia, nada
    // más: ni <p> aparte ni la frase larga de la primera versión.
    const bloque = PAGINA.slice(linea, compat);
    expect(bloque).toMatch(/<NvidiaInceptionBadge width=\{150\} \/>\s*<span>\{t\("nvidia\.miembro"\)\}<\/span>/);
    expect(bloque).not.toContain("nvidia.frase");
    // Mismo cuerpo que la nota: 13 px, ink-soft, flex.
    const nota_css = regla(".hero-note");
    const linea_css = regla(".hero-nvidia");
    for (const prop of [/font-size:\s*13px/, /color:\s*var\(--ink-soft\)/, /display:\s*flex/]) {
      expect(nota_css).toMatch(prop);
      expect(linea_css).toMatch(prop);
    }
    // APILADA (privacy #303): distintivo arriba, frase en su propia línea
    // debajo, 8 px entre ambos y todo al inicio — no en fila ni envolviendo.
    expect(linea_css).toMatch(/flex-direction:\s*column/);
    expect(linea_css).toMatch(/align-items:\s*flex-start/);
    expect(linea_css).toMatch(/gap:\s*8px/);
    expect(linea_css).not.toMatch(/flex-wrap/);
    // En pantalla baja el distintivo va a su mínimo, no por debajo.
    expect(CSS).toMatch(/@media \(max-height: 720px\) \{ \.lp \.hero-nvidia \.nvi-badge img \{ width: 120px; \} \}/);
  });

  it("banda: la de bivelio.com, a sangre completa entre el <main> y el pie, con las cuatro claves", () => {
    const finMain = PAGINA.indexOf("</main>");
    const banda = PAGINA.indexOf("<NvidiaEcosystemBand");
    const pie = PAGINA.indexOf("<Footer />");
    expect(finMain).toBeGreaterThan(-1);
    expect(banda).toBeGreaterThan(finMain);
    expect(pie).toBeGreaterThan(banda);
    const uso = PAGINA.slice(banda, PAGINA.indexOf("/>", banda));
    for (const k of CLAVES_BANDA) expect(uso).toContain(`${k}={t("nvidia.${k}")}`);
    // La banda anterior (rótulo ECOSISTEMA + distintivo + frase) se fue del todo.
    expect(PAGINA).not.toContain("ecosistema");
    expect(CSS).not.toContain(".ecosistema");
    expect(PAGINA).not.toContain("LogoProveedor marca=\"nvidia\" size={15} />\n              </section>");
  });

  it("banda: izquierda kicker + título + sub + CTA; derecha la caja blanca con el arte a 224", () => {
    const banda = COMPONENTE.slice(COMPONENTE.indexOf("export function NvidiaEcosystemBand"));
    expect(banda).toContain('<section className="nvi-band" aria-labelledby="nvi-band-title">');
    expect(banda).toContain('<div className="wrap">');
    const k = banda.indexOf('className="nvi-band-k"');
    const t = banda.indexOf('className="nvi-band-t"');
    const s = banda.indexOf('className="nvi-band-s"');
    const cta = banda.indexOf('className="nvi-band-cta"');
    const art = banda.indexOf('className="nvi-band-art"');
    expect(k).toBeGreaterThan(-1);
    expect(t).toBeGreaterThan(k);
    expect(s).toBeGreaterThan(t);
    expect(cta).toBeGreaterThan(s);
    expect(art).toBeGreaterThan(cta);
    expect(banda).toMatch(/className="nvi-band-k">\{kicker\}/);
    expect(banda).toMatch(/className="nvi-band-s">\{sub\}/);
    expect(banda).toMatch(/rel="noopener noreferrer">\s*\{cta\}\s*<Chevron \/>/);
    expect(banda).toMatch(/<span className="nvi-band-box">\s*<NvidiaInceptionArt width=\{224\} \/>/);
    // La caja es la de la banda, no la tarjeta de fondo oscuro ni el distintivo desnudo.
    expect(banda).not.toContain("onDark");
    expect(banda).not.toContain("nvi-badge");
  });

  it("banda: las medidas de bivelio.com — hairline, blanco al 70 %, 36 px, columna → fila a 640", () => {
    const seccion = regla("section.nvi-band");
    expect(seccion).toMatch(/border-top:\s*1px solid var\(--line\)/);
    expect(seccion).toMatch(/background:\s*rgba\(255, 255, 255, \.7\)/);
    // Sin el aire de una sección normal: lo pone el .wrap de dentro.
    expect(seccion).toMatch(/padding:\s*0;/);
    // Sobre la rejilla del cursor, como .wrap y .ftr.
    expect(seccion).toMatch(/position:\s*relative/);
    expect(seccion).toMatch(/z-index:\s*1/);
    const wrap = regla(".nvi-band .wrap");
    expect(wrap).toMatch(/padding:\s*36px 24px/);
    expect(wrap).toMatch(/flex-direction:\s*column/);
    expect(wrap).toMatch(/gap:\s*28px/);
    const fila = reglaEnMedia("min-width: 640px", ".nvi-band .wrap");
    expect(fila).toMatch(/flex-direction:\s*row/);
    expect(fila).toMatch(/align-items:\s*center/);
    expect(fila).toMatch(/justify-content:\s*space-between/);
    expect(fila).toMatch(/gap:\s*40px/);
    expect(regla(".nvi-band-text")).toMatch(/min-width:\s*0/);
  });

  it("banda: kicker, título, sub y CTA con la tipografía de bivelio.com", () => {
    const kicker = regla(".nvi-band-k");
    expect(kicker).toMatch(/font-size:\s*11\.5px/);
    expect(kicker).toMatch(/font-weight:\s*600/);
    expect(kicker).toMatch(/text-transform:\s*uppercase/);
    expect(kicker).toMatch(/letter-spacing:\s*\.13em/);
    expect(kicker).toMatch(/color:\s*color-mix\(in srgb, var\(--muted\) 60%, transparent\)/);
    const titulo = regla(".nvi-band-t");
    expect(titulo).toMatch(/margin:\s*8px 0 0/);
    expect(titulo).toMatch(/font-size:\s*21px/);
    expect(titulo).toMatch(/font-weight:\s*600/);
    expect(titulo).toMatch(/line-height:\s*1\.375/);
    expect(titulo).toMatch(/letter-spacing:\s*-\.015em/);
    expect(titulo).toMatch(/color:\s*var\(--ink\)/);
    const sub = regla(".nvi-band-s");
    expect(sub).toMatch(/margin:\s*8px 0 0/);
    expect(sub).toMatch(/font-size:\s*14\.5px/);
    expect(sub).toMatch(/line-height:\s*1\.6/);
    expect(sub).toMatch(/color:\s*var\(--muted\)/);
    expect(sub).toMatch(/max-width:\s*28rem/);
    const cta = regla(".nvi-band-cta");
    expect(cta).toMatch(/margin-top:\s*14px/);
    expect(cta).toMatch(/font-size:\s*14\.5px/);
    expect(cta).toMatch(/font-weight:\s*500/);
    expect(cta).toMatch(/color:\s*var\(--muted\)/);
    expect(cta).toMatch(/text-decoration:\s*underline/);
    expect(cta).toMatch(/text-underline-offset:\s*4px/);
    expect(regla(".nvi-band-cta:hover")).toMatch(/color:\s*var\(--ink\)/);
    expect(regla(".nvi-band-cta:hover svg")).toMatch(/translateX\(2px\)/);
    // El chevron: 14 px, hereda el color.
    expect(COMPONENTE).toMatch(/<svg width="14" height="14"[^>]*stroke="currentColor"/);
  });

  it("banda: la caja blanca LITERAL, borde, radio 8, sombra, 6 px de aire y hover a 1.02 — sin movimiento si se pide", () => {
    const caja = regla(".nvi-band-box");
    expect(caja).toMatch(/display:\s*inline-flex/);
    // Blanco LITERAL, no `var(--surface)`: una paleta oscura no puede invertirla.
    expect(caja).toMatch(/background:\s*#FFFFFF\b/i);
    expect(caja).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(caja).toMatch(/border-radius:\s*var\(--radius-md\)/);
    expect(caja).toMatch(/box-shadow:\s*0 10px 18px -8px rgba\(15, 18, 24, \.12\)/);
    expect(caja).toMatch(/padding:\s*6px/);
    // El radio del token es 8 px (0.625rem × 0.8): es lo que la caja necesita.
    expect(CSS).toMatch(/--radius-md:\s*calc\(var\(--radius\) \* 0\.8\)/);
    expect(CSS).toMatch(/--radius:\s*0\.625rem/);
    const arte = regla(".nvi-band-art");
    expect(arte).toMatch(/flex:\s*none/);
    expect(arte).toMatch(/align-self:\s*flex-start/);
    expect(arte).toMatch(/transition:\s*transform \.2s/);
    expect(reglaEnMedia("min-width: 640px", ".nvi-band-art")).toMatch(/align-self:\s*center/);
    expect(regla(".nvi-band-art:hover")).toMatch(/scale\(1\.02\)/);
    const quieto = /@media \(prefers-reduced-motion: reduce\) \{[^\n]*\.lp \.nvi-band-art:hover \{ transform: none; \}[^\n]*\.lp \.nvi-band-cta:hover svg \{ transform: none; \}/;
    expect(CSS).toMatch(quieto);
  });

  it("pie: en la columna de marca, en .ftr-creds junto al chip del algoritmo, y sin línea de texto", () => {
    const marca = PIE.indexOf('className="ftr-brand"');
    const creds = PIE.indexOf('className="ftr-creds"');
    const chip = PIE.indexOf('className="ftr-badge"');
    const distintivo = PIE.indexOf("<NvidiaInceptionBadge");
    const columnas = PIE.indexOf('className="ftr-cols"');
    expect(marca).toBeGreaterThan(-1);
    expect(creds).toBeGreaterThan(marca);
    expect(chip).toBeGreaterThan(creds);
    expect(distintivo).toBeGreaterThan(chip);
    expect(columnas).toBeGreaterThan(distintivo);
    // Se dice una vez: ni la línea de texto bajo las columnas ni su CSS.
    expect(PIE).not.toContain("ftr-nvidia");
    expect(PIE).not.toContain("nvidia.pie");
    expect(CSS).not.toContain(".ftr-nvidia");
    expect(PIE.match(/<NvidiaInceptionBadge/g)?.length).toBe(1);
    // La fila: en línea, centrada, envuelve, con su aire; el chip se centra en ella.
    const fila = regla(".ftr-creds");
    expect(fila).toMatch(/display:\s*flex/);
    expect(fila).toMatch(/align-items:\s*center/);
    expect(fila).toMatch(/flex-wrap:\s*wrap/);
    expect(fila).toMatch(/gap:\s*12px 14px/);
    expect(regla(".ftr-badge")).toMatch(/align-self:\s*center/);
  });

  it("en ningún otro sitio: dos distintivos desnudos (héroe y pie) y una banda", () => {
    const desnudos = (PAGINA.match(/<NvidiaInceptionBadge/g)?.length ?? 0) + (PIE.match(/<NvidiaInceptionBadge/g)?.length ?? 0);
    expect(desnudos).toBe(2);
    expect(PAGINA.match(/<NvidiaEcosystemBand/g)?.length).toBe(1);
    expect(PIE).not.toContain("NvidiaEcosystemBand");
  });
});
