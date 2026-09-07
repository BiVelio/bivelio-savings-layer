import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { TECHO_PRECIO_LECTURA_PER_1K, recortarSuelo } from "./techo-precio-lectura";

/**
 * El techo del suelo de la elisión se ata al CATÁLOGO, no a un número en la
 * cabeza de nadie. apps/web no puede importar de src/ (proyecto aparte), así que
 * se lee el fichero como texto — el mismo truco que precio-publicado y que
 * extracto-sombra.test.ts con PRECIOS_AL_DIA.
 */
const catalogo = readFileSync(new URL("../../../../src/pricing/catalogo.ts", import.meta.url), "utf8");

function precios(campo: "cachedInputPer1k" | "inputPer1k"): number[] {
  const re = new RegExp(`\\b${campo}:\\s*([0-9.]+)`, "g");
  return [...catalogo.matchAll(re)].map((m) => Number(m[1]));
}

describe("el techo del suelo de la elisión (precio de LECTURA de caché)", () => {
  it("el catálogo se ha leído de verdad: hay precios de lectura", () => {
    expect(precios("cachedInputPer1k").length).toBeGreaterThan(20);
  });

  it("el techo es ≥ el MAYOR cachedInputPer1k del catálogo — ningún suelo legítimo se recorta", () => {
    const max = Math.max(...precios("cachedInputPer1k"));
    expect(max).toBeGreaterThan(0);
    expect(TECHO_PRECIO_LECTURA_PER_1K).toBeGreaterThanOrEqual(max);
  });

  it("⛔ un suelo tarifado a precio de ENTRADA de un modelo Anthropic queda recortado", () => {
    // fable-5-1: inputPer1k 0.01 frente a cachedInputPer1k 0.00025 (×40). Un
    // gateway que se equivoque de precio manda 10.000 tokens como $0,10; el
    // techo lo deja en 10 × 0,002 = $0,02 como mucho.
    const m = /"claude-fable-5-1":\s*\{\s*inputPer1k:\s*([0-9.]+)/.exec(catalogo);
    expect(m, "claude-fable-5-1 tiene que estar en el catálogo").not.toBeNull();
    const entrada = Number(m![1]);
    const tokens = 10_000;
    const aEntrada = (tokens / 1_000) * entrada;
    expect(recortarSuelo(aEntrada, tokens)).toBeLessThan(aEntrada);
    expect(recortarSuelo(aEntrada, tokens)).toBe((tokens / 1_000) * TECHO_PRECIO_LECTURA_PER_1K);
  });

  it("dinero sin conteo → 0; dentro del techo → intacto", () => {
    expect(recortarSuelo(0.5, 0)).toBe(0);
    expect(recortarSuelo(0.001, 10_000)).toBe(0.001);
  });

  it("espejo: packages/protocol lleva EXACTAMENTE el mismo techo", () => {
    const protocolo = readFileSync(new URL("../../../../packages/protocol/src/index.ts", import.meta.url), "utf8");
    const m = /TECHO_PRECIO_LECTURA_PER_1K = ([0-9.]+)/.exec(protocolo);
    expect(m, "el techo tiene que estar en packages/protocol").not.toBeNull();
    expect(Number(m![1])).toBe(TECHO_PRECIO_LECTURA_PER_1K);
  });
});
