import { describe, it, expect } from "vitest";

import {
  DIAS_DE_RETENCION,
  DIAS_DE_RETENCION_REFERENCIAS,
  DIAS_DE_RETENCION_VERIFICACION,
  fechaDeCorte,
  fechaDeCorteReferencias,
  fechaDeCorteVerificacion,
} from "./retencion";

describe("retención de usage_ingest_seen", () => {
  it("el corte son 30 días exactos antes de ahora, en UTC", () => {
    expect(DIAS_DE_RETENCION).toBe(30);
    expect(fechaDeCorte(new Date("2026-10-01T05:45:00.000Z"))).toBe("2026-09-01T05:45:00.000Z");
  });
  it("una retención de 0 o negativa se rechaza: borraría todo lo que aún protege de duplicados", () => {
    expect(() => fechaDeCorte(new Date(), 0)).toThrow();
    expect(() => fechaDeCorte(new Date(), -3)).toThrow();
    expect(() => fechaDeCorte(new Date(), 1.5)).toThrow();
  });
});

describe("retención de reference_hits (0029)", () => {
  it("≈ 15 meses: 460 días antes de hoy, como día UTC (la columna es `day`)", () => {
    expect(DIAS_DE_RETENCION_REFERENCIAS).toBe(460);
    expect(fechaDeCorteReferencias(new Date("2027-12-01T05:45:00.000Z"))).toBe("2026-08-28");
  });
  it("devuelve una FECHA, no una marca de tiempo: se compara con `day`", () => {
    expect(fechaDeCorteReferencias(new Date("2026-10-01T23:59:59.000Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("una retención de 0 o negativa se rechaza: borraría el CSV del período en curso", () => {
    expect(() => fechaDeCorteReferencias(new Date(), 0)).toThrow();
    expect(() => fechaDeCorteReferencias(new Date(), -1)).toThrow();
  });
  it("es más larga que la de idempotencia: el CSV tiene que sobrevivir al cierre del año", () => {
    expect(DIAS_DE_RETENCION_REFERENCIAS).toBeGreaterThan(365);
  });
});

describe("retención de «tu propio banco» (0030)", () => {
  it("180 días, como día UTC", () => {
    expect(DIAS_DE_RETENCION_VERIFICACION).toBe(180);
    expect(fechaDeCorteVerificacion(new Date("2026-09-25T05:45:00.000Z"))).toBe("2026-03-29");
  });
  it("una retención de 0 o negativa se rechaza", () => {
    expect(() => fechaDeCorteVerificacion(new Date(), 0)).toThrow();
    expect(() => fechaDeCorteVerificacion(new Date(), -3)).toThrow();
  });
});
