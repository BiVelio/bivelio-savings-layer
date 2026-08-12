import { describe, it, expect, vi } from "vitest";

import { diagnosticar, contarFilasReales } from "./visibilidad";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * «NO HAY TRÁFICO» Y «NO PUEDES VER TU TRÁFICO» SON LO MISMO EN PANTALLA.
 *
 * Y son opuestos: el primero se arregla instalando el SDK, el segundo es un fallo
 * nuestro. No se distinguen solos porque **una denegación de RLS en PostgREST no
 * es un error**: devuelve `[]` con `error: null`, exactamente igual que "no hay
 * nada". Así que una política mal puesta se le presentaba al cliente como «aún no
 * has enviado ninguna petición» — mientras sus datos seguían intactos en la base y
 * él pagaba por verlos.
 */

describe("diagnosticar", () => {
  it("con filas a la vista, no hay nada que explicar", () => {
    expect(diagnosticar(5, 5)).toBe("con_datos");
    // Ni siquiera se mira el recuento real: en el camino normal no se consulta.
    expect(diagnosticar(5, null)).toBe("con_datos");
  });

  it("cero y cero: no hay tráfico, que es lo normal el primer día", () => {
    expect(diagnosticar(0, 0)).toBe("sin_trafico");
  });

  it("⛔ cero a la vista pero filas REALES: está oculto, y es fallo nuestro", () => {
    // El caso entero. Un cliente que lleva semanas midiendo, mirando un panel que
    // le dice que no ha enviado nada.
    expect(diagnosticar(0, 1)).toBe("oculto");
    expect(diagnosticar(0, 4000)).toBe("oculto");
  });

  it("si no se pudo comprobar, no se AFIRMA nada", () => {
    // Decir "no tienes tráfico" sin haberlo podido verificar es exactamente la
    // mentira que este módulo existe para no contar.
    expect(diagnosticar(0, null)).toBe("desconocido");
  });

  it("un recuento absurdo no dispara la alarma", () => {
    // Nadie ve MÁS que `service_role`. Si el admin viera menos, el roto está en la
    // comprobación, no en la RLS — y alarmar por un fallo del propio diagnóstico
    // es la forma de que dejen de leerse las alarmas.
    expect(diagnosticar(3, 0)).toBe("con_datos");
  });
});

describe("contarFilasReales", () => {
  const doble = (respuesta: unknown, lanza = false) =>
    ({
      from: () => ({
        select: () => ({
          eq: () => ({
            gte: async () => {
              if (lanza) throw new Error("boom");
              return respuesta;
            },
          }),
        }),
      }),
    }) as unknown as AdminClient;

  it("devuelve el recuento", async () => {
    await expect(contarFilasReales(doble({ count: 7, error: null }), "org", "2026-01-01")).resolves.toBe(7);
  });

  it("cero es cero, no null", async () => {
    // Si un 0 se confundiera con "no se pudo saber", el diagnóstico nunca podría
    // decir "sin tráfico" y todo cliente nuevo vería "desconocido".
    await expect(contarFilasReales(doble({ count: 0, error: null }), "org", "2026-01-01")).resolves.toBe(0);
  });

  it("⛔ NUNCA lanza: un diagnóstico no puede tumbar la página que explicaba", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(contarFilasReales(doble({}, true), "org", "2026-01-01")).resolves.toBeNull();
    await expect(
      contarFilasReales(doble({ count: null, error: { message: "nope" } }), "org", "2026-01-01"),
    ).resolves.toBeNull();
    await expect(contarFilasReales(doble({ count: undefined, error: null }), "org", "2026-01-01")).resolves.toBeNull();
    vi.restoreAllMocks();
  });

  it("acota por organización y por fecha", async () => {
    const filtros: [string, unknown][] = [];
    const admin = {
      from: () => ({
        select: () => ({
          eq: (c: string, v: unknown) => {
            filtros.push([c, v]);
            return {
              gte: async (c2: string, v2: unknown) => {
                filtros.push([c2, v2]);
                return { count: 1, error: null };
              },
            };
          },
        }),
      }),
    } as unknown as AdminClient;
    await contarFilasReales(admin, "org-1", "2026-04-14");
    // Sin el `.eq("org_id", …)` esto contaría las filas de TODOS los clientes y
    // diría "oculto" a cualquiera que no tenga tráfico propio.
    expect(filtros).toContainEqual(["org_id", "org-1"]);
    // Y la misma ventana que la lectura del usuario: si el admin mirara más atrás,
    // un cliente con tráfico antiguo y ninguno reciente daría "oculto" en falso.
    expect(filtros).toContainEqual(["day", "2026-04-14"]);
  });
});
