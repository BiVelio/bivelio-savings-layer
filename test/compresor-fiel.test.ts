import { describe, it, expect } from "vitest";

import { compresorFiel, withProtectedSpans, type Compressor } from "../src/compression/compression.js";

/**
 * La comprobación de fidelidad de la compresión ya no es vacua.
 *
 * El pipeline llamaba a compress() sin protectedSpans, y withProtectedSpans con
 * lista vacía devuelve fidelityPassed:true INCONDICIONAL: el único filtro era
 * «¿es más corto?». Reproducido con el propio código: «Refunds are not allowed»
 * salía como «Refunds are allowed» y se certificaba fiel. `compresorFiel`
 * verifica el resultado (números/fechas y paridad de negación) y descarta la
 * reescritura que cambió un dato crítico — pase lo que pase el compresor.
 */

/** Un compresor que se come la palabra «not» (el fallo exacto de la auditoría). */
const comeNegaciones: Compressor = {
  async compress({ text }) {
    const out = text.replace(/\bnot\b ?/g, "");
    return { compressed: out, originalTokens: text.length, compressedTokens: out.length, protectedSpans: 0, fidelityPassed: true, skipped: false, reason: "quita not" };
  },
};

/** Un compresor honesto que solo quita relleno inocuo. */
const quitaRelleno: Compressor = {
  async compress({ text }) {
    const out = text.replace(/\b(please|kindly|really)\b ?/gi, "").replace(/\s+/g, " ").trim();
    return { compressed: out, originalTokens: text.length, compressedTokens: out.length, protectedSpans: 0, fidelityPassed: true, skipped: false, reason: "quita relleno" };
  },
};

describe("compresorFiel", () => {
  it("descarta la reescritura que invierte una negación y devuelve el original", async () => {
    const r = await compresorFiel(comeNegaciones).compress({ text: "Refunds are not allowed after 30 days." });
    expect(r.compressed).toBe("Refunds are not allowed after 30 days.");
    expect(r.skipped).toBe(true);
    expect(r.fidelityPassed).toBe(false);
  });

  it("con el compresor VACÍO de spans, withProtectedSpans mentía; compresorFiel lo caza", async () => {
    // Reproduce el camino real: withProtectedSpans + sin spans devolvía true.
    const envueltoMentiroso = withProtectedSpans(comeNegaciones);
    const sinFidelidad = await envueltoMentiroso.compress({ text: "You must not charge twice." });
    expect(sinFidelidad.fidelityPassed).toBe(true); // el bug: certifica sin verificar
    expect(sinFidelidad.compressed).toBe("You must charge twice."); // sentido invertido
    // Con compresorFiel encima, se caza.
    const conFidelidad = await compresorFiel(envueltoMentiroso).compress({ text: "You must not charge twice." });
    expect(conFidelidad.skipped).toBe(true);
    expect(conFidelidad.compressed).toBe("You must not charge twice.");
  });

  it("una compresión honesta (solo relleno) SÍ pasa", async () => {
    const r = await compresorFiel(quitaRelleno).compress({ text: "Please kindly summarize this report" });
    expect(r.skipped).toBe(false);
    expect(r.fidelityPassed).toBe(true);
    expect(r.compressed).toBe("summarize this report");
  });

  it("un cambio de número se descarta igual", async () => {
    const cambiaCifra: Compressor = {
      async compress({ text }) {
        const out = text.replace("118", "119");
        return { compressed: out, originalTokens: text.length, compressedTokens: out.length, protectedSpans: 0, fidelityPassed: true, skipped: false, reason: "x" };
      },
    };
    const r = await compresorFiel(cambiaCifra).compress({ text: "el total es 118 euros" });
    expect(r.skipped).toBe(true);
  });
});
