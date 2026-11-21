import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator, type AbstractIntlMessages } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { planDelDestino, type PlanDeAlta } from "@/app/components/acceso/plan-de-alta";
import type { TarifasDeLosPlanes } from "@/lib/stripe/pricing";
import { terminosDeLosPlanes } from "@/lib/legal/precios-publicados";
import { LIMITES_MEDIR } from "@/lib/license/medir-publico";

/**
 * m26 · EL ALTA DICE QUÉ PLAN SE ELIGIÓ Y CUÁNTO CUESTA.
 *
 * Quien pulsaba «Choose Pro» o «Choose Team» llegaba a /signup sin una palabra
 * sobre su plan, y con una nota que le ofrecía empezar gratis con Measure.
 * Ahora, si el `next` trae el plan (`/<idioma>/dashboard?plan=pro|equipo`), el
 * alta lo nombra con su precio —el MISMO que pinta /pricing, leído de sus
 * Prices de Stripe— y retira la nota de Measure. Sin plan, todo queda igual.
 *
 * Se renderiza la página de verdad, con los mensajes reales de los 12 idiomas.
 * Las tarifas que devuelve el lector de Stripe son a propósito DISTINTAS de las
 * de respaldo: si alguien escribiera el precio a mano, esto fallaría.
 */

const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"] as const;
const mensajesDe = (loc: string) =>
  JSON.parse(readFileSync(new URL(`../../../messages/${loc}.json`, import.meta.url), "utf8")) as AbstractIntlMessages & {
    auth: Record<string, string>;
    pricingPage: { plans: Record<string, { name: string }> };
  };

/** Lo que «lee Stripe» en este test: ni 15 € ni 129 €, para que no coincida con el respaldo. */
const TARIFAS: TarifasDeLosPlanes = {
  pro: {
    monthly: { fijaCentimos: 0, asientosIncluidos: 0, asientoCentimos: 1_700, currency: "eur" },
    yearly: { fijaCentimos: 0, asientosIncluidos: 0, asientoCentimos: 17_000, currency: "eur" },
  },
  equipo: {
    monthly: { fijaCentimos: 13_900, asientosIncluidos: 10, asientoCentimos: 1_300, currency: "eur" },
    yearly: { fijaCentimos: 139_000, asientosIncluidos: 10, asientoCentimos: 13_000, currency: "eur" },
  },
};

const estado = vi.hoisted(() => ({ locale: "en", messages: {} as Record<string, unknown>, plan: null as "pro" | "equipo" | null }));
const lanzar = (e: Error) => {
  throw e;
};

vi.mock("next-intl/server", () => ({
  getTranslations: async (ns: string | { namespace: string }) =>
    createTranslator({
      locale: estado.locale,
      messages: estado.messages as AbstractIntlMessages,
      namespace: (typeof ns === "string" ? ns : ns.namespace) as never,
      onError: lanzar,
    }),
  setRequestLocale: () => {},
}));
vi.mock("@/lib/stripe/pricing", () => ({ tarifasDeLosPlanes: async () => TARIFAS }));
// Lo que necesita el runtime de Next o un navegador: fuera.
vi.mock("@/i18n/navigation", () => ({ Link: ({ children }: { children: ReactNode }) => createElement("a", null, children) }));
vi.mock("@/app/components/AuthForm", () => ({ default: () => createElement("form") }));
vi.mock("@/app/components/acceso/PanelDeMarca", () => ({ PanelDeMarca: () => null }));
vi.mock("@/app/components/acceso/EnlaceConDestino", () => ({
  EnlaceConDestino: ({ children }: { children: ReactNode }) => createElement("a", null, children),
}));
vi.mock("@/app/components/acceso/AccesoShell", () => ({
  AccesoShell: ({ children }: { children: ReactNode }) => createElement("main", null, children),
}));
// El plan lo lee el navegador al montar (`window.location.search`); aquí se
// fija desde el test y se pintan las piezas de verdad con ese plan.
vi.mock("@/app/components/acceso/PlanElegidoEnAlta", async (original) => {
  const real = await original<typeof import("@/app/components/acceso/PlanElegidoEnAlta")>();
  return {
    ...real,
    PlanElegidoEnAlta: ({ textos }: { textos: Record<PlanDeAlta, string> }) => real.AvisoDelPlan({ plan: estado.plan, textos }),
    SoloSinPlanElegido: ({ children }: { children: ReactNode }) => real.SinPlan({ plan: estado.plan, children }),
  };
});

async function pintar(locale: string, plan: "pro" | "equipo" | null) {
  estado.locale = locale;
  estado.messages = mensajesDe(locale);
  estado.plan = plan;
  const { default: SignupPage } = await import("./page.js");
  return renderToStaticMarkup(await SignupPage({ params: Promise.resolve({ locale }) }));
}

/** El texto tal como lo escapa React en el HTML. */
const enHtml = (s: string) => renderToStaticMarkup(createElement("span", null, s)).slice("<span>".length, -"</span>".length);

/** La query que fabrica el enlace «Elegir …» de la portada y de /pricing. */
const consulta = (next: string) => `?${new URLSearchParams({ next })}`;

describe("m26 · el plan que trae el `next` del alta", () => {
  it("lee Pro y Team del destino que fijan la portada y /pricing", () => {
    expect(planDelDestino(consulta("/en/dashboard?plan=pro"))).toBe("pro");
    expect(planDelDestino(consulta("/de/dashboard?plan=equipo"))).toBe("equipo");
    expect(planDelDestino("?next=/es/dashboard?plan=equipo")).toBe("equipo");
    expect(planDelDestino(consulta("/en/dashboard/account?plan=pro"))).toBe("pro");
  });

  it("sin plan, con un plan que no se vende o con un destino ajeno, no hay plan", () => {
    for (const q of [
      "",
      "?plan=pro",
      consulta("/en/dashboard"),
      consulta("/en/dashboard?plan=comision"),
      consulta("/en/dashboard?plan=enterprise"),
      consulta("/en/dashboard?plan=PRO"),
      consulta("/es/invitacion/abc?plan=pro"),
      consulta("https://evil.example/dashboard?plan=pro"),
      consulta("//evil.example/dashboard?plan=pro"),
      consulta("/\\evil.example/dashboard?plan=pro"),
    ]) {
      expect(planDelDestino(q), q).toBeNull();
    }
  });
});

describe("m26 · /signup con y sin plan elegido, en los 12 idiomas", () => {
  for (const loc of LOCALES) {
    const m = mensajesDe(loc);
    const t = createTranslator({ locale: loc, messages: m, namespace: "auth", onError: lanzar });
    const planes = terminosDeLosPlanes(loc, TARIFAS);
    const nombres = { pro: m.pricingPage.plans.pro!.name, equipo: m.pricingPage.plans.team!.name };
    const medir = t("signupMedir", { seats: LIMITES_MEDIR.asientos, requests: LIMITES_MEDIR.peticionesDiarias.toLocaleString(loc) });
    const pro = t("signupPlanPro", { plan: nombres.pro, price: planes.pro.mensual });
    const team = t("signupPlanTeam", { plan: nombres.equipo, price: planes.equipo.mensual, seats: planes.equipo.incluidos });

    it(`${loc}: sin plan, la página de siempre — con Measure y sin línea de plan`, async () => {
      const html = await pintar(loc, null);
      expect(html).toContain(enHtml(medir));
      expect(html).not.toContain(enHtml(pro));
      expect(html).not.toContain(enHtml(team));
      expect(html).not.toContain("acc-plan-elegido");
    });

    it(`${loc}: con Pro, dice Pro y su precio de Stripe, y no ofrece Measure`, async () => {
      const html = await pintar(loc, "pro");
      expect(pro).toContain(planes.pro.mensual);
      expect(html).toContain(enHtml(pro));
      expect(html).not.toContain(enHtml(team));
      expect(html).not.toContain(enHtml(medir));
      expect(html).toMatch(/class="auth-msg info acc-plan-elegido" role="status"/);
    });

    it(`${loc}: con Team, dice Team, su cuota y los asientos incluidos, y no ofrece Measure`, async () => {
      const html = await pintar(loc, "equipo");
      expect(team).toContain(planes.equipo.mensual);
      expect(team).toContain(planes.equipo.incluidos);
      expect(html).toContain(enHtml(team));
      expect(html).not.toContain(enHtml(pro));
      expect(html).not.toContain(enHtml(medir));
    });

    it(`${loc}: las frases del plan llevan sus variables y ninguna cifra escrita a mano`, () => {
      const a = m.auth;
      for (const p of ["{plan}", "{price}"]) {
        expect(a.signupPlanPro, `${loc} signupPlanPro`).toContain(p);
        expect(a.signupPlanTeam, `${loc} signupPlanTeam`).toContain(p);
      }
      expect(a.signupPlanTeam, `${loc} signupPlanTeam`).toContain("{seats}");
      expect(a.signupPlanPro).not.toMatch(/[0-9€$]/);
      expect(a.signupPlanTeam).not.toMatch(/[0-9€$]/);
    });
  }

  it("el precio sale de donde lo lee /pricing, no de una cifra en la página", () => {
    const leer = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
    const alta = leer("./page.tsx");
    const precios = leer("../pricing/page.tsx");
    const lectura = "terminosDeLosPlanes(locale, await tarifasDeLosPlanes())";
    expect(precios).toContain(lectura);
    expect(alta).toContain(lectura);
    expect(alta).toContain("planes.pro.mensual");
    expect(alta).toContain("planes.equipo.mensual");
    expect(alta).toContain("planes.equipo.incluidos");
    // Como /pricing, se regenera con la caché del precio (una hora).
    expect(alta).toMatch(/export const revalidate = 3600;/);
  });
});
