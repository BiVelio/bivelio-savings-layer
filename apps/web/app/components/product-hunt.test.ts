import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsigniaProductHunt } from "./ProductHunt";
import {
  FIN_CAMPANA,
  INSIGNIA_PH,
  LANZAMIENTO,
  URL_TARJETA_PH,
  VARIANTES,
  elegirVariante,
  guionPrevio,
  hojaDelGuion,
  hojaProductHunt,
  insigniaAlcanzable,
  laMasAvanzada,
  tocaInsignia,
  varianteAlMontar,
  type LugarInsignia,
  type Variante,
} from "./franja-lanzamiento";

/**
 * LA INSIGNIA OFICIAL DE PRODUCT HUNT (lanzamiento del 22-11-2026).
 *
 * Va en el pie desde el lanzamiento y para siempre, y en el héroe solo mientras
 * dura la campaña (dos semanas); antes no aparece y su imagen no se pide.
 * Mismas fronteras que la campaña. La tarjeta del final de la portada, que
 * ahora es el carrusel de plataformas, se prueba en
 * landing/tarjeta-lanzamiento.test.ts y en lib/plataformas-de-lanzamiento.test.ts.
 */

const DIA = 24 * 60 * 60 * 1000;
const WEB = fileURLToPath(new URL("../../", import.meta.url));
const leer = (ruta: string) => readFileSync(`${WEB}${ruta}`, "utf8");
const amp = (s: string) => s.replace(/&/g, "&amp;");

describe("cuándo va la insignia", () => {
  it("héroe: solo durante la campaña; pie: desde el lanzamiento, para siempre", () => {
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

describe("con qué variante arranca un componente cliente", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("al hidratar (y en el servidor): la del servidor, para que el marcado coincida", () => {
    for (const inicial of VARIANTES) {
      for (const t of [LANZAMIENTO - 1, LANZAMIENTO, FIN_CAMPANA, FIN_CAMPANA + 365 * DIA]) {
        expect(varianteAlMontar(inicial, true, t)).toBe(inicial);
      }
    }
  });

  it("montado por una navegación dentro de la web: ya la del reloj, desde el primer render", () => {
    // Un payload RSC de antes del lanzamiento, montado el 23-11: «en vivo» de entrada,
    // sin pintar primero el hueco escondido ni el botón «avísame».
    expect(varianteAlMontar("aviso", false, Date.UTC(2026, 10, 23, 12))).toBe("en-vivo");
    // La campaña dura dos semanas: el 1-12 sigue en vivo; el 7-12 ya no.
    expect(varianteAlMontar("aviso", false, Date.UTC(2026, 11, 1, 12))).toBe("en-vivo");
    expect(varianteAlMontar("aviso", false, Date.UTC(2026, 11, 7, 12))).toBe("bivelio");
    expect(varianteAlMontar("en-vivo", false, Date.UTC(2026, 11, 7, 12))).toBe("bivelio");
    expect(varianteAlMontar("aviso", false, LANZAMIENTO)).toBe("en-vivo");
    expect(varianteAlMontar("aviso", false, LANZAMIENTO - 1)).toBe("aviso");
    // Un reloj atrasado no devuelve una ventana que ya pasó.
    expect(varianteAlMontar("bivelio", false, Date.UTC(2026, 10, 18))).toBe("bivelio");
    expect(varianteAlMontar("en-vivo", false, Number.NaN)).toBe("bivelio");
  });

  it("el servidor pinta siempre la de su `inicial`, aunque el reloj ya haya cruzado (getServerSnapshot)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 23, 12));
    expect(insignia("heroe", "aviso")).toBe('<span class="ph-insignia" data-ph-espera="heroe" aria-hidden="true"></span>');
    expect(insignia("pie", "aviso")).not.toContain("<img");
  });

  it("useVariante arranca con varianteAlMontar y detecta la hidratación con useSyncExternalStore", () => {
    const fuente = leer("app/components/ProductHunt.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(fuente).toMatch(/useSyncExternalStore\(sinSuscripcion, \(\) => false, \(\) => true\)/);
    expect(fuente).toContain("useState<Variante>(() => varianteAlMontar(inicial, hidratando, Date.now()))");
    expect(fuente).toContain("useState<Variante>(base)");
  });
});

describe("el guion previo corrige la insignia", () => {
  it("cada regla apunta a lo que pintan los componentes", () => {
    expect(hojaProductHunt("aviso", "en-vivo")).toBe('.ph-insignia[data-ph-espera="heroe"]{display:block}.ph-insignia[data-ph-espera="pie"]{display:block}');
    // Del aviso a después de la campaña: el héroe sigue sin insignia; el pie la enseña.
    expect(hojaProductHunt("aviso", "bivelio")).toBe('.ph-insignia[data-ph-espera="pie"]{display:block}');
    // De en vivo a después: fuera la del héroe.
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

  it("el guion de un build en aviso lleva la insignia en cada ventana", () => {
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

  it("la tarjeta de plataformas: después del cierre, al final de main (antes de NVIDIA y del pie)", () => {
    const cierre = portada.indexOf('className="cierre-sec"');
    const tarjeta = portada.indexOf("<TarjetaLanzamiento construido={Date.now()}");
    const finMain = portada.indexOf("</main>");
    expect(tarjeta).toBeGreaterThan(cierre);
    expect(finMain).toBeGreaterThan(tarjeta);
    expect(portada.indexOf("<NvidiaEcosystemBand")).toBeGreaterThan(finMain);
    expect(portada).toContain('textosDeTarjeta(tl as unknown as Traductor, tn("newTab"))');
  });

  it("el héroe y el pie no llevan más insignia que la de Product Hunt (ni DevHunt ni fila de insignias)", () => {
    expect(portada).not.toMatch(/DevHunt|hero-insignias/);
    expect(pie).not.toMatch(/DevHunt|ftr-insignias/);
    expect(portada.match(/<Insignia/g)).toHaveLength(1);
    expect(pie.match(/<Insignia/g)).toHaveLength(1);
    const css = leer("app/globals.css");
    expect(css).not.toMatch(/dh-insignia|hero-insignias|ftr-insignias/);
  });

  it("pie: en todas las páginas, cerrando la columna de marca después de NVIDIA", () => {
    const nvidia = pie.indexOf("<NvidiaFooterCard");
    const ins = pie.indexOf('<InsigniaProductHunt lugar="pie" inicial={elegirVariante(Date.now())}');
    expect(nvidia).toBeGreaterThan(-1);
    expect(ins).toBeGreaterThan(nvidia);
  });
});
