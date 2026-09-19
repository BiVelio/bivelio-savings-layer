import { describe, expect, it } from "vitest";
import { aCsv, nombreDeFichero } from "./explorer-exportar";
import type { Ranura } from "./explorer-estadisticas";

const ranuras: Ranura[] = [
  { day: "2026-09-01", valor: 1.5, conDatos: true },
  { day: "2026-09-02", valor: 0, conDatos: false },
  { day: "2026-09-03", valor: -0.25, conDatos: true },
];

describe("exportación CSV del explorador", () => {
  const meta = { metrica: "neto", periodoDias: 30, modo: "dia" as const, origen: "bvsala.usage_daily", generadoEn: "2026-09-19T00:00:00.000Z" };

  it("lleva la procedencia en cabecera y una fila por ranura", () => {
    const csv = aCsv(ranuras, ranuras.map((r) => r.valor), meta);
    expect(csv.split("\n").slice(0, 6)).toEqual([
      "# metric=neto",
      "# period_days=30",
      "# mode=dia",
      "# source=bvsala.usage_daily",
      "# generated_at=2026-09-19T00:00:00.000Z",
      "day,value,measured",
    ]);
    expect(csv).toContain("2026-09-01,1.5,yes\n");
    expect(csv).toContain("2026-09-03,-0.25,yes\n");
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("un día sin fila sale VACÍO y marcado, jamás como 0", () => {
    const csv = aCsv(ranuras, ranuras.map((r) => r.valor), meta);
    expect(csv).toContain("2026-09-02,,no\n");
    expect(csv).not.toContain("2026-09-02,0,");
  });

  it("en modo acumulado exporta la serie acumulada que se pinta, no el valor del día", () => {
    const acumulada = [1.5, 1.5, 1.25];
    const csv = aCsv(ranuras, acumulada, { ...meta, modo: "acumulado" });
    expect(csv).toContain("2026-09-03,1.25,yes");
  });

  it("entrecomilla lo que lleve coma o comillas", () => {
    const csv = aCsv([{ day: 'a,"b"', valor: 1, conDatos: true }], [1], meta);
    expect(csv).toContain('"a,""b""",1,yes');
  });

  it("el nombre del fichero lleva métrica y extremos del rango", () => {
    expect(nombreDeFichero(ranuras, "neto")).toBe("bvsala-neto-2026-09-01_2026-09-03.csv");
    expect(nombreDeFichero([], "neto")).toBe("bvsala-neto-sin-datos_sin-datos.csv");
  });
});
