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
 * `auth.signupMedir` dice, como la tarjeta, desde qué versión ahorra Measure
 * (`{saves}`, por parámetro; revisión de #610) en lugar de «la última versión»:
 * es un umbral fijo y no caduca con cada release (textos-que-no-caducan.test.ts).
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
  // Verificación final de la 1.2.4 (#614): el botón principal de /how-it-works y
  // el correo de ejemplo del alta, que estaba escrito a mano en inglés.
  "howItWorks.hero.ctaInstall",
  "auth.emailPlaceholder",
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
      "The dashboard with what you really save, and the same levers as with no key (one exception for tool-result trimming, see the README). Saves with @bivelio/savings-layer {saves} or later; older versions only observe.",
    );
    // Las condiciones sí nombran la sombra: es lo que hacen las versiones anteriores.
    expect(en["pricingPage.plans.medir.body"]).toContain("only observe with a Measure key: shadow mode");
    expect(en["pricingPage.plans.medir.body"]).not.toMatch(/cloud levers need Pro or Team/);
    expect(es["pricingPage.plans.medir.body"]).not.toMatch(/palancas de nube necesitan Pro o Team/);
  });
});

describe("revisión de #610: el alta y «cómo funciona» dicen lo que hace Measure con la 1.2.4", () => {
  /** La frase de #608 que cerraba el alta: «funciona con la última versión», sin decir desde cuál ahorra. */
  const ULTIMA: Record<Loc, string> = {
    ca: "Funciona amb la darrera versió",
    de: "funktioniert mit der neuesten Version",
    en: "works with the latest version",
    es: "Funciona con la última versión",
    fr: "fonctionne avec la dernière version",
    id: "Berfungsi dengan versi terbaru",
    it: "Funziona con l'ultima versione",
    nl: "werkt met de nieuwste versie",
    pl: "Działa z najnowszą wersją",
    pt: "Funciona com a versão mais recente",
    tr: "en son sürümüyle çalışır",
    vi: "Hoạt động với phiên bản mới nhất",
  };

  it("/signup pasa la versión que ahorra por parámetro, desde la constante", () => {
    expect(codigo("app/[locale]/signup/page.tsx")).toMatch(/t\("signupMedir", \{[^}]*saves: VERSION_MEDIR_AHORRA,/);
  });

  for (const loc of LOCALES) {
    it(`${loc}: el alta dice desde qué versión ahorra y que las anteriores solo observan, sin números escritos`, () => {
      const d = cargar(loc);
      const alta = d["auth.signupMedir"]!;
      expect(alta).toContain("@bivelio/savings-layer {saves}");
      expect(alta).not.toContain(ULTIMA[loc]);
      expect(alta).not.toContain("{version}");
      expect(alta).not.toMatch(/[0-9]/);
      // La misma frase que la tarjeta de Measure: «ahorra con {saves}…; las anteriores solo observan».
      const tarjeta = d["pricingPage.cards.medir.summary"]!;
      const desdeTarjeta = tarjeta.slice(tarjeta.indexOf("@bivelio/savings-layer {saves}"));
      expect(alta.endsWith(desdeTarjeta), `${loc}: ${alta}`).toBe(true);
      const t = createTranslator({ locale: loc, messages: crudo(loc), onError: (e) => { throw e; } });
      const pintado = (t as unknown as (k: string, p: object) => string)("auth.signupMedir", { seats: 5, requests: "20.000", saves: VERSION_MEDIR_AHORRA });
      expect(pintado).toContain("@bivelio/savings-layer 1.2.4");
    });
  }

  it("en/es: el texto exacto del cierre del alta", () => {
    expect(cargar("en")["auth.signupMedir"]).toMatch(/ It saves with @bivelio\/savings-layer \{saves\} or later; older versions only observe\.$/);
    expect(cargar("es")["auth.signupMedir"]).toMatch(/ Ahorra con @bivelio\/savings-layer \{saves\} o posterior; las versiones anteriores solo observan\.$/);
  });

  it("/how-it-works: la tarjeta «antes de instalar», que nombra Measure, ya no lleva la insignia «modo sombra»", () => {
    const src = codigo("app/components/HowItWorks.tsx");
    const antes = src.slice(src.indexOf('{t("mBeforeK")}'), src.indexOf('{t("mAfterK")}'));
    expect(antes).toContain("{t(\"mBeforeBody\")}");
    expect(antes).not.toContain('tipo="sombra"');
    expect(antes).not.toContain("evidence.sombra");
    // La cifra de antes de instalar sale del banco público, como dice el texto.
    expect(antes).toContain('<EvidenceBadge tipo="benchmark" label={tUi("evidence.benchmark")} />');
    expect(cargar("en")["howItWorks.mBeforeBody"]).toContain("the public bench");
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
    // La serialización compacta también va encendida (pipeline.ts, `toggles.serialization !== false`),
    // y el README la nombra: la lista pública es la misma en los dos sitios (verificación final, #614).
    expect(en).toContain(
      "On by default: exact cache, in-flight deduplication, local resolvers, prompt-cache placement, trimming of superseded tool results and compact serialization of the structured data you pass.",
    );
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

  it("en/es: con suscripción, el gateway no cambia el tráfico (con lo que trae por defecto) y mide en local, gratis", () => {
    // «Con lo que trae por defecto»: con una palanca opcional (modelo hermano,
    // esfuerzo) el gateway sí reescribe peticiones de suscripción; el cartel y el
    // resumen al salir de la 1.2.4 ya lo dicen así (verificación final, #614).
    expect(cargar("en")["howItWorks.caseCodeBody"]).toMatch(/^On a subscription the fee is flat, and with the defaults the gateway changes nothing in your traffic: it measures each session's spend on your machine, free, at list price\. For the caps there is the savings-mode skill, free, with its effect not measured yet\. /);
    expect(cargar("es")["howItWorks.caseCodeBody"]).toMatch(/^Con suscripción la cuota es fija, y por defecto el gateway no cambia nada de tu tráfico: mide en tu máquina, gratis, lo que gasta cada sesión a precio de lista\. /);
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

/**
 * VERIFICACIÓN FINAL DE LA 1.2.4 (#614, 2026-11-21): lo que aún quedaba en la web.
 *
 *   · BLOQUEANTE: el botón principal del héroe de /how-it-works seguía diciendo
 *     «Install open source» en los 12 idiomas, mientras la portada y /pricing ya
 *     decían «Install free». Ahora es el mismo texto que el de la portada.
 *   · La tarjeta de Claude Code: «con lo que trae por defecto» el gateway no
 *     cambia el tráfico de una suscripción (con una palanca opcional sí), y al
 *     salir la 1.2.4 dice también el gasto a precio de lista y el ahorro por base.
 *   · La tarjeta de open core nombra las seis palancas que van por defecto, como
 *     el README: faltaba la serialización compacta.
 *   · La FAQ y la clave de Measure de la portada remitían a unas «condiciones»
 *     que no dan ninguna versión; ahora dicen desde cuál ahorra (por parámetro
 *     donde se puede formatear, y la página de precios en la FAQ, que va en crudo).
 *   · de: «Seats» en todo lo público, como las tarjetas (antes «5 Sitze»).
 *   · El correo de ejemplo del alta estaba escrito a mano en inglés.
 */
describe("verificación final de la 1.2.4 (#614): lo que quedaba en la web", () => {
  /** El texto del botón de la portada en cada idioma (landing.hero.ctaOss). */
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
  /** Lo que decía el botón de /how-it-works hasta hoy. */
  const OPEN_SOURCE: Record<Loc, string> = {
    ca: "Instal·lar open source",
    de: "Open Source installieren",
    en: "Install open source",
    es: "Instalar open source",
    fr: "Installer l'open source",
    id: "Pasang open source",
    it: "Installa l'open source",
    nl: "Open source installeren",
    pl: "Zainstaluj open source",
    pt: "Instalar open source",
    tr: "Açık kaynağı kur",
    vi: "Cài đặt mã nguồn mở",
  };
  /** La base del ahorro, con las palabras de landing.devs.cards.1.body en cada idioma. */
  const BASE: Record<Loc, string> = {
    ca: "(mesurat o estimat)",
    de: "(gemessen oder geschätzt)",
    en: "(measured or estimated)",
    es: "(medido o estimado)",
    fr: "(mesuré ou estimé)",
    id: "(terukur atau estimasi)",
    it: "(misurato o stimato)",
    nl: "(gemeten of geschat)",
    pl: "(zmierzone lub szacowane)",
    pt: "(medido ou estimado)",
    tr: "(ölçülen veya tahmini)",
    vi: "(đo được hay ước tính)",
  };
  /** La sexta palanca por defecto, la serialización compacta. */
  const SERIALIZACION: Record<Loc, RegExp> = {
    ca: /serialització compacta/,
    de: /kompakte Serialisierung/,
    en: /compact serialization/,
    es: /serialización compacta/,
    fr: /sérialisation compacte/,
    id: /serialisasi ringkas/,
    it: /serializzazione compatta/,
    nl: /compacte serialisatie/,
    pl: /zwarta serializacja/,
    pt: /serialização compacta/,
    tr: /kompakt serileştirilmesi/,
    vi: /tuần tự hóa gọn/,
  };
  /** La FAQ remitía a sus «condiciones» para la versión, y no dan ninguna. */
  const FAQ_VIEJA: Record<Loc, string> = {
    ca: "la versió mínima és a les seves condicions",
    de: "die Mindestversion steht in seinen Bedingungen",
    en: "the minimum version is in its terms",
    es: "la versión mínima está en sus condiciones",
    fr: "la version minimale figure dans ses conditions",
    id: "versi minimumnya ada di ketentuannya",
    it: "la versione minima è nelle sue condizioni",
    nl: "de minimale versie staat in de voorwaarden",
    pl: "minimalna wersja jest w jego warunkach",
    pt: "a versão mínima está nas suas condições",
    tr: "en düşük sürüm koşullarında yazar",
    vi: "phiên bản tối thiểu có trong điều khoản",
  };

  it("/how-it-works: el primer botón del héroe lleva a la instalación con hero.ctaInstall", () => {
    const src = codigo("app/[locale]/how-it-works/page.tsx");
    const acciones = src.slice(src.indexOf("acciones={"), src.indexOf("</GridBackground>"));
    expect(acciones).toMatch(/^acciones=\{\s*<>\s*<a className="btn btn-lg" href="#install-sdk">\s*\{t\("hero\.ctaInstall"\)\}\s*<\/a>/);
  });

  for (const loc of LOCALES) {
    it(`${loc}: el botón de /how-it-works dice lo mismo que el de la portada y /pricing`, () => {
      const d = cargar(loc);
      expect(d["landing.hero.ctaOss"]).toBe(GRATIS[loc]);
      expect(d["howItWorks.hero.ctaInstall"]).toBe(d["landing.hero.ctaOss"]);
      expect(d["howItWorks.hero.ctaInstall"]).toBe(d["pricingPage.access.install"]);
      expect(publicas(d).filter(([, v]) => v === OPEN_SOURCE[loc]).map(([k]) => k)).toEqual([]);
    });

    it(`${loc}: Claude Code — «por defecto» no cambia el tráfico, y al salir da el ahorro por base`, () => {
      const t = cargar(loc)["howItWorks.caseCodeBody"]!;
      expect(t).toContain(BASE[loc]);
      // La frase de la suscripción es la primera; «por defecto» va dentro de ella.
      const primera = t.slice(0, t.indexOf(":"));
      expect(primera, loc).toMatch(/defaults|por defecto|per defecte|Standardeinstellungen|par défaut|pengaturan bawaan|impostazioni predefinite|standaardinstellingen|ustawieniach domyślnych|por defeito|varsayılan ayarlarla|cấu hình mặc định/);
    });

    it(`${loc}: la tarjeta de open core nombra la serialización compacta entre las que van por defecto`, () => {
      expect(cargar(loc)["landing.explica.pasos.3.body"]).toMatch(SERIALIZACION[loc]);
    });

    it(`${loc}: la FAQ y la clave de Measure de la portada dicen desde qué versión ahorra`, () => {
      const d = cargar(loc);
      const faq = d["landing.faq.items.2.a"]!;
      expect(faq).not.toContain(FAQ_VIEJA[loc]);
      expect(faq).not.toMatch(/[0-9]/);
      const medir = d["landing.pricing.plans.medir.body"]!;
      expect(medir).toContain("@bivelio/savings-layer {saves}");
      const t = createTranslator({ locale: loc, messages: crudo(loc), onError: (e) => { throw e; } });
      const pintado = (t as unknown as (k: string, p: object) => string)("landing.pricing.plans.medir.body", {
        seats: 5,
        requests: "20.000",
        version: VERSION_MINIMA_MEDIR,
        saves: VERSION_MEDIR_AHORRA,
      });
      expect(pintado).toContain("@bivelio/savings-layer 1.2.4");
      expect(pintado).toContain("0.4.33");
    });

    it(`${loc}: el correo de ejemplo del alta está traducido, igual que el de la llamada de 15 min`, () => {
      const d = cargar(loc);
      expect(d["auth.emailPlaceholder"]).toBe(d["landing.cta15.placeholder"]);
      expect(d["auth.emailPlaceholder"]).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/);
    });
  }

  it("en/es: el texto exacto del cierre de la FAQ de Measure", () => {
    expect(cargar("en")["landing.faq.items.2.a"]).toMatch(/ Older versions of the package only observe with it; the pricing page says from which version it saves\.$/);
    expect(cargar("es")["landing.faq.items.2.a"]).toMatch(/ Con versiones antiguas del paquete solo observa; la página de precios dice desde qué versión ahorra\.$/);
  });

  it("AuthForm pide el correo de ejemplo a los mensajes, no en inglés a mano", () => {
    const src = codigo("app/components/AuthForm.tsx");
    expect(src).toContain('placeholder={t("emailPlaceholder")}');
    expect(src).not.toContain("you@company.com");
  });

  it("de: «Seats» en todo lo público, como en las tarjetas; ningún «Sitz»/«Sitze»", () => {
    expect(publicas(cargar("de")).filter(([, v]) => /\bSitze?\b/.test(v)).map(([k]) => k)).toEqual([]);
    expect(cargar("de")["pricingPage.plans.medir.body"]).toContain("<b>{seats} Seats</b>");
  });
});

/**
 * LA EXCEPCIÓN DEL RECORTE (comportamiento final de la 1.2.4, CHANGELOG y README
 * de release/1.2.4): con cualquier clave, Measure incluida, el recorte de
 * resultados de herramientas sustituidos solo actúa dentro de un bucle de
 * herramientas en Anthropic; sin clave, como en la 1.2.3. Por eso ningún texto
 * público dice «las mismas palancas que sin clave» a secas: donde Measure se
 * ofrece va la forma corta («una excepción para el recorte, ver el README») y
 * en sus condiciones de /pricing, la excepción entera, como el README y el
 * panel de la 1.2.4. Las condiciones tampoco dicen que el ahorro real se mida
 * todo «con el contador del proveedor»: el panel enseña lo medido y lo estimado
 * aparte (dashboard.measurePlan.card.realContext).
 */
describe("la excepción del recorte de resultados de herramientas (1.2.4)", () => {
  /** La forma corta, la misma en las cinco claves que ofrecen Measure. */
  const CORTA: Record<Loc, string> = {
    ca: "(amb una excepció en el retall de resultats d'eines, explicada al README)",
    de: "(mit einer Ausnahme beim Kürzen von Tool-Ergebnissen, siehe README)",
    en: "(one exception for tool-result trimming, see the README)",
    es: "(con una excepción en el recorte de resultados de herramientas, explicada en el README)",
    fr: "(avec une exception pour l'élagage des résultats d'outils, voir le README)",
    id: "(dengan satu pengecualian untuk pemangkasan hasil alat, lihat README)",
    it: "(con un'eccezione per il taglio dei risultati degli strumenti, vedi il README)",
    nl: "(met één uitzondering voor het inkorten van toolresultaten, zie de README)",
    pl: "(z jednym wyjątkiem dotyczącym przycinania wyników narzędzi, opisanym w README)",
    pt: "(com uma exceção no corte de resultados de ferramentas, descrita no README)",
    tr: "(tek istisna araç sonuçlarının kırpılmasında, bkz. README)",
    vi: "(có một ngoại lệ về việc cắt bớt kết quả công cụ, xem README)",
  };
  /** La excepción entera, en las condiciones de /pricing (las palabras del panel de la 1.2.4). */
  const ENTERA: Record<Loc, RegExp> = {
    ca: /només actua dins d'un bucle d'eines a Anthropic/,
    de: /ausschließlich innerhalb einer Tool-Schleife auf Anthropic/,
    en: /except that trimming of superseded tool results only acts inside a tool loop on Anthropic/,
    es: /salvo que el recorte de resultados de herramientas ya sustituidos solo actúa dentro de un bucle de herramientas en Anthropic/,
    fr: /n'agit qu'à l'intérieur d'une boucle d'outils sur Anthropic/,
    id: /hanya bekerja di dalam loop alat di Anthropic/,
    it: /agisce solo dentro un ciclo di strumenti su Anthropic/,
    nl: /alleen binnen een toollus op Anthropic werkt/,
    pl: /działa tylko wewnątrz pętli narzędzi na Anthropic/,
    pt: /só atua dentro de um ciclo de ferramentas na Anthropic/,
    tr: /yalnızca Anthropic'teki bir araç döngüsü içinde çalışır/,
    vi: /chỉ hoạt động bên trong một vòng lặp công cụ trên Anthropic/,
  };
  const OFRECEN = [
    "auth.signupMedir",
    "landing.pricing.plans.medir.body",
    "landing.faq.items.2.a",
    "landing.closing.sub",
    "pricingPage.cards.medir.summary",
  ] as const;

  for (const loc of LOCALES) {
    it(`${loc}: donde se ofrece Measure, «las mismas palancas» llevan la excepción; en las condiciones, entera`, () => {
      const d = cargar(loc);
      for (const k of OFRECEN) expect(d[k], `${loc} ${k}`).toContain(CORTA[loc]);
      expect(d["pricingPage.plans.medir.body"], loc).toMatch(ENTERA[loc]);
      // Sigue formateando (ICU) con los apóstrofos de la excepción.
      const t = createTranslator({ locale: loc, messages: crudo(loc), onError: (e) => { throw e; } });
      const alta = (t as unknown as (k: string, p: object) => string)("auth.signupMedir", { seats: 5, requests: "20.000", saves: VERSION_MEDIR_AHORRA });
      expect(alta).toContain("README");
    });
  }

  it("en/es: ningún texto público dice «the same levers» / «las mismas palancas» sin la excepción", () => {
    const en = cargar("en");
    const es = cargar("es");
    expect(publicas(en).filter(([, v]) => /same levers/i.test(v) && !/exception|except that/i.test(v)).map(([k]) => k)).toEqual([]);
    expect(publicas(es).filter(([, v]) => /mismas palancas/i.test(v) && !/excepción|salvo que/i.test(v)).map(([k]) => k)).toEqual([]);
    expect(publicas(en).filter(([, v]) => /exactly the same levers|8 (of|out of) 60/i.test(v)).map(([k]) => k)).toEqual([]);
  });

  it("vi: «cùng các» (las mismas), no «đúng các» (exactamente las) donde se ofrece Measure", () => {
    const vi = cargar("vi");
    for (const k of [...OFRECEN, "pricingPage.plans.medir.body"]) expect(vi[k], k).not.toMatch(/đúng các đòn bẩy/i);
  });

  it("en/es: las condiciones dan el ahorro real con lo medido y lo estimado aparte, no todo «con el contador del proveedor»", () => {
    const en = cargar("en")["pricingPage.plans.medir.body"]!;
    const es = cargar("es")["pricingPage.plans.medir.body"]!;
    expect(en).toContain("your real savings, measured and estimated kept apart;");
    expect(en).not.toContain("measured with your provider's own counter");
    expect(es).toContain("tu ahorro real, con lo medido y lo estimado por separado;");
    expect(es).not.toContain("medido con el contador de tu proveedor");
  });
});
