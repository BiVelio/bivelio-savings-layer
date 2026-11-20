import { describe, expect, it } from "vitest";
import { AnthropicProvider, createSavingsLayer, OpenAICompatibleProvider, ToolSelector } from "../src/index.js";
import type { ToolDescriptor } from "../src/index.js";

/**
 * A2-28, verificación previa a la 1.2.3 · UNA HERRAMIENTA DE ESCRITURA RETIRADA
 * NO DEJA NI UN TOKEN DE CRÉDITO EN `cost.*`.
 *
 * El CHANGELOG lo promete («it does not count in `tokens.eliminatedInput` or in
 * `cost.*`») y `tokens.eliminatedInput` lo cumplía, pero el baseline
 * reconstruido no del todo. Lo retirado se restaba sumando el peso de cada
 * herramienta POR SEPARADO, mientras que el baseline las cuenta DENTRO del
 * prompt, con el salto de línea que las une. Esa diferencia —unos tokens por
 * herramienta— quedaba como «quitado por la capa»: con la verja puesta y nada
 * más que escrituras retiradas, el informe publicaba un ahorro en dólares
 * mayor que cero y `basis: "estimated"`. Medido antes del arreglo: 1,5 % con
 * cuatro herramientas (tres retiradas) y hasta el 27 % cuando la petición se
 * quedaba sin ninguna herramienta.
 *
 * Ahora lo retirado se mide por diferencia, con el mismo ensamblador que el
 * baseline: el prompt enviado con y sin las de escritura retiradas.
 *
 * Todo inventado. Proveedores falsos locales.
 */

const h = (id: string, intent: string, risk: ToolDescriptor["risk"]): ToolDescriptor => ({
  id,
  intents: [intent],
  risk,
  description: `Tool for ${intent}`,
  parameters: { type: "object", properties: { id: { type: "string" }, note: { type: "string" } }, required: ["id"] },
});
const MIXTO = [h("get_order", "order", "read"), h("refund_order", "refund", "write"), h("email_customer", "email", "write"), h("delete_order", "delete order", "destructive")];
const SOLO_ESCRITURA = MIXTO.filter((t) => t.risk !== "read");

function openai() {
  const vistas: string[][] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const cuerpo = JSON.parse(String(init?.body)) as { model: string; tools?: { function: { name: string } }[] };
    vistas.push((cuerpo.tools ?? []).map((t) => t.function.name));
    return new Response(
      JSON.stringify({
        model: cuerpo.model,
        choices: [{ index: 0, message: { role: "assistant", content: "hecho" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 300, completion_tokens: 5, total_tokens: 305 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { vistas, modelo: "openai/gpt-4o-mini", provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.test/v1", apiKey: "k-inventada", fetchImpl }) };
}

function anthropic() {
  const vistas: string[][] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const cuerpo = JSON.parse(String(init?.body)) as { model: string; tools?: { name: string }[] };
    vistas.push((cuerpo.tools ?? []).map((t) => t.name));
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: cuerpo.model,
        content: [{ type: "text", text: "hecho" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 300, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { vistas, modelo: "anthropic/claude-haiku-4-5", provider: new AnthropicProvider({ baseUrl: "https://api.anthropic.test/v1", apiKey: "k-inventada", fetchImpl }) };
}

describe("A2-28 · con la verja, lo retirado no deja crédito en `cost.*`", () => {
  for (const [nombre, montar] of [["OpenAI", openai], ["Anthropic", anthropic]] as const) {
    for (const [catalogo, tools, enviadas] of [["mixto", MIXTO, ["get_order"]], ["solo escritura", SOLO_ESCRITURA, []]] as const) {
      it(`${nombre} · catálogo ${catalogo}: baseline = lo medido, ahorro 0 y \`basis: "measured"\``, async () => {
        const { vistas, modelo, provider } = montar();
        const capa = createSavingsLayer({ provider, toolSelector: new ToolSelector({ withholdWriteTools: true }), silenceWarnings: true });
        const { report } = await capa.generate({ model: modelo, messages: [{ role: "user", content: "Refund order 4411" }], tools: [...tools] });
        expect(vistas[0]).toEqual(enviadas);
        const traza = report.traces.find((t) => t.stage === "tool-selector")!.detail as { withheldWritesNotCredited: string[] };
        expect(traza.withheldWritesNotCredited).toEqual(SOLO_ESCRITURA.map((t) => t.id));
        expect(report.tokens.eliminatedInput).toBe(0);
        expect(report.tokens.baselineInput).toBe(report.tokens.actualInput);
        expect(report.cost.netSavingsUsd).toBe(0);
        expect(report.cost.netSavingsRatio).toBe(0);
        expect(report.cost.baselineEstimate).toBe(report.cost.actual);
        expect(report.cost.basis).toBe("measured");
      });
    }
  }

  it("en stream, igual", async () => {
    const { modelo, provider } = anthropic();
    // El proveedor falso contesta JSON; el camino sin `generateStream` nativo
    // del doble basta para comprobar el libro.
    const capa = createSavingsLayer({ provider: { id: provider.id, generate: provider.generate.bind(provider) }, toolSelector: new ToolSelector({ withholdWriteTools: true }), silenceWarnings: true });
    const s = capa.generateStream({ model: modelo, messages: [{ role: "user", content: "Refund order 4411" }], tools: MIXTO });
    for await (const _ of s) void _;
    const { report } = await s.result;
    expect(report.tokens.baselineInput).toBe(report.tokens.actualInput);
    expect(report.cost.netSavingsUsd).toBe(0);
  });

  it("una de LECTURA podada con `maxTools` sigue acreditándose (el arreglo no borra el ahorro legítimo)", async () => {
    const { modelo, provider } = anthropic();
    const capa = createSavingsLayer({ provider, toolSelector: new ToolSelector({ withholdWriteTools: true, maxTools: 2 }), silenceWarnings: true });
    const { report } = await capa.generate({ model: modelo, messages: [{ role: "user", content: "Tell me a joke about penguins" }], tools: MIXTO });
    // Se retiran las tres de escritura (sin crédito) y la de lectura, que no casa (con crédito).
    expect(report.tokens.eliminatedInput).toBeGreaterThan(0);
    expect(report.tokens.baselineInput).toBeGreaterThan(report.tokens.actualInput);
    expect(report.cost.netSavingsUsd).toBeGreaterThan(0);
  });
});
