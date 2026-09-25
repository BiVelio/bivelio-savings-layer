import { describe, it, expect } from "vitest";

import {
  costePeorCaso,
  CUOTA_CORTA_MAXIMA,
  informeDelBancoPropio,
  MIN_PARES,
  MIN_PARES_POR_ESTRATO,
  motivoDeNoComparable,
  remuestreosPara,
  type FilaDeResumen,
  type Par,
} from "./banco-propio";
import { bootstrapEstratificadoPonderado, mulberry32 } from "./bootstrap";

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
      naiveFinishReason: "stop",
      naiveContract: "none",
    };
  });
}

/** Un par fijo: la copia cuesta `a`, la optimizada `b`. */
const par = (stratum: string, a: number, b: number, extra: Partial<Par> = {}): Par => ({
  stratum,
  naiveCost: a,
  optimizedCost: b,
  naiveInputTokens: 1000,
  naiveOutputTokens: 100,
  cachedInputPer1k: null,
  outputPer1k: 0.0006,
  naiveFinishReason: "stop",
  naiveContract: "none",
  ...extra,
});

/** El resumen exacto que devolvería `verification_summary` para estos pares (misma precedencia que el SQL). */
function resumenDe(ps: Par[], extra: FilaDeResumen[] = []): FilaDeResumen[] {
  const porEstrato = new Map<string, Par[]>();
  for (const p of ps) porEstrato.set(p.stratum, [...(porEstrato.get(p.stratum) ?? []), p]);
  return [
    ...[...porEstrato].map(([stratum, xs]) => ({
      outcome: "paired",
      stratum,
      samples: xs.length,
      naiveCost: xs.reduce((n, p) => n + p.naiveCost, 0),
      naiveTruncated: xs.filter((p) => motivoDeNoComparable(p) === "truncated").length,
      naiveIncomplete: xs.filter((p) => motivoDeNoComparable(p) === "incomplete").length,
      naiveContractMissed: xs.filter((p) => motivoDeNoComparable(p) === "contract_missed").length,
    })),
    ...extra,
  ];
}

const filaVacia = (outcome: string, stratum: string, samples: number): FilaDeResumen => ({
  outcome,
  stratum,
  samples,
  naiveCost: 0,
  naiveTruncated: 0,
  naiveIncomplete: 0,
  naiveContractMissed: 0,
});

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
    expect(r.falta).toBe("pares");
    expect(r.titular).toBeUndefined();
    expect(r.exclusiones).toEqual([{ motivo: "fail_open", peticiones: 3 }]);
  });

  it("reuniendo por GRUPOS: 36 pares repartidos y ningún estrato con 10 (antes: «Reuniendo 36 de 30»)", () => {
    const rng = mulberry32(2);
    const ps = [...pares("unchanged", 9, rng), ...pares("tokens_removed", 9, rng), ...pares("avoided_call", 9, rng), ...pares("cheaper_model", 9, rng)];
    const r = informeDelBancoPropio({ conteos: {}, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: 1 });
    expect(r.estado).toBe("reuniendo");
    expect(r.falta).toBe("grupos");
    expect(r.paresEnTitular).toBe(36);
    expect(r.cuotaCorta).toBe(1);
  });

  it("listo: titular, peor caso y estratos", () => {
    const rng = mulberry32(3);
    const ps = [...pares("unchanged", 40, rng, 0.05), ...pares("tokens_removed", 25, rng, 0.4)];
    const r = informeDelBancoPropio({
      conteos: { unchanged: 4000, tokens_removed: 1000, truncated: 12 },
      resumen: resumenDe(ps, [filaVacia("check_failed", "unchanged", 2)]),
      pares: ps,
      totalPares: ps.length,
      semilla: 99,
    });
    expect(r.estado).toBe("listo");
    expect(r.falta).toBeUndefined();
    expect(r.titular!.fraccion.lower).toBeLessThanOrEqual(r.titular!.fraccion.point);
    expect(r.titular!.fraccion.point).toBeLessThanOrEqual(r.titular!.fraccion.upper);
    expect(r.titular!.diferencia.lower).toBeLessThanOrEqual(r.titular!.diferencia.point);
    expect(r.titular!.diferencia.point).toBeLessThanOrEqual(r.titular!.diferencia.upper);
    expect(r.resultados).toEqual([{ resultado: "check_failed", muestras: 2 }]);
    expect(r.noComparables).toEqual({ truncadas: 0, incompletas: 0, incumplidas: 0 });
    expect(r.cobertura).toBe(1);
    expect(r.paresEnTitular).toBe(65);
    expect(r.tasaLograda).toBeCloseTo(65 / 5000, 12);
    expect(r.estratos.find((e) => e.estrato === "unchanged")!.diferencia).toBeDefined();
  });
});

describe("la regla simétrica: un par solo cuenta si la copia terminó como se le exige a la servida", () => {
  it("motivoDeNoComparable: la misma precedencia que clasificar() y que verification_summary", () => {
    const casos: Array<[string | null, string | null, ReturnType<typeof motivoDeNoComparable>]> = [
      ["stop", "none", null],
      ["stop", "met", null],
      ["tool_calls", "none", null],
      [null, "none", null],
      [null, null, null],
      ["length", "none", "truncated"],
      ["length", "missed", "truncated"],
      ["content_filter", "none", "incomplete"],
      ["stop_sequence", "met", "incomplete"],
      ["other", "missed", "incomplete"],
      ["stop", "missed", "contract_missed"],
      ["tool_calls", "missed", "contract_missed"],
      [null, "missed", "contract_missed"],
    ];
    for (const [fin, contrato, esperado] of casos) {
      expect(motivoDeNoComparable({ naiveFinishReason: fin, naiveContract: contrato }), `${fin}/${contrato}`).toBe(esperado);
    }
  });

  it("las copias cortadas, paradas o sin contrato no mueven NINGUNA cifra: el informe es el mismo sin ellas", () => {
    const rng = mulberry32(21);
    const limpios = [...pares("unchanged", 60, rng, 0.02), ...pares("tokens_removed", 30, rng, 0.3)];
    // Las no comparables, a propósito CARÍSIMAS en la copia: si entraran, inventarían ahorro.
    const sucios = [
      ...Array.from({ length: 15 }, () => par("unchanged", 0.05, 0.001, { naiveFinishReason: "length" })),
      ...Array.from({ length: 4 }, () => par("unchanged", 0.05, 0.001, { naiveFinishReason: "content_filter" })),
      ...Array.from({ length: 4 }, () => par("tokens_removed", 0.05, 0.001, { naiveContract: "missed" })),
    ];
    const conteos = { unchanged: 3000, tokens_removed: 1500 };
    const con = informeDelBancoPropio({ conteos, resumen: resumenDe([...limpios, ...sucios]), pares: [...limpios, ...sucios], totalPares: 113, semilla: 5 });
    const sin = informeDelBancoPropio({ conteos, resumen: resumenDe(limpios), pares: limpios, totalPares: 90, semilla: 5 });
    expect(con.estado).toBe("listo");
    expect(con.titular).toEqual(sin.titular);
    expect(con.peorCaso).toEqual(sin.peorCaso);
    expect(con.estratos.map((e) => [e.pares, e.diferencia])).toEqual(sin.estratos.map((e) => [e.pares, e.diferencia]));
    expect(con.paresEnTitular).toBe(90);
    expect(con.paresTotales).toBe(113);
    expect(con.noComparables).toEqual({ truncadas: 15, incompletas: 4, incumplidas: 4 });
  });

  it("NULO: una capa que no hace nada y el mismo tope en los dos brazos no fabrican ahorro (antes: +15 %)", () => {
    // El caso del revisor: salida 100-400 tokens o, con un 20 %, cortada en el
    // tope de 500, IGUAL en los dos brazos. La servida cortada ya se excluye
    // antes de mandar la copia; la copia cortada, antes de este arreglo, se
    // quedaba — y era la salida más cara posible.
    const TOPE = 500;
    const salida = (rng: () => number) => (rng() < 0.2 ? { tokens: TOPE, fin: "length" } : { tokens: 100 + Math.floor(rng() * 300), fin: "stop" });
    const coste = (t: number) => (200 / 1000) * 0.00015 + (t / 1000) * 0.0006;
    const suelos: number[] = [];
    let sesgoAsimetrico = 0;
    for (let s = 1; s <= 20; s++) {
      const rng = mulberry32(1000 + s);
      const ps: Par[] = [];
      let elegibles = 0;
      for (let i = 0; i < 1500; i++) {
        const servida = salida(rng);
        if (servida.fin === "length") continue; // excluida como `truncated`: ni copia ni par
        elegibles++;
        const copia = salida(rng);
        ps.push(par("unchanged", coste(copia.tokens), coste(servida.tokens), { naiveInputTokens: 200, naiveOutputTokens: copia.tokens, naiveFinishReason: copia.fin }));
      }
      const r = informeDelBancoPropio({ conteos: { unchanged: elegibles }, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: s, remuestreos: 400 });
      expect(r.estado).toBe("listo");
      suelos.push(r.titular!.fraccion.lower);
      // El mismo cálculo con la regla vieja (todas las copias dentro), para ver el agujero que se cierra.
      const a = ps.reduce((n, p) => n + p.naiveCost, 0);
      const b = ps.reduce((n, p) => n + p.optimizedCost, 0);
      sesgoAsimetrico += (1 - b / a) / 20;
    }
    expect(sesgoAsimetrico).toBeGreaterThan(0.1); // el agujero existía de verdad
    // Con la regla simétrica, un IC 95 % con el suelo por encima de cero debería
    // salir ~1 vez de cada 40 por azar; 20 tiradas, como mucho 2.
    expect(suelos.filter((x) => x > 0).length).toBeLessThanOrEqual(2);
  });
});

describe("ningún estrato con datos se queda fuera, y la verja de grupos cortos", () => {
  it("N_h = max(conteo, filas de muestra del estrato)", () => {
    const rng = mulberry32(4);
    const ps = pares("unchanged", 40, rng);
    const conMenos = informeDelBancoPropio({ conteos: { unchanged: 10 }, resumen: resumenDe(ps), pares: ps, totalPares: 40, semilla: 1 });
    expect(conMenos.estratos.find((e) => e.estrato === "unchanged")!.elegibles).toBe(40);
    const conMas = informeDelBancoPropio({ conteos: { unchanged: 900 }, resumen: resumenDe(ps), pares: ps, totalPares: 40, semilla: 1 });
    expect(conMas.estratos.find((e) => e.estrato === "unchanged")!.elegibles).toBe(900);
    expect(conMas.tasaLograda).toBeCloseTo(40 / 900, 12);
  });

  it("el caso del revisor 1: 20 evitadas, 9 sin cambios que PIERDEN y 1 con tokens quitados → sin titular (antes: «≥ 100 %»)", () => {
    const ps = [
      ...Array.from({ length: 20 }, () => par("avoided_call", 0.002, 0)),
      ...Array.from({ length: 9 }, () => par("unchanged", 0.002, 0.003)),
      par("tokens_removed", 0.002, 0.0019),
    ];
    const r = informeDelBancoPropio({ conteos: { avoided_call: 1000, unchanged: 450, tokens_removed: 50 }, resumen: resumenDe(ps), pares: ps, totalPares: 30, semilla: 1 });
    expect(r.estado).toBe("reuniendo");
    expect(r.falta).toBe("grupos");
    expect(r.titular).toBeUndefined();
    expect(r.peorCaso).toBeUndefined();
    expect(r.cuotaCorta).toBeCloseTo(500 / 1500, 12);
    // Los pares de los grupos cortos siguen contando: el titular, cuando llegue, los llevará.
    expect(r.estratos.find((e) => e.estrato === "unchanged")!.enTitular).toBe(true);
  });

  it("el caso del revisor 3: 10 pares que ahorran y 20 repartidos que pierden → sin titular (antes: «≥ 40,7 %» sobre el 20 %)", () => {
    const ps = [
      ...Array.from({ length: 10 }, (_, i) => par("tokens_removed", 0.001 + i * 1e-5, 0.0006 + (i % 3) * 1e-5)),
      ...["avoided_call", "cheaper_model", "tokens_compressed", "unchanged"].flatMap((h) => Array.from({ length: 5 }, () => par(h, 0.001, 0.0011))),
    ];
    const conteos = { tokens_removed: 500, avoided_call: 500, cheaper_model: 500, tokens_compressed: 500, unchanged: 500 };
    const r = informeDelBancoPropio({ conteos, resumen: resumenDe(ps), pares: ps, totalPares: 30, semilla: 1 });
    expect(r.estado).toBe("reuniendo");
    expect(r.falta).toBe("grupos");
    expect(r.titular).toBeUndefined();
  });

  it(`grupos cortos ≤ ${CUOTA_CORTA_MAXIMA * 100} %: hay titular y SUS PARES ENTRAN con su peso (no se tiran)`, () => {
    const rng = mulberry32(5);
    const ps = [...pares("unchanged", 60, rng, 0.3), ...Array.from({ length: 4 }, () => par("cheaper_model", 0.001, 0.004))];
    const conteos = { unchanged: 3000, cheaper_model: 150 }; // 150 / 3150 = 4,8 %
    const r = informeDelBancoPropio({ conteos, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: 1 });
    expect(r.estado).toBe("listo");
    const baratas = r.estratos.find((e) => e.estrato === "cheaper_model")!;
    expect(baratas.cubierto).toBe(false);
    expect(baratas.enTitular).toBe(true);
    expect(baratas.diferencia).toBeUndefined();
    expect(r.cobertura).toBe(1);
    expect(r.paresEnTitular).toBe(64);
    // El grupo que pierde BAJA el titular respecto a quitarlo (la regla vieja).
    const sinEl = informeDelBancoPropio({ conteos: { unchanged: 3000 }, resumen: resumenDe(ps.slice(0, 60)), pares: ps.slice(0, 60), totalPares: 60, semilla: 1 });
    expect(r.titular!.fraccion.point).toBeLessThan(sinEl.titular!.fraccion.point);
  });

  it("un grupo SIN pares (≤ 5 %) queda fuera del titular y la cobertura lo dice", () => {
    const rng = mulberry32(6);
    const ps = pares("unchanged", 60, rng);
    const r = informeDelBancoPropio({ conteos: { unchanged: 3000, avoided_call: 100 }, resumen: resumenDe(ps), pares: ps, totalPares: 60, semilla: 1 });
    expect(r.estado).toBe("listo");
    expect(r.cobertura).toBeCloseTo(3000 / 3100, 12);
    expect(r.estratos.find((e) => e.estrato === "avoided_call")!.enTitular).toBe(false);
  });

  it("el titular pesa por población, no por pares", () => {
    const rng = mulberry32(7);
    const ps = [...pares("unchanged", 200, rng, 0), ...pares("avoided_call", 12, rng, 1)];
    const pocasEvitadas = informeDelBancoPropio({ conteos: { unchanged: 9900, avoided_call: 100 }, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: 1 });
    const muchasEvitadas = informeDelBancoPropio({ conteos: { unchanged: 100, avoided_call: 9900 }, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: 1 });
    expect(pocasEvitadas.titular!.fraccion.point).toBeLessThan(0.1);
    expect(muchasEvitadas.titular!.fraccion.point).toBeGreaterThan(0.9);
  });

  it("propiedad (300 semillas): con muestreo proporcional y grupos cortos que PIERDEN, el titular coincide con juntarlo todo en un estrato", () => {
    let listos = 0;
    for (let s = 1; s <= 300; s++) {
      const rng = mulberry32(s);
      // Tasa lograda común r: cada estrato aporta ≈ r·N_h pares (Bernoulli por requestId).
      const N = { unchanged: 2000 + Math.floor(rng() * 2000), tokens_removed: 800 + Math.floor(rng() * 800), cheaper_model: 40 + Math.floor(rng() * 60) };
      const r = 0.02;
      const n = (h: keyof typeof N) => Math.max(1, Math.round(N[h] * r));
      const ps = [
        ...pares("unchanged", n("unchanged"), rng, 0.02),
        ...pares("tokens_removed", n("tokens_removed"), rng, 0.35),
        ...pares("cheaper_model", n("cheaper_model"), rng, -0.8), // la capa pierde
      ];
      // Pesos EXACTAMENTE proporcionales a los pares: la igualdad es exacta.
      const conteos = { unchanged: n("unchanged") * 50, tokens_removed: n("tokens_removed") * 50, cheaper_model: n("cheaper_model") * 50 };
      const inf = informeDelBancoPropio({ conteos, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: s, remuestreos: 200 });
      if (inf.estado !== "listo") continue;
      listos++;
      expect(inf.estratos.find((e) => e.estrato === "cheaper_model")!.enTitular).toBe(true);
      const a = ps.reduce((m, p) => m + p.naiveCost, 0);
      const b = ps.reduce((m, p) => m + p.optimizedCost, 0);
      const juntos = 1 - b / a;
      expect(inf.titular!.fraccion.point, `semilla ${s}`).toBeCloseTo(juntos, 10);
      expect(inf.titular!.fraccion.lower, `semilla ${s}`).toBeLessThanOrEqual(juntos + 1e-12);
    }
    // La propiedad no puede pasar en vacío: casi todas las semillas llegan a titular.
    expect(listos).toBeGreaterThan(250);
  });
});

describe("el peor caso", () => {
  it("par a par, la copia en el peor caso nunca vale más que la medida", () => {
    const rng = mulberry32(8);
    for (const p of [...pares("unchanged", 500, rng), par("unchanged", 0.001, 0.001, { cachedInputPer1k: 1 })]) {
      expect(costePeorCaso(p)).toBeLessThanOrEqual(p.naiveCost);
    }
  });

  it("SIN ACOTAR, el suelo del peor caso ya es ≤ el suelo medido (500 semillas): la cota no la fabrica el `min`", () => {
    for (let s = 1; s <= 500; s++) {
      const rng = mulberry32(s);
      const ps = [...pares("unchanged", 30 + (s % 7), rng, rng() - 0.3), ...pares("tokens_removed", 10 + (s % 5), rng, rng())];
      const conteos = { unchanged: 100 + s, tokens_removed: 50 };
      const r = informeDelBancoPropio({ conteos, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: s, remuestreos: 200 });
      expect(r.estado, `semilla ${s}`).toBe("listo");
      expect(r.peorCaso!.sinAcotar.lower, `semilla ${s}`).toBeLessThanOrEqual(r.titular!.fraccion.lower);
      // Y es de verdad el bootstrap del peor caso, no una copia del titular.
      const porEstrato = (h: string) => ps.filter((p) => p.stratum === h);
      const directo = bootstrapEstratificadoPonderado(
        (["tokens_removed", "unchanged"] as const).map((h) => ({ peso: conteos[h], a: porEstrato(h).map(costePeorCaso), b: porEstrato(h).map((p) => p.optimizedCost) })),
        { remuestreos: 200, alfa: 0.05, semilla: s },
      ).fraccion;
      expect(r.peorCaso!.sinAcotar, `semilla ${s}`).toEqual(directo);
      expect(r.titular!.fraccion.lower, `semilla ${s}`).toBeLessThanOrEqual(r.titular!.fraccion.point);
      expect(r.titular!.fraccion.point, `semilla ${s}`).toBeLessThanOrEqual(r.titular!.fraccion.upper);
    }
  });

  it("el borde que sí necesita la cota: copias gratis en el peor caso y un titular negativo", () => {
    // Sin tarifa cacheada y sin precio de salida, la copia en el peor caso vale 0:
    // Σ = 0 → fracción 0 por convención, POR ENCIMA de un titular negativo.
    const ps = Array.from({ length: 40 }, (_, i) => par("unchanged", 0.001, 0.0015 + i * 1e-6, { outputPer1k: 0, cachedInputPer1k: null }));
    const r = informeDelBancoPropio({ conteos: { unchanged: 2000 }, resumen: resumenDe(ps), pares: ps, totalPares: 40, semilla: 3 });
    expect(r.estado).toBe("listo");
    expect(r.titular!.fraccion.lower).toBeLessThan(0);
    expect(r.peorCaso!.sinAcotar.lower).toBe(0);
    expect(r.peorCaso!.fraccion.lower).toBe(r.titular!.fraccion.lower);
  });
});

describe("contabilidad", () => {
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
    expect(r.paresLeidos).toBe(40);
  });

  it("el coste: Σ naive del resumen; sin coste medible, también las fallidas y las agotadas (pueden estar facturadas)", () => {
    const ps = pares("unchanged", 40, mulberry32(9));
    const r = informeDelBancoPropio({
      conteos: {},
      resumen: resumenDe(ps, [
        filaVacia("check_unmeasured", "unchanged", 3),
        filaVacia("abandoned", "unchanged", 2),
        filaVacia("check_failed", "unchanged", 7),
        filaVacia("dropped", "unchanged", 11),
      ]),
      pares: ps,
      totalPares: 40,
      semilla: 1,
    });
    expect(r.coste.usd).toBeCloseTo(ps.reduce((n, p) => n + p.naiveCost, 0), 12);
    expect(r.coste.copias).toBe(40);
    // Las `dropped` nunca salieron: no cuentan.
    expect(r.coste.sinCoste).toBe(12);
  });

  it(`el mínimo de pares es de pares EN EL TITULAR, no leídos: ${MIN_PARES} pares con copias cortadas no bastan`, () => {
    const rng = mulberry32(10);
    const ps = [...pares("unchanged", MIN_PARES - 5, rng), ...Array.from({ length: 10 }, () => par("unchanged", 0.01, 0.001, { naiveFinishReason: "length" }))];
    const r = informeDelBancoPropio({ conteos: { unchanged: 2000 }, resumen: resumenDe(ps), pares: ps, totalPares: ps.length, semilla: 1 });
    expect(r.paresLeidos).toBe(MIN_PARES + 5);
    expect(r.paresEnTitular).toBe(MIN_PARES - 5);
    expect(r.estado).toBe("reuniendo");
    expect(r.falta).toBe("pares");
    expect(MIN_PARES_POR_ESTRATO).toBe(10);
  });
});
