import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  HOJA_ACCESO,
  HOJA_GLOBAL,
  HOJA_PANEL,
  ajenasEnLaHojaDeAcceso,
  ficherosSinAcceso,
  laProduce,
  publicasEnLaHojaDeAcceso,
  reglas,
  rutas,
  trocea,
  vocabularioSinAcceso,
} from "../../../scripts/hoja-del-panel.mjs";

/**
 * LA HOJA DE ACCESO SOLO LLEVA REGLAS QUE NINGUNA PÁGINA SIN ELLA PUEDE PINTAR.
 *
 * POR QUÉ EXISTE. La portada es la página de aterrizaje de los anuncios y su
 * primer pintado espera a `globals.css` entera. El marco de acceso (la
 * tarjeta, el panel de marca, los campos, los avisos, la ficha de la
 * invitación) no se pinta en ella: vive en `components/acceso/acceso.css`, que
 * solo importan las cinco páginas de acceso. El reparto se rompe de dos
 * maneras, las dos MUDAS —no falla el build ni ningún otro test, la página
 * simplemente sale sin estilo—:
 *
 *   1. una página que no la carga (el marketing, la 404 o el PANEL, que
 *      tampoco la importa) empieza a usar una clase cuya regla está aquí;
 *   2. una página de acceso deja de importarla, o una de marketing la importa
 *      «para arreglarlo» y la portada vuelve a pagarla.
 *
 * El criterio, en la cabecera de `scripts/hoja-del-panel.mjs`. Si falla el
 * primer test: la regla vuelve a `globals.css` (y hay que comprobar que la
 * cascada no cambia: esta hoja carga DESPUÉS de `affectui.css` y la global).
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

const PAGINAS = ["login", "signup", "signup/success", "reset-password", "invitacion/[token]"].map((p) => `app/[locale]/${p}/page.tsx`);

describe("la hoja de acceso", () => {
  const hoja = lee(HOJA_ACCESO);

  it("existe y tiene las reglas del marco de acceso", () => {
    expect(reglas(hoja).length).toBeGreaterThan(60);
    for (const sel of [".auth-wrap.acc", ".auth-card.acc-card", ".acc-aside", ".inv-ficha"]) expect(hoja, sel).toContain(`\n${sel} {`);
  });

  it("no tiene ninguna regla que una página sin ella (marketing o panel) pueda pintar", () => {
    // Si falla: esa regla (entera, con todos sus selectores) vuelve a app/globals.css.
    expect(publicasEnLaHojaDeAcceso()).toEqual([]);
  });

  it("solo lleva reglas: los @keyframes, @font-face y demás se quedan en la global", () => {
    expect(ajenasEnLaHojaDeAcceso()).toEqual([]);
    expect(hoja.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/:root\b/);
  });

  it("ninguna regla está en dos hojas", () => {
    const firma = (css: string) => reglas(css).map((r: { grupos: string[]; ini: number; fin: number }) => `${r.grupos.join(" ")} ¶ ${css.slice(r.ini, r.fin)}`);
    const enOtras = new Set([...firma(lee(HOJA_GLOBAL)), ...firma(lee(HOJA_PANEL))]);
    expect(firma(hoja).filter((f: string) => enOtras.has(f))).toEqual([]);
  });

  it("cierra lo que abre", () => {
    const { nodos, cola } = trocea(hoja);
    const pega = (ns: Array<Record<string, any>>): string =>
      ns.map((n) => n.antes + (n.tipo === "grupo" ? hoja.slice(n.ini, n.abre + 1) + pega(n.hijos) + n.cola + "}" : hoja.slice(n.ini, n.fin))).join("");
    expect(pega(nodos) + cola).toBe(hoja);
  });
});

describe("quién recibe la hoja de acceso", () => {
  it("la importan las cinco páginas de acceso, y nadie más", () => {
    const importaLaDeAcceso = /^\s*import\s+["'][^"']*\/acceso\/acceso\.css["']/m;
    const quien = [...fuentes("app"), ...fuentes("lib"), ...fuentes("i18n"), ...fuentes("vendor")].filter((f) => importaLaDeAcceso.test(lee(f)));
    expect(quien.sort()).toEqual([...PAGINAS].sort());
    const con = rutas().filter((r: { conHojaDeAcceso: boolean }) => r.conHojaDeAcceso).map((r: { ruta: string }) => r.ruta);
    expect(con.sort()).toEqual([...PAGINAS].sort());
  });

  it("cada página de acceso pide sus dos hojas: la propia y, detrás, la de affectUI", () => {
    for (const f of PAGINAS) {
      const hojas = [...lee(f).matchAll(/^\s*import\s+["']([^"']+\.css)["']/gm)].map((m) => m[1]);
      expect(hojas, f).toEqual(["@/app/components/acceso/acceso.css", "@/vendor/affectui/affectui-acceso.css"]);
    }
  });

  it("ni la portada, ni la 404, ni el panel la reciben", () => {
    const sin = rutas().filter((r: { conHojaDeAcceso: boolean }) => !r.conHojaDeAcceso).map((r: { ruta: string }) => r.ruta);
    for (const r of ["layout.tsx", "page.tsx", "not-found.tsx", "pricing/page.tsx", "how-it-works/page.tsx", "benchmarks/page.tsx", "privacy/page.tsx", "dashboard/layout.tsx", "dashboard/page.tsx"]) {
      expect(sin, r).toContain(`app/[locale]/${r}`);
    }
    expect(sin).toContain("app/not-found.tsx");
  });
});

describe("qué cuenta como «sin la hoja de acceso»", () => {
  it("el corpus incluye la portada, el panel y los mensajes; no el marco de acceso", () => {
    const sin = ficherosSinAcceso();
    for (const f of ["app/[locale]/page.tsx", "app/[locale]/layout.tsx", "app/[locale]/dashboard/layout.tsx", "app/components/NavBar.tsx", "app/components/app/AppSidebar.tsx", "messages/es.json", "middleware.ts"]) {
      expect(sin, f).toContain(f);
    }
    for (const f of [...PAGINAS, "app/components/AuthForm.tsx", "app/components/acceso/AccesoShell.tsx"]) expect(sin, f).not.toContain(f);
    expect(sin.filter((f: string) => !/\.(ts|tsx|mjs|js|json)$/.test(f))).toEqual([]);
  });

  it("las clases de la portada y del panel cuentan; las del marco de acceso, no", () => {
    const voc = vocabularioSinAcceso();
    for (const c of ["lp", "btn", "hero-panel", "app-sidebar", "field"]) expect(laProduce(c, voc), c).toBe(true);
    for (const c of ["acc-card", "acc-aside", "inv-ficha", "auth-wrap"]) expect(laProduce(c, voc), c).toBe(false);
  });
});
