import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { alternativasDe, GUIAS, idiomasDe, urlDeGuia } from "@/app/[locale]/guides/registry";
import sitemap from "@/app/sitemap";
import { locales } from "@/i18n/config";
import { EDICION_PAPER } from "@/lib/paper/edicion";

const WEB = fileURLToPath(new URL("../../", import.meta.url));

describe("sitemap.xml", () => {
  const entradas = sitemap();
  const urls = entradas.map((e) => e.url);
  const rutas = urls.map((u) => new URL(u).pathname);

  it("cinco páginas en los 12 idiomas, el paper una vez y las guías (índice + una por guía) en cada idioma traducido", () => {
    const guias = idiomasDe().length + GUIAS.reduce((n, g) => n + idiomasDe(g.slug).length, 0);
    expect(entradas).toHaveLength(5 * locales.length + 1 + guias);
    for (const p of ["", "/how-it-works", "/pricing", "/privacy", "/benchmarks"]) {
      for (const loc of locales) expect(rutas, `/${loc}${p}`).toContain(`/${loc}${p}`);
    }
    expect(rutas.filter((r) => r.endsWith("/paper"))).toEqual(["/en/paper"]);
  });

  it("ninguna URL aparece dos veces", () => {
    const repetidas = urls.filter((u, i) => urls.indexOf(u) !== i);
    expect(repetidas).toEqual([]);
  });

  it("cada guía del registro aparece EXACTAMENTE una vez por idioma traducido, con la fecha de su registro y sus hreflang", () => {
    expect(GUIAS.length).toBeGreaterThan(0);
    for (const g of GUIAS) {
      expect(idiomasDe(g.slug), g.slug).toContain("en");
      for (const l of idiomasDe(g.slug)) {
        const suyas = entradas.filter((e) => e.url === urlDeGuia(g.slug, l));
        expect(suyas, `${l} ${g.slug}`).toHaveLength(1);
        expect(suyas[0]!.lastModified, g.slug).toBe(g.updated ?? g.date);
        expect(suyas[0]!.alternates?.languages, g.slug).toEqual(alternativasDe(g.slug));
      }
    }
    // Ninguna copia bajo un idioma sin traducción: su canonical es /en.
    const deGuias = rutas.filter((r) => r.includes("/guides"));
    expect(deGuias).toHaveLength(idiomasDe().length + GUIAS.reduce((n, g) => n + idiomasDe(g.slug).length, 0));
  });

  it("los hreflang de una guía: cada edición que existe y x-default en /en", () => {
    for (const slug of [undefined, ...GUIAS.map((g) => g.slug)]) {
      const alt = alternativasDe(slug);
      expect(alt["x-default"]).toBe(urlDeGuia(slug, "en"));
      expect(Object.keys(alt).filter((k) => k !== "x-default")).toEqual(idiomasDe(slug));
    }
  });

  it("el índice /<idioma>/guides aparece una vez por idioma, con la fecha de la guía más reciente", () => {
    const masReciente = GUIAS.map((g) => g.updated ?? g.date).sort().at(-1);
    for (const l of idiomasDe()) {
      const indice = entradas.filter((e) => e.url === urlDeGuia(undefined, l));
      expect(indice, l).toHaveLength(1);
      expect(indice[0]!.lastModified).toBe(masReciente);
    }
  });

  it("la guía de migración a la 0.5 sale del sitemap, pero la página sigue publicada", () => {
    expect(rutas.some((r) => r.includes("migrate-to-0.5"))).toBe(false);
    expect(existsSync(`${WEB}app/[locale]/migrate-to-0.5/page.tsx`)).toBe(true);
  });

  it("toda entrada lleva <lastmod>; el paper, la fecha de su edición", () => {
    for (const e of entradas) expect(e.lastModified, e.url).toBeTruthy();
    expect(entradas.find((e) => e.url.endsWith("/en/paper"))!.lastModified).toBe(EDICION_PAPER.fecha);
  });

  it("<lastmod> es la fecha del build, no «ahora» en cada llamada", async () => {
    const antes = entradas.find((e) => e.url.endsWith("/en/pricing"))!.lastModified;
    await new Promise((r) => setTimeout(r, 5));
    const despues = sitemap().find((e) => e.url.endsWith("/en/pricing"))!.lastModified;
    expect(antes).toBeInstanceOf(Date);
    expect(despues).toEqual(antes);
  });
});
