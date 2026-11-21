import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { createTranslator, type AbstractIntlMessages } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { extractoEnSombra } from "@/lib/billing/extracto-sombra";
import { tuvoComisionEnElPeriodo } from "@/lib/billing/plan-de-la-org";

import { comisionLlegaA, desdeDeLaTarjeta, regimenSinPlanVivo } from "./comision-del-panel";
import { ExtractoVista } from "./components/ExtractoVista";
import { MedirSavingsCard } from "./components/MedirSavingsCard";
import type { UsageRollup } from "./data";

/**
 * EL PANEL NO DICE «NUNCA SE FACTURA» SOBRE UN MES QUE SÍ SE FACTURA.
 *
 * Casos de la verificación de la 1.2.4 (21-11-2026):
 *   · 07 — comisión cancelada a mitad de mes y vuelta a Measure: el día 1 le
 *     llegan 237,30 €; el panel le decía «Measure: real savings, never billed»
 *     y «Measure never bills any of it».
 *   · 20 — ex-comisión (acabó en septiembre) que pasa por Pro y cancela: con la
 *     tercera verja ya no se le factura nada, y el panel puede decir Measure.
 *   · 08 — ex-comisión en Measure todo el mes: 0 €, Measure.
 * El criterio del panel es la MISMA función que la tercera verja de la
 * facturación: lo que el panel dice y lo que se factura no pueden separarse.
 */

const est = vi.hoisted(() => ({
  locale: "en",
  messages: {} as Record<string, unknown>,
  monthly: "price_comision_antiguo",
  yearly: "price_comision_antiguo_y",
}));
const lanzar = (error: Error) => {
  throw error;
};
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: est.locale,
      messages: est.messages as AbstractIntlMessages,
      namespace: namespace as never,
      onError: lanzar,
    }),
  getLocale: async () => est.locale,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) =>
    createElement("a", { href, className }, children),
}));
vi.mock("@/lib/stripe/env", () => ({
  get STRIPE_PRICE_ID_MONTHLY() {
    return est.monthly;
  },
  get STRIPE_PRICE_ID_YEARLY() {
    return est.yearly;
  },
}));

const LOCALES = ["en", "es", "ca", "de", "fr", "it", "pt", "nl", "pl", "tr", "id", "vi"] as const;
const mensajes = (locale: string) =>
  JSON.parse(readFileSync(new URL(`../../../messages/${locale}.json`, import.meta.url), "utf8")) as Record<string, any>;

const ORG = "77777777-7777-4777-8777-777777777777";
const NOVIEMBRE = Date.parse("2026-11-01T00:00:00Z");
type Sub = { price_id: string | null; current_period_end: string | null };

/** Un cliente de solo lectura con las suscripciones de una org (o un error). */
function lector(subs: Sub[] | { error: string }) {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve(Array.isArray(subs) ? { data: subs, error: null } : { data: null, error: { message: subs.error } }).then(ok, ko),
  };
  return { schema: () => ({ from: () => q }) } as never;
}

const CASOS: Record<string, { subs: Sub[]; seFactura: boolean }> = {
  "07_comision_cancelada_a_mitad": {
    subs: [{ price_id: "price_comision_antiguo", current_period_end: "2026-11-12T10:00:00Z" }],
    seFactura: true,
  },
  "20_ex_comision_pro_cancelado": {
    subs: [
      { price_id: "price_comision_antiguo", current_period_end: "2026-09-01T00:00:00Z" },
      { price_id: "price_pro_m", current_period_end: "2026-11-12T10:00:00Z" },
    ],
    seFactura: false,
  },
  "08_ex_comision_en_measure": {
    subs: [{ price_id: "price_comision_antiguo", current_period_end: "2026-10-01T00:00:00Z" }],
    seFactura: false,
  },
  "01_measure_pura": { subs: [], seFactura: false },
  "ex_pro_en_measure": { subs: [{ price_id: "price_pro_m", current_period_end: "2026-11-20T00:00:00Z" }], seFactura: false },
  "comision_anual_cancelada": { subs: [{ price_id: "price_comision_antiguo_y", current_period_end: "2027-02-01T00:00:00Z" }], seFactura: true },
};

beforeEach(() => {
  est.monthly = "price_comision_antiguo";
  est.yearly = "price_comision_antiguo_y";
  vi.stubEnv("STRIPE_PRICE_IDS_EXTRA", "");
});

describe("comisionLlegaA · el panel decide con la regla de la facturación", () => {
  it.each(Object.entries(CASOS))("%s: el panel dice comisión exactamente cuando la tercera verja factura", async (_n, c) => {
    const panel = await comisionLlegaA(lector(c.subs), ORG, NOVIEMBRE);
    expect(panel).toBe(c.seFactura);
    expect(panel).toBe(tuvoComisionEnElPeriodo(c.subs, ["price_comision_antiguo", "price_comision_antiguo_y"], "2026-11"));
  });

  it("una lectura que falla es «no sé» (null), nunca «no hay comisión»", async () => {
    expect(await comisionLlegaA(lector({ error: "boom" }), ORG, NOVIEMBRE)).toBeNull();
  });

  it("un despliegue sin precios de comisión no factura comisión: el panel tampoco la anuncia", async () => {
    est.monthly = "";
    est.yearly = "";
    expect(await comisionLlegaA(lector(CASOS["07_comision_cancelada_a_mitad"]!.subs), ORG, NOVIEMBRE)).toBe(false);
  });
});

describe("regimenSinPlanVivo · el régimen del extracto", () => {
  it("07 · comisión cancelada a mitad de mes, ya en Measure: «legado-fin», nunca «medir»", () => {
    expect(regimenSinPlanVivo("ninguno", true, true)).toBe("legado-fin");
    expect(regimenSinPlanVivo("ninguno", true, false)).toBe("legado-fin");
  });
  it("08 y 20 · sin comisión que llegue al mes: Measure si solo tiene Measure; si no, el aviso neutro", () => {
    expect(regimenSinPlanVivo("ninguno", false, true)).toBe("medir");
    expect(regimenSinPlanVivo("ninguno", false, false)).toBe("ninguno");
  });
  it("sin poder leerlo: «indeterminado», ni «never billed» ni una comisión supuesta", () => {
    expect(regimenSinPlanVivo("ninguno", null, true)).toBe("indeterminado");
  });
  it("con un plan vivo, la base manda (no se toca)", () => {
    for (const r of ["fija", "exenta", "legado", "indeterminado"] as const) expect(regimenSinPlanVivo(r, true, true)).toBe(r);
  });
});

describe("desdeDeLaTarjeta", () => {
  it("el primer día que pinta la tarjeta, o el inicio del mes si es anterior", () => {
    const ahora = new Date("2026-11-21T12:00:00Z");
    expect(desdeDeLaTarjeta([], ahora)).toBe(NOVIEMBRE);
    expect(desdeDeLaTarjeta([{ day: "2026-11-10" }], ahora)).toBe(NOVIEMBRE);
    expect(desdeDeLaTarjeta([{ day: "2026-08-20" }, { day: "2026-11-10" }], ahora)).toBe(Date.parse("2026-08-20T00:00:00Z"));
  });
});

function fila(day: string): UsageRollup {
  return {
    day,
    requests: 200,
    avoidedLlm: 10,
    actualLlm: 190,
    eliminatedInputTokens: 0,
    compressedInputTokens: 0,
    providerCachedInputTokens: 0,
    baselineCost: 900,
    actualCost: 300,
    measuredRequests: 190,
    measuredBaselineCost: 800,
    measuredActualCost: 300,
    actualInputTokens: 20_000,
  };
}
const USO = ["2026-10-20", "2026-11-03", "2026-11-10"].map(fila);

describe("la tarjeta de Measure no dice «never bills» a quien este mes paga comisión", () => {
  it.each(LOCALES)("%s · sin comisión: la frase de Measure; con comisión o sin saberlo: la que separa las dos cosas", async (loc) => {
    est.locale = loc;
    est.messages = mensajes(loc);
    const card = mensajes(loc)["dashboard"]["measurePlan"]["card"];
    const pinta = async (conComision: boolean | null) => renderToString(await MedirSavingsCard({ usage: USO, conComision }));
    const sinComision = await pinta(false);
    const conComision = await pinta(true);
    const sinSaber = await pinta(null);
    const ultima = (s: string) => s.split(/[.;。]\s*/).filter(Boolean).pop()!.replace(/'/g, "&#x27;");
    expect(sinComision).toContain(ultima(card.realContext));
    for (const html of [conComision, sinSaber]) {
      expect(html).not.toContain(ultima(card.realContext));
      expect(html).toContain(ultima(card.realContextComision));
    }
  });

  it("en · el texto, tal cual", async () => {
    est.locale = "en";
    est.messages = mensajes("en");
    const html = renderToString(await MedirSavingsCard({ usage: USO, conComision: true }));
    expect(html).not.toContain("Measure never bills any of it");
    expect(html).toContain("Measure never bills its own savings");
    expect(html).toContain("part of its commission, invoiced on the first of the following month");
  });
});

describe("el extracto de una comisión cancelada a mitad de mes", () => {
  const pinta = async (regimen: "legado-fin" | "medir") => {
    const e = extractoEnSombra("panel", USO, "2026-11", regimen === "medir");
    return renderToString(
      await ExtractoVista({ e, periodo: "2026-11", regimen, usageFailed: false, cerrados: [], diasDeDescarga: null }),
    );
  };

  it.each(LOCALES)("%s · «legado-fin» enseña la comisión de este mes y no dice «nunca se factura»", async (loc) => {
    est.locale = loc;
    est.messages = mensajes(loc);
    const ex = mensajes(loc)["dashboard"]["extracto"];
    const esc = (s: string) => s.replace(/'/g, "&#x27;");
    const html = await pinta("legado-fin");
    expect(html).toContain(esc(ex.regimenLegadoTitulo));
    expect(html).toContain(esc(ex.regimenLegadoFinBody));
    expect(html).toContain(esc(ex.simulacionAplica));
    expect(html).not.toContain(esc(ex.regimenMedirTitulo));
    expect(html).not.toContain(esc(ex.regimenMedirBody));
    expect(html).not.toContain(esc(ex.simulacionMedir));
    // Y la prueba muerde: el régimen de Measure SÍ dice «never billed».
    const medir = await pinta("medir");
    expect(medir).toContain(esc(ex.regimenMedirTitulo));
  });

  it("en · la simulación de «legado-fin» lleva cargo (no la de una cuenta exenta)", async () => {
    est.locale = "en";
    est.messages = mensajes("en");
    const e = extractoEnSombra("panel", USO, "2026-11", false);
    expect(e.cargoEur).toBeGreaterThan(0);
    const html = await pinta("legado-fin");
    expect(html).toContain("Your commission subscription is no longer active, but this month still closes under it");
    expect(html).not.toContain("never billed");
  });
});
