import { describe, it, expect } from "vitest";

import { validateAgainstSchema } from "../src/constraints/validate.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

/**
 * Un `pattern` con sintaxis inválida en el contrato del cliente NO puede lanzar.
 *
 * El fallo (encontrado en la verificación pre-lanzamiento): `new RegExp(pattern)`
 * sin guarda lanzaba, tumbaba la validación entera, y el fail-open reenviaba la
 * petición al proveedor — el cliente pagaba DOS veces por un error de SU propio
 * esquema. Es la peor clase de fallo de facturación: silencioso y autoinfligido.
 */

const patternInvalido = {
  type: "object" as const,
  properties: { x: { type: "string" as const, pattern: "(sin-cerrar[" } },
};

describe("un pattern inválido se trata como error de validación, no como excepción", () => {
  it("validateAgainstSchema no lanza; devuelve inválido con motivo", () => {
    const r = validateAgainstSchema({ x: "hola" }, patternInvalido);
    expect(r.valid).toBe(false);
    expect(JSON.stringify(r.errors)).toMatch(/not a valid regular expression/);
  });

  it("un pattern VÁLIDO sigue funcionando (sin regresión)", () => {
    const ok = { type: "object" as const, properties: { x: { type: "string" as const, pattern: "^[a-z]+$" } } };
    expect(validateAgainstSchema({ x: "hola" }, ok).valid).toBe(true);
    expect(validateAgainstSchema({ x: "H0LA" }, ok).valid).toBe(false);
  });

  it("NO hay doble llamada al proveedor por un pattern roto", async () => {
    // El mecanismo del doble cobro: validate lanza -> generate cae a
    // failOpenDirect -> segunda llamada. Con el arreglo, validate no lanza, así
    // que solo hay UNA llamada.
    let llamadas = 0;
    const provider: Provider = {
      id: "cuenta",
      async generate(_r: ProviderRequest): Promise<ProviderResponse> {
        llamadas++;
        return { text: '{"x":"hola"}', finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const layer = createSavingsLayer({ provider, devUnlicensed: true });
    await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "dame x" }],
      response: { contractId: "c:v1", schema: patternInvalido },
    });
    expect(llamadas).toBe(1);
  });
});
