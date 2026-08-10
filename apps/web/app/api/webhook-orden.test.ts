import { describe, it, expect } from "vitest";

/**
 * Guardia de orden del webhook de Stripe. Stripe no garantiza orden y reintenta
 * durante días lo que respondió 5xx, así que un `subscription.updated` viejo podía
 * reentrar DESPUÉS de un `deleted` y des-cancelar la org: volvía a pro sin licencia
 * viva, y reconcile la contaba con asientos pagados.
 *
 * La decisión vive en upsertSub: se ignora un evento cuyo `event.created` sea
 * anterior al último aplicado. Se prueba esa decisión aislada (mismo criterio que
 * el código), verificable por mutación.
 */

/** Igual que la guardia de upsertSub: ¿este evento es viejo respecto a la fila? */
function esStale(eventCreatedUnix: number, lastEventAt: string | null): boolean {
  if (!lastEventAt) return false;
  return eventCreatedUnix * 1000 < new Date(lastEventAt).getTime();
}

describe("webhook — la última escritura por tiempo de origen gana", () => {
  const ultimoAplicado = "2026-08-10T12:00:00.000Z"; // = 1786622400 unix
  const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

  it("un updated que reentra DESPUÉS de un deleted más nuevo se ignora", () => {
    const updatedViejo = unix("2026-08-10T11:59:00.000Z"); // 1 min antes
    expect(esStale(updatedViejo, ultimoAplicado)).toBe(true);
  });

  it("un evento más nuevo sí se aplica", () => {
    const nuevo = unix("2026-08-10T12:01:00.000Z");
    expect(esStale(nuevo, ultimoAplicado)).toBe(false);
  });

  it("el primer evento sobre una fila sin historial nunca es stale", () => {
    expect(esStale(unix("2020-01-01T00:00:00.000Z"), null)).toBe(false);
  });

  it("un evento del MISMO instante no se descarta (>=, no >)", () => {
    expect(esStale(unix(ultimoAplicado), ultimoAplicado)).toBe(false);
  });
});
