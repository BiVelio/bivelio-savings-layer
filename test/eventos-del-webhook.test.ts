import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * Los eventos que el webhook MANEJA y los que el aprovisionamiento DA DE ALTA
 * tienen que ser exactamente los mismos.
 *
 * Ya se desincronizaron una vez, y el fallo es de los peores que tiene este
 * producto porque no se ve desde ningún sitio: `provision-stripe.mjs` registró
 * SEIS eventos, y `checkout.session.async_payment_succeeded` se añadió al código
 * DESPUÉS. Ese es el evento del pago por domiciliación (SEPA), que en EUR/España
 * es un medio de pago normal y llega días después del checkout. Sin él, el
 * cliente paga, Stripe cobra, el checkout ve `incomplete`… y nadie emite la
 * licencia jamás. En Stripe no aparece ningún error: el evento simplemente no
 * está suscrito, así que nunca se envía.
 *
 * Nada más en la verja compara estos dos ficheros, así que la comparación vive
 * aquí. Ojo: esto ata el REPOSITORIO consigo mismo. Que el endpoint VIVO de
 * Stripe tenga los siete es una comprobación de panel que no se puede hacer
 * desde aquí sin una clave de la cuenta.
 */

const RAIZ = new URL("..", import.meta.url).pathname;

/** Los `case "x.y":` del switch del webhook. */
function eventosManejados(): string[] {
  const src = readFileSync(`${RAIZ}apps/web/app/api/stripe/webhook/route.ts`, "utf8");
  const encontrados = [...src.matchAll(/case\s+"((?:checkout|customer|invoice)\.[a-z_.]+)"/g)].map((m) => m[1]!);
  return [...new Set(encontrados)].sort();
}

/** El array EVENTS del script de aprovisionamiento. */
function eventosAprovisionados(): string[] {
  const src = readFileSync(`${RAIZ}apps/web/scripts/provision-stripe.mjs`, "utf8");
  const bloque = src.match(/const EVENTS = \[([\s\S]*?)\];/);
  if (!bloque?.[1]) throw new Error("no se encontró el array EVENTS en provision-stripe.mjs");
  return [...bloque[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
}

describe("los eventos del webhook", () => {
  it("el script da de alta EXACTAMENTE los que el código maneja", () => {
    expect(eventosAprovisionados()).toEqual(eventosManejados());
  });

  it("incluyen el del pago SEPA, que es el que faltó", () => {
    // Explícito además de la comparación: si algún día alguien "limpia" los dos
    // ficheros a la vez, la comparación de arriba seguiría en verde y este no.
    expect(eventosManejados()).toContain("checkout.session.async_payment_succeeded");
    expect(eventosAprovisionados()).toContain("checkout.session.async_payment_succeeded");
  });

  it("son siete", () => {
    expect(eventosManejados()).toHaveLength(7);
  });
});
