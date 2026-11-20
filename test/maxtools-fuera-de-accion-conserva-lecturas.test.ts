import { describe, expect, it } from "vitest";
import { createSavingsLayer, OpenAICompatibleProvider, ToolSelector } from "../src/index.js";
import type { SavingsReport, ToolDescriptor } from "../src/index.js";

/**
 * A2-28, verificación previa a la 1.2.3 · CON `maxTools`, MANDAR LAS DE ESCRITURA
 * NO PUEDE QUITARLE AL MODELO LAS DE LECTURA QUE YA RECIBÍA.
 *
 * Al abrir la verja por defecto, las herramientas de escritura pasaron a ocupar
 * «los primeros huecos» de `maxTools` en TODA petición, no solo en las que el
 * router clasifica como acción. Las de lectura se quedaban con el hueco que
 * sobrara: con `maxTools: 3` y tres de escritura, «Where is order 4411?» salía
 * con las tres de escritura y SIN `get_order`. La 1.2.1 mandaba `get_order`. El
 * modelo recibía cómo reembolsar y borrar, pero no cómo consultar, y la lectura
 * retirada se apuntaba como ahorro.
 *
 * Regla desde este arreglo, fuera de una acción y sin la verja: `maxTools` poda
 * solo las de lectura —las mismas que elegía la 1.2.1— y las de escritura van
 * todas, además. En una petición de acción no cambia nada respecto a la 1.2.1.
 *
 * Todo inventado. Proveedor falso local.
 */

const lectura = (id: string, intent: string): ToolDescriptor => ({
  id,
  intents: [intent],
  risk: "read",
  description: `Look up a ${intent} by its number`,
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
});
const escritura = (id: string, intent: string, risk: "write" | "destructive" = "write"): ToolDescriptor => ({
  id,
  intents: [intent],
  risk,
  description: `Perform ${intent} on an item`,
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
});

const CATALOGO: ToolDescriptor[] = [
  lectura("get_order", "order"),
  escritura("refund_order", "refund"),
  lectura("get_invoice", "invoice"),
  escritura("email_customer", "email"),
  lectura("get_weather", "weather"),
  escritura("delete_order", "delete order", "destructive"),
];
const SOLO_LECTURA = CATALOGO.filter((t) => t.risk === "read");
const ids = (ts: ToolDescriptor[]) => ts.map((t) => t.id).sort();

describe("selector · `maxTools` fuera de una acción, con la verja apagada (el default)", () => {
  it("una pregunta de lectura conserva su herramienta de lectura aunque las de escritura llenen `maxTools`", () => {
    const r = new ToolSelector({ maxTools: 3 }).select("where is order 4411?", CATALOGO, "SINGLE_RETRIEVAL");
    expect(r.tools.map((t) => t.id)).toContain("get_order");
    // Y las de escritura van todas: es lo que A2-28 promete.
    expect(ids(r.tools)).toEqual(["delete_order", "email_customer", "get_order", "refund_order"]);
    // Solo se retiran (y solo se acreditan) lecturas que no casan.
    expect(r.droppedIds.sort()).toEqual(["get_invoice", "get_weather"]);
  });

  it("las de lectura enviadas son EXACTAMENTE las que elige el mismo selector sobre el catálogo sin escrituras", () => {
    for (const texto of ["where is order 4411?", "refund order 4411 and show the invoice", "tell me a joke", "order invoice weather"]) {
      for (const maxTools of [1, 2, 3, 8]) {
        const mixto = new ToolSelector({ maxTools }).select(texto, CATALOGO, "SINGLE_RETRIEVAL");
        const soloLectura = new ToolSelector({ maxTools }).select(texto, SOLO_LECTURA, "SINGLE_RETRIEVAL");
        expect(ids(mixto.tools.filter((t) => t.risk === "read")), `${texto} · ${maxTools}`).toEqual(ids(soloLectura.tools));
        expect(ids(mixto.tools.filter((t) => t.risk !== "read")), `${texto} · ${maxTools}`).toEqual([
          "delete_order",
          "email_customer",
          "refund_order",
        ]);
        expect(mixto.droppedIds.every((id) => SOLO_LECTURA.some((t) => t.id === id))).toBe(true);
      }
    }
  });

  it("con más escrituras que `maxTools` no se retira ninguna de escritura", () => {
    const r = new ToolSelector({ maxTools: 1 }).select("refund order 4411", CATALOGO, "SINGLE_RETRIEVAL");
    expect(ids(r.tools)).toEqual(["delete_order", "email_customer", "get_order", "refund_order"]);
  });

  it("el conjunto congelado tampoco pierde escrituras ni las lecturas aprendidas", () => {
    const sel = new ToolSelector({ maxTools: 2, learningTurns: 2 });
    sel.select("where is order 4411?", CATALOGO, "SINGLE_RETRIEVAL", "sesion");
    sel.select("show the invoice", CATALOGO, "SINGLE_RETRIEVAL", "sesion");
    const congelado = sel.select("tell me a joke", CATALOGO, "SINGLE_RETRIEVAL", "sesion");
    expect(ids(congelado.tools)).toEqual(["delete_order", "email_customer", "get_invoice", "get_order", "refund_order"]);
    expect(congelado.droppedIds).toEqual(["get_weather"]);
    expect(congelado.setIsStable).toBe(true);
  });

  it("el orden emitido no depende de la pregunta cuando el conjunto es el mismo", () => {
    const sel = new ToolSelector({ maxTools: 8 });
    const a = sel.select("order then invoice then weather", CATALOGO, "SINGLE_RETRIEVAL");
    const b = sel.select("weather, invoice and order", CATALOGO, "SINGLE_RETRIEVAL");
    expect(a.tools.map((t) => t.id)).toEqual(b.tools.map((t) => t.id));
  });

  it("en una petición de ACCIÓN no cambia nada: las de escritura primero, dentro de `maxTools`", () => {
    const r = new ToolSelector({ maxTools: 3 }).select("send the refund for order 4411", CATALOGO, "TOOL_ACTION");
    expect(ids(r.tools)).toEqual(["delete_order", "email_customer", "refund_order"]);
  });

  it("con la verja (`withholdWriteTools`) tampoco cambia nada: solo lecturas, hasta `maxTools`", () => {
    const r = new ToolSelector({ maxTools: 3, withholdWriteTools: true }).select("where is order 4411?", CATALOGO, "SINGLE_RETRIEVAL");
    expect(ids(r.tools)).toEqual(["get_order"]);
  });
});

describe("de extremo a extremo · lo que recibe el modelo con `maxTools`", () => {
  function montar(maxTools: number) {
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
      toolSelector: new ToolSelector({ maxTools }),
      silenceWarnings: true,
    });
    const pedir = (texto: string) =>
      capa.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: texto }], tools: CATALOGO });
    return { vistas, pedir };
  }
  const traza = (r: SavingsReport) => r.traces.find((t) => t.stage === "tool-selector");

  it("«Where is order 4411?» con maxTools 3: el modelo recibe `get_order` y las tres de escritura", async () => {
    const { vistas, pedir } = montar(3);
    const { report } = await pedir("Where is order 4411?");
    expect([...vistas[0]!].sort()).toEqual(["delete_order", "email_customer", "get_order", "refund_order"]);
    // Lo único retirado, y lo único acreditado, son lecturas que no casan.
    expect((traza(report)?.detail as { dropped: string[] }).dropped.sort()).toEqual(["get_invoice", "get_weather"]);
    expect((traza(report)?.detail as Record<string, unknown>)["withheldWritesNotCredited"]).toBeUndefined();
    expect(report.tokens.eliminatedInput).toBeGreaterThan(0);
  });

  it("«Refund order 4411» con maxTools 1: `refund_order` llega, con `get_order`", async () => {
    const { vistas, pedir } = montar(1);
    await pedir("Refund order 4411");
    expect(vistas[0]).toContain("refund_order");
    expect(vistas[0]).toContain("get_order");
  });
});
