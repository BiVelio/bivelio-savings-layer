import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator, type AbstractIntlMessages } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TarifasDeLosPlanes } from "@/lib/stripe/pricing";

/**
 * LA ENTRADA Y EL ALTA, CON Y SIN `BVSALA_CUENTA_PROPIA` (revisión de #632).
 *
 * Las dos entradillas de acceso decían «la misma cuenta que usas en toda la
 * suite» y «una cuenta BiVelio para toda la suite» aunque el interruptor
 * estuviera encendido. Aquí se pintan las dos páginas de verdad, con los
 * mensajes reales de los 12 idiomas:
 *   · apagado (hoy): exactamente las frases de siempre;
 *   · encendido: ni una palabra de la suite ni de Shield en todo el HTML.
 */

const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"] as const;
const mensajesDe = (loc: string) =>
  JSON.parse(readFileSync(new URL(`../../messages/${loc}.json`, import.meta.url), "utf8")) as AbstractIntlMessages & {
    auth: Record<string, string>;
  };

/** La misma búsqueda que `lib/auth/cuenta-compartida.test.ts`. */
const LA_SUITE = /\bsuite\b|\bsuity\b|süit|całym pakiecie|tüm paket|paketinin tamamı|bộ sản phẩm|Shield/i;

const TARIFAS: TarifasDeLosPlanes = {
  pro: {
    monthly: { fijaCentimos: 0, asientosIncluidos: 0, asientoCentimos: 1_500, currency: "eur" },
    yearly: { fijaCentimos: 0, asientosIncluidos: 0, asientoCentimos: 15_000, currency: "eur" },
  },
  equipo: {
    monthly: { fijaCentimos: 12_900, asientosIncluidos: 10, asientoCentimos: 1_200, currency: "eur" },
    yearly: { fijaCentimos: 129_000, asientosIncluidos: 10, asientoCentimos: 12_000, currency: "eur" },
  },
};

const estado = vi.hoisted(() => ({ locale: "en", messages: {} as Record<string, unknown> }));
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
// Sin plan elegido: el plan lo lee el navegador al montar.
vi.mock("@/app/components/acceso/PlanElegidoEnAlta", async (original) => {
  const real = await original<typeof import("@/app/components/acceso/PlanElegidoEnAlta")>();
  return {
    ...real,
    PlanElegidoEnAlta: ({ textos }: { textos: Record<"pro" | "equipo", string> }) => real.AvisoDelPlan({ plan: null, textos }),
    SoloSinPlanElegido: ({ children }: { children: ReactNode }) => real.SinPlan({ plan: null, children }),
  };
});

async function pintar(locale: string) {
  estado.locale = locale;
  estado.messages = mensajesDe(locale);
  const { default: LoginPage } = await import("./login/page.js");
  const { default: SignupPage } = await import("./signup/page.js");
  const entrada = renderToStaticMarkup(
    await LoginPage({ params: Promise.resolve({ locale }), searchParams: Promise.resolve({}) }),
  );
  const alta = renderToStaticMarkup(await SignupPage({ params: Promise.resolve({ locale }) }));
  return { entrada, alta };
}

/** El texto tal como lo escapa React en el HTML. */
const enHtml = (s: string) => renderToStaticMarkup(createElement("span", null, s)).slice("<span>".length, -"</span>".length);

afterEach(() => vi.unstubAllEnvs());

describe("entrada y alta — BVSALA_CUENTA_PROPIA apagado (hoy): las frases de siempre", () => {
  for (const loc of LOCALES) {
    it(`${loc}`, async () => {
      expect(process.env.BVSALA_CUENTA_PROPIA ?? "").not.toBe("1");
      const a = mensajesDe(loc).auth;
      const { entrada, alta } = await pintar(loc);
      expect(entrada).toContain(`<p class="sub">${enHtml(a.loginSubtitle!)}</p>`);
      expect(alta).toContain(`<p class="sub">${enHtml(a.signupSubtitle!)}</p>`);
      expect(alta).toContain(`<p class="acc-nota">${enHtml(a.signupSsoNote!)}</p>`);
      expect(entrada).not.toContain(enHtml(a.loginSubtitleSinSuite!) + "</p>");
    });
  }
});

describe("entrada y alta — BVSALA_CUENTA_PROPIA=1: ni la suite ni Shield", () => {
  for (const loc of LOCALES) {
    it(`${loc}`, async () => {
      vi.stubEnv("BVSALA_CUENTA_PROPIA", "1");
      const a = mensajesDe(loc).auth;
      const { entrada, alta } = await pintar(loc);
      expect(entrada).toContain(`<p class="sub">${enHtml(a.loginSubtitleSinSuite!)}</p>`);
      expect(alta).toContain(`<p class="sub">${enHtml(a.signupSubtitleSinSuite!)}</p>`);
      expect(alta).not.toContain(enHtml(a.signupSsoNote!));
      expect(entrada, `${loc}: entrada`).not.toMatch(LA_SUITE);
      expect(alta, `${loc}: alta`).not.toMatch(LA_SUITE);
    });
  }
});
