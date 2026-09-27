import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * LO QUE SE PROMETE NUNCA PUEDE PASARSE DE LO MEDIDO.
 *
 * La fila OpenAI del héroe vivía escrita a mano en 12 ficheros de traducción
 * mientras `ab:publish` renovaba el artefacto — exactamente la receta con la
 * que esta landing ya sirvió un MOCK como si fuera una medición.
 *
 * La primera versión de esta verja exigía IGUALDAD exacta con el suelo del
 * artefacto. Se cambió el 2026-09-10 a una DESIGUALDAD, y el motivo importa:
 * publicar exactamente el suelo obliga a reescribir los 12 idiomas cada vez que
 * el banco se mueve una décima, y —peor— convierte cualquier redondeo hacia
 * arriba en una promesa que la medición no sostiene. Con `prometido ≤ medido`
 * se puede elegir una cifra redonda y conservadora y el build sigue poniéndose
 * rojo en el único caso que de verdad importa: que la web prometa más de lo que
 * el banco puede defender. (Desde el 2026-09-25 la cifra es 10 %: la verja
 * hermana, test/titular-como-se-instala.test.ts, exige que quepa también en lo
 * que entrega el paquete de npm, y el artefacto publicado se midió con el
 * compresor del banco.)
 *
 * Sigue exigiendo que las 12 digan LA MISMA cifra y que la fila anuncie el
 * mismo modelo que se midió.
 *
 * Desde el 2026-09-13 la verja mira los DOS suelos del artefacto: frente al
 * brazo ingenuo (B0) y frente al razonable (B1, «lo que un equipo cuidadoso ya
 * haría»), y exige que lo prometido quepa en el MENOR. El banco publica ambas
 * cifras a propósito; prometer solo contra la base más favorable era elegir
 * la comparación que más ahorro enseña.
 *
 * Desde el 2026-09-27, cuando el artefacto trae el brazo B2 («nativo bien
 * configurado»: B1 más lo que el proveedor documenta gratis para esa petición),
 * la cifra tiene que caber en el MENOR DE LOS TRES. Es la comparación con la
 * que un comprador técnico nos va a medir (informe de competencia, §8 rec. 3).
 */

const DIR = new URL(".", import.meta.url).pathname;

const artefacto = JSON.parse(
  readFileSync(`${DIR}../public/data/ab-live.json`, "utf8"),
) as {
  model?: string;
  aggregate?: { savings?: { lower?: number } };
  aggregateB1?: { savings?: { lower?: number } };
  aggregateB2?: { savings?: { lower?: number } };
};

/** El número de una cifra localizada («≥ 23,1 %», «≥ %23,1») como float. */
function numeroDe(cifra: string): number {
  const m = /(\d+)[.,](\d+)/.exec(cifra);
  expect(m, `sin número en ${JSON.stringify(cifra)}`).not.toBeNull();
  return Number(`${m![1]}.${m![2]}`);
}

describe("la fila OpenAI del héroe no promete más de lo que el artefacto mide", () => {
  const lowerB0 = artefacto.aggregate?.savings?.lower;
  const lowerB1 = artefacto.aggregateB1?.savings?.lower;
  // B2 solo existe en los artefactos medidos desde el 2026-09-27; si está, manda.
  const lowerB2 = artefacto.aggregateB2?.savings?.lower;
  it("el artefacto publicado trae una cota inferior frente a B0", () => {
    expect(typeof lowerB0).toBe("number");
  });
  it("y otra frente a B1: la verja exige caber en la MENOR de las dos", () => {
    expect(typeof lowerB1).toBe("number");
  });

  // El menor de los suelos: lo prometido tiene que caber también frente a la
  // base razonable y, si el artefacto la trae, frente a la nativa bien
  // configurada — no solo frente a la ingenua.
  const lower = Math.min(lowerB0 ?? 0, lowerB1 ?? lowerB0 ?? 0, lowerB2 ?? lowerB1 ?? lowerB0 ?? 0);
  // TRUNCADO a una décima, nunca redondeado: `toFixed(1)` convertía un 22,96 %
  // en 23,0 % y dejaba prometer una décima que el banco no sostiene. La verja
  // hermana (titular-como-se-instala) ya truncaba; ahora las dos dicen lo mismo.
  const medido = Math.floor((lower ?? 0) * 1000) / 10;
  const cifras: number[] = [];

  for (const f of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
    it(`${f}: lo prometido cabe dentro de lo medido (${medido}%)`, () => {
      const d = JSON.parse(readFileSync(`${DIR}${f}`, "utf8")) as {
        landing: { hero: { proofs: { marca: string; modelo: string; cifra: string }[] } };
      };
      const fila = d.landing.hero.proofs[0]!;
      expect(fila.marca).toBe("OpenAI");
      // La fila anuncia el MISMO modelo que midió el artefacto…
      expect(artefacto.model ?? "").toContain(fila.modelo);
      const prometido = numeroDe(fila.cifra);
      cifras.push(prometido);
      // …y promete MENOS O IGUAL que su suelo del IC 95 %. Prometer de más es
      // el único fallo que esta verja existe para impedir.
      expect(prometido).toBeLessThanOrEqual(medido);
      // Y algo tiene que prometer: un 0 no es conservador, es no decir nada.
      expect(prometido).toBeGreaterThan(0);
    });
  }

  it("los 12 idiomas prometen LA MISMA cifra", () => {
    expect(new Set(cifras).size).toBe(1);
  });
});
