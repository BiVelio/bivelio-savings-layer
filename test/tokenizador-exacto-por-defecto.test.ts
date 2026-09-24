import { describe, expect, it } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { defaultTokenizerRegistry } from "../src/tokenizer/registry.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

/**
 * `gpt-tokenizer` era peer opcional, el README lo anunciaba, `registerExactTokenizer`
 * existía… y la fábrica nunca lo llamaba: solo los bancos y los tests. Un cliente
 * que instalaba el peer seguía contando con el heurístico y cada ahorro salía
 * `estimated`. Desde hoy la fábrica lo carga sola en el registro por defecto y la
 * primera petición espera a que esté. El orden de estos tests importa: el
 * registro por defecto es un singleton del módulo, y una vez cargado el exacto
 * no se descarga — por eso el caso "apagado" va primero.
 */
const proveedor: Provider = {
  id: "mock",
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    return {
      text: "ok",
      usage: { inputTokens: 10, outputTokens: 1 },
      model: req.model,
      finishReason: "stop",
    } as ProviderResponse;
  },
} as Provider;

const MODELO = "openai/gpt-4o-mini";
const peticion = { model: MODELO, messages: [{ role: "user" as const, content: "hola" }] };

describe("el tokenizador exacto se carga solo en el registro por defecto", () => {
  it("con `exactTokenizer: false` el registro sigue heurístico aunque el peer esté instalado", async () => {
    const capa = createSavingsLayer({ provider: proveedor, devUnlicensed: true, exactTokenizer: false });
    await capa.generate(peticion);
    expect(defaultTokenizerRegistry.resolve({ model: MODELO }).exact).toBe(false);
    capa.close();
  });

  it("por defecto, tras la primera petición el modelo de OpenAI resuelve a un tokenizador EXACTO", async () => {
    const capa = createSavingsLayer({ provider: proveedor, devUnlicensed: true });
    await capa.generate(peticion);
    const est = defaultTokenizerRegistry.resolve({ model: MODELO });
    expect(est.exact).toBe(true);
    expect(est.id).toBe("o200k_base");
    // Con y sin prefijo de proveedor: el mismo modelo llega de las dos formas.
    expect(defaultTokenizerRegistry.resolve({ model: "gpt-4o-mini" }).exact).toBe(true);
    capa.close();
  });

  it("un registro propio del llamante no se toca", async () => {
    const { TokenizerRegistry } = await import("../src/tokenizer/registry.js");
    const propio = new TokenizerRegistry();
    const capa = createSavingsLayer({ provider: proveedor, devUnlicensed: true, tokenizer: propio });
    await capa.generate(peticion);
    expect(propio.resolve({ model: MODELO }).exact).toBe(false);
    capa.close();
  });
});
