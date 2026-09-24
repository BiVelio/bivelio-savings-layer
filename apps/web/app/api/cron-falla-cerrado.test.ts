import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * LOS CRONS FALLAN CERRADO, Y LO DICEN EN INGLÉS.
 *
 * Sin CRON_SECRET ninguno de los tres toca nada: 501, alerta crítica y un cuerpo
 * que quien mire los logs de Vercel desde fuera pueda leer. Hasta hoy tres rutas
 * contestaban «cron sin configurar» y la cuarta (invariantes) ya lo decía en
 * inglés; aquí se fija el texto común para que no vuelvan a divergir.
 */

const { alertas } = vi.hoisted(() => ({ alertas: [] as { nivel: string; asunto: string }[] }));
vi.mock("@/lib/observabilidad/alerta", () => ({
  alertar: async (a: { nivel: string; asunto: string }) => {
    alertas.push(a);
  },
}));

const RUTAS = [
  ["cierre-extractos", () => import("./cron/cierre-extractos/route")],
  ["retencion", () => import("./cron/retencion/route")],
  ["facturar-extractos", () => import("./cron/facturar-extractos/route")],
] as const;

function peticion(ruta: string, bearer?: string): Request {
  return new Request(`https://savings.bivelio.com/api/cron/${ruta}`, {
    method: "GET",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

const ENTORNO = ["CRON_SECRET", "STRIPE_SECRET_KEY"] as const;
const previo: Partial<Record<(typeof ENTORNO)[number], string | undefined>> = {};

beforeEach(() => {
  alertas.length = 0;
  for (const k of ENTORNO) {
    previo[k] = process.env[k];
    delete process.env[k];
  }
  // `billingConfigured` se lee al cargar el módulo: cada test importa fresco.
  vi.resetModules();
});
afterEach(() => {
  for (const k of ENTORNO) {
    if (previo[k] === undefined) delete process.env[k];
    else process.env[k] = previo[k];
  }
});

describe("sin CRON_SECRET: 501, en inglés, y una alerta crítica", () => {
  for (const [nombre, cargar] of RUTAS) {
    it(`/api/cron/${nombre}`, async () => {
      const { GET } = await cargar();
      const res = await GET(peticion(nombre));
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: "Cron isn't configured (CRON_SECRET unset)." });
      expect(alertas).toHaveLength(1);
      expect(alertas[0]!.nivel).toBe("critico");
    });
  }
});

describe("facturar-extractos sin Stripe", () => {
  it("con Bearer válido pero sin STRIPE_SECRET_KEY responde 501 en inglés y no toca nada", async () => {
    process.env.CRON_SECRET = "secreto-de-pruebas";
    vi.resetModules();
    const { GET } = await import("./cron/facturar-extractos/route");
    const res = await GET(peticion("facturar-extractos", "secreto-de-pruebas"));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "Stripe isn't configured (STRIPE_SECRET_KEY unset)." });
    expect(alertas).toEqual([]);
  });
});
