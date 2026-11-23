import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { DIAS_DE_DEVOLUCION_PRIMERA_COMPRA_MENSUAL } from "@/lib/billing/planes";

/**
 * /pricing DICE LO QUE SE VENDE (auditoría de alineación, 21-11-2026):
 *   · LA DEVOLUCIÓN. El dueño decidió 14 días en la primera compra mensual (la
 *     respuesta 18 de Product Hunt ya lo dice) y la web no lo decía. Va en las
 *     condiciones de Pro (Team es «lo mismo que Pro») y la cifra llega por
 *     parámetro desde DIAS_DE_DEVOLUCION_PRIMERA_COMPRA_MENSUAL: los mensajes de
 *     pricingPage no llevan dígitos (tarifa-en-parametros.test.ts).
 *   · TEAM NO SE COBRA «POR ASIENTO». Pro es por asiento; Team es una cuota fija
 *     con asientos incluidos y cada asiento extra aparte (PRECIOS_DE_LOS_PLANES).
 *     Cinco frases decían «Pro y Team se facturan por asiento».
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
const publicas = (d: Plano) => Object.entries(d).filter(([k]) => !k.startsWith("dashboard."));
const codigo = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

/** «Pro y Team … por asiento» en una misma frase, en cada idioma: lo que ya no se dice. */
const PRO_Y_TEAM_POR_ASIENTO: Record<Loc, RegExp> = {
  ca: /Pro i Team[^.]*per seient/,
  de: /Pro und Team[^.]*pro Seat/,
  en: /Pro and Team[^.]*per seat|plans billed per seat|is billed per seat with no commission/,
  es: /Pro y Team[^.]*por asiento/,
  fr: /Pro et Team[^.]*par siège/,
  id: /Pro dan Team[^.]*per kursi/,
  it: /Pro e Team[^.]*per postazione/,
  nl: /Pro en Team[^.]*per seat/,
  pl: /Pro i Team[^.]*za stanowisko/,
  pt: /Pro e (o )?Team[^.]*por (lugar|assento)/,
  tr: /Pro ve Team[^.]*koltuk başına/,
  vi: /Pro và Team[^.]*theo (chỗ|ghế)/,
};

describe("la devolución de la primera compra mensual, en las condiciones de Pro", () => {
  it("son 14 días y /pricing los pasa por parámetro, con el correo de soporte", () => {
    expect(DIAS_DE_DEVOLUCION_PRIMERA_COMPRA_MENSUAL).toBe(14);
    const src = codigo("app/[locale]/pricing/page.tsx");
    expect(src).toMatch(/t\.rich\("plans\.pro\.refund", \{[^}]*days: DIAS_DE_DEVOLUCION_PRIMERA_COMPRA_MENSUAL,/);
    expect(src.indexOf('"plans.pro.refund"')).toBeGreaterThan(src.indexOf('"plans.pro.body"'));
    expect(src.indexOf('"plans.pro.refund"')).toBeLessThan(src.indexOf('"plans.team.amount"'));
  });

  for (const loc of LOCALES) {
    it(`${loc}: el texto existe, no lleva dígitos y se formatea con los días`, () => {
      const v = cargar(loc)["pricingPage.plans.pro.refund"];
      expect(v, loc).toBeTruthy();
      expect(v, loc).toContain("{days}");
      expect(v, loc).toContain("<contact>");
      expect(v, loc).not.toMatch(/[0-9]/);
      const t = createTranslator({ locale: loc, messages: crudo(loc), onError: (e) => { throw e; } });
      const texto = (t as unknown as { markup: (k: string, p: object) => string }).markup("pricingPage.plans.pro.refund", {
        days: DIAS_DE_DEVOLUCION_PRIMERA_COMPRA_MENSUAL,
        b: (c: string) => c,
        contact: (c: string) => c,
      });
      expect(texto, loc).toContain(String(DIAS_DE_DEVOLUCION_PRIMERA_COMPRA_MENSUAL));
    });
  }

  it("en/es: dice «primera compra mensual»", () => {
    expect(cargar("en")["pricingPage.plans.pro.refund"]).toContain("on a first monthly purchase you can ask for a refund within {days} days");
    expect(cargar("es")["pricingPage.plans.pro.refund"]).toContain("en la primera compra mensual puedes pedir la devolución en un plazo de {days} días");
  });
});

describe("Team es cuota fija con asientos incluidos, no «por asiento»", () => {
  for (const loc of LOCALES) {
    it(`${loc}: ningún texto público dice que Pro y Team se cobran por asiento`, () => {
      expect(publicas(cargar(loc)).filter(([, v]) => PRO_Y_TEAM_POR_ASIENTO[loc].test(v)).map(([k]) => k)).toEqual([]);
    });
  }

  it("en/es: /pricing y la portada separan Pro (por asiento) de Team (cuota fija con asientos incluidos)", () => {
    const en = cargar("en");
    const es = cargar("es");
    expect(en["pricingPage.plans.intro"]).toContain("Pro is paid per seat, Team as a flat fee with seats included plus each extra seat");
    expect(en["pricingPage.modes.cloud.body"]).toContain("Team as a flat fee with seats included");
    expect(en["landing.pricing.body"]).toContain("Pro is billed per seat and Team is a flat fee with seats included");
    expect(es["pricingPage.plans.intro"]).toContain("Pro se paga por asiento, Team con una cuota fija con asientos incluidos más cada asiento extra");
    expect(es["landing.faq.items.0.a"]).toContain("Pro, por asiento, y Team, con asientos incluidos y asientos extra aparte");
  });
});
