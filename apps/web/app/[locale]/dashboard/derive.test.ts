import { describe, it, expect } from "vitest";

import { deriveLicenseStatus, deriveVerdict } from "./derive";

/**
 * El panel de un producto que se vende como "verify-don't-trust" no puede
 * afirmar hechos que no ha medido. Estos son los tres que afirmaba.
 */

describe("estado de licencia", () => {
  const DIA = 86_400_000;
  const ahora = Date.UTC(2026, 7, 6);
  const enISO = (ms: number) => new Date(ms).toISOString();

  it("sin fila de licencia devuelve null — AUSENCIA medida, no 'activa'", () => {
    // El bug: `licensed = ctx.license?.status === "active" || ctx.org != null`.
    // ctx.license nunca se rellenaba, así que decidía el `||`: bastaba con que
    // existiera la organización, y esa fila la crea el endpoint de claves. Pulsar
    // "crear clave de servicio" encendía "License active" sin licencia alguna.
    expect(deriveLicenseStatus(null, ahora)).toBeNull();
    expect(deriveLicenseStatus({}, ahora)).toBeNull();
  });

  it("una licencia vigente es 'active'", () => {
    expect(deriveLicenseStatus({ expires_at: enISO(ahora + 30 * DIA), grace_days: 14 }, ahora)).toBe("active");
  });

  it("una revocada nunca es 'active', aunque no haya expirado", () => {
    expect(
      deriveLicenseStatus({ expires_at: enISO(ahora + 30 * DIA), grace_days: 14, revoked: true }, ahora),
    ).toBe("revoked");
  });

  it("distingue gracia de expirada", () => {
    const caducada = { expires_at: enISO(ahora - 2 * DIA) };
    expect(deriveLicenseStatus({ ...caducada, grace_days: 14 }, ahora)).toBe("grace");
    expect(deriveLicenseStatus({ ...caducada, grace_days: 0 }, ahora)).toBe("expired");
  });

  it("las fronteras exactas caen del lado generoso", () => {
    const expira = ahora;
    expect(deriveLicenseStatus({ expires_at: enISO(expira), grace_days: 3 }, ahora)).toBe("active");
    expect(deriveLicenseStatus({ expires_at: enISO(expira - 3 * DIA), grace_days: 3 }, ahora)).toBe("grace");
  });
});

describe("titular de ahorro", () => {
  it("sin tráfico medido no hay número, y ese estado es propio", () => {
    expect(deriveVerdict([])).toEqual({ kind: "empty" });
  });

  it("con filas pero SIN baseline no fabrica un 0.0% en verde", () => {
    // El cálculo era `net = baseline > 0 ? 1 - actual/baseline : 0` y la clase
    // `pos` estaba fija: salía "0.0%" en verde, que es exactamente el cero
    // fabricado que el comentario del componente promete no pintar jamás.
    const v = deriveVerdict([{ baselineCost: 0, actualCost: 0 }]);
    expect(v.kind).toBe("unpriced");
    expect(v).not.toHaveProperty("net", 0);
  });

  it("una PÉRDIDA no se pinta de verde", () => {
    const v = deriveVerdict([{ baselineCost: 100, actualCost: 112 }]);
    expect(v).toMatchObject({ kind: "measured", tone: "neg" });
    if (v.kind === "measured") expect(v.net).toBeCloseTo(-0.12, 6);
  });

  it("un ahorro real se mide y se pinta en positivo", () => {
    const v = deriveVerdict([
      { baselineCost: 60, actualCost: 20 },
      { baselineCost: 40, actualCost: 20 },
    ]);
    expect(v).toMatchObject({ kind: "measured", tone: "pos" });
    if (v.kind === "measured") {
      expect(v.net).toBeCloseTo(0.6, 6);
      expect(v.saved).toBeCloseTo(60, 6);
    }
  });
});
