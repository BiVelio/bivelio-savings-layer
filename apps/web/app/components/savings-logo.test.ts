/**
 * EL LOGO DE SAVINGS, AL TAMAÑO JUSTO (17-11-2026).
 *
 * Los PNG de origen (574×160, 61 KB; 256×256, 48 KB) se pintan a 22–52 px de
 * alto, y React 19 los anunciaba en el <head> (`<link rel="preload">` por cada
 * <img> sin `loading="lazy"`) delante de las hojas de estilo: 109 KB antes de
 * la primera pintura de cada página en el móvil, por un logo que no es el LCP.
 * Ahora van copias WebP casi sin pérdida a 1×, 2× y 3× del tamaño pintado, dentro
 * de <picture> (donde React no precarga), y la variante que el CSS oculta no
 * se descarga: su <picture> elige un píxel vacío en línea con la MISMA consulta
 * del CSS.
 *
 * El fallo sería silencioso: una consulta de `ocultoEn` que se desalinea del
 * CSS deja la cabecera SIN logo en una franja de anchos, una copia que falta
 * en public/brand sale como imagen rota, y un <img> suelto con el PNG vuelve a
 * colar los 109 KB en el <head>. Por eso se leen el componente, sus usos, la
 * hoja de estilos y los propios ficheros.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ANCHOS_WEBP, LOGO_PNG, SavingsLogo, rutaWebp, srcSetDelLogo } from "./SavingsLogo";

// Mismo apaño que nvidia-inception.test.ts: el .tsx puede bajar a
// `React.createElement`, que Next inyecta y aquí no hay.
(globalThis as { React?: typeof React }).React = React;

const AQUI = dirname(fileURLToPath(import.meta.url));
const WEB = join(AQUI, "..", "..");
const leer = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const CSS = leer("app", "globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** Ancho y alto de un WebP (VP8L sin pérdida, VP8X extendido o VP8 con pérdida). */
function medidasWebp(buf: Buffer): { w: number; h: number } {
  expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
  expect(buf.toString("ascii", 8, 12)).toBe("WEBP");
  const trozo = buf.toString("ascii", 12, 16);
  if (trozo === "VP8L") {
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  if (trozo === "VP8X") return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
  if (trozo === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  throw new Error(`WebP sin trozo conocido: ${trozo}`);
}

/** Los anchos de un srcset con descriptor de ancho, comprobando que cada
 *  candidata es la copia de ese ancho. */
const anchosDe = (variant: "full" | "mark", srcSet: string) =>
  srcSet.split(",").map((c) => {
    const [ruta, w] = c.trim().split(/\s+/);
    expect(w, c).toMatch(/^\d+w$/);
    const ancho = Number.parseInt(w!, 10);
    expect(ruta).toBe(rutaWebp(variant, ancho));
    return ancho;
  });

/** La consulta con la que el CSS oculta `selector` (`display: none`). */
function consultaQueOculta(selector: string): string {
  const re = new RegExp("@media \\(([^)]+)\\) \\{[^\\n]*" + selector.replace(/\./g, "\\.") + " \\{ display: none; \\}");
  const m = re.exec(CSS);
  expect(m, `@media que oculta ${selector}`).not.toBeNull();
  return `(${m![1]})`;
}

/** El complemento exacto de `(max-width: Npx)` en píxeles enteros. */
const desde = (q: string) => {
  const m = /^\(max-width: (\d+)px\)$/.exec(q);
  expect(m, q).not.toBeNull();
  return `(min-width: ${Number(m![1]) + 1}px)`;
};

describe("las copias al tamaño justo", () => {
  it("existen en public/brand y miden lo que dice su descriptor", () => {
    for (const [variante, alto] of [["full", 160 / 574], ["mark", 1]] as const) {
      for (const ancho of ANCHOS_WEBP[variante]) {
        const ruta = rutaWebp(variante, ancho);
        const fichero = join(WEB, "public", ruta);
        expect(existsSync(fichero), ruta).toBe(true);
        const { w, h } = medidasWebp(readFileSync(fichero));
        expect(w, ruta).toBe(ancho);
        expect(h, ruta).toBe(Math.round(ancho * alto));
      }
    }
  });

  it("cada uso recibe, para 1×, 2× y 3×, la copia más pequeña que llega", () => {
    // La cabecera pinta 108 px de logotipo: el iPhone (3×) recibe 324 exactos.
    expect(anchosDe("full", srcSetDelLogo("full", 108))).toEqual([108, 216, 324]);
    // El pie, 187 px: su 3× (561) lo cubre el original de 574.
    expect(anchosDe("full", srcSetDelLogo("full", 187))).toEqual([187, 374, 574]);
    // El isotipo: cabecera del móvil (28 px, 84 exactos en el iPhone), recibo
    // (22 px) y acceso o invitación (32 px).
    expect(anchosDe("mark", srcSetDelLogo("mark", 28))).toEqual([64, 84]);
    expect(anchosDe("mark", srcSetDelLogo("mark", 22))).toEqual([64, 84]);
    expect(anchosDe("mark", srcSetDelLogo("mark", 32))).toEqual([64, 96]);
    // Nada pasa del PNG de origen.
    expect(Math.max(...ANCHOS_WEBP.full)).toBeLessThanOrEqual(574);
    expect(Math.max(...ANCHOS_WEBP.mark)).toBeLessThanOrEqual(256);
  });

  it("los PNG de origen siguen publicados (enlaces externos, reserva sin WebP)", () => {
    for (const ruta of Object.values(LOGO_PNG)) expect(existsSync(join(WEB, "public", ruta)), ruta).toBe(true);
  });
});

describe("SavingsLogo", () => {
  it("no hace que React precargue el logo en el <head>", () => {
    // Un <img> suelto sí lo haría: así se ve la verja.
    expect(renderToStaticMarkup(React.createElement("img", { src: LOGO_PNG.full }))).toMatch(/rel="preload"/);
    const html = renderToStaticMarkup(
      React.createElement("div", null,
        React.createElement(SavingsLogo, { variant: "full", height: 30 }),
        React.createElement(SavingsLogo, { variant: "mark", height: 28, ocultoEn: "(min-width: 640px)" }),
      ),
    );
    expect(html).not.toMatch(/rel="preload"/);
    expect(html).toMatch(/<picture style="display:contents">/);
  });

  it("ofrece el WebP por densidad con el ancho pintado y deja el PNG de reserva", () => {
    const html = renderToStaticMarkup(React.createElement(SavingsLogo, { variant: "full", height: 30 }));
    expect(html).toContain(`<source type="image/webp" srcSet="${srcSetDelLogo("full", 108)}" sizes="108px"/>`);
    expect(html).toMatch(/<img class="savings-logo" src="\/brand\/savings-logo\.png" alt="Savings by BiVelio" width="108" height="30" style="width:108px;height:30px"/);
  });

  it("donde el CSS lo oculta, elige primero un píxel en línea (no se descarga)", () => {
    const html = renderToStaticMarkup(React.createElement(SavingsLogo, { variant: "mark", height: 28, ocultoEn: "(min-width: 640px)" }));
    expect(html).toMatch(/^<picture style="display:contents"><source media="\(min-width: 640px\)" srcSet="data:image\/gif;base64,[^"]+"\/><source type="image\/webp"/);
  });
});

describe("ocultoEn es la misma consulta con la que el CSS oculta cada variante", () => {
  it("cabecera pública: el logotipo bajo 640 px, el isotipo desde 640 px", () => {
    const nav = leer("app", "components", "NavBar.tsx");
    const q = consultaQueOculta(".nav-logo-full");
    expect(CSS).toMatch(/(?:^|\n)\.nav-logo-mark \{ display: none; \}/);
    expect(nav).toContain(`className="nav-logo-full" ocultoEn="${q}"`);
    expect(nav).toContain(`className="nav-logo-mark" ocultoEn="${desde(q)}"`);
  });

  it("barra del panel: el logotipo bajo 521 px, el isotipo desde 521 px", () => {
    const barra = leer("app", "components", "app", "AppTopbar.tsx");
    const q = consultaQueOculta(".app-logo-full");
    expect(CSS).toMatch(/(?:^|\n)\.app-logo-mark \{ display: none; \}/);
    expect(barra).toContain(`className="app-logo-full" ocultoEn="${q}"`);
    expect(barra).toContain(`className="app-logo-mark" ocultoEn="${desde(q)}"`);
  });

  it("acceso: el isotipo de la tarjeta, que el CSS quita en el móvil", () => {
    const acceso = leer("app", "components", "acceso", "AccesoShell.tsx");
    const q = consultaQueOculta(".acc-card .auth-brand");
    expect(acceso).toContain(`<SavingsLogo variant="mark" height={32} ocultoEn="${q}" />`);
  });
});

describe("ningún uso vuelve al PNG suelto", () => {
  it("el pie lo carga en diferido y el recibo y la invitación usan las copias", () => {
    expect(leer("app", "components", "Footer.tsx")).toContain('<SavingsLogo variant="full" height={52} loading="lazy" />');
    const recibo = leer("app", "components", "ui", "Recibo.tsx");
    expect(recibo).toContain('<source type="image/webp" srcSet={srcSetDelLogo("mark", 22)} sizes="22px" />');
    const invitacion = leer("app", "[locale]", "invitacion", "[token]", "AceptarInvitacion.tsx");
    expect(invitacion).toContain('src="/brand/savings-mark-96.webp" srcSet={srcSetDelLogo("mark", 32)} sizes="32px"');
  });

  it("solo SavingsLogo.tsx nombra los PNG del logo", () => {
    for (const f of ["components/NavBar.tsx", "components/Footer.tsx", "components/app/AppTopbar.tsx", "components/acceso/AccesoShell.tsx", "components/ui/Recibo.tsx", "[locale]/invitacion/[token]/AceptarInvitacion.tsx"]) {
      expect(leer("app", ...f.split("/")), f).not.toMatch(/savings-(?:logo|mark)\.png/);
    }
  });
});
