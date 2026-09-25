import { describe, it, expect } from "vitest";

import {
  informeDelBancoPropio,
  MIN_PARES,
  MIN_PARES_POR_ESTRATO,
  remuestreosPara,
  type FilaDeResumen,
  type Par,
} from "./banco-propio";
import { mulberry32 } from "./bootstrap";

function pares(estrato: string, n: number, rng: () => number, ahorro = 0.3): Par[] {
  return Array.from({ length: n }, () => {
    const entrada = 500 + Math.floor(rng() * 3000);
    const salida = 50 + Math.floor(rng() * 400);
    const naiveCost = (entrada / 1000) * 0.00015 + (salida / 1000) * 0.0006;
    return {
      stratum: estrato,
      naiveCost,
      optimizedCost: naiveCost * (1 - ahorro + (rng() - 0.5) * 0.4),
      naiveInputTokens: entrada,
      naiveOutputTokens: salida,
      cachedInputPer1k: rng() < 0.5 ? 0.000075 : null,
      outputPer1k: 0.0006,
    };
  });
}

function resumenDe(ps: Par[], extra: FilaDeResumen[] = []): FilaDeResumen[] {
  const porEstrato = new Map<string, Par[]>();
  for (const p of ps) porEstrato.set(p.stratum, [...(porEstrato.get(p.stratum) ?? []), p]);
  return [
    ...[...porEstrato].map(([stratum, xs]) => ({
      outcome: "paired",
      stratum,
      samples: xs.length,
      naiveCost: xs.reduce((n, p) => n + p.naiveCost, 0),
      naiveTruncated: 1,
      naiveContractMissed: 0,
    })),
    ...extra,
  ];
}

describe("los tres estados", () => {
  it("sin_datos: ni conteos ni filas", () => {
    const r = informeDelBancoPropio({ conteos: {}, resumen: [], pares: [], totalPares: 0, semilla: 1 });
    expect(r.estado).toBe("sin_datos");
    expect(r.titular).toBeUndefined();
  });

  it(`reuniendo: menos de ${MIN_PARES} pares`, () => {
    const ps = pares("unchanged", MIN_PARES - 1, mulberry32(1));
    const r = informeDelBancoPropio({ conteos: { unchanged: 500, fail_open: 3 }, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: 1 });
    expect(r.estado).toBe("reuniendo");
    expect(r.titular).toBeUndefined();
    expect(r.exclusiones).toEqual([{ motivo: "fail_open", peticiones: 3 }]);
  });

  it("reuniendo: con 30 pares repartidos y ningún estrato cubierto", () => {
    const rng = mulberry32(2);
    const ps = [...pares("unchanged", 9, rng), ...pares("tokens_removed", 9, rng), ...pares("avoided_call", 9, rng), ...pares("cheaper_model", 9, rng)];
    const r = informeDelBancoPropio({ conteos: {}, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: 1 });
    expect(r.estado).toBe("reuniendo");
  });

  it("listo: titular, peor caso y estratos", () => {
    const rng = mulberry32(3);
    const ps = [...pares("unchanged", 40, rng, 0.05), ...pares("tokens_removed", 25, rng, 0.4)];
    const r = informeDelBancoPropio({
      conteos: { unchanged: 4000, tokens_removed: 1000, truncated: 12 },
      resumen: resumenDe(ps, [{ outcome: "check_failed", stratum: "unchanged", samples: 2, naiveCost: 0, naiveTruncated: 0, naiveContractMissed: 0 }]),
      pares: ps,
      totalPares: ps.length,
      semilla: 99,
    });
    expect(r.estado).toBe("listo");
    expect(r.titular!.fraccion.lower).toBeLessThanOrEqual(r.titular!.fraccion.point);
    expect(r.titular!.fraccion.point).toBeLessThanOrEqual(r.titular!.fraccion.upper);
    expect(r.titular!.diferencia.lower).toBeLessThanOrEqual(r.titular!.diferencia.point);
    expect(r.titular!.diferencia.point).toBeLessThanOrEqual(r.titular!.diferencia.upper);
    expect(r.resultados).toEqual([{ resultado: "check_failed", muestras: 2 }]);
    expect(r.calidad).toEqual({ truncadas: 2, incumplidas: 0 });
    expect(r.cobertura).toBe(1);
    expect(r.estratos.find((e) => e.estrato === "unchanged")!.diferencia).toBeDefined();
  });
});

describe("pesos y cobertura", () => {
  it("N_h = max(conteo, filas de muestra del estrato)", () => {
    const rng = mulberry32(4);
    const ps = pares("unchanged", 40, rng);
    const conMenos = informeDelBancoPropio({ conteos: { unchanged: 10 }, resumen: resumenDe(ps), pares: ps, totalPares: 40, semilla: 1 });
    expect(conMenos.estratos.find((e) => e.estrato === "unchanged")!.elegibles).toBe(40);
    const conMas = informeDelBancoPropio({ conteos: { unchanged: 900 }, resumen: resumenDe(ps), pares: ps, totalPares: 40, semilla: 1 });
    expect(conMas.estratos.find((e) => e.estrato === "unchanged")!.elegibles).toBe(900);
    expect(conMas.tasaLograda).toBeCloseTo(40 / 900, 12);
  });

  it(`un estrato con menos de ${MIN_PARES_POR_ESTRATO} pares queda fuera y baja la cobertura`, () => {
    const rng = mulberry32(5);
    const ps = [...pares("unchanged", 40, rng), ...pares("avoided_call", MIN_PARES_POR_ESTRATO - 1, rng, 1)];
    const r = informeDelBancoPropio({ conteos: { unchanged: 3000, avoided_call: 1000 }, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: 1 });
    const evitadas = r.estratos.find((e) => e.estrato === "avoided_call")!;
    expect(evitadas.cubierto).toBe(false);
    expect(evitadas.diferencia).toBeUndefined();
    expect(r.cobertura).toBeCloseTo(0.75, 12);
    // Sin el estrato que ahorra el 100 %, el titular no lo recoge: lado seguro.
    expect(r.titular!.fraccion.upper).toBeLessThan(0.9);
  });

  it("el titular pesa por población, no por pares", () => {
    const rng = mulberry32(6);
    const ps = [...pares("unchanged", 200, rng, 0), ...pares("avoided_call", 12, rng, 1)];
    const pocasEvitadas = informeDelBancoPropio({ conteos: { unchanged: 9900, avoided_call: 100 }, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: 1 });
    const muchasEvitadas = informeDelBancoPropio({ conteos: { unchanged: 100, avoided_call: 9900 }, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: 1 });
    expect(pocasEvitadas.titular!.fraccion.point).toBeLessThan(0.1);
    expect(muchasEvitadas.titular!.fraccion.point).toBeGreaterThan(0.9);
  });
});

describe("propiedades", () => {
  it("el suelo del peor caso es ≤ el suelo medido (500 semillas)", () => {
    for (let s = 1; s <= 500; s++) {
      const rng = mulberry32(s);
      const ps = [...pares("unchanged", 30 + (s % 7), rng, rng() - 0.3), ...pares("tokens_removed", 10 + (s % 5), rng, rng())];
      const r = informeDelBancoPropio({ conteos: { unchanged: 100 + s, tokens_removed: 50 }, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: s, remuestreos: 200 });
      expect(r.estado, `semilla ${s}`).toBe("listo");
      expect(r.peorCaso!.fraccion.lower, `semilla ${s}`).toBeLessThanOrEqual(r.titular!.fraccion.lower);
      expect(r.titular!.fraccion.lower, `semilla ${s}`).toBeLessThanOrEqual(r.titular!.fraccion.point);
      expect(r.titular!.fraccion.point, `semilla ${s}`).toBeLessThanOrEqual(r.titular!.fraccion.upper);
    }
  });

  it("los remuestreos: min(10 000, max(1 000, ⌊4·10⁷/n⌋))", () => {
    expect(remuestreosPara(30)).toBe(10_000);
    expect(remuestreosPara(4_000)).toBe(10_000);
    expect(remuestreosPara(8_000)).toBe(5_000);
    expect(remuestreosPara(20_000)).toBe(2_000);
    expect(remuestreosPara(100_000)).toBe(1_000);
  });

  it("la marca de submuestreo", () => {
    const ps = pares("unchanged", 40, mulberry32(8));
    expect(informeDelBancoPropio({ conteos: {}, resumen: resumenDe(ps), pares: ps, totalPares: 40, semilla: 1 }).submuestreado).toBe(false);
    const r = informeDelBancoPropio({ conteos: {}, resumen: resumenDe(ps), pares: ps, totalPares: 25_000, semilla: 1 });
    expect(r.submuestreado).toBe(true);
    expect(r.paresTotales).toBe(25_000);
  });

  it("el coste: Σ naive del resumen y las copias sin coste conocido", () => {
    const ps = pares("unchanged", 40, mulberry32(9));
    const r = informeDelBancoPropio({
      conteos: {},
      resumen: resumenDe(ps, [
        { outcome: "check_unmeasured", stratum: "unchanged", samples: 3, naiveCost: 0, naiveTruncated: 0, naiveContractMissed: 0 },
        { outcome: "abandoned", stratum: "unchanged", samples: 2, naiveCost: 0, naiveTruncated: 0, naiveContractMissed: 0 },
        { outcome: "check_failed", stratum: "unchanged", samples: 7, naiveCost: 0, naiveTruncated: 0, naiveContractMissed: 0 },
      ]),
      pares: ps,
      totalPares: 40,
      semilla: 1,
    });
    expect(r.coste.usd).toBeCloseTo(ps.reduce((n, p) => n + p.naiveCost, 0), 12);
    expect(r.coste.copias).toBe(40);
    expect(r.coste.sinCoste).toBe(5);
  });
});
