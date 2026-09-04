import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { FEATURES } from "../packages/protocol/src/index.js";

/**
 * Las TRES listas de features viven desconectadas — la unión `Feature` del
 * protocolo, `PRO_FEATURES` de la emisión Stripe y la allow-list del trial — y
 * ninguna verja las ataba: añadir un literal a la unión y olvidar las otras dos
 * firmaba el feature en un carril y no en el otro (hallazgo de la exploración
 * S4a). apps/web no puede importar packages/ en producción (Vercel construye
 * solo apps/web), así que la paridad se comprueba aquí, leyendo su FUENTE.
 */

const RAIZ = join(__dirname, "..");

function listaDe(fuente: string, ancla: RegExp, fichero: string): string[] {
  const m = ancla.exec(fuente);
  expect(m, `no se encontró la lista en ${fichero}`).not.toBeNull();
  const literales = m![1]!.match(/"([a-z_]+)"/g) ?? [];
  expect(literales.length, `lista vacía en ${fichero}`).toBeGreaterThan(0);
  return literales.map((l) => l.replaceAll('"', ""));
}

describe("paridad de las listas de features", () => {
  const union = new Set<string>(FEATURES);

  it("la unión del protocolo conoce context_elision (S4a)", () => {
    expect(union.has("context_elision")).toBe(true);
  });

  it("PRO_FEATURES (emisión Stripe) ⊆ la unión del protocolo", () => {
    const fuente = readFileSync(join(RAIZ, "apps/web/lib/license/issue.ts"), "utf8");
    const pro = listaDe(fuente, /export const PRO_FEATURES = \[([\s\S]*?)\] as const/, "issue.ts");
    for (const f of pro) expect(union.has(f), `"${f}" no está en la unión Feature`).toBe(true);
  });

  it("la allow-list del trial ⊆ la unión del protocolo", () => {
    const fuente = readFileSync(join(RAIZ, "apps/web/app/api/license/trial/route.ts"), "utf8");
    const trial = listaDe(fuente, /const features = \[([\s\S]*?)\]/, "trial/route.ts");
    for (const f of trial) expect(union.has(f), `"${f}" (trial) no está en la unión Feature`).toBe(true);
  });
});
