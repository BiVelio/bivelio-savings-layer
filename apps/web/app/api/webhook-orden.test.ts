import { describe, it, expect } from "vitest";

import { esStale, condicionEscritura, ganaLaEscritura, puedeAplicarImpago, fallbackVencimientoUnix } from "@/lib/stripe/guardia-orden";

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

describe("puedeAplicarImpago — el hallazgo VIVO de la re-verificación del 02-09", () => {
  it("⛔ canceled es TERMINAL: ni siquiera un payment_failed MÁS NUEVO lo resucita", () => {
    // Stripe puede emitir el fallo de la última factura DESPUÉS de cancelar; si
    // esto pasara, la fila volvía a past_due, el entitlement reabría el ingest
    // de la org cancelada y el reconcile le contaba asientos otra vez.
    expect(puedeAplicarImpago("canceled", ULTIMO, unix("2026-08-10T12:05:00.000Z"))).toBe(false);
  });

  it("⛔ y un payment_failed VIEJO reentregado tampoco pisa nada (esStale)", () => {
    expect(puedeAplicarImpago("active", ULTIMO, unix("2026-08-10T11:00:00.000Z"))).toBe(false);
  });

  it("el caso legítimo sigue pasando: impago nuevo sobre suscripción activa", () => {
    expect(puedeAplicarImpago("active", ULTIMO, unix("2026-08-10T12:05:00.000Z"))).toBe(true);
    expect(puedeAplicarImpago(null, null, unix("2026-08-10T12:05:00.000Z"))).toBe(true);
  });
});

describe("fallbackVencimientoUnix — el residuo de la carrera de licencias (0018)", () => {
  it("dos handlers concurrentes del MISMO día calculan el MISMO vencimiento", () => {
    // El índice único (org_id, expires_at, seats) solo frena la emisión doble
    // si los corredores colisionan: con nowUnix() a segundos distintos no lo
    // hacían. Anclado al día, chocan — y el 23505 entrega la licencia ganadora.
    const a = fallbackVencimientoUnix(unix("2026-09-02T10:15:07.000Z"));
    const b = fallbackVencimientoUnix(unix("2026-09-02T10:15:09.000Z"));
    const c = fallbackVencimientoUnix(unix("2026-09-02T23:59:59.000Z"));
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("y vence a 31 días, en frontera de día exacta", () => {
    const v = fallbackVencimientoUnix(unix("2026-09-02T10:15:07.000Z"));
    expect(v).toBe(unix("2026-10-03T00:00:00.000Z"));
    expect(v % 86400).toBe(0);
  });
});
