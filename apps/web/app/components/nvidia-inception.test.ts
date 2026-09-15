/**
 * El distintivo del NVIDIA Inception Program, pinado a la guía de marca de
 * NVIDIA y a los DOS sitios pedidos (banda «Compañía y ecosistema» antes del
 * pie, columna de marca del pie) — y a que el héroe NO lo lleve: el distintivo
 * desnudo bajo los botones (2026-09-14) se fue el 2026-09-15 por decisión del
 * CEO, y con él su componente, su clase, sus reglas y su clave de copy.
 *
 * Nada de esto es gusto. El logotipo de un tercero trae reglas — solo el
 * fichero oficial, en la banda y en el pie sobre la caja blanca de
 * bivelio.com, nunca por debajo de 120 px, siempre «NVIDIA Inception
 * Program» con «Program», siempre pertenencia y nunca aval — y el fallo es
 * silencioso: una edición posterior cambia el fichero por una copia
 * recoloreada, vuelve a colar el sello en el héroe, pinta la caja de la banda
 * o la del pie con un token que una paleta oscura invertiría, o acorta el
 * nombre en un catálogo, y nada más se pone rojo. Y la banda y el pie son los
 * MISMOS que los de bivelio.com (capturas aprobadas el 2026-09-15): medidas,
 * colores y copy verbatim en 12 idiomas, y «BiVelio» como en bivelio.com y en
 * privacy (#304): las letras en el navy del logotipo y las dos íes con su
 * punto de color, no un <strong> en el azul de acento. Por eso las reglas se
 * leen del SVG, del componente, de la marca, de la página, del pie, de la
 * hoja de estilos y de los doce catálogos.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { NvidiaEcosystemBand, NvidiaFooterCard, partirMarca } from "./NvidiaInception";

// vitest compila el .tsx con el runtime CLÁSICO de JSX (el tsconfig dice
// `preserve` y esbuild lo baja a `React.createElement`), así que el componente
// espera un `React` global que Next sí inyecta y aquí no hay. Se le da.
(globalThis as { React?: typeof React }).React = React;

const AQUI = dirname(fileURLToPath(import.meta.url));
const WEB = join(AQUI, "..", "..");
const leer = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

const COMPONENTE = leer("app", "components", "NvidiaInception.tsx");
const MARCA = leer("app", "components", "BivelioWordmark.tsx");
const PIE = leer("app", "components", "Footer.tsx");
const PAGINA = leer("app", "[locale]", "page.tsx");
const CSS = leer("app", "globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"];
const CLAVES_BANDA = ["kicker", "title", "sub", "cta"];

const escapar = (s: string) => s.replace(/[.*+?^()|[\]\\]/g, "\\$&");

/** Cuerpo de la primera regla que empieza línea con exactamente `.lp <sel> {`:
 *  `.nvi-foot` no casa con `.nvi-foot img`, `.nvi-foot:hover` ni
 *  `.nvi-foot-box`, y las reglas sangradas dentro de un @media quedan fuera. */
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
    // Un único <img> (NvidiaInceptionArt) que comparten la caja de la banda y
    // la tarjeta del pie: no hay dos formas de pintar el logotipo.
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
    // El CTA de la banda, la caja de la banda y la tarjeta del pie.
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
    for (const sel of [".nvi-band-box img", ".nvi-foot-box img"]) {
      const img = regla(sel);
      expect(img).toMatch(/height:\s*auto/);
      expect(img).toMatch(/max-width:\s*100%/);
    }
  });

  it("nunca se pinta por debajo de 120 px de ancho — en el marcado ni en la hoja de estilos", () => {
    const anchos = [...COMPONENTE.matchAll(/<NvidiaInceptionArt width=\{(\d+)\}/g)].map((m) => Number(m[1]));
    // Banda + pie, y ningún otro: ni el <img> admite otro ancho ni queda una
    // regla que lo acote (la de 120 px en portátil corto se fue con el héroe).
    expect(anchos.length).toBe(2);
    for (const w of anchos) expect(w).toBeGreaterThanOrEqual(120);
    expect(CSS).not.toMatch(/img \{ width: \d+px; \}/);
  });
});

describe("los doce catálogos lo dicen como pertenencia, completo y con «Program»", () => {
  it.each(LOCALES)("%s", (locale) => {
    const n = catalogo(locale);
    expect(n, "landing.nvidia").toBeDefined();
    // Las cuatro de la banda (el copy aprobado de bivelio.com), que el pie
    // reutiliza: el rótulo «Ecosistema» de la banda anterior se fue con ella y
    // la frase corta del héroe («Miembro del…», `miembro`) se fue con el héroe.
    expect(Object.keys(n!).sort()).toEqual(["cta", "kicker", "sub", "title"]);
    for (const v of Object.values(n!)) expect(v.trim().length).toBeGreaterThan(0);
    // Siempre el nombre completo, nunca «NVIDIA Inception» a secas — en el
    // título de la banda, que es el que lo nombra (y el pie lo reutiliza).
    expect(n!.title, "title").toContain("NVIDIA Inception Program");
    for (const v of Object.values(n!)) expect(v).not.toMatch(/NVIDIA Inception(?! Program)/);
    // Banda: el título nombra a BiVelio tal cual (es lo que `partirMarca`
    // sustituye por BvBrandWord) y termina en punto; el sub es una sola frase.
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
    // Y nadie pide lo que ya no existe (las tres de las versiones anteriores y
    // la frase corta del héroe).
    for (const vieja of ["nvidia.rotulo", "nvidia.frase", "nvidia.pie", "nvidia.miembro"]) {
      expect(PAGINA).not.toContain(vieja);
      expect(PIE).not.toContain(vieja);
      expect(COMPONENTE).not.toContain(vieja);
    }
  });
});

describe("partirMarca: la marca con su tratamiento sin tocar el copy", () => {
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

  it("y el componente la usa sobre el título: el nombre lo pinta BvBrandWord, no un <strong> en azul", () => {
    expect(COMPONENTE).toMatch(/const partes = partirMarca\(title\)/);
    expect(COMPONENTE).toContain('import { BvBrandWord } from "./BivelioWordmark";');
    expect(COMPONENTE).toMatch(/\{partes\[0\]\}\s*<strong className="nvi-brand">\s*<BvBrandWord \/>\s*<\/strong>\s*\{partes\[2\]\}/);
    // El texto plano «BiVelio» ya no se pinta: lo dibuja la marca.
    expect(COMPONENTE).not.toMatch(/<strong>\{partes\[1\]\}<\/strong>/);
    // Sin marca en la frase, el título va tal cual: nada se inventa.
    expect(COMPONENTE).toMatch(/\) : \(\s*title\s*\)/);
  });
});

describe("«BiVelio» en el título de la banda: navy con las íes en color, como bivelio.com y privacy", () => {
  it("BvBrandWord: el nombre una vez para el lector de pantalla, y el dibujo (dos íes con punto) aria-hidden y sin partir", () => {
    const fn = MARCA.slice(MARCA.indexOf("export function BvBrandWord"), MARCA.indexOf("export function BivelioWordmark"));
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain('<span className="sr-only">BiVelio</span>');
    expect(fn).toMatch(/<span aria-hidden>\s*B<IConPunto color=\{PUNTO_PRIMERO\} \/>Vel<IConPunto color=\{PUNTO_CENTRO\} \/>o\s*<\/span>/);
    expect(fn).toContain('whiteSpace: "nowrap"');
    // Sin el punto final del logotipo: es el nombre en una frase, no el logotipo.
    expect(fn).not.toContain("PUNTO_FINAL");
    // Ni familia, ni peso, ni tamaño propios: los hereda del título.
    expect(fn).not.toMatch(/fontFamily|fontWeight|fontSize/);
  });

  it("los puntos son los dos azules del logotipo (los mismos que privacy y bivelio.com)", () => {
    expect(MARCA).toContain('const PUNTO_PRIMERO = "#00B3FC"');
    expect(MARCA).toContain('const PUNTO_CENTRO = "#0073FF"');
    // La «ı» sin punto (U+0131) con el círculo propio encima, medido: 0.17em a 0.08em.
    expect(MARCA).toContain('{"ı"}');
    expect(MARCA).toMatch(/top:\s*"0\.08em"/);
    expect(MARCA).toMatch(/width:\s*"0\.17em"/);
  });

  it("renderizado: «BiVelio» sale UNA vez (sr-only), las dos astas sin punto van ocultas al lector y no se parte", () => {
    const html = renderToStaticMarkup(
      React.createElement(NvidiaEcosystemBand, { kicker: "K", title: "BiVelio es miembro del NVIDIA Inception Program.", sub: "S.", cta: "C" }),
    );
    const titulo = /<p class="nvi-band-t" id="nvi-band-title">([\s\S]*?)<\/p>/.exec(html);
    expect(titulo).not.toBeNull();
    const t = titulo![1]!;
    expect(t.match(/BiVelio/g)?.length).toBe(1);
    // El nombre: nowrap → sr-only «BiVelio» → el dibujo aria-hidden, y nada más.
    const nombre = /^<strong class="nvi-brand"><span style="white-space:nowrap"><span class="sr-only">BiVelio<\/span><span aria-hidden="true">(.*?)<\/span><\/span><\/strong>/.exec(t);
    expect(nombre, "estructura del nombre").not.toBeNull();
    const dibujo = nombre![1]!;
    // Dos «ı» (U+0131), cada una con su punto: cian la primera, azul la segunda;
    // y las letras, tal cual: B ı Vel ı o.
    expect(dibujo.match(/ı/g)?.length).toBe(2);
    expect(dibujo).toMatch(/ı<span aria-hidden="true" style="[^"]*background:#00B3FC/);
    expect(dibujo).toMatch(/ı<span aria-hidden="true" style="[^"]*background:#0073FF/);
    expect(dibujo.replace(/<[^>]+>/g, "")).toBe("BıVelıo");
    // Lo que el lector de pantalla oye es la frase entera, con el nombre una vez.
    const audible = t.replace(nombre![0], '<span class="sr-only">BiVelio</span>').replace(/<[^>]+>/g, "");
    expect(audible).toBe("BiVelio es miembro del NVIDIA Inception Program.");
    // Y el «después» va tal cual detrás del nombre.
    expect(t.slice(nombre![0].length)).toBe(" es miembro del NVIDIA Inception Program.");
  });

  it("la hoja: el nombre en el navy del logotipo al peso del título, y ni rastro del azul de acento", () => {
    const marca = regla(".nvi-band-t .nvi-brand");
    expect(marca).toMatch(/color:\s*var\(--navy\)/);
    expect(marca).toMatch(/font-weight:\s*inherit/);
    expect(marca).not.toMatch(/--accent|--brand\b/);
    // La regla anterior (<strong> en azul) se fue del todo.
    expect(CSS).not.toMatch(/\.nvi-band-t strong/);
    // El token es el navy exacto de la rampa de bivelio.com (privacy: --ramp-navy).
    expect(CSS).toMatch(/--navy:\s*#020852;/);
    // Y `.sr-only` existe de verdad: fuera del flujo, 1×1 y recortada.
    const sr = /(?:^|\n)\.sr-only \{([^}]*)\}/.exec(CSS);
    expect(sr, ".sr-only").not.toBeNull();
    expect(sr![1]).toMatch(/position:\s*absolute/);
    expect(sr![1]).toMatch(/width:\s*1px/);
    expect(sr![1]).toMatch(/height:\s*1px/);
    expect(sr![1]).toMatch(/overflow:\s*hidden/);
    expect(sr![1]).toMatch(/clip-path:\s*inset\(50%\)/);
  });
});

describe("está en los dos sitios pedidos, y solo ahí — el héroe ya no", () => {
  it("héroe: SIN el sello — de «Se instala en minutos…» se pasa a «Compatible con» como antes del distintivo", () => {
    const cta = PAGINA.indexOf('className="hero-cta"');
    const nota = PAGINA.indexOf('className="hero-note"');
    const compat = PAGINA.indexOf('className="hero-compat"');
    expect(cta).toBeGreaterThan(-1);
    expect(nota).toBeGreaterThan(cta);
    expect(compat).toBeGreaterThan(nota);
    // Entre la nota y «Compatible con» no hay componente, clase ni copy del
    // programa: ni el distintivo desnudo, ni su <div>, ni la frase corta.
    const entre = PAGINA.slice(nota, compat);
    expect(entre).not.toMatch(/Nvidia|nvidia|NVIDIA/);
    expect(entre).not.toContain("hero-nvidia");
    expect(entre).not.toMatch(/<(a|img)\s/);
    // Y en toda la página, solo la banda: ni el componente del héroe (que ya
    // no existe) ni su clave.
    expect(PAGINA).not.toContain("NvidiaInceptionBadge");
    expect(PAGINA).not.toContain("hero-nvidia");
    expect(PAGINA).not.toContain("nvidia.miembro");
    expect(PAGINA).toContain('import { NvidiaEcosystemBand } from "@/app/components/NvidiaInception";');
    expect(COMPONENTE).not.toContain("NvidiaInceptionBadge");
    expect(COMPONENTE).not.toContain("onDark");
    expect(COMPONENTE).not.toContain("nvi-badge");
    // La hoja: ni `.hero-nvidia`, ni `.nvi-badge*`, ni la acotación a 120 px
    // en pantalla baja que solo servía al héroe (la otra regla de
    // `max-height: 720px`, la que deja al héroe sin altura forzada, se queda).
    expect(CSS).not.toContain(".hero-nvidia");
    expect(CSS).not.toContain(".nvi-badge");
    expect(CSS).not.toMatch(/max-height: 720px\)[^\n]*120px/);
    expect(CSS).toMatch(/@media \(max-height: 720px\) \{\n\s*\.lp \.hero \{ min-height: 0;/);
    // La separación de antes del distintivo: «Compatible con» sigue a 30 px de
    // la nota con su hairline y sus 20 px de aire, y la nota conserva sus 20.
    const compat_css = regla(".hero-compat");
    expect(compat_css).toMatch(/margin-top:\s*30px/);
    expect(compat_css).toMatch(/padding-top:\s*20px/);
    expect(compat_css).toMatch(/border-top:\s*1px solid var\(--line\)/);
    expect(regla(".hero-note")).toMatch(/margin-top:\s*20px/);
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

  it("pie: cierra la columna de marca como en bivelio.com — logo, frase, chip, dock social y DESPUÉS la tarjeta; el chip solo en su fila", () => {
    const marca = PIE.indexOf('className="ftr-brand"');
    const logo = PIE.indexOf('className="ftr-logo"');
    const frase = PIE.indexOf('t.rich("footer.tagline"');
    const creds = PIE.indexOf('className="ftr-creds"');
    const chip = PIE.indexOf('className="ftr-badge"');
    const finCreds = PIE.indexOf("</div>", chip);
    const dock = PIE.indexOf("<SocialDock />");
    const tarjeta = PIE.indexOf("<NvidiaFooterCard");
    const columnas = PIE.indexOf('className="ftr-cols"');
    expect(marca).toBeGreaterThan(-1);
    expect(logo).toBeGreaterThan(marca);
    expect(frase).toBeGreaterThan(logo);
    expect(creds).toBeGreaterThan(frase);
    expect(chip).toBeGreaterThan(creds);
    expect(dock).toBeGreaterThan(finCreds);
    expect(tarjeta).toBeGreaterThan(dock);
    expect(columnas).toBeGreaterThan(tarjeta);
    // La frase del pie es la clave `title` de la banda, no una copia en doce
    // catálogos: el pie lee el namespace `landing` entero.
    expect(PIE).toContain('<NvidiaFooterCard line={t("nvidia.title")} />');
    expect(PIE).toContain('getTranslations("landing")');
    expect(PIE).not.toContain("footer.nvidia");
    // El distintivo desnudo de 124 px que iba en .ftr-creds junto al chip se
    // fue: dentro de la fila queda solo el chip, y el pie no importa el desnudo.
    expect(PIE.slice(creds, finCreds)).not.toContain("Nvidia");
    expect(PIE).not.toContain("NvidiaInceptionBadge");
    expect(PIE.match(/<NvidiaFooterCard/g)?.length).toBe(1);
    // Se dice una vez: ni la línea de texto bajo las columnas ni su CSS.
    expect(PIE).not.toContain("ftr-nvidia");
    expect(PIE).not.toContain("nvidia.pie");
    expect(CSS).not.toContain(".ftr-nvidia");
    // La fila del chip: flex para que el `align-self: center` del chip lo
    // centre en su línea y no en la columna; ya no envuelve dos credenciales.
    const fila = regla(".ftr-creds");
    expect(fila).toMatch(/display:\s*flex/);
    expect(fila).toMatch(/align-items:\s*center/);
    expect(fila).not.toMatch(/flex-wrap/);
    expect(regla(".ftr-badge")).toMatch(/align-self:\s*center/);
  });

  it("pie: un único enlace en columna que apila la tarjeta blanca (arte a 150) y la frase con la marca", () => {
    const pie = COMPONENTE.slice(COMPONENTE.indexOf("export function NvidiaFooterCard"));
    expect(pie.length).toBeGreaterThan(0);
    // Un solo <a>, al programa, en pestaña nueva y con noopener.
    expect(pie.match(/<a\s/g)?.length).toBe(1);
    expect(pie).toContain('<a className="nvi-foot" href={NVIDIA_INCEPTION_URL} target="_blank" rel="noopener noreferrer">');
    // Dentro, primero la tarjeta con el arte a 150 (≥ 120), después la frase.
    const caja = pie.indexOf('className="nvi-foot-box"');
    const frase = pie.indexOf('className="nvi-foot-line"');
    expect(caja).toBeGreaterThan(-1);
    expect(frase).toBeGreaterThan(caja);
    expect(pie).toMatch(/<span className="nvi-foot-box">\s*<NvidiaInceptionArt width=\{150\} \/>/);
    // La frase: el mismo partidor que la banda y el nombre en BvBrandWord.
    expect(pie).toMatch(/const partes = partirMarca\(line\)/);
    expect(pie).toMatch(/\{partes\[0\]\}\s*<span className="nvi-brand">\s*<BvBrandWord \/>\s*<\/span>\s*\{partes\[2\]\}/);
    expect(pie).toMatch(/\) : \(\s*line\s*\)/);
    // Ni el distintivo desnudo ni la tarjeta de fondo oscuro: es la caja de bivelio.com.
    expect(pie).not.toContain("nvi-badge");
    expect(pie).not.toContain("onDark");
  });

  it("pie: renderizado — la tarjeta, el <img> con su alt y la frase entera con «BiVelio» una vez", () => {
    const html = renderToStaticMarkup(
      React.createElement(NvidiaFooterCard, { line: "BiVelio es miembro del NVIDIA Inception Program." }),
    );
    expect(html.match(/<a /g)?.length).toBe(1);
    expect(html).toMatch(/^<a class="nvi-foot" href="https:\/\/www\.nvidia\.com\/en-us\/startups\/" target="_blank" rel="noopener noreferrer">/);
    expect(html).toMatch(/<span class="nvi-foot-box"><img src="\/nvidia-inception-program\.svg" width="150" height="65" alt="NVIDIA Inception Program"/);
    const frase = /<span class="nvi-foot-line">([\s\S]*?)<\/span><\/a>$/.exec(html);
    expect(frase, "frase").not.toBeNull();
    const f = frase![1]!;
    expect(f.match(/BiVelio/g)?.length).toBe(1);
    expect(f).toMatch(/^<span class="nvi-brand"><span style="white-space:nowrap"><span class="sr-only">BiVelio<\/span><span aria-hidden="true">/);
    expect(f.replace(/<[^>]+>/g, "")).toBe("BiVelioBıVelıo es miembro del NVIDIA Inception Program.");
    expect(f.endsWith(" es miembro del NVIDIA Inception Program.")).toBe(true);
    // Sin marca en la frase, va tal cual.
    const plano = renderToStaticMarkup(React.createElement(NvidiaFooterCard, { line: "Miembro del programa." }));
    expect(plano).toContain('<span class="nvi-foot-line">Miembro del programa.</span>');
    expect(plano).not.toContain("nvi-brand");
  });

  it("pie: las medidas de bivelio.com — enlace en columna a 10 px, 28 px por encima, escala 1.02; tarjeta blanca LITERAL, borde, radio 12, 4 px; frase a 11 px al 80 %", () => {
    const enlace = regla(".nvi-foot");
    expect(enlace).toMatch(/display:\s*flex/);
    expect(enlace).toMatch(/flex-direction:\s*column/);
    expect(enlace).toMatch(/align-items:\s*flex-start/);
    expect(enlace).toMatch(/gap:\s*10px/);
    expect(enlace).toMatch(/width:\s*fit-content/);
    expect(enlace).toMatch(/margin-top:\s*28px/);
    expect(enlace).toMatch(/transition:\s*transform \.2s/);
    const hover = regla(".nvi-foot:hover");
    expect(hover).toMatch(/scale\(1\.02\)/);
    expect(hover).toMatch(/text-decoration:\s*none/);
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^\n]*\.lp \.nvi-foot:hover \{ transform: none; \}/);
    const caja = regla(".nvi-foot-box");
    expect(caja).toMatch(/display:\s*inline-flex/);
    expect(caja).toMatch(/align-items:\s*center/);
    expect(caja).toMatch(/justify-content:\s*center/);
    // Blanco LITERAL, no `var(--surface)`: una paleta oscura no puede invertirla.
    expect(caja).toMatch(/background:\s*#FFFFFF\b/i);
    expect(caja).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(caja).toMatch(/border-radius:\s*12px/);
    // ≥ 4 px de aire: 4 + los ≈7,5 px transparentes del SVG oficial a 150 dan
    // los 10–12 de bivelio.com, que recorta el suyo al marco.
    const padding = /padding:\s*(\d+)px/.exec(caja);
    expect(padding, "padding").not.toBeNull();
    expect(Number(padding![1])).toBeGreaterThanOrEqual(4);
    expect(caja).not.toMatch(/box-shadow/);
    const frase = regla(".nvi-foot-line");
    expect(frase).toMatch(/font-size:\s*11px/);
    expect(frase).toMatch(/line-height:\s*1\.6/);
    expect(frase).toMatch(/color:\s*color-mix\(in srgb, var\(--muted\) 80%, transparent\)/);
    expect(frase).toMatch(/max-width:\s*15rem/);
    const marca = regla(".nvi-foot-line .nvi-brand");
    expect(marca).toMatch(/color:\s*var\(--navy\)/);
    expect(marca).not.toMatch(/--accent|--brand\b/);
  });

  it("en ningún otro sitio: una banda y una tarjeta en el pie — y nada en el héroe", () => {
    expect(PAGINA).not.toContain("NvidiaInceptionBadge");
    expect(PIE).not.toContain("NvidiaInceptionBadge");
    expect(PAGINA.match(/<NvidiaEcosystemBand/g)?.length).toBe(1);
    expect(PIE).not.toContain("NvidiaEcosystemBand");
    expect(PIE.match(/<NvidiaFooterCard/g)?.length).toBe(1);
    expect(PAGINA).not.toContain("NvidiaFooterCard");
  });
});
