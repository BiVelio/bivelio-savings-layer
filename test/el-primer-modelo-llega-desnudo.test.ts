import { describe, it, expect } from "vitest";
import { createSavingsLayer, OpenAICompatibleProvider } from "../src/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { quitarPrefijoDeProveedor } from "../src/providers/openai-compatible.js";

/**
 * El fragmento del README, pegado tal cual, MORÍA en la primera llamada que
 * llegaba al proveedor.
 *
 * `model: "openai/gpt-4o-mini"` viajaba al cable con el prefijo puesto, y OpenAI
 * responde a eso con un 404 («model does not exist»). Nadie lo veía porque el
 * ejemplo del README es «What is 2 + 2 * 3?», que resuelve el resolver local sin
 * tocar la red, y porque TODOS los bancos ponían `stripProviderPrefix` a mano.
 * El test de fragmentos solo los compila; compilar no es llegar.
 *
 * La regla que fija este test: el id cualificado es el del layer (precios, caché,
 * informe); lo que viaja lo decide el destino. OpenAI, Azure y Anthropic reciben
 * el id desnudo; una pasarela o un servidor propio con nombre de modelo cualificado
 * conserva lo que escribió el cliente. Un valor explícito gana siempre.
 */

function espia(respuesta: unknown) {
  const cuerpos: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    cuerpos.push(JSON.parse(String(init.body)));
    return {
      ok: true,
      status: 200,
      json: async () => respuesta,
      text: async () => JSON.stringify(respuesta),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { cuerpos, fetchImpl };
}

const RESPUESTA_OPENAI = {
  choices: [{ message: { content: "Madrid" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 2 },
};

describe("el primer modelo que llega al proveedor", () => {
  it("el fragmento del README, contra api.openai.com, envía `gpt-4o-mini` sin prefijo", async () => {
    const { cuerpos, fetchImpl } = espia(RESPUESTA_OPENAI);
    // Exactamente el proveedor del README: mismo baseUrl, ninguna opción extra.
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-placeholder",
      fetchImpl,
    });
    const layer = createSavingsLayer({ provider, devUnlicensed: true, silenceWarnings: true });
    // Una pregunta que el resolver local NO contesta, para que la llamada salga.
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is the capital of Spain?" }],
    });
    expect(cuerpos).toHaveLength(1);
    expect(cuerpos[0]?.model).toBe("gpt-4o-mini");
    // El informe sigue hablando en el id cualificado: es la clave del catálogo.
    expect(res.report.model).toBe("openai/gpt-4o-mini");
  });

  it("Azure OpenAI también recibe el id desnudo", async () => {
    const { cuerpos, fetchImpl } = espia(RESPUESTA_OPENAI);
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://mi-recurso.openai.azure.com/openai/deployments/x",
      fetchImpl,
    });
    await provider.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
    expect(cuerpos[0]?.model).toBe("gpt-4o-mini");
  });

  it("una pasarela conserva el prefijo, porque enruta con él", async () => {
    const { cuerpos, fetchImpl } = espia(RESPUESTA_OPENAI);
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://gateway.example.test/v1",
      fetchImpl,
    });
    await provider.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
    expect(cuerpos[0]?.model).toBe("openai/gpt-4o-mini");
  });

  it("un valor explícito gana en ambos sentidos", () => {
    expect(quitarPrefijoDeProveedor("openai/gpt-4o-mini", false, "https://api.openai.com/v1")).toBe(
      "openai/gpt-4o-mini",
    );
    expect(quitarPrefijoDeProveedor("openai/gpt-4o-mini", true, "https://gateway.example.test/v1")).toBe(
      "gpt-4o-mini",
    );
    // Un baseUrl que no parsea no rompe nada: se conserva lo escrito.
    expect(quitarPrefijoDeProveedor("openai/gpt-4o-mini", undefined, "not a url")).toBe(
      "openai/gpt-4o-mini",
    );
  });

  it("Anthropic: la API pública recibe `claude-…`; una pasarela, lo que se escribió", async () => {
    const respuesta = {
      content: [{ type: "text", text: "Madrid" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 2 },
    };
    const publica = espia(respuesta);
    await new AnthropicProvider({ apiKey: "k", fetchImpl: publica.fetchImpl }).generate({
      model: "anthropic/claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(publica.cuerpos[0]?.model).toBe("claude-sonnet-4-5");

    const pasarela = espia(respuesta);
    await new AnthropicProvider({
      baseUrl: "https://gateway.example.test/anthropic/v1",
      fetchImpl: pasarela.fetchImpl,
    }).generate({ model: "anthropic/claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] });
    expect(pasarela.cuerpos[0]?.model).toBe("anthropic/claude-sonnet-4-5");

    const explicita = espia(respuesta);
    await new AnthropicProvider({
      baseUrl: "https://gateway.example.test/anthropic/v1",
      stripProviderPrefix: true,
      fetchImpl: explicita.fetchImpl,
    }).generate({ model: "anthropic/claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] });
    expect(explicita.cuerpos[0]?.model).toBe("claude-sonnet-4-5");
  });
});
