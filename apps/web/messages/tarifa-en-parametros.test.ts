import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * LA TARIFA PÚBLICA NO VIVE EN LOS MENSAJES — el anclaje llevado al límite.
 *
 * El plan maestro exige «ningún número público sin test que lo ancle». La
 * forma más fuerte de ese ancla no es comparar números: es que NO HAYA
 * números que comparar. En los namespaces que publican la tarifa
 * (`landing.calculadora` y `landing.formula`), cada cifra —umbral, rampa,
 * tramos, precio del asiento, cero— llega como parámetro ICU desde
 * `lib/billing/tarifa` o desde el Price de Stripe, formateada en código.
 *
 * Así, cambiar la tarifa real cambia la web sola, en los 12 idiomas a la vez,
 * y es IMPOSIBLE que un texto anuncie un número viejo. Este test convierte la
 * doctrina en verja: un solo dígito escrito a mano en esos namespaces pone la
 * suite en rojo. (La prohibición de símbolos de moneda ya vive en
 * parity.test.ts; esta es su hermana para las cifras.)
 */

const LOCALES = ["es", "en", "ca", "de", "fr", "it", "nl", "pl", "pt", "tr", "id", "vi"];
const NAMESPACES = ["calculadora", "formula"] as const;
const DIR = new URL(".", import.meta.url).pathname;

function aplanar(o: unknown, p = ""): [string, string][] {
  if (typeof o === "string") return [[p, o]];
  if (o !== null && typeof o === "object") {
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => aplanar(v, p ? `${p}.${k}` : k));
  }
  return [];
}

describe("la tarifa pública viaja SIEMPRE por parámetro, nunca escrita a mano", () => {
  for (const loc of LOCALES) {
    it(`${loc}: ni un dígito en landing.calculadora ni landing.formula`, () => {
      const data = JSON.parse(readFileSync(join(DIR, `${loc}.json`), "utf8")) as {
        landing: Record<string, unknown>;
      };
      const infractores: string[] = [];
      for (const ns of NAMESPACES) {
        for (const [clave, valor] of aplanar(data.landing[ns], ns)) {
          if (/[0-9]/.test(valor)) infractores.push(`${clave}: "${valor}"`);
        }
      }
      expect(infractores).toEqual([]);
    });
  }

  it("los dos namespaces existen (si desaparecen, este test no protege nada)", () => {
    const es = JSON.parse(readFileSync(join(DIR, "es.json"), "utf8")) as { landing: Record<string, unknown> };
    expect(es.landing["calculadora"]).toBeTruthy();
    expect(es.landing["formula"]).toBeTruthy();
  });
});
