import type { SavingsReport } from "../../src/index.js";

// Ayudas comunes de los tests de adaptadores. Nada aquí toca la red: la medición
// de uso va a un `fetch` espía y ningún adaptador recibe `licenseServerUrl`.

/** Una medición de uso espía: cada registro que la capa enviaría a BiVelio. */
export function medicion(): {
  opciones: {
    serviceAccountKey: string;
    meteringUrl: string;
    meteringFetch: typeof fetch;
    metering: { maxBatch: number; seatId: string; ci: boolean };
  };
  registros: Record<string, unknown>[];
} {
  const registros: Record<string, unknown>[] = [];
  const meteringFetch = (async (_url: string, init: RequestInit) => {
    const cuerpo = JSON.parse(String(init.body)) as unknown;
    const lista = Array.isArray(cuerpo)
      ? cuerpo
      : Array.isArray((cuerpo as { records?: unknown }).records)
        ? (cuerpo as { records: unknown[] }).records
        : [cuerpo];
    registros.push(...(lista as Record<string, unknown>[]));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return {
    opciones: {
      serviceAccountKey: "bvk_de_prueba",
      meteringUrl: "https://cp.example/api/metering/usage",
      meteringFetch,
      metering: { maxBatch: 1, seatId: "asiento", ci: false },
    },
    registros,
  };
}

/** Deja que los envíos de uso (asíncronos, sin await en el camino) se completen. */
export async function vaciar(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Ejecuta `fn` con la puerta de licencia CERRADA, como en el paquete publicado sin clave. */
export async function sinLicencia<T>(fn: () => Promise<T>): Promise<T> {
  const antes = process.env.BVSALA_DEV_OPEN;
  delete process.env.BVSALA_DEV_OPEN;
  try {
    return await fn();
  } finally {
    if (antes === undefined) delete process.env.BVSALA_DEV_OPEN;
    else process.env.BVSALA_DEV_OPEN = antes;
  }
}

/** Una red que no existe: cualquier `fetch` no previsto es un fallo del test. */
export function prohibirLaRed(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    throw new Error(`[test] la red está prohibida: ${String(url)}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Recoge los informes que entrega `onReport`. */
export function coleccion(): { onReport: (r: SavingsReport) => void; informes: SavingsReport[] } {
  const informes: SavingsReport[] = [];
  return { onReport: (r) => informes.push(r), informes };
}
