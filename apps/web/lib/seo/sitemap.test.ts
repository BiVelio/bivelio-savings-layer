import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import sitemap from "@/app/sitemap";
import { locales } from "@/i18n/config";
import { EDICION_PAPER } from "@/lib/paper/edicion";

import { entradasDeGuias } from "./guias-en-el-sitemap";

const WEB = fileURLToPath(new URL("../../", import.meta.url));

describe("sitemap.xml", () => {
  const entradas = sitemap();
  const rutas = entradas.map((e) => new URL(e.url).pathname);

  it("cinco páginas en los 12 idiomas y el paper una vez, en /en", () => {
    expect(entradas).toHaveLength(5 * locales.length + 1);
    for (const p of ["", "/how-it-works", "/pricing", "/privacy", "/benchmarks"]) {
      for (const loc of locales) expect(rutas, `/${loc}${p}`).toContain(`/${loc}${p}`);
    }
    expect(rutas.filter((r) => r.endsWith("/paper"))).toEqual(["/en/paper"]);
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

describe("las guías entran por el enganche de sitemap.ts", () => {
  const construido = new Date("2026-11-23T00:00:00Z");

  it("una entrada por slug, en /en, con en + x-default; con fecha propia o la del build", () => {
    const e = entradasDeGuias(["reduce-openai-costs", { slug: "prompt-caching", lastModified: "2026-11-20" }], construido);
    expect(e.map((x) => x.url)).toEqual([
      "https://savings.bivelio.com/en/guides/reduce-openai-costs",
      "https://savings.bivelio.com/en/guides/prompt-caching",
    ]);
    expect(e[0]!.lastModified).toBe(construido);
    expect(e[1]!.lastModified).toBe("2026-11-20");
    for (const x of e) expect(x.alternates?.languages).toEqual({ en: x.url, "x-default": x.url });
  });

  it("sin guías registradas, ninguna entrada", () => {
    expect(entradasDeGuias([], construido)).toEqual([]);
  });
});
