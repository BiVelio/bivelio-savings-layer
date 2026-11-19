import { describe, it, expect } from "vitest";

import { CATALOGO, PRECIOS_AL_DIA, precioDeLista, precioDeListaPropio } from "../src/pricing/catalogo.js";
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
  // Los proveedores chinos no tienen tabla de tiers (TARIFAS_DE_TIER vacía):
  // la fuente no se usa, pero el Record tiene que cerrar.
  deepseek: "https://api-docs.deepseek.com/quick_start/pricing",
  qwen: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
  glm: "https://docs.bigmodel.cn/cn/guide/start/pricing",
};

// El día del catálogo, no el de hoy: las filas de CATALOGO son las que rigen ese
// día, y con el reloj real esta verja se ponía roja SOLA el día en que una fila
// cambiaba de tramo o caducaba (A2-22).
const AL_DIA = Date.parse(`${PRECIOS_AL_DIA}T12:00:00Z`);

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
      expect(precioDeListaPropio(f.modelo, AL_DIA)).toBe(CATALOGO[f.modelo]);
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
    // gpt-5.3 no tiene fila propia (sí gpt-5.3-codex): la versión menor no
    // hereda la de gpt-5. (Aquí estaba gpt-5.1, que desde el 2026-11-19 tiene
    // fila propia en CATALOGO y por eso también en Flex y Batch, A2-5.)
    expect(tarifaDeTier("openai", "flex", "gpt-5.3")).toBeUndefined();
    expect(tarifaDeTier("openai", "flex", "gpt-5.1")).toBe(TARIFAS_DE_TIER.openai.flex!["gpt-5.1"]);
    // gpt-6.2 no tiene fila Flex publicada: solo de lote.
    expect(tarifaDeTier("openai", "flex", "gpt-6.2-sol")).toBeUndefined();
    expect(tarifaDeTier("openai", "batch", "gpt-6.2-sol")).toBe(TARIFAS_DE_TIER.openai.batch!["gpt-6.2-sol"]);
    expect(tarifaDeTier("google", "flex", "gemini-3.8-flash-lite")).toBeUndefined();
    expect(tarifaDeTier("google", "flex", "gemini-2.5-flash-image")).toBeUndefined();
    // gemini-2.5-flash-lite entró con fila propia (N5, 2026-11-19): la suya, no
    // la de gemini-2.5-flash.
    expect(tarifaDeTier("google", "flex", "gemini-2.5-flash-lite")).toBe(TARIFAS_DE_TIER.google.flex!["gemini-2.5-flash-lite"]);
    expect(tarifaDeTier("google", "flex", "gemini-2.5-flash-lite")).not.toBe(TARIFAS_DE_TIER.google.flex!["gemini-2.5-flash"]);
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

  it("las filas de A2-5 (2026-11-19): Flex y Batch a la mitad exacta de la estándar en cada componente, como dicen las tablas oficiales", () => {
    // OpenAI: «Flex pricing data» y «Batch pricing data»; gpt-6.2 solo en Batch.
    // Google: pestaña «Flex» de cada Gemini 4, caché incluida.
    const casos: [OrigenDeTarifa, "flex" | "batch", string][] = [
      ["openai", "flex", "gpt-5.1"],
      ["openai", "batch", "gpt-5.1"],
      ["openai", "flex", "gpt-6.1-sol"],
      ["openai", "batch", "gpt-6.1-sol"],
      ["openai", "flex", "gpt-6.1-terra"],
      ["openai", "batch", "gpt-6.1-terra"],
      ["openai", "batch", "gpt-6.2-sol"],
      ["openai", "batch", "gpt-6.2-astra"],
      ["google", "flex", "gemini-4-carbon"],
      ["google", "flex", "gemini-4-argon"],
      ["google", "flex", "gemini-4-neon"],
      ["google", "flex", "gemini-4-hydrogen"],
    ];
    for (const [origen, tier, m] of casos) {
      const f = TARIFAS_DE_TIER[origen][tier]![m]!;
      const s = CATALOGO[m]!;
      const ctx = `${origen}/${tier}/${m}`;
      expect(f.consultado, ctx).toBe("2026-11-19");
      expect(f.inputPer1k, ctx).toBeCloseTo(s.inputPer1k / 2, 12);
      expect(f.outputPer1k, ctx).toBeCloseTo(s.outputPer1k / 2, 12);
      expect(f.cachedInputPer1k, ctx).toBeCloseTo(s.cachedInputPer1k! / 2, 12);
      // Escritura: 1,25× la entrada del tier en gpt-6.x; gpt-5.1 y Gemini no la publican.
      if (m.startsWith("gpt-6")) expect(f.cacheWritePer1k, ctx).toBeCloseTo(f.inputPer1k * 1.25, 12);
      else expect(f.cacheWritePer1k, ctx).toBeUndefined();
    }
    // Carbon y Argon doblan el 1-dic: su fila Flex, que es la de hoy, caduca el 30-nov.
    for (const m of ["gemini-4-carbon", "gemini-4-argon"]) {
      expect(TARIFAS_DE_TIER.google.flex![m]!.vigenteHasta, m).toBe("2026-11-30");
      expect(tarifaDeTier("google", "flex", m, Date.parse("2026-11-30T23:00:00Z")), m).toBeDefined();
      expect(tarifaDeTier("google", "flex", m, Date.parse("2026-12-01T00:00:01Z")), m).toBeUndefined();
    }
  });

  it("gpt-5.6-sol: el precio promocional rige hasta el 30-11-2026 incluido, en estándar, Flex y Batch (A2-22)", () => {
    // https://developers.openai.com/api/docs/pricing, releída el 2026-11-19:
    // «GPT-5.6 Sol's promotional pricing is available until November 30, 2026».
    // Antes caducaba el 2026-11-21 y el 22 (el día del lanzamiento) la propiedad
    // de lotes se ponía roja sola.
    const ultimo = Date.parse("2026-11-30T23:00:00Z");
    const siguiente = Date.parse("2026-12-01T00:00:01Z");
    for (const tier of ["flex", "batch"] as const) {
      const fila = TARIFAS_DE_TIER.openai[tier]!["gpt-5.6-sol"]!;
      expect(fila.vigenteHasta, tier).toBe("2026-11-30");
      expect(tarifaDeTier("openai", tier, "gpt-5.6-sol", Date.parse("2026-11-22T12:00:00Z")), tier).toBe(fila);
      expect(tarifaDeTier("openai", tier, "gpt-5.6-sol", ultimo), tier).toBe(fila);
      expect(tarifaDeTier("openai", tier, "gpt-5.6-sol", siguiente), tier).toBeUndefined();
    }
    // Y la fila estándar acaba a la vez: sin precio anunciado detrás, cae al
    // respaldo ilustrativo, que avisa, en vez de seguir con el promocional.
    expect(precioDeLista("gpt-5.6-sol", ultimo)).toBe(CATALOGO["gpt-5.6-sol"]);
    expect(precioDeLista("gpt-5.6-sol", siguiente)).toBeUndefined();
  });

  it("una fila con `vigenteHasta` deja de existir al día siguiente", () => {
    const fila = TARIFAS_DE_TIER.google.flex!["gemini-3.7-flash"]!;
    expect(fila.vigenteHasta).toBe("2026-12-31");
    expect(tarifaDeTier("google", "flex", "gemini-3.7-flash", Date.parse("2026-12-31T23:00:00Z"))).toBe(fila);
    expect(tarifaDeTier("google", "flex", "gemini-3.7-flash", Date.parse("2027-01-01T00:00:01Z"))).toBeUndefined();
  });
});
