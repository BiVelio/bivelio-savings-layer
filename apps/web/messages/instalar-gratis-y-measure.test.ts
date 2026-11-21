import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { VERSION_MEDIR_AHORRA, VERSION_MINIMA_MEDIR } from "@/lib/license/medir-publico";

/**
 * LA WEB DICE LO QUE EL PRODUCTO HACE (dueño, 2026-11-21; auditoría de ahorro
 * con proveedores falsos y grupos m02, m03, m16, m17 de la auditoría de medios).
 *
 *   · El botón principal instala el open source GRATIS y sin clave, que es lo
 *     que ahorra; Measure pasa a segundo (portada y /pricing). Solo cambian
 *     texto, destino y orden: cada posición conserva sus clases.
 *   · Con @bivelio/savings-layer 1.2.4, Measure ahorra: las mismas palancas que
 *     sin clave y el panel con el ahorro real. Las versiones anteriores solo
 *     observan (modo sombra). La versión llega por parámetro.
 *   · Pro no vende «todas las optimizaciones»: las palancas son gratis sin
 *     clave; lo que se paga es la nube (panel de equipo, medición compartida,
 *     asientos y licencias). Solo se cobra el Cloud.
 *   · Las «cachés compartidas» no existen en la nube: fuera del alta y de
 *     «cómo funciona». Compartir caché es gratis con un almacén propio.
 *   · «Todas las palancas locales encendidas» no es cierto: unas van por
 *     defecto y el resto se enciende, una línea cada una.
 *   · La compactación no va por defecto; la tarjeta de Claude Code no promete
 *     ahorro con suscripción.
 *
 * Las claves del panel (dashboard.*) las lleva otro trabajo y no se tocan aquí.
 * `auth.signupMedir` conserva la frase de #608 («la última versión», sin número;
 * textos-que-no-caducan.test.ts) y solo deja de decir «modo sombra».
 */

const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"] as const;
type Loc = (typeof LOCALES)[number];

const crudo = (loc: string) => JSON.parse(readFileSync(new URL(`./${loc}.json`, import.meta.url), "utf8"));
type Plano = Record<string, string>;
function aplanar(o: unknown, p = ""): Plano {
  if (o !== null && typeof o === "object") {
    return Object.entries(o as Record<string, unknown>).reduce<Plano>((acc, [k, v]) => Object.assign(acc, aplanar(v, p ? `${p}.${k}` : k)), {});
  }
  return { [p]: String(o) };
}
const cargar = (loc: string): Plano => aplanar(crudo(loc));
/** Lo público: todo menos el panel, que lleva otro trabajo. */
const publicas = (d: Plano) => Object.entries(d).filter(([k]) => !k.startsWith("dashboard."));

const codigo = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Las claves que este cambio reescribe: en todos los idiomas existen y no se quedan en inglés. */
const CAMBIADAS = [
  "landing.hero.ctaOss",
  "pricingPage.access.install",
  "pricingPage.cards.medir.unit",
  "pricingPage.cards.medir.summary",
  "pricingPage.plans.medir.body",
  "landing.pricing.plans.medir.body",
  "pricingPage.cards.pro.summary",
  "pricingPage.plans.pro.body",
  "landing.pricing.plans.pro.note",
  "landing.pricing.features.0",
  "auth.signupSubtitle",
  "auth.signupMedir",
  "landing.explica.pasos.3.body",
  "landing.pricing.body",
  "pricingPage.modes.cloud.body",
  "howItWorks.pieces.cloud.account",
  "howItWorks.mBeforeBody",
  "landing.faq.items.2.a",
  "landing.faq.items.6.a",
  "landing.closing.sub",
  "landing.layer.step3Title",
  "landing.layer.step3Body",
  "landing.layer.compactLabel",
  "landing.layer.legendData",
  "howItWorks.caseCodeBody",
] as const;

describe("los botones: instalar gratis primero, Measure después, mismas clases", () => {
  it("portada: el héroe lleva a #sdk-install con «Install free» y deja Measure de segundo", () => {
    const src = codigo("app/[locale]/page.tsx");
    const cta = src.slice(src.indexOf('className="hero-cta"'), src.indexOf('className="hpanel-shot"'));
    expect(cta).toMatch(/^className="hero-cta">\s*<a className="btn" href="#sdk-install">\s*\{t\("hero\.ctaOss"\)\}\s*<\/a>\s*<Link className="btn ghost hero-oss" href="\/signup">\s*\{t\("hero\.ctaStart"\)\}\s*<\/Link>/);
  });

  it("/pricing: instalar gratis (btn), Measure (btn ghost) y el código (btn btn-quiet)", () => {
    const src = codigo("app/[locale]/pricing/page.tsx");
    const acc = src.slice(src.indexOf('className="precios-acciones"'), src.indexOf("terms-governs"));
    expect(acc).toMatch(/<Link className="btn" href="\/#sdk-install">\s*\{t\("access\.install"\)\}\s*<\/Link>/);
    expect(acc).toMatch(/<Link className="btn ghost" href="\/signup">\s*\{t\("cards\.medir\.cta"\)\}\s*<\/Link>/);
    expect(acc).toMatch(/<a className="btn btn-quiet" href=\{URL_DEL_CODIGO\}[^>]*>\s*\{t\("access\.code"\)\}/);
    expect([...acc.matchAll(/className="([^"]+)"/g)].map((m) => m[1])).toEqual(["precios-acciones", "btn", "btn ghost", "btn btn-quiet", "sr-only"]);
  });

  it("en/es: el texto del botón principal dice gratis", () => {
    const en = cargar("en");
    const es = cargar("es");
    expect(en["landing.hero.ctaOss"]).toBe("Install free");
    expect(en["pricingPage.access.install"]).toBe("Install free");
    expect(es["landing.hero.ctaOss"]).toBe("Instalar gratis");
    expect(es["pricingPage.access.install"]).toBe("Instalar gratis");
  });
});

describe("Measure con la 1.2.4: ahorra, y las versiones anteriores solo observan", () => {
  it("la versión que ahorra es la 1.2.4 y la mínima que reconoce la licencia sigue siendo la 0.4.33", () => {
    expect(VERSION_MEDIR_AHORRA).toBe("1.2.4");
    expect(VERSION_MINIMA_MEDIR).toBe("0.4.33");
  });

  it("la tarjeta (PlanesCloud) y las condiciones de /pricing reciben la versión por parámetro", () => {
    expect(codigo("app/components/landing/PlanesCloud.tsx")).toContain('summary: c("medir.summary", { saves: VERSION_MEDIR_AHORRA })');
    expect(codigo("app/[locale]/pricing/page.tsx")).toMatch(/t\.rich\("plans\.medir\.body", \{[^}]*saves: VERSION_MEDIR_AHORRA,/);
  });

  for (const loc of LOCALES) {
    it(`${loc}: tarjeta y condiciones se formatean con la versión, sin números escritos a mano`, () => {
      const d = cargar(loc);
      for (const k of ["pricingPage.cards.medir.summary", "pricingPage.plans.medir.body"]) {
        expect(d[k], `${loc} ${k}`).toContain("{saves}");
        expect(d[k], `${loc} ${k}`).toContain("@bivelio/savings-layer");
        expect(d[k], `${loc} ${k}`).not.toMatch(/[0-9]/);
      }
      expect(d["pricingPage.plans.medir.body"]).toContain("{version}");
      const t = createTranslator({ locale: loc, messages: crudo(loc), onError: (e) => { throw e; } });
      const tarjeta = (t as unknown as (k: string, p: object) => string)("pricingPage.cards.medir.summary", { saves: VERSION_MEDIR_AHORRA });
      expect(tarjeta).toContain("@bivelio/savings-layer 1.2.4");
      const condiciones = JSON.stringify(
        (t as unknown as { rich: (k: string, p: object) => unknown }).rich("pricingPage.plans.medir.body", {
          b: (c: unknown) => c,
          seats: 5,
          requests: "20.000",
          version: VERSION_MINIMA_MEDIR,
          saves: VERSION_MEDIR_AHORRA,
        }),
      );
      for (const v of ["1.2.4", "0.4.33", "20.000"]) expect(condiciones, `${loc} ${v}`).toContain(v);
    });
  }

  it("en/es: la tarjeta y los textos que presentan Measure ya no dicen que solo mide en sombra", () => {
    const en = cargar("en");
    const es = cargar("es");
    const PRESENTAN = ["auth.signupMedir", "pricingPage.cards.medir.unit", "pricingPage.cards.medir.summary", "pricingPage.modes.cloud.body", "howItWorks.pieces.cloud.account", "howItWorks.mBeforeBody", "landing.faq.items.2.a", "landing.closing.sub"];
    for (const k of PRESENTAN) {
      expect(en[k], k).not.toMatch(/shadow/i);
      expect(es[k], k).not.toMatch(/sombra/i);
    }
    expect(en["pricingPage.cards.medir.unit"]).toBe("The free cloud plan, for small teams.");
    expect(en["pricingPage.cards.medir.summary"]).toBe(
      "The dashboard with what you really save, and the same levers as with no key. Saves with @bivelio/savings-layer {saves} or later; older versions only observe.",
    );
    // Las condiciones sí nombran la sombra: es lo que hacen las versiones anteriores.
    expect(en["pricingPage.plans.medir.body"]).toContain("only observe with a Measure key: shadow mode");
    expect(en["pricingPage.plans.medir.body"]).not.toMatch(/cloud levers need Pro or Team/);
    expect(es["pricingPage.plans.medir.body"]).not.toMatch(/palancas de nube necesitan Pro o Team/);
  });
});

describe("Pro y Team: se paga la nube, no las palancas (m02)", () => {
  it("en: ningún texto público dice «Every optimization»; Pro dice lo que se paga y que las palancas son gratis", () => {
    const en = cargar("en");
    expect(publicas(en).filter(([, v]) => /every (BV.SALA )?optimization/i.test(v)).map(([k]) => k)).toEqual([]);
    expect(en["pricingPage.cards.pro.summary"]).toBe(
      "Everything in Measure, for more machines and requests: team dashboard, shared measurement, seats and licences. The engine and its levers stay free without a key. A flat fee, due whether or not you save.",
    );
    expect(en["pricingPage.plans.pro.body"]).toContain("The engine and its levers stay free without a key.");
    expect(en["pricingPage.plans.pro.body"]).toContain("<b>No commission</b>");
  });

  it("es: tampoco «todas las optimizaciones»", () => {
    const es = cargar("es");
    expect(publicas(es).filter(([, v]) => /todas las optimizaciones/i.test(v)).map(([k]) => k)).toEqual([]);
    expect(es["pricingPage.cards.pro.summary"]).toContain("El motor y sus palancas siguen gratis sin clave.");
  });
});

describe("las cachés compartidas no existen en la nube (m03)", () => {
  /** «Cachés compartidas» en cada idioma, como lo decía la web hasta el 2026-11-21. */
  const COMPARTIDAS: Record<Loc, RegExp> = {
    ca: /memòries cau compartides/i,
    de: /geteilte Caches/i,
    en: /shared caches?/i,
    es: /cachés compartidas/i,
    fr: /caches partagées/i,
    id: /cache bersama/i,
    it: /cache condivise/i,
    nl: /gedeelde caches/i,
    pl: /współdzielone pamięci podręczne/i,
    pt: /caches partilhadas/i,
    tr: /paylaşılan önbellekler/i,
    vi: /cache dùng chung/i,
  };
  for (const loc of LOCALES) {
    it(`${loc}: ningún texto público las ofrece`, () => {
      expect(publicas(cargar(loc)).filter(([, v]) => COMPARTIDAS[loc].test(v)).map(([k]) => k)).toEqual([]);
    });
  }

  it("en/es: el alta y «cómo funciona» dicen lo que la nube sí da, y compartir caché es gratis con un almacén propio", () => {
    const en = cargar("en");
    const es = cargar("es");
    expect(en["auth.signupSubtitle"]).toContain("team dashboard, shared measurement, seats and licences");
    expect(es["auth.signupSubtitle"]).toContain("panel de equipo, medición compartida, asientos y licencias");
    expect(en["landing.explica.pasos.3.body"]).toContain("Two machines can share a cache for free with a store you run (Redis, for example).");
    expect(es["landing.explica.pasos.3.body"]).toContain("Dos máquinas pueden compartir caché gratis con un almacén tuyo (Redis, por ejemplo).");
  });
});

describe("qué va encendido por defecto (m17) y la compactación (m16)", () => {
  it("en: nadie dice «every local lever on» ni «the levers are on»", () => {
    expect(publicas(cargar("en")).filter(([, v]) => /every local (saving )?lever|levers are on/i.test(v)).map(([k]) => k)).toEqual([]);
  });

  it("es: nadie dice «todas las palancas locales encendidas» ni «las palancas están encendidas»", () => {
    expect(publicas(cargar("es")).filter(([, v]) => /palancas locales encendidas|palancas están encendidas|cada palanca local/i.test(v)).map(([k]) => k)).toEqual([]);
  });

  it("en/es: la tarjeta de open core dice cuáles van por defecto y que el resto se enciende", () => {
    const en = cargar("en")["landing.explica.pasos.3.body"]!;
    expect(en).toContain("Every lever is included and free, with no key.");
    expect(en).toContain("On by default: exact cache, in-flight deduplication, local resolvers, prompt-cache placement and trimming of superseded tool results.");
    expect(en).toContain("The rest you switch on, one line each.");
    const es = cargar("es")["landing.explica.pasos.3.body"]!;
    expect(es).toContain("Todas las palancas vienen incluidas y gratis, sin clave.");
    expect(es).toContain("Las demás se encienden con una línea cada una.");
  });

  it("en/es: el paso 3 de la animación no dice «datos compactados» como si fuera por defecto", () => {
    const en = cargar("en");
    const es = cargar("es");
    expect(en["landing.layer.step3Title"]).not.toMatch(/compact/i);
    expect(es["landing.layer.step3Title"]).not.toMatch(/compact/i);
    expect(en["landing.layer.step3Body"]).toContain("Compacting tool outputs is a lever you switch on.");
    expect(es["landing.layer.step3Body"]).toContain("Compactar las salidas de herramientas es una palanca que enciendes tú.");
  });
});

describe("Claude Code: con suscripción el gateway no toca el tráfico y el skill no está medido", () => {
  /** La primera frase vieja: el skill «estira el mismo tope semanal». */
  const VIEJA: Record<Loc, string> = {
    ca: "estira el mateix topall setmanal",
    de: "dehnt dasselbe Wochenlimit",
    en: "stretches the same weekly cap",
    es: "estira el mismo tope semanal",
    fr: "étire le même plafond hebdomadaire",
    id: "merenggangkan batas mingguan yang sama",
    it: "allunga lo stesso tetto settimanale",
    nl: "rekt dezelfde weeklimiet op",
    pl: "rozciąga ten sam tygodniowy limit",
    pt: "estica o mesmo teto semanal",
    tr: "aynı haftalık limiti esnetir",
    vi: "kéo giãn chính giới hạn tuần ấy",
  };
  for (const loc of LOCALES) {
    it(`${loc}: la tarjeta ya no dice que el skill estira el tope y nombra savings-mode`, () => {
      const t = cargar(loc)["howItWorks.caseCodeBody"]!;
      expect(t).not.toContain(VIEJA[loc]);
      expect(t).toContain("savings-mode");
    });
  }

  it("en/es: con suscripción, el gateway no cambia el tráfico y mide en local, gratis", () => {
    expect(cargar("en")["howItWorks.caseCodeBody"]).toMatch(/^On a subscription the fee is flat, and the gateway changes nothing in your traffic: it measures each session's spend on your machine, free, at list price\. For the caps there is the savings-mode skill, free, with its effect not measured yet\. /);
    expect(cargar("es")["howItWorks.caseCodeBody"]).toMatch(/^Con suscripción la cuota es fija, y el gateway no cambia nada de tu tráfico: mide en tu máquina, gratis, lo que gasta cada sesión a precio de lista\. /);
  });
});

describe("los 12 idiomas", () => {
  const en = cargar("en");
  for (const loc of LOCALES) {
    it(`${loc}: las claves cambiadas existen${loc === "en" ? "" : " y no se quedaron en inglés"}`, () => {
      const d = cargar(loc);
      for (const k of CAMBIADAS) expect(d[k], `${loc} ${k}`).toBeTruthy();
      if (loc !== "en") expect(CAMBIADAS.filter((k) => d[k] === en[k])).toEqual([]);
    });
  }
});
