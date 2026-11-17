import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HOJA_ACCESO, HOJA_PANEL, HOJA_PUBLICA, juntar, piezas, reparto, rutas } from "../../scripts/juntar-affectui.mjs";

/**
 * EL CSS DE affectUI VIAJA EN LAS HOJAS DE LOS LAYOUTS, NO EN CADA COMPONENTE.
 *
 * POR QUÉ EXISTE. Cada pieza importaba su `.css` desde su `.tsx`. Next partía
 * eso en 43 ficheros: una página esperaba hasta 15 hojas antes de pintar y la
 * 404 —que se pinta en el cliente sobre `<html id="__next_error__">`— se
 * quedaba en blanco en 22 de 64 cargas directas (prelanzamiento, 2026-11-16).
 * React precargaba las hojas que solo conocía el árbol de «no encontrado», su
 * primer commit quitaba esos `<link rel="preload">` del <head>, el navegador
 * cancelaba las descargas y el commit siguiente esperaba 60 s un `load` que no
 * iba a llegar.
 *
 * El arreglo es de estructura —nada de CSS importado por debajo de un layout
 * (salvo las cinco páginas de acceso, que piden sus dos hojas), y tres
 * ficheros generados: el del sitio público, el de acceso y el del panel—, y
 * la estructura se rompe sola en cuanto alguien vendoriza una pieza «como
 * antes» o usa en la portada una pieza del panel sin regenerar. Estos tests
 * son la valla.
 */
const WEB = fileURLToPath(new URL("../../", import.meta.url));
const lee = (ruta: string) => readFileSync(WEB + ruta, "utf8");
const sinComentarios = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(WEB + dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const ruta = `${dir}/${e.name}`;
    if (e.isDirectory()) fuentes(ruta, acc);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) acc.push(ruta);
  }
  return acc;
}

/** `import "x.css"` e `import y from "x.css"`, en una línea de código (no en un comentario). */
const importaCss = /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+\.css)["']/gm;

describe("hojas de affectUI", () => {
  const hojas = piezas();
  const { publicas, acceso, panel } = reparto();

  it("hay piezas, y cada .tsx tiene su hoja", () => {
    expect(hojas.length).toBeGreaterThanOrEqual(48);
    for (const f of readdirSync(WEB + "vendor/affectui")) {
      if (f.endsWith(".tsx")) expect(hojas, `${f} sin hoja`).toContain(f.replace(/\.tsx$/, ".css"));
    }
  });

  it("los tres ficheros generados están al día", () => {
    // Si falla: `node scripts/juntar-affectui.mjs` desde apps/web.
    const esperado = juntar();
    expect(Object.keys(esperado).sort()).toEqual([HOJA_ACCESO, HOJA_PANEL, HOJA_PUBLICA].sort());
    for (const [f, css] of Object.entries(esperado)) expect(lee(`vendor/affectui/${f}`), f).toBe(css);
  });

  it("cada pieza está en un fichero y solo en uno, entera y con su aviso de licencia", () => {
    expect([...publicas, ...acceso, ...panel].sort()).toEqual(hojas);
    expect(publicas.filter((p) => panel.includes(p) || acceso.includes(p))).toEqual([]);
    expect(acceso.filter((p) => panel.includes(p))).toEqual([]);
    const publica = lee(`vendor/affectui/${HOJA_PUBLICA}`);
    const deAcceso = lee(`vendor/affectui/${HOJA_ACCESO}`);
    const delPanel = lee(`vendor/affectui/${HOJA_PANEL}`);
    for (const f of hojas) {
      const hoja = lee(`vendor/affectui/${f}`);
      const trozo = `/* ===== ${f} ===== */\n${hoja}`;
      expect(publica.includes(trozo), `${f} en la hoja pública`).toBe(publicas.includes(f));
      expect(deAcceso.includes(trozo), `${f} en la hoja de acceso`).toBe(acceso.includes(f));
      expect(delPanel.includes(trozo), `${f} en la hoja del panel`).toBe(panel.includes(f));
      expect(hoja.trimStart().startsWith("/*"), `${f} no empieza por su cabecera de licencia`).toBe(true);
    }
  });

  it("el reparto tiene sentido: la 404 y la portada van en la pública; el acceso y el panel, no", () => {
    for (const p of ["empty-state-clean.css", "grid-background.css", "separator-clean.css", "tab-overload.css", "gradient-text.css", "pricing-plans.css"]) {
      expect(publicas, p).toContain(p);
    }
    // Los campos, el botón y la tarjeta inclinada del acceso: la portada no los pinta.
    for (const p of ["text-field-clean.css", "button-clean.css", "tilt-card.css"]) expect(acceso, p).toContain(p);
    for (const p of ["kpi-chart.css", "dialog.css", "profile-menu.css"]) expect(panel, p).toContain(p);
  });

  it("a toda ruta le llegan las hojas de las piezas que pinta", () => {
    // Una página pública que alcanzara una pieza del panel —o del acceso— la pintaría sin CSS.
    const todas = rutas();
    expect(todas.length).toBeGreaterThan(20);
    expect(todas.some((r) => r.piezas.length > 0 && !r.conHojaDelPanel && !r.conHojaDeAcceso)).toBe(true);
    const llega = (r: { conHojaDelPanel: boolean; conHojaDeAcceso: boolean }, p: string) =>
      publicas.includes(p) || (r.conHojaDeAcceso && acceso.includes(p)) || (r.conHojaDelPanel && panel.includes(p));
    const sinHoja = todas.flatMap((r) => r.piezas.filter((p) => !llega(r, p)).map((p) => `${r.ruta} → ${p}`));
    expect(sinHoja).toEqual([]);
  });

  it("el panel recibe también la hoja de acceso: comparte piezas con el login", () => {
    for (const r of rutas().filter((x) => x.ruta.startsWith("app/[locale]/dashboard/"))) {
      expect(r.conHojaDeAcceso, r.ruta).toBe(true);
      expect(r.conHojaDelPanel, r.ruta).toBe(true);
    }
  });

  it("la 404 no necesita ninguna hoja fuera de las del layout del idioma", () => {
    const nf = rutas().find((r) => r.ruta === "app/[locale]/not-found.tsx");
    expect(nf?.piezas.length).toBeGreaterThan(0);
    expect(nf?.conHojaDelPanel).toBe(false);
    expect(nf?.conHojaDeAcceso).toBe(false);
    expect([...lee("app/[locale]/not-found.tsx").matchAll(importaCss)]).toEqual([]);
    expect(rutas().find((r) => r.ruta === "app/not-found.tsx")?.piezas).toEqual([]);
  });

  it("cada pieza cierra lo que abre: pegadas una tras otra, ninguna se come a la siguiente", () => {
    for (const f of hojas) {
      const crudo = lee(`vendor/affectui/${f}`);
      expect((crudo.match(/\/\*/g) ?? []).length, `${f}: comentario sin cerrar`).toBe((crudo.match(/\*\//g) ?? []).length);
      const css = sinComentarios(crudo).replace(/"[^"\n]*"|'[^'\n]*'/g, "");
      expect((css.match(/\{/g) ?? []).length, `${f}: llaves descuadradas`).toBe((css.match(/\}/g) ?? []).length);
      expect(css, `${f}: @import/@charset/@namespace quedarían en medio de la hoja`).not.toMatch(/@(import|charset|namespace)\b/);
    }
  });

  it("los @keyframes y @property no se repiten entre piezas ni con globals.css", () => {
    const visto = new Map<string, string>();
    const repetidos: string[] = [];
    for (const [f, css] of [["globals.css", lee("app/globals.css")] as const, ...hojas.map((f) => [f, lee(`vendor/affectui/${f}`)] as const)]) {
      for (const n of new Set([...sinComentarios(css).matchAll(/@(?:keyframes|property)\s+([\w-]+)/g)].map((m) => m[1]!))) {
        const antes = visto.get(n);
        if (antes) repetidos.push(`${n}: ${antes} y ${f}`);
        visto.set(n, f);
      }
    }
    expect(repetidos).toEqual([]);
  });
});

describe("quién importa CSS", () => {
  it("ningún .tsx de affectUI importa una hoja", () => {
    const culpables = fuentes("vendor/affectui").filter((f) => [...lee(f).matchAll(importaCss)].length > 0);
    expect(culpables).toEqual([]);
  });

  it("en la aplicación solo importan CSS los dos layouts, la 404 raíz, las páginas de acceso y las galerías de desarrollo", () => {
    const quien: Record<string, string[]> = {};
    for (const f of [...fuentes("app"), ...fuentes("lib"), ...fuentes("i18n")]) {
      const importadas = [...lee(f).matchAll(importaCss)].map((m) => m[1]!);
      if (importadas.length) quien[f] = importadas;
    }
    // Las piezas de affectUI que el panel comparte con el acceso, las reglas
    // propias del panel (`dashboard/panel.css`, ver
    // `dashboard/panel-css.test.ts`) y, detrás, la de affectUI del panel.
    const panel = ["@/vendor/affectui/affectui-acceso.css", "@/app/[locale]/dashboard/panel.css", "@/vendor/affectui/affectui-panel.css"];
    // Las reglas propias del acceso (`components/acceso/acceso.css`, ver
    // `components/acceso/acceso-css.test.ts`) y, detrás, sus piezas de affectUI.
    const acceso = ["@/app/components/acceso/acceso.css", "@/vendor/affectui/affectui-acceso.css"];
    expect(quien).toEqual({
      // globals ANTES que affectUI: es el orden de cascada con el que se diseñó.
      "app/[locale]/layout.tsx": ["../globals.css", "@/vendor/affectui/affectui.css"],
      "app/[locale]/dashboard/layout.tsx": ["@/vendor/affectui/affectui-acceso.css", "./panel.css", "@/vendor/affectui/affectui-panel.css"],
      "app/not-found.tsx": ["./globals.css"],
      // La portada no carga nada de esto: lo piden las cinco páginas de acceso.
      "app/[locale]/login/page.tsx": acceso,
      "app/[locale]/signup/page.tsx": acceso,
      "app/[locale]/signup/success/page.tsx": acceso,
      "app/[locale]/reset-password/page.tsx": acceso,
      "app/[locale]/invitacion/[token]/page.tsx": acceso,
      // Solo existen con `next dev` (en producción dan 404 antes de pintar).
      "app/[locale]/captura-cuenta/page.tsx": panel,
      "app/[locale]/captura-estados/page.tsx": panel,
      "app/[locale]/captura-panel/page.tsx": panel,
      "app/[locale]/kit/page.tsx": panel,
    });
  });

  it("las galerías que piden la hoja del panel no existen en producción", () => {
    for (const f of ["captura-cuenta", "captura-estados", "captura-panel", "kit"]) {
      expect(lee(`app/[locale]/${f}/page.tsx`), f).toMatch(/if \(!capturaDisponible\(\)\) notFound\(\);/);
    }
  });
});
