import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { PRO_FEATURES } from "../apps/web/lib/license/issue.js";

/**
 * LA VERJA CONTRA LA TRAMPA MUDA.
 *
 * El fallo que cierra este PR no dio ni un error: el gateway gateaba la
 * elisión con `tiene("context_elision")`, el canal de entitlements es
 * FAIL-CLOSED a apagado, y ese literal no estaba en PRO_FEATURES. Resultado:
 * el cliente que PAGA tenía la palanca apagada, sin un solo log que lo dijera.
 * Ninguna prueba podía cazarlo porque las dos mitades —el gate y la lista— son
 * ficheros distintos que no se hablan.
 *
 * Esta verja los hace hablar: se leen del FUENTE los literales sobre los que
 * el gateway decide, y se exige que cada uno sea alcanzable por alguien que
 * paga. Un feature nuevo gateado y no vendido rompe aquí, en rojo, en CI.
 *
 * La lista de EXENTOS es la vía de escape, y es explícita a propósito: dejar
 * un feature fuera de PRO debe costar escribir por qué.
 */

/** Features que el gateway gatea a sabiendas SIN venderlos en el plan PRO. */
const EXENTOS: Record<string, string> = {
  // Vive en la verificación offline del SDK (`pipeline.ts` lo exige en el
  // token firmado), no en el gateway del terminal. Superficie distinta,
  // decisión distinta: sigue siendo solo del anillo interno del dueño.
  tool_result_elision: "supersesión en vivo del SDK, no del gateway",
};

const raiz = new URL("..", import.meta.url).pathname;

function literalesGateados(rutaRelativa: string): string[] {
  const fuente = readFileSync(join(raiz, rutaRelativa), "utf8");
  // `canal.tiene("x")` / `canalElision.tiene('x')` — la única forma en que el
  // gateway consulta el canal de entitlements.
  const encontrados = [...fuente.matchAll(/\.tiene\(\s*["'`]([a-z0-9_]+)["'`]\s*\)/g)].map((m) => m[1]);
  return [...new Set(encontrados)];
}

describe("toda palanca gateada es alcanzable por quien paga", () => {
  const gateados = literalesGateados("gateway/servidor.ts");

  it("el escáner encuentra de verdad los gates (si no, la verja sería un placebo)", () => {
    expect(gateados.length).toBeGreaterThan(0);
    expect(gateados).toContain("context_elision");
  });

  it.each(gateados)("«%s» está en PRO_FEATURES o exento con motivo escrito", (feature) => {
    const enPro = (PRO_FEATURES as readonly string[]).includes(feature);
    const exento = Object.hasOwn(EXENTOS, feature);
    expect(
      enPro || exento,
      `El gateway decide sobre "${feature}" pero ninguna licencia PRO lo lleva. ` +
        `El canal de entitlements es fail-closed: el cliente que paga se quedaría ` +
        `sin la palanca EN SILENCIO. Añádelo a PRO_FEATURES (y a la migración de ` +
        `relleno para las licencias ya emitidas) o decláralo en EXENTOS con el motivo.`,
    ).toBe(true);
  });

  it("las dos palancas de dinero llegan al cliente de pago", () => {
    expect(PRO_FEATURES).toContain("context_elision");
    expect(PRO_FEATURES).toContain("cache_ttl_tuning");
  });

  it("la migración de relleno cubre exactamente lo que se añadió a PRO", () => {
    const sql = readFileSync(join(raiz, "db/migrations/0023_features_pro_palancas.sql"), "utf8");
    for (const f of ["context_elision", "cache_ttl_tuning"]) expect(sql).toContain(f);
  });
});
