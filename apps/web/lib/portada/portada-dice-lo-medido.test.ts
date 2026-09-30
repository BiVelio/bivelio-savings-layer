import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { LIMITES_MEDIR, VERSION_MINIMA_MEDIR } from "@/lib/license/medir-publico";
import { MEASURE_LIMITS } from "../../../../packages/protocol/src/index";

import { VERSION_GEMINI_NATIVO } from "./banco-en-vivo";

/**
 * LA PORTADA DICE SOLO LO MEDIDO (2026-09-29), EN LOS 12 IDIOMAS.
 *
 * Una auditoría encontró en la web pública cinco afirmaciones que la medición
 * no sostenía o que ya no eran verdad:
 *   1. «With the SDK as you install it from npm, the bill goes down by at least
 *      10%» / «≥ 10.0% less bill»: salía de una tirada sintética con un
 *      compresor que npm no trae. /benchmarks mide ≈ 0 % sin repeticiones.
 *   2. «… enters the commission» en las tarjetas del SDK y del gateway: Pro y
 *      Equipo no llevan comisión (la modalidad con comisión está cerrada).
 *   3. «Compatible with … Gemini»: sugería medido lo que no lo está.
 *   4. Medir (gratis) sin sus límites ni la versión mínima del paquete.
 *   5. Las cifras del skill (68,2 / 19,6 / 11,6 %) sin informe publicado.
 * Esta verja impide que vuelvan, en cualquier idioma.
 */

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"] as const;
type Loc = (typeof LOCALES)[number];

type Plano = Record<string, string>;
function aplanar(o: unknown, p = ""): Plano {
  if (o !== null && typeof o === "object") {
    return Object.entries(o as Record<string, unknown>).reduce<Plano>(
      (acc, [k, v]) => Object.assign(acc, aplanar(v, p ? `${p}.${k}` : k)),
      {},
    );
  }
  return { [p]: String(o) };
}
const crudo = (loc: Loc) => JSON.parse(readFileSync(join(WEB, "messages", `${loc}.json`), "utf8")) as Record<string, unknown>;
const cargar = (loc: Loc): Plano => aplanar(crudo(loc));
const fuente = (rel: string) => readFileSync(join(WEB, rel), "utf8");
/** El fuente sin comentarios: lo que se comprueba es el código, no lo que se cuenta de él. */
const codigo = (rel: string) =>
  fuente(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Las superficies públicas: la portada, «cómo funciona», /pricing y el alta. */
const PUBLICAS = ["landing.", "howItWorks.", "pricingPage.", "auth."];
const publicas = (d: Plano) => Object.entries(d).filter(([k]) => PUBLICAS.some((p) => k.startsWith(p)));
/** Y el panel (2026-09-29): la web ENTERA dice solo lo medido, dentro y fuera. */
const PANEL = ["dashboard.", "app."];
const conPanel = (d: Plano) => Object.entries(d).filter(([k]) => [...PUBLICAS, ...PANEL].some((p) => k.startsWith(p)));

/**
 * «Al menos un 10 %» en cada idioma, tal como lo decía la portada, y la fórmula
 * genérica «al menos {piso}». Más el «≥ 10» en cualquier escritura.
 */
const AL_MENOS: Record<Loc, RegExp> = {
  en: /at least (\{piso\}|10\b)/i,
  es: /al menos (un )?(\{piso\}|10\b)/i,
  ca: /(com a mínim|almenys) (un )?(\{piso\}|10\b)/i,
  de: /(mindestens|um mindestens) (\{piso\}|10\b)/i,
  fr: /(au moins|d'au moins) (\{piso\}|10\b)/i,
  id: /(setidaknya|sedikitnya|paling sedikit) (\{piso\}|10\b)/i,
  it: /(almeno|di almeno) (il |del )?(\{piso\}|10\b)/i,
  nl: /(minstens|ten minste|minimaal) (\{piso\}|10\b)/i,
  pl: /(co najmniej|o co najmniej) (\{piso\}|10\b)/i,
  pt: /(pelo menos|no mínimo) (\{piso\}|10\b)/i,
  tr: /(en az) (%?\{piso\}|%?10\b)/i,
  vi: /(ít nhất) (\{piso\}|10\b)/i,
};
const DIEZ = /≥\s*%?\s*10(?:[.,]0)?\s*%?|\{piso\}/;

/** «Entra en la comisión» y sus hermanas, tal como lo decían las tarjetas en cada idioma. */
const ENTRA_EN_LA_COMISION: Record<Loc, RegExp> = {
  en: /enters? (the|your) commission|enter the commission/i,
  es: /entra en (la|tu) comisión|En la comisión solo entra/i,
  ca: /entra a la (teva )?comissió|A la comissió només hi entra/i,
  de: /in die Provision ein|in Ihre Provision ein|In die Provision geht/i,
  fr: /entre (jamais )?dans (la|votre) commission/i,
  id: /masuk (ke )?komisi/i,
  it: /entra (mai )?nella (tua )?commissione|Nella commissione entra/i,
  nl: /telt (nooit )?mee voor (de|je) commissie/i,
  pl: /(wchodzi|wchodzą) do (Twojej )?prowizji|Do prowizji wchodzą/i,
  pt: /entra na (tua )?comissão|Na comissão só entra/i,
  tr: /komisyon(a|unuza) (da )?(yalnızca .* )?gir/i,
  vi: /tính vào hoa hồng/i,
};

/** La palabra «comisión» en cada idioma. */
const COMISION: Record<Loc, RegExp> = {
  en: /commission/i,
  es: /comisi[oó]n/i,
  ca: /comissi[oó]/i,
  de: /Provision/i,
  fr: /commission/i,
  id: /komisi/i,
  it: /commission/i,
  nl: /commissie/i,
  pl: /prowizj/i,
  pt: /comiss[aã]o/i,
  tr: /komisyon/i,
  vi: /hoa hồng/i,
};
/**
 * Donde la comisión no pinta nada: lo que la portada dice del producto. La
 * comisión solo puede aparecer al hablar de planes (Medir «nunca comisión»,
 * Pro/Equipo «sin comisión», la modalidad antigua para quien la conserva).
 */
const SIN_COMISION = [
  "landing.hero.",
  "landing.enVivo.",
  "landing.offers.",
  "landing.devs.",
  "landing.step2.",
  "landing.cascade.",
  "landing.ledgersHead.",
  "howItWorks.",
];

describe("⛔ nunca más «al menos un 10 %» ni «entra en la comisión»", () => {
  for (const loc of LOCALES) {
    it(`${loc}: ni la web pública ni el panel prometen «al menos {piso}» / «≥ 10 %»`, () => {
      const malos = conPanel(cargar(loc))
        .filter(([, v]) => AL_MENOS[loc].test(v) || DIEZ.test(v))
        .map(([k, v]) => `${k}: ${v}`);
      expect(malos).toEqual([]);
    });

    // /pricing queda fuera a propósito: sus condiciones de la modalidad antigua
    // (cerrada a clientes nuevos) SÍ dicen qué entra en la comisión de quien la
    // conserva. La portada, «cómo funciona» y el alta, no.
    it(`${loc}: ni la portada, ni «cómo funciona», ni el alta dicen que el ahorro «entra en la comisión»`, () => {
      const malos = publicas(cargar(loc))
        .filter(([k]) => !k.startsWith("pricingPage."))
        .filter(([, v]) => ENTRA_EN_LA_COMISION[loc].test(v))
        .map(([k, v]) => `${k}: ${v}`);
      expect(malos).toEqual([]);
    });

    it(`${loc}: la portada no habla de comisión al describir el producto (Pro y Equipo no la llevan)`, () => {
      const malos = Object.entries(cargar(loc))
        .filter(([k]) => SIN_COMISION.some((p) => k.startsWith(p)))
        .filter(([, v]) => COMISION[loc].test(v))
        .map(([k]) => k);
      expect(malos).toEqual([]);
    });

    it(`${loc}: la portada ya no trae el titular de la tirada sintética ni su recibo`, () => {
      const d = crudo(loc) as { landing: Record<string, Record<string, unknown>> };
      expect(d.landing.hero!.proofs).toBeUndefined();
      expect(d.landing.hero!.proofSdkPendiente).toBeUndefined();
      expect(d.landing.step2!.plainSdkPendiente).toBeUndefined();
      expect(d.landing.recibo).toBeUndefined();
    });
  }

  it("las verjas de arriba cazan las frases viejas (si no, no protegen nada)", () => {
    expect(AL_MENOS.en.test("With the SDK as you install it from npm, the bill goes down by at least {piso}.")).toBe(true);
    expect(AL_MENOS.es.test("la factura baja al menos un {piso}")).toBe(true);
    expect(DIEZ.test("≥ 10.0%")).toBe(true);
    expect(DIEZ.test("≥ %10,0")).toBe(true);
    expect(ENTRA_EN_LA_COMISION.en.test("only what your provider's counter confirms enters the commission.")).toBe(true);
    expect(ENTRA_EN_LA_COMISION.es.test("solo lo que confirma el contador de tu proveedor entra en la comisión.")).toBe(true);
    expect(ENTRA_EN_LA_COMISION.tr.test("komisyona da yalnızca sağlayıcınızın sayacının doğruladığı girer.")).toBe(true);
    expect(ENTRA_EN_LA_COMISION.vi.test("mới tính vào hoa hồng.")).toBe(true);
  });
});

describe("el código de la portada y de «cómo funciona» no lee la tirada sintética", () => {
  const FICHEROS = [
    "app/[locale]/page.tsx",
    "app/components/HowItWorks.tsx",
    "app/[locale]/how-it-works/opengraph-image.tsx",
  ];
  for (const rel of FICHEROS) {
    it(`⛔ ${rel}: sin ab-live.json, sin sueloPublicable, sin ANATOMIA_MEDIDA`, () => {
      const src = codigo(rel);
      expect(src).not.toMatch(/ab-live|sueloPublicable|PROMESA_DEL_TITULAR|ANATOMIA_MEDIDA/);
    });
  }

  it("la portada construye lo medido desde BANCO_EN_VIVO y enseña siempre la fila sin repeticiones", () => {
    const filas = codigo("app/components/MedidoEnVivo.tsx");
    expect(filas).toMatch(/from "@\/lib\/portada\/banco-en-vivo"/);
    expect(filas).toContain('t("enVivo.sinRepeticiones")');
    expect(filas).toContain('t("enVivo.conRepeticiones"');
    expect(filas).toContain('t("enVivo.anthropic"');
    expect(codigo("app/[locale]/page.tsx")).toContain("filasDelBancoEnVivo(t, locale)");
  });
});

describe("el panel: la cifra del banco en vivo y el dinero del cliente, nunca el «≥ 10 %» de la tirada sintética", () => {
  function fuentes(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(join(WEB, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) fuentes(rel, acc);
      else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) acc.push(rel);
    }
    return acc;
  }
  const TODAS = [...fuentes("app"), ...fuentes("lib")];

  it("⛔ PROMESA_DEL_TITULAR y sueloPublicable no existen en ningún fuente de la web", () => {
    expect(TODAS.length).toBeGreaterThan(100);
    expect(TODAS.filter((rel) => /PROMESA_DEL_TITULAR|sueloPublicable/.test(codigo(rel)))).toEqual([]);
  });

  it("⛔ ningún componente escribe un «≥ 10 %» a mano", () => {
    expect(TODAS.filter((rel) => DIEZ.test(codigo(rel)))).toEqual([]);
  });

  it("/dashboard/proof abre con el banco en vivo y el dinero del cliente, y etiqueta la tirada sintética", () => {
    const src = codigo("app/[locale]/dashboard/proof/page.tsx");
    const pos = ["filasDelBancoEnVivo(tl, locale)", 't.rich("proof.tuDinero"', 't("proof.sinteticaTitulo")', "<ReferenceModeBadge", "<NetSavingsCIBand"].map((x) =>
      src.indexOf(x),
    );
    for (const p of pos) expect(p).toBeGreaterThan(-1);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it("la banda del intervalo no pinta nada de una tirada que no midió lo instalado", () => {
    const src = codigo("app/[locale]/dashboard/components/NetSavingsCIBand.tsx");
    expect(src).toContain("if (!midioElSdkInstalado(ab)) return null;");
  });

  it("las baldosas vacías del panel no enseñan una «ref» de la tirada sintética", () => {
    const src = codigo("app/[locale]/dashboard/components/LiveLedgerTiles.tsx");
    expect(src).not.toMatch(/AbArtifact|ab-live|fantasmaDeReferencia|ref \$\{/);
    expect(src).toContain('t("liveLedgerTiles.ghostAwaiting")');
  });

  for (const loc of LOCALES) {
    it(`${loc}: la insignia llama «sintética» a la tirada y dice que no es una promesa; la baldosa no lleva {ref}`, () => {
      const d = cargar(loc);
      expect(d["dashboard.referenceModeBadge.sdkPendiente"], loc).toBeTruthy();
      expect(d["dashboard.proof.sinteticaTitulo"], loc).toBeTruthy();
      expect(d["dashboard.proof.tuDinero"], loc).toMatch(/<overview>.+<\/overview>/);
      expect(d["dashboard.liveLedgerTiles.ghostAwaiting"], loc).not.toContain("{ref}");
      expect(d["dashboard.netSavingsCIBand.captionSdkPendiente"], loc).toBeUndefined();
    });
  }
  it("en/es: «synthetic» / «sintética» y «not a promise» / «no son una promesa»", () => {
    expect(cargar("en")["dashboard.referenceModeBadge.sdkPendiente"]).toMatch(/^Synthetic run/);
    expect(cargar("en")["dashboard.referenceModeBadge.sdkPendiente"]).toMatch(/not a promise/);
    expect(cargar("es")["dashboard.referenceModeBadge.sdkPendiente"]).toMatch(/^Tirada sintética/);
    expect(cargar("es")["dashboard.referenceModeBadge.sdkPendiente"]).toMatch(/no son una promesa/);
  });
});

describe("la calculadora de comisión, retirada: ni componente ni claves", () => {
  for (const loc of LOCALES) {
    it(`${loc}: sin landing.calculadora ni landing.formula`, () => {
      const d = crudo(loc) as { landing: Record<string, unknown> };
      expect(d.landing.calculadora).toBeUndefined();
      expect(d.landing.formula).toBeUndefined();
    });
  }
});

describe("Gemini: compatible ≠ medido", () => {
  for (const loc of LOCALES) {
    it(`${loc}: la nota de compatibilidad nombra el adaptador nativo de Gemini con su versión`, () => {
      const nota = cargar(loc)["landing.hero.compatibleNota"]!;
      expect(nota).toContain("Gemini");
      expect(nota).toContain("{gemini}");
      expect(nota).toContain("OpenAI");
      expect(nota).toContain("Anthropic");
    });
  }
  it("en/es: lo dice con todas las letras", () => {
    expect(cargar("en")["landing.hero.compatibleNota"]).toMatch(/Compatible is not measured/);
    expect(cargar("en")["landing.hero.compatibleNota"]).toMatch(/Gemini has no measured saving yet/);
    expect(cargar("es")["landing.hero.compatibleNota"]).toMatch(/Compatible no es medido/);
    expect(cargar("es")["landing.hero.compatibleNota"]).toMatch(/Gemini aún no tiene ahorro medido/);
  });
  it("la versión del adaptador nativo es la 0.4.33 y la portada la pasa por parámetro", () => {
    expect(VERSION_GEMINI_NATIVO).toBe("0.4.33");
    expect(codigo("app/[locale]/page.tsx")).toContain('t("hero.compatibleNota", { gemini: VERSION_GEMINI_NATIVO })');
  });
});

describe("Medir: sus límites y su versión mínima, donde se ofrece", () => {
  it("las constantes públicas son las de la ingesta y las del protocolo", () => {
    expect(LIMITES_MEDIR.asientos).toBe(MEASURE_LIMITS.seats);
    expect(LIMITES_MEDIR.peticionesDiarias).toBe(MEASURE_LIMITS.dailyRequests);
    expect(VERSION_MINIMA_MEDIR).toBe("0.4.33");
  });

  const CLAVES = ["landing.pricing.plans.medir.body", "pricingPage.plans.medir.body", "auth.signupMedir"];
  for (const loc of LOCALES) {
    it(`${loc}: la tarjeta de la portada, /pricing y /signup llevan asientos, peticiones al día y versión mínima`, () => {
      const d = cargar(loc);
      for (const k of CLAVES) {
        const v = d[k];
        expect(v, `${loc} ${k}`).toBeTruthy();
        for (const p of ["{seats}", "{requests}", "{version}", "@bivelio/savings-layer"]) expect(v, `${loc} ${k}`).toContain(p);
        // Los números llegan por parámetro, nunca escritos a mano.
        expect(v, `${loc} ${k}`).not.toMatch(/[0-9]/);
      }
      expect(d["landing.footer.ctaSub"], loc).toContain("{version}");
    });
  }

  it("las páginas pasan las constantes, no números escritos a mano", () => {
    for (const rel of ["app/[locale]/page.tsx", "app/[locale]/pricing/page.tsx", "app/[locale]/signup/page.tsx"]) {
      const src = codigo(rel);
      expect(src, rel).toContain("LIMITES_MEDIR.asientos");
      expect(src, rel).toContain("LIMITES_MEDIR.peticionesDiarias");
      expect(src, rel).toContain("VERSION_MINIMA_MEDIR");
    }
    expect(codigo("app/components/Footer.tsx")).toContain('t("footer.ctaSub", { version: VERSION_MINIMA_MEDIR })');
  });
});

describe("los textos nuevos se formatean en los 12 idiomas (ICU sin errores)", () => {
  const PARAMS: Record<string, Record<string, string | number>> = {
    "landing.enVivo.titulo": { fecha: "2026-09-28" },
    "landing.enVivo.conRepeticiones": { bajo: "25,7 %", alto: "36,7 %", rep: "30 %", bateria: "GSM8K", version: "0.4.31" },
    "landing.enVivo.sinRepeticiones": {},
    "landing.enVivo.anthropic": { bajo: "69,3 %", alto: "79,6 %", prefijo: "41 %" },
    "landing.step2.plain": { rep: "30 %", punto: "31,5 %", bajo: "25,7 %", alto: "36,7 %", cero: "0 %" },
    "landing.trabajos.caption": { cero: "0 %" },
    "landing.ledgersHead.providerNote": { fecha: "2026-09-28" },
    "landing.hero.compatibleNota": { gemini: "0.4.33" },
    "landing.pricing.plans.medir.body": { seats: 5, requests: "20.000", version: "0.4.33" },
    "landing.footer.ctaSub": { version: "0.4.33" },
    "howItWorks.billWith": {},
    "howItWorks.billDepends": {},
    "auth.signupMedir": { seats: 5, requests: "20.000", version: "0.4.33" },
  };
  for (const loc of LOCALES) {
    it(`${loc}`, () => {
      const t = createTranslator({
        locale: loc,
        messages: crudo(loc) as never,
        onError: (e) => {
          throw e;
        },
      });
      for (const [k, p] of Object.entries(PARAMS)) {
        const out = (t as unknown as (k: string, p: object) => string)(k, p);
        for (const v of Object.values(p)) expect(out, `${loc} ${k}`).toContain(String(v));
      }
      const pie = (t as unknown as { rich: (k: string, p: object) => unknown }).rich("landing.enVivo.pie", {
        bench: (c: unknown) => c,
      });
      expect(pie).toBeTruthy();
      const medir = (t as unknown as { rich: (k: string, p: object) => unknown }).rich("pricingPage.plans.medir.body", {
        b: (c: unknown) => c,
        seats: 5,
        requests: "20.000",
        version: "0.4.33",
      });
      expect(JSON.stringify(medir)).toContain("0.4.33");
    });
  }
});
