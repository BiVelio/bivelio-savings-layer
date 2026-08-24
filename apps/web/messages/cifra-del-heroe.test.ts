import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * LA CIFRA DEL HÉROE ES EL ARTEFACTO, NO UNA REDACCIÓN.
 *
 * La fila OpenAI del héroe («≥ 24,1 %») vivía escrita a mano en 12 ficheros de
 * traducción mientras `ab:publish` renovaba el artefacto — exactamente la
 * receta con la que esta landing ya sirvió un MOCK como si fuera una medición.
 * Esta verja ata las dos cosas: si el artefacto publicado cambia de cota, el
 * build se pone rojo hasta que los 12 idiomas digan la cifra nueva
 * (scratchpad/actualizar-cifras-heroe.py la propaga con el formato de cada
 * locale).
 */

const DIR = new URL(".", import.meta.url).pathname;

const artefacto = JSON.parse(
  readFileSync(`${DIR}../public/data/ab-live.json`, "utf8"),
) as { model?: string; aggregate?: { savings?: { lower?: number } } };

/** El número de una cifra localizada («≥ 23,1 %», «≥ %23,1») como float. */
function numeroDe(cifra: string): number {
  const m = /(\d+)[.,](\d+)/.exec(cifra);
  expect(m, `sin número en ${JSON.stringify(cifra)}`).not.toBeNull();
  return Number(`${m![1]}.${m![2]}`);
}

describe("la fila OpenAI del héroe dice la cota del artefacto publicado", () => {
  const lower = artefacto.aggregate?.savings?.lower;
  it("el artefacto publicado trae una cota inferior", () => {
    expect(typeof lower).toBe("number");
  });

  const esperado = Number(((lower ?? 0) * 100).toFixed(1));

  for (const f of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
    it(`${f}: la cifra del héroe es la del artefacto (${esperado}%)`, () => {
      const d = JSON.parse(readFileSync(`${DIR}${f}`, "utf8")) as {
        landing: { hero: { proofs: { marca: string; modelo: string; cifra: string }[] } };
      };
      const fila = d.landing.hero.proofs[0]!;
      expect(fila.marca).toBe("OpenAI");
      // La fila anuncia el MISMO modelo que midió el artefacto…
      expect(artefacto.model ?? "").toContain(fila.modelo);
      // …y el mismo suelo del IC 95%, en el formato del idioma que sea.
      expect(numeroDe(fila.cifra)).toBe(esperado);
    });
  }
});
