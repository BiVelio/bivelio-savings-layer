import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider, createTranslator, type AbstractIntlMessages } from "next-intl";
import { describe, expect, it, vi } from "vitest";

/**
 * EL PANEL DE INSTALACIÓN RENDERIZA EN LOS 12 IDIOMAS.
 *
 * La paridad de claves y de etiquetas ya la vigila `messages/parity.test.ts`,
 * pero no ve el cruce entre el MENSAJE y el COMPONENTE: una etiqueta `<code>`
 * que el mensaje trae y el `t.rich` no recibe, o una clave que el componente
 * pide y se borró, revientan al renderizar, y solo en la página de quien acaba
 * de pagar. Aquí se renderiza el componente de verdad (servidor + islas de
 * cliente) con los mensajes reales de cada idioma y un `onError` que lanza.
 *
 * Lo único simulado es lo que necesita red o el runtime de Next: el precio
 * (Stripe) y `next-intl/server`, sustituido por el mismo traductor de next-intl.
 */

const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"] as const;

const mensajesDe = (loc: string): AbstractIntlMessages =>
  JSON.parse(readFileSync(new URL(`../../../messages/${loc}.json`, import.meta.url), "utf8")) as AbstractIntlMessages;

const estado = vi.hoisted(() => ({ locale: "en", messages: {} as Record<string, unknown> }));

const lanzar = (e: Error) => {
  throw e;
};

vi.mock("next-intl/server", () => ({
  getLocale: async () => estado.locale,
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: estado.locale,
      messages: estado.messages as AbstractIntlMessages,
      namespace: namespace as never,
      onError: lanzar,
    }),
}));

vi.mock("@/lib/stripe/pricing", () => ({
  preciosDelPlan: async () => ({
    monthly: { amount: 400, currency: "eur" },
    yearly: { amount: 3900, currency: "eur" },
  }),
}));

const { InstallLicensePanel } = await import("./components/InstallLicensePanel");

async function renderizar(loc: string): Promise<string> {
  estado.locale = loc;
  estado.messages = mensajesDe(loc) as Record<string, unknown>;
  const arbol = await InstallLicensePanel({ ctx: { serviceAccount: null } as never });
  return renderToString(
    createElement(NextIntlClientProvider, {
      locale: loc,
      messages: estado.messages as AbstractIntlMessages,
      timeZone: "UTC",
      onError: lanzar,
      children: arbol,
    }),
  );
}

describe("el panel de instalación renderiza en los 12 idiomas", () => {
  for (const loc of LOCALES) {
    it(loc, async () => {
      const html = await renderizar(loc);
      // La vía recomendada, y la alternativa a mano sin perderla.
      expect(html).toContain("npx @bivelio/savings-layer@latest init");
      expect(html).toContain("<code>--write</code>");
      expect(html).toContain("pnpm add @bivelio/savings-layer");
      expect(html).toContain("createSavingsLayer");
      // Los ocho envoltorios y el doctor, con su nombre de producto.
      for (const cmd of ["claude", "codex", "goose", "qwen", "opencode", "kilo", "copilot", "aider", "doctor"]) {
        expect(html, cmd).toMatch(new RegExp(`bvsala</span> ${cmd}\\b`));
      }
      expect(html).toContain("GitHub Copilot CLI");
      // La nota de Python con el comando exacto del README de packages/python.
      expect(html).toContain("<code>pip install ./packages/python</code>");
      // Ninguna etiqueta rich sin sustituir.
      expect(html).not.toMatch(/&lt;\/?(b|code)&gt;/);
    });
  }
});
