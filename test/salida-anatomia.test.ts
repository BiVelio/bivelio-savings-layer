/**
 * Verjas del núcleo puro de la anatomía de salida (benchmarks/salida/
 * anatomia-nucleo.ts) sobre un SSE SINTÉTICO: reparto de caracteres por tipo
 * de bloque, por herramienta, truncado, usage fusionado, shingles de
 * repetición y agregación. Sin red, sin corpus: el corpus real jamás entra en
 * un test.
 */
import { describe, expect, it } from "vitest";

import {
  SHINGLE,
  acumuladorVacio,
  agregar,
  anatomiaDeJson,
  anatomiaDeSse,
  fraccionRepetida,
  percentil,
  repartirDinero,
  resumir,
  resumirEstratificado,
  textoDelCuerpo,
  ultimoToolResult,
  usageFusionado,
  type FuentesRepeticion,
  type MedidaPeticion,
} from "../benchmarks/salida/anatomia-nucleo.js";

/** Un SSE sintético con la forma sondeada en las capturas del espía. */
function sse(eventos: [string, unknown][]): string {
  return eventos.map(([ev, d]) => `event: ${ev}\ndata: ${JSON.stringify(d)}`).join("\n\n") + "\n\n";
}

const TEXTO = "La función devuelve el índice del primer elemento que cumple la condición."; // 74 chars
const PENSAMIENTO = "Primero miro el fichero y luego decido.";
const JSON_WRITE = '{"file_path":"/x/a.ts","content":"export const a = 1;\\n"}';

const RESPUESTA = sse([
  ["message_start", { message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 500 } } }],
  ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }],
  ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: PENSAMIENTO.slice(0, 20) } }],
  ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: PENSAMIENTO.slice(20) } }],
  ["content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "abcdef==" } }],
  ["content_block_stop", { index: 0 }],
  ["content_block_start", { index: 1, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { index: 1, delta: { type: "text_delta", text: TEXTO.slice(0, 30) } }],
  ["content_block_delta", { index: 1, delta: { type: "text_delta", text: TEXTO.slice(30) } }],
  ["content_block_stop", { index: 1 }],
  ["content_block_start", { index: 2, content_block: { type: "tool_use", id: "tu_1", name: "Write", input: {} } }],
  ["content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: JSON_WRITE.slice(0, 25) } }],
  ["content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: JSON_WRITE.slice(25) } }],
  ["content_block_stop", { index: 2 }],
  ["content_block_start", { index: 3, content_block: { type: "tool_use", id: "tu_2", name: "Bash", input: {} } }],
  ["content_block_delta", { index: 3, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }],
  ["content_block_stop", { index: 3 }],
  ["ping", { type: "ping" }],
  ["message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 57, output_tokens_details: { thinking_tokens: 12 } } }],
  ["message_stop", {}],
]);

describe("anatomiaDeSse — reparto de la salida por tipo de bloque", () => {
  it("suma los caracteres de cada delta en su bloque y cuenta bloques", () => {
    const a = anatomiaDeSse(RESPUESTA);
    expect(a.chars.text).toBe(TEXTO.length);
    expect(a.chars.thinking).toBe(PENSAMIENTO.length);
    expect(a.chars.tool_use).toBe(JSON_WRITE.length + '{"command":"ls"}'.length);
    expect(a.chars.otros).toBe(0);
    expect(a.bloques).toEqual({ text: 1, tool_use: 2, thinking: 1, otros: 0 });
  });

  it("reparte el tool_use por NOMBRE de herramienta (solo nombre y longitud)", () => {
    const a = anatomiaDeSse(RESPUESTA);
    expect(a.herramientas).toEqual({
      Write: { llamadas: 1, chars: JSON_WRITE.length },
      Bash: { llamadas: 1, chars: '{"command":"ls"}'.length },
    });
  });

  it("la signature_delta no es texto: va a charsFirma, no a thinking", () => {
    const sin = sse([
      ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "x".repeat(200) } }],
    ]);
    const a = anatomiaDeSse(sin);
    expect(a.chars.thinking).toBe(0);
    expect(a.charsFirma).toBe(200);
  });

  it("thinking VACÍO con estimated_tokens (la forma real del corpus): chars 0, tokens estimados sumados", () => {
    const vacio = sse([
      ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "", estimated_tokens: 40 } }],
      ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "", estimated_tokens: 25 } }],
    ]);
    const a = anatomiaDeSse(vacio);
    expect(a.chars.thinking).toBe(0);
    expect(a.bloques.thinking).toBe(1);
    expect(a.thinkingTokensEstimados).toBe(65);
  });

  it("lee el stop_reason del message_delta; max_tokens = truncado", () => {
    expect(anatomiaDeSse(RESPUESTA).stopReason).toBe("tool_use");
    const truncada = sse([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "hola" } }],
      ["message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4096 } }],
    ]);
    expect(anatomiaDeSse(truncada).stopReason).toBe("max_tokens");
  });

  it("un bloque de tipo desconocido (redacted_thinking) va a «otros» sin romper", () => {
    const raro = sse([
      ["content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: "..." } }],
      ["content_block_start", { index: 1, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 1, delta: { type: "text_delta", text: "ok" } }],
      ["data ilegible", {}],
    ]);
    const a = anatomiaDeSse(raro + "event: content_block_delta\ndata: {no es json}\n\n");
    expect(a.bloques.otros).toBe(1);
    expect(a.chars.text).toBe(2);
  });

  it("repetición: null sin fuentes, y la fracción por fuente cuando las hay", () => {
    expect(anatomiaDeSse(RESPUESTA, null).repeticion).toBeNull();
    expect(anatomiaDeSse(RESPUESTA, null).repeticionCuerpo).toBeNull();
    // El tool_result contiene el texto entero → todos los shingles repetidos.
    const a = anatomiaDeSse(RESPUESTA, { ultimoToolResult: `salida del comando\n${TEXTO}\nfin`, cuerpo: "z".repeat(500) });
    expect(a.repeticion).toBe(1);
    expect(a.repeticionCuerpo).toBe(0);
    expect(anatomiaDeSse(RESPUESTA, { ultimoToolResult: null, cuerpo: TEXTO }).repeticion).toBeNull();
    expect(anatomiaDeSse(RESPUESTA, { ultimoToolResult: null, cuerpo: TEXTO }).repeticionCuerpo).toBe(1);
  });

  it("los bloques «otros» guardan solo el NOMBRE del tipo", () => {
    const raro = sse([
      ["content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: "..." } }],
      ["content_block_start", { index: 1, content_block: { type: "server_tool_use", id: "x", name: "web_search", input: {} } }],
    ]);
    expect(anatomiaDeSse(raro).tiposOtros).toEqual({ redacted_thinking: 1, server_tool_use: 1 });
  });
});

describe("anatomiaDeJson — la misma anatomía para stream:false", () => {
  it("cuenta text/thinking/tool_use del content ensamblado", () => {
    const cuerpo = JSON.stringify({
      content: [
        { type: "thinking", thinking: PENSAMIENTO },
        { type: "text", text: TEXTO },
        { type: "tool_use", id: "tu", name: "Edit", input: { file_path: "/x", old_string: "a", new_string: "b" } },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const a = anatomiaDeJson(cuerpo);
    expect(a).not.toBeNull();
    expect(a!.chars.text).toBe(TEXTO.length);
    expect(a!.chars.thinking).toBe(PENSAMIENTO.length);
    expect(a!.chars.tool_use).toBe(JSON.stringify({ file_path: "/x", old_string: "a", new_string: "b" }).length);
    expect(a!.herramientas["Edit"]?.llamadas).toBe(1);
    expect(a!.stopReason).toBe("end_turn");
  });

  it("un cuerpo ilegible o sin content → null (se cuenta como cuerpo ilegible, no como cero)", () => {
    expect(anatomiaDeJson("{no")).toBeNull();
    expect(anatomiaDeJson(JSON.stringify({ error: { type: "overloaded_error" } }))).toBeNull();
  });
});

describe("ultimoToolResult — lo que el modelo acaba de leer", () => {
  it("content string (Claude Code) y content en bloques text", () => {
    expect(ultimoToolResult([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "abc" }] }])).toBe("abc");
    expect(
      ultimoToolResult([
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "text", text: "b" }] }] },
      ]),
    ).toBe("a\nb");
  });

  it("toma el ÚLTIMO tool_result del ÚLTIMO mensaje; sin él → null", () => {
    const msgs = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "viejo" }] },
      { role: "assistant", content: [{ type: "text", text: "..." }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "uno" }, { type: "tool_result", tool_use_id: "t2", content: "dos" }] },
    ];
    expect(ultimoToolResult(msgs)).toBe("dos");
    expect(ultimoToolResult([{ role: "user", content: "hola" }])).toBeNull();
    expect(ultimoToolResult([{ role: "user", content: [{ type: "text", text: "hola" }] }])).toBeNull();
    expect(ultimoToolResult(undefined)).toBeNull();
  });
});

describe("textoDelCuerpo — todo lo dicho antes, sin los inputs de tool_use", () => {
  it("concatena usuario, asistente y tool_results; ignora el JSON de tool_use", () => {
    const msgs = [
      { role: "user", content: "pregunta" },
      { role: "assistant", content: [{ type: "text", text: "respuesta" }, { type: "tool_use", id: "t", name: "Bash", input: { command: "SECRETO" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "salida" }] }, { type: "text", text: "recordatorio" }] },
    ];
    const s = textoDelCuerpo(msgs);
    expect(s).toBe("pregunta\nrespuesta\nsalida\nrecordatorio");
    expect(s).not.toContain("SECRETO");
    expect(textoDelCuerpo(undefined)).toBe("");
  });
});

describe("fraccionRepetida — shingles de 40 caracteres", () => {
  it("texto contenido entero → 1; disjunto → 0; corto → null", () => {
    const texto = "x".repeat(10) + "un párrafo suficientemente largo para tener varios shingles de cuarenta";
    expect(fraccionRepetida(texto, `cabecera ${texto} cola`)).toBe(1);
    expect(fraccionRepetida(texto, "q".repeat(300))).toBe(0);
    expect(fraccionRepetida("corto", "lo que sea")).toBeNull();
    expect(fraccionRepetida("a".repeat(SHINGLE), "b".repeat(10))).toBe(0);
  });

  it("parcial: la mitad copiada da ~0,5 y los shingles se cuentan DISTINTOS", () => {
    const copiado = "Error: cannot find module './x' at line 12 of main.ts (resolved)";
    const propio = "Eso viene de un import relativo mal escrito en el fichero.";
    const f = fraccionRepetida(copiado + propio, `log:\n${copiado}\n`);
    // 27 shingles del trozo copiado sobre 85 distintos: los 39 que cruzan la
    // costura copiado|propio no están en la fuente y NO cuentan como repetidos.
    expect(f).toBeGreaterThan(0.25);
    expect(f).toBeLessThan(0.45);
    // Repetir el mismo trozo diez veces no vale diez: los shingles son distintos.
    const repetido = fraccionRepetida(copiado.repeat(10), copiado);
    expect(repetido).toBeGreaterThan(0.2); // los shingles que cruzan la costura no están en la fuente
    expect(repetido).toBeLessThan(1);
  });
});

describe("usageFusionado (reutilizado del anillo 2): el último evento gana", () => {
  it("message_delta pisa output_tokens y trae output_tokens_details", () => {
    const u = usageFusionado([
      { usage: { input_tokens: 10, output_tokens: 1 } },
      { usage: { output_tokens: 57, output_tokens_details: { thinking_tokens: 12 } } as never },
    ]) as { output_tokens?: number; output_tokens_details?: { thinking_tokens?: number } };
    expect(u.output_tokens).toBe(57);
    expect(u.output_tokens_details?.thinking_tokens).toBe(12);
  });
});

describe("agregar / resumir — el informe son solo cifras", () => {
  function medida(sobre: Partial<MedidaPeticion>, cuerpo = RESPUESTA, toolResult: string | null = null): MedidaPeticion {
    const fuentes: FuentesRepeticion | null = toolResult === null ? null : { ultimoToolResult: toolResult, cuerpo: toolResult };
    return {
      model: "claude-sonnet-4-5",
      tokensSalida: 100,
      thinkingTokens: 10,
      salidaUsd: 0.0015,
      entradaUsd: 0.01,
      anatomia: anatomiaDeSse(cuerpo, fuentes),
      ...sobre,
    };
  }

  it("suma tokens, dinero y caracteres; calcula shares, percentiles y truncado", () => {
    const acum = acumuladorVacio();
    agregar(acum, medida({ tokensSalida: 100 }));
    agregar(acum, medida({ tokensSalida: 300 }));
    const truncada = sse([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "h".repeat(400) } }],
      ["message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1000 } }],
    ]);
    agregar(acum, medida({ tokensSalida: 1000, thinkingTokens: 0 }, truncada));
    agregar(acum, { model: "claude-sonnet-4-5", tokensSalida: 50, thinkingTokens: 0, salidaUsd: 0.001, entradaUsd: 0.002, anatomia: null });

    const r = resumir(acum);
    expect(r.peticiones).toBe(4);
    expect(r.conCuerpo).toBe(3);
    expect(r.tokensSalida).toEqual({ total: 1450, media: 362.5, p50: 100, p95: 1000, max: 1000 });
    expect(r.thinking.tokens).toBe(20);
    expect(r.thinking.shareDeSalida).toBeCloseTo(20 / 1450, 4);
    expect(r.chars.porTipo.text).toBe(TEXTO.length * 2 + 400);
    expect(r.chars.porTipo.thinking).toBe(PENSAMIENTO.length * 2);
    expect(r.chars.share.text + r.chars.share.tool_use + r.chars.share.thinking + r.chars.share.otros).toBeCloseTo(1, 3);
    expect(r.chars.proxyTokens.text).toBe(Math.round((TEXTO.length * 2 + 400) / 4));
    expect(r.herramientas["Write"]?.llamadas).toBe(2);
    expect(Object.keys(r.herramientas)[0]).toBe("Write"); // ordenadas por chars descendentes
    expect(r.stopReason).toEqual({ tool_use: 2, max_tokens: 1 });
    expect(r.truncadas).toEqual({ peticiones: 1, share: Number((1 / 3).toFixed(4)), tokensSalida: 1000 });
    expect(r.dinero.salidaUsd).toBeCloseTo(0.0055, 6);
    expect(r.dinero.entradaUsd).toBeCloseTo(0.032, 6);
    expect(r.dinero.shareSalida).toBeCloseTo(0.0055 / 0.0375, 3);
  });

  it("la repetición solo cuenta peticiones con tool_result y pondera por shingles", () => {
    const acum = acumuladorVacio();
    agregar(acum, medida({}, RESPUESTA, null)); // sin tool_result: no cuenta
    agregar(acum, medida({}, RESPUESTA, `${TEXTO}`)); // 1
    const largo = sse([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "k".repeat(1039) } }], // 1000 shingles
    ]);
    agregar(acum, medida({}, largo, "z".repeat(100))); // 0, con peso 1000
    const r = resumir(acum);
    expect(r.repeticion.n).toBe(2);
    expect(r.repeticion.media).toBe(0.5);
    expect(r.repeticionCuerpo).toEqual(r.repeticion); // misma fuente en este test
    // ponderada: (1·shingles(TEXTO) + 0·1000) / (shingles(TEXTO) + 1000)
    const shinglesTexto = TEXTO.length - SHINGLE + 1;
    expect(r.repeticion.ponderada).toBeCloseTo(shinglesTexto / (shinglesTexto + 1000), 3);
  });

  it("repartirDinero: thinking por tokens, lo visible por caracteres; nada se pierde", () => {
    const r = repartirDinero({ tokensSalida: 100, thinkingTokens: 40, salidaUsd: 1 }, { text: 30, tool_use: 90, thinking: 0, otros: 0 });
    expect(r.thinking).toBeCloseTo(0.4, 6);
    expect(r.text).toBeCloseTo(0.15, 6);
    expect(r.tool_use).toBeCloseTo(0.45, 6);
    expect(r.thinking + r.text + r.tool_use + r.otros).toBeCloseTo(1, 9);
    // Sin caracteres visibles ni thinking: todo a «otros», jamás a la nada.
    const v = repartirDinero({ tokensSalida: 5, thinkingTokens: 0, salidaUsd: 0.2 }, { text: 0, tool_use: 0, thinking: 0, otros: 0 });
    expect(v.otros).toBeCloseTo(0.2, 9);
    // thinking > salida (usage inconsistente) se acota a 1.
    expect(repartirDinero({ tokensSalida: 10, thinkingTokens: 50, salidaUsd: 1 }, { text: 4, tool_use: 0, thinking: 0, otros: 0 }).thinking).toBe(1);
  });

  it("el resumen reparte el dinero de salida por masa y lo cuadra con salidaUsd", () => {
    const acum = acumuladorVacio();
    agregar(acum, medida({ tokensSalida: 100, thinkingTokens: 10, salidaUsd: 10 }));
    agregar(acum, { model: "claude-sonnet-4-5", tokensSalida: 50, thinkingTokens: 0, salidaUsd: 5, entradaUsd: 2, anatomia: null });
    const r = resumir(acum);
    const m = r.dinero.porMasa;
    expect(m.thinking).toBeCloseTo(1, 4);
    expect(m.sinCuerpo).toBeCloseTo(5, 4);
    expect(m.thinking + m.text + m.tool_use + m.otros + m.sinCuerpo).toBeCloseTo(r.dinero.salidaUsd, 3);
    // Lo visible (9 $) se reparte por caracteres: la partición del dinero es la de los chars.
    const visibles = r.chars.porTipo.text + r.chars.porTipo.tool_use;
    expect(m.text).toBeCloseTo((9 * r.chars.porTipo.text) / visibles, 3);
    expect(m.tool_use).toBeCloseTo((9 * r.chars.porTipo.tool_use) / visibles, 3);
    expect(r.dinero.shareDeSalidaPorMasa.sinCuerpo).toBeCloseTo(1 / 3, 3);
    expect(r.chars.firma).toBe(8); // la signature_delta "abcdef==" de RESPUESTA
    expect(r.thinking.tokensEstimadosEnDeltas).toBe(0);
  });

  it("calibración: mide chars/token en respuestas puras y corrige el reparto del dinero", () => {
    const acum = acumuladorVacio();
    // Prosa pura: 460 chars visibles en 200 tokens → 2,3 chars/token.
    const prosa = sse([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "p".repeat(460) } }],
    ]);
    agregar(acum, { model: "m", tokensSalida: 200, thinkingTokens: 0, salidaUsd: 2, entradaUsd: 0, anatomia: anatomiaDeSse(prosa) });
    // JSON puro: 340 chars en 200 tokens → 1,7 chars/token.
    const json = sse([
      ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "t", name: "Write", input: {} } }],
      ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "j".repeat(340) } }],
    ]);
    agregar(acum, { model: "m", tokensSalida: 200, thinkingTokens: 0, salidaUsd: 2, entradaUsd: 0, anatomia: anatomiaDeSse(json) });
    // Mixta: 230 chars de prosa (100 tokens a 2,3) + 170 de JSON (100 tokens a 1,7) = 200 tokens.
    const mixta = sse([
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "p".repeat(230) } }],
      ["content_block_start", { index: 1, content_block: { type: "tool_use", id: "t", name: "Write", input: {} } }],
      ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "j".repeat(170) } }],
    ]);
    agregar(acum, { model: "m", tokensSalida: 200, thinkingTokens: 0, salidaUsd: 2, entradaUsd: 0, anatomia: anatomiaDeSse(mixta) });
    const r = resumir(acum);
    // La calibración solo bebe de las respuestas PURAS (la mixta no entra).
    expect(r.chars.calibracion).toEqual({ prosaCharsPorToken: 2.3, nProsa: 1, jsonCharsPorToken: 1.7, nJson: 1 });
    // Por caracteres, la mixta reparte 230/400 al texto: 2 + 1,15 = 3,15 de 6 → 52,5 %…
    expect(r.dinero.shareDeSalidaPorMasa.text).toBeCloseTo(3.15 / 6, 3);
    // …calibrado: 690/2,3 = 300 tokens de prosa y 510/1,7 = 300 de JSON → 50 %, lo facturado.
    expect(r.dinero.porMasaCalibrado.calibrado).toBe(true);
    expect(r.dinero.porMasaCalibrado.text).toBeCloseTo(3, 3);
    expect(r.dinero.porMasaCalibrado.tool_use).toBeCloseTo(3, 3);
    expect(r.dinero.shareDeSalidaPorMasaCalibrado.text).toBeCloseTo(0.5, 3);
  });

  it("sin muestras puras de un tipo no hay calibración: cae al proporcional y lo dice", () => {
    const acum = acumuladorVacio();
    agregar(acum, medida({ tokensSalida: 100, thinkingTokens: 10, salidaUsd: 10 })); // RESPUESTA es mixta
    const r = resumir(acum);
    expect(r.dinero.porMasaCalibrado.calibrado).toBe(false);
    expect(r.dinero.porMasaCalibrado.text).toBe(r.dinero.porMasa.text);
    expect(r.dinero.porMasaCalibrado.tool_use).toBe(r.dinero.porMasa.tool_use);
    expect(r.chars.calibracion.nProsa + r.chars.calibracion.nJson).toBe(0);
  });

  it("⛔ el calibrado GLOBAL se suma por modelo: un ratio global mezclaría precios", () => {
    const puro = (tipo: "text" | "tool_use", chars: number) =>
      sse(
        tipo === "text"
          ? [
              ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
              ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "p".repeat(chars) } }],
            ]
          : [
              ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "t", name: "Write", input: {} } }],
              ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "j".repeat(chars) } }],
            ],
      );
    // Modelo BARATO, solo prosa: 1000 tokens a 2,3 chars/token, 1 $.
    const barato = acumuladorVacio();
    agregar(barato, { model: "b", tokensSalida: 1000, thinkingTokens: 0, salidaUsd: 1, entradaUsd: 0, anatomia: anatomiaDeSse(puro("text", 2300)) });
    agregar(barato, { model: "b", tokensSalida: 1000, thinkingTokens: 0, salidaUsd: 1, entradaUsd: 0, anatomia: anatomiaDeSse(puro("tool_use", 1700)) });
    // Modelo CARO (×10), solo JSON: 1000 tokens, 10 $.
    const caro = acumuladorVacio();
    agregar(caro, { model: "c", tokensSalida: 1000, thinkingTokens: 0, salidaUsd: 10, entradaUsd: 0, anatomia: anatomiaDeSse(puro("tool_use", 1700)) });
    agregar(caro, { model: "c", tokensSalida: 1000, thinkingTokens: 0, salidaUsd: 10, entradaUsd: 0, anatomia: anatomiaDeSse(puro("text", 2300)) });
    const global = acumuladorVacio();
    for (const e of [barato, caro]) for (let i = 0; i < 2; i++) agregar(global, { model: "x", tokensSalida: 1000, thinkingTokens: 0, salidaUsd: e.salidaUsd / 2, entradaUsd: 0, anatomia: anatomiaDeSse(puro(i === 0 ? "text" : "tool_use", i === 0 ? 2300 : 1700)) });
    // Lo facturado en texto: 1 $ (barato) + 10 $ (caro) = 11 de 22.
    const r = resumirEstratificado(global, [barato, caro]);
    expect(r.dinero.porMasaCalibrado.calibrado).toBe(true);
    expect(r.dinero.porMasaCalibrado.text).toBeCloseTo(11, 3);
    expect(r.dinero.porMasaCalibrado.tool_use).toBeCloseTo(11, 3);
    expect(r.dinero.shareDeSalidaPorMasaCalibrado.text).toBeCloseTo(0.5, 3);
    // Un estrato sin calibración (respuesta mixta, sin puras) baja la cobertura: el global lo dice.
    const mixto = acumuladorVacio();
    agregar(mixto, medida({ tokensSalida: 100, thinkingTokens: 10, salidaUsd: 5 }));
    expect(resumirEstratificado(global, [barato, caro, mixto]).dinero.porMasaCalibrado.calibrado).toBe(false);
  });

  it("percentil por rango más cercano; vacío → 0", () => {
    expect(percentil([], 50)).toBe(0);
    expect(percentil([5, 1, 3], 50)).toBe(3);
    expect(percentil([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentil([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
  });
});
