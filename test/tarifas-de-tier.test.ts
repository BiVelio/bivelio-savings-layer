import { describe, it, expect } from "vitest";

import { CATALOGO, precioDeListaPropio } from "../src/pricing/catalogo.js";
import {
  TARIFAS_DE_TIER,
  TARIFAS_DE_TIER_AL_DIA,
  tarifaDeTier,
  type OrigenDeTarifa,
} from "../src/pricing/tarifas-de-tier.js";

/**
 * LA TABLA DE TARIFAS POR TIER: QUE NINGUNA FILA PUEDA ESTAR SIN FUENTE, SIN
 * FECHA O SIN CONTRA QUÉ RESTAR.
 *
 * El ahorro de un tier es una resta entre la fila estándar (CATALOGO) y la del
 * tier servido. Una fila de tier sin fila estándar propia no tiene contra qué
 * restar, y una sin página oficial o sin fecha es una cifra sin fuente: las dos
 * cosas que este producto no publica.
 */

const FUENTES: Record<OrigenDeTarifa, string> = {
  openai: "https://developers.openai.com/api/docs/pricing",
  google: "https://ai.google.dev/gemini-api/docs/pricing",
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
};

const filas = Object.entries(TARIFAS_DE_TIER).flatMap(([origen, porTier]) =>
  Object.entries(porTier).flatMap(([tier, porModelo]) =>
    Object.entries(porModelo).map(([modelo, fila]) => ({
      origen: origen as OrigenDeTarifa,
      tier,
      modelo,
      fila,
    })),
  ),
);

describe("la tabla de tarifas por tier", () => {
  it("no está vacía (si lo estuviera, este test no protegería nada)", () => {
    expect(filas.length).toBeGreaterThan(10);
  });

  it.each(filas.map((f) => [`${f.origen}/${f.tier}/${f.modelo}`, f] as const))(
    "%s tiene fila estándar PROPIA en CATALOGO",
    (_n, f) => {
      expect(CATALOGO[f.modelo], `${f.modelo} no está en CATALOGO`).toBeDefined();
      expect(precioDeListaPropio(f.modelo)).toBe(CATALOGO[f.modelo]);
    },
  );

  it.each(filas.map((f) => [`${f.origen}/${f.tier}/${f.modelo}`, f] as const))(
    "%s cita la página oficial de su proveedor y una fecha válida",
    (_n, f) => {
      expect(f.fila.fuente).toBe(FUENTES[f.origen]);
      expect(f.fila.consultado).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(f.fila.consultado))).toBe(false);
      expect(f.fila.consultado <= TARIFAS_DE_TIER_AL_DIA).toBe(true);
      if (f.fila.vigenteHasta) {
        expect(f.fila.vigenteHasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(f.fila.vigenteHasta >= f.fila.consultado).toBe(true);
      }
    },
  );

  it("cada fila se busca con la MISMA regla que la referencia: un pariente no hereda", () => {
    // Sufijo de letra, versión menor y vendor: solo la fila propia o su
    // instantánea con fecha.
    expect(tarifaDeTier("openai", "flex", "gpt-5-mini")).toBeDefined();
    expect(tarifaDeTier("openai", "flex", "openai/gpt-5-mini")).toBeDefined();
    expect(tarifaDeTier("openai", "flex", "gpt-5-mini-2025-08-07")).toBeDefined();
    expect(tarifaDeTier("openai", "flex", "gpt-5-mini-latest")).toBeUndefined();
    expect(tarifaDeTier("openai", "flex", "gpt-5.1")).toBeUndefined();
    expect(tarifaDeTier("google", "flex", "gemini-2.5-flash-lite")).toBeUndefined();
    // El origen es parte de la clave: un modelo de Google no tiene fila en OpenAI.
    expect(tarifaDeTier("openai", "flex", "gemini-2.5-pro")).toBeUndefined();
  });

  it("Anthropic: toda fila de lote es EXACTAMENTE la mitad de la estándar, en los cuatro componentes", () => {
    // «All usage is charged at 50% of the standard API prices» (guía de batch
    // processing) y «These multipliers stack with … the Batch API discount»
    // (página de precios): la lectura y la escritura de caché en lote no tienen
    // columna propia y salen de esas dos frases. Si alguien teclea una fila que
    // no es la mitad, esto lo caza.
    const filasDeLote = Object.entries(TARIFAS_DE_TIER.anthropic.batch!);
    expect(filasDeLote.length).toBeGreaterThan(10);
    for (const [modelo, f] of filasDeLote) {
      const s = CATALOGO[modelo]!;
      const mitad = (x: number) => x / 2;
      expect(f.inputPer1k, modelo).toBeCloseTo(mitad(s.inputPer1k), 12);
      expect(f.outputPer1k, modelo).toBeCloseTo(mitad(s.outputPer1k), 12);
      expect(f.cachedInputPer1k, modelo).toBeCloseTo(mitad(s.cachedInputPer1k!), 12);
      expect(f.cacheWritePer1k, modelo).toBeCloseTo(mitad(s.inputPer1k * 1.25), 12);
    }
  });

  it("una fila con `vigenteHasta` deja de existir al día siguiente", () => {
    const fila = TARIFAS_DE_TIER.google.flex!["gemini-3.7-flash"]!;
    expect(fila.vigenteHasta).toBe("2026-12-31");
    expect(tarifaDeTier("google", "flex", "gemini-3.7-flash", Date.parse("2026-12-31T23:00:00Z"))).toBe(fila);
    expect(tarifaDeTier("google", "flex", "gemini-3.7-flash", Date.parse("2027-01-01T00:00:01Z"))).toBeUndefined();
  });
});
