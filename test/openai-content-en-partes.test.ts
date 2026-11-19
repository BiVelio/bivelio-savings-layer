import { describe, expect, it } from "vitest";
import { createSavingsLayer, OpenAICompatibleProvider } from "../src/index.js";
import type { ProviderRequest, ProviderStreamEvent } from "../src/index.js";

/**
 * A2-7 (segunda auditoría, 2026-11-19) · `content` COMO LISTA DE PARTES.
 *
 * Algunos servicios compatibles con OpenAI (Mistral con sus modelos de
 * razonamiento) devuelven `message.content` como lista de partes en vez de una
 * cadena, también en el `delta` del stream. Cada `generate()` moría con
 * «TypeError: me.trim is not a function» después de que el proveedor ya
 * hubiera cobrado la llamada. Servidor falso local; textos inventados.
 */

const USO = { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 };
const REQ: ProviderRequest = { model: "modelo-inventado", messages: [{ role: "user", content: "hola" }] };

function proveedorQueDevuelve(cuerpo: unknown, tipo = "application/json") {
  let llamadas = 0;
  const fetchImpl = (async () => {
    llamadas += 1;
    return new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), {
      status: 200,
      headers: { "content-type": tipo },
    });
  }) as unknown as typeof fetch;
  const proveedor = new OpenAICompatibleProvider({ baseUrl: "https://compatible.test/v1", apiKey: "k-inventada", fetchImpl });
  return { proveedor, llamadas: () => llamadas };
}

const respuesta = (content: unknown, extra: Record<string, unknown> = {}) => ({
  model: "modelo-inventado",
  choices: [{ index: 0, message: { role: "assistant", content, ...extra }, finish_reason: "stop" }],
  usage: USO,
});

describe("⛔ A2-7 · una respuesta con `content` en partes no rompe la llamada", () => {
  it("razonamiento + texto: la respuesta es el texto", async () => {
    const { proveedor } = proveedorQueDevuelve(
      respuesta([
        { type: "thinking", thinking: [{ type: "text", text: "pienso un rato" }] },
        { type: "text", text: "hola" },
      ]),
    );
    const r = await proveedor.generate(REQ);
    expect(r.text).toBe("hola");
    expect(r.usage.inputTokens).toBe(40);
    expect(r.usage.outputTokens).toBe(12);
  });

  it("varias partes de texto se unen en orden, y una cadena suelta también cuenta", async () => {
    const { proveedor } = proveedorQueDevuelve(respuesta([{ type: "text", text: "uno, " }, "dos, ", { text: "tres" }]));
    expect((await proveedor.generate(REQ)).text).toBe("uno, dos, tres");
  });

  it("una lista sin ninguna parte de texto es una respuesta vacía, no un error", async () => {
    const { proveedor } = proveedorQueDevuelve(respuesta([{ type: "thinking", thinking: [] }]));
    expect((await proveedor.generate(REQ)).text).toBe("");
  });

  it("una parte que no es texto impide afirmar «0 tokens de razonamiento»", async () => {
    const con0 = { ...USO, completion_tokens_details: { reasoning_tokens: 0 } };
    const soloTexto = proveedorQueDevuelve({ ...respuesta([{ type: "text", text: "hola" }]), usage: con0 });
    expect((await soloTexto.proveedor.generate(REQ)).usage.reasoningTokens).toBe(0);
    const conRazonamiento = proveedorQueDevuelve({
      ...respuesta([{ type: "thinking", thinking: [{ type: "text", text: "pienso" }] }, { type: "text", text: "hola" }]),
      usage: con0,
    });
    expect((await conRazonamiento.proveedor.generate(REQ)).usage.reasoningTokens).toBeUndefined();
  });

  it("lo de siempre no cambia: cadena, null con tool_calls", async () => {
    expect((await proveedorQueDevuelve(respuesta("hola")).proveedor.generate(REQ)).text).toBe("hola");
    const conLlamada = await proveedorQueDevuelve(
      respuesta(null, { tool_calls: [{ id: "c1", type: "function", function: { name: "buscar", arguments: "{}" } }] }),
    ).proveedor.generate(REQ);
    expect(conLlamada.text).toBe("");
    expect(conLlamada.toolCalls).toEqual([{ id: "c1", name: "buscar", arguments: "{}" }]);
  });

  it("un `content` que no es ni texto ni lista falla con un mensaje claro", async () => {
    const { proveedor } = proveedorQueDevuelve(respuesta({ text: "hola" }));
    await expect(proveedor.generate(REQ)).rejects.toThrow(/neither text nor a list of parts/);
  });

  it("por la capa: `generate()` devuelve el texto y la repetición sale de caché", async () => {
    const { proveedor, llamadas } = proveedorQueDevuelve(
      respuesta([{ type: "thinking", thinking: [{ type: "text", text: "pienso" }] }, { type: "text", text: "hola" }]),
    );
    const capa = createSavingsLayer({ provider: proveedor, silenceWarnings: true });
    const peticion = { model: "modelo-inventado", temperature: 0, messages: [{ role: "user" as const, content: "saluda" }] };
    const primera = await capa.generate(peticion);
    expect(primera.text).toBe("hola");
    const segunda = await capa.generate(peticion);
    expect(segunda.text).toBe("hola");
    expect(segunda.report.cache.result).toBe("exact");
    expect(llamadas()).toBe(1);
    capa.close();
  });

  it("en stream: los `delta.content` en partes se reenvían como texto", async () => {
    const trozo = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const cuerpo =
      trozo({ role: "assistant", content: [{ type: "thinking", thinking: [{ type: "text", text: "pienso" }] }] }) +
      trozo({ content: [{ type: "text", text: "ho" }] }) +
      trozo({ content: "la" }) +
      trozo({}, "stop") +
      `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [], usage: USO })}\n\n` +
      "data: [DONE]\n\n";
    const { proveedor } = proveedorQueDevuelve(cuerpo, "text/event-stream");
    const eventos: ProviderStreamEvent[] = [];
    for await (const e of proveedor.generateStream(REQ)) eventos.push(e);
    const texto = eventos.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta);
    expect(texto).toEqual(["ho", "la"]);
    const final = eventos.find((e) => e.type === "done") as { response: { text: string } } | undefined;
    expect(final?.response.text).toBe("hola");
  });
});
