import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * «INSTALAR GRATIS» ES EL BOTÓN PRINCIPAL (dueño, 2026-11-21; parte 1 de #610).
 *
 * Con @bivelio/savings-layer 1.2.3, la versión publicada, una clave de Measure
 * pone el SDK en modo sombra: observa y no ahorra. Lo que ahorra es el open
 * source sin clave. Por eso, en los héroes de la portada y de /pricing, el
 * primer botón instala gratis (#sdk-install) y Measure pasa a segundo; en
 * /pricing, «Ver el código» pasa a tercero.
 *
 * El diseño no cambia: cada posición conserva sus clases, y solo cambian el
 * texto, el destino y el orden. Lo que la web dice de Measure (que observa) no
 * se toca aquí.
 */

const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"] as const;
type Loc = (typeof LOCALES)[number];

/** El texto del botón principal en cada idioma (landing.hero.ctaOss y pricingPage.access.install). */
const GRATIS: Record<Loc, string> = {
  ca: "Instal·lar gratis",
  de: "Kostenlos installieren",
  en: "Install free",
  es: "Instalar gratis",
  fr: "Installer gratuitement",
  id: "Pasang gratis",
  it: "Installa gratis",
  nl: "Gratis installeren",
  pl: "Zainstaluj za darmo",
  pt: "Instalar grátis",
  tr: "Ücretsiz kurun",
  vi: "Cài miễn phí",
};

const mensajes = (loc: string) => JSON.parse(readFileSync(new URL(`./${loc}.json`, import.meta.url), "utf8"));

/** El fuente sin comentarios: lo que se comprueba es el JSX, no lo que se cuenta de él. */
const codigo = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("los botones del héroe: instalar gratis primero, Measure después, mismas clases", () => {
  it("portada: el primero lleva a #sdk-install con hero.ctaOss y Measure va de segundo", () => {
    const src = codigo("app/[locale]/page.tsx");
    const cta = src.slice(src.indexOf('className="hero-cta"'), src.indexOf('className="hpanel-shot"'));
    expect(cta).toMatch(
      /^className="hero-cta">\s*<a className="btn" href="#sdk-install">\s*\{t\("hero\.ctaOss"\)\}\s*<\/a>\s*<Link className="btn ghost hero-oss" href="\/signup">\s*\{t\("hero\.ctaStart"\)\}\s*<\/Link>/,
    );
  });

  it("portada: el ancla #sdk-install existe, una sola vez", () => {
    const src = codigo("app/[locale]/page.tsx");
    expect(src.match(/id="sdk-install"/g)).toHaveLength(1);
  });

  it("/pricing: instalar gratis (btn), Measure (btn ghost) y el código (btn btn-quiet)", () => {
    const src = codigo("app/[locale]/pricing/page.tsx");
    const acc = src.slice(src.indexOf('className="precios-acciones"'), src.indexOf("terms-governs"));
    expect(acc).toMatch(/<Link className="btn" href="\/#sdk-install">\s*\{t\("access\.install"\)\}\s*<\/Link>/);
    expect(acc).toMatch(/<Link className="btn ghost" href="\/signup">\s*\{t\("cards\.medir\.cta"\)\}\s*<\/Link>/);
    expect(acc).toMatch(/<a className="btn btn-quiet" href=\{URL_DEL_CODIGO\}[^>]*>\s*\{t\("access\.code"\)\}/);
    expect([...acc.matchAll(/className="([^"]+)"/g)].map((m) => m[1])).toEqual(["precios-acciones", "btn", "btn ghost", "btn btn-quiet", "sr-only"]);
  });
});

describe("los 12 idiomas: el botón principal dice gratis", () => {
  const en = mensajes("en");
  for (const loc of LOCALES) {
    it(`${loc}: portada y /pricing dicen lo mismo, «${GRATIS[loc]}»`, () => {
      const m = mensajes(loc);
      expect(m.landing.hero.ctaOss).toBe(GRATIS[loc]);
      expect(m.pricingPage.access.install).toBe(GRATIS[loc]);
      if (loc !== "en") expect(m.landing.hero.ctaOss).not.toBe(en.landing.hero.ctaOss);
      // El botón de instalar no nombra ninguna clave, licencia ni plan.
      expect(GRATIS[loc]).not.toMatch(/measure|key|clave|licen|pro\b|team/i);
    });
  }
});
