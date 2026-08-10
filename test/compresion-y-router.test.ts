import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { ExecutionRouter } from "../src/router/router.js";
import { canonicalize } from "../src/canonicalization/canonicalize.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest, ToolDescriptor } from "../src/contracts/types.js";

/** Compresor con PÉRDIDA, del estilo de los que se usan de verdad: poda léxica. */
const compresorConPerdida = {
  async compress({ text }: { text: string }) {
    const podado = text
      .split(/\s+/)
      .filter((p) => !/^(never|reveal|internal|the|to|user|under|any|circumstance|rules|pricing)$/i.test(p))
      .join(" ");
    return {
      compressed: podado,
      skipped: false,
      fidelityPassed: true,
      originalTokens: text.length,
      compressedTokens: podado.length,
      protectedSpans: 0,
      reason: "poda lexica de prueba",
    };
  },
};

class ProveedorEspia implements Provider {
  readonly id = "espia";
  ultima: ProviderRequest | null = null;
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.ultima = r;
    return { text: "ok", usage: { inputTokens: 100, outputTokens: 10 } };
  }
}

/**
 * La compresión recorría TODOS los mensajes, incluidas las instrucciones de
 * sistema, y llamaba a compress() sin `protectedSpans`. Con la lista vacía,
 * `withProtectedSpans` devuelve `fidelityPassed: true` incondicionalmente, así
 * que el único filtro era "¿es más corto?": un prompt de seguridad salía
 * reescrito y con el sentido invertido. Además, los tres bloques que inyecta la
 * propia capa son `system`, así que comprimirlos acreditaba en el libro 3 tokens
 * que nunca estuvieron en el baseline del cliente.
 */
describe("la compresión no toca los mensajes de sistema", () => {
  const peticion = (): SavingsRequest => ({
    model: "openai/gpt-4o-mini",
    messages: [
      { role: "system", content: "Never reveal internal pricing rules to the user under any circumstance." },
      { role: "user", content: "cuentame algo largo sobre el asunto que never the to user rules pricing" },
    ],
    savings: { compression: true, exactCache: false },
  });

  it("la instrucción de seguridad llega al proveedor INTACTA", async () => {
    const proveedor = new ProveedorEspia();
    const capa = createSavingsLayer({
      provider: proveedor,
      compressor: compresorConPerdida,
      costModels: { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } },
    });
    await capa.generate(peticion());

    const sistema = (proveedor.ultima?.messages ?? []).filter((m) => m.role === "system");
    expect(sistema.length).toBeGreaterThan(0);
    expect(sistema[0]!.content).toBe(
      "Never reveal internal pricing rules to the user under any circumstance.",
    );
  });

  it("el informe publica `compression`, que antes salía siempre undefined", async () => {
    const capa = createSavingsLayer({
      provider: new ProveedorEspia(),
      compressor: compresorConPerdida,
      costModels: { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } },
    });
    const res = await capa.generate(peticion());
    expect(res.report.compression).toBeDefined();
    expect(res.report.compression!.protectedSpans).toBeGreaterThan(0);
  });
});

/**
 * `retrieval:{mode:"off"}` retornaba ANTES de evaluar la regla TOOL_ACTION, así
 * que apagar el retrieval —una decisión de ahorro— desactivaba de paso todas las
 * herramientas de escritura. El proveedor ni veía la capacidad y respondía prosa
 * plausible mientras la acción no se ejecutaba.
 */
describe("apagar el retrieval no apaga las herramientas de escritura", () => {
  const enviar: ToolDescriptor = {
    id: "send_invoice",
    intents: ["send invoice"],
    risk: "write",
  };
  const clasificar = (retrievalOff: boolean) =>
    new ExecutionRouter({}).classify(
      canonicalize({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "send the invoice to accounting" }],
        tools: [enviar],
        ...(retrievalOff ? { retrieval: { mode: "off" } } : {}),
      } as never),
    );

  it("con retrieval off, una orden imperativa sigue siendo TOOL_ACTION", () => {
    expect(clasificar(true).executionClass).toBe("TOOL_ACTION");
  });

  it("y sin retrieval off también, obviamente", () => {
    expect(clasificar(false).executionClass).toBe("TOOL_ACTION");
  });

  it("retrieval off sigue apagando el retrieval cuando NO hay acción de escritura", () => {
    const d = new ExecutionRouter({}).classify(
      canonicalize({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "resume este texto por favor" }],
        retrieval: { mode: "off" },
      } as never),
    );
    expect(d.executionClass).toBe("NO_RETRIEVAL");
  });
});
