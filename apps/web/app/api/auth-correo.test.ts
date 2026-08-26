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

let resendLlamadas: { to: string[]; subject: string; html: string }[] = [];
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
      const cuerpo = JSON.parse(String(init?.body)) as { to: string[]; subject: string; html: string };
      resendLlamadas.push(cuerpo);
      return new Response(resendFalla ? "{}" : "{}", { status: resendFalla ? 500 : 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPABASE_SEND_EMAIL_HOOK_SECRET;
});

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

  it("sin secreto configurado responde 501, no 401", async () => {
    delete process.env.SUPABASE_SEND_EMAIL_HOOK_SECRET;
    const { POST } = await import("./auth/correo/route");
    const res = await POST(peticion(CARGA));
    expect(res.status).toBe(501);
    expect(resendLlamadas).toHaveLength(0);
  });
});
