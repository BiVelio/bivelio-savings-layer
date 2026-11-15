import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * LA RUTA DEL HOOK DE PUNTA A PUNTA: firma → producto/idioma → Resend.
 *
 * Lo innegociable: sin firma válida NO se manda nada (401 antes de tocar el
 * cuerpo), y si Resend falla la respuesta es 5xx — GoTrue debe enterarse de
 * que el correo no salió, porque un 200 hueco deja a alguien esperando un
 * correo que no existe.
 */

const SECRETO_CRUDO = Buffer.from("secreto-de-la-ruta-de-pruebas").toString("base64");

let resendLlamadas: { to: string[]; subject: string; html: string; text: string }[] = [];
let resendFalla = false;

function firmar(cuerpo: string): Headers {
  const id = "msg_route_1";
  const ts = String(Math.floor(Date.now() / 1000));
  const firma = createHmac("sha256", Buffer.from(SECRETO_CRUDO, "base64"))
    .update(`${id}.${ts}.${cuerpo}`)
    .digest("base64");
  return new Headers({
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${firma}`,
    "content-type": "application/json",
  });
}

function peticion(cuerpo: string, cabeceras?: Headers): Request {
  return new Request("https://savings.bivelio.com/api/auth/correo", {
    method: "POST",
    headers: cabeceras ?? firmar(cuerpo),
    body: cuerpo,
  });
}

const CARGA = JSON.stringify({
  user: { email: "alguien@empresa.com" },
  email_data: {
    token_hash: "th_ruta",
    redirect_to: "https://savings.bivelio.com/auth/callback?next=/de/dashboard",
    email_action_type: "signup",
    site_url: "https://app.bivelio.com",
  },
});

beforeEach(() => {
  resendLlamadas = [];
  resendFalla = false;
  process.env.SUPABASE_SEND_EMAIL_HOOK_SECRET = `v1,whsec_${SECRETO_CRUDO}`;
  process.env.RESEND_API_KEY = "re_prueba";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const cuerpo = JSON.parse(String(init?.body)) as { to: string[]; subject: string; html: string; text: string };
      resendLlamadas.push(cuerpo);
      return new Response(resendFalla ? "{}" : "{}", { status: resendFalla ? 500 : 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPABASE_SEND_EMAIL_HOOK_SECRET;
  delete process.env.BVSALA_CORREO_CALLBACK_PRIVACY;
});

/** Una carga de alta con el redirect (y el site_url) que se quiera probar. */
function cargaCon(redirectTo: string, siteUrl = "https://app.bivelio.com"): string {
  return JSON.stringify({
    user: { email: "persona@ejemplo.com" },
    email_data: {
      token_hash: "th_ruta",
      redirect_to: redirectTo,
      email_action_type: "signup",
      site_url: siteUrl,
    },
  });
}

describe("POST /api/auth/correo", () => {
  it("con firma válida manda el correo del producto y del idioma del redirect", async () => {
    const { POST } = await import("./auth/correo/route");
    const res = await POST(peticion(CARGA));
    expect(res.status).toBe(200);
    expect(resendLlamadas).toHaveLength(1);
    expect(resendLlamadas[0]!.to).toEqual(["alguien@empresa.com"]);
    // Alemán (el next=/de/…) y con el enlace bien construido: & tras la query.
    expect(resendLlamadas[0]!.subject).toContain("Bestätigen");
    expect(resendLlamadas[0]!.html).toContain("token_hash=th_ruta");
    expect(resendLlamadas[0]!.html).toContain("type=signup");
  });

  it("⛔ sin firma válida: 401 y CERO correos", async () => {
    const { POST } = await import("./auth/correo/route");
    const cab = firmar(CARGA);
    cab.set("webhook-signature", "v1,AAAA");
    const res = await POST(peticion(CARGA, cab));
    expect(res.status).toBe(401);
    expect(resendLlamadas).toHaveLength(0);
  });

  it("⛔ si Resend falla, la respuesta es 500 — GoTrue debe saber que no salió", async () => {
    resendFalla = true;
    const { POST } = await import("./auth/correo/route");
    const res = await POST(peticion(CARGA));
    expect(res.status).toBe(500);
  });

  it("un alta en shield.bivelio.com sale como BiVelio Shield y con el enlace a shield", async () => {
    const { POST } = await import("./auth/correo/route");
    const res = await POST(peticion(cargaCon("https://shield.bivelio.com/auth/callback?next=/it/dashboard")));
    expect(res.status).toBe(200);
    const c = resendLlamadas[0]!;
    expect(c.subject).toContain("Confermi"); // italiano, por el next=/it/…
    expect(c.html).toContain("BiVelio Shield");
    expect(c.html).toContain("https://shield.bivelio.com/auth/callback?next=%2Fit%2Fdashboard&amp;token_hash=th_ruta&amp;type=signup");
    expect(c.html).not.toContain("#070B14"); // NO la carcasa oscura de GPOS
    expect(c.html).not.toContain("app.bivelio.com");
    expect(c.text.endsWith("BiVelio Shield · shield.bivelio.com")).toBe(true);
  });

  it("un alta en privacy.bivelio.com sale igual que siempre", async () => {
    const { POST } = await import("./auth/correo/route");
    const res = await POST(peticion(cargaCon("https://privacy.bivelio.com/auth/callback?next=/es/dashboard")));
    expect(res.status).toBe(200);
    const c = resendLlamadas[0]!;
    expect(c.html).toContain("BY BIVELIO");
    expect(c.html).toContain("https://privacy.bivelio.com/auth/callback?next=%2Fes%2Fdashboard&amp;token_hash=th_ruta");
    expect(c.html).not.toContain("Shield");
    expect(c.text.endsWith("BiVelio · privacy.bivelio.com")).toBe(true);
  });

  it("un dominio desconocido sigue saliendo como GPOS, como hasta hoy", async () => {
    const { POST } = await import("./auth/correo/route");
    const res = await POST(peticion(cargaCon("https://desconocido.example/auth/callback")));
    expect(res.status).toBe(200);
    expect(resendLlamadas[0]!.html).toContain("#070B14");
    expect(resendLlamadas[0]!.html).not.toContain("Shield");
  });

  it("el interruptor: con la variable a shield, un redirect de privacy roto cae en shield", async () => {
    // «privacy.bivelio.com/…» sin esquema: es privacy, pero no es una URL.
    const roto = cargaCon("privacy.bivelio.com/auth/callback");
    const { POST } = await import("./auth/correo/route");

    await POST(peticion(roto));
    expect(resendLlamadas[0]!.html).toContain("https://privacy.bivelio.com/auth/callback?token_hash=th_ruta");
    expect(resendLlamadas[0]!.html).not.toContain("Shield");

    process.env.BVSALA_CORREO_CALLBACK_PRIVACY = "https://shield.bivelio.com/auth/callback";
    await POST(peticion(roto));
    expect(resendLlamadas[1]!.html).toContain("https://shield.bivelio.com/auth/callback?token_hash=th_ruta");
    expect(resendLlamadas[1]!.html).toContain("BiVelio Shield");
  });

  it("sin secreto configurado responde 501, no 401", async () => {
    delete process.env.SUPABASE_SEND_EMAIL_HOOK_SECRET;
    const { POST } = await import("./auth/correo/route");
    const res = await POST(peticion(CARGA));
    expect(res.status).toBe(501);
    expect(resendLlamadas).toHaveLength(0);
  });
});
