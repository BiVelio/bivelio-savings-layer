import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A2-20 · EL PORTAL DE STRIPE OFRECE LOS PLANES EN VENTA, NO EL CERRADO.
 *
 * `scripts/provision-portal.mjs` (lo ejecuta el dueño, nunca un agente) solo
 * listaba los dos precios del plan con comisión, cerrado a clientes nuevos, con
 * mínimo 1. Un cliente Pro o Team no podía cambiar de asientos en el portal (su
 * precio no estaba en la lista) y el portal podía ofrecer el plan cerrado.
 *
 * Se ejecuta el script DE VERDAD contra un Stripe falso y se mira qué
 * configuración crearía. Ninguna llamada sale de la máquina.
 */

const creadas: Record<string, unknown>[] = [];
const actualizadas: Record<string, unknown>[] = [];
let hecho: () => void = () => {};

/** Pro y Team cuelgan del MISMO producto que el precio de siempre (provision-planes.mjs). */
const PRODUCTO_DE: Record<string, string> = {
  price_pro_mes: "prod_bvsala",
  price_pro_anio: "prod_bvsala",
  price_team_mes: "prod_bvsala",
  price_team_anio: "prod_bvsala",
  price_legado_mes: "prod_bvsala",
  price_legado_anio: "prod_bvsala_anual",
};

vi.mock("stripe", () => ({
  default: class StripeFalso {
    prices = {
      retrieve: async (id: string) => {
        if (!PRODUCTO_DE[id]) throw new Error(`precio desconocido ${id}`);
        return { id, product: PRODUCTO_DE[id] };
      },
    };
    billingPortal = {
      configurations: {
        list: async () => ({ data: [] }),
        create: async (c: Record<string, unknown>) => {
          creadas.push(c);
          hecho();
          return { id: "bpc_falsa" };
        },
        update: async (_id: string, c: Record<string, unknown>) => {
          actualizadas.push(c);
          hecho();
          return { id: "bpc_falsa" };
        },
      },
    };
  },
}));

const ENTORNO: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_falsa",
  STRIPE_PRICE_ID_PRO_MONTHLY: "price_pro_mes",
  STRIPE_PRICE_ID_PRO_YEARLY: "price_pro_anio",
  STRIPE_PRICE_ID_TEAM_MONTHLY: "price_team_mes",
  STRIPE_PRICE_ID_TEAM_YEARLY: "price_team_anio",
  // El plan cerrado sigue configurado en la web: el script NO debe ofrecerlo.
  STRIPE_PRICE_ID_MONTHLY: "price_legado_mes",
  STRIPE_PRICE_ID_YEARLY: "price_legado_anio",
};

async function ejecutar(entorno: Record<string, string>) {
  for (const [k, v] of Object.entries(entorno)) vi.stubEnv(k, v);
  const terminado = new Promise<void>((ok) => (hecho = ok));
  await import("../../scripts/provision-portal.mjs");
  await terminado;
}

beforeEach(() => {
  creadas.length = 0;
  actualizadas.length = 0;
  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Producto = { product: string; prices: string[]; adjustable_quantity: { enabled: boolean; minimum: number; maximum: number } };
const productosDe = (c: Record<string, unknown>) =>
  (c.features as { subscription_update: { products: Producto[] } }).subscription_update.products;

describe("A2-20 · provision-portal.mjs ofrece Pro y Team y deja fuera el plan cerrado", () => {
  it("⛔ el portal lista exactamente los cuatro precios en venta, y ninguno del plan cerrado", async () => {
    await ejecutar(ENTORNO);
    expect(creadas).toHaveLength(1);
    const productos = productosDe(creadas[0]!);
    const precios = productos.flatMap((p) => p.prices).sort();
    expect(precios).toEqual(["price_pro_anio", "price_pro_mes", "price_team_anio", "price_team_mes"]);
    expect(precios).not.toContain("price_legado_mes");
    expect(precios).not.toContain("price_legado_anio");
    // Agrupados por producto (Stripe exige un producto por entrada).
    expect(productos).toHaveLength(1);
    expect(productos[0]!.product).toBe("prod_bvsala");
  });

  it("se pueden cambiar asientos (el mínimo del portal es por producto: el suelo de Team lo pone el webhook)", async () => {
    await ejecutar(ENTORNO);
    for (const p of productosDe(creadas[0]!)) {
      expect(p.adjustable_quantity).toEqual({ enabled: true, minimum: 1, maximum: 500 });
    }
    const su = (creadas[0]!.features as { subscription_update: { enabled: boolean; default_allowed_updates: string[] } }).subscription_update;
    expect(su.enabled).toBe(true);
    expect(su.default_allowed_updates).toEqual(["quantity", "price"]);
  });

  it("sin los cuatro precios de Pro y Team no configura nada", async () => {
    const salir = vi.spyOn(process, "exit").mockImplementation(((codigo?: number) => {
      hecho();
      throw new Error(`exit ${codigo}`);
    }) as never);
    const { STRIPE_PRICE_ID_TEAM_YEARLY: _fuera, ...incompleto } = ENTORNO;
    vi.stubEnv("STRIPE_PRICE_ID_TEAM_YEARLY", "");
    await expect(ejecutar(incompleto)).rejects.toThrow("exit 1");
    expect(salir).toHaveBeenCalledWith(1);
    expect(creadas).toHaveLength(0);
    expect(actualizadas).toHaveLength(0);
  });
});
