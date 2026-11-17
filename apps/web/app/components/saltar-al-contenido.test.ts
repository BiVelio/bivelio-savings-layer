import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ACCESIBILIDAD DE LANZAMIENTO (2026-11-16) — lo que axe marcaba «serious» y lo
 * que no tenía nombre en el idioma de quien lee.
 *
 * - «Saltar al contenido» es el PRIMER foco de las páginas públicas y del
 *   panel, y su destino existe en los dos sitios.
 * - Los tres `aria-label` que estaban escritos en inglés salen del catálogo.
 * - Las cajas con scroll de las tablas del banco se alcanzan con el teclado.
 * - Los doce catálogos traen las claves, traducidas.
 *
 * El contraste lo mide el navegador (axe); aquí se fija la causa en la fuente.
 */
const leer = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"];
type Catalogo = {
  nav: Record<string, string>;
  app: { topbar: Record<string, unknown> };
  landing: { footer: Record<string, string> };
  benchmarksPage: Record<string, unknown>;
};
const catalogo = (l: string) => JSON.parse(leer(`../../messages/${l}.json`)) as Catalogo;

describe("saltar al contenido", () => {
  it("el enlace apunta al id del destino y sale del catálogo", () => {
    const src = leer("./SkipLink.tsx");
    expect(src).toContain('export const ID_DEL_CONTENIDO = "contenido";');
    expect(src).toContain('className="skip-link" href={`#${ID_DEL_CONTENIDO}`}');
    expect(src).toContain('t("skipToContent")');
    expect(src).toContain('<span id={ID_DEL_CONTENIDO} className="skip-target" tabIndex={-1} />');
  });

  it("páginas públicas: va ANTES de la cabecera y su destino justo después", () => {
    const src = leer("../[locale]/layout.tsx");
    const enlace = src.indexOf("<SkipLink />");
    const cabecera = src.indexOf("<NavBar />");
    const destino = src.indexOf("<SkipTarget />");
    expect(enlace).toBeGreaterThan(-1);
    expect(cabecera).toBeGreaterThan(enlace);
    expect(destino).toBeGreaterThan(cabecera);
    expect(destino).toBeLessThan(src.indexOf("{children}"));
  });

  it("panel: va antes de la barra y el destino es el <main>", () => {
    const src = leer("../[locale]/dashboard/layout.tsx");
    const enlace = src.indexOf("<SkipLink />");
    expect(enlace).toBeGreaterThan(-1);
    expect(src.indexOf("<AppTopbar")).toBeGreaterThan(enlace);
    expect(src).toContain('<main className="app-main" id={ID_DEL_CONTENIDO} tabIndex={-1}>');
  });

  it("la hoja lo esconde fuera de pantalla y lo trae con el foco", () => {
    const css = leer("../globals.css");
    expect(css).toMatch(/\.skip-link \{[^}]*position: fixed;[^}]*transform: translateY\(-200%\);/);
    expect(css).toMatch(/\.skip-link:focus, \.skip-link:focus-visible \{[^}]*transform: none;/);
  });
});

describe("nombres accesibles en el idioma de quien lee", () => {
  it("el pie y la barra del panel no llevan aria-label escritos en inglés", () => {
    const pie = leer("./Footer.tsx");
    expect(pie).not.toMatch(/BiVelio on (LinkedIn|GitHub)/);
    expect(pie).toContain("aria-label={t(clave)}");
    const barra = leer("./app/AppTopbar.tsx");
    expect(barra).not.toContain("— dashboard");
    expect(barra).toContain('aria-label={a("brandAria")}');
  });

  it("las tablas del banco con scroll son regiones enfocables con nombre", () => {
    const src = leer("./BancoPublico.tsx");
    expect(src).toContain(
      '<div className="tbl-scroll" tabIndex={0} role="region" aria-label={t("tableRegion", { title: titulo })}>',
    );
    // Ninguna caja con scroll se queda sin foco: o es <Desplazable> o lo declara ella.
    for (const m of src.matchAll(/<div className="tbl-scroll[^>]*>/g)) expect(m[0]).toContain("tabIndex={0}");
  });

  for (const l of LOCALES) {
    it(`${l}: trae las cinco claves, y traducidas`, () => {
      const c = catalogo(l);
      const en = catalogo("en");
      const valores = {
        skip: c.nav.skipToContent,
        marca: c.app.topbar.brandAria as string,
        linkedin: c.landing.footer.socialLinkedIn,
        github: c.landing.footer.socialGitHub,
        tabla: c.benchmarksPage.tableRegion as string,
      };
      for (const [k, v] of Object.entries(valores)) expect(v, k).toBeTruthy();
      expect(valores.marca).toContain("Savings by BiVelio");
      expect(valores.linkedin).toContain("LinkedIn");
      expect(valores.github).toContain("GitHub");
      expect(valores.tabla).toContain("{title}");
      if (l !== "en") {
        expect(valores.skip).not.toBe(en.nav.skipToContent);
        expect(valores.linkedin).not.toBe(en.landing.footer.socialLinkedIn);
        expect(valores.tabla).not.toBe(en.benchmarksPage.tableRegion);
      }
    });
  }
});
