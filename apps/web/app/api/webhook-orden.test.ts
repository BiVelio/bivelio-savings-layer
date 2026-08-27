import { describe, it, expect } from "vitest";

import { esStale, condicionEscritura, ganaLaEscritura } from "@/lib/stripe/guardia-orden";

/**
 * Guardia de orden del webhook de Stripe, en sus DOS líneas.
 *
 * Primera (esStale): Stripe no garantiza orden y reintenta durante días lo que
 * respondió 5xx; un `updated` viejo que reentra tras un `deleted` no debe
 * des-cancelar la org.
 *
 * Segunda (ganaLaEscritura / condicionEscritura): la ráfaga CONCURRENTE que la
 * lectura previa no ve — reproducida en el banco del 2026-08-27: `payment_failed`
 * y `deleted` entregados a la vez, ambos pasan esStale, y el último en escribir
 * dejó la fila en `past_due` con la suscripción cancelada en Stripe. La regla
 * vive en el WHERE del UPDATE; aquí se prueba su referencia ejecutable y que la
 * condición PostgREST expresa lo mismo.
 */

const unix = (isoStr: string) => Math.floor(new Date(isoStr).getTime() / 1000);
const ULTIMO = "2026-08-10T12:00:00.000Z";

describe("primera línea — esStale sobre lo último aplicado", () => {
  it("un updated que reentra DESPUÉS de un deleted más nuevo se ignora", () => {
    expect(esStale(unix("2026-08-10T11:59:00.000Z"), ULTIMO)).toBe(true);
  });

  it("un evento más nuevo sí se aplica", () => {
    expect(esStale(unix("2026-08-10T12:01:00.000Z"), ULTIMO)).toBe(false);
  });

  it("el primer evento sobre una fila sin historial nunca es stale", () => {
    expect(esStale(unix("2020-01-01T00:00:00.000Z"), null)).toBe(false);
  });

  it("un evento del MISMO instante no se descarta (>=, no >)", () => {
    expect(esStale(unix(ULTIMO), ULTIMO)).toBe(false);
  });
});

describe("segunda línea — la ráfaga concurrente y el desempate", () => {
  it("⛔ el caso del banco: a MISMO instante, `canceled` es pegajoso", () => {
    // El `deleted` escribió canceled; su gemelo `payment_failed` del mismo
    // segundo ya no lo pisa.
    expect(ganaLaEscritura(ULTIMO, ULTIMO, "canceled")).toBe(false);
  });

  it("a mismo instante sobre una fila NO cancelada sí se escribe (reintentos idempotentes)", () => {
    expect(ganaLaEscritura(ULTIMO, ULTIMO, "past_due")).toBe(true);
    expect(ganaLaEscritura(ULTIMO, ULTIMO, "active")).toBe(true);
  });

  it("estrictamente más nuevo siempre gana, incluso sobre canceled", () => {
    expect(ganaLaEscritura("2026-08-10T12:00:01.000Z", ULTIMO, "canceled")).toBe(true);
  });

  it("estrictamente más viejo nunca escribe", () => {
    expect(ganaLaEscritura("2026-08-10T11:59:59.000Z", ULTIMO, "active")).toBe(false);
  });

  it("fila sin historial: se escribe siempre", () => {
    expect(ganaLaEscritura(ULTIMO, null, null)).toBe(true);
  });

  it("la condición PostgREST expresa la misma regla, con el timestamp entre comillas", () => {
    const c = condicionEscritura(ULTIMO);
    expect(c).toBe(
      `last_event_at.is.null,` +
        `last_event_at.lt."${ULTIMO}",` +
        `and(last_event_at.eq."${ULTIMO}",status.neq.canceled)`,
    );
  });
});
