import { describe, it, expect } from "vitest";
import { costeMedido, informeMedido } from "../gateway/medidor.js";

/**
 * DETRÁS DE UN UPSTREAM NO OFICIAL EL GATEWAY MIDE Y NO ACREDITA (decisión del
 * dueño, 2026-09-28).
 *
 * Las tres palancas del gateway que acreditan dinero `measured` lo hacen como
 * una resta entre precios de LISTA sobre el mismo conteo: la rebaja de TTL (1 h
 * → 5 min), el modelo hermano y el suelo de la elisión del proveedor (a precio
 * de lectura de caché). El precio de lista solo está en la factura del ORIGEN
 * del proveedor. Detrás de LiteLLM, un revendedor o un modelo propio no hay
 * factura que respalde esa resta: se aplica la palanca, se mide el coste y
 * baseline == actual. Es lo que ya pasaba con el tráfico de suscripción y con la
 * gemela coalescida (`unofficial-upstream`). Cada caso lleva su control: el
 * MISMO informe contra el origen oficial sí acredita.
 */

type Informe = {
  cost: { baselineEstimate: number; actual: number; netSavingsRatio: number; basis: string; eliminatedInputFloorCost?: number };
};

const rebaja = { rebajadas: 2, yaEran5m: 0, herramientaDeServidor: false };

describe("upstream no oficial: se mide el coste y no se acredita dinero", () => {
  it("rebaja de TTL: control oficial acredita la prima evitada; no oficial, baseline == actual", () => {
    const medido = costeMedido("claude-opus-5", { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 100_000 })!;
    const oficial = informeMedido("r-of", "claude-opus-5", medido, undefined, null, rebaja) as unknown as Informe;
    const proxy = informeMedido("r-px", "claude-opus-5", medido, undefined, null, rebaja, null, false, true) as unknown as Informe;

    expect(oficial.cost.baselineEstimate - oficial.cost.actual).toBeGreaterThan(0);
    expect(proxy.cost.basis).toBe("measured");
    expect(proxy.cost.actual).toBe(oficial.cost.actual);
    expect(proxy.cost.baselineEstimate).toBe(proxy.cost.actual);
    expect(proxy.cost.netSavingsRatio).toBe(0);
  });

  it("modelo hermano: control oficial acredita la diferencia de lectura; no oficial, nada", () => {
    const medido = costeMedido("claude-fable-5-1", { cache_read_input_tokens: 1_000_000 })!;
    const cambio = { solicitado: "claude-fable-5", servido: "claude-fable-5-1" };
    const oficial = informeMedido("h-of", "claude-fable-5-1", medido, undefined, null, null, cambio) as unknown as Informe;
    const proxy = informeMedido("h-px", "claude-fable-5-1", medido, undefined, null, null, cambio, false, true) as unknown as Informe;

    expect(oficial.cost.netSavingsRatio).toBeGreaterThan(0);
    expect(proxy.cost.baselineEstimate).toBe(proxy.cost.actual);
    expect(proxy.cost.netSavingsRatio).toBe(0);
  });

  it("suelo de la elisión: control oficial lleva eliminatedInputFloorCost; no oficial, el conteo sí y el dinero no", () => {
    const medido = costeMedido("claude-opus-5", { input_tokens: 1_000, output_tokens: 10 })!;
    const elision = { borrados: 1, tokensLimpiados: 30_000, tokensLimpiadosToolUses: 30_000, atribuible: true };
    const oficial = informeMedido("e-of", "claude-opus-5", medido, undefined, elision) as unknown as Informe & {
      tokens: { eliminatedInput: number };
    };
    const proxy = informeMedido("e-px", "claude-opus-5", medido, undefined, elision, null, null, false, true) as unknown as Informe & {
      tokens: { eliminatedInput: number };
    };

    expect(oficial.cost.eliminatedInputFloorCost).toBeGreaterThan(0);
    expect(proxy.cost.eliminatedInputFloorCost).toBeUndefined();
    // El CONTEO que declaró el proveedor se sigue reportando: es un hecho, no dinero.
    expect(proxy.tokens.eliminatedInput).toBe(oficial.tokens.eliminatedInput);
  });

  it("sin palanca no cambia nada: el informe medido es el mismo con upstream oficial o no", () => {
    const medido = costeMedido("claude-opus-5", { input_tokens: 500, output_tokens: 20 })!;
    const oficial = informeMedido("s-of", "claude-opus-5", medido);
    const proxy = informeMedido("s-of", "claude-opus-5", medido, undefined, undefined, undefined, undefined, false, true);
    expect(proxy).toEqual(oficial);
  });
});
