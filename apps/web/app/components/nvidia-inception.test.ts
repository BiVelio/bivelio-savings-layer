/**
 * El distintivo del NVIDIA Inception Program, pinado a la guía de marca de
 * NVIDIA y a los tres sitios pedidos (héroe bajo los botones, banda de
 * ecosistema, columna de marca del pie).
 *
 * Nada de esto es gusto. El logotipo de un tercero trae reglas — solo el
 * fichero oficial, desnudo sobre fondo claro y sobre tarjeta blanca solo en
 * fondo oscuro, nunca por debajo de 120 px, siempre «NVIDIA Inception
 * Program» con «Program», siempre pertenencia y nunca aval — y el fallo es
 * silencioso: una edición posterior cambia el fichero por una copia
 * recoloreada, vuelve a meterlo en una tarjeta (el «marco dentro de otro» que
 * la revisión del 2026-09-14 rechazó), o acorta el nombre en un catálogo, y
 * nada más se pone rojo. Por eso las reglas se leen del SVG, del componente,
 * de la página, del pie, de la hoja de estilos y de los doce catálogos.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const AQUI = dirname(fileURLToPath(import.meta.url));
const WEB = join(AQUI, "..", "..");
const leer = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

const COMPONENTE = leer("app", "components", "NvidiaInception.tsx");
const PIE = leer("app", "components", "Footer.tsx");
const PAGINA = leer("app", "[locale]", "page.tsx");
const CSS = leer("app", "globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"];

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

describe("el logotipo es el de NVIDIA, servido desde este dominio", () => {
  const svg = leer("public", "nvidia-inception-program.svg");

  it("es el distintivo oficial, sin tocar", () => {
    // El fichero que envía NVIDIA: este viewBox, este verde, este grupo. Un
    // recoloreado, un recorte o un redibujado cambia al menos uno de los tres.
    expect(svg).toContain('viewBox="0 0 500.4288 216"');
    expect(svg).toContain("#76b900");
    expect(svg).toContain('data-name="Inception Program"');
    // Y trae su propio marco: el negro empieza a 25 unidades del borde. Es la
    // razón de que no lleve tarjeta sobre fondo claro.
    expect(svg).toMatch(/M25\.49926,25\.4052V190\.5948H474\.9307V25\.4052/);
  });

  it("no trae nada que la CSP tuviera que permitir", () => {
    expect(svg).not.toMatch(/<script|<image|xlink:href|url\(/i);
  });

  it("se referencia por ruta del propio dominio, nunca por CDN", () => {
    expect(COMPONENTE).toContain('NVIDIA_BADGE_SRC = "/nvidia-inception-program.svg"');
    expect(COMPONENTE).not.toMatch(/https?:\/\/[^"]*\.svg/);
    // `img-src 'self'` en next.config.mjs — el distintivo no necesita más.
    expect(leer("next.config.mjs")).toMatch(/img-src 'self'/);
  });
});

describe("el distintivo sigue la guía de marca", () => {
  it("enlaza a la página del programa en pestaña nueva y con noopener", () => {
    expect(COMPONENTE).toContain('NVIDIA_INCEPTION_URL = "https://www.nvidia.com/en-us/startups/"');
    const anclas = COMPONENTE.match(/<a\s[\s\S]*?href=\{NVIDIA_INCEPTION_URL\}[\s\S]*?>/g) ?? [];
    expect(anclas.length).toBe(1);
    for (const a of anclas) {
      expect(a).toContain('target="_blank"');
      expect(a).toMatch(/rel="[^"]*noopener[^"]*"/);
    }
    // El pie ya no enlaza por su cuenta: el único <a> al programa es el del componente.
    expect(PIE).not.toContain("NVIDIA_INCEPTION_URL");
  });

  it("el alt nombra el programa completo, y la imagen declara ancho, alto y proporción", () => {
    expect(COMPONENTE).toContain('alt="NVIDIA Inception Program"');
    expect(COMPONENTE).toMatch(/width=\{width\}/);
    expect(COMPONENTE).toMatch(/height=\{Math\.round\(width \* RATIO\)\}/);
    expect(COMPONENTE).toContain("216 / 500.4288");
    const img = regla(".nvi-badge img");
    expect(img).toMatch(/height:\s*auto/);
    expect(img).toMatch(/max-width:\s*100%/);
  });

  it("nunca se pinta por debajo de 120 px de ancho — en el marcado ni en la hoja de estilos", () => {
    const anchos = [
      ...[...COMPONENTE.matchAll(/width = (\d+)/g)].map((m) => Number(m[1])),
      ...[...PAGINA.matchAll(/<NvidiaInceptionBadge width=\{(\d+)\}/g)].map((m) => Number(m[1])),
      ...[...PIE.matchAll(/<NvidiaInceptionBadge width=\{(\d+)\}/g)].map((m) => Number(m[1])),
      // Las reglas que acotan el logotipo en móvil y en portátil corto.
      ...[...CSS.matchAll(/\.nvi-badge img \{ width: (\d+)px; \}/g)].map((m) => Number(m[1])),
    ];
    // Componente + héroe + banda + pie + las dos acotaciones de CSS.
    expect(anchos.length).toBeGreaterThanOrEqual(6);
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
    const m = JSON.parse(leer("messages", `${locale}.json`)) as {
      landing: { nvidia?: Record<string, string> };
    };
    const n = m.landing.nvidia;
    expect(n, "landing.nvidia").toBeDefined();
    // UNA sola frase de pertenencia por idioma, más el rótulo de la banda: las
    // claves de la frase larga («Parte del…, impulsando…») y del pie se fueron.
    expect(Object.keys(n!).sort()).toEqual(["miembro", "rotulo"]);
    expect(n!.rotulo!.length).toBeGreaterThan(0);
    // Siempre el nombre completo, nunca «NVIDIA Inception» a secas.
    expect(n!.miembro).toContain("NVIDIA Inception Program");
    expect(n!.miembro).not.toMatch(/NVIDIA Inception(?! Program)/);
    // Cinco palabras, no un anuncio: sin coma ni segunda oración.
    expect(n!.miembro).not.toMatch(/[,.:;—–]/);
    // Pertenencia, nunca aval — en las lenguas que un revisor puede leer.
    for (const v of Object.values(n!)) {
      expect(v).not.toMatch(/respald|aval|partner|endors|backed|certif|sponsor|patrocin/i);
    }
  });
});

describe("está en los tres sitios pedidos, y solo ahí", () => {
  it("héroe: una línea más bajo los botones, detrás de «Se instala en minutos…» y antes de «Compatible con»", () => {
    const cta = PAGINA.indexOf('className="hero-cta"');
    const nota = PAGINA.indexOf('className="hero-note"');
    const linea = PAGINA.indexOf('className="hero-nvidia"');
    const compat = PAGINA.indexOf('className="hero-compat"');
    expect(cta).toBeGreaterThan(-1);
    expect(nota).toBeGreaterThan(cta);
    expect(linea).toBeGreaterThan(nota);
    expect(compat).toBeGreaterThan(linea);
    // La línea es el distintivo y la frase de pertenencia, nada más: ni <p>
    // aparte ni la frase larga de la primera versión.
    const bloque = PAGINA.slice(linea, compat);
    expect(bloque).toMatch(/<NvidiaInceptionBadge width=\{\d+\} \/>\s*<span>\{t\("nvidia\.miembro"\)\}<\/span>/);
    expect(bloque).not.toContain("nvidia.frase");
    // Mismo cuerpo que la nota: 13 px, ink-soft, una fila que puede envolver.
    const nota_css = regla(".hero-note");
    const linea_css = regla(".hero-nvidia");
    for (const prop of [/font-size:\s*13px/, /color:\s*var\(--ink-soft\)/, /display:\s*flex/, /align-items:\s*center/]) {
      expect(nota_css).toMatch(prop);
      expect(linea_css).toMatch(prop);
    }
    expect(linea_css).toMatch(/flex-wrap:\s*wrap/);
    // En pantalla baja el distintivo va a su mínimo, no por debajo.
    expect(CSS).toMatch(/@media \(max-height: 720px\) \{ \.lp \.hero-nvidia \.nvi-badge img \{ width: 120px; \} \}/);
  });

  it("banda de ecosistema: la última de la home, rótulo mono + distintivo desnudo + la frase, sin tarjeta", () => {
    const banda = PAGINA.indexOf('className="ecosistema"');
    const finMain = PAGINA.indexOf("</main>");
    expect(banda).toBeGreaterThan(-1);
    expect(finMain).toBeGreaterThan(banda);
    const bloque = PAGINA.slice(banda, finMain);
    expect(bloque).toMatch(/className="hm-k" id="ecosistema-rotulo">\{t\("nvidia\.rotulo"\)\}/);
    expect(bloque).toMatch(/<NvidiaInceptionBadge width=\{150\} \/>\s*<span>\{t\("nvidia\.miembro"\)\}<\/span>/);
    expect(bloque).not.toContain("onDark");
    // Rótulo mono en mayúsculas, texto en gris; en la banda no hay ningún
    // logotipo de proveedor, así que tampoco hace falta filete que los separe.
    expect(regla(".ecosistema .hm-k")).toMatch(/text-transform:\s*uppercase/);
    expect(regla(".ecosistema .hm-k")).toMatch(/var\(--mono\)/);
    expect(regla(".ecosistema-fila")).toMatch(/color:\s*var\(--ink-soft\)/);
    expect(bloque).not.toContain("LogoProveedor");
    // Bajo 700 px: rótulo en una columna de 112 px y distintivo a 136.
    const movil = CSS.slice(CSS.indexOf("@media (max-width: 700px) {\n  .lp section.ecosistema"));
    const fin = movil.indexOf("\n}\n");
    expect(fin).toBeGreaterThan(-1);
    const bloqueMovil = movil.slice(0, fin);
    expect(bloqueMovil).toMatch(/grid-template-columns:\s*112px minmax\(0, 1fr\)/);
    expect(bloqueMovil).toMatch(/\.lp \.ecosistema \.nvi-badge img \{ width: 136px; \}/);
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

  it("en ningún otro sitio: tres usos del componente en total", () => {
    const usos = (PAGINA.match(/<NvidiaInceptionBadge/g)?.length ?? 0) + (PIE.match(/<NvidiaInceptionBadge/g)?.length ?? 0);
    expect(usos).toBe(3);
  });
});
