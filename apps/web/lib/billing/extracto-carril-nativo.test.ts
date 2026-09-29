import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { construirExtracto, type FilaDiaria } from "./extracto";

/**
 * 0032 · EL AHORRO NATIVO de la caché de prefijo del proveedor. Decisión del
 * dueño: «mostrar el ahorro de la caché de prefijo del proveedor aparte, sin
 * comisión». A diferencia del suelo de la elisión o de la referencia, aquí NO
 * hay interruptor: el descuento lo factura el proveedor y no es mérito de la
 * capa, así que no hay posición en la que entre en la base.
 *
 * La garantía, en el servidor: la comisión no se mueve ni un céntimo con un
 * carril nativo enorme, y el extracto no lee esas columnas en ningún sitio.
 */

function fila(day: string, extra?: Partial<FilaDiaria>): FilaDiaria {
  return {
    day,
    baseline_cost: 140,
    actual_cost: 110,
    requests: 100,
    measured_requests: 80,
    measured_baseline_cost: 100,
    measured_actual_cost: 60,
    ...extra,
  };
}

const FX = { eurPorUsd: 0.9, fuente: "BCE 2026-09-30 (test)" };
const base = { orgId: "org-1", periodo: "2026-09", esCalibracion: false, versionPrecios: "v", fx: FX };

describe("⛔ el ahorro nativo JAMÁS entra en la comisión (0032)", () => {
  it("con un carril nativo enorme, base, ahorro, comisión y cargo son idénticos al céntimo", () => {
    const sin = construirExtracto({ ...base, filas: [fila("2026-09-01"), fila("2026-09-02")] });
    const con = construirExtracto({
      ...base,
      filas: [
        // Enorme a propósito: si se colara en la base, la comisión saltaría de tramo.
        fila("2026-09-01", { native_cache_read_savings: 50_000, native_cache_write_premium: 1_000, native_requests: 900 }),
        fila("2026-09-02", { native_cache_read_savings: 75_000, native_cache_write_premium: 0, native_requests: 900 }),
      ],
    });
    expect(con).toEqual(sin);
    expect(con.comision).toEqual(sin.comision);
    expect(con.cargoEur).toBe(sin.cargoEur);
  });

  it("el extracto no nombra las columnas nativas fuera de su tipo (ninguna suma las lee)", () => {
    const fuente = readFileSync(new URL("./extracto.ts", import.meta.url), "utf8");
    const usos = fuente.split("\n").filter((l) => /native_/.test(l) && !/^\s*(native_[a-z_]+\?: number;|\/?\*)/.test(l));
    expect(usos).toEqual([]);
  });

  it("tampoco el cierre sellado ni la facturación leen el carril nativo", () => {
    for (const f of ["./cierre.ts", "./facturacion.ts", "./tarifa.ts", "./invariantes.ts"]) {
      const fuente = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(fuente, f).not.toMatch(/native_cache|nativeCache/);
    }
  });
});
