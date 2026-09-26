import { describe, it, expect } from "vitest";

import { construirBrazoNaive } from "../benchmarks/brazos.js";
import { MUESTREO_PAREADO, scenarios } from "../benchmarks/scenarios.js";
import { construirPeticionSinCapa } from "../src/verification/brazo-sin-capa.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * LA COPIA DE LA VERIFICACIÓN ES EL BRAZO B0 DEL BANCO PUBLICADO. Con mensajes
 * de solo `role` y `content` y el muestreo pareado del banco, las dos
 * construcciones tienen que dar lo mismo, escenario a escenario: si una se
 * moviera, «tu propio banco» dejaría de comparar lo mismo que el publicado.
 *
 * La única diferencia intencionada —la copia conserva `toolCallId`/`toolCalls`,
 * que B0 descarta (y con ellos un ciclo de herramientas daría 400 en el banco)—
 * queda fuera de este test por construcción y fijada en verificacion-ab.test.ts.
 */
describe("construirPeticionSinCapa = construirBrazoNaive", () => {
  it("hay escenarios que comparar", () => {
    expect(scenarios.length).toBeGreaterThan(5);
  });

  for (const esc of scenarios) {
    it(esc.name, () => {
      const req: SavingsRequest = {
        ...esc.request,
        messages: esc.request.messages.map((m) => ({ role: m.role, content: m.content })),
        ...MUESTREO_PAREADO,
      };
      expect(construirPeticionSinCapa(req)).toEqual(construirBrazoNaive(req, req.model));
    });
  }
});
