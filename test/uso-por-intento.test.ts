import { describe, it, expect } from "vitest";

import {
  ConflictoDeRecibo,
  LibroDeRecibos,
  idDeEvento,
  idDeIntento,
  normalizarUso,
  reciboDeIntento,
  tarifarIntento,
  type AttemptUsage,
} from "../src/metering/intento.js";
import { usoDeMensajes } from "../src/providers/anthropic-uso.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { PRECIOS_AL_DIA } from "../src/pricing/catalogo.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import { costeMedido, mapearUsoChat } from "../gateway/medidor.js";

/**
 * D02 · EL USO POR INTENTO.
 *
 * Las cifras esperadas están hechas a mano con el precio de lista, no leídas
 * del código: claude-sonnet-4-5 cobra 3 µ$ el token de entrada, 0,3 µ$ el leído
 * de caché, 3,75 µ$ el escrito a 5 min (1,25×), 6 µ$ a 1 h (2×) y 15 µ$ el de
 * salida. Un día fijo, para que un tramo de precio futuro no mueva el test.
 */

const DIA = Date.UTC(2026, 9, 1);

// El MISMO uso lógico: 1000 de entrada normal, 8000 leídos de caché, 2000
// escritos y 500 de salida. Cada dialecto lo cuenta a su manera.
const ANTHROPIC = { input_tokens: 1000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000, output_tokens: 500 };
const CHAT = { prompt_tokens: 11000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 8000, cache_write_tokens: 2000 } };
const RESPONSES = { input_tokens: 11000, output_tokens: 500, input_tokens_details: { cached_tokens: 8000, cache_write_tokens: 2000 } };
const NUMEROS = { inputUncached: 1000, cacheRead: 8000, cacheWrite5m: 2000, cacheWrite1h: 0, output: 500 };
// 1000×3 + 8000×0,3 + 2000×3,75 + 500×15
const COSTE_MICRO = 3000 + 2400 + 7500 + 7500;

const numeros = (u: AttemptUsage) => ({
  inputUncached: u.inputUncached,
  cacheRead: u.cacheRead,
  cacheWrite5m: u.cacheWrite5m,
  cacheWrite1h: u.cacheWrite1h,
  output: u.output,
});

describe("normalizar: el mismo uso lógico da los mismos números en cada dialecto", () => {
  it("Anthropic (input SIN caché) y OpenAI Chat/Responses (prompt CON caché) coinciden, sin contar la caché dos veces", () => {
    for (const u of [
      normalizarUso({ dialecto: "anthropic", uso: ANTHROPIC }),
      normalizarUso({ dialecto: "openai-chat", uso: CHAT }),
      normalizarUso({ dialecto: "openai-responses", uso: RESPONSES }),
    ]) {
      expect(numeros(u)).toEqual(NUMEROS);
      expect(u.completeness).toBe("complete");
      expect(u.missing).toBeUndefined();
      expect(u.basis).toBe("provider_reported");
    }
  });

  it("el ProviderUsage que fabrican los adaptadores reales del SDK da los mismos números", async () => {
    // Anthropic: el adaptador suma lectura y escritura a `inputTokens`.
    const deAnthropic = usoDeMensajes(ANTHROPIC, ANTHROPIC.output_tokens, false).usage;
    expect(deAnthropic.inputTokens).toBe(11000);
    expect(numeros(normalizarUso({ dialecto: "provider-usage", uso: deAnthropic }))).toEqual(NUMEROS);

    // OpenAI: el proveedor de verdad, con un fetch que devuelve ese usage.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "hola" }, finish_reason: "stop" }], usage: CHAT }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ baseUrl: "https://example.test/v1", fetchImpl });
    const r = await p.generate({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hola" }] });
    expect(numeros(normalizarUso({ dialecto: "provider-usage", uso: r.usage }))).toEqual(NUMEROS);
  });

  it("la forma UsoSse del gateway (lo que mapearUsoChat produce) se lee como Anthropic y cuadra", () => {
    const sse = mapearUsoChat(CHAT)!;
    expect(numeros(normalizarUso({ dialecto: "anthropic", uso: sse }))).toEqual(NUMEROS);
  });

  it("el desglose de 1 h sale aparte y nunca por encima del total escrito", () => {
    const u = normalizarUso({
      dialecto: "anthropic",
      uso: { ...ANTHROPIC, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1500 } },
    });
    expect([u.cacheWrite5m, u.cacheWrite1h]).toEqual([500, 1500]);
    const incoherente = normalizarUso({
      dialecto: "anthropic",
      uso: { ...ANTHROPIC, cache_creation: { ephemeral_1h_input_tokens: 9999 } },
    });
    expect([incoherente.cacheWrite5m, incoherente.cacheWrite1h]).toEqual([0, 2000]);
  });

  it("OpenAI con cached + writes > prompt se recorta: nunca aparece entrada que no se facturó", () => {
    const u = normalizarUso({
      dialecto: "openai-chat",
      uso: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 50 } },
    });
    expect(numeros(u)).toEqual({ inputUncached: 0, cacheRead: 90, cacheWrite5m: 10, cacheWrite1h: 0, output: 1 });
  });
});

describe("el razonamiento no se cuenta dos veces", () => {
  it("OpenAI: reasoning_tokens es un desglose de completion_tokens, y el precio es el de la salida sola", () => {
    const u = normalizarUso({
      dialecto: "openai-chat",
      uso: { prompt_tokens: 100, completion_tokens: 1000, completion_tokens_details: { reasoning_tokens: 600 } },
    });
    expect(u.output).toBe(1000);
    expect(u.reasoning).toBe(600);
    expect(u.reasoningIncludedInOutput).toBe(true);
    // o4-mini: 1,1 µ$ entrada y 4,4 µ$ salida → 100×1,1 + 1000×4,4. Sumando el
    // razonamiento encima serían 7150.
    const p = tarifarIntento("o4-mini", u, DIA);
    expect(p.state === "priced" && p.amountMicroUsd).toBe(4510);
  });

  it("Gemini por el endpoint compatible: el pensamiento solo está en total_tokens, entra UNA vez en la salida", () => {
    const u = normalizarUso({ dialecto: "openai-chat", uso: { prompt_tokens: 16, completion_tokens: 3, total_tokens: 211 } });
    expect(u.output).toBe(195);
    expect(u.reasoning).toBe(192);
  });

  it("Responses: output_tokens ya incluye el razonamiento", () => {
    const u = normalizarUso({
      dialecto: "openai-responses",
      uso: { input_tokens: 10, output_tokens: 300, output_tokens_details: { reasoning_tokens: 250 } },
    });
    expect([u.output, u.reasoning]).toEqual([300, 250]);
  });

  it("Anthropic no desglosa el razonamiento: ausente, no 0", () => {
    expect(normalizarUso({ dialecto: "anthropic", uso: ANTHROPIC }).reasoning).toBeUndefined();
  });
});

describe("tarifar en enteros con el catálogo versionado", () => {
  it("el coste a mano, entero en micro-USD, con la versión del catálogo y el día", () => {
    const p = tarifarIntento("claude-sonnet-4-5", normalizarUso({ dialecto: "anthropic", uso: ANTHROPIC }), DIA);
    expect(p).toEqual({
      state: "priced",
      amountMicroUsd: COSTE_MICRO,
      exactAttoUsd: `${COSTE_MICRO}000000000000`,
      currency: "USD",
      priceVersion: PRECIOS_AL_DIA,
      priceDay: "2026-10-01",
      catalogKey: "claude-sonnet-4-5",
    });
  });

  it("la escritura de 1 h a 2× y la de 5 min a 1,25×", () => {
    const u = normalizarUso({
      dialecto: "anthropic",
      uso: { ...ANTHROPIC, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 } },
    });
    const p = tarifarIntento("claude-sonnet-4-5", u, DIA);
    // 2000 a 6 µ$ en vez de a 3,75 µ$: 4500 más.
    expect(p.state === "priced" && p.amountMicroUsd).toBe(COSTE_MICRO + 4500);
  });

  it("cuadra con costeMedido del gateway (la fórmula en coma flotante que ya factura)", () => {
    const u = normalizarUso({ dialecto: "anthropic", uso: ANTHROPIC });
    const p = tarifarIntento("claude-sonnet-4-5", u, DIA);
    const gateway = costeMedido("claude-sonnet-4-5", ANTHROPIC, DIA)!;
    expect(p.state).toBe("priced");
    if (p.state === "priced") expect(Math.abs(p.amountMicroUsd - gateway.costeUsd * 1e6)).toBeLessThan(1e-6);
  });

  it("aritmética exacta: fracciones de micro-USD se suman exactas y se redondean UNA vez", () => {
    // gpt-4o-mini: 0,15 µ$ entrada, 0,6 µ$ salida. Un token de cada: 0,75 µ$.
    const u: AttemptUsage = {
      inputUncached: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 1,
      reasoningIncludedInOutput: true, basis: "provider_reported", completeness: "complete",
    };
    const p = tarifarIntento("gpt-4o-mini", u, DIA);
    expect(p).toMatchObject({ state: "priced", amountMicroUsd: 1, exactAttoUsd: "750000000000" });
    const libro = new LibroDeRecibos();
    for (const attempt of [0, 1, 2]) {
      libro.registrar(reciboDeIntento({ logicalCallId: "lc-exacto", attempt, kind: attempt ? "retry" : "primary", model: "gpt-4o-mini", at: DIA, usage: u }));
    }
    // 3 × 0,75 = 2,25 → 2. Sumar los redondeados daría 3.
    expect(libro.total("lc-exacto")!.amountMicroUsd).toBe(2);
  });

  it("cifras grandes siguen siendo enteros exactos", () => {
    const u: AttemptUsage = {
      inputUncached: 0, cacheRead: 199_999, cacheWrite5m: 0, cacheWrite1h: 0, output: 7_000_000,
      reasoningIncludedInOutput: true, basis: "provider_reported", completeness: "complete",
    };
    // claude-opus-4: 75 µ$ la salida, 1,5 µ$ el leído → 525 000 000 + 299 998,5.
    // (La entrada se queda bajo los 200K: por encima rige el tramo de contexto
    // largo, que el catálogo no modela, y el intento ya no sale `priced`.)
    const p = tarifarIntento("claude-opus-4", u, DIA);
    expect(p).toMatchObject({ state: "priced", amountMicroUsd: 525_299_999, exactAttoUsd: "525299998500000000000" });
  });

  it("modelo desconocido → unpriced, nunca coste 0 ni el precio ilustrativo", () => {
    const p = tarifarIntento("acme-llm-9", normalizarUso({ dialecto: "anthropic", uso: ANTHROPIC }), DIA);
    expect(p.state).toBe("unpriced");
    expect(p.state === "unpriced" && p.reason).toBe("no-catalog-price");
    expect(p).not.toHaveProperty("amountMicroUsd");
  });

  it("un id que solo hereda el precio de un pariente → uncertain, sin suelo", () => {
    const p = tarifarIntento("gpt-4o-mini-latest", normalizarUso({ dialecto: "openai-chat", uso: CHAT }), DIA);
    expect(p).toMatchObject({ state: "uncertain", reason: "inherited-price" });
    expect(p).not.toHaveProperty("lowerBoundMicroUsd");
  });

  it("una estimación o un conteo del cliente nunca salen priced", () => {
    for (const basis of ["estimated", "client_observed"] as const) {
      const p = tarifarIntento("claude-sonnet-4-5", normalizarUso({ dialecto: "anthropic", uso: ANTHROPIC }, { basis }), DIA);
      expect(p.state).toBe("uncertain");
      expect(p).not.toHaveProperty("lowerBoundMicroUsd");
    }
  });

  it("un uso «completo» con cero tokens de entrada no se da por bueno a 0", () => {
    const p = tarifarIntento(
      "claude-sonnet-4-5",
      normalizarUso({ dialecto: "provider-usage", uso: { inputTokens: 0, outputTokens: 0 } }),
      DIA,
    );
    expect(p).toMatchObject({ state: "uncertain", reason: "implausible-zero-input", lowerBoundMicroUsd: 0 });
  });
});

describe("un stream truncado o un uso relleno con ceros nunca da coste 0", () => {
  it("Anthropic cortado tras message_start: la salida es provisional → partial, uncertain con suelo de la entrada", () => {
    const u = normalizarUso({ dialecto: "anthropic", uso: { ...ANTHROPIC, output_tokens: 1 }, final: false });
    expect(u.completeness).toBe("partial");
    expect(u.missing).toEqual(["output"]);
    expect(u.output).toBe(0);
    const p = tarifarIntento("claude-sonnet-4-5", u, DIA);
    expect(p).toMatchObject({ state: "uncertain", reason: "usage-partial", lowerBoundMicroUsd: 3000 + 2400 + 7500 });
  });

  it("OpenAI sin el chunk final de usage → absent → unpriced", () => {
    const u = normalizarUso({ dialecto: "openai-chat", uso: undefined });
    expect(u.completeness).toBe("absent");
    expect(tarifarIntento("gpt-4o-mini", u, DIA)).toMatchObject({ state: "unpriced", reason: "usage-absent" });
  });

  it("ProviderUsage con complete:false y todo a 0 (el adaptador rellenó) → absent → unpriced", () => {
    const u = normalizarUso({ dialecto: "provider-usage", uso: { inputTokens: 0, outputTokens: 0, complete: false } });
    expect(u.completeness).toBe("absent");
    expect(tarifarIntento("gpt-4o-mini", u, DIA).state).toBe("unpriced");
  });

  it("ProviderUsage con complete:false y solo la entrada → partial, el suelo es la entrada", () => {
    const u = normalizarUso({
      dialecto: "provider-usage",
      uso: { inputTokens: 11000, cachedInputTokens: 8000, cacheWriteInputTokens: 2000, outputTokens: 0, complete: false },
    });
    expect([u.completeness, u.missing]).toEqual(["partial", ["output"]]);
    expect(tarifarIntento("claude-sonnet-4-5", u, DIA)).toMatchObject({ state: "uncertain", lowerBoundMicroUsd: 12900 });
  });

  it("un contador que no es un entero ≥ 0 no es un contador", () => {
    const u = normalizarUso({ dialecto: "openai-responses", uso: { input_tokens: 50, output_tokens: -3 } });
    expect([u.completeness, u.missing, u.output]).toEqual(["partial", ["output"], 0]);
  });
});

describe("ids y libro de recibos idempotente", () => {
  const usoA = normalizarUso({ dialecto: "anthropic", uso: ANTHROPIC });

  it("el eventId es determinista por intento y distinto entre intentos y llamadas", () => {
    expect(idDeEvento("lc-1", 0)).toBe(idDeEvento("lc-1", 0));
    expect(idDeEvento("lc-1", 0)).not.toBe(idDeEvento("lc-1", 1));
    expect(idDeEvento("lc-1", 0)).not.toBe(idDeEvento("lc-2", 0));
    expect(idDeEvento("lc-1", 0)).toMatch(/^ev_[0-9a-f]{32}$/);
    expect(idDeIntento("lc-1", 2)).toBe("lc-1:a2");
    expect(() => idDeEvento("con espacio", 0)).toThrow(TypeError);
    expect(() => idDeEvento("lc-1", -1)).toThrow(TypeError);
  });

  it("duplicar el evento no suma: mismo id y mismo cuerpo es un no-op", () => {
    const libro = new LibroDeRecibos();
    const r = reciboDeIntento({ logicalCallId: "lc-dup", attempt: 0, kind: "primary", model: "claude-sonnet-4-5", at: DIA, usage: usoA });
    expect(libro.registrar(r)).toBe("registrado");
    const antes = libro.total("lc-dup");
    // Un recibo reconstruido igual (otra instancia, claves en otro orden) es el mismo.
    const otraVez = reciboDeIntento({ usage: { ...usoA }, at: DIA, model: "claude-sonnet-4-5", kind: "primary", attempt: 0, logicalCallId: "lc-dup" });
    expect(libro.registrar(otraVez)).toBe("repetido");
    expect(libro.total("lc-dup")).toEqual(antes);
    expect(antes).toMatchObject({ attempts: 1, amountMicroUsd: COSTE_MICRO });
  });

  it("mismo eventId con otro cuerpo → conflicto explícito, y lo apuntado no cambia", () => {
    const libro = new LibroDeRecibos();
    libro.registrar(reciboDeIntento({ logicalCallId: "lc-c", attempt: 0, kind: "primary", model: "claude-sonnet-4-5", at: DIA, usage: usoA }));
    const distinto = reciboDeIntento({
      logicalCallId: "lc-c", attempt: 0, kind: "primary", model: "claude-sonnet-4-5", at: DIA,
      usage: { ...usoA, output: 501 },
    });
    expect(() => libro.registrar(distinto)).toThrow(ConflictoDeRecibo);
    expect(libro.total("lc-c")!.amountMicroUsd).toBe(COSTE_MICRO);
  });

  it("un eventId que no es el de su intento → conflicto (no hay segundo id para contar dos veces)", () => {
    const libro = new LibroDeRecibos();
    const r = reciboDeIntento({ logicalCallId: "lc-f", attempt: 0, kind: "primary", model: "claude-sonnet-4-5", at: DIA, usage: usoA });
    expect(() => libro.registrar({ ...r, eventId: "ev_otro" })).toThrow(ConflictoDeRecibo);
    expect(libro.total("lc-f")).toBeUndefined();
  });

  it("lo devuelto es una copia: tocarla no mueve el libro", () => {
    const libro = new LibroDeRecibos();
    const r = reciboDeIntento({ logicalCallId: "lc-copia", attempt: 0, kind: "primary", model: "claude-sonnet-4-5", at: DIA, usage: usoA });
    libro.registrar(r);
    r.usage.output = 99_999;
    libro.recibos("lc-copia")[0]!.usage.output = 99_999;
    expect(libro.total("lc-copia")!.tokens.output).toBe(500);
  });

  it("el brazo A reporta la tarea completa: primaria cortada + reintento + reparación, con los inciertos a la vista", () => {
    const libro = new LibroDeRecibos();
    const cortada = normalizarUso({ dialecto: "anthropic", uso: { ...ANTHROPIC, output_tokens: 1 }, final: false });
    const reparacion = normalizarUso({ dialecto: "anthropic", uso: { input_tokens: 200, output_tokens: 40 } });
    libro.registrar(reciboDeIntento({ logicalCallId: "lc-a", attempt: 0, kind: "primary", model: "claude-sonnet-4-5", at: DIA, usage: cortada }));
    libro.registrar(reciboDeIntento({ logicalCallId: "lc-a", attempt: 1, kind: "retry", model: "claude-sonnet-4-5", at: DIA, usage: usoA }));
    libro.registrar(reciboDeIntento({ logicalCallId: "lc-a", attempt: 2, kind: "repair", model: "claude-sonnet-4-5", at: DIA, usage: reparacion }));
    const t = libro.total("lc-a")!;
    expect(t).toMatchObject({
      attempts: 3,
      byKind: { primary: 1, retry: 1, repair: 1 },
      priced: 2,
      uncertain: 1,
      unpriced: 0,
      state: "partial",
      incompleteAttempts: 1,
      priceVersions: [PRECIOS_AL_DIA],
    });
    // Sin coste total que publicar: uno de los tres no tiene precio cierto.
    expect(t.amountMicroUsd).toBeUndefined();
    // Suelo: la cortada (12 900) + el reintento (20 400) + la reparación (200×3 + 40×15 = 1200).
    expect(t.lowerBoundMicroUsd).toBe(12900 + COSTE_MICRO + 1200);
    expect(t.tokens).toEqual({ inputUncached: 2200, cacheRead: 16000, cacheWrite5m: 4000, cacheWrite1h: 0, output: 540 });
  });

  it("un total de solo intentos sin precio es unpriced, con suelo 0 y sin importe", () => {
    const libro = new LibroDeRecibos();
    libro.registrar(reciboDeIntento({ logicalCallId: "lc-u", attempt: 0, kind: "primary", model: "acme-llm-9", at: DIA, usage: usoA }));
    expect(libro.total("lc-u")).toMatchObject({ state: "unpriced", unpriced: 1, lowerBoundMicroUsd: 0 });
    expect(libro.total("lc-u")!.amountMicroUsd).toBeUndefined();
  });
});

// ── El hallazgo del inventario: `cost.actual` de una llamada sin contador ────

class ProveedorGuion implements Provider {
  readonly id = "guion";
  constructor(private readonly respuesta: ProviderResponse) {}
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    return this.respuesta;
  }
}

async function informe(usage: ProviderResponse["usage"]) {
  const layer = createSavingsLayer({ provider: new ProveedorGuion({ text: "hola", usage }), devUnlicensed: true });
  const r = await layer.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "di hola" }] });
  return r.report;
}

describe("SavingsReport: un `actual` sobre contadores rellenos con 0 se declara suelo", () => {
  it("sin ningún contador, `actual` es 0 y el informe lo dice: no es el gasto, es un suelo", async () => {
    const r = await informe({ inputTokens: 0, outputTokens: 0, complete: false });
    expect(r.cost.basis).toBe("unmeasured");
    expect(r.cost.actual).toBe(0);
    expect(r.cost.actualIsLowerBound).toBe(true);
  });

  it("con solo la entrada, `actual` tarifa la entrada (la salida falta) y también es suelo", async () => {
    const r = await informe({ inputTokens: 1000, outputTokens: 0, complete: false });
    // 1000 × 0,15 µ$: la salida que el proveedor sí cobró no está.
    expect(r.cost.actual).toBeCloseTo(0.00015, 12);
    expect(r.cost.actualIsLowerBound).toBe(true);
  });

  it("con el contador completo no cambia nada: la clave ni aparece", async () => {
    const r = await informe({ inputTokens: 1000, outputTokens: 10 });
    expect(r.cost.basis).toBe("measured");
    expect(r.cost).not.toHaveProperty("actualIsLowerBound");
  });
});

// ── Revisión adversaria (D02): los defectos que la primera versión dejaba pasar ──

describe("revisión: lo que no es un contador entero no llega a la tarifa", () => {
  it("una iteración de compactación con un contador fraccionario no tumba la tarifa: unpriced, no RangeError", () => {
    const u = normalizarUso({
      dialecto: "anthropic",
      uso: { input_tokens: 10, output_tokens: 5, iterations: [{ type: "compaction", input_tokens: 1.5, output_tokens: 2 }] },
    });
    const p = tarifarIntento("claude-sonnet-4-5", u, DIA);
    expect(p).toMatchObject({ state: "unpriced", reason: "usage-invalid" });
  });

  it("un contador por encima de Number.MAX_SAFE_INTEGER no es un contador: el importe no puede perder precisión", () => {
    const u = normalizarUso({ dialecto: "openai-chat", uso: { prompt_tokens: 2 ** 60, completion_tokens: 1 } });
    expect(u.missing).toContain("input");
    const p = tarifarIntento("gpt-4o", u, DIA);
    expect(p.state).not.toBe("priced");
    if (p.state === "uncertain" && p.lowerBoundMicroUsd !== undefined) expect(Number.isSafeInteger(p.lowerBoundMicroUsd)).toBe(true);
  });

  it("un AttemptUsage hecho a mano con un negativo o un NaN sale unpriced", () => {
    const base: AttemptUsage = {
      inputUncached: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 10,
      reasoningIncludedInOutput: true, basis: "provider_reported", completeness: "complete",
    };
    expect(tarifarIntento("claude-sonnet-4-5", { ...base, output: -10 }, DIA)).toMatchObject({ state: "unpriced", reason: "usage-invalid" });
    expect(tarifarIntento("claude-sonnet-4-5", { ...base, cacheRead: Number.NaN }, DIA)).toMatchObject({ state: "unpriced", reason: "usage-invalid" });
  });
});

describe("revisión: el tramo de contexto largo no se presenta como el coste", () => {
  it("gpt-5.5 con 400K de entrada (tramo >272K, la petición entera a 2×/1,5×) → uncertain con el suelo de la tarifa corta", () => {
    const u = normalizarUso({ dialecto: "openai-responses", uso: { input_tokens: 400_000, output_tokens: 1000 } });
    const p = tarifarIntento("gpt-5.5", u, DIA);
    // 400 000 × 5 µ$ + 1000 × 30 µ$ = 2 030 000 µ$ a tarifa corta: la factura es MÁS.
    expect(p).toMatchObject({ state: "uncertain", reason: "long-context-tier", lowerBoundMicroUsd: 2_030_000 });
  });

  it("justo en 200K sigue priced; un token más ya no", () => {
    const mk = (n: number) => normalizarUso({ dialecto: "openai-responses", uso: { input_tokens: n, output_tokens: 1 } });
    expect(tarifarIntento("gpt-5.5", mk(200_000), DIA).state).toBe("priced");
    expect(tarifarIntento("gpt-5.5", mk(200_001), DIA).state).toBe("uncertain");
  });
});

describe("revisión: el libro no acepta un precio que no sale de su uso ni un instante que no es fecha", () => {
  it("un recibo con price «priced 0» sobre un uso ausente → ConflictoDeRecibo, y el total no lo cuenta", () => {
    const usage = normalizarUso({ dialecto: "anthropic", uso: null });
    const r = reciboDeIntento({ logicalCallId: "lc-f", attempt: 0, kind: "primary", model: "claude-sonnet-4-5", at: DIA, usage });
    const falso = {
      ...r,
      price: {
        state: "priced" as const, amountMicroUsd: 0, exactAttoUsd: "0", currency: "USD" as const,
        priceVersion: PRECIOS_AL_DIA, priceDay: "2026-10-01", catalogKey: "claude-sonnet-4-5",
      },
    };
    const libro = new LibroDeRecibos();
    expect(() => libro.registrar(falso)).toThrow(ConflictoDeRecibo);
    expect(libro.total("lc-f")).toBeUndefined();
  });

  it("un recibo con at NaN no se construye: el día del precio no puede ser «hoy» según cuándo se mire", () => {
    const usage = normalizarUso({ dialecto: "anthropic", uso: { input_tokens: 10, output_tokens: 5 } });
    expect(() => reciboDeIntento({ logicalCallId: "lc-n", attempt: 0, kind: "primary", model: "claude-sonnet-4-5", at: Number.NaN, usage })).toThrow(TypeError);
  });
});
