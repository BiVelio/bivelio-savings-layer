import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator, type AbstractIntlMessages } from "next-intl";
import { describe, expect, it, vi } from "vitest";

/**
 * A2-18 · LA PANTALLA DE ENTRADA DICE QUE EL ENLACE DE REGISTRO YA SE USÓ.
 *
 * /auth/callback manda aquí con `?error=enlace_usado` cuando un enlace de alta
 * no se puede canjear: casi siempre porque el filtro de seguridad del correo lo
 * abrió antes que la persona (ver app/auth/callback/enlace-usado.test.ts). Antes
 * cualquier `error` pintaba «No hemos podido validar el enlace. Solicita uno
 * nuevo», y para un registro no hay enlace nuevo que pedir: la cuenta ya está
 * confirmada y basta con entrar.
 *
 * Se renderiza la página de verdad con los mensajes reales de los 12 idiomas.
 */

const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"] as const;
const mensajesDe = (loc: string) =>
  JSON.parse(readFileSync(new URL(`../../../messages/${loc}.json`, import.meta.url), "utf8")) as AbstractIntlMessages & {
    auth: Record<string, string>;
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
// Lo que necesita el runtime de Next o un navegador: fuera.
vi.mock("@/i18n/navigation", () => ({ Link: ({ children }: { children: ReactNode }) => createElement("a", null, children) }));
vi.mock("@/app/components/AuthForm", () => ({ default: () => null }));
vi.mock("@/app/components/acceso/PanelDeMarca", () => ({ PanelDeMarca: () => null }));
vi.mock("@/app/components/acceso/EnlaceConDestino", () => ({
  EnlaceConDestino: ({ children }: { children: ReactNode }) => createElement("a", null, children),
}));
vi.mock("@/app/components/acceso/AccesoShell", () => ({
  AccesoShell: ({ children }: { children: ReactNode }) => createElement("main", null, children),
}));

async function pintar(locale: string, error?: string) {
  estado.locale = locale;
  estado.messages = mensajesDe(locale);
  const { default: LoginPage } = await import("./page.js");
  const pagina = await LoginPage({
    params: Promise.resolve({ locale }),
    searchParams: Promise.resolve(error === undefined ? {} : { error }),
  });
  return renderToStaticMarkup(pagina);
}

/** El texto tal como lo escapa React en el HTML. */
const enHtml = (s: string) => renderToStaticMarkup(createElement("span", null, s)).slice("<span>".length, -"</span>".length);

describe("A2-18 · /login?error=enlace_usado", () => {
  for (const loc of LOCALES) {
    it(`${loc}: dice que el enlace ya se usó, y no que pidas uno nuevo`, async () => {
      const a = mensajesDe(loc).auth;
      expect(a.signupLinkUsed, `${loc}: falta auth.signupLinkUsed`).toBeTruthy();
      expect(a.signupLinkUsed).not.toBe(a.callbackFailed);
      const html = await pintar(loc, "enlace_usado");
      expect(html).toContain(enHtml(a.signupLinkUsed!));
      expect(html).not.toContain(enHtml(a.callbackFailed!));
      expect(html).toContain('role="alert"');
    });
  }

  it("en/es: el texto dice que ya se usó y que, con la cuenta confirmada, se entra con correo y contraseña", () => {
    const en = mensajesDe("en").auth.signupLinkUsed!;
    const es = mensajesDe("es").auth.signupLinkUsed!;
    expect(en).toMatch(/already been used/);
    expect(en).toMatch(/sign in with your email and password/);
    expect(en).not.toMatch(/request a new/i);
    expect(es).toMatch(/ya se ha usado/);
    expect(es).toMatch(/entra con tu correo y tu contraseña/);
    expect(es).not.toMatch(/solicita uno nuevo/i);
  });

  it("cualquier otro error sigue con el texto de siempre, y sin error no hay aviso", async () => {
    const a = mensajesDe("es").auth;
    const otro = await pintar("es", "auth_callback");
    expect(otro).toContain(enHtml(a.callbackFailed!));
    expect(otro).not.toContain(enHtml(a.signupLinkUsed ?? "∅"));
    // Lo que trae el query no se refleja nunca en la página.
    const raro = await pintar("es", "<script>x</script>");
    expect(raro).toContain(enHtml(a.callbackFailed!));
    expect(raro).not.toContain("<script>x</script>");
    const limpio = await pintar("es");
    expect(limpio).not.toContain('role="alert"');
  });
});
