import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import {
  TECHO_PRECIO_ENTRADA_PER_1K,
  TECHO_PRECIO_LECTURA_PER_1K,
  TECHO_PRECIO_SALIDA_PER_1K,
  recortarNativo,
  recortarSuelo,
} from "./techo-precio-lectura";

/**
 * El techo del suelo de la elisión se ata al CATÁLOGO, no a un número en la
 * cabeza de nadie. apps/web no puede importar de src/ (proyecto aparte), así que
 * se lee el fichero como texto — el mismo truco que precio-publicado y que
 * extracto-sombra.test.ts con PRECIOS_AL_DIA.
 */
const catalogo = readFileSync(new URL("../../../../src/pricing/catalogo.ts", import.meta.url), "utf8");

function precios(campo: "cachedInputPer1k" | "inputPer1k" | "outputPer1k"): number[] {
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

describe("el techo de SALIDA del carril medido por referencia (0029)", () => {
  it("el catálogo se ha leído de verdad: hay precios de salida", () => {
    expect(precios("outputPer1k").length).toBeGreaterThan(20);
  });

  it("el techo es ≥ el MAYOR outputPer1k del catálogo — ninguna referencia legítima se degrada", () => {
    const max = Math.max(...precios("outputPer1k"));
    expect(max).toBeGreaterThan(0);
    expect(TECHO_PRECIO_SALIDA_PER_1K).toBeGreaterThanOrEqual(max);
  });

  it("espejo: packages/protocol lleva EXACTAMENTE el mismo techo de salida", () => {
    const protocolo = readFileSync(new URL("../../../../packages/protocol/src/index.ts", import.meta.url), "utf8");
    const m = /TECHO_PRECIO_SALIDA_PER_1K = ([0-9.]+)/.exec(protocolo);
    expect(m, "el techo de salida tiene que estar en packages/protocol").not.toBeNull();
    expect(Number(m![1])).toBe(TECHO_PRECIO_SALIDA_PER_1K);
  });
});

describe("el techo de ENTRADA del carril del ahorro nativo (0032)", () => {
  const tier = readFileSync(new URL("../../../../src/pricing/tarifas-de-tier.ts", import.meta.url), "utf8");
  const entradas = [...`${catalogo}\n${tier}`.matchAll(/\binputPer1k:\s*([0-9.]+)/g)].map((m) => Number(m[1]));

  it("el techo es ≥ el MAYOR inputPer1k del catálogo y de las tablas de tier", () => {
    expect(entradas.length).toBeGreaterThan(20);
    expect(TECHO_PRECIO_ENTRADA_PER_1K).toBeGreaterThanOrEqual(Math.max(...entradas));
  });

  it("dinero sin conteo → 0; dentro del techo → intacto; por encima → recortado", () => {
    expect(recortarNativo(0.5, 0)).toBe(0);
    expect(recortarNativo(0.0216, 8_000)).toBe(0.0216);
    expect(recortarNativo(10, 1_000)).toBe(TECHO_PRECIO_ENTRADA_PER_1K);
  });

  it("espejo: packages/protocol lleva EXACTAMENTE el mismo techo", () => {
    const protocolo = readFileSync(new URL("../../../../packages/protocol/src/index.ts", import.meta.url), "utf8");
    const m = /TECHO_PRECIO_ENTRADA_PER_1K = ([0-9.]+)/.exec(protocolo);
    expect(m, "el techo tiene que estar en packages/protocol").not.toBeNull();
    expect(Number(m![1])).toBe(TECHO_PRECIO_ENTRADA_PER_1K);
  });
});
