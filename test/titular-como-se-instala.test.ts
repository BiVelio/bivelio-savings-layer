import { readFileSync, readdirSync } from "node:fs";

import { describe, it, expect } from "vitest";

import {
  leerEnsayos,
  sueloComoSeInstala,
  type ArtefactoParaSuelo,
  type Ensayo,
} from "../benchmarks/titular-como-se-instala.js";

/**
 * LO QUE LA WEB PROMETE TIENE QUE CABER EN LO QUE EL PAQUETE DE NPM ENTREGA.
 *
 * `cifra-del-heroe.test.ts` compara la promesa con los suelos del artefacto
 * publicado. Eso basta cuando el artefacto midió el SDK tal como se instala; el
 * del 2026-09-12 no: llevaba el compresor del banco, que npm no trae, y su
 * escenario de compresión ahorró un 15,1 % que ningún cliente puede ahorrar.
 * Esta verja reconstruye el suelo sin esa pieza (ver
 * benchmarks/titular-como-se-instala.ts) y exige que la promesa quepa también
 * ahí. Con un artefacto `sdk.asShipped: true` la reconstrucción se apaga sola.
 */

const RAIZ = new URL("../", import.meta.url);
const DATOS = new URL("apps/web/public/data/", RAIZ);
const MENSAJES = new URL("apps/web/messages/", RAIZ);

const artefacto = JSON.parse(readFileSync(new URL("ab-live.json", DATOS), "utf8")) as ArtefactoParaSuelo;
const ensayos = leerEnsayos(readFileSync(new URL("ab-live-trials.csv", DATOS), "utf8"));

/** «≥ 12,0 %», «≥ %12,0», «≥ 12.0%» → 12. */
function numeroDe(cifra: string): number {
  const m = /(\d+)[.,](\d+)/.exec(cifra);
  if (!m) throw new Error(`sin número en ${JSON.stringify(cifra)}`);
  return Number(`${m[1]}.${m[2]}`);
}

describe("el suelo que sostiene el paquete de npm", () => {
  it("recalculado desde el CSV sin tocar nada, da los suelos publicados al decimal: CSV, artefacto y estimador cuadran", () => {
    const r = sueloComoSeInstala(artefacto, ensayos, { reconstruir: false });
    expect(r.b0.lower).toBeCloseTo(artefacto.aggregate!.savings!.lower!, 9);
    if (artefacto.aggregateB1?.savings?.lower != null) {
      expect(r.b1!.lower).toBeCloseTo(artefacto.aggregateB1.savings.lower, 9);
    }
  });

  it("devolver lo que quitó una pieza que npm no trae nunca SUBE el suelo", () => {
    const tal = sueloComoSeInstala(artefacto, ensayos, { reconstruir: false });
    const r = sueloComoSeInstala(artefacto, ensayos);
    expect(r.menor).toBeLessThanOrEqual(tal.menor + 1e-12);
    if (!r.medidoTalCual) expect(r.reconstruidos.length).toBeGreaterThan(0);
  });

  const r = sueloComoSeInstala(artefacto, ensayos);
  // Truncado a una décima, nunca redondeado hacia arriba.
  const suelo = Math.floor(r.menor * 1000) / 10;
  const cifras: number[] = [];
  for (const f of readdirSync(MENSAJES).filter((f) => f.endsWith(".json"))) {
    it(`⛔ ${f}: la cifra del héroe cabe en lo que entrega npm (${suelo} %${r.medidoTalCual ? ", medido" : ", reconstruido"})`, () => {
      const d = JSON.parse(readFileSync(new URL(f, MENSAJES), "utf8")) as {
        landing: { hero: { proofs: { cifra: string }[] } };
      };
      const prometido = numeroDe(d.landing.hero.proofs[0]!.cifra);
      cifras.push(prometido);
      expect(prometido).toBeLessThanOrEqual(suelo);
    });
  }
  it("y los 12 idiomas dicen lo mismo", () => {
    expect(cifras).toHaveLength(12);
    expect(new Set(cifras).size).toBe(1);
  });
});

describe("la reconstrucción, sobre datos de juguete", () => {
  // Dos escenarios, dos ensayos cada uno. «comp» ahorra solo porque el
  // compresor del banco le quitó 1000 tokens de entrada al brazo B.
  const base: ArtefactoParaSuelo = {
    model: "openai/gpt-4o-mini",
    config: { seed: 7 },
    pricing: { table: { "gpt-4o-mini": { inputPer1k: 0.001 } } },
    aggregate: { savings: { point: 0.3, lower: 0.25, upper: 0.35 } },
    aggregateB1: { savings: { point: 0.28, lower: 0.2, upper: 0.33 } },
    levers: { exercised: [{ palanca: "compression", escenario: "comp" }] },
    scenarios: [{ name: "comp", measured: { inputTokenDeltaMean: 1000 } }, { name: "tabla" }],
  };
  const juguete: Ensayo[] = [
    { scenario: "tabla", costA: 0.002, costA1: 0.002, costB: 0.001 },
    { scenario: "tabla", costA: 0.002, costA1: 0.002, costB: 0.001 },
    { scenario: "comp", costA: 0.002, costA1: 0.002, costB: 0.001 },
    { scenario: "comp", costA: 0.002, costA1: 0.002, costB: 0.001 },
  ];

  it("devuelve la entrada al precio del modelo: el escenario de compresión pasa de ahorrar 50 % a 0 %", () => {
    const r = sueloComoSeInstala(base, juguete);
    expect(r.medidoTalCual).toBe(false);
    expect(r.reconstruidos).toEqual([
      { escenario: "comp", palanca: "compression", tokensDeEntradaDevueltos: 1000, usdPorEnsayo: 0.001 },
    ]);
    // tabla ahorra 0,001 de 0,002 y comp nada: 1 − (0,001 + 0,002) / (0,002 + 0,002) = 25 %.
    expect(r.b0.point).toBeCloseTo(0.25, 12);
    expect(r.menor).toBeCloseTo(0.25, 12);
  });

  it("un artefacto medido tal cual (`sdk.asShipped: true`) NO se reconstruye: mandan sus suelos", () => {
    const r = sueloComoSeInstala({ ...base, sdk: { asShipped: true } }, juguete);
    expect(r.medidoTalCual).toBe(true);
    expect(r.reconstruidos).toEqual([]);
    expect(r.menor).toBe(0.2);
  });

  it("sin palanca que npm no trae entre las ejercitadas, tampoco", () => {
    const r = sueloComoSeInstala({ ...base, levers: { exercised: [{ palanca: "toolDiscovery", escenario: "x" }] } }, juguete);
    expect(r.medidoTalCual).toBe(true);
  });

  it("lee el CSV con nombres entre comillas, como los escribe report.ts", () => {
    const csv =
      "scenario,kind,rep,costA,costA1,costB,savedFraction,savedFractionB1\n" +
      '"Hilo, reenviado",ran,0,0.002,,0.001,0.5,\n';
    expect(leerEnsayos(csv)).toEqual([{ scenario: "Hilo, reenviado", costA: 0.002, costA1: null, costB: 0.001 }]);
  });
});
