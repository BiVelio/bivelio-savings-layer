import { NextRequest } from "next/server";
import { describe, it, expect } from "vitest";

import sitemap from "./app/sitemap";
import { locales } from "./i18n/config";
import { languageAlternates } from "./i18n/site";
import middleware from "./middleware";

/**
 * QUIEN NO HABLA NINGUNO DE NUESTROS IDIOMAS VA A /en, NO A /es (W6, auditoría
 * del lanzamiento, 2026-11-19).
 *
 * El idioma de respaldo era el español: un visitante con el navegador en
 * japonés, chino o ruso —buena parte del público de un lanzamiento
 * internacional— caía en `/es`, y `hreflang="x-default"` le decía lo mismo a
 * los buscadores. El inglés es el respaldo; quien SÍ habla uno de los doce
 * idiomas sigue yendo al suyo, y el español sigue siendo `/es`.
 *
 * Se ejercita el middleware de verdad (next-intl incluido), no una copia de su
 * regla: lo que importa es adónde manda `GET /`.
 */

const pedir = (cabeceras: Record<string, string> = {}, ruta = "/") =>
  middleware(new NextRequest(`https://savings.bivelio.com${ruta}`, { headers: cabeceras }));

const destino = async (cabeceras: Record<string, string> = {}, ruta = "/") => {
  const res = await pedir(cabeceras, ruta);
  expect([307, 308]).toContain(res.status);
  const loc = new URL(res.headers.get("location")!);
  return loc.pathname + loc.search;
};

describe("GET / — a qué idioma se manda al visitante", () => {
  for (const idioma of ["ja", "zh-CN", "zh-TW,zh;q=0.9", "ru", "ko-KR,ko;q=0.9", "sv", "ar", "hi-IN"]) {
    it(`⛔ Accept-Language «${idioma}» (no soportado) → /en`, async () => {
      expect(await destino({ "accept-language": idioma })).toBe("/en");
    });
  }

  it("⛔ sin cabecera de idioma (rastreadores, curl) → /en", async () => {
    expect(await destino()).toBe("/en");
    expect(await destino({ "accept-language": "*" })).toBe("/en");
  });

  it("los doce idiomas soportados siguen yendo al suyo", async () => {
    for (const loc of locales) {
      expect(await destino({ "accept-language": loc }), loc).toBe(`/${loc}`);
    }
  });

  it("las variantes regionales siguen igual: es-ES y es-MX → /es, en-US → /en, pt-BR → /pt, de-AT → /de", async () => {
    expect(await destino({ "accept-language": "es-ES,es;q=0.9,en;q=0.8" })).toBe("/es");
    expect(await destino({ "accept-language": "es-MX" })).toBe("/es");
    expect(await destino({ "accept-language": "en-US,en;q=0.9" })).toBe("/en");
    expect(await destino({ "accept-language": "pt-BR,pt;q=0.9" })).toBe("/pt");
    expect(await destino({ "accept-language": "de-AT" })).toBe("/de");
  });

  it("un idioma no soportado seguido de uno que sí: gana el soportado, no el respaldo", async () => {
    expect(await destino({ "accept-language": "ja,es;q=0.8" })).toBe("/es");
    expect(await destino({ "accept-language": "ru,fr;q=0.7,en;q=0.3" })).toBe("/fr");
  });

  it("quien eligió idioma a mano (cookie NEXT_LOCALE) lo conserva, diga lo que diga el navegador", async () => {
    expect(await destino({ cookie: "NEXT_LOCALE=es", "accept-language": "ja" })).toBe("/es");
    expect(await destino({ cookie: "NEXT_LOCALE=es" })).toBe("/es");
    expect(await destino({ cookie: "NEXT_LOCALE=ca", "accept-language": "en-US" })).toBe("/ca");
  });

  it("las rutas sin prefijo siguen la misma regla y conservan la consulta", async () => {
    expect(await destino({ "accept-language": "ja" }, "/pricing?plan=pro")).toBe("/en/pricing?plan=pro");
    expect(await destino({ "accept-language": "es-ES" }, "/pricing?plan=pro")).toBe("/es/pricing?plan=pro");
  });

  it("una URL que ya trae idioma no se toca: /es sigue siendo /es para todo el mundo", async () => {
    for (const ruta of ["/es", "/es/pricing", "/en", "/vi/how-it-works"]) {
      const res = await pedir({ "accept-language": "ja" }, ruta);
      expect(res.headers.get("location"), ruta).toBeNull();
      expect(res.status, ruta).toBe(200);
    }
  });
});

describe("hreflang x-default → /en", () => {
  it("⛔ en el mapa de alternativas de la portada y de las páginas públicas", () => {
    expect(languageAlternates()["x-default"]).toMatch(/\/en$/);
    expect(languageAlternates("pricing")["x-default"]).toMatch(/\/en\/pricing$/);
    // …y cada idioma sigue apuntando a sí mismo.
    for (const loc of locales) expect(languageAlternates()[loc]).toMatch(new RegExp(`/${loc}$`));
  });

  it("⛔ en todas las entradas del sitemap que declaran alternativas", () => {
    const conAlternativas = sitemap().filter((e) => e.alternates?.languages);
    expect(conAlternativas.length).toBeGreaterThan(locales.length);
    for (const entrada of conAlternativas) {
      const xDefault = (entrada.alternates!.languages as Record<string, string>)["x-default"]!;
      expect(new URL(xDefault).pathname.split("/")[1], entrada.url).toBe("en");
    }
  });

  it("⛔ en la cabecera Link que el middleware pone en cada página", async () => {
    const res = await pedir({ "accept-language": "ja" }, "/es");
    const link = res.headers.get("link") ?? "";
    const xDefault = link.split(",").find((l) => l.includes('hreflang="x-default"'));
    expect(xDefault, link).toBeDefined();
    expect(xDefault!).toMatch(/<https:\/\/savings\.bivelio\.com\/(en)?>/);
  });
});
