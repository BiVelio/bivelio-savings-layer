import { describe, it, expect } from "vitest";

import { deriveLicenseStatus, deriveVerdict, elegirLicencia } from "./derive";

/**
 * El panel de un producto que se vende como "verify-don't-trust" no puede
 * afirmar hechos que no ha medido. Estos son los tres que afirmaba.
 */

describe("cuál de las licencias describe la situación de la org", () => {
  const DIA = 86_400_000;
  const ahora = Date.UTC(2026, 7, 6);
  const enISO = (ms: number) => new Date(ms).toISOString();
  const viva = { expires_at: enISO(ahora + 30 * DIA), grace_days: 21, revoked: false };
  const revocada = { expires_at: enISO(ahora + 30 * DIA), grace_days: 21, revoked: true };
  const caducada = { expires_at: enISO(ahora - 90 * DIA), grace_days: 21, revoked: false };

  it("sin ninguna licencia, null", () => {
    expect(elegirLicencia([], ahora)).toBeNull();
  });

  it("una revocación sola SÍ se ve — era el estado invisible", () => {
    // La consulta filtraba `revoked = false`, así que una org con la licencia
    // revocada no devolvía ninguna fila y el panel la trataba como "nunca tuvo
    // licencia": le habíamos cortado el servicio a propósito y no se lo decíamos.
    expect(elegirLicencia([revocada], ahora)?.status).toBe("revoked");
  });

  it("una revocación ANTIGUA seguida de reemisión es un cliente sano", () => {
    expect(elegirLicencia([revocada, viva], ahora)?.status).toBe("active");
    expect(elegirLicencia([viva, revocada], ahora)?.status).toBe("active");
  });

  it("sin ninguna viva, una revocación explica más que una caducidad", () => {
    expect(elegirLicencia([caducada, revocada], ahora)?.status).toBe("revoked");
  });

  it("solo caducadas: caducada", () => {
    expect(elegirLicencia([caducada], ahora)?.status).toBe("expired");
  });

  it("una en gracia cuenta como viva", () => {
    const enGracia = { expires_at: enISO(ahora - 2 * DIA), grace_days: 21, revoked: false };
    expect(elegirLicencia([enGracia, revocada], ahora)?.status).toBe("grace");
  });

  it("devuelve la FILA elegida, no solo el estado (el panel necesita sus fechas)", () => {
    const elegida = elegirLicencia([revocada, viva], ahora);
    expect(elegida?.row).toBe(viva);
  });
});

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
    const v = deriveVerdict([{ requests: 1, baselineCost: 0, actualCost: 0 }]);
    expect(v.kind).toBe("unpriced");
    expect(v).not.toHaveProperty("net", 0);
  });

  it("una PÉRDIDA no se pinta de verde", () => {
    const v = deriveVerdict([{ requests: 1, baselineCost: 100, actualCost: 112 }]);
    expect(v).toMatchObject({ kind: "measured", tone: "neg" });
    if (v.kind === "measured") expect(v.net).toBeCloseTo(-0.12, 6);
  });

  it("un ahorro real se mide y se pinta en positivo", () => {
    const v = deriveVerdict([
      { requests: 1, baselineCost: 60, actualCost: 20 },
      { requests: 1, baselineCost: 40, actualCost: 20 },
    ]);
    expect(v).toMatchObject({ kind: "measured", tone: "pos" });
    if (v.kind === "measured") {
      expect(v.net).toBeCloseTo(0.6, 6);
      expect(v.saved).toBeCloseTo(60, 6);
    }
  });
});

describe("dinero medido vs estimado", () => {
  it("separa lo comprobable contra la factura de lo que solo está modelado", () => {
    // Tres peticiones: una MEDIDA (contador del proveedor) y dos evitadas, cuyo
    // baseline es necesariamente estimado porque la llamada nunca ocurrió.
    // Mezclarlas daba un 80%; lo verificable es un 40%.
    const v = deriveVerdict([
      { requests: 3, baselineCost: 0.30, actualCost: 0.06,
        measuredRequests: 1, measuredBaselineCost: 0.10, measuredActualCost: 0.06 },
    ]);
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.net).toBeCloseTo(0.80, 6);            // el total, como antes
    expect(v.measured).not.toBeNull();
    expect(v.measured!.net).toBeCloseTo(0.40, 6);  // lo comprobable
    expect(v.measured!.share).toBeCloseTo(1 / 3, 6);
  });

  it("sin nada medido, `measured` es null y no se inventa un cero", () => {
    const v = deriveVerdict([
      { requests: 2, baselineCost: 0.20, actualCost: 0, measuredRequests: 0,
        measuredBaselineCost: 0, measuredActualCost: 0 },
    ]);
    if (v.kind !== "measured") throw new Error("esperaba measured");
    expect(v.measured).toBeNull();
  });

  it("filas de un SDK antiguo (sin las columnas) no rompen el cálculo", () => {
    const v = deriveVerdict([{ requests: 1, baselineCost: 10, actualCost: 4 }]);
    if (v.kind !== "measured") throw new Error("esperaba measured");
    expect(v.net).toBeCloseTo(0.6, 6);
    expect(v.measured).toBeNull();
  });
});
