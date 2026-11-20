import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavingsLayer, OpenAICompatibleProvider, ToolSelector } from "../src/index.js";
import type { SavingsReport, ToolDescriptor } from "../src/index.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";

/**
 * A2-28 (segunda auditoría, 2026-11-19) · LA CAPA LE QUITABA AL MODELO LAS
 * HERRAMIENTAS DE ESCRITURA, Y LO APUNTABA COMO AHORRO.
 *
 * Con un catálogo tipado (`risk: "write"`, que el tipo `ToolDescriptor` obliga
 * a declarar) y la configuración por defecto, «Refund order 4411» salía hacia
 * el modelo SIN `refund_order`: el router solo ve una acción en 11 verbos, y
 * «refund» no es uno. El modelo contestaba que no podía, sin error, y el
 * informe presumía de un 57-59 % de ahorro por los tokens retirados.
 *
 * Desde este arreglo, por defecto `layer.generate({ tools })` manda TODAS las
 * herramientas, como ya hacían los adaptadores y el catálogo sin tipar. La
 * verja queda como opción explícita (`new ToolSelector({ withholdWriteTools:
 * true })`), y lo que retire NUNCA se acredita.
 *
 * Proveedor falso local que anota qué herramientas recibe. Todo inventado.
 */

const MODELO = "openai/gpt-4o-mini";

const CATALOGO: ToolDescriptor[] = [
  {
    id: "get_order",
    intents: ["order", "pedido"],
    risk: "read",
    description: "Look up an order by its number",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    id: "refund_order",
    intents: ["refund", "reembolso"],
    risk: "write",
    description: "Refund an order to the original payment method",
    parameters: { type: "object", properties: { id: { type: "string" }, amount: { type: "number" } }, required: ["id"] },
  },
  {
    id: "email_customer",
    intents: ["email", "notify"],
    risk: "write",
    description: "Send an email to the customer of an order",
    parameters: { type: "object", properties: { id: { type: "string" }, body: { type: "string" } }, required: ["id", "body"] },
  },
  {
    id: "delete_order",
    intents: ["delete order"],
    risk: "destructive",
    description: "Delete an order permanently",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

function montar(extra: Record<string, unknown> = {}) {
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
  const capa = createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.test/v1", apiKey: "k-inventada", fetchImpl }),
    ...extra,
  });
  const pedir = (texto: string) =>
    capa.generate({ model: MODELO, messages: [{ role: "user", content: texto }], tools: CATALOGO });
  return { vistas, pedir };
}

const trazaDelSelector = (r: SavingsReport) => r.traces.filter((t) => t.stage === "tool-selector");

// Ninguna lleva uno de los 11 verbos del router (create, update, delete, send,
// pay, book, cancel, crea, actualiza, elimina, envía, paga).
const SIN_VERBO_DE_LA_LISTA = [
  "Refund order 4411",
  "Email the customer that order 4411 has shipped",
  "Please issue a refund for order 4411 and notify the customer",
  "Reembolsa el pedido 4411",
  "Where is order 4411?",
];

let avisos: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  reiniciarAvisos();
  avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => avisos.mockRestore());

describe("⛔ A2-28 · por defecto el modelo recibe todas las herramientas que el llamante declaró", () => {
  it.each(SIN_VERBO_DE_LA_LISTA)("«%s»: las cuatro viajan y no se acredita nada", async (texto) => {
    const { vistas, pedir } = montar();
    const r = await pedir(texto);
    expect(vistas[0]).toEqual(["get_order", "refund_order", "email_customer", "delete_order"]);
    expect(r.report.tokens.eliminatedInput).toBe(0);
    expect(r.report.calls.actualTools).toBe(4);
    expect(r.report.calls.baselineTools).toBe(4);
    expect(trazaDelSelector(r.report)).toEqual([]);
    expect(avisos.mock.calls.filter((c: unknown[]) => String(c[0]).includes("tool selector"))).toEqual([]);
  });

  it("y con un verbo de la lista, igual que antes: las cuatro", async () => {
    const { vistas, pedir } = montar();
    const r = await pedir("Send the customer an email about order 4411");
    expect(vistas[0]).toHaveLength(4);
    expect(r.report.tokens.eliminatedInput).toBe(0);
  });
});

describe("A2-28 · la verja es opción explícita, y lo que retira nunca es ahorro", () => {
  const conVerja = () => montar({ toolSelector: new ToolSelector({ withholdWriteTools: true }) });

  it.each(SIN_VERBO_DE_LA_LISTA)("con `withholdWriteTools`, «%s» sale solo con la de lectura, sin crédito", async (texto) => {
    const { vistas, pedir } = conVerja();
    const r = await pedir(texto);
    expect(vistas[0]).toEqual(["get_order"]);
    // NUNCA es ahorro: ni tokens eliminados ni ratio.
    expect(r.report.tokens.eliminatedInput).toBe(0);
    expect(r.report.cost.netSavingsRatio).toBe(0);
    // Pero se ve: la traza las lista, y dice que no se acreditan.
    const traza = trazaDelSelector(r.report);
    expect(traza).toHaveLength(1);
    expect(traza[0]!.detail).toMatchObject({
      dropped: ["refund_order", "email_customer", "delete_order"],
      eliminatedTokens: 0,
      withheldWritesNotCredited: ["refund_order", "email_customer", "delete_order"],
    });
    // Y el aviso sigue saltando.
    expect(avisos.mock.calls.some((c: unknown[]) => String(c[0]).includes("tool selector sent 1 of 4"))).toBe(true);
  });

  it("con `withholdWriteTools`, un verbo de la lista las deja pasar", async () => {
    const { vistas, pedir } = conVerja();
    const r = await pedir("Send the customer an email about order 4411");
    expect(r.report.routing.executionClass).toBe("TOOL_ACTION");
    expect(vistas[0]).toHaveLength(4);
  });

  it("con `maxTools`, una de lectura podada SÍ se acredita, y una de escritura que no cabe NO", async () => {
    // maxTools: 1 en una petición de ACCIÓN («send» es uno de los 11 verbos) →
    // cabe una sola. Las de escritura van primero, así que dos de las tres de
    // escritura y la de lectura se quedan fuera. Fuera de una acción `maxTools`
    // ya no retira ninguna de escritura (ver
    // maxtools-fuera-de-accion-conserva-lecturas.test.ts).
    const { vistas, pedir } = montar({ toolSelector: new ToolSelector({ maxTools: 1 }) });
    const r = await pedir("Send a refund for order 4411");
    expect(r.report.routing.executionClass).toBe("TOOL_ACTION");
    expect(vistas[0]).toEqual(["refund_order"]);
    const detalle = trazaDelSelector(r.report)[0]!.detail as { eliminatedTokens: number; withheldWritesNotCredited: string[] };
    expect(detalle.withheldWritesNotCredited).toEqual(["email_customer", "delete_order"]);
    // Solo `get_order` (lectura) cuenta, y su crédito es el de UNA herramienta.
    expect(r.report.tokens.eliminatedInput).toBe(detalle.eliminatedTokens);
    expect(detalle.eliminatedTokens).toBeGreaterThan(0);

    const soloLecturas = montar({ toolSelector: new ToolSelector({ maxTools: 1, withholdWriteTools: true }) });
    const r2 = await soloLecturas.pedir("Where is my parcel?");
    // Aquí la verja retira las tres de escritura y la relevancia la de lectura
    // (no casa): el crédito es el mismo, el de la de lectura y nada más.
    expect(soloLecturas.vistas[0]).toEqual([]);
    expect(r2.report.tokens.eliminatedInput).toBe(detalle.eliminatedTokens);
  });

  it("el selector lo declara: `withholdWriteTools` es falso salvo que se pida", () => {
    expect(new ToolSelector().withholdWriteTools).toBe(false);
    expect(new ToolSelector({ maxTools: 8 }).withholdWriteTools).toBe(false);
    expect(new ToolSelector({ withholdWriteTools: true }).withholdWriteTools).toBe(true);
  });
});
