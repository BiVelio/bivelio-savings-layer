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

/**
 * LO QUE HAY DETRÁS DE «INSTALAR GRATIS» (#sdk-install y /how-it-works).
 *
 *   · El bloque del gateway llevaba sin comentar `export BIVELIO_SERVICE_KEY=bvk_…`.
 *     Quien lo pega entero deja el marcador como clave y `bvsala claude` no
 *     arranca (no hay licencia que verificar). La línea va comentada, con
 *     «optional, only for the cloud dashboard» encima: sin clave, el gateway
 *     arranca en modo Community y mide. Es el mismo texto que #610.
 *   · El fragmento del SDK imprimía `report.cost.netSavingsRatio` con «the saving,
 *     measured». La cifra no siempre es medida: `report.cost` lleva su base
 *     (`basis`), medida o estimada. Mismo texto que #610.
 */

/** El texto que se pega: los literales y los <span> de un <pre className="code">, en orden, como los pinta JSX. */
function textoDelBloque(pre: string): string {
  let out = "";
  for (const m of pre.matchAll(/\{("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\}|<span[^>]*>([^<]*)<\/span>/g)) {
    if (m[2] !== undefined) out += m[2];
    else if (m[1]!.startsWith('"')) out += JSON.parse(m[1]!) as string;
    else out += JSON.parse(`"${m[1]!.slice(1, -1).replace(/"/g, '\\"')}"`) as string;
  }
  return out;
}
/** Los bloques <pre className="code"> de un fuente que nombran una variable BIVELIO_. */
const bloquesConBivelio = (src: string) =>
  [...src.matchAll(/<pre className="code">([\s\S]*?)<\/pre>/g)].map((m) => textoDelBloque(m[1]!)).filter((t) => t.includes("BIVELIO_"));

describe("el bloque del gateway, pegado entero, arranca sin clave", () => {
  const BLOQUES = [
    ["portada (#sdk-install)", bloquesConBivelio(codigo("app/[locale]/page.tsx"))],
    ["/how-it-works#install-gateway", bloquesConBivelio(codigo("app/[locale]/how-it-works/page.tsx"))],
  ] as const;

  it("hay un bloque en la portada y dos en /how-it-works (macOS/Linux y Windows)", () => {
    expect(BLOQUES[0][1]).toHaveLength(1);
    expect(BLOQUES[1][1]).toHaveLength(2);
  });

  for (const [donde, bloques] of BLOQUES) {
    it(`${donde}: ninguna línea que nombra BIVELIO_ va sin comentar`, () => {
      for (const b of bloques) {
        expect(b).toContain("npm i -g @bivelio/savings-layer\n");
        expect(b).toMatch(/\nbvsala claude$/);
        expect(b).toContain("# optional, only for the cloud dashboard:\n");
        const lineas = b.split("\n").filter((l) => l.includes("BIVELIO_"));
        expect(lineas.length).toBeGreaterThan(0);
        for (const l of lineas) expect(l, `${donde}: ${l}`).toMatch(/^\s*#/);
        // Nada en el bloque dice que haga falta una clave para ahorrar.
        expect(b).not.toMatch(/required|needed|necesari|licen/i);
      }
    });
  }

  it("los literales exactos de #610 (portada y /how-it-works)", () => {
    expect(codigo("app/[locale]/page.tsx")).toMatch(/\{"# export "\}\s*<span className="s">BIVELIO_SERVICE_KEY<\/span>/);
    expect(codigo("app/[locale]/how-it-works/page.tsx")).toMatch(/\{"# export "\}\s*<span className="s">BIVELIO_SERVICE_KEY<\/span>/);
    expect(codigo("app/[locale]/how-it-works/page.tsx")).toMatch(/\{"# "\}\s*<span className="s">\$env:BIVELIO_SERVICE_KEY<\/span>/);
  });
});

describe("el fragmento del SDK imprime el coste con su base", () => {
  /** howItWorks.snipResult en cada idioma, como en #610. */
  const CON_SU_BASE: Record<Loc, string> = {
    ca: "l'estalvi, amb la seva base: mesurat o estimat",
    de: "die Ersparnis, mit ihrer Basis: gemessen oder geschätzt",
    en: "the saving, with its basis: measured or estimated",
    es: "el ahorro, con su base: medido o estimado",
    fr: "l'économie, avec sa base : mesurée ou estimée",
    id: "penghematan, dengan dasarnya: terukur atau diperkirakan",
    it: "il risparmio, con la sua base: misurato o stimato",
    nl: "de besparing, met haar basis: gemeten of geschat",
    pl: "oszczędność, z jej podstawą: zmierzona lub szacowana",
    pt: "a economia, com a sua base: medida ou estimada",
    tr: "tasarruf, dayanağıyla: ölçülmüş ya da tahmini",
    vi: "khoản tiết kiệm, kèm cơ sở: đã đo hoặc ước tính",
  };

  it("portada y /how-it-works imprimen report.cost, no netSavingsRatio", () => {
    for (const f of ["app/[locale]/page.tsx", "app/components/HowItWorks.tsx"]) {
      const src = codigo(f);
      expect(src, f).toContain('console.log(report.cost)  "');
      expect(src, f).not.toContain("console.log(report.cost.netSavingsRatio)");
    }
  });

  for (const loc of LOCALES) {
    it(`${loc}: el comentario dice medido o estimado`, () => {
      expect(mensajes(loc).howItWorks.snipResult).toBe(CON_SU_BASE[loc]);
    });
  }
});
