import { describe, expect, it } from "vitest";

import type { StepState } from "@/app/[locale]/dashboard/data";

import { progressPercent, setupProgress } from "./progress";

const pasos = (estados: StepState["status"][]): StepState[] =>
  estados.map((status, i) => ({ id: `s${i}`, label: `Paso ${i + 1}`, status }));

describe("puesta en marcha (bloque del raíl)", () => {
  it("cuenta los hechos, no encoge el total y nombra el primero que falta", () => {
    const p = setupProgress(pasos(["done", "done", "current", "pending", "pending"]), false);
    expect(p).toMatchObject({ readable: true, done: 2, total: 5, firstPending: "Paso 3" });
    expect(progressPercent(p)).toBe(40);
  });

  it("con todo hecho no hay «Falta: …»", () => {
    const p = setupProgress(pasos(["done", "done", "done", "done", "done"]), false);
    expect(p.firstPending).toBeNull();
    expect(progressPercent(p)).toBe(100);
  });

  it("NUNCA pinta un «0 de 5» por un fallo: si la lectura de uso falló, no hay bloque", () => {
    const p = setupProgress(pasos(["done", "done", "current", "pending", "pending"]), true);
    expect(p.readable).toBe(false);
    expect(p.steps).toEqual([]);
    expect(p.done).toBe(0);
    expect(p.total).toBe(5);
    expect(progressPercent(p)).toBe(0);
  });
});
