import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { HORAS_SIN_RESPUESTA_CON_CLAVE } from "@/lib/license/medir-publico";

/**
 * LA WEB DICE LO MISMO QUE EL PAQUETE 1.2.4 (verificación del 21-11-2026,
 * antes de Product Hunt). Cada caso es una frase de la web que contradecía o
 * callaba algo que el README y el CHANGELOG de la 1.2.4 dicen:
 *   · lo que ata una clave, también la gratuita de Measure: con
 *     `licenseServerUrl`, {horas} sin respuesta de savings.bivelio.com y la capa
 *     falla cerrada con `LicenseError`. La nota final del panel ya lo dice
 *     (cifras-alineadas.test.ts); la FAQ y /pricing no lo decían;
 *   · lo que va encendido por defecto son seis palancas, también la
 *     serialización compacta; el panel nombraba cinco;
 *   · en el gateway una licencia de pago funciona como en la 1.2.3: cada palanca
 *     necesita además la licencia de la organización, comprobada fail-closed;
 *   · las palancas no se activan en Cuenta: la sombra viene de máquinas que solo
 *     observan, y se ahorra actualizándolas o apagando solo-observar;
 *   · la elisión de contexto del gateway se enciende con su variable, no «cuando
 *     la cifra lo justifique»;
 *   · la nube es gratis con Measure y cuota fija con Pro y Team.
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
const RAIZ = new URL("../../../", import.meta.url);
const delRepo = (rel: string) => readFileSync(fileURLToPath(new URL(rel, RAIZ)), "utf8");

/** La serialización compacta, como la nombra cada idioma en la tarjeta de open core. */
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

describe("lo que ata una clave: las horas sin respuesta son las del paquete", () => {
  it("HORAS_SIN_RESPUESTA_CON_CLAVE es DEFAULT_MAX_STALENESS_SECONDS del SDK, y el README dice esas horas", () => {
    const m = delRepo("src/pipeline/create.ts").match(/DEFAULT_MAX_STALENESS_SECONDS\s*=\s*(\d+)\s*\*\s*3600\b/);
    expect(m, "src/pipeline/create.ts ya no define DEFAULT_MAX_STALENESS_SECONDS como horas × 3600").not.toBeNull();
    expect(Number(m![1])).toBe(HORAS_SIN_RESPUESTA_CON_CLAVE);
    expect(delRepo("README.md")).toContain(`${HORAS_SIN_RESPUESTA_CON_CLAVE} hours without an answer from savings.bivelio.com`);
  });

  for (const loc of LOCALES) {
    it(`${loc}: la nota final del panel y /pricing dicen las horas y LicenseError; /pricing y la FAQ, savings.bivelio.com`, () => {
      const d = cargar(loc);
      const t = createTranslator({ locale: loc, messages: crudo(loc), onError: (e) => { throw e; } });
      const fmt = t as unknown as (k: string, p: object) => string;
      // La nota final del panel lleva las horas escritas (cifras-alineadas.test.ts);
      // /pricing no lleva dígitos y las recibe por parámetro.
      expect(d["dashboard.installLicensePanel.finalNote"], loc).toContain(`${HORAS_SIN_RESPUESTA_CON_CLAVE}`);
      expect(d["dashboard.installLicensePanel.finalNote"], loc).toContain("<code>LicenseError</code>");
      const k = "pricingPage.modes.cloud.body";
      expect(d[k], `${loc} ${k}`).toContain("{horas}");
      expect(d[k], `${loc} ${k}`).toContain("savings.bivelio.com");
      expect(d[k], `${loc} ${k}`).toContain("LicenseError");
      expect(fmt("pricingPage.modes.cloud.body", { horas: HORAS_SIN_RESPUESTA_CON_CLAVE })).toContain(String(HORAS_SIN_RESPUESTA_CON_CLAVE));
      // La FAQ se pinta con t.raw y no lleva dígitos: dice lo mismo en palabras.
      expect(d["landing.faq.items.2.a"], loc).toContain("savings.bivelio.com");
      // El gateway con clave de servicio necesita el servidor para arrancar
      // (SECURITY.md, Availability); en marcha no tiene límite de horas.
      expect(d["dashboard.installLicensePanel.gatewayNote"], loc).toContain("savings.bivelio.com");
    });
  }

  it("en: el gateway con clave necesita savings.bivelio.com para arrancar, y en marcha sigue sin él", () => {
    expect(cargar("en")["dashboard.installLicensePanel.gatewayNote"]).toContain(
      "With that key the gateway needs savings.bivelio.com to start; once running, it keeps serving without it.",
    );
  });

  it("en/es: el panel ya no promete que nunca deja de servir si no respondemos", () => {
    const en = cargar("en")["dashboard.installLicensePanel.finalNote"]!;
    const es = cargar("es")["dashboard.installLicensePanel.finalNote"]!;
    expect(en).not.toMatch(/never bricks/i);
    expect(es).not.toMatch(/nunca inutiliza/i);
    expect(en).toContain(`after ${HORAS_SIN_RESPUESTA_CON_CLAVE} hours without an answer every call fails with <code>LicenseError</code>`);
    expect(cargar("en")["landing.faq.items.2.a"]).toContain("three days without an answer from savings.bivelio.com");
    expect(cargar("es")["landing.faq.items.2.a"]).toContain("tres días sin respuesta de savings.bivelio.com");
  });
});

describe("lo que va encendido por defecto: las seis del README, también en el panel", () => {
  for (const loc of LOCALES) {
    it(`${loc}: el paso 1 y el modo local nombran la serialización compacta`, () => {
      const d = cargar(loc);
      for (const k of ["dashboard.installLicensePanel.step1", "dashboard.installLicensePanel.modeLocalBody", "landing.explica.pasos.3.body"]) {
        expect(d[k], `${loc} ${k}`).toMatch(SERIALIZACION[loc]);
      }
    });
  }
});

describe("planes: Measure gratis, Pro y Team cuota fija, y el gateway de pago como en la 1.2.3", () => {
  for (const loc of LOCALES) {
    it(`${loc}: Pro en /pricing dice que en el gateway cada palanca se comprueba fail-closed`, () => {
      expect(cargar(loc)["pricingPage.plans.pro.body"]).toContain("fail-closed");
    });
    it(`${loc}: la tarjeta de open core dice que la nube es gratis con Measure`, () => {
      expect(cargar(loc)["landing.explica.pasos.3.body"]).toContain("Measure");
    });
  }
  it("en: la nube no es «una cuota fija por asiento» a secas", () => {
    expect(cargar("en")["landing.explica.pasos.3.body"]).toContain("free on Measure, and on Pro and Team a fixed fee, whether or not you save, with no commission on your savings.");
  });
});

describe("el panel no dice que las palancas se activan en Cuenta ni que la elisión se enciende sola", () => {
  for (const loc of LOCALES) {
    it(`${loc}: oportunidades en sombra sin jerga interna`, () => {
      expect(cargar(loc)["dashboard.shadowOpportunities.action"]).not.toMatch(/server-first|servidor-primer|\bwire\b/i);
    });
  }
  it("en/es: lo que hay que hacer es actualizar o apagar solo-observar; ningún plan", () => {
    const en = cargar("en");
    const es = cargar("es");
    expect(en["dashboard.shadowOpportunities.action"]).not.toMatch(/Account to activate/);
    expect(en["dashboard.shadowOpportunities.action"]).toContain("update those machines or turn observe-only off: the levers need no plan.");
    expect(es["dashboard.shadowOpportunities.action"]).not.toMatch(/Cuenta para activar/);
    expect(en["dashboard.sombraElision.nota"]).not.toContain("only turns on when this figure justifies it");
    expect(en["dashboard.sombraElision.nota"]).toContain("the lever stays off unless you switch it on with its own variable");
    expect(en["dashboard.extracto.sombraElisionNegativa"]).not.toContain("only what truly saves gets turned on");
  });
});
