import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LA PORTADA DICE LO MISMO QUE /pricing — Y LO MISMO QUE COBRA EL CÓDIGO.
 *
 * `/pricing` es la «Published Pricing» de la LICENSE §6 y manda al lector a la
 * calculadora de la portada (`/#pricing`). Si la tarjeta de precios de esa
 * portada dice otra cosa, el cliente lee dos tarifas en el mismo dominio y la
 * que le vende es la que promete más. Pasó (2026-09-26, dos revisores):
 *
 *   · `landing.pricing.seatNote` decía «billed only if active on 3+ days in a
 *     month». El código cobra los asientos de la suscripción (la `quantity`
 *     de Stripe); los días activos (`bvsala.billable_seats`) solo cuentan
 *     cuántos hubo en uso y el panel lo compara — /api/billing/reconcile no
 *     cobra. Y el 3 estaba escrito a mano.
 *   · `landing.formula.mes1` y la nota de la calculadora prometían «your first
 *     month» sin comisión. cierre.ts calibra el primer MES NATURAL (UTC) CON
 *     USO, aunque quede un día de él: quien empieza el 30 tiene dos días.
 *     (Esas dos claves se borraron el 2026-09-29 con la calculadora, que ya no
 *     se renderizaba; la regla sigue atada en /pricing.)
 *
 * Aquí se ata el texto de los doce idiomas a esas dos reglas del código.
 */

const DIR = new URL(".", import.meta.url).pathname;
const LOCALES = ["es", "en", "ca", "de", "fr", "it", "nl", "pl", "pt", "tr", "id", "vi"] as const;

/**
 * Cómo dice cada idioma «mes natural». Es la palabra que ya usa
 * `pricingPage.calibration.body` (la definición que copia la LICENSE §6), y la
 * portada tiene que usar la misma: «primer mes» a secas es un mes desde el
 * alta, y eso no es lo que calcula cierre.ts.
 */
const MES_NATURAL: Record<(typeof LOCALES)[number], string> = {
  es: "mes natural",
  en: "calendar month",
  ca: "mes natural",
  de: "Kalendermonat",
  fr: "mois civil",
  it: "mese solare",
  nl: "kalendermaand",
  pl: "kalendarzow",
  pt: "mês civil",
  tr: "takvim",
  id: "bulan kalender",
  vi: "dương lịch",
};

type Catalogo = Record<string, unknown>;
const cargar = (loc: string): Catalogo => JSON.parse(readFileSync(join(DIR, `${loc}.json`), "utf8")) as Catalogo;
const clave = (c: Catalogo, ruta: string): string => {
  const v = ruta.split(".").reduce<unknown>((o, k) => (o as Catalogo | undefined)?.[k], c);
  if (typeof v !== "string") throw new Error(`falta ${ruta}`);
  return v;
};
const leerApp = (ruta: string) => readFileSync(join(DIR, "..", ruta), "utf8");

describe("⛔ el asiento de la portada es el que cobra el código", () => {
  it("la portada pasa los días activos desde la constante espejo del SQL, no escritos a mano", () => {
    const pagina = leerApp("app/[locale]/page.tsx");
    expect(pagina).toContain('t.rich("pricing.seatNote", { b: (c) => <b>{c}</b>, dias: DIAS_ACTIVOS_PARA_CONTAR_ASIENTO })');
    expect(pagina).toContain('import { DIAS_ACTIVOS_PARA_CONTAR_ASIENTO } from "@/lib/billing/asientos";');
  });

  for (const loc of LOCALES) {
    it(`${loc}: seatNote lleva {dias} por parámetro (y ni un dígito: tarifa-en-parametros)`, () => {
      const nota = clave(cargar(loc), "landing.pricing.seatNote");
      expect(nota).toContain("{dias}");
      expect(nota).not.toMatch(/[0-9]/);
    });
  }

  it("en: no vuelve a prometer que solo se cobra el asiento activo", () => {
    const nota = clave(cargar("en"), "landing.pricing.seatNote");
    expect(nota).not.toMatch(/billed only|only if active|charged only/i);
    expect(nota).toMatch(/seats your subscription covers/);
  });
});

describe("⛔ la calibración de la portada es la de cierre.ts: el primer mes natural (UTC) con uso", () => {
  it("cierre.ts sigue calibrando por el primer período (mes natural) con uso", () => {
    // Si esto cambia (p. ej. a «30 días desde el alta»), cambian los textos de
    // abajo, /pricing y la LICENSE §6 — no solo el código.
    const cierre = leerApp("lib/billing/cierre.ts");
    expect(cierre).toContain("esCalibracion: org.primerPeriodoConUso >= periodo");
  });

  for (const loc of LOCALES) {
    it(`${loc}: /pricing dice «${MES_NATURAL[loc]}»`, () => {
      const c = cargar(loc);
      for (const ruta of [
        "pricingPage.calibration.body",
        "pricingPage.statement.body",
      ]) {
        expect(clave(c, ruta).toLowerCase(), `${loc} ${ruta}`).toContain(MES_NATURAL[loc].toLowerCase());
      }
    });
  }

  it("en: el mes natural es el de la COMISIÓN, no el ciclo del asiento", () => {
    const en = cargar("en");
    expect(clave(en, "pricingPage.statement.body")).toMatch(/^The commission is calculated per calendar month \(UTC\)\./);
    expect(clave(en, "pricingPage.statement.body")).not.toMatch(/billing periods? (is|are) calendar months?/i);
    expect(clave(en, "pricingPage.seat.cycle")).toMatch(/monthly or yearly cycle of your subscription/);
  });
});
