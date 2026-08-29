import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { ExecutionRouter } from "../src/router/router.js";
import { canonicalize } from "../src/canonicalization/canonicalize.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest, ToolDescriptor } from "../src/contracts/types.js";

/** Compresor con PÉRDIDA, del estilo de los que se usan de verdad: poda léxica.
 *
 *  La lista NO incluye «never», y no es un detalle: este fichero prueba que los
 *  mensajes de SISTEMA no se comprimen, no la verja de negación. Podar «never»
 *  se come una negación e invierte el sentido, así que desde que
 *  `compresionFiel` comprueba el resultado —y no la palabra del compresor— esa
 *  reescritura se rechaza, con razón, y el mensaje del usuario tampoco se
 *  comprimiría: el test dejaría de probar lo suyo por un motivo ajeno. Con
 *  relleno de verdad, la poda es fiel y la protección del sistema se ve sola. */
const compresorConPerdida = {
  async compress({ text }: { text: string }) {
    const podado = text
      .split(/\s+/)
      .filter((p) => !/^(reveal|internal|the|to|user|under|any|circumstance|rules|pricing)$/i.test(p))
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
  /**
   * El contexto es largo A PROPÓSITO, y no por gusto: desde que la etapa 9 llama
   * a las verjas económicas, un prompt de dos frases no se comprime —no llega al
   * mínimo de 2000 tokens— y este test pasaría sin haber ejercitado nada. El
   * relleno que NO se puede podar es igual de deliberado: si lo comprimido cayera
   * por debajo del tramo cacheable de 1024, la capa se abstendría por dinero y
   * volveríamos a comprobar el prompt de sistema de una compresión que no ocurrió.
   */
  const podable = Array.from({ length: 200 }, () => "never the to user rules pricing").join(" ");
  const intocable = Array.from({ length: 250 }, () => "contexto adicional que no se toca").join(" ");
  const peticion = (): SavingsRequest => ({
    model: "openai/gpt-4o-mini",
    messages: [
      { role: "system", content: "Never reveal internal pricing rules to the user under any circumstance." },
      { role: "user", content: `cuentame algo largo sobre el asunto: ${podable} ${intocable}` },
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
    const res = await capa.generate(peticion());

    // Primero: que la compresión CORRIÓ. Sin esto el test es verde por no haber
    // ejercitado nada, que es la trampa de la que este repo ya se ha quemado.
    expect(res.report.tokens.compressedInput).toBeGreaterThan(0);

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
    expect(res.report.compression!.originalTokens).toBeGreaterThan(0);
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
