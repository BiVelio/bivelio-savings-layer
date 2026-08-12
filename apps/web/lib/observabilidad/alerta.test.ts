import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { alertar, MARCA } from "./alerta";

/**
 * El avisador. Las dos cosas que tiene que cumplir sin excepción:
 *   1. NUNCA romper a quien lo llama — se invoca desde caminos que ya están
 *      gestionando un fallo, y un avisador que rompe lo que intentaba avisar es
 *      peor que no tenerlo.
 *   2. Que lo crítico llegue por correo y lo demás NO, porque mandar todo por
 *      correo entrena a ignorarlo y entonces se pierde el que importa.
 */

const originales = { ...process.env };

function espiarFetch() {
  const llamadas: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    llamadas.push({ url, init });
    return { ok: true, status: 200 } as Response;
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return llamadas;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originales };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a dónde llega cada alerta", () => {
  it("lo CRÍTICO sale por correo", async () => {
    process.env.RESEND_API_KEY = "re_de_prueba";
    delete process.env.BVSALA_ALERT_WEBHOOK;
    const llamadas = espiarFetch();

    await alertar({ nivel: "critico", asunto: "el ingest se está perdiendo datos", detalle: { org: "o1" } });

    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.url).toBe("https://api.resend.com/emails");
    const cuerpo = JSON.parse(String(llamadas[0]!.init.body));
    expect(cuerpo.to).toEqual(["support@bivelio.com"]);
    expect(cuerpo.subject).toContain("el ingest se está perdiendo datos");
  });

  it("un AVISO no manda correo — si no, el correo que importa se pierde", async () => {
    process.env.RESEND_API_KEY = "re_de_prueba";
    delete process.env.BVSALA_ALERT_WEBHOOK;
    const llamadas = espiarFetch();

    await alertar({ nivel: "aviso", asunto: "algo menor" });

    expect(llamadas).toHaveLength(0);
  });

  it("el destino se puede cambiar por entorno, y admite varios", async () => {
    process.env.RESEND_API_KEY = "re_de_prueba";
    process.env.BVSALA_ALERT_EMAIL = "a@bivelio.com, b@bivelio.com";
    const llamadas = espiarFetch();

    await alertar({ nivel: "critico", asunto: "x" });

    expect(JSON.parse(String(llamadas[0]!.init.body)).to).toEqual(["a@bivelio.com", "b@bivelio.com"]);
  });

  it("sin clave de correo no se intenta enviar (y no se rompe nada)", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.BVSALA_ALERT_WEBHOOK;
    const llamadas = espiarFetch();

    await expect(alertar({ nivel: "critico", asunto: "x" })).resolves.toBeUndefined();
    expect(llamadas).toHaveLength(0);
  });

  it("correo y webhook van los DOS, y en paralelo", async () => {
    process.env.RESEND_API_KEY = "re_de_prueba";
    process.env.BVSALA_ALERT_WEBHOOK = "https://hooks.example.com/x";
    const llamadas = espiarFetch();

    await alertar({ nivel: "critico", asunto: "x" });

    expect(llamadas.map((l) => l.url).sort()).toEqual([
      "https://api.resend.com/emails",
      "https://hooks.example.com/x",
    ]);
  });
});

describe("el avisador nunca rompe a quien lo llama", () => {
  it("si el correo revienta, el webhook sale igual", async () => {
    process.env.RESEND_API_KEY = "re_de_prueba";
    process.env.BVSALA_ALERT_WEBHOOK = "https://hooks.example.com/x";
    const vistas: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        vistas.push(url);
        if (url.includes("resend")) throw new Error("red caída");
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    );

    await expect(alertar({ nivel: "critico", asunto: "x" })).resolves.toBeUndefined();
    expect(vistas).toContain("https://hooks.example.com/x");
  });

  it("si TODO revienta, sigue sin lanzar", async () => {
    process.env.RESEND_API_KEY = "re_de_prueba";
    process.env.BVSALA_ALERT_WEBHOOK = "https://hooks.example.com/x";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("todo mal"); }) as unknown as typeof fetch);

    await expect(alertar({ nivel: "critico", asunto: "x" })).resolves.toBeUndefined();
  });

  it("el registro sale SIEMPRE, haya canales o no: es la red de la red", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.BVSALA_ALERT_WEBHOOK;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await alertar({ nivel: "critico", asunto: "sin canales" });

    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toContain(MARCA);
  });
});
