import { describe, expect, it } from "vitest";
import type { ChatMessage, ProviderResponse, SavingsRequest } from "../../src/index.js";
import { crearCapaDelAdaptador } from "../../src/adapters/comun/capa.js";
import { construirPeticion } from "../../src/adapters/comun/peticion.js";
import {
  crearAlmacen,
  crearPuente,
  ERROR_REESCRITA,
  ERROR_SEGUNDA,
  ERROR_SIN_LLAMADA,
  nuevaLlamada,
} from "../../src/adapters/comun/puente.js";

/**
 * EL PUENTE (R1 y R2): lo que llega al modelo es lo que mandó el framework, y
 * una llamada del framework es, como mucho, una llamada al modelo.
 *
 * Con las palancas que el adaptador fuerza (D4), el núcleo tiene que entregar al
 * puente LOS MISMOS objetos de mensaje que renderizó el adaptador. Si un día una
 * palanca nueva reescribiera algo, el puente lo detecta y lanza antes de gastar.
 */

const RESPUESTA: ProviderResponse = {
  text: "Paris",
  finishReason: "stop",
  usage: { inputTokens: 30, outputTokens: 2, reasoningTokens: 0 },
};

// Mensajes mixtos: system al principio y a mitad, assistant con llamadas, tool.
function mensajes(): ChatMessage[] {
  return [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Capital of France?" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "lookup", arguments: '{"q":"x"}' }] },
    { role: "tool", content: '{"r":1}', toolCallId: "c1", name: "lookup" },
    { role: "system", content: "Mid-conversation note." },
    { role: "user", content: "And again, in one word?" },
  ];
}

async function peticion(): Promise<SavingsRequest> {
  return construirPeticion(
    {},
    {
      model: "openai/gpt-4o-mini",
      messages: mensajes(),
      tools: [{ id: "lookup", intents: [], risk: "read", parameters: { type: "object", properties: { q: { type: "string" } } } }],
      temperature: 0,
      proyeccion: { cualquier: "cosa" },
    },
  );
}

describe("el puente", () => {
  it("R1: con las palancas del adaptador, el núcleo le entrega LOS MISMOS objetos que se renderizaron", async () => {
    const capa = crearCapaDelAdaptador("prueba", { silenceWarnings: true });
    const req = await peticion();
    const vistos: unknown[] = [];
    const llamada = nuevaLlamada({ model: req.model, messages: req.messages, ...(req.tools ? { tools: req.tools } : {}) }, async () => {
      llamada.completada = true;
      vistos.push(llamada.renderizado);
      return RESPUESTA;
    });
    const d = await capa.generar(req, llamada);
    expect(d.tipo).toBe("vivo");
    expect(vistos).toHaveLength(1);
    capa.close();
  });

  it("R1: el ProviderRequest que recibe el puente lleva los mismos objetos de mensaje (identidad, no solo igualdad)", async () => {
    const req = await peticion();
    const als = crearAlmacen();
    let recibido: { messages: ChatMessage[] } | undefined;
    const puente = crearPuente("prueba", als);
    const original = puente.generate.bind(puente);
    const espia = { ...puente, generate: (r: Parameters<typeof puente.generate>[0]) => ((recibido = r), original(r)) };
    const { createSavingsLayer } = await import("../../src/index.js");
    const capa = createSavingsLayer({ provider: espia, silenceWarnings: true });
    const llamada = nuevaLlamada({ model: req.model, messages: req.messages, ...(req.tools ? { tools: req.tools } : {}) }, async () => RESPUESTA);
    await als.run(llamada, () => capa.generate(req));
    expect(recibido?.messages).toHaveLength(req.messages.length);
    recibido?.messages.forEach((m, i) => expect(m).toBe(req.messages[i]));
    capa.close();
  });

  it("R1: un ProviderRequest alterado lanza SIN llamar al framework", async () => {
    const als = crearAlmacen();
    const puente = crearPuente("prueba", als);
    let llamado = false;
    const renderizado = { model: "openai/gpt-4o-mini", messages: mensajes() };
    const llamada = nuevaLlamada(renderizado, async () => {
      llamado = true;
      return RESPUESTA;
    });
    const alterado = { ...renderizado, messages: [...renderizado.messages.slice(0, -1), { role: "user" as const, content: "Something else" }] };
    await expect(als.run(llamada, () => puente.generate(alterado))).rejects.toThrow(ERROR_REESCRITA);
    const otroModelo = { ...renderizado, model: "openai/gpt-4o" };
    await expect(als.run(llamada, () => puente.generate(otroModelo))).rejects.toThrow(ERROR_REESCRITA);
    expect(llamado).toBe(false);
    expect(llamada.invocada).toBe(false);
  });

  it("R2: una segunda llamada dentro de la misma llamada del framework lanza sin llamar", async () => {
    const als = crearAlmacen();
    const puente = crearPuente("prueba", als);
    let veces = 0;
    const renderizado = { model: "openai/gpt-4o-mini", messages: mensajes() };
    const llamada = nuevaLlamada(renderizado, async () => {
      veces += 1;
      return RESPUESTA;
    });
    await als.run(llamada, async () => {
      await puente.generate(renderizado);
      await expect(puente.generate(renderizado)).rejects.toThrow(ERROR_SEGUNDA);
      const stream = puente.generateStream!(renderizado);
      await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(ERROR_SEGUNDA);
    });
    expect(veces).toBe(1);
  });

  it("fuera de una llamada del framework, el puente no llama a nada", async () => {
    const puente = crearPuente("prueba", crearAlmacen());
    await expect(puente.generate({ model: "m", messages: [] })).rejects.toThrow(ERROR_SIN_LLAMADA);
  });

  it("las palancas forzadas (D4) y las que se apagan por llamada", async () => {
    const req = await construirPeticion(
      { savings: { singleflight: false } },
      {
        model: "m",
        messages: [],
        tools: [],
        proyeccion: {},
        savings: { exactCache: false, deterministicResolvers: true },
      },
    );
    expect(req.savings).toEqual({
      router: false,
      compression: false,
      elision: false,
      serialization: false,
      toolDiscovery: false,
      modelCascade: "off",
      outputCodebook: false,
      deferrable: false,
      semanticCache: false,
      verification: false,
      exactCache: false,
      singleflight: false,
      deterministicResolvers: true,
    });
  });
});
