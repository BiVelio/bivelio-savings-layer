import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// @ts-expect-error — script .mjs sin tipos; se testea su contrato, no su forma
import { analizar, bloquesDe, usageDe, claveDeSesion, edicionesDelProveedor, leerCaptura } from "../scripts/analisis-corpus-f0.mjs";

/**
 * El análisis de S1 contra un corpus SINTÉTICO con las poblaciones que las
 * cifras del denominador tienen que separar: tool_results grandes, recortes
 * del proveedor (applied_edits) vs podas del cliente, y mezcla de caché 5m/1h.
 * Contenido inventado — jamás una captura real en el repo.
 */

function registroMessages(
  id: number,
  clientPort: number,
  mensajes: unknown[],
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  cabeceras: Record<string, string> = {},
) {
  return {
    id,
    at: `2026-08-30T10:00:0${id}.000Z`,
    method: "POST",
    path: "/v1/messages",
    clientPort,
    requestHeaders: cabeceras,
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

  it("bloquesDe aguanta messages malformados (null, objeto no-array) sin morir — el modo de fallo del espía y el del análisis ya no divergen", () => {
    expect(bloquesDe({ messages: [null, { role: "user", content: "ok" }] }).porTipo["?:invalido"].n).toBe(1);
    expect(bloquesDe({ messages: {} }).mensajes).toBe(0);
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

  it("claveDeSesion: la cabecera x-claude-code-session-id manda sobre el puerto (dos ids en el mismo puerto = dos sesiones)", () => {
    const a = registroMessages(1, 50001, [{ role: "user", content: "a" }], {}, {}, { "x-claude-code-session-id": "S1" });
    const b = registroMessages(2, 50001, [{ role: "user", content: "a" }], {}, {}, { "x-claude-code-session-id": "S2" });
    expect(claveDeSesion(a)).not.toBe(claveDeSesion(b));
    expect(analizar([a, b]).sesiones).toBe(2);
  });

  it("sin cabecera, el primer mensaje correlaciona la conversación aunque el puerto CAMBIE (keep-alive reciclado)", () => {
    const conv = (id: number, puerto: number, extraMsg: unknown[]) =>
      registroMessages(id, puerto, [{ role: "user", content: "la primera pregunta" }, ...extraMsg], { input_tokens: 10 });
    const a = analizar([conv(1, 50001, []), conv(2, 59999, [{ role: "assistant", content: "sigo" }])]);
    expect(a.sesiones).toBe(1);
  });

  it("poda del cliente: in situ (≥ mensajes, menos bytes) y compactación (menos mensajes) se cuentan por separado", () => {
    const primero = { role: "user", content: "pregunta" };
    const grande = [primero, { role: "user", content: [TOOL_RESULT_GRANDE] }];
    const podado = [primero, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "[recortado]" }] }, { role: "assistant", content: "sigo" }];
    const compactado = [primero, { role: "user", content: "resumen corto de todo" }];
    const a = analizar([
      registroMessages(1, 50001, grande, { input_tokens: 1000 }, { context_management: { edits: [] } }),
      registroMessages(2, 50001, podado, { input_tokens: 200 }, { context_management: { edits: [] } }),
      registroMessages(3, 50001, compactado, { input_tokens: 50 }),
    ]);
    expect(a.contexto.peticionesConConfig).toBe(2);
    expect(a.contexto.podaDelCliente.podasInSitu).toBe(1);
    expect(a.contexto.podaDelCliente.compactaciones).toBe(1);
    expect(a.contexto.podaDelCliente.bytesRecortados).toBeGreaterThan(3000);
  });

  it("el recorte DEL PROVEEDOR se lee de applied_edits en la respuesta grabada, no del request", () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10},"context_management":{"applied_edits":[{"type":"clear_tool_uses_20250919","cleared_input_tokens":5000,"cleared_tool_uses":2}]}}}\n\n',
      "event: message_stop\ndata: {}\n\n",
    ].join("");
    const r = {
      ...registroMessages(1, 50001, [{ role: "user", content: "a" }], { input_tokens: 10 }),
      responseBodyBase64: Buffer.from(sse).toString("base64"),
    };
    expect(edicionesDelProveedor(r)).toEqual({ edits: 1, clearedInputTokens: 5000, clearedToolUses: 2 });
    const a = analizar([r]);
    expect(a.contexto.proveedor).toEqual({ respuestasConEdits: 1, editsAplicados: 1, clearedInputTokens: 5000, clearedToolUses: 2 });
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

  it("⛔ leerCaptura salta líneas ilegibles contándolas — jamás tumba el análisis ni filtra contenido", () => {
    const dir = mkdtempSync(join(tmpdir(), "bvsala-analisis-"));
    const ruta = join(dir, "captura-rota.jsonl");
    writeFileSync(
      ruta,
      [JSON.stringify({ id: 1, method: "HEAD", path: "/api/hello" }), 'CONTENIDO-QUE-NO-DEBE-SALIR{{{', JSON.stringify({ id: 2, method: "HEAD", path: "/api/hello" })].join("\n"),
    );
    const { registros, ilegibles } = leerCaptura(ruta);
    expect(registros).toHaveLength(2);
    expect(ilegibles).toBe(1);
    expect(analizar(registros).peticiones).toBe(2); // y el análisis sigue vivo
  });

  it("registros con messages no-array no entran (count_tokens y peticiones rotas no contaminan)", () => {
    const roto = { ...registroMessages(1, 50001, [], {}), requestBody: { model: "m", messages: {} } };
    expect(analizar([roto]).peticionesMessages).toBe(0);
  });

  it("la fuga se declara como no computable, nunca se inventa", () => {
    expect(analizar([]).fuga).toContain("no computable");
  });
});
