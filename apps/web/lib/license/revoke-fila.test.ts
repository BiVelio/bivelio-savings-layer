import { describe, it, expect, vi } from "vitest";

import type { AdminClient } from "@/lib/supabase/admin";

/**
 * revokeLicense escribe el LEDGER primero (de él depende el SDK del cliente) y
 * DESPUÉS marca `licenses.revoked = true`. De esa COLUMNA dependen los dos
 * candados de SERVIDOR (`/api/license/current` y la ingesta de metering), así
 * que su fallo NO puede tragarse: antes devolvía 200 mientras el servidor seguía
 * sirviendo. Ahora reintenta y, si persiste, LANZA (fail-closed).
 */

vi.mock("./sign", () => ({ loadPrivateKey: () => "k", signCompact: () => "t" }));

/** Un admin doble: el upsert del ledger siempre va bien; el update de la fila
 *  falla las primeras `fallosUpdate` veces y luego funciona. */
function adminDoble(fallosUpdate: number) {
  let updates = 0;
  let ledgerUpserts = 0;
  const admin = {
    from: (tabla: string) => {
      if (tabla === "revocations") {
        return { upsert: async () => { ledgerUpserts++; return { error: null }; } };
      }
      if (tabla === "licenses") {
        return {
          update: () => ({
            eq: async () => {
              updates++;
              return { error: updates <= fallosUpdate ? { message: "update falló", code: "XX000" } : null };
            },
          }),
        };
      }
      throw new Error(`tabla inesperada: ${tabla}`);
    },
  } as unknown as AdminClient;
  return { admin, updates: () => updates, ledgerUpserts: () => ledgerUpserts };
}

describe("revokeLicense — la columna revoked no se traga si falla", () => {
  it("caso feliz: ledger + fila, sin lanzar", async () => {
    const d = adminDoble(0);
    const { revokeLicense } = await import("./issue");
    await expect(revokeLicense(d.admin, "jti-1", "fraude")).resolves.toBeUndefined();
    expect(d.ledgerUpserts()).toBe(1);
    expect(d.updates()).toBe(1);
  });

  it("se auto-cura si el update falla una vez y luego funciona (no lanza)", async () => {
    const d = adminDoble(1);
    const { revokeLicense } = await import("./issue");
    await expect(revokeLicense(d.admin, "jti-2", "fraude")).resolves.toBeUndefined();
    expect(d.updates()).toBe(2); // reintentó
  });

  it("⛔ si el update falla SIEMPRE, LANZA (fail-closed: el servidor no puede quedar sirviendo)", async () => {
    const d = adminDoble(99);
    const { revokeLicense } = await import("./issue");
    await expect(revokeLicense(d.admin, "jti-3", "fraude")).rejects.toBeTruthy();
    expect(d.ledgerUpserts()).toBe(1); // el ledger SÍ quedó (el SDK del cliente ya se para)
    expect(d.updates()).toBe(3); // agotó los reintentos
  });

  it("⛔ si el LEDGER falla, lanza antes de tocar la fila", async () => {
    const admin = {
      from: (tabla: string) =>
        tabla === "revocations"
          ? { upsert: async () => ({ error: { message: "ledger caído" } }) }
          : { update: () => ({ eq: async () => { throw new Error("no debería llegar aquí"); } }) },
    } as unknown as AdminClient;
    const { revokeLicense } = await import("./issue");
    await expect(revokeLicense(admin, "jti-4", "fraude")).rejects.toBeTruthy();
  });
});
