import { describe, expect, it } from "vitest";
import {
  PREFS_VACIAS,
  alternar,
  esPorDefecto,
  guardar,
  leer,
  mover,
  normalizar,
  ocultasEfectivas,
  ordenar,
  visibles,
  type PanelPrefs,
} from "./panel-preferencias";

const DEF = ["ritmo", "tokens", "libros", "explorador", "trafico", "sesiones", "maquinas"];

describe("preferencias de disposición del panel", () => {
  it("sin preferencias, el orden es el por defecto y nada está oculto", () => {
    expect(visibles(DEF, PREFS_VACIAS)).toEqual(DEF);
    expect(ocultasEfectivas(DEF, PREFS_VACIAS)).toEqual([]);
    expect(esPorDefecto(PREFS_VACIAS)).toBe(true);
  });

  it("una tarjeta NUEVA del producto aparece aunque las prefs no la conozcan", () => {
    const prefs: PanelPrefs = { version: 1, orden: ["maquinas", "ritmo"], ocultas: [] };
    expect(ordenar(DEF, prefs)).toEqual(["maquinas", "ritmo", "tokens", "libros", "explorador", "trafico", "sesiones"]);
  });

  it("un id que ya no existe se ignora sin romper el orden", () => {
    const prefs: PanelPrefs = { version: 1, orden: ["fantasma", "tokens"], ocultas: ["otro-fantasma"] };
    expect(visibles(DEF, prefs)[0]).toBe("tokens");
    expect(ocultasEfectivas(DEF, prefs)).toEqual([]);
  });

  it("ocultar y volver a mostrar es idempotente y no toca el orden", () => {
    const a = alternar(DEF, PREFS_VACIAS, "trafico");
    expect(visibles(DEF, a)).not.toContain("trafico");
    expect(ocultasEfectivas(DEF, a)).toEqual(["trafico"]);
    const b = alternar(DEF, a, "trafico");
    expect(visibles(DEF, b)).toEqual(DEF);
    expect(alternar(DEF, PREFS_VACIAS, "no-existe")).toBe(PREFS_VACIAS);
  });

  it("mover intercambia con la vecina VISIBLE y respeta los extremos", () => {
    const oculta = alternar(DEF, PREFS_VACIAS, "tokens");
    const subida = mover(DEF, oculta, "libros", -1);
    // «libros» salta por encima de «ritmo»: «tokens» está oculta y no cuenta.
    expect(visibles(DEF, subida)).toEqual(["libros", "ritmo", "explorador", "trafico", "sesiones", "maquinas"]);
    expect(mover(DEF, subida, "libros", -1)).toBe(subida);
    expect(mover(DEF, PREFS_VACIAS, "maquinas", 1)).toBe(PREFS_VACIAS);
    // Al mostrar «tokens» de nuevo vuelve a su sitio, no al final.
    expect(visibles(DEF, alternar(DEF, subida, "tokens"))).toEqual(["libros", "tokens", "ritmo", "explorador", "trafico", "sesiones", "maquinas"]);
  });

  it("normaliza cualquier basura del almacén a algo seguro", () => {
    expect(normalizar(null)).toEqual(PREFS_VACIAS);
    expect(normalizar("x")).toEqual(PREFS_VACIAS);
    expect(normalizar({ orden: ["a", 3, null], ocultas: "no" })).toEqual({ version: 1, orden: ["a"], ocultas: [] });
    expect(normalizar({ orden: Array(200).fill("a") }).orden).toHaveLength(50);
  });

  it("lee tolerante y guarda quitando la clave cuando todo es por defecto", () => {
    const mem = new Map<string, string>();
    const almacen = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    expect(leer(undefined)).toEqual(PREFS_VACIAS);
    expect(leer({ getItem: () => "{no es json" })).toEqual(PREFS_VACIAS);
    expect(leer({ getItem: () => { throw new Error("denegado"); } })).toEqual(PREFS_VACIAS);
    guardar(almacen, alternar(DEF, PREFS_VACIAS, "ritmo"));
    expect(mem.size).toBe(1);
    expect(leer(almacen).ocultas).toEqual(["ritmo"]);
    guardar(almacen, PREFS_VACIAS);
    expect(mem.size).toBe(0);
  });
});
