import { describe, expect, it } from "vitest";

import { getOrgContext } from "./data";

/**
 * LAS CUATRO CONSULTAS DEL CONTEXTO SALEN A LA VEZ, NO UNA DETRÁS DE OTRA.
 *
 * Medido en producción el 22-09-2026: la función corre en Vercel y la base en
 * Fráncfort, así que cada viaje cuesta la distancia entre las dos, y cuatro en
 * serie eran cuatro viajes antes de pintar nada. Este test le pone a cada
 * consulta un retardo de 40 ms y exige que el total se parezca al MÁXIMO, no a
 * la SUMA: si alguien vuelve a encadenarlas con `await` en serie, tarda más de
 * 160 ms y esto se pone en rojo.
 */
const ORG = "99999999-9999-4999-8999-999999999999";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const RETARDO_MS = 40;

function dobleLento() {
  const consulta = (tabla: string) => {
    const filas: Record<string, unknown>[] =
      tabla === "org_members"
        ? [{ org_id: ORG, user_id: USUARIO, role: "owner", organizations: { name: "Lenta S.L.", plan: "pro" } }]
        : [];
    const espera = <T,>(v: T) => new Promise<T>((res) => setTimeout(() => res(v), RETARDO_MS));
    const q: Record<string, unknown> = {
      select: () => q,
      order: () => q,
      limit: () => q,
      eq: () => q,
      maybeSingle: () => espera({ data: filas[0] ?? null, error: null }),
      then: (res: (v: { data: unknown; error: null }) => unknown) => espera({ data: filas, error: null }).then(res),
    };
    return q;
  };
  return { schema: () => ({ from: consulta }), from: consulta } as never;
}

describe("getOrgContext", () => {
  it("lanza sus cuatro consultas en paralelo", async () => {
    const t0 = performance.now();
    const ctx = await getOrgContext(dobleLento(), ORG, USUARIO);
    const total = performance.now() - t0;
    expect(ctx.org?.name).toBe("Lenta S.L.");
    // Cuatro en serie serían ≥ 160 ms; en paralelo, ~40. El margen cubre un
    // runner cargado sin dejar pasar la versión en serie.
    expect(total).toBeLessThan(RETARDO_MS * 2.5);
  });
});
