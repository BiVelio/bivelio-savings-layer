import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MINIATURA_PH } from "../franja-lanzamiento";
import { PLATAFORMAS, finDeTodas, textosDeTarjeta, type Traductor } from "../../../lib/plataformas-de-lanzamiento";
import { INTERVALO_MS, TarjetaLanzamiento } from "./TarjetaLanzamiento";

/**
 * EL CARRUSEL DE PLATAFORMAS («Find us on …»), al final de la portada.
 *
 * La tarjeta que ya había, ahora con una diapositiva por plataforma del
 * registro. Aquí se prueba lo que no puede romperse en silencio: que todas las
 * diapositivas vayan en el HTML y solo una se vea (sin saltos de altura ni de
 * hidratación), que sea un carrusel ACCESIBLE (nombre, diapositivas con nombre,
 * pausa —WCAG 2.2.2—, puntos con nombre y zona de 24 px, foco visible, nada en
 * movimiento con `prefers-reduced-motion`) y que no conecte con ninguna
 * plataforma hasta que alguien pulse.
 */

// vitest compila el .tsx con el runtime clásico de JSX (como nvidia-inception.test.ts).
(globalThis as { React?: typeof React }).React = React;

const WEB = fileURLToPath(new URL("../../../", import.meta.url));
const leer = (ruta: string) => readFileSync(`${WEB}${ruta}`, "utf8");
const HOY = Date.UTC(2026, 10, 20, 12);
const DOMINGO = Date.UTC(2026, 10, 22, 8);

const en = JSON.parse(leer("messages/en.json")).landing.launch as Record<string, string>;
const t = Object.assign((clave: string, v: Record<string, string> = {}) => en[clave]!.replace("{platform}", v.platform ?? ""), { has: (clave: string) => clave in en }) as Traductor;
const textos = textosDeTarjeta(t, "(opens in a new tab)");
const pinta = (construido: number) => renderToString(React.createElement(TarjetaLanzamiento, { construido, t: textos }));
const diapos = (html: string) => [...html.matchAll(/<div class="lz-diapo"([^>]*)>([\s\S]*?)<\/a><\/div>/g)].map((m) => ({ atributos: m[1]!, dentro: m[2]! }));

describe("el HTML del servidor", () => {
  const html = pinta(HOY);

  it("es un carrusel con nombre, y cada diapositiva un grupo con el nombre de su plataforma", () => {
    expect(html).toMatch(/^<section class="ph-sec lz-sec" aria-roledescription="carousel" aria-label="Launch platforms">/);
    const ds = diapos(html);
    expect(ds).toHaveLength(PLATAFORMAS.length);
    ds.forEach((d, i) => {
      expect(d.atributos).toContain('role="group" aria-roledescription="slide"');
      expect(d.atributos).toContain(`aria-label="${PLATAFORMAS[i]!.nombre}"`);
      expect(d.atributos).toContain(`data-lz-d="${PLATAFORMAS[i]!.id}"`);
    });
  });

  it("todas las diapositivas van en el HTML y solo UNA se ve: las demás, fuera del árbol accesible", () => {
    const ds = diapos(html);
    const ocultas = ds.filter((d) => d.atributos.includes('data-oculta="true"') && d.atributos.includes('aria-hidden="true"'));
    expect(ocultas).toHaveLength(ds.length - 1);
    // Sin azar (servidor): la franja lleva la primera del registro y la tarjeta, la segunda.
    expect(ds.find((d) => !d.atributos.includes("data-oculta"))!.atributos).toContain('data-lz-d="devhunt"');
  });

  it("cada diapositiva: el kicker con el marcador en el nombre, el producto, el lema y el botón en el color de la plataforma", () => {
    diapos(html).forEach((d, i) => {
      const p = PLATAFORMAS[i]!;
      expect(d.dentro).toContain(`<h2 class="ph-k">Find us on <span class="mk">${p.nombre}</span></h2>`);
      expect(d.dentro).toContain('<p class="ph-nombre">BiVelio Savings Layer</p>');
      expect(d.dentro).toContain('<p class="ph-lema">Cut LLM costs with an open-source savings layer</p>');
      expect(d.atributos).toContain(`style="--lz-fondo:${p.color.fondo};--lz-texto:${p.color.texto};--lz-realce:${p.color.realce}"`);
      expect(d.dentro).toContain(`<a class="ph-boton" href="${p.ficha.tarjeta.replace(/&/g, "&amp;")}" target="_blank" rel="noopener">`);
      expect(d.dentro).toContain("(opens in a new tab)");
      // La flecha va con la última palabra, sin poder partir.
      expect(d.dentro).toMatch(/<span class="ph-cola">[^<]*Hunt(<!-- -->)? <svg/);
    });
  });

  it("antes del lanzamiento, el botón de Product Hunt lleva sus dos textos apilados y se ve «avísame»; el de DevHunt, solo «échale un vistazo»", () => {
    const [ph, dh] = diapos(html);
    expect(ph!.dentro.match(/data-lz-b="(antes|vivo)"/g)).toEqual(['data-lz-b="antes"', 'data-lz-b="vivo"']);
    expect(ph!.dentro).toMatch(/<span data-lz-b="antes">Get notified on Product Hunt<\/span>/);
    expect(ph!.dentro).toMatch(/<span data-lz-b="vivo" data-oculta="true" aria-hidden="true">/);
    expect(dh!.dentro.match(/data-lz-b="(antes|vivo)"/g)).toEqual(['data-lz-b="vivo"']);
    expect(dh!.dentro).not.toContain("Get notified");
  });

  it("desde el lanzamiento (y después de la campaña) nadie dice «avísame»; la tarjeta sigue con todas", () => {
    for (const cuando of [DOMINGO, finDeTodas() + 30 * 24 * 60 * 60 * 1000]) {
      const h = pinta(cuando);
      expect(h).not.toContain("Get notified");
      expect(h).not.toContain('data-lz-b="antes"');
      expect(diapos(h)).toHaveLength(PLATAFORMAS.length);
      expect(h).toContain('Check it out on <span class="ph-cola">Product\u00A0Hunt');
    }
  });

  it("los mandos: pausa y un punto por plataforma, con nombre; reservados en el HTML y escondidos hasta hidratar", () => {
    const mandos = html.match(/<div class="lz-mandos"([^>]*)>([\s\S]*?)<\/div><\/section>$/)!;
    expect(mandos[1]).not.toContain("data-listos");
    const botones = [...mandos[2]!.matchAll(/<button ([^>]*)>/g)].map((m) => m[1]!);
    expect(botones).toHaveLength(1 + PLATAFORMAS.length);
    for (const b of botones) expect(b).toContain('type="button"');
    expect(botones[0]).toContain('class="lz-pausa" aria-label="Pause rotation"');
    expect(botones.slice(1).map((b) => b.match(/aria-label="([^"]+)"/)![1])).toEqual(PLATAFORMAS.map((p) => `Show ${p.nombre}`));
    // El punto de la que se ve, marcado.
    expect(botones.filter((b) => b.includes('aria-current="true"'))).toHaveLength(1);
    expect(botones.find((b) => b.includes('aria-current="true"'))).toContain('aria-label="Show DevHunt"');
  });

  it("girando sola no interrumpe al lector de pantalla (aria-live off hasta que se pausa)", () => {
    expect(html).toContain('<div class="lz-pista" aria-live="off">');
    expect(leer("app/components/landing/TarjetaLanzamiento.tsx")).toContain('aria-live={pausado ? "polite" : "off"}');
  });

  it("la miniatura es la nuestra, a 64×64 con su 2×, decorativa; ninguna imagen de terceros", () => {
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain('width="64" height="64"');
    expect(html).toContain('alt=""');
    expect(html).toContain(encodeURIComponent(MINIATURA_PH));
    expect(html).toMatch(/w=64&amp;q=\d+ 1x, [^"]*w=128&amp;q=\d+ 2x/);
    expect(html).not.toMatch(/imgix|ph-files|src="https?:/);
    expect(MINIATURA_PH).toMatch(/^\/brand\/product-hunt-thumb-\d{4}-\d{2}\.png$/);
    const png = readFileSync(`${WEB}public${MINIATURA_PH}`);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([240, 240]);
    expect(statSync(`${WEB}public${MINIATURA_PH}`).size).toBeLessThan(100_000);
  });
});

describe("cómo gira", () => {
  const fuente = leer("app/components/landing/TarjetaLanzamiento.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\s*\}/g, "{}");

  it("despacio (≥ 5 s) y solo cuando toca: a la vista, sin pausa, sin movimiento reducido y con más de una", () => {
    expect(INTERVALO_MS).toBeGreaterThanOrEqual(5000);
    expect(fuente).toContain("const gira = montada && varias && !pausado && aLaVista && !sinMovimiento;");
    expect(fuente).toContain("new IntersectionObserver(");
    expect(fuente).toContain('window.matchMedia("(prefers-reduced-motion: reduce)")');
    expect(fuente).toContain("window.setInterval(");
    expect(fuente).toContain("window.clearInterval(id)");
  });

  it("no avanza con el ratón o el foco encima (tampoco sobre la franja) ni con la pestaña oculta", () => {
    expect(fuente).toContain('if (viva && !viva.retenida() && document.visibilityState === "visible") viva.avanzar(1);');
    for (const evento of ["onMouseEnter={retener(true)}", "onMouseLeave={retener(false)}", "onFocus={retener(true)}", "onBlur={retener(false)}"]) expect(fuente).toContain(evento);
  });

  it("se puede pausar (WCAG 2.2.2), y elegir una plataforma la deja quieta", () => {
    expect(fuente).toContain("aria-label={pausado ? t.reanudar : t.pausar}");
    expect(fuente).toContain("onClick={() => setPausado((p) => !p)}");
    expect(fuente).toMatch(/setPausado\(true\);\s*rotacion\(\)\?\.irA\(id\);/);
    // Con movimiento reducido no gira sola: el botón de pausa sobra y no se pinta.
    expect(fuente).toContain("{!sinMovimiento && (");
  });

  it("el primer render es el del servidor (sin error de hidratación) y la hoja del guion se retira al montar", () => {
    expect(fuente).toContain("useSyncExternalStore(suscribirRotacion, leerRotacion, leerRotacionEnServidor)");
    expect(fuente).toContain("r ? repartir(FILAS, construido, r.t, r.orden, r.k) : repartoDelServidor(construido)");
    expect(fuente).toContain('if (montada) retirarHojaDeLanzamiento("t");');
    expect(fuente).not.toMatch(/Math\.random|Date\.now/);
  });
});

describe("la hoja de estilos del carrusel", () => {
  const css = leer("app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

  it("sin saltos de altura: todas las diapositivas ocupan las MISMAS celdas de la tarjeta", () => {
    expect(css).toMatch(/\.lz-pista, \.lz-diapo\s*\{\s*display:\s*contents;\s*\}/);
    expect(css).toMatch(/\.lz-diapo > \.ph-texto\s*\{\s*grid-area:\s*1 \/ 2;\s*\}/);
    expect(css).toMatch(/\.lz-diapo > \.ph-boton\s*\{\s*grid-area:\s*1 \/ 3;\s*\}/);
    // En móvil el botón baja, también en una celda fija.
    expect(css).toMatch(/\.lz-diapo > \.ph-boton\s*\{\s*grid-area:\s*2 \/ 2;/);
    expect(css).toMatch(/\.lz-diapo > \.ph-boton\s*\{\s*grid-area:\s*2 \/ 1 \/ 3 \/ -1;/);
    expect(css).toMatch(/\.ph-pila > \*\s*\{\s*grid-area:\s*1 \/ 1;/);
  });

  it("la que no toca no se ve, no se enfoca y no recibe clics", () => {
    expect(css).toMatch(/\.lz-diapo\[data-oculta\] > \*\s*\{\s*visibility:\s*hidden;\s*opacity:\s*0;[^}]*pointer-events:\s*none;/);
    expect(css).toMatch(/\.ph-pila > \[data-oculta\]\s*\{\s*visibility:\s*hidden;\s*\}/);
  });

  it("con movimiento reducido no hay transición ni desplazamiento", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.lz-diapo > \*, \.lz-diapo\[data-oculta\] > \*\s*\{\s*transition:\s*none;\s*transform:\s*none;\s*\}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.lz-mandos, \.lz-punto::before\s*\{\s*transition:\s*none;\s*\}/);
  });

  it("los mandos: 24 px de zona de pulsación como mínimo (WCAG 2.5.8), foco visible y su fila reservada", () => {
    expect(css).toMatch(/\.lz-pausa, \.lz-punto\s*\{[^}]*width:\s*24px;\s*height:\s*24px;/);
    expect(css).toMatch(/\.lz-pausa:focus-visible, \.lz-punto:focus-visible\s*\{\s*outline:\s*2px solid var\(--ink\);/);
    expect(css).toMatch(/\.lz-mandos\s*\{[^}]*height:\s*28px;[^}]*visibility:\s*hidden;/);
    expect(css).toMatch(/\.lz-mandos\[data-listos\]\s*\{\s*visibility:\s*visible;/);
    expect(css).toMatch(/\.lz-punto\[aria-current\]::before\s*\{[^}]*background:\s*var\(--ink\);/);
  });

  it("el botón toma el color de la plataforma; sin él, el coral de siempre", () => {
    expect(css).toMatch(/\.ph-boton\s*\{[^}]*background:\s*var\(--lz-fondo, #FF6154\);\s*color:\s*var\(--lz-texto, #0F1218\);/);
    expect(css).toMatch(/\.ph-boton:hover\s*\{\s*background:\s*var\(--lz-realce, #FF7366\);/);
    expect(css).toMatch(/\.ph-boton:focus-visible\s*\{\s*outline:\s*2px solid #0F1218;/);
  });
});
