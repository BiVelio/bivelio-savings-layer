import { describe, it, expect } from "vitest";

import { deriveElisionProveedor, deriveLicenseStatus, deriveSombra, deriveTokens, deriveVerdict, elegirLicencia } from "./derive";

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
    const v = deriveVerdict([
      { requests: 1, baselineCost: 100, actualCost: 112,
        measuredRequests: 1, measuredBaselineCost: 100, measuredActualCost: 112 },
    ]);
    expect(v).toMatchObject({ kind: "measured", tone: "neg" });
    if (v.kind === "measured") expect(v.net).toBeCloseTo(-0.12, 6);
  });

  it("un ahorro real se mide y se pinta en positivo", () => {
    const v = deriveVerdict([
      { requests: 1, baselineCost: 60, actualCost: 20,
        measuredRequests: 1, measuredBaselineCost: 60, measuredActualCost: 20 },
      { requests: 1, baselineCost: 40, actualCost: 20,
        measuredRequests: 1, measuredBaselineCost: 40, measuredActualCost: 20 },
    ]);
    expect(v).toMatchObject({ kind: "measured", tone: "pos" });
    if (v.kind === "measured") {
      expect(v.net).toBeCloseTo(0.6, 6);
      expect(v.saved).toBeCloseTo(60, 6);
      // Todo medido: no hay total que añadir, sería ruido.
      expect(v.total).toBeNull();
      expect(v.share).toBeCloseTo(1, 6);
    }
  });
});

describe("EL TITULAR ES LO MEDIDO (jerarquía invertida el 2026-09-10)", () => {
  it("el titular dice lo COMPROBABLE, y el total pasa a ser el contexto", () => {
    // Tres peticiones: una MEDIDA (contador del proveedor) y dos evitadas, cuyo
    // baseline es necesariamente estimado porque la llamada nunca ocurrió.
    //
    // Este es EL caso del arreglo. Antes el titular era el 80 % —el total— y lo
    // comprobable, un 40 %, colgaba de un campo opcional; encima de ese 80 % el
    // panel escribía «Tu ahorro · medido». Ahora el titular ES el 40 % y el 80 %
    // baja a contexto.
    const v = deriveVerdict([
      { requests: 3, baselineCost: 0.30, actualCost: 0.06,
        measuredRequests: 1, measuredBaselineCost: 0.10, measuredActualCost: 0.06 },
    ]);
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.net).toBeCloseTo(0.40, 6);            // ← el titular: lo comprobable
    expect(v.saved).toBeCloseTo(0.04, 6);
    expect(v.share).toBeCloseTo(1 / 3, 6);
    expect(v.total).not.toBeNull();
    expect(v.total!.net).toBeCloseTo(0.80, 6);     // ← el total, como contexto
    expect(v.total!.saved).toBeCloseTo(0.24, 6);
  });

  it("⛔ sin NADA medido el titular no cae al total: es su propio estado", () => {
    // Antes esto devolvía `measured` con net = 1 (¡el 100 %!) y `measured: null`,
    // y el panel pintaba ese 100 % bajo el rótulo «medido». Cero comprobable.
    const v = deriveVerdict([
      { requests: 2, baselineCost: 0.20, actualCost: 0, measuredRequests: 0,
        measuredBaselineCost: 0, measuredActualCost: 0 },
    ]);
    expect(v).toEqual({ kind: "sin_medir", requests: 2 });
  });

  it("filas de un SDK antiguo (sin las columnas) tampoco caen al total", () => {
    const v = deriveVerdict([{ requests: 1, baselineCost: 10, actualCost: 4 }]);
    expect(v).toEqual({ kind: "sin_medir", requests: 1 });
  });

  it("con todo medido el total se calla: repetir la misma cifra es ruido", () => {
    const v = deriveVerdict([
      { requests: 4, baselineCost: 10, actualCost: 8,
        measuredRequests: 4, measuredBaselineCost: 10, measuredActualCost: 8 },
    ]);
    if (v.kind !== "measured") throw new Error("esperaba measured");
    expect(v.net).toBeCloseTo(0.2, 6);
    expect(v.total).toBeNull();
  });

  it("el caso de HOY en producción: todo medido, la cifra no se mueve", () => {
    // Los 10 días reales, redondeados: measured_* == total en las tres columnas.
    const v = deriveVerdict([
      { requests: 20848, baselineCost: 4330.214529, actualCost: 4279.309526,
        measuredRequests: 20848, measuredBaselineCost: 4330.214529, measuredActualCost: 4279.309526 },
    ]);
    if (v.kind !== "measured") throw new Error("esperaba measured");
    expect(v.net).toBeCloseTo(0.011756, 6);
    expect(v.saved).toBeCloseTo(50.905003, 6);
    expect(v.total).toBeNull();
  });
});

describe("el carril sombra (0021) — hipotético, con derivador propio", () => {
  it("⛔ la sombra NO toca el Verdict: mismo titular con y sin columnas de sombra", () => {
    const fila = { requests: 2, baselineCost: 0.2, actualCost: 0.1, measuredRequests: 2, measuredBaselineCost: 0.2, measuredActualCost: 0.1 };
    const sin = deriveVerdict([fila]);
    const con = deriveVerdict([{ ...fila, shadowRequests: 99, shadowBaselineCost: 5, shadowActualCost: 1 }]);
    expect(con).toEqual(sin);
  });

  it("agrega el carril y el neto puede salir NEGATIVO (v2 lo demostró)", () => {
    const s = deriveSombra([
      { requests: 1, baselineCost: 1, actualCost: 1, shadowRequests: 3, shadowBaselineCost: 10, shadowActualCost: 8 },
      { requests: 1, baselineCost: 1, actualCost: 1, shadowRequests: 2, shadowBaselineCost: 10, shadowActualCost: 16 },
    ]);
    if (s.kind !== "ok") throw new Error("esperaba ok");
    expect(s.requests).toBe(5);
    expect(s.savedUsd).toBeCloseTo(-4, 6);
    expect(s.net).toBeCloseTo(-0.2, 6);
    expect(s.tone).toBe("neg");
  });

  it("sin datos de sombra, 'none' — la tarjeta no existe (nada de ceros fabricados)", () => {
    expect(deriveSombra([{ requests: 1, baselineCost: 1, actualCost: 1 }]).kind).toBe("none");
    expect(deriveSombra([]).kind).toBe("none");
    // Peticiones sin base simulada tampoco pintan nada.
    expect(deriveSombra([{ requests: 1, baselineCost: 1, actualCost: 1, shadowRequests: 2, shadowBaselineCost: 0, shadowActualCost: 0 }]).kind).toBe("none");
  });
});

describe("el carril del borrado del proveedor (0025) — conteo del proveedor, con derivador propio", () => {
  const fila = {
    requests: 2, baselineCost: 0.2, actualCost: 0.1,
    measuredRequests: 2, measuredBaselineCost: 0.2, measuredActualCost: 0.1,
    baselineInputTokens: 1_000, actualInputTokens: 800, baselineOutputTokens: 10, actualOutputTokens: 10,
  };
  const conCarril = { ...fila, eliminatedInputTokens: 50_000, eliminatedFloorCost: 0.0125, eliminatedCreditedRequests: 1 };

  it("⛔ NO toca el Verdict: mismo titular con y sin las columnas de 0025", () => {
    expect(deriveVerdict([conCarril])).toEqual(deriveVerdict([fila]));
  });

  it("⛔ NO toca los tokens ni la sombra", () => {
    expect(deriveTokens([conCarril])).toEqual(deriveTokens([fila]));
    expect(deriveSombra([conCarril])).toEqual(deriveSombra([fila]));
  });

  it("agrega acreditadas y el suelo (que viaja pero no se pinta); NO expone tokens: columna compartida SDK+gateway", () => {
    const e = deriveElisionProveedor([
      conCarril,
      { ...conCarril, eliminatedInputTokens: 10_000, eliminatedFloorCost: 0.0025, eliminatedCreditedRequests: 3 },
    ]);
    if (e.kind !== "ok") throw new Error("esperaba ok");
    expect(e.requests).toBe(4);
    expect("tokens" in e).toBe(false);
    expect(e.floorUsd).toBeCloseTo(0.015, 9);
  });

  it("sin acreditadas, 'none' — la tarjeta no existe (columnas ausentes, o presentes a cero)", () => {
    expect(deriveElisionProveedor([fila]).kind).toBe("none");
    expect(deriveElisionProveedor([]).kind).toBe("none");
    // Tokens borrados por el proveedor SIN acreditadas (diales del cliente, no
    // los nuestros): no es nuestro y no se pinta.
    expect(deriveElisionProveedor([{ ...fila, eliminatedInputTokens: 9_999, eliminatedFloorCost: 0, eliminatedCreditedRequests: 0 }]).kind).toBe("none");
  });
});

describe("el carril MEDIDO POR REFERENCIA (0029) — suma al titular bajo COMISIONAR_REFERENCIA", () => {
  it("solo referencia → titular medido: la repetición tiene contador (el de la idéntica que corrió)", () => {
    // 4 peticiones: 2 repeticiones por referencia (0,06 USD de baseline, coste 0)
    // y 2 estimadas. Nada medido por su propio contador.
    const v = deriveVerdict([
      { requests: 4, baselineCost: 0.1, actualCost: 0.02,
        measuredRequests: 0, measuredBaselineCost: 0, measuredActualCost: 0,
        referenceRequests: 2, referenceBaselineCost: 0.06, referenceActualCost: 0 },
    ]);
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.net).toBeCloseTo(1, 6);
    expect(v.saved).toBeCloseTo(0.06, 6);
    expect(v.share).toBeCloseTo(0.5, 6);
    expect(v.byReference).toEqual({ requests: 2, saved: 0.06 });
    expect(v.total).not.toBeNull();
  });

  it("medido + referencia se SUMAN en el titular, y byReference dice cuánto viene de la referencia", () => {
    const v = deriveVerdict([
      { requests: 3, baselineCost: 0.16, actualCost: 0.06,
        measuredRequests: 1, measuredBaselineCost: 0.10, measuredActualCost: 0.06,
        referenceRequests: 2, referenceBaselineCost: 0.06, referenceActualCost: 0 },
    ]);
    if (v.kind !== "measured") throw new Error("esperaba measured");
    expect(v.saved).toBeCloseTo(0.10, 6);           // 0,04 medido + 0,06 por referencia
    expect(v.net).toBeCloseTo(0.10 / 0.16, 6);
    expect(v.share).toBeCloseTo(1, 6);              // las tres tienen contador del proveedor
    expect(v.byReference!.requests).toBe(2);
    expect(v.byReference!.saved).toBeCloseTo(0.06, 6);
    // Todo medido (por su contador o por referencia): el total se calla.
    expect(v.total).toBeNull();
  });

  it("sin nada medido ni por referencia → sin_medir", () => {
    const v = deriveVerdict([
      { requests: 2, baselineCost: 0.2, actualCost: 0,
        measuredRequests: 0, measuredBaselineCost: 0, measuredActualCost: 0,
        referenceRequests: 0, referenceBaselineCost: 0, referenceActualCost: 0 },
    ]);
    expect(v).toEqual({ kind: "sin_medir", requests: 2 });
  });

  it("sin las columnas de 0029 → byReference null y el titular de siempre", () => {
    const fila = { requests: 2, baselineCost: 0.2, actualCost: 0.1, measuredRequests: 2, measuredBaselineCost: 0.2, measuredActualCost: 0.1 };
    const v = deriveVerdict([fila]);
    if (v.kind !== "measured") throw new Error("esperaba measured");
    expect(v.byReference).toBeNull();
    expect(v.net).toBeCloseTo(0.5, 6);
  });

  it("⛔ la referencia NO toca los tokens (deriveTokens no cambia)", () => {
    const fila = {
      requests: 2, baselineCost: 0.2, actualCost: 0.1,
      measuredRequests: 2, measuredBaselineCost: 0.2, measuredActualCost: 0.1,
      baselineInputTokens: 1_000, actualInputTokens: 800, baselineOutputTokens: 10, actualOutputTokens: 10,
    };
    expect(deriveTokens([{ ...fila, referenceRequests: 5, referenceBaselineCost: 0.3, referenceActualCost: 0 }])).toEqual(
      deriveTokens([fila]),
    );
  });
});
