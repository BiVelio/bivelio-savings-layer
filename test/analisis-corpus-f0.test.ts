import { describe, it, expect } from "vitest";

// @ts-expect-error — script .mjs sin tipos; se testea su contrato, no su forma
import { analizar, bloquesDe, usageDe } from "../scripts/analisis-corpus-f0.mjs";

/**
 * El análisis de S1 contra un corpus SINTÉTICO con las tres poblaciones que
 * las cifras del denominador tienen que separar: tool_results grandes,
 * encogimiento de historial (context_management) y mezcla de caché 5m/1h.
 * Contenido inventado — jamás una captura real en el repo.
 */

function registroMessages(
  id: number,
  clientPort: number,
  mensajes: unknown[],
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    at: `2026-08-30T10:00:0${id}.000Z`,
    method: "POST",
    path: "/v1/messages",
    clientPort,
    requestBody: { model: "claude-haiku-4-5", messages: mensajes, system: "eres util", ...extra },
    sse: { eventos: { message_start: 1, message_delta: 1 }, usage: [{ evento: "message_start", usage }] },
    fichero: "captura-test.jsonl",
  };
}

const TOOL_RESULT_GRANDE = { type: "tool_result", tool_use_id: "t1", content: "x".repeat(4000) };

describe("analisis-corpus-f0 — las cifras del denominador", () => {
  it("bloquesDe separa tool_result del resto, en bytes serializados", () => {
    const b = bloquesDe({
      messages: [
        { role: "user", content: "hola" },
        { role: "user", content: [TOOL_RESULT_GRANDE, { type: "text", text: "sigue" }] },
      ],
      system: "s",
      tools: [{ name: "leer" }],
    });
    expect(b.mensajes).toBe(2);
    expect(b.porTipo["user:tool_result"].n).toBe(1);
    expect(b.porTipo["user:tool_result"].bytes).toBeGreaterThan(4000);
    expect(b.porTipo["user:text"].n).toBe(2); // el string suelto y el bloque text
    expect(b.totalBytes).toBe(Object.values(b.porTipo as Record<string, { bytes: number }>).reduce((s, t) => s + t.bytes, 0));
  });

  it("usageDe fusiona message_start ∪ message_delta y conserva el desglose 1h (regla del ObservadorSse)", () => {
    const uso = usageDe({
      sse: {
        usage: [
          {
            evento: "message_start",
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 3000,
              cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
            },
          },
          { evento: "message_delta", usage: { output_tokens: 42, cache_creation: { ephemeral_5m_input_tokens: 1000 } } },
        ],
      },
    });
    expect(uso.output_tokens).toBe(42);
    expect(uso.cache_creation).toEqual({ ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 });
  });

  it("usageDe extrae el usage del JSON de una respuesta no-SSE (stream:false, espía v2)", () => {
    const cuerpo = Buffer.from(JSON.stringify({ id: "msg", usage: { input_tokens: 7, output_tokens: 3 } })).toString("base64");
    expect(usageDe({ responseBodyBase64: cuerpo })).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it("la fracción de tool_result se calibra contra el contador REAL del proveedor", () => {
    // Un turno cuyo prompt es ~mitad tool_result en bytes y 1000 tokens reales
    // de entrada → la estimación tiene que rondar los 500 tokens.
    const r = registroMessages(
      1,
      50001,
      [
        { role: "user", content: "z".repeat(4056) }, // ~ mismos bytes que el tool_result serializado
        { role: "user", content: [TOOL_RESULT_GRANDE] },
      ],
      { input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 5 },
    );
    const a = analizar([r]);
    expect(a.toolResults.tokensEntradaReales).toBe(1000);
    expect(a.toolResults.fraccionBytesPct).toBeGreaterThan(30);
    expect(a.toolResults.fraccionBytesPct).toBeLessThan(60);
    expect(a.toolResults.tokensEstimados).toBeGreaterThan(300);
    expect(a.toolResults.tokensEstimados).toBeLessThan(600);
  });

  it("detecta encogimientos de historial dentro de una sesión (más turnos, menos bytes)", () => {
    const grande = [
      { role: "user", content: "pregunta" },
      { role: "user", content: [TOOL_RESULT_GRANDE] },
    ];
    const recortado = [
      { role: "user", content: "pregunta" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "[recortado]" }] },
      { role: "assistant", content: "sigo" },
    ];
    const a = analizar([
      registroMessages(1, 50001, grande, { input_tokens: 1000 }, { context_management: { edits: [] } }),
      registroMessages(2, 50001, recortado, { input_tokens: 200 }, { context_management: { edits: [] } }),
    ]);
    expect(a.contextManagement.peticionesConConfig).toBe(2);
    expect(a.contextManagement.encogimientosObservados).toBe(1);
    expect(a.contextManagement.bytesRecortados).toBeGreaterThan(3000);
  });

  it("dos clientPort distintos son dos sesiones: el encogimiento no cruza subagentes", () => {
    const grande = [{ role: "user", content: "x".repeat(5000) }];
    const chico = [
      { role: "user", content: "hola" },
      { role: "assistant", content: "ok" },
    ];
    const a = analizar([registroMessages(1, 50001, grande, { input_tokens: 1000 }), registroMessages(2, 50002, chico, { input_tokens: 10 })]);
    expect(a.sesiones).toBe(2);
    expect(a.contextManagement.encogimientosObservados).toBe(0);
  });

  it("la mezcla de caché reparte lectura / 5m / 1h / sin-desglose y suma 100", () => {
    const a = analizar([
      registroMessages(1, 50001, [{ role: "user", content: "a" }], {
        input_tokens: 100,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 400,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 300 },
      }),
      // legacy sin desglose:
      registroMessages(2, 50001, [{ role: "user", content: "b" }], { input_tokens: 0, cache_creation_input_tokens: 1000 }),
    ]);
    expect(a.mezclaCache.tokens).toEqual({ lectura: 500, escritura5m: 100, escritura1h: 300, escrituraSinDesglose: 1000, entradaSinCache: 100 });
    const suma =
      a.mezclaCache.lecturaPct + a.mezclaCache.escritura5mPct + a.mezclaCache.escritura1hPct + a.mezclaCache.escrituraSinDesglosePct + a.mezclaCache.entradaSinCachePct;
    expect(suma).toBeCloseTo(100, 0);
  });

  it("la fuga se declara como no computable, nunca se inventa", () => {
    expect(analizar([]).fuga).toContain("no computable");
  });
});
