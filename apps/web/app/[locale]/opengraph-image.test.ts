import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * La tarjeta social RELLENA el precio, nunca pinta la plantilla `{amount}`.
 *
 * POR QUÉ ESTE TEST EXISTE. `pricing.amount` es el marcador ICU `{amount}` en los
 * 12 idiomas (el precio vive en el Price de Stripe, no en los mensajes, con un
 * candado en parity.test que lo exige). La imagen OG lo consumía como
 * `t("pricing.amount")` SIN pasar el argumento, así que la píldora de la tarjeta
 * decía literalmente «{amount} / seat / month» en LinkedIn/Slack de los 12
 * idiomas — y las cachés de OG la congelan días. La landing (page.tsx) siempre lo
 * hizo bien; este guard ata la imagen OG al mismo contrato sin renderizar satori.
 */

const fuente = readFileSync(new URL("./opengraph-image.tsx", import.meta.url), "utf8");

describe("opengraph-image", () => {
  it("no llama a t(\"pricing.amount\") sin el argumento del precio", () => {
    // La forma buggy exacta: `t("pricing.amount")` cerrado sin coma/argumento.
    const sinArgumento = /t\(\s*["']pricing\.amount["']\s*\)/;
    expect(sinArgumento.test(fuente), "pricing.amount debe recibir { amount }").toBe(false);
  });

  it("obtiene el precio real del plan (no un literal)", () => {
    expect(fuente).toMatch(/preciosDelPlan\(\)/);
    expect(fuente).toMatch(/t\(\s*["']pricing\.amount["']\s*,\s*\{\s*amount/);
  });
});
