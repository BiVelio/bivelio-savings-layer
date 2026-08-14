import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import {
  tramoDeCache,
  politicaDeCompresion,
} from "../src/economics/politica-compresion.js";
import {
  ANTHROPIC_CACHE_TIER,
  OPENAI_CACHE_TIER,
  NO_CACHE_TIER,
  UNKNOWN_PROVIDER_CACHE_TIER,
} from "../src/economics/cache-tier.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest, TraceEvent } from "../src/contracts/types.js";

/**
 * LA COMPRESIÓN SE COBRABA EN TOKENS Y SE PAGABA EN DINERO.
 *
 * El pipeline comprimía todos los mensajes no-system en cuanto la palanca estaba
 * encendida. Las dos verjas que existían para impedirlo —`shouldCompress()` y
 * `decidirCompresion()`— estaban escritas, probadas y sin un solo llamante,
 * mientras el README prometía "context reduction that must pay for itself".
 *
 * El caso medido (cabecera de `economics/cache-tier.ts`): el payload naive de
 * 1212 tokens ENTRA en el tramo cacheable de 1024 y el nuestro, comprimido a
 * 780, NO. Se quitó el 35,6% de los tokens y se capturó el 18,5% del dinero, y
 * el libro 3 acreditaba el 35,6%. Estos tests fijan que eso ya no puede pasar.
 */

class ProveedorEspia implements Provider {
  readonly id = "espia";
  ultima: ProviderRequest | null = null;
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.ultima = r;
    return { text: "ok", usage: { inputTokens: 100, outputTokens: 10 } };
  }
  /** El prompt tal y como salió, para comprobar si la compresión se aplicó. */
  enviado(): string {
    return (this.ultima?.messages ?? []).map((m) => m.content).join("\n");
  }
}

/**
 * Compresor de mentira que quita las palabras "RUIDO" y CUENTA sus llamadas.
 * El contador es la mitad del valor: distingue "no se comprimió" de "ni siquiera
 * se pagó el compresor", que son dos decisiones distintas de la capa.
 */
function compresorContador() {
  const estado = { llamadas: 0 };
  return {
    estado,
    compresor: {
      async compress({ text }: { text: string }) {
        estado.llamadas += 1;
        const podado = text.split(/\s+/).filter((p) => p !== "RUIDO").join(" ");
        return {
          compressed: podado,
          skipped: false,
          fidelityPassed: true,
          originalTokens: text.length,
          compressedTokens: podado.length,
          protectedSpans: 0,
          reason: "poda de prueba",
        };
      },
    },
  };
}

/** ~2 tokens por palabra con el estimador heurístico del repo. */
const repetir = (palabra: string, veces: number): string =>
  Array.from({ length: veces }, () => palabra).join(" ");

const contexto = (ruido: number, relleno: number): string =>
  `${repetir("RUIDO", ruido)} ${repetir("texto", relleno)}`;

const peticion = (model: string, contenido: string): SavingsRequest => ({
  model,
  messages: [{ role: "user", content: contenido }],
  savings: { compression: true, exactCache: false },
});

const trazaDeCompresion = (trazas: TraceEvent[]): TraceEvent => {
  const t = trazas.find((e) => e.stage === "compression");
  expect(t, "la etapa de compresión tiene que dejar rastro").toBeDefined();
  return t!;
};

describe("verja 1: un contexto corto no llega ni a pagar el compresor", () => {
  it("no se llama al compresor, no se acredita nada y la traza dice por qué", async () => {
    const { estado, compresor } = compresorContador();
    const proveedor = new ProveedorEspia();
    const capa = createSavingsLayer({ provider: proveedor, compressor: compresor });

    const texto = contexto(20, 30); // ~100 tokens: muy por debajo de los 2000
    const res = await capa.generate(peticion("openai/gpt-4o-mini", texto));

    // Comprimir cuesta latencia y cómputo local: en un contexto corto no se paga
    // ni para averiguar cuánto habría quitado.
    expect(estado.llamadas).toBe(0);
    expect(proveedor.enviado()).toContain("RUIDO");
    expect(res.report.tokens.compressedInput).toBe(0);

    const traza = trazaDeCompresion(res.report.traces);
    expect(traza.outcome).toBe("skipped");
    expect(String(traza.detail?.reason)).toMatch(/context \d+ < 2000 min/);
  });
});

describe("verja 3: comprimir no puede sacar el prompt del tramo cacheable", () => {
  // 700 RUIDO (~1400 tokens) + 350 de relleno (~700): el prompt entero pasa de
  // largo el mínimo de 1024, y comprimido cae por debajo. Es el caso medido.
  const texto = contexto(700, 350);

  it("la compresión se calcula, se mide y se DESCARTA: el prompt sale entero", async () => {
    const { estado, compresor } = compresorContador();
    const proveedor = new ProveedorEspia();
    const capa = createSavingsLayer({ provider: proveedor, compressor: compresor });

    const res = await capa.generate(peticion("openai/gpt-4o-mini", texto));

    // El compresor SÍ corrió: lo que bloquea aquí es el dinero, no el tamaño.
    expect(estado.llamadas).toBeGreaterThan(0);
    expect(proveedor.enviado()).toContain("RUIDO");
    expect(res.report.tokens.compressedInput).toBe(0);
    expect(res.report.compression?.originalTokens).toBe(0);

    const traza = trazaDeCompresion(res.report.traces);
    expect(traza.outcome).toBe("skipped");
    expect(String(traza.detail?.reason)).toMatch(/tramo cacheable/);
    expect(String(traza.detail?.reason)).toContain("1024");
  });

  it("el MISMO caso sí se comprime si el cliente declara que su prefijo no está caliente", async () => {
    // Idéntico al anterior salvo por el dato que solo el cliente puede medir. Si
    // su tráfico nunca reutiliza prefijo, no hay caché que romper y el ahorro es
    // real: la capa no le apaga la palanca por precaución cuando él ya midió.
    const { compresor } = compresorContador();
    const proveedor = new ProveedorEspia();
    const capa = createSavingsLayer({
      provider: proveedor,
      compressor: compresor,
      compressionEconomics: { prefix: { stableTokens: 0, hitRate: 0 } },
    });

    const res = await capa.generate(peticion("openai/gpt-4o-mini", texto));

    expect(proveedor.enviado()).not.toContain("RUIDO");
    expect(res.report.tokens.compressedInput).toBeGreaterThan(0);
    expect(trazaDeCompresion(res.report.traces).outcome).toBe("applied");
  });

  it("y con un modelo que no reconocemos tampoco: el defecto no puede inventar ahorro", async () => {
    // Un proveedor desconocido PODRÍA cachear. Suponer que no —y comprimir— es
    // la suposición que acredita tokens y resta dinero, así que el defecto se
    // abstiene igual que con OpenAI.
    const { compresor } = compresorContador();
    const proveedor = new ProveedorEspia();
    const capa = createSavingsLayer({ provider: proveedor, compressor: compresor });

    const res = await capa.generate(peticion("un-modelo-de-la-casa", texto));

    expect(proveedor.enviado()).toContain("RUIDO");
    expect(res.report.tokens.compressedInput).toBe(0);
    expect(String(trazaDeCompresion(res.report.traces).detail?.reason)).toMatch(
      /tramo cacheable/,
    );
  });

  it("con el prefijo CALIENTE de Anthropic comprimir pierde aunque no se salga del tramo", async () => {
    // 3000 tokens de prefijo estable leídos a 0,1x salen a 1300 equivalentes;
    // comprimido, el prompt son 3000 tokens a precio lleno. Quitar tokens aquí
    // MULTIPLICA la factura, y el cliente de alto volumen con prefijo estable es
    // justo el que más paga.
    const { compresor } = compresorContador();
    const proveedor = new ProveedorEspia();
    const capa = createSavingsLayer({
      provider: proveedor,
      compressor: compresor,
      compressionEconomics: { prefix: { stableTokens: 3000, hitRate: 1 } },
    });

    const res = await capa.generate(
      peticion("anthropic/claude-sonnet-4", contexto(500, 1500)),
    );

    expect(proveedor.enviado()).toContain("RUIDO");
    expect(res.report.tokens.compressedInput).toBe(0);
    expect(String(trazaDeCompresion(res.report.traces).detail?.reason)).toMatch(
      /sin comprimir sale más barato/,
    );
  });
});

describe("verja 2: el ahorro neto se comprueba con lo que se quitó de VERDAD", () => {
  it("una reducción por debajo del mínimo no se aplica ni se acredita", async () => {
    const { estado, compresor } = compresorContador();
    const proveedor = new ProveedorEspia();
    const capa = createSavingsLayer({ provider: proveedor, compressor: compresor });

    // Contexto largo (pasa la verja 1) del que solo hay ~80 tokens que quitar.
    const res = await capa.generate(
      peticion("openai/gpt-4o-mini", contexto(40, 1200)),
    );

    expect(estado.llamadas).toBeGreaterThan(0);
    expect(res.report.tokens.compressedInput).toBe(0);
    expect(String(trazaDeCompresion(res.report.traces).detail?.reason)).toMatch(
      /net saving \d+ < 200 min/,
    );
  });
});

describe("cuando sale a cuenta, se comprime — las verjas no apagan la palanca", () => {
  it("contexto largo, reducción grande y sin tocar el tramo: se aplica y se acredita", async () => {
    const { compresor } = compresorContador();
    const proveedor = new ProveedorEspia();
    const capa = createSavingsLayer({ provider: proveedor, compressor: compresor });

    // 700 RUIDO fuera y ~1800 tokens de relleno dentro: el prompt comprimido
    // sigue muy por encima de 1024, así que no hay caché que romper.
    const res = await capa.generate(
      peticion("openai/gpt-4o-mini", contexto(700, 900)),
    );

    expect(proveedor.enviado()).not.toContain("RUIDO");
    expect(res.report.tokens.compressedInput).toBeGreaterThan(0);
    expect(res.report.compression?.originalTokens).toBeGreaterThan(0);
    const traza = trazaDeCompresion(res.report.traces);
    expect(traza.outcome).toBe("applied");
    expect(String(traza.detail?.reason)).toMatch(/compensa/);
  });
});

describe("qué tramo de caché se le supone a cada modelo", () => {
  it("las dos familias conocidas salen del prefijo o del nombre", () => {
    expect(tramoDeCache("openai/gpt-4o-mini")).toBe(OPENAI_CACHE_TIER);
    expect(tramoDeCache("gpt-4.1-mini")).toBe(OPENAI_CACHE_TIER);
    expect(tramoDeCache("anthropic/claude-sonnet-4")).toBe(ANTHROPIC_CACHE_TIER);
    expect(tramoDeCache("claude-3-5-haiku")).toBe(ANTHROPIC_CACHE_TIER);
  });

  it("lo desconocido no reclama descuento pero tampoco se deja romper la caché", () => {
    // El defecto tiene que ser el que NO invente ahorro: multiplicadores a 1
    // (ningún descuento que no se pueda verificar) y mínimo puesto (la
    // compresión no puede sacar el prompt del tramo).
    const t = tramoDeCache("un-modelo-de-la-casa");
    expect(t).toBe(UNKNOWN_PROVIDER_CACHE_TIER);
    expect(t.cacheReadMultiplier).toBe(1);
    expect(t.cacheWriteMultiplier).toBe(1);
    expect(t.minimumCacheTokens).toBe(1024);
  });

  it("el tramo declarado por el cliente gana: ahí es donde se corrige el mínimo supuesto", () => {
    // El 1024 es una suposición y los mínimos reales difieren por modelo. Quien
    // sepa el suyo lo pone aquí.
    const mio = { ...OPENAI_CACHE_TIER, minimumCacheTokens: 2048 };
    expect(tramoDeCache("openai/gpt-4o-mini", { cacheTier: mio })).toBe(mio);
  });
});

describe("la política, sin pipeline por medio", () => {
  const cruzando = { originalTokens: 1212, compressedTokens: 780, tier: OPENAI_CACHE_TIER };

  it("sin medición, cruzar el tramo se bloquea y se dice cómo desbloquearlo", () => {
    const d = politicaDeCompresion(cruzando);
    expect(d.comprimir).toBe(false);
    expect(d.razon).toMatch(/compressionEconomics\.prefix/);
  });

  it("con medición manda la cuenta completa, incluso para perder la caché a sabiendas", () => {
    // Aciertos al 100% sobre 512 tokens de prefijo: en OpenAI (lectura a 0,5x)
    // comprimir sigue ganando, y la capa no se interpone.
    const d = politicaDeCompresion({
      ...cruzando,
      prefix: { stableTokens: 512, hitRate: 1 },
    });
    expect(d.comprimir).toBe(true);
    expect(d.razon).toMatch(/pese a perder la caché/);
  });

  it("sin tramo de caché no hay nada que proteger: decide el recuento de tokens", () => {
    const d = politicaDeCompresion({ ...cruzando, tier: NO_CACHE_TIER });
    expect(d.comprimir).toBe(true);
    expect(d.ganancia).toBeCloseTo(1212 - 780, 6);
  });

  it("un compresor caro anula su propio ahorro aunque no toque ninguna caché", () => {
    const d = politicaDeCompresion({
      originalTokens: 8000,
      compressedTokens: 5000,
      tier: OPENAI_CACHE_TIER,
      compressorCostTokens: 4000,
    });
    expect(d.comprimir).toBe(false);
  });
});
