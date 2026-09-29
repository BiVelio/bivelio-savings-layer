import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PRECIOS_DE_LOS_PLANES } from "./planes";

/**
 * El script que crea los Prices de Pro y Equipo (lo ejecuta el dueño) usa las
 * MISMAS cifras que PRECIOS_DE_LOS_PLANES de planes.ts. Si alguien cambia una y no la
 * otra, /pricing anunciaría una cosa y Stripe cobraría otra.
 */
const script = readFileSync(fileURLToPath(new URL("../../scripts/provision-planes.mjs", import.meta.url)), "utf8");
const cifra = (linea: string, campo: string) => {
  const m = new RegExp(`${linea}:[^\\n]*\\b${campo}: (\\d+)`).exec(script);
  if (!m) throw new Error(`${linea}.${campo} no está en el script`);
  return Number(m[1]);
};

describe("provision-planes.mjs crea exactamente los precios confirmados", () => {
  it("Pro, mensual y anual", () => {
    expect(cifra("pro_monthly", "unit_amount")).toBe(PRECIOS_DE_LOS_PLANES.pro.monthly.asientoCentimos);
    expect(cifra("pro_yearly", "unit_amount")).toBe(PRECIOS_DE_LOS_PLANES.pro.yearly.asientoCentimos);
  });

  it("Equipo: incluidos, cuota fija y asiento extra, mensual y anual", () => {
    for (const [linea, t] of [
      ["team_monthly", PRECIOS_DE_LOS_PLANES.equipo.monthly],
      ["team_yearly", PRECIOS_DE_LOS_PLANES.equipo.yearly],
    ] as const) {
      expect(cifra(linea, "incluidos")).toBe(t.asientosIncluidos);
      expect(cifra(linea, "flat_amount")).toBe(t.fijaCentimos);
      expect(cifra(linea, "extra")).toBe(t.asientoCentimos);
    }
  });

  it("escribe las variables con los nombres que lee env.ts", () => {
    const env = readFileSync(fileURLToPath(new URL("../stripe/env.ts", import.meta.url)), "utf8");
    for (const nombre of ["STRIPE_PRICE_ID_PRO_MONTHLY", "STRIPE_PRICE_ID_PRO_YEARLY", "STRIPE_PRICE_ID_TEAM_MONTHLY", "STRIPE_PRICE_ID_TEAM_YEARLY"]) {
      expect(script).toContain(`env: "${nombre}"`);
      expect(env).toContain(`process.env.${nombre}`);
    }
  });
});
