import { describe, expect, it } from "vitest";
import { RANGO_POR_DEFECTO, rangoDesdeParametro } from "./rango";

describe("el rango del panel desde la URL", () => {
  it("acepta solo los tres rangos que la consulta puede servir", () => {
    expect(rangoDesdeParametro("30")).toBe(30);
    expect(rangoDesdeParametro("90")).toBe(90);
    expect(rangoDesdeParametro("120")).toBe(120);
    expect(rangoDesdeParametro(["90", "30"])).toBe(90);
  });

  it("cualquier otra cosa cae al por defecto, sin excepción ni 0", () => {
    for (const v of [undefined, "", "all", "7", "365", "abc", "-30", "3e1"]) {
      expect(rangoDesdeParametro(v)).toBe(RANGO_POR_DEFECTO);
    }
  });
});
