import { describe, expect, it } from "vitest";

import {
  MIN_DIAS_POR_BRAZO,
  PROTOCOLO_PARIDAD,
  auditarParidad,
  bootstrapDosMuestras,
  bootstrapEstratificado,
  brazoEsperado,
  configDelCliente,
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
    expect(elisionDeCuerpoSse(sse)).toEqual({ borrados: 1, tokensLimpiados: 28543, tokensLimpiadosToolUses: 28543 });
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

describe("auditoría de paridad — el protocolo frente al cuerpo", () => {
  it("brazoEsperado: día natural UTC par = palanca, impar = control", () => {
    expect(brazoEsperado("2026-09-06")).toBe("palanca");
    expect(brazoEsperado("2026-09-07")).toBe("control");
    expect(brazoEsperado("2026-09-30")).toBe("palanca");
    expect(brazoEsperado("2026-10-01")).toBe("control");
  });

  it("configDelCliente: lo que trae el cliente aparte de nuestro edit", () => {
    expect(configDelCliente({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] })).toBe("clear_thinking");
    // Un cuerpo de PALANCA fusionado: nuestro edit no cuenta como «del cliente».
    expect(
      configDelCliente({ edits: [{ type: "clear_thinking_20251015", keep: "all" }, ...configDeDiales().edits] }),
    ).toBe("clear_thinking");
    expect(configDelCliente(configDeDiales())).toBe("ninguna");
    expect(configDelCliente({ edits: [{ type: "clear_tool_uses_20250919", trigger: { value: 100_000 } }] })).toBe(
      "clear_tool_uses_ajeno",
    );
    expect(
      configDelCliente({ edits: [{ type: "futura" }, { type: "clear_thinking_20251015" }] }),
    ).toBe("clear_thinking+otra");
    expect(configDelCliente(undefined)).toBe("ninguna");
    expect(configDelCliente({ edits: "no" })).toBe("ninguna");
  });

  it("lista las fisuras: par sin palanca, impar con palanca, día mezclado, palanca sin disparos, cliente cambiado, hueco", () => {
    const ts: TurnoAnillo2[] = [
      turno({ dia: "2026-09-07", brazo: "control", cliente: "claude-cli/2.1.260" }), // impar limpio
      turno({ dia: "2026-09-08", brazo: "control", cliente: "claude-cli/2.1.260" }), // par SIN palanca
      turno({ dia: "2026-09-09", brazo: "palanca", borrados: 1, tokensLimpiados: 10, cliente: "claude-cli/2.1.260" }), // impar CON palanca
      turno({ dia: "2026-09-10", brazo: "control", cliente: "claude-cli/2.1.260" }),
      turno({ dia: "2026-09-10", brazo: "palanca", cliente: "claude-cli/2.1.261" }), // mezclado + sin disparos + 2 clientes
      turno({ dia: "2026-09-12", brazo: "palanca", borrados: 2, tokensLimpiados: 40_000, cliente: "claude-cli/2.1.261" }), // par limpio; el 11 falta
    ];
    const p = auditarParidad(ts);
    expect(p.protocolo).toBe(PROTOCOLO_PARIDAD);
    const por = Object.fromEntries(p.dias.map((d) => [d.dia, d]));
    expect(por["2026-09-07"]!.limpio).toBe(true);
    expect(por["2026-09-07"]!.fisuras).toEqual([]);
    expect(por["2026-09-08"]!.limpio).toBe(false);
    expect(por["2026-09-08"]!.fisuras.join(" ")).toMatch(/día PAR sin palanca/);
    expect(por["2026-09-09"]!.limpio).toBe(false);
    expect(por["2026-09-09"]!.fisuras.join(" ")).toMatch(/día IMPAR con 1 turnos de palanca/);
    const mezclado = por["2026-09-10"]!;
    expect(mezclado.limpio).toBe(false);
    expect(mezclado.observado).toEqual({ control: 1, palanca: 1 });
    expect(mezclado.fisuras.join(" | ")).toMatch(/día mezclado/);
    expect(mezclado.fisuras.join(" | ")).toMatch(/palanca sin disparos/);
    expect(mezclado.fisuras.join(" | ")).toMatch(/2 versiones de cliente/);
    expect(por["2026-09-12"]!.limpio).toBe(true);
    expect(por["2026-09-12"]!.tokensLimpiadosPalancaM).toBeCloseTo(0, 5);
    expect(por["2026-09-12"]!.configCliente).toEqual({ "?": 1 });
    expect(p.fisuras.join(" | ")).toMatch(/días sin tráfico en la ventana: 2026-09-11/);
    expect(p.fisuras.join(" | ")).toMatch(/solo 1 días limpios de palanca/);
    expect(p.fisuras.join(" | ")).toMatch(/solo 1 días limpios de control/);
    expect(p.fisuras.join(" | ")).toMatch(/el cliente cambió de versión/);
  });

  it("el informe entero lleva la auditoría y el corpus real de hoy (todo control) sale como «par sin palanca»", () => {
    const r = resumir([turno({ dia: "2026-09-06", brazo: "control" }), turno({ dia: "2026-09-05", brazo: "control" })]);
    expect(r.paridad.dias.map((d) => [d.dia, d.esperado, d.limpio])).toEqual([
      ["2026-09-05", "control", true],
      ["2026-09-06", "palanca", false],
    ]);
  });
});

describe("veredicto estratificado por modelo — la mezcla de modelos no fabrica efecto", () => {
  const diasC = ["2026-09-07", "2026-09-09", "2026-09-11"];
  const diasP = ["2026-09-08", "2026-09-10", "2026-09-12"];

  /** Dos modelos con métricas ×10 distintas; la palanca ahorra el 20 % en los dos. */
  function corpusDosModelos(ahorroPct = 20): TurnoAnillo2[] {
    const ts: TurnoAnillo2[] = [];
    const f = 1 - ahorroPct / 100;
    for (const dia of diasC) {
      ts.push(turno({ dia, brazo: "control", model: "caro", entradaUsd: 10, salidaTokens: 1_000, sesion: `c1-${dia}` }));
      ts.push(turno({ dia, brazo: "control", model: "barato", entradaUsd: 1, salidaTokens: 1_000, sesion: `c2-${dia}` }));
    }
    for (const dia of diasP) {
      ts.push(
        turno({ dia, brazo: "palanca", model: "caro", entradaUsd: 10 * f, salidaTokens: 1_000, sesion: `p1-${dia}`, borrados: 1, tokensLimpiados: 5_000 }),
      );
      ts.push(
        turno({ dia, brazo: "palanca", model: "barato", entradaUsd: 1 * f, salidaTokens: 1_000, sesion: `p2-${dia}`, borrados: 1, tokensLimpiados: 500 }),
      );
    }
    return ts;
  }

  it("bootstrapEstratificado es determinista y pondera por el peso de cada estrato", () => {
    const a = bootstrapEstratificado([
      { peso: 30, control: [10, 10, 10], palanca: [8, 8, 8] }, // 20 %
      { peso: 3, control: [1, 1, 1], palanca: [1, 1, 1] }, // 0 %
    ]);
    const b = bootstrapEstratificado([
      { peso: 30, control: [10, 10, 10], palanca: [8, 8, 8] },
      { peso: 3, control: [1, 1, 1], palanca: [1, 1, 1] },
    ]);
    expect(a).toEqual(b);
    // (30·2 + 3·0) / (30·10 + 3·1) = 60 / 303 = 19,8 %
    expect(a.ahorroPct).toBeCloseTo(19.8, 1);
    expect(a.inferior).toBeCloseTo(19.8, 1);
    expect(a.superior).toBeCloseTo(19.8, 1);
  });

  it("con el mismo 20 % en cada modelo, el titular estratificado dice 20 % con IC", () => {
    const r = resumir(corpusDosModelos(20));
    expect(r.veredictoPorModelo.estado).toBe("ok");
    if (r.veredictoPorModelo.estado !== "ok") return;
    expect(r.veredictoPorModelo.ahorroPctFactura).toBeCloseTo(20, 1);
    expect(r.veredictoPorModelo.significativo).toBe(true);
    expect(r.veredictoPorModelo.modelosIncluidos.sort()).toEqual(["barato", "caro"]);
    expect(r.veredictoPorModelo.modelosExcluidos).toEqual([]);
    expect(r.veredictoPorModelo.pesoUsdControlIncluido).toBe(r.veredictoPorModelo.pesoUsdControlTotal);
    expect(r.porModelo["caro"]!.ahorroPct).toBeCloseTo(20, 1);
    expect(r.porModelo["caro"]!.significativo).toBe(true);
    expect(r.porModelo["barato"]!.diasControl).toBe(3);
  });

  it("⛔ la mezcla de modelos por día NO puede fabricar un ahorro: mismo precio por modelo, días de control caros y de palanca baratos", () => {
    // Control: solo el modelo caro; palanca: solo el barato. Ningún modelo
    // cambia de precio → el estratificado no puede comparar (0 modelos con
    // ambos brazos) y lo dice; el global por día mentiría (10 → 1 = «90 %»).
    const ts: TurnoAnillo2[] = [];
    for (const dia of diasC) ts.push(turno({ dia, brazo: "control", model: "caro", entradaUsd: 10, sesion: `c-${dia}` }));
    for (const dia of diasP)
      ts.push(turno({ dia, brazo: "palanca", model: "barato", entradaUsd: 1, sesion: `p-${dia}`, borrados: 1, tokensLimpiados: 1 }));
    const r = resumir(ts);
    expect(r.veredictoPorModelo.estado).toBe("insuficiente");
    if (r.veredictoPorModelo.estado !== "insuficiente") return;
    expect(r.veredictoPorModelo.modelosExcluidos.map((m) => m.modelo).sort()).toEqual(["barato", "caro"]);
    // El global por día sí «ve» un 90 % — por eso es secundario.
    expect(r.veredicto.estado).toBe("ok");
    if (r.veredicto.estado === "ok") expect(r.veredicto.ahorroPctFactura).toBeCloseTo(90, 0);
  });

  it("un modelo con pocos días se excluye del titular y se declara, con su peso", () => {
    const ts = corpusDosModelos(20).filter((t) => !(t.model === "barato" && t.brazo === "palanca" && t.dia === "2026-09-12"));
    const r = resumir(ts);
    expect(r.veredictoPorModelo.estado).toBe("ok");
    if (r.veredictoPorModelo.estado !== "ok") return;
    expect(r.veredictoPorModelo.modelosIncluidos).toEqual(["caro"]);
    expect(r.veredictoPorModelo.modelosExcluidos).toEqual([
      { modelo: "barato", motivo: "3 días control / 2 días palanca (mínimo 3 cada uno)" },
    ]);
    expect(r.veredictoPorModelo.pesoUsdControlIncluido).toBe(30);
    expect(r.veredictoPorModelo.pesoUsdControlTotal).toBe(33);
    expect(r.porDiaModelo["2026-09-07"]!["caro"]!.control!.turnos).toBe(1);
  });

  it("⛔ días de palanca por modelo con cero borrados → palanca-sin-disparos también en el estratificado", () => {
    const ts = corpusDosModelos(20).map((t) => (t.brazo === "palanca" ? { ...t, borrados: 0, tokensLimpiados: 0 } : t));
    expect(resumir(ts).veredictoPorModelo.estado).toBe("palanca-sin-disparos");
  });
});

describe("determinismo frente al orden de entrada", () => {
  it("el informe es byte a byte el mismo con los turnos en orden inverso (los Maps no mandan al PRNG)", () => {
    // Dispersión REAL por día y por modelo, con un PRNG propio: los fixtures
    // idénticos colapsan el bootstrap y no prueban nada.
    let x = 7;
    const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const ts: TurnoAnillo2[] = [];
    for (const dia of ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"])
      for (const model of ["zeta", "alfa"])
        for (let i = 0; i < 4; i++)
          ts.push(
            turno({
              dia,
              brazo: Number(dia.slice(8)) % 2 ? "control" : "palanca",
              model,
              sesion: `${dia}-${model}-${i}`,
              entradaUsd: 1 + rnd() * (model === "zeta" ? 10 : 1),
              salidaTokens: 500 + Math.floor(rnd() * 1000),
              borrados: 1,
              tokensLimpiados: 100,
            }),
          );
    const directo = resumir(ts);
    const inverso = resumir([...ts].reverse());
    expect(JSON.stringify(inverso)).toBe(JSON.stringify(directo));
    expect(directo.veredictoPorModelo.estado).toBe("ok");
  });
});
