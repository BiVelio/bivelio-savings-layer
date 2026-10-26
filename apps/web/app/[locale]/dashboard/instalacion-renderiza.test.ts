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

vi.mock("@/lib/stripe/pricing", async () => {
  const { PRECIOS_DE_LOS_PLANES } = await import("@/lib/billing/planes");
  return {
    preciosDelPlan: async () => ({
      monthly: { amount: 400, currency: "eur" },
      yearly: { amount: 3900, currency: "eur" },
    }),
    tarifasDeLosPlanes: async () => PRECIOS_DE_LOS_PLANES,
  };
});

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
      expect(html).toContain("<code>pip install bivelio-savings-layer</code>");
      expect(html).toContain("<code>import bvsala</code>");
      // Ninguna etiqueta rich sin sustituir.
      expect(html).not.toMatch(/&lt;\/?(b|code)&gt;/);
    });
  }
});

/**
 * EL PASO «SDK installed» DEL INICIO DEL PANEL DICE LO MISMO QUE EL PANEL DE
 * INSTALACIÓN. Seguía mostrando `pnpm add @bivelio/savings-layer` cuando el panel
 * ya recomendaba `init` (#355): la primera pantalla tras entrar mandaba por la
 * vía que la segunda presentaba como la alternativa.
 */
const { InstrumentationSpine } = await import("./components/InstrumentationSpine");
const { activationSteps } = await import("./data");

const PASOS = ["Account created", "License active", "SDK or gateway installed", "First real request", "Report ready"] as const;

async function renderizarEspina(loc: string, actual: (typeof PASOS)[number]): Promise<string> {
  estado.locale = loc;
  estado.messages = mensajesDe(loc) as Record<string, unknown>;
  const t = createTranslator({ locale: loc, messages: estado.messages as AbstractIntlMessages, namespace: "dashboard" as never, onError: lanzar });
  const claves: Record<(typeof PASOS)[number], string> = {
    "Account created": "overview.steps.accountCreated",
    "SDK or gateway installed": "overview.steps.sdkInstalled",
    "License active": "overview.steps.licenseActive",
    "First real request": "overview.steps.firstRequest",
    "Report ready": "overview.steps.reportReady",
  };
  const i = PASOS.indexOf(actual);
  const steps = PASOS.map((id, j) => ({
    id,
    label: t(claves[id] as never),
    status: j < i ? ("done" as const) : j === i ? ("current" as const) : ("pending" as const),
  }));
  const arbol = await InstrumentationSpine({ steps });
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

describe("la espina de instalación recomienda `init` y enlaza SDK/gateway en los 12 idiomas", () => {
  for (const loc of LOCALES) {
    it(loc, async () => {
      const html = await renderizarEspina(loc, "SDK or gateway installed");
      expect(html).toContain("npx @bivelio/savings-layer@latest init");
      expect(html).not.toContain("pnpm add");
      expect(html).toContain('href="/dashboard/install#sdk"');
      expect(html).toContain('href="/dashboard/install#gateway"');
    });
  }

  it("las pistas y los CTA salen por el `id`, no por la etiqueta traducida", async () => {
    const es = mensajesDe("es") as { dashboard: { instrumentationSpine: Record<string, string> } };
    const pistas = es.dashboard.instrumentationSpine;
    const licencia = await renderizarEspina("es", "License active");
    expect(licencia).toContain(pistas["hintLicense"]!.slice(0, 30));
    expect(licencia).toContain('href="/dashboard/account"');
    expect(await renderizarEspina("es", "First real request")).toContain(pistas["hintFirstRequest"]!.slice(0, 30));
  });
});

describe("activationSteps — orden y pruebas de activación", () => {
  const ctx = {
    license: { status: "active", expiresAt: "2027-01-01", graceDays: 0 },
    serviceAccount: { keyPrefix: "bvk_prueba", lastUsedAt: null },
  } as never;
  const lectura = { usageFailed: false, usageHidden: false };

  it("cuenta → licencia → instalación → petición real → informe; una clave no instala", async () => {
    estado.locale = "en";
    estado.messages = mensajesDe("en") as Record<string, unknown>;
    const steps = await activationSteps(true, ctx, [], lectura);
    expect(steps.map((s) => s.id)).toEqual(PASOS);
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "current", "pending", "pending"]);
  });

  it("licencia sin credencial de servicio mantiene el paso de credenciales como siguiente", async () => {
    const sinClave = { license: { status: "active", expiresAt: "2027-01-01", graceDays: 0 }, serviceAccount: null } as never;
    const steps = await activationSteps(true, sinClave, [], lectura);
    expect(steps[1]!.status).toBe("current");
    expect(steps[2]!.status).toBe("pending");
  });

  it("un lote vacío o solo sombra tampoco prueba instalación", async () => {
    const steps = await activationSteps(true, ctx, [{ requests: 0, shadowRequests: 4 }] as never, lectura);
    expect(steps[2]!.status).toBe("current");
    expect(steps[3]!.status).toBe("pending");
  });

  it("la primera petición real completa instalación, petición e informe", async () => {
    const steps = await activationSteps(true, ctx, [{ requests: 1 }] as never, lectura);
    expect(steps.every((s) => s.status === "done")).toBe(true);
  });

  it.each([{ usageFailed: true, usageHidden: false }, { usageFailed: false, usageHidden: true }])(
    "error/RLS no se presenta como «instala»: %o",
    async (estadoLectura) => {
      const steps = await activationSteps(true, ctx, [], estadoLectura);
      expect(steps.slice(2).every((s) => s.status === "unavailable")).toBe(true);
      expect(steps.some((s) => s.id === "SDK or gateway installed" && s.status === "current")).toBe(false);
    },
  );
});
