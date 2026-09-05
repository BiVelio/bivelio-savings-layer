import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * VERJA DE NO-SOLAPE — el gateway jamás corre el pipeline de optimización.
 *
 * Hay DOS caminos que borran contexto y acreditan el MISMO campo de
 * contabilidad `tokens.eliminatedInput` → wire `eliminatedInputTokens` → columna
 * `usage_daily.eliminated_input_tokens` → tarjeta `eliminated_tokens` del panel:
 *
 *   · CAMINO A — elisión v0 del lado del SDK (`src/pipeline/elision.ts`, etapa en
 *     `src/pipeline/pipeline.ts`): reescribe el cuerpo de tool_results viejos y
 *     gordos ANTES de enviar, y acredita con `ledger.eliminate(...)`.
 *   · CAMINO B — `clear_tool_uses` del proveedor (S4a, `gateway/diales.ts` +
 *     `gateway/medidor.ts`): el proveedor limpia tool_uses y devuelve
 *     `applied_edits`; el medidor suma `cleared_input_tokens` en el mismo campo.
 *
 * Como ambos acreditan la MISMA columna, lo ÚNICO que impide contar los mismos
 * tokens dos veces es que corren sobre TRÁFICO FÍSICAMENTE DISJUNTO: el gateway
 * (B) es un passthrough que SOLO mide y ajusta `context_management` — nunca
 * construye ni ejecuta el `Pipeline` del SDK (A). Los dos son productos
 * separados: `src/` nunca importa `gateway/`, y el gateway solo importa de `src/`
 * precios, tipos de coste, metering, util y la versión — jamás el pipeline.
 *
 * Si un cambio futuro hiciera que el gateway invocara el pipeline, los dos
 * caminos pasarían a tocar el MISMO tráfico y la contabilidad quedaría protegida
 * solo por el ORDEN (A pone el muñón antes de que B mida) — una salvaguarda
 * frágil y no aserida. Esta verja bloquea ese cambio en seco: obliga a una
 * decisión consciente sobre el solape antes de fusionar. Ver
 * `docs/PLAN-PASARELA-API-KEY.md` (dedupe S4a) y la investigación del 05-09.
 */
describe("verja de no-solape: el gateway no corre el pipeline de optimización", () => {
  const ficheros: string[] = [];
  const recorrer = (dir: string): void => {
    for (const entrada of readdirSync(dir)) {
      const p = join(dir, entrada);
      if (statSync(p).isDirectory()) recorrer(p);
      else if (p.endsWith(".ts")) ficheros.push(p);
    }
  };
  recorrer(join(process.cwd(), "gateway"));

  it("ningún fichero de gateway/ importa nada de src/pipeline/", () => {
    // Cualquier forma de import cuyo camino apunte a `src/pipeline/…` (estático,
    // side-effect, dinámico o require). El gateway importa legítimamente de
    // `../src/pricing`, `../src/tokenizer`, `../src/contracts`, `../src/metering`,
    // `../src/util` y `../src/index` (solo `BV_SALA_VERSION`) — todos fuera de
    // `pipeline/`. Un import de `../src/pipeline/…` es justo lo que rompe la
    // disjunción de tráfico.
    const importPipeline =
      /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)["'][^"']*\/src\/pipeline\/[^"']*["']/;
    const infractores = ficheros.filter((f) => importPipeline.test(readFileSync(f, "utf8")));
    expect(infractores).toEqual([]);
  });

  it("ningún fichero de gateway/ construye un Pipeline ni llama a la elisión del SDK", () => {
    // Defensa en profundidad: aunque no haya import (p. ej. un re-export desde el
    // barrel), nombrar estos símbolos en el gateway señala que el pipeline se ha
    // colado en el camino de medición.
    const usoProhibido = /\bnew\s+Pipeline\b|\bseleccionarElisionV0\b|\baplicarElision\b/;
    const infractores = ficheros.filter((f) => usoProhibido.test(readFileSync(f, "utf8")));
    expect(infractores).toEqual([]);
  });
});
