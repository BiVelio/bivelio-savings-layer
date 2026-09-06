import { describe, expect, it } from "vitest";

import {
  MIN_DIAS_POR_BRAZO,
  bootstrapDosMuestras,
  diaDe,
  elisionDeCuerpoSse,
  esDialNuestro,
  resumir,
  usageFusionado,
  type TurnoAnillo2,
} from "../benchmarks/anillo2/nucleo.js";
import { configDeDiales } from "../gateway/diales.js";

/** Un turno con todo lo aburrido rellenado. */
function turno(sobre: Partial<TurnoAnillo2>): TurnoAnillo2 {
  return {
    dia: "2026-09-08",
    brazo: "control",
    model: "claude-fable-5",
    sesion: "s1",
    entradaUsd: 1,
    salidaUsd: 0.1,
    entradaTokens: 100_000,
    salidaTokens: 1_000,
    borrados: 0,
    tokensLimpiados: 0,
    respuestaOmitida: false,
    ...sobre,
  };
}

describe("esDialNuestro — la firma del brazo palanca", () => {
  it("reconoce EXACTAMENTE la config que inyecta la palanca", () => {
    expect(esDialNuestro(configDeDiales())).toBe(true);
  });

  it("⛔ el context_management de fábrica de Claude Code NO es nuestro", () => {
    // El corpus lleva 75,2 % de peticiones con context_management ajeno (otros
    // umbrales); clasificarlo como palanca contaminaría el brazo control.
    expect(
      esDialNuestro({
        edits: [
          {
            type: "clear_tool_uses_20250919",
            trigger: { type: "input_tokens", value: 100_000 },
            keep: { type: "tool_uses", value: 3 },
            clear_at_least: { type: "input_tokens", value: 0 },
          },
        ],
      }),
    ).toBe(false);
  });

  it("ausente, nulo o malformado → control", () => {
    expect(esDialNuestro(undefined)).toBe(false);
    expect(esDialNuestro(null)).toBe(false);
    expect(esDialNuestro({ edits: "no" })).toBe(false);
    expect(esDialNuestro({})).toBe(false);
  });
});

describe("elisionDeCuerpoSse — applied_edits del cuerpo crudo", () => {
  it("suma los cleared_input_tokens de los message_delta", () => {
    const sse = [
      `event: message_start\ndata: {"message":{"usage":{"input_tokens":5}}}`,
      `event: message_delta\ndata: {"usage":{"output_tokens":4},"context_management":{"applied_edits":[{"type":"clear_tool_uses_20250919","cleared_input_tokens":28543}]}}`,
      `event: message_stop\ndata: {}`,
    ].join("\n\n");
    expect(elisionDeCuerpoSse(sse)).toEqual({ borrados: 1, tokensLimpiados: 28543 });
  });

  it("sin applied_edits (la respuesta típica) → null, no un cero fantasma", () => {
    const sse = `event: message_delta\ndata: {"usage":{"output_tokens":4},"context_management":null}`;
    expect(elisionDeCuerpoSse(sse)).toBeNull();
    expect(elisionDeCuerpoSse("data: no-es-json\n\nbasura")).toBeNull();
  });
});

describe("usageFusionado — la regla del ObservadorSse", () => {
  it("fusiona eventos y el desglose anidado no se pisa", () => {
    const uso = usageFusionado([
      { usage: { input_tokens: 3, cache_creation: { ephemeral_1h_input_tokens: 100 } } },
      { usage: { output_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 5 } } },
    ]);
    expect(uso).toMatchObject({
      input_tokens: 3,
      output_tokens: 7,
      cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 5 },
    });
    expect(usageFusionado([])).toBeNull();
  });
});

describe("diaDe", () => {
  it("día natural UTC; basura → null", () => {
    expect(diaDe("2026-09-08T14:03:00.000Z")).toBe("2026-09-08");
    expect(diaDe("ayer")).toBeNull();
  });
});

describe("bootstrapDosMuestras", () => {
  it("es determinista (PRNG sembrado) y acierta el signo", () => {
    const a = bootstrapDosMuestras([10, 11, 12], [5, 6, 7]);
    const b = bootstrapDosMuestras([10, 11, 12], [5, 6, 7]);
    expect(a).toEqual(b);
    expect(a.media).toBeCloseTo(5, 10);
    expect(a.inferior).toBeGreaterThan(0);
  });
});

describe("resumir — el veredicto del A/B de días", () => {
  const diasControl = ["2026-09-08", "2026-09-10", "2026-09-12"];
  const diasPalanca = ["2026-09-09", "2026-09-11", "2026-09-13"];

  function corpus(entradaUsdPalanca: number): TurnoAnillo2[] {
    const ts: TurnoAnillo2[] = [];
    for (const dia of diasControl) ts.push(turno({ dia, brazo: "control", entradaUsd: 10, sesion: `c-${dia}` }));
    for (const dia of diasPalanca)
      ts.push(
        turno({
          dia,
          brazo: "palanca",
          entradaUsd: entradaUsdPalanca,
          sesion: `p-${dia}`,
          borrados: 2,
          tokensLimpiados: 30_000,
        }),
      );
    return ts;
  }

  it("con la palanca más barata, el ahorro sale en % de factura con IC", () => {
    const r = resumir(corpus(8));
    expect(r.veredicto.estado).toBe("ok");
    if (r.veredicto.estado !== "ok") return;
    // 10 → 8 €/kTok de salida = 20 % de ahorro.
    expect(r.veredicto.ahorroPctFactura).toBeCloseTo(20, 1);
    expect(r.veredicto.significativo).toBe(true);
    // 3 días × 30.000 = 90.000 tokens = 0,09 M → 0,1 con un decimal.
    expect(r.porBrazo.palanca.tokensLimpiadosM).toBeCloseTo(0.1, 5);
  });

  it("⛔ menos de MIN_DIAS_POR_BRAZO días en un brazo → insuficiente, jamás un %", () => {
    const pocos = corpus(8).filter((t) => t.dia !== "2026-09-13");
    const r = resumir(pocos);
    expect(r.veredicto.estado).toBe("insuficiente");
    if (r.veredicto.estado !== "insuficiente") return;
    expect(r.veredicto.diasPalanca).toBe(MIN_DIAS_POR_BRAZO - 1);
  });

  it("⛔ días de palanca con CERO borrados declarados → palanca-sin-disparos", () => {
    const sinDisparos = corpus(10).map((t) =>
      t.brazo === "palanca" ? { ...t, borrados: 0, tokensLimpiados: 0 } : t,
    );
    expect(resumir(sinDisparos).veredicto.estado).toBe("palanca-sin-disparos");
  });

  it("la verja por modelo señala dónde la palanca sale PEOR", () => {
    // fable ahorra; opus-4-8 empeora (el patrón real del replay del 06-09).
    const ts = [
      ...corpus(8),
      turno({ dia: "2026-09-08", brazo: "control", model: "claude-opus-4-8", entradaUsd: 5, sesion: "oc" }),
      turno({
        dia: "2026-09-09",
        brazo: "palanca",
        model: "claude-opus-4-8",
        entradaUsd: 6,
        sesion: "op",
        borrados: 1,
        tokensLimpiados: 1_000,
      }),
    ];
    const r = resumir(ts);
    expect(r.porModelo["claude-opus-4-8"]!.peorConPalanca).toBe(true);
    expect(r.porModelo["claude-fable-5"]!.peorConPalanca).toBe(false);
    expect(r.porModelo["claude-opus-4-8"]!.ahorroPct).toBeLessThan(0);
  });

  it("un día sin tokens de salida no entra en la métrica (sin denominador no hay dato)", () => {
    const ts = corpus(8);
    ts.push(turno({ dia: "2026-09-14", brazo: "palanca", salidaTokens: 0, salidaUsd: 0, sesion: "mudo" }));
    const r = resumir(ts);
    expect(r.veredicto.estado).toBe("ok");
    if (r.veredicto.estado !== "ok") return;
    expect(r.veredicto.diasPalanca).toBe(3);
  });
});
