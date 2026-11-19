import { describe, it, expect, vi } from "vitest";

import type { AdminClient } from "@/lib/supabase/admin";

/**
 * «¿ESTA ORGANIZACIÓN YA TIENE SU LICENCIA DE PAGO?» (W7, auditoría del
 * lanzamiento). La red de seguridad del webhook (`ensurePrimeraLicencia`) y la
 * renovación preguntan aquí. La gratuita «Medir» convive con la de pago y dura
 * años; mientras la consulta miraba solo `revoked = false`, la Medir contestaba
 * «sí» y quien venía del plan gratuito podía pagar y quedarse con la gratuita.
 *
 * El doble APLICA los filtros de verdad: quitar el `.neq("plan", "measure")`
 * tiene que romper esta prueba.
 */

vi.mock("./sign", () => ({ loadPrivateKey: () => "clave-de-prueba", signCompact: () => "token" }));

type Fila = { id: string; org_id: string; plan: string; seats: number; revoked: boolean; issued_at: string; expires_at: string };

const ORG = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
const OTRA = "6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b";
const medir: Fila = { id: "jti-medir", org_id: ORG, plan: "measure", seats: 1, revoked: false, issued_at: "2026-11-10T09:00:00Z", expires_at: "2036-11-10T09:00:00Z" };
const proVieja: Fila = { id: "jti-pro-vieja", org_id: ORG, plan: "pro", seats: 2, revoked: false, issued_at: "2026-10-01T09:00:00Z", expires_at: "2026-11-01T09:00:00Z" };
const proNueva: Fila = { id: "jti-pro-nueva", org_id: ORG, plan: "pro", seats: 3, revoked: false, issued_at: "2026-11-01T09:00:00Z", expires_at: "2026-12-01T09:00:00Z" };
const proRevocada: Fila = { id: "jti-pro-revocada", org_id: ORG, plan: "pro", seats: 2, revoked: true, issued_at: "2026-11-15T09:00:00Z", expires_at: "2026-12-15T09:00:00Z" };
const deOtraOrg: Fila = { id: "jti-ajena", org_id: OTRA, plan: "team", seats: 9, revoked: false, issued_at: "2026-11-18T09:00:00Z", expires_at: "2026-12-18T09:00:00Z" };

function adminCon(filas: Fila[]): AdminClient {
  return {
    from: (tabla: string) => {
      if (tabla !== "licenses") throw new Error(`tabla inesperada: ${tabla}`);
      let vistas = [...filas];
      let tope = Infinity;
      const q = {
        select: () => q,
        eq: (col: keyof Fila, val: unknown) => {
          vistas = vistas.filter((f) => f[col] === val);
          return q;
        },
        neq: (col: keyof Fila, val: unknown) => {
          vistas = vistas.filter((f) => f[col] !== val);
          return q;
        },
        order: (col: keyof Fila, opts?: { ascending?: boolean }) => {
          vistas.sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (opts?.ascending === false ? -1 : 1));
          return q;
        },
        limit: (n: number) => {
          tope = n;
          return q;
        },
        maybeSingle: async () => ({ data: vistas.slice(0, tope)[0] ?? null, error: null }),
      };
      return q;
    },
  } as unknown as AdminClient;
}

describe("currentPaidLicense / currentPaidLicenseJti — la gratuita Medir no cuenta", () => {
  it("⛔ con SOLO la Medir viva, la organización NO tiene licencia de pago", async () => {
    const { currentPaidLicense, currentPaidLicenseJti } = await import("./issue");
    expect(await currentPaidLicense(adminCon([medir, deOtraOrg]), ORG)).toBeNull();
    expect(await currentPaidLicenseJti(adminCon([medir, deOtraOrg]), ORG)).toBeNull();
  });

  it("⛔ con Medir (emitida después) y una de pago, devuelve la de PAGO", async () => {
    // La Medir puede ser la más reciente por `issued_at`: quien canceló volvió
    // a Medir y luego recompró, o la reclamó con la de pago ya emitida.
    const { currentPaidLicense, currentPaidLicenseJti } = await import("./issue");
    const filas = [medir, proVieja, proNueva];
    expect(await currentPaidLicense(adminCon(filas), ORG)).toEqual({
      jti: "jti-pro-nueva",
      seats: 3,
      expiresAt: "2026-12-01T09:00:00Z",
    });
    expect(await currentPaidLicenseJti(adminCon(filas), ORG)).toBe("jti-pro-nueva");
  });

  it("una de pago revocada sigue sin contar, y la de otra organización tampoco", async () => {
    const { currentPaidLicense } = await import("./issue");
    expect(await currentPaidLicense(adminCon([medir, proRevocada, deOtraOrg]), ORG)).toBeNull();
    expect((await currentPaidLicense(adminCon([proRevocada, proVieja]), ORG))?.jti).toBe("jti-pro-vieja");
  });
});
