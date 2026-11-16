import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `catalogoDeComision()` — DEL ENTORNO AL CATÁLOGO QUE DECIDE EL DINERO.
 *
 * Todos los tests del cierre y de la facturación sustituyen esta función por un
 * catálogo fijo, así que nada vigilaba el mapeo en sí. Y un cambio aquí es
 * dinero: meter STRIPE_PRICE_IDS_EXTRA en `comision` cobraría comisión a las
 * cortesías; meterlo en `sinComision` cerraría a 0, sin alerta, a los clientes
 * de comisión cuyos Prices se rotaron en agosto (#53); y romper el troceo por
 * comas dejaría sin declarar todos los Prices de la lista.
 *
 * Los price ids de aquí son inventados (y un price id no es un secreto).
 */

const VARIABLES = [
  "STRIPE_PRICE_ID_MONTHLY",
  "STRIPE_PRICE_ID_YEARLY",
  "STRIPE_PRICE_ID_PRO_MONTHLY",
  "STRIPE_PRICE_ID_PRO_YEARLY",
  "STRIPE_PRICE_ID_TEAM_MONTHLY",
  "STRIPE_PRICE_ID_TEAM_YEARLY",
  "STRIPE_PRICE_IDS_COMISION",
  "STRIPE_PRICE_IDS_SIN_COMISION",
  "STRIPE_PRICE_IDS_EXTRA",
] as const;

const original = { ...process.env };

/** Carga el módulo con SOLO estas variables de Price (las constantes se leen al importar). */
async function conEntorno(entorno: Partial<Record<(typeof VARIABLES)[number], string>>) {
  vi.resetModules();
  for (const nombre of VARIABLES) delete process.env[nombre];
  Object.assign(process.env, entorno);
  return import("./env");
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  process.env = { ...original };
  vi.resetModules();
});

describe("catalogoDeComision — el mapeo del entorno", () => {
  it("cada variable va a su lista y a ninguna otra", async () => {
    const { catalogoDeComision } = await conEntorno({
      STRIPE_PRICE_ID_MONTHLY: "price_exclusive_m",
      STRIPE_PRICE_ID_YEARLY: "price_exclusive_y",
      STRIPE_PRICE_ID_PRO_MONTHLY: "price_pro_m",
      STRIPE_PRICE_ID_PRO_YEARLY: "price_pro_y",
      STRIPE_PRICE_ID_TEAM_MONTHLY: "price_team_m",
      STRIPE_PRICE_ID_TEAM_YEARLY: "price_team_y",
      STRIPE_PRICE_IDS_COMISION: "price_inclusive_m,price_inclusive_y",
      STRIPE_PRICE_IDS_SIN_COMISION: "price_socio",
      STRIPE_PRICE_IDS_EXTRA: "price_inclusive_m,price_cortesia",
    });
    expect(catalogoDeComision()).toEqual({
      comision: ["price_exclusive_m", "price_exclusive_y", "price_inclusive_m", "price_inclusive_y"],
      pro: ["price_pro_m", "price_pro_y"],
      equipo: ["price_team_m", "price_team_y"],
      sinComision: ["price_socio"],
    });
  });

  it("⛔ STRIPE_PRICE_IDS_EXTRA no entra en NINGUNA lista: un Price que solo está ahí queda sin declarar", async () => {
    const { catalogoDeComision } = await conEntorno({
      STRIPE_PRICE_ID_MONTHLY: "price_exclusive_m",
      STRIPE_PRICE_ID_PRO_MONTHLY: "price_pro_m",
      STRIPE_PRICE_IDS_EXTRA: "price_solo_en_extra, price_otro_extra",
    });
    const c = catalogoDeComision();
    const todas = [...c.comision, ...c.pro, ...c.equipo, ...(c.sinComision ?? [])];
    expect(todas).not.toContain("price_solo_en_extra");
    expect(todas).not.toContain("price_otro_extra");
    expect(todas.sort()).toEqual(["price_exclusive_m", "price_pro_m"]);
  });

  it("STRIPE_PRICE_IDS_COMISION: se recortan los espacios, se ignoran los huecos y no se repite ningún id", async () => {
    const { catalogoDeComision } = await conEntorno({
      STRIPE_PRICE_ID_MONTHLY: "price_exclusive_m",
      STRIPE_PRICE_ID_YEARLY: "price_exclusive_y",
      // Espacios, saltos de línea, comas de más, uno repetido y uno que ya es el MONTHLY.
      STRIPE_PRICE_IDS_COMISION: "  price_inclusive_m , price_inclusive_y,,\n price_inclusive_m ,price_exclusive_m, ",
    });
    expect(catalogoDeComision().comision).toEqual(["price_exclusive_m", "price_exclusive_y", "price_inclusive_m", "price_inclusive_y"]);
  });

  it("STRIPE_PRICE_IDS_SIN_COMISION → `sinComision`, recortada, y NO en `comision`", async () => {
    const { catalogoDeComision } = await conEntorno({
      STRIPE_PRICE_ID_MONTHLY: "price_exclusive_m",
      STRIPE_PRICE_IDS_SIN_COMISION: " price_socio ,price_cuota_fija_a_medida ,",
    });
    const c = catalogoDeComision();
    expect(c.sinComision).toEqual(["price_socio", "price_cuota_fija_a_medida"]);
    expect(c.comision).toEqual(["price_exclusive_m"]);
  });

  it("sin ninguna variable: todas las listas vacías (el cierre aplaza con alerta; aquí no se inventa nada)", async () => {
    const { catalogoDeComision } = await conEntorno({});
    expect(catalogoDeComision()).toEqual({ comision: [], pro: [], equipo: [], sinComision: [] });
  });

  it("las listas extra se leen en cada llamada, no al importar", async () => {
    const { catalogoDeComision } = await conEntorno({ STRIPE_PRICE_ID_MONTHLY: "price_exclusive_m" });
    expect(catalogoDeComision().comision).toEqual(["price_exclusive_m"]);
    process.env.STRIPE_PRICE_IDS_COMISION = "price_inclusive_m";
    expect(catalogoDeComision().comision).toEqual(["price_exclusive_m", "price_inclusive_m"]);
  });
});
