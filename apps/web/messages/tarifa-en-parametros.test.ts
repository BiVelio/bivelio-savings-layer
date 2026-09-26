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
/**
 * Rutas de namespace completas. `dashboard.extracto` entró el 2026-09-01: su
 * intro anunciaba «la rampa del 30%» escrita a mano y sobrevivió a la retirada
 * del mínimo porque esta verja solo miraba la landing — el dueño la cazó en el
 * panel. El extracto enseña sus cifras por parámetro ({cero}, {pct}, {usd}),
 * así que le aplica la misma regla: ni un dígito en los textos.
 *
 * `dashboard.yourBench` entró el 2026-09-25 («tu propio banco», la verificación
 * A/B opcional): nivel del intervalo, «por cada mil», mínimos de pares y todas
 * sus cifras llegan por parámetro desde lib/verificacion/banco-propio.ts.
 *
 * `pricingPage` y `privacyPage` entraron el 2026-09-26: son las páginas que
 * cita la LICENSE (§6 «Published Pricing», §5 los datos que salen). Cuota,
 * tramos, mínimo facturable, días activos de un asiento y plazos de retención
 * llegan por parámetro desde las constantes que cobran y purgan
 * (lib/legal/precios-publicados.ts, lib/legal/lo-que-sale.ts).
 */
const NAMESPACES = [
  "landing.calculadora",
  "landing.formula",
  "dashboard.extracto",
  "dashboard.yourBench",
  "pricingPage",
  "privacyPage",
] as const;
const DIR = new URL(".", import.meta.url).pathname;

function porRuta(data: Record<string, unknown>, ruta: string): unknown {
  return ruta.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], data);
}

function aplanar(o: unknown, p = ""): [string, string][] {
  if (typeof o === "string") return [[p, o]];
  if (o !== null && typeof o === "object") {
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => aplanar(v, p ? `${p}.${k}` : k));
  }
  return [];
}

describe("la tarifa pública viaja SIEMPRE por parámetro, nunca escrita a mano", () => {
  for (const loc of LOCALES) {
    it(`${loc}: ni un dígito en ${NAMESPACES.join(", ")}`, () => {
      const data = JSON.parse(readFileSync(join(DIR, `${loc}.json`), "utf8")) as Record<string, unknown>;
      const infractores: string[] = [];
      for (const ns of NAMESPACES) {
        for (const [clave, valor] of aplanar(porRuta(data, ns), ns)) {
          if (/[0-9]/.test(valor)) infractores.push(`${clave}: "${valor}"`);
        }
      }
      expect(infractores).toEqual([]);
    });
  }

  it("los namespaces vigilados existen (si desaparecen, este test no protege nada)", () => {
    const es = JSON.parse(readFileSync(join(DIR, "es.json"), "utf8")) as Record<string, unknown>;
    for (const ns of NAMESPACES) {
      expect(porRuta(es, ns), ns).toBeTruthy();
    }
  });
});
