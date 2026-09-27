import { describe, it, expect } from "vitest";

import { MUESTREO_PAREADO, conMargenDeRazonamiento, conMuestreoPareado, muestreoPareadoPara, razonaParaElBanco } from "../benchmarks/scenarios.js";
import type { SavingsRequest } from "../src/index.js";

/**
 * EL MUESTREO QUE ADMITE CADA MODELO.
 *
 * Con los modelos de 2026 un `temperature: 0` rompe la tirada en la primera
 * llamada: Claude Sonnet 5 devuelve 400 a una temperatura que no es la de por
 * defecto, y la familia gpt-5 solo acepta la suya. La regla es la de
 * `src/pricing/razonamiento.ts` (`salidaNoRepetible`): donde el modelo honra
 * el muestreo fijo, 0/7; en cualquier otro caso, nada — y TODOS los brazos
 * reciben lo mismo.
 */
describe("muestreoPareadoPara", () => {
  it.each(["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5", "gpt-4o"])(
    "%s honra el muestreo fijo: temperature 0, seed 7",
    (m) => {
      expect(muestreoPareadoPara(m)).toEqual(MUESTREO_PAREADO);
    },
  );

  it.each([
    "anthropic/claude-sonnet-5",
    "openai/gpt-6-luna",
    "google/gemini-3.8-flash",
    "openai/gpt-5.6",
    "anthropic/claude-opus-4-8",
    "acme/un-modelo-sin-clasificar",
  ])("%s no: el proveedor aplica su valor por defecto", (m) => {
    expect(muestreoPareadoPara(m)).toEqual({});
  });

  it("conMuestreoPareado aplica la regla del modelo de la petición", () => {
    const base: SavingsRequest = { model: "anthropic/claude-sonnet-5", messages: [{ role: "user", content: "hola" }] };
    expect(conMuestreoPareado(base).temperature).toBeUndefined();
    expect(conMuestreoPareado({ ...base, model: "openai/gpt-4o-mini" })).toMatchObject(MUESTREO_PAREADO);
  });
});

describe("el margen de razonamiento: el mismo en todos los brazos, y solo donde se razona", () => {
  const conTope = (model: string, tope?: number): SavingsRequest => ({
    model,
    messages: [{ role: "user", content: "hola" }],
    ...(tope != null ? { response: { contractId: "c", schema: { type: "object" }, maxOutputTokens: tope } } : {}),
  });

  it("suma al tope en modelos que razonan (gpt-6 incluido, aunque aún no tenga fila)", () => {
    expect(razonaParaElBanco("openai/gpt-6-luna")).toBe(true);
    expect(conMargenDeRazonamiento(conTope("openai/gpt-6-luna", 232), "openai/gpt-6-luna", 400).response?.maxOutputTokens).toBe(632);
    expect(conMargenDeRazonamiento(conTope("anthropic/claude-sonnet-5", 220), "anthropic/claude-sonnet-5", 100.9).response?.maxOutputTokens).toBe(320);
  });

  it("no toca nada sin margen, sin tope o en un modelo que no razona", () => {
    const r = conTope("openai/gpt-6-luna", 232);
    expect(conMargenDeRazonamiento(r, "openai/gpt-6-luna", 0)).toBe(r);
    const sinTope = conTope("openai/gpt-6-luna");
    expect(conMargenDeRazonamiento(sinTope, "openai/gpt-6-luna", 400)).toBe(sinTope);
    const mini = conTope("openai/gpt-4o-mini", 232);
    expect(razonaParaElBanco("openai/gpt-4o-mini")).toBe(false);
    expect(conMargenDeRazonamiento(mini, "openai/gpt-4o-mini", 400)).toBe(mini);
  });
});
