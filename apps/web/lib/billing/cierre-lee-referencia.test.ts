import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * VERJA POR GREP (0029): el cron del cierre selecciona columnas EXPLÍCITAS de
 * usage_daily. Si no lee las tres reference_*, `construirExtracto` recibe filas
 * sin el carril y el extracto SELLADO —inmutable— sale sin el dinero medido por
 * referencia, sin ningún error. Es la trampa que tarifa.ts ya avisaba para el
 * suelo de la elisión («el cron … selecciona columnas explícitas y no lee las
 * nuevas»).
 */
const ruta = readFileSync(new URL("../../app/api/cron/cierre-extractos/route.ts", import.meta.url), "utf8");

describe("el cierre lee y mapea el carril medido por referencia", () => {
  it("el SELECT de usage_daily incluye las tres columnas reference_*", () => {
    const m = /const COLUMNAS_USO =\s*"([^"]+)"/.exec(ruta);
    expect(m, "COLUMNAS_USO tiene que existir y ser un literal").not.toBeNull();
    const columnas = m![1]!.split(",").map((c) => c.trim());
    for (const col of [
      "measured_requests",
      "measured_baseline_cost",
      "measured_actual_cost",
      "reference_requests",
      "reference_baseline_cost",
      "reference_actual_cost",
    ]) {
      expect(columnas, col).toContain(col);
    }
    // Y ese SELECT es el primero que se intenta.
    expect(ruta).toContain("filas = await leerUso(COLUMNAS_USO);");
  });

  it("el mapeo a FilaDiaria pasa las tres columnas, normalizadas con Number", () => {
    for (const linea of [
      "reference_requests: Number(f.reference_requests ?? 0),",
      "reference_baseline_cost: Number(f.reference_baseline_cost ?? 0),",
      "reference_actual_cost: Number(f.reference_actual_cost ?? 0),",
    ]) {
      expect(ruta, linea).toContain(linea);
    }
  });

  it("el respaldo sin 0029 solo se activa ante «columna inexistente», y retira del upsert las cuatro columnas de extractos", () => {
    expect(ruta).toContain("if (!esColumnaInexistente(error as ErrorDePostgrest)) throw error;");
    expect(ruta).toContain('"requests_referencia", "base_referencia_usd", "ahorro_referencia_usd", "regla_referencia"');
    expect(ruta).toContain(".upsert(filasACerrar,");
  });
});
