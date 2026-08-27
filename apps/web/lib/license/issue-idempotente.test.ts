import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AdminClient } from "@/lib/supabase/admin";

/**
 * LA EMISIÓN ES IDEMPOTENTE ANTE EL CANDADO DE 0018. La carrera de webhooks
 * (varios manejadores emitiendo la primera licencia a la vez) choca con el
 * índice único parcial (org, expires_at, seats) viva; el perdedor tiene que
 * devolver la licencia que ganó — con SU token — y no fallar ni duplicar.
 */

vi.mock("./sign", () => ({
  loadPrivateKey: () => "clave-de-prueba",
  signCompact: () => "token-recien-firmado",
}));

let insertos = 0;
let chocaConElIndice = false;

const FILA_GANADORA = { id: "jti-ganador", token: "token-del-ganador" };

function adminDoble(): AdminClient {
  return {
    from: (tabla: string) => {
      if (tabla !== "licenses") throw new Error(`tabla inesperada: ${tabla}`);
      return {
        insert: async () => {
          insertos += 1;
          return chocaConElIndice
            ? { error: { code: "23505", message: "duplicate key value violates unique constraint" } }
            : { error: null };
        },
        select: () => ({
          eq: function eq() {
            return this;
          },
          order: function order() {
            return this;
          },
          limit: function limit() {
            return this;
          },
          maybeSingle: async () => ({ data: FILA_GANADORA }),
        }),
      };
    },
  } as unknown as AdminClient;
}

beforeEach(() => {
  insertos = 0;
  chocaConElIndice = false;
});

describe("issueLicense — idempotencia ante el índice único", () => {
  it("sin conflicto emite y devuelve el token recién firmado", async () => {
    const { issueLicense } = await import("./issue");
    const r = await issueLicense(adminDoble(), { orgId: "org-1", seats: 1, periodEndUnix: 1_790_000_000 });
    expect(insertos).toBe(1);
    expect(r.token).toBe("token-recien-firmado");
  });

  it("⛔ con 23505 devuelve la licencia que GANÓ la carrera, sin lanzar", async () => {
    chocaConElIndice = true;
    const { issueLicense } = await import("./issue");
    const r = await issueLicense(adminDoble(), { orgId: "org-1", seats: 1, periodEndUnix: 1_790_000_000 });
    expect(r.jti).toBe("jti-ganador");
    expect(r.token).toBe("token-del-ganador");
    expect(r.expiresAt).toBe(1_790_000_000);
  });

  it("cualquier otro error de inserción sigue lanzando (el webhook responde 5xx y Stripe reintenta)", async () => {
    const roto = {
      from: () => ({
        insert: async () => ({ error: { code: "XX000", message: "otra cosa" } }),
      }),
    } as unknown as AdminClient;
    const { issueLicense } = await import("./issue");
    await expect(issueLicense(roto, { orgId: "org-1", seats: 1, periodEndUnix: 1_790_000_000 })).rejects.toBeTruthy();
  });
});
