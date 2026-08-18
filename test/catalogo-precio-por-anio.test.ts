import { describe, it, expect } from "vitest";

import { precioDeLista } from "../src/pricing/catalogo.js";

/**
 * El catálogo no hereda precio hacia VERSIONES MENORES.
 *
 * POR QUÉ. `buscarPorModelo` casaba por prefijo con cualquier separador, así que
 * `claude-opus-4-5` heredaba el precio de `claude-opus-4` (15/75 por MTok en vez
 * de 5/25 — el TRIPLE), en silencio y con `basis:"measured"`: cost.actual y los
 * dólares del panel salían triplicados sin el aviso de «precio ilustrativo» (que
 * solo salta cuando el catálogo NO casa nada). Ahora solo hereda una instantánea
 * FECHADA (año de 4 dígitos tras el separador); una versión menor cae a
 * ilustrativo + aviso, que la propia cabecera declara la respuesta honesta.
 */

describe("catálogo — herencia solo por instantánea fechada", () => {
  it("una versión menor NO hereda el precio de la mayor", () => {
    // gpt-4.5-preview y gpt-4-32k no están en el catálogo: deben caer a undefined
    // (ilustrativo + aviso), no al precio de gpt-4.
    expect(precioDeLista("gpt-4.5-preview")).toBeUndefined();
    expect(precioDeLista("openai/gpt-4.5-preview")).toBeUndefined();
    expect(precioDeLista("gpt-4-32k")).toBeUndefined();
  });

  it("claude-opus-4-5 se tarifa a SU precio, no al de claude-opus-4", () => {
    const p = precioDeLista("claude-opus-4-5");
    expect(p).toEqual({ inputPer1k: 0.005, outputPer1k: 0.025, cachedInputPer1k: 0.0005 });
    // Y con prefijo de vendor + instantánea fechada, sigue siendo opus-4-5.
    expect(precioDeLista("anthropic/claude-opus-4-5-20260115")).toEqual({
      inputPer1k: 0.005,
      outputPer1k: 0.025,
      cachedInputPer1k: 0.0005,
    });
    // Lo que NO puede pasar: heredar el precio de opus-4 (el triple).
    expect(precioDeLista("claude-opus-4-5")).not.toEqual(precioDeLista("claude-opus-4"));
  });

  it("las instantáneas FECHADAS de un modelo real sí heredan (no rompemos el caso legítimo)", () => {
    expect(precioDeLista("gpt-4o-2024-08-06")).toEqual(precioDeLista("gpt-4o"));
    expect(precioDeLista("openai/gpt-4o-2024-11-20")).toEqual(precioDeLista("gpt-4o"));
    expect(precioDeLista("claude-sonnet-4-20250514")).toEqual(precioDeLista("claude-sonnet-4"));
  });

  it("exacto y sin-prefijo siguen funcionando", () => {
    expect(precioDeLista("gpt-4o")).toEqual({ inputPer1k: 0.0025, outputPer1k: 0.01, cachedInputPer1k: 0.00125 });
    expect(precioDeLista("openai/gpt-4o-mini")).toEqual({ inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 });
  });

  it("un modelo desconocido no casa (cae a ilustrativo)", () => {
    expect(precioDeLista("acme/supermodel-9000")).toBeUndefined();
  });
});
