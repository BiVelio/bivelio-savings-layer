import { describe, it, expect } from "vitest";

import { DIAS_DE_RETENCION, fechaDeCorte } from "./retencion";

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
