import { describe, it, expect } from "vitest";

import { revokeLicensesForSubscription } from "./issue";

/**
 * Revocar por SUSCRIPCIÓN, no por org.
 *
 * Al cancelar una suscripción duplicada, revocar todas las licencias de la org
 * apagaba la flota entera aunque le quedara otra suscripción activa. Este helper
 * acota la revocación a las licencias de UNA suscripción (por `subscription_id`).
 */

type Licencia = { id: string; subscription_id: string | null; revoked: boolean };

/** Fake admin mínimo: licenses filtrable por subscription_id + revoked, y un
 *  registro de qué jtis se inscribieron en el ledger de revocaciones. */
function fakeAdmin(licencias: Licencia[]) {
  const revocadas: string[] = [];
  const marcadasRevoked: string[] = [];
  const from = (tabla: string) => {
    const filtros: { col: string; val: unknown }[] = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      filtros.push({ col, val });
      return q;
    };
    q.upsert = (fila: { jti: string }) => {
      if (tabla === "revocations") revocadas.push(fila.jti);
      return { error: null };
    };
    q.update = (fila: Record<string, unknown>) => {
      const q2: Record<string, unknown> = {};
      q2.eq = (_col: string, jti: string) => {
        if (tabla === "licenses" && fila.revoked === true) marcadasRevoked.push(jti);
        return { error: null };
      };
      return q2;
    };
    // Terminal de lista: filtra las licencias por los `.eq(...)` registrados.
    (q as { then?: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const data = tabla === "licenses"
        ? licencias.filter((l) => filtros.every((f) => (l as Record<string, unknown>)[f.col] === f.val)).map((l) => ({ id: l.id }))
        : [];
      return resolve({ data, error: null });
    };
    return q;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: { from } as any, revocadas, marcadasRevoked };
}

describe("revokeLicensesForSubscription", () => {
  it("revoca solo las licencias vivas de ESA suscripción, no las de otra", async () => {
    const { admin, revocadas, marcadasRevoked } = fakeAdmin([
      { id: "lic-A1", subscription_id: "sub-A", revoked: false },
      { id: "lic-A2", subscription_id: "sub-A", revoked: false },
      { id: "lic-B1", subscription_id: "sub-B", revoked: false }, // otra suscripción: intacta
      { id: "lic-A3", subscription_id: "sub-A", revoked: true },  // ya revocada: no se re-toca
    ]);
    const ids = await revokeLicensesForSubscription(admin, "sub-A", "duplicada cancelada");
    expect(ids.sort()).toEqual(["lic-A1", "lic-A2"]);
    expect(revocadas.sort()).toEqual(["lic-A1", "lic-A2"]);
    expect(marcadasRevoked.sort()).toEqual(["lic-A1", "lic-A2"]);
    // La de la otra suscripción NO se tocó.
    expect(revocadas).not.toContain("lic-B1");
  });

  it("sin licencias para la suscripción, no revoca nada", async () => {
    const { admin, revocadas } = fakeAdmin([{ id: "lic-B1", subscription_id: "sub-B", revoked: false }]);
    const ids = await revokeLicensesForSubscription(admin, "sub-A", "x");
    expect(ids).toEqual([]);
    expect(revocadas).toEqual([]);
  });
});
