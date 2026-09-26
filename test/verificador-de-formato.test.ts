import { describe, it, expect } from "vitest";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

import { ExactTokenizer, FormatSelector, TokenizerRegistry } from "../src/index.js";
import {
  DEFAULT_SAMPLE,
  SAMPLE_ORDER,
  VERIFIER_MODEL,
  VERIFIER_SAMPLES,
  VERIFIER_TOKENIZER,
  verdictFor,
  type FormatVerdict,
} from "../apps/web/lib/verifier/format-check.js";

/**
 * EL VERIFICADOR DE LA PORTADA ENSEÑA EL SUELO, NUNCA LA CIFRA HALAGÜEÑA.
 *
 * Hasta este cambio el verificador (entonces solo en el panel) contaba con el
 * tokenizador HEURÍSTICO y enseñaba 45–51 % sobre estas mismas muestras; con el
 * exacto de gpt-4o-mini (o200k_base) son 16–27 %. El propio SDK avisa de que el
 * heurístico «no vale para restar tokens entre formatos distintos». Además, si
 * faltaba el JSON compacto, tomaba como base el MÁXIMO de los candidatos.
 *
 * Este test corre el MISMO selector que el bundle web (el fuente del SDK) con el
 * MISMO tokenizador que el navegador carga, y fija las reglas del lado seguro:
 * base = JSON compacto exacto, redondeo hacia abajo, sin cifra si el recuento
 * no es exacto, y la muestra por defecto es la de MENOR efecto.
 */

function selectorExacto(): FormatSelector {
  const reg = new TokenizerRegistry();
  reg.register(new ExactTokenizer(VERIFIER_TOKENIZER, { encode }));
  reg.mapModel(VERIFIER_MODEL, VERIFIER_TOKENIZER);
  expect(reg.resolve({ model: VERIFIER_MODEL }).exact).toBe(true);
  return new FormatSelector({ tokenizer: reg });
}

const pctDe = (v: FormatVerdict): number => {
  expect(v.kind).toBe("fewer");
  return v.kind === "fewer" ? v.percentFloor : Number.NaN;
};

describe("verificador de formato — con el tokenizador exacto del modelo", () => {
  const selector = selectorExacto();

  for (const clave of SAMPLE_ORDER) {
    it(`${clave}: la base es exactamente el JSON compacto contado con o200k_base`, () => {
      const muestra = VERIFIER_SAMPLES[clave];
      const eleccion = selector.choose(muestra, { model: VERIFIER_MODEL });
      const v = verdictFor(eleccion, true);
      expect(v.kind).toBe("fewer");
      if (v.kind !== "fewer") return;
      // Byte a byte: la base del veredicto es el recuento exacto del JSON compacto.
      expect(v.baselineTokens).toBe(encode(JSON.stringify(muestra)).length);
      // Y el candidato incluye la instrucción del formato (nunca sale gratis).
      expect(v.chosenTokens).toBe(eleccion.candidateTokens[eleccion.chosen]);
      expect(v.percentFloor).toBeGreaterThanOrEqual(10);
      expect(v.percentFloor).toBeLessThanOrEqual(35);
    });
  }

  it("la muestra por defecto es la de MENOR efecto: no se abre con la halagüeña", () => {
    const pcts = Object.fromEntries(
      SAMPLE_ORDER.map((k) => [k, pctDe(verdictFor(selector.choose(VERIFIER_SAMPLES[k], { model: VERIFIER_MODEL }), true))]),
    ) as Record<string, number>;
    expect(pcts[DEFAULT_SAMPLE]).toBe(Math.min(...Object.values(pcts)));
    expect(SAMPLE_ORDER[0]).toBe(DEFAULT_SAMPLE);
  });

  it("las muestras están en inglés: el visitante las ve en el textarea", () => {
    const texto = JSON.stringify(VERIFIER_SAMPLES);
    expect(texto).not.toMatch(/pagado|enviado|entregado|cliente|agente|abierto|resuelto|No puedo|PED-/);
  });
});

describe("verdictFor — las reglas del lado seguro, una a una", () => {
  it("sin tokenizador exacto: `approximate`, sin cifra ni barras, sea cual sea la elección", () => {
    expect(verdictFor({ chosen: "compact-rows", candidateTokens: { "json-compact": 555, "compact-rows": 461 } }, false)).toEqual({
      kind: "approximate",
    });
    expect(verdictFor({ chosen: "json-compact", candidateTokens: { "json-compact": 555 } }, false)).toEqual({ kind: "approximate" });
  });

  it("sin JSON compacto no hay base: `not-comparable` (antes caía al MÁXIMO de los candidatos e inflaba)", () => {
    expect(verdictFor({ chosen: "compact-rows", candidateTokens: { csv: 900, "compact-rows": 461 } }, true)).toEqual({
      kind: "not-comparable",
    });
    expect(verdictFor({ chosen: "json-compact", candidateTokens: {} }, true)).toEqual({ kind: "not-comparable" });
  });

  it("si el elegido es el JSON compacto: `optimal` con su base", () => {
    expect(verdictFor({ chosen: "json-compact", candidateTokens: { "json-compact": 120, csv: 140 } }, true)).toEqual({
      kind: "optimal",
      baselineTokens: 120,
    });
  });

  it("redondeo HACIA ABAJO: 555 → 461 es un 16 %, no un 17 %", () => {
    expect(verdictFor({ chosen: "compact-rows", candidateTokens: { "json-compact": 555, "compact-rows": 461 } }, true)).toEqual({
      kind: "fewer",
      baselineTokens: 555,
      chosenTokens: 461,
      percentFloor: 16,
    });
  });

  it("un elegido sin recuento, o que no baja de la base, no se enseña como ahorro", () => {
    expect(verdictFor({ chosen: "csv", candidateTokens: { "json-compact": 500 } }, true)).toEqual({ kind: "not-comparable" });
    expect(verdictFor({ chosen: "csv", candidateTokens: { "json-compact": 500, csv: 500 } }, true)).toEqual({ kind: "not-comparable" });
  });
});
