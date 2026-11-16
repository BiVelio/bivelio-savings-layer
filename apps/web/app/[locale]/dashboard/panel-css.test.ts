import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  HOJA_GLOBAL,
  HOJA_PANEL,
  ajenasEnLaHojaDelPanel,
  clasesQueExige,
  esSoloDelPanel,
  ficherosPublicos,
  laProduce,
  publicasEnLaHojaDelPanel,
  reglas,
  rutas,
  selectores,
  trocea,
  vocabulario,
  vocabularioPublico,
} from "../../../scripts/hoja-del-panel.mjs";

/**
 * LA HOJA DEL PANEL SOLO LLEVA REGLAS QUE UNA PÁGINA PÚBLICA NO PUEDE PINTAR.
 *
 * POR QUÉ EXISTE. `globals.css` bloqueaba el primer pintado de la portada con
 * 61 kB (gzip) de los que una buena parte eran tablas, extracto y gráficas del
 * panel. Esas reglas viven ahora en `dashboard/panel.css`, que solo cargan el
 * layout del panel y las galerías de desarrollo. El reparto tiene dos maneras
 * de romperse, y las dos son MUDAS —no falla el build ni ningún otro test, la
 * página simplemente sale sin estilo—:
 *
 *   1. una página pública empieza a usar una clase cuya regla está en
 *      `panel.css` (o alguien escribe ahí una regla de la portada);
 *   2. una ruta pública importa `panel.css` «para arreglarlo», y la portada
 *      vuelve a pagar el CSS entero.
 *
 * Qué cuenta como «público» y por qué es tan generoso está en la cabecera de
 * `scripts/hoja-del-panel.mjs`. Si falla el primer test: la regla vuelve a
 * `globals.css` (y hay que comprobar que la cascada no cambia: la hoja del
 * panel carga DESPUÉS de `affectui.css` y la global, antes).
 */
const WEB = fileURLToPath(new URL("../../../", import.meta.url));
const lee = (ruta: string) => readFileSync(WEB + ruta, "utf8");

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(WEB + dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const ruta = `${dir}/${e.name}`;
    if (e.isDirectory()) fuentes(ruta, acc);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) acc.push(ruta);
  }
  return acc;
}

const GALERIAS = ["captura-cuenta", "captura-estados", "captura-panel", "kit"].map((g) => `app/[locale]/${g}/page.tsx`);

describe("la hoja del panel", () => {
  const panel = lee(HOJA_PANEL);

  it("existe, tiene reglas y la global sigue teniendo las suyas", () => {
    expect(reglas(panel).length).toBeGreaterThan(300);
    expect(reglas(lee(HOJA_GLOBAL)).length).toBeGreaterThan(1500);
  });

  it("no tiene ninguna regla que una página pública pueda pintar", () => {
    // Si falla: esa regla (entera, con todos sus selectores) vuelve a app/globals.css.
    expect(publicasEnLaHojaDelPanel()).toEqual([]);
  });

  it("solo lleva reglas: los @keyframes, @font-face y demás se quedan en la global", () => {
    expect(ajenasEnLaHojaDelPanel()).toEqual([]);
    expect(panel.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/:root\b/);
  });

  it("ninguna regla está en las dos hojas", () => {
    const firma = (css: string) => reglas(css).map((r: { grupos: string[]; ini: number; fin: number }) => `${r.grupos.join(" ")} ¶ ${css.slice(r.ini, r.fin)}`);
    const enLaGlobal = new Set(firma(lee(HOJA_GLOBAL)));
    expect(firma(panel).filter((f: string) => enLaGlobal.has(f))).toEqual([]);
  });

  it("cierra lo que abre", () => {
    for (const css of [panel, lee(HOJA_GLOBAL)]) {
      const { nodos, cola } = trocea(css);
      // Trocear y volver a pegar devuelve el fichero byte a byte: el troceador no se ha perdido.
      const pega = (ns: Array<Record<string, any>>): string =>
        ns.map((n) => n.antes + (n.tipo === "grupo" ? css.slice(n.ini, n.abre + 1) + pega(n.hijos) + n.cola + "}" : css.slice(n.ini, n.fin))).join("");
      expect(pega(nodos) + cola).toBe(css);
    }
  });
});

describe("quién recibe la hoja del panel", () => {
  it("solo el layout del panel y las galerías de desarrollo la importan", () => {
    // `…/panel.css` con su barra: `affectui-panel.css` es otra hoja.
    const importaLaDelPanel = /^\s*import\s+["'][^"']*\/panel\.css["']/m;
    const quien = [...fuentes("app"), ...fuentes("lib"), ...fuentes("i18n"), ...fuentes("vendor")].filter((f) => importaLaDelPanel.test(lee(f)));
    expect(quien.sort()).toEqual(["app/[locale]/dashboard/layout.tsx", ...GALERIAS].sort());
  });

  it("ninguna ruta pública la recibe: solo /dashboard y las galerías, que en producción dan 404", () => {
    const con = rutas().filter((r: { conHojaDelPanel: boolean }) => r.conHojaDelPanel).map((r: { ruta: string }) => r.ruta);
    expect(con.filter((r: string) => !r.startsWith("app/[locale]/dashboard/")).sort()).toEqual([...GALERIAS].sort());
    for (const g of GALERIAS) expect(lee(g), g).toMatch(/if \(!capturaDisponible\(\)\) notFound\(\);/);
    // Y las públicas de verdad están en el otro lado.
    const sin = rutas().filter((r: { conHojaDelPanel: boolean }) => !r.conHojaDelPanel).map((r: { ruta: string }) => r.ruta);
    for (const r of ["layout.tsx", "page.tsx", "not-found.tsx", "pricing/page.tsx", "how-it-works/page.tsx", "benchmarks/page.tsx", "privacy/page.tsx", "login/page.tsx", "signup/page.tsx", "invitacion/[token]/page.tsx"]) {
      expect(sin, r).toContain(`app/[locale]/${r}`);
    }
    expect(sin).toContain("app/not-found.tsx");
  });

  it("va delante de la de affectUI del panel, en el layout y en cada galería", () => {
    // En producción Next emite `panel.css` antes que `affectui-panel.css` se
    // importen en el orden que se importen (comprobado con los dos, 2026-11-16).
    // Importarlas así hace que `next dev` —y las galerías— pinten esa misma
    // cascada. Ninguna regla de la hoja del panel empata hoy con una de
    // affectUI sobre el mismo elemento, así que el orden no decide nada: que
    // siga sin decidirlo es cosa de quien traiga reglas nuevas.
    for (const f of ["app/[locale]/dashboard/layout.tsx", ...GALERIAS]) {
      const hojas = [...lee(f).matchAll(/^\s*import\s+["']([^"']+\.css)["']/gm)].map((m) => m[1]!.replace(/^.*\//, ""));
      expect(hojas, f).toEqual(["panel.css", "affectui-panel.css"]);
    }
  });
});

describe("qué cuenta como público", () => {
  it("el corpus público incluye la portada, lo que importa y los mensajes; no el panel", () => {
    const publicos = ficherosPublicos();
    for (const f of ["app/[locale]/page.tsx", "app/[locale]/layout.tsx", "app/components/NavBar.tsx", "app/components/Footer.tsx", "messages/es.json", "middleware.ts"]) {
      expect(publicos, f).toContain(f);
    }
    expect(publicos).not.toContain("app/[locale]/dashboard/layout.tsx");
    expect(publicos).not.toContain("app/[locale]/dashboard/page.tsx");
    for (const g of GALERIAS) expect(publicos, g).not.toContain(g);
    // Nada que no sea código: una hoja en el corpus haría pública cada clase que define.
    expect(publicos.filter((f: string) => !/\.(ts|tsx|mjs|js|json)$/.test(f))).toEqual([]);
  });

  it("las clases de la portada son públicas; las del extracto, no", () => {
    const voc = vocabularioPublico();
    for (const c of ["lp", "btn", "hero-panel", "skip-link", "app-sidebar"]) expect(laProduce(c, voc), c).toBe(true);
    for (const c of ["ext-grid", "acct-facts", "equipo-form"]) expect(laProduce(c, voc), c).toBe(false);
  });

  it("solo cuentan las clases que el selector exige", () => {
    expect(clasesQueExige(".a:not(.b) > .c[data-x='.d']:is(.e, .f)::before")).toEqual(["a", "c"]);
    expect(clasesQueExige("button:hover")).toEqual([]);
    expect(selectores(".a, .b:is(.c, .d) .e ,\n.f")).toEqual([".a", ".b:is(.c, .d) .e", ".f"]);
  });

  it("una clase compuesta al ejecutar es de quien la compone", () => {
    const voc = { palabras: new Set(["tarjeta", "ui-x"]), prefijos: ["ui-bdgc--", "tono"], sufijos: ["-title"] };
    expect(laProduce("tarjeta", voc)).toBe(true);
    expect(laProduce("tarjeta-grande", voc)).toBe(false);
    expect(laProduce("ui-bdgc--warn", voc)).toBe(true);
    expect(laProduce("tono3", voc)).toBe(true);
    // El sufijo solo vale sobre una raíz que también es pública.
    expect(laProduce("ui-x-title", voc)).toBe(true);
    expect(laProduce("otra-title", voc)).toBe(false);
  });

  it("una regla es del panel solo si lo son TODOS sus selectores", () => {
    const voc = { palabras: new Set(["publica"]), prefijos: [], sufijos: [] };
    expect(esSoloDelPanel(".privada", voc)).toBe(true);
    expect(esSoloDelPanel(".publica .privada, .privada:hover", voc)).toBe(true);
    expect(esSoloDelPanel(".privada, .publica", voc)).toBe(false);
    expect(esSoloDelPanel(".publica:not(.privada)", voc)).toBe(false);
    expect(esSoloDelPanel("a:hover", voc)).toBe(false);
    expect(esSoloDelPanel(":root", voc)).toBe(false);
  });

  it("el vocabulario lee prefijos de plantillas y de sumas, no las órdenes de un trazado", () => {
    // Sobre un fichero real: la pieza de insignias compone su variante.
    const voc = vocabulario(["app/components/RevealObserver.tsx"]);
    expect(voc.palabras.has("rv-on")).toBe(true);
    expect(vocabularioPublico().prefijos.filter((p: string) => p.length < 2)).toEqual([]);
  });
});
