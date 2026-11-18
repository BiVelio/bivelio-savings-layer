import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BotonProductHunt, InsigniaProductHunt } from "./ProductHunt";
import { TarjetaProductHunt } from "./landing/TarjetaProductHunt";
import {
  FIN_CAMPANA,
  INSIGNIA_PH,
  LANZAMIENTO,
  MINIATURA_PH,
  URL_TARJETA_PH,
  VARIANTES,
  botonDeLaTarjeta,
  elegirVariante,
  guionPrevio,
  hojaDelGuion,
  hojaProductHunt,
  insigniaAlcanzable,
  laMasAvanzada,
  tocaInsignia,
  type LugarInsignia,
  type Variante,
} from "./franja-lanzamiento";

/**
 * LA INSIGNIA Y LA TARJETA DE PRODUCT HUNT (lanzamiento del 22-11-2026).
 *
 * La insignia oficial va en el pie desde el lanzamiento y para siempre, y en el
 * héroe solo la semana del lanzamiento; antes no aparece y su imagen no se
 * pide. La tarjeta del final de la portada cambia el texto del botón y mide lo
 * mismo en las tres ventanas. Mismas fronteras que la franja.
 */

const DIA = 24 * 60 * 60 * 1000;
const WEB = fileURLToPath(new URL("../../", import.meta.url));
const leer = (ruta: string) => readFileSync(`${WEB}${ruta}`, "utf8");
const amp = (s: string) => s.replace(/&/g, "&amp;");

describe("cuándo va la insignia", () => {
  it("héroe: solo la semana del lanzamiento; pie: desde el lanzamiento, para siempre", () => {
    expect(VARIANTES.map((v) => tocaInsignia("heroe", v))).toEqual([false, true, false]);
    expect(VARIANTES.map((v) => tocaInsignia("pie", v))).toEqual([false, true, true]);
    expect(tocaInsignia("pie", elegirVariante(LANZAMIENTO - 1))).toBe(false);
    expect(tocaInsignia("pie", elegirVariante(LANZAMIENTO))).toBe(true);
    expect(tocaInsignia("heroe", elegirVariante(FIN_CAMPANA - 1))).toBe(true);
    expect(tocaInsignia("heroe", elegirVariante(FIN_CAMPANA))).toBe(false);
    expect(tocaInsignia("pie", elegirVariante(FIN_CAMPANA + 365 * DIA))).toBe(true);
  });

  it("qué puede llegar a enseñar una página según su build", () => {
    expect(insigniaAlcanzable("heroe", "aviso")).toBe(true);
    expect(insigniaAlcanzable("heroe", "en-vivo")).toBe(true);
    expect(insigniaAlcanzable("heroe", "bivelio")).toBe(false);
    for (const v of VARIANTES) expect(insigniaAlcanzable("pie", v)).toBe(true);
  });

  it("el botón de la tarjeta: «avísame» antes; «échale un vistazo» durante y después", () => {
    expect(VARIANTES.map(botonDeLaTarjeta)).toEqual(["aviso", "vivo", "vivo"]);
  });
});

describe("la insignia es la oficial de PH, tal cual", () => {
  it("enlace, imagen (tema light), medidas y alt", () => {
    expect(INSIGNIA_PH.href).toBe(
      "https://www.producthunt.com/products/bivelio-savings-layer?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-bivelio-savings-layer",
    );
    expect(INSIGNIA_PH.src).toBe("https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1321519&theme=light&t=1795000351842");
    expect(INSIGNIA_PH.src).toContain("theme=light");
    expect([INSIGNIA_PH.width, INSIGNIA_PH.height]).toEqual([250, 54]);
    expect(INSIGNIA_PH.alt).toBe("BiVelio Savings Layer - Cut LLM costs with an open-source savings layer | Product Hunt");
    expect(URL_TARJETA_PH).toBe("https://www.producthunt.com/products/bivelio-savings-layer?embed=true&utm_source=embed&utm_medium=post_embed");
  });
});

const insignia = (lugar: LugarInsignia, inicial: Variante) =>
  renderToString(createElement(InsigniaProductHunt, { lugar, inicial, nuevaPestana: "(opens in a new tab)" }));

describe("el HTML del servidor de la insignia", () => {
  it("antes del lanzamiento: un hueco vacío y escondido, SIN imagen de PH (no se pide)", () => {
    for (const lugar of ["heroe", "pie"] as const) {
      const html = insignia(lugar, "aviso");
      expect(html).toBe(`<span class="ph-insignia" data-ph-espera="${lugar}" aria-hidden="true"></span>`);
      expect(html).not.toContain("producthunt");
      expect(html).not.toContain("<img");
    }
  });

  it("en vivo: la imagen oficial en el héroe (sin lazy) y en el pie (lazy), con su hueco de 250×54", () => {
    for (const lugar of ["heroe", "pie"] as const) {
      const html = insignia(lugar, "en-vivo");
      expect(html).toContain(`class="ph-insignia" data-ph="${lugar}"`);
      expect(html).toContain(`href="${amp(INSIGNIA_PH.href)}"`);
      expect(html).toContain('target="_blank" rel="noopener noreferrer"');
      expect(html).toContain(`src="${amp(INSIGNIA_PH.src)}"`);
      expect(html).toContain('width="250" height="54"');
      expect(html).toContain(`alt="${INSIGNIA_PH.alt}"`);
      expect(html).toContain('lang="en"');
      expect(html).toContain('referrerPolicy="strict-origin-when-cross-origin"');
      expect(html).toMatch(/<span class="sr-only"> (<!-- -->)?\(opens in a new tab\)<\/span><\/a>$/);
      // Baja prioridad y sin <link rel="preload">: no compite con el paisaje del héroe (el LCP).
      expect(html).toContain('fetchPriority="low"');
      expect(html).not.toContain("<link");
      expect(html).not.toContain("data-oculta");
      expect(html.includes('loading="lazy"')).toBe(lugar === "pie");
    }
  });

  it("después de la campaña: en el pie sigue; en el héroe no queda nada", () => {
    expect(insignia("pie", "bivelio")).toContain(`src="${amp(INSIGNIA_PH.src)}"`);
    expect(insignia("heroe", "bivelio")).toBe("");
  });
});

describe("la tarjeta del final de la portada", () => {
  const boton = (inicial: Variante) =>
    renderToString(createElement(BotonProductHunt, { inicial, aviso: "Get notified on Product Hunt", vivo: "Check it out on Product Hunt", nuevaPestana: "(opens in a new tab)" }));

  it.each(VARIANTES)("build en «%s»: los dos textos apilados, solo el que toca visible", (v) => {
    const html = boton(v);
    expect(html.match(/data-ph-boton="(aviso|vivo)"/g)).toEqual(['data-ph-boton="aviso"', 'data-ph-boton="vivo"']);
    const oculto = botonDeLaTarjeta(v) === "aviso" ? "vivo" : "aviso";
    expect(html).toMatch(new RegExp(`data-ph-boton="${oculto}" data-oculta="true" aria-hidden="true"`));
    expect(html.match(/data-oculta="true"/g)).toHaveLength(1);
    expect(html).toContain(`href="${amp(URL_TARJETA_PH)}" target="_blank" rel="noopener"`);
    expect(html).toContain("(opens in a new tab)");
    // La flecha va con la última palabra, sin poder partir.
    expect(html).toMatch(/<span class="ph-cola">Product\u00A0Hunt(<!-- -->)? <svg/);
  });

  it("la miniatura es la nuestra, servida a 64×64 con su 2×; ni imgix ni imágenes de PH", () => {
    const html = renderToString(
      createElement(TarjetaProductHunt, {
        inicial: "aviso",
        t: { kicker: "Find us on Product Hunt", lema: "Cut LLM costs with an open-source savings layer", aviso: "a", vivo: "b c", nuevaPestana: "(nt)" },
      }),
    );
    expect(html).toContain('width="64" height="64"');
    expect(html).toContain(encodeURIComponent(MINIATURA_PH));
    expect(html).toMatch(/w=64&amp;q=\d+ 1x, [^"]*w=128&amp;q=\d+ 2x/);
    expect(html).not.toMatch(/imgix|ph-files|producthunt\.com\/[^"]*\.(png|jpe?g|gif|webp)/);
    expect(html).toContain("BiVelio Savings Layer");
    expect(html).toMatch(/<h2 class="ph-k" id="ph-sec-t">Find us on <span class="mk">Product Hunt<\/span><\/h2>/);
    expect(html).toContain('aria-labelledby="ph-sec-t"');
    // Una imagen en toda la tarjeta, decorativa (el nombre va al lado).
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain('alt=""');
  });

  it("el fichero de la miniatura existe, fechado, 240×240", () => {
    const ruta = `${WEB}public${MINIATURA_PH}`;
    expect(MINIATURA_PH).toMatch(/^\/brand\/product-hunt-thumb-\d{4}-\d{2}\.png$/);
    const png = readFileSync(ruta);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([240, 240]);
    expect(statSync(ruta).size).toBeLessThan(100_000);
  });
});

describe("el guion previo también corrige la insignia y la tarjeta", () => {
  it("cada regla apunta a lo que pintan los componentes", () => {
    expect(hojaProductHunt("aviso", "en-vivo")).toBe(
      '.ph-insignia[data-ph-espera="heroe"]{display:block}.ph-insignia[data-ph-espera="pie"]{display:block}' +
        '.ph-pila>[data-ph-boton="aviso"]{visibility:hidden}.ph-pila>[data-ph-boton="vivo"]{visibility:visible}',
    );
    // Del aviso a después de la campaña: el héroe sigue sin insignia; el pie la enseña.
    expect(hojaProductHunt("aviso", "bivelio")).toBe(
      '.ph-insignia[data-ph-espera="pie"]{display:block}' +
        '.ph-pila>[data-ph-boton="aviso"]{visibility:hidden}.ph-pila>[data-ph-boton="vivo"]{visibility:visible}',
    );
    // De en vivo a después: fuera la del héroe; el botón ya decía lo mismo.
    expect(hojaProductHunt("en-vivo", "bivelio")).toBe('.ph-insignia[data-ph="heroe"]{display:none}');
    expect(hojaProductHunt("en-vivo", "aviso")).toBe("");
    expect(hojaProductHunt("bivelio", "bivelio")).toBe("");
  });

  it("las reglas del guion pesan lo mismo que las de la hoja y llegan después: ganan", () => {
    const css = leer("app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.ph-insignia\[data-ph-espera\]\s*\{\s*display:\s*none;\s*\}/);
    expect(css).toMatch(/\.ph-pila > \[data-oculta\]\s*\{\s*visibility:\s*hidden;\s*\}/);
    expect(css).toMatch(/\.ph-insignia\s*\{\s*display:\s*block;/);
    // `.ph-insignia[data-ph-espera]` (0,2,0) frente a `.ph-insignia[data-ph-espera="heroe"]` (0,2,0).
    expect(hojaProductHunt("aviso", "en-vivo")).toContain(".ph-insignia[data-ph-espera=");
  });

  it("el guion de un build en aviso lleva la insignia y la tarjeta en cada ventana", () => {
    const guion = guionPrevio("aviso")!;
    expect(guion).toContain(JSON.stringify(hojaDelGuion("aviso", "en-vivo")).slice(1, -1));
    expect(guion).toContain(JSON.stringify(hojaDelGuion("aviso", "bivelio")).slice(1, -1));
    expect(guion).not.toMatch(/<\/|<!--/);
  });

  it("el hueco que enseña el guion es el que pinta el servidor (heroe y pie)", () => {
    for (const lugar of ["heroe", "pie"] as const) {
      expect(insignia(lugar, "aviso")).toContain(`data-ph-espera="${lugar}"`);
      expect(hojaDelGuion("aviso", laMasAvanzada("aviso", elegirVariante(LANZAMIENTO)))).toContain(`.ph-insignia[data-ph-espera="${lugar}"]{display:block}`);
    }
  });
});

describe("dónde está montado", () => {
  const portada = leer("app/[locale]/page.tsx").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const pie = leer("app/components/Footer.tsx").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("héroe: bajo los botones principales, con la ventana de esta regeneración", () => {
    const botones = portada.indexOf('className="hero-cta"');
    const ins = portada.indexOf('<InsigniaProductHunt lugar="heroe" inicial={ventanaPh}');
    const figura = portada.indexOf('className="hpanel-shot"');
    expect(botones).toBeGreaterThan(-1);
    expect(ins).toBeGreaterThan(botones);
    expect(figura).toBeGreaterThan(ins);
    expect(portada).toContain("const ventanaPh = elegirVariante(Date.now());");
  });

  it("tarjeta: después del cierre, al final de main (antes de NVIDIA y del pie)", () => {
    const cierre = portada.indexOf('className="cierre-sec"');
    const tarjeta = portada.indexOf("<TarjetaProductHunt");
    const finMain = portada.indexOf("</main>");
    expect(tarjeta).toBeGreaterThan(cierre);
    expect(finMain).toBeGreaterThan(tarjeta);
    expect(portada.indexOf("<NvidiaEcosystemBand")).toBeGreaterThan(finMain);
    expect(portada).toContain('nuevaPestana: tn("newTab")');
  });

  it("pie: en todas las páginas, cerrando la columna de marca después de NVIDIA", () => {
    const nvidia = pie.indexOf("<NvidiaFooterCard");
    const ins = pie.indexOf('<InsigniaProductHunt lugar="pie" inicial={elegirVariante(Date.now())}');
    expect(nvidia).toBeGreaterThan(-1);
    expect(ins).toBeGreaterThan(nvidia);
  });
});

describe("los textos de la tarjeta, en los 12 idiomas", () => {
  const DIR = `${WEB}messages/`;
  const locales = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  it.each(locales)("%s: kicker, lema y los dos botones; «Product Hunt» sin traducir", (loc) => {
    const ph = JSON.parse(readFileSync(`${DIR}${loc}.json`, "utf8")).landing.productHunt as Record<string, string>;
    expect(Object.keys(ph).sort()).toEqual(["kicker", "live", "notify", "tagline"]);
    for (const k of ["kicker", "notify", "live"]) expect(ph[k], k).toContain("Product Hunt");
    expect(ph.tagline).toMatch(/LLM/);
    expect(ph.tagline).not.toContain("Product Hunt");
    // Cortos: caben en el botón sin que la tarjeta crezca.
    for (const k of ["notify", "live"]) expect(ph[k]!.length, `${loc}.${k}`).toBeLessThanOrEqual(40);
    if (loc === "en") {
      expect(ph.tagline).toBe("Cut LLM costs with an open-source savings layer");
      expect(ph.kicker).toBe("Find us on Product Hunt");
    }
  });
});
