import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A2-18 · EL ENLACE DE REGISTRO YA USADO DICE LA VERDAD, EN EL IDIOMA DE QUIEN SE REGISTRÓ.
 *
 * El correo de alta confirma la cuenta con un GET. Los filtros de correo de
 * empresa (Safe Links, Proofpoint…) abren los enlaces antes que la persona, y esa
 * visita gasta el token, que vale una sola vez. Cuando la persona hacía clic,
 * llegaba a `/login?error=auth_callback` —sin idioma, así que en inglés— con
 * «We couldn't validate that link. Request a new one», cuando su cuenta ya estaba
 * confirmada y no hay «enlace nuevo» que pedir para un registro.
 *
 * Ahora un `signup` que no se puede canjear lleva a `/{idioma del next}/login`
 * con el código `enlace_usado`, que pinta un texto propio (ver
 * app/[locale]/login/enlace-usado.test.ts). El resto de tipos sigue igual.
 */

// GoTrue: un token_hash vale UNA vez. El doble lo imita.
const usados = new Set<string>();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      verifyOtp: async ({ token_hash }: { token_hash: string }) => {
        if (usados.has(token_hash)) return { error: { message: "Email link is invalid or has expired" } };
        usados.add(token_hash);
        return { error: null };
      },
      exchangeCodeForSession: async () => ({ error: { message: "invalid" } }),
    },
  }),
}));

async function get(url: string) {
  const { GET } = await import("./route.js");
  const r = await GET(new Request(url));
  return { status: r.status, destino: new URL(r.headers.get("location")!) };
}

beforeEach(() => usados.clear());

describe("A2-18 · /auth/callback con un enlace de registro ya usado", () => {
  it("⛔ el escáner del correo lo abre primero: la persona llega a SU login con «enlace_usado», no a «auth_callback»", async () => {
    const enlace = "https://savings.bivelio.com/auth/callback?next=%2Fde%2Fdashboard&token_hash=th_falso_1&type=signup";
    const escaner = await get(enlace);
    expect(escaner.destino.pathname).toBe("/de/signup/success");
    const persona = await get(enlace);
    expect(persona.status).toBe(307);
    expect(persona.destino.origin).toBe("https://savings.bivelio.com");
    expect(persona.destino.pathname).toBe("/de/login");
    expect(persona.destino.searchParams.get("error")).toBe("enlace_usado");
  });

  it("sin `next` con idioma, al idioma por defecto", async () => {
    usados.add("th_falso_2");
    const r = await get("https://savings.bivelio.com/auth/callback?token_hash=th_falso_2&type=signup");
    expect(r.destino.pathname).toBe("/en/login");
    expect(r.destino.searchParams.get("error")).toBe("enlace_usado");
  });

  it("un `next` hostil no saca de la web: el idioma sale del next saneado", async () => {
    usados.add("th_falso_3");
    const r = await get("https://savings.bivelio.com/auth/callback?next=%2F%2Fevil.example%2Fes&token_hash=th_falso_3&type=signup");
    expect(r.destino.origin).toBe("https://savings.bivelio.com");
    expect(r.destino.pathname).toBe("/en/login");
  });

  it("los demás tipos (recuperación, magic link…) siguen como antes", async () => {
    usados.add("th_falso_4");
    const r = await get("https://savings.bivelio.com/auth/callback?next=%2Fes%2Fdashboard&token_hash=th_falso_4&type=recovery");
    expect(r.destino.pathname).toBe("/login");
    expect(r.destino.searchParams.get("error")).toBe("auth_callback");
  });

  it("el primer clic de un registro sigue llevando a la página de éxito (la conversión)", async () => {
    const r = await get("https://savings.bivelio.com/auth/callback?next=%2Fes%2Fdashboard&token_hash=th_falso_5&type=signup");
    expect(r.destino.pathname).toBe("/es/signup/success");
    expect(r.destino.searchParams.get("next")).toBe("/es/dashboard");
  });
});
