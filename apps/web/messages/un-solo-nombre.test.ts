import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * m28 · UN SOLO NOMBRE PARA CADA COSA, EN LOS 12 IDIOMAS.
 *
 * En una misma página convivían «BV-SALA», «Savings Layer», «BiVelio Savings
 * Layer», «BiVelio Savings», «Savings» a secas y «Savings Cloud», y el pie
 * abría con el lema corporativo de BiVelio. Quien llega desde Product Hunt no
 * sabía si eran lo mismo. La regla (2026-11-21):
 *   · el producto es «BiVelio Savings Layer» («Savings Layer» como forma corta);
 *   · lo que se paga es «Savings Cloud» (la cuenta, el panel, los planes);
 *   · «BV-SALA» queda para el paper, el paquete y el chip del algoritmo del pie
 *     (`landing.footer.badge`, convención de todos los pies BV-*).
 * El logo («Savings by BiVelio») es la marca dibujada y no es un texto de aquí.
 */

const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"] as const;

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
const cargar = (loc: string): Plano => aplanar(JSON.parse(readFileSync(new URL(`./${loc}.json`, import.meta.url), "utf8")));

/**
 * Donde «BV-SALA» puede seguir. Las tres últimas son textos que reescribe o
 * revisa otro trabajo (las cachés compartidas y el plan; Claude y el skill; el
 * aviso de licencia caducada, que reescribe fix/web-textos-auditoria-medios) y
 * no se tocan desde aquí: cuando dejen de decir «BV-SALA», salen de la lista.
 */
const BV_SALA_PERMITIDO = new Set([
  "landing.footer.badge",
  // Clave sin uso en el código (la tarjeta de Pro ya no la pinta).
  "landing.pricing.features.0",
  "dashboard.accountPlanStrip.planBody",
  "dashboard.projectorVerifier.onlyChatBody",
  "dashboard.billingState.expiredBody",
]);

/** Textos donde «Savings» a secas nombraba el producto o el panel. */
const ANTES_SAVINGS_A_SECAS = [
  "auth.successBody",
  "app.tour.steps.welcome.title",
  "dashboard.proof.diagramB",
  "dashboard.yourBench.readout.armB",
  "landing.ways.title",
  "landing.ways.cloud.account",
  "landing.step2.body",
  "landing.step2.videoCaption",
  "landing.faq.items.1.a",
  "invitacion.arteAlt",
  "howItWorks.metaDescription",
  "howItWorks.beam.lede",
  "howItWorks.pieces.title",
  "howItWorks.pieces.tablist",
];
/** «Savings» que no va seguido de Layer, Cloud ni Report (ni pegado a otra palabra). */
const SAVINGS_A_SECAS = /(?<![\w-])Savings(?![\w-])(?! (?:Layer|Cloud|Report))|Savings-(?!Cloud-)/;

describe("m28 · un solo nombre", () => {
  for (const loc of LOCALES) {
    describe(loc, () => {
      const d = cargar(loc);

      it("«BV-SALA» no nombra el producto fuera del chip del pie", () => {
        const fuera = Object.entries(d)
          .filter(([k, v]) => /BV[-‑]SALA/.test(v) && !BV_SALA_PERMITIDO.has(k))
          .map(([k]) => k);
        expect(fuera).toEqual([]);
      });

      it("ni «BiVelio Savings» suelto ni «Savings» a secas donde se nombraba el producto o el panel", () => {
        for (const [k, v] of Object.entries(d)) expect(v, `${loc} ${k}`).not.toMatch(/BiVelio Savings(?! (?:Layer|Cloud))/);
        for (const k of ANTES_SAVINGS_A_SECAS) {
          expect(d[k], `${loc} ${k}`).toBeTruthy();
          expect(d[k], `${loc} ${k}`).not.toMatch(SAVINGS_A_SECAS);
        }
      });

      it("el pie presenta el producto por su nombre, sin el lema corporativo", () => {
        const frase = d["landing.footer.tagline"]!;
        expect(frase).toContain("<b>BiVelio Savings Layer</b>");
        expect(frase).not.toMatch(/BV[-‑]SALA/);
        // El lema era la primera frase, delante del nombre: ahora el nombre abre.
        expect(frase.indexOf("<b>BiVelio Savings Layer</b>")).toBeLessThanOrEqual("O ".length);
      });
    });
  }

  it("en: el lema corporativo ya no está en el pie", () => {
    expect(cargar("en")["landing.footer.tagline"]).not.toMatch(/operating system/i);
  });
});
