import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { partirEnLaPausa } from "./components/CabeceraDeSeccion";
import { diasDelMosaico, escalaDeTeselas } from "./components/MosaicoDeLlamadas";
import type { UsageRollup } from "./data";

/**
 * EL MOSAICO DE LLAMADAS Y LA CABECERA PARTIDA DEL RESUMEN (Firma de campaña,
 * 2026-11-17). El mosaico no calcula nada nuevo: pinta por día las dos
 * columnas que ya suma la tarjeta «Tráfico». Lo que se vigila aquí es que no
 * invente: un día sin fila es un hueco, la escala que dice el pie es la que
 * se pinta, y el titular partido no cambia una letra en ningún idioma.
 */

const fila = (day: string, avoidedLlm: number, actualLlm: number) => ({ day, avoidedLlm, actualLlm }) as UsageRollup;

describe("los días del mosaico", () => {
  it("un día sin fila es un hueco (null), no un cero", () => {
    const dias = diasDelMosaico([fila("2026-11-01", 2, 8), fila("2026-11-03", 0, 0)]);
    expect(dias.map((d) => d.day)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(dias[1]).toEqual({ day: "2026-11-02", sinProveedor: null, ejecutadas: null });
    // Un día CON fila y sin llamadas sí es un cero medido.
    expect(dias[2]).toEqual({ day: "2026-11-03", sinProveedor: 0, ejecutadas: 0 });
  });

  it("suma las filas del mismo día y da los mismos totales que la tarjeta «Tráfico»", () => {
    const uso = [fila("2026-11-01", 2, 8), fila("2026-11-01", 1, 4), fila("2026-11-02", 5, 5)];
    const dias = diasDelMosaico(uso);
    expect(dias[0]).toEqual({ day: "2026-11-01", sinProveedor: 3, ejecutadas: 12 });
    const total = (k: "sinProveedor" | "ejecutadas") => dias.reduce((n, d) => n + (d[k] ?? 0), 0);
    expect(total("sinProveedor")).toBe(uso.reduce((n, r) => n + r.avoidedLlm, 0));
    expect(total("ejecutadas")).toBe(uso.reduce((n, r) => n + r.actualLlm, 0));
  });

  it("sin filas, nada", () => {
    expect(diasDelMosaico([])).toEqual([]);
  });
});

describe("la escala de las teselas", () => {
  it("es la menor escala redonda que deja la columna más alta en 24 teselas", () => {
    expect(escalaDeTeselas(0)).toBe(1);
    expect(escalaDeTeselas(24)).toBe(1);
    expect(escalaDeTeselas(25)).toBe(2);
    expect(escalaDeTeselas(48)).toBe(2);
    expect(escalaDeTeselas(49)).toBe(5);
    expect(escalaDeTeselas(500)).toBe(25);
    expect(escalaDeTeselas(601)).toBe(50);
    expect(escalaDeTeselas(1_000_000)).toBe(50_000);
  });
});

describe("el titular de sección partido en su pausa", () => {
  const DIR = new URL("../../../messages/", import.meta.url).pathname;
  const IDIOMAS = ["es", "en", "ca", "fr", "de", "it", "pt", "nl", "pl", "tr", "id", "vi"];

  it("se parte en los doce idiomas sin cambiar una letra", () => {
    for (const l of IDIOMAS) {
      const titulo: string = JSON.parse(readFileSync(`${DIR}${l}.json`, "utf8")).dashboard.overview.savingsTitle;
      const p = partirEnLaPausa(titulo);
      expect(p, l).not.toBeNull();
      expect(p!.antes + p!.pausa + p!.despues, l).toBe(titulo);
    }
  });

  it("sin pausa, no se parte", () => {
    expect(partirEnLaPausa("Tu medidor")).toBeNull();
  });
});
