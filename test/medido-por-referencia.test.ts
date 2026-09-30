import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { createMockProvider } from "../src/providers/mock.js";
import { InMemoryExactCache, type CachedAnswer, type ExactCache } from "../src/cache/exact.js";
import { InMemorySemanticCache } from "../src/cache/semantic.js";
import { UsageEmitter } from "../src/metering/emitter.js";
import { CATALOGO, claveDeCatalogo, precioDeLista, precioDeListaPropio } from "../src/pricing/catalogo.js";
import { providerNativeBackend } from "../src/constraints/backends.js";
import {
  evaluarReferencia,
  registroDeReferencia,
  type HechosDeLaPoblada,
} from "../src/pipeline/referencia.js";
import { atestiguar, type AtestadoDelCable } from "../src/providers/atestado-del-cable.js";
import type { SavingsLayerConfig } from "../src/pipeline/config.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { JsonSchema, SavingsReport, SavingsRequest, SavingsResult, ToolDescriptor } from "../src/contracts/types.js";
import { ToolSelector } from "../src/router/tool-selector.js";

/**
 * MEDIDO POR REFERENCIA (basis "reference"), de punta a punta.
 *
 * Una evitada —acierto exacto o seguidor de singleflight— se valora con el
 * contador de la petición IDÉNTICA BYTE A BYTE que sí corrió, intacta, y a la
 * baja: toda la entrada a tarifa cacheada, la salida solo con `temperature: 0`.
 * Cada `describe` fija una de las reglas de escritura (E1-E7) o de lectura
 * (L0-L7); el orden de los casos es el de la especificación. Lo nuevo de la
 * regla v2 (E5 ampliada y la guarda de razonamiento) vive en
 * `test/referencia-v2.test.ts`, contra los adaptadores de verdad.
 */

const DIA = 24 * 60 * 60 * 1000;
const MINI = "openai/gpt-4o-mini"; // catálogo: cacheada 0,000075 · salida 0,0006
const PREGUNTA = "What is the capital of France?";

/**
 * El cable que atestigua el adaptador de Chat Completions con la vía nativa: el
 * esquema del cliente tal cual en `response_format`, en modo estricto. Aquí lo firma el test para
 * probar las reglas del pipeline; que el adaptador REAL lo firme (y solo
 * entonces) lo fija `test/referencia-v2.test.ts`.
 */
const CABLE_NATIVO: AtestadoDelCable = {
  esquemaEnFormatoNativo: true,
  esquemaEstricto: true,
  esquemaPorPrompt: false,
  piezasDelAdaptador: 0,
};

/** Proveedor de contador FIJO, que cuenta las llamadas. Declara 0 tokens de
 *  razonamiento salvo que se le diga otra cosa (`razonamiento: null` = no lo dice). */
class ProveedorFijo implements Provider {
  readonly id = "fijo";
  readonly recibidas: ProviderRequest[] = [];
  constructor(
    private readonly entrada: number,
    private readonly salida: number,
    private readonly opciones: {
      tier?: string;
      texto?: string | ((r: ProviderRequest) => string);
      structuredNatively?: boolean;
      razonamiento?: number | null;
      cable?: AtestadoDelCable;
    } = {},
  ) {}
  get llamadas(): number {
    return this.recibidas.length;
  }
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.recibidas.push(r);
    const t = this.opciones.texto;
    const razonamiento = this.opciones.razonamiento === undefined ? 0 : this.opciones.razonamiento;
    const respuesta: ProviderResponse = {
      text: typeof t === "function" ? t(r) : (t ?? "Paris is the capital of France."),
      usage: {
        inputTokens: this.entrada,
        outputTokens: this.salida,
        ...(razonamiento !== null ? { reasoningTokens: razonamiento } : {}),
      },
      ...(this.opciones.tier ? { servedServiceTier: this.opciones.tier } : {}),
      ...(this.opciones.structuredNatively !== undefined
        ? { structuredNatively: this.opciones.structuredNatively }
        : {}),
    };
    return this.opciones.cable ? atestiguar(respuesta, this.opciones.cable) : respuesta;
  }
}

/** Una capa con reloj y caché exacta de 60 días, para poder envejecer el contador. */
function montar(provider: Provider, extra: Partial<SavingsLayerConfig> = {}) {
  let n = 0;
  const reloj = { t: 1_780_000_000_000 };
  const exactCache = new InMemoryExactCache({ now: () => reloj.t });
  const layer = createSavingsLayer({
    provider,
    devUnlicensed: true,
    exactTokenizer: false,
    silenceWarnings: true,
    generateId: () => `req-${n++}`,
    now: () => reloj.t,
    exactCache,
    exactCacheTtlMs: 60 * DIA,
    ...extra,
  });
  return { layer, reloj, exactCache };
}

const peticion = (extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: MINI,
  messages: [{ role: "user", content: PREGUNTA }],
  ...extra,
});

const roundUsd = (n: number): number => Math.round(n * 1e10) / 1e10;

const CONTRATO: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } },
};

/** La traza `reference` de la llamada que pobló. */
const trazaDeReferencia = (r: SavingsResult) => r.report.traces.find((t) => t.stage === "reference");

/** Una caché exacta que MANIPULA lo que sirve: el escritor forjado, el viejo, el roto. */
class CacheManipulada implements ExactCache {
  readonly base = new InMemoryExactCache();
  constructor(private readonly tocar: (a: CachedAnswer) => CachedAnswer | null) {}
  async get<T = unknown>(key: string): Promise<CachedAnswer<T> | null> {
    const a = await this.base.get(key);
    return a ? (this.tocar(a) as CachedAnswer<T> | null) : null;
  }
  set<T = unknown>(key: string, value: CachedAnswer<T>, ttlMs?: number): Promise<void> {
    return this.base.set(key, value, ttlMs);
  }
  delete(key: string): Promise<void> {
    return this.base.delete(key);
  }
}

/** Los hechos de una poblada intacta con esquema nativo, para las reglas puras. */
const HECHOS_INTACTOS: HechosDeLaPoblada = {
  contadorSimulado: false,
  usoPrimario: { inputTokens: 500, outputTokens: 300, reasoningTokens: 0 },
  eliminatedInput: 0,
  compressedInput: 0,
  elididoLocal: 0,
  sentLocalSinSondeo: 40,
  baselineInput: 40,
  codebookAplicado: false,
  tokensDelSondeo: 0,
  sondeoAplicado: false,
  hayEsquema: true,
  esquemaNativo: true,
  esquemaEnFormatoNativo: true,
  esquemaEstricto: true,
  esquemaPorPrompt: false,
  piezasDelAdaptador: 0,
  modeloPedido: MINI,
  modeloServido: MINI,
  cacheable: true,
  mensajesDeLaCapa: 0,
  requestId: "req-poblada",
  at: 1_000,
  textoServido: '{"answer":"ok"}',
  huella: () => "huella",
};

const conReferencia = (a: CachedAnswer, cambio: Record<string, unknown>): CachedAnswer => ({
  ...a,
  meta: { ...(a.meta ?? {}), reference: { ...(a.meta?.["reference"] as object), ...cambio } },
});

describe("1-4 · la valoración: entrada a tarifa cacheada, salida solo determinista", () => {
  it("1 · temperature 0: la repetición se valora con el contador de la poblada", async () => {
    const { layer, reloj } = montar(new ProveedorFijo(1736, 282));
    const relojAlPoblar = reloj.t;
    const primera = await layer.generate(peticion({ temperature: 0 }));
    expect(primera.report.cache.result).toBe("miss");
    expect(trazaDeReferencia(primera)?.outcome).toBe("written");
    expect(trazaDeReferencia(primera)?.detail?.["exactCache"]).toBe(true);

    reloj.t += 60_000;
    const hit = await layer.generate(peticion({ temperature: 0 }));
    const r = hit.report;
    expect(r.cache.result).toBe("exact");
    expect(r.cost.basis).toBe("reference");
    expect(r.tokens.baselineInput).toBe(1736);
    expect(r.tokens.baselineOutput).toBe(267);
    expect(r.tokens.actualInput).toBe(0);
    expect(r.tokens.actualOutput).toBe(0);
    expect(r.tokens.providerCachedInput).toBeUndefined();
    expect(r.cost.actual).toBe(0);
    expect(r.cost.netSavingsRatio).toBe(1);
    expect(r.cost.baselineEstimate).toBeCloseTo(2.904e-4, 10);
    expect(r.cache.reference).toEqual({
      requestId: primera.report.requestId,
      at: relojAlPoblar,
      inputTokens: 1736,
      outputTokens: 282,
      creditedInputTokens: 1736,
      creditedOutputTokens: 267,
      cachedInputPer1k: 0.000075,
      outputPer1k: 0.0006,
      tierFactor: 1,
    });
    expect(r.cache.referenceRejected).toBeUndefined();

    // LA IDENTIDAD PUBLICADA: con los campos del informe, `baselineEstimate` se
    // recalcula exacto, sin creernos.
    const ref = r.cache.reference!;
    expect(r.cost.baselineEstimate).toBe(
      roundUsd(
        ref.tierFactor *
          ((ref.creditedInputTokens / 1000) * ref.cachedInputPer1k +
            (ref.creditedOutputTokens / 1000) * ref.outputPer1k),
      ),
    );
    expect(r.traces.find((t) => t.stage === "exact-cache")?.detail?.["basis"]).toBe("reference");
  });

  it("la traza distingue «registro construido» de «guardado en la caché exacta»", async () => {
    // Con la caché exacta apagada el registro se construye igual (los seguidores
    // de singleflight lo usan), pero no viaja a ninguna caché, y la traza lo dice.
    const { layer } = montar(new ProveedorFijo(1736, 282));
    const primera = await layer.generate(peticion({ temperature: 0, savings: { exactCache: false } }));
    expect(trazaDeReferencia(primera)?.outcome).toBe("written");
    expect(trazaDeReferencia(primera)?.detail?.["exactCache"]).toBe(false);
  });

  it("2 · sin temperature: la salida no cuenta", async () => {
    const { layer } = montar(new ProveedorFijo(1736, 282));
    await layer.generate(peticion());
    const hit = await layer.generate(peticion());
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.tokens.baselineOutput).toBe(0);
    expect(hit.report.cache.reference?.creditedOutputTokens).toBe(0);
    expect(hit.report.cost.baselineEstimate).toBeCloseTo(1.302e-4, 10);
  });

  it("3 · seed 7 sin temperature: la salida tampoco cuenta — la regla es solo temperature 0", async () => {
    const { layer } = montar(new ProveedorFijo(1736, 282));
    await layer.generate(peticion({ seed: 7 }));
    const hit = await layer.generate(peticion({ seed: 7 }));
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.tokens.baselineOutput).toBe(0);
  });

  it("4 · el tope de salida del LECTOR acota la salida acreditada", async () => {
    // `maxOutputTokens` no está en la clave exacta: la repetición puede pedir
    // menos salida que la poblada, y nunca se le acredita más que su tope.
    // El tope viaja en el contrato de salida, así que hace falta esquema, y con
    // esquema, nativo y tal cual (E5). Con la configuración POR DEFECTO: sin
    // `constraintBackends`, que en la v1 lo dejaba fuera.
    const { layer } = montar(
      new ProveedorFijo(1736, 282, { texto: '{"answer":"Paris"}', structuredNatively: true, cable: CABLE_NATIVO }),
    );
    const contrato = (maxOutputTokens: number) => ({ contractId: "a:v1", schema: CONTRATO, maxOutputTokens });
    await layer.generate(peticion({ temperature: 0, response: contrato(1000) }));
    const hit = await layer.generate(peticion({ temperature: 0, response: contrato(100) }));
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.cache.reference?.creditedOutputTokens).toBe(95);
  });
});

describe("5 · L6: sin tarifa cacheada documentada no hay referencia", () => {
  it("gpt-4-turbo no tiene precio cacheado en el catálogo", async () => {
    const { layer } = montar(new ProveedorFijo(1736, 282));
    await layer.generate(peticion({ model: "openai/gpt-4-turbo" }));
    const hit = await layer.generate(peticion({ model: "openai/gpt-4-turbo" }));
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("no-cached-price");
    expect(hit.report.cache.reference).toBeUndefined();
  });

  it("un modelo fuera del catálogo: el precio ilustrativo nunca vale", async () => {
    const { layer } = montar(new ProveedorFijo(1736, 282));
    await layer.generate(peticion({ model: "acme/modelo-casero" }));
    const hit = await layer.generate(peticion({ model: "acme/modelo-casero" }));
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("no-cached-price");
  });

  it("claude-3-haiku, retirado del API (2026-04-20) y sin fila: como cualquier modelo fuera de catálogo", async () => {
    // https://platform.claude.com/docs/en/about-claude/model-deprecations
    // (consultada el 2026-09-28): claude-3-haiku-20240307 «Retired», April 20, 2026.
    for (const id of ["claude-3-haiku", "claude-3-haiku-20240307", "anthropic/claude-3-haiku-20240307"]) {
      expect(claveDeCatalogo(id), id).toBeUndefined();
      expect(precioDeLista(id), id).toBeUndefined();
      expect(precioDeListaPropio(id), id).toBeUndefined();
    }
    // Sus vecinos siguen con su fila, y ninguno hereda la del otro.
    expect(claveDeCatalogo("claude-3-5-haiku-20241022")).toBe("claude-3-5-haiku");
    expect(precioDeListaPropio("claude-3-5-haiku-20241022")).toBe(CATALOGO["claude-3-5-haiku"]);
    expect(claveDeCatalogo("anthropic/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(precioDeListaPropio("anthropic/claude-haiku-4-5-20251001")).toBe(CATALOGO["claude-haiku-4-5"]);

    const HAIKU3 = "anthropic/claude-3-haiku-20240307";
    const { layer } = montar(new ProveedorFijo(1736, 282));
    await layer.generate(peticion({ model: HAIKU3, temperature: 0 }));
    const hit = await layer.generate(peticion({ model: HAIKU3, temperature: 0 }));
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("no-cached-price");
    expect(hit.report.cache.reference).toBeUndefined();
  });

  it("costModels con la tarifa cacheada POR ENCIMA de la de entrada", async () => {
    const { layer } = montar(new ProveedorFijo(1736, 282), {
      costModels: { [MINI]: { inputPer1k: 0.0001, outputPer1k: 0.0006, cachedInputPer1k: 0.0002 } },
    });
    await layer.generate(peticion());
    const hit = await layer.generate(peticion());
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("no-cached-price");
  });

  it("un id que HEREDA la fila de otro modelo no vale: gemini-2.5-flash-lite no es gemini-2.5-flash", async () => {
    // `precioDeLista` le da a `-lite` la fila de su pariente (sufijo de letra),
    // tres veces su entrada cacheada real. Para tarifar un informe puede pasar;
    // para un suelo que entra en la comisión, no.
    const LITE = "google/gemini-2.5-flash-lite";
    expect(precioDeLista(LITE)).toBe(precioDeLista("gemini-2.5-flash"));
    const { layer } = montar(new ProveedorFijo(400, 60));
    await layer.generate(peticion({ model: LITE, temperature: 0 }));
    const hit = await layer.generate(peticion({ model: LITE, temperature: 0 }));
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("no-cached-price");
    expect(hit.report.cache.reference).toBeUndefined();
  });

  it("…pero con su precio declarado en costModels, sí: el precio es el del cliente", async () => {
    const LITE = "google/gemini-2.5-flash-lite";
    const precio = { inputPer1k: 0.0001, outputPer1k: 0.0004, cachedInputPer1k: 0.00001 };
    const { layer } = montar(new ProveedorFijo(400, 60), { costModels: { "gemini-2.5-flash-lite": precio } });
    await layer.generate(peticion({ model: LITE, temperature: 0 }));
    const hit = await layer.generate(peticion({ model: LITE, temperature: 0 }));
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.cache.reference?.cachedInputPer1k).toBe(0.00001);
    expect(hit.report.cache.reference?.outputPer1k).toBe(0.0004);
    // Regla v2: Gemini 2.5 es familia de razonamiento, así que la salida no
    // cuenta aunque el contador diga 0 y la petición pida temperature 0.
    expect(hit.report.cache.reference?.creditedOutputTokens).toBe(0);
    expect(hit.report.cost.baselineEstimate).toBeCloseTo((400 * 0.00001) / 1000, 10);
    expect(hit.report.traces.find((t) => t.stage === "exact-cache")?.detail?.["outputNotCredited"]).toBe(
      "reasoning-model",
    );
  });

  it("una instantánea con FECHA es el mismo modelo: gpt-4o-mini-2024-07-18 se valora con su fila", async () => {
    const FECHADO = "openai/gpt-4o-mini-2024-07-18";
    const { layer } = montar(new ProveedorFijo(1736, 282));
    await layer.generate(peticion({ model: FECHADO, temperature: 0 }));
    const hit = await layer.generate(peticion({ model: FECHADO, temperature: 0 }));
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.cache.reference?.cachedInputPer1k).toBe(0.000075);
    expect(hit.report.cost.baselineEstimate).toBeCloseTo(2.904e-4, 10);
  });
});

describe("E0 · el contador del proveedor de demo no es un contador", () => {
  it("el mock inventa su usage: la poblada no deja registro y la repetición sigue estimated", async () => {
    const { layer } = montar(createMockProvider({ answer: "Paris" }));
    const primera = await layer.generate(peticion({ temperature: 0 }));
    expect(trazaDeReferencia(primera)?.outcome).toBe("not-written");
    expect(trazaDeReferencia(primera)?.detail).toEqual({ reason: "simulated-provider" });

    const hit = await layer.generate(peticion({ temperature: 0 }));
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("absent");
    expect(hit.report.cache.reference).toBeUndefined();
  });

  it("la regla pura: E0 va antes que todo lo demás", () => {
    expect(registroDeReferencia({ ...HECHOS_INTACTOS, contadorSimulado: true })).toBe("simulated-provider");
    // Y aunque el usage falte: el motivo es el primero que falla.
    expect(
      registroDeReferencia({ ...HECHOS_INTACTOS, contadorSimulado: true, usoPrimario: undefined }),
    ).toBe("simulated-provider");
    expect(typeof registroDeReferencia(HECHOS_INTACTOS)).toBe("object");
  });
});

describe("E1 · un contador incompleto no deja referencia", () => {
  it("la regla pura: complete false en la primaria o en la reparación → no-usage", () => {
    expect(
      registroDeReferencia({ ...HECHOS_INTACTOS, usoPrimario: { inputTokens: 500, outputTokens: 0, complete: false } }),
    ).toBe("no-usage");
    expect(
      registroDeReferencia({ ...HECHOS_INTACTOS, usoReparacion: { inputTokens: 520, outputTokens: 0, complete: false } }),
    ).toBe("no-usage");
    // `complete: true` (o ausente) sigue siendo un contador.
    expect(
      typeof registroDeReferencia({
        ...HECHOS_INTACTOS,
        usoPrimario: { inputTokens: 500, outputTokens: 300, complete: true },
      }),
    ).toBe("object");
  });

  it("de punta a punta: la poblada sale unmeasured, no deja registro y la repetición sigue estimated", async () => {
    // Un endpoint que da la entrada y omite la salida: el adaptador rellena el 0
    // y marca `complete: false`. La entrada es real; el contador, no.
    const provider: Provider = {
      id: "sin-salida",
      async generate(): Promise<ProviderResponse> {
        return {
          text: "Paris is the capital of France.",
          usage: { inputTokens: 1736, outputTokens: 0, complete: false },
        };
      },
    };
    const { layer } = montar(provider);
    const primera = await layer.generate(peticion({ temperature: 0 }));
    expect(primera.report.cost.basis).toBe("unmeasured");
    expect(trazaDeReferencia(primera)?.outcome).toBe("not-written");
    expect(trazaDeReferencia(primera)?.detail).toEqual({ reason: "no-usage" });

    const hit = await layer.generate(peticion({ temperature: 0 }));
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("absent");
    expect(hit.report.cache.reference).toBeUndefined();
  });
});

/** Cinco herramientas de las que la pregunta solo casa con una. */
const HERRAMIENTAS: ToolDescriptor[] = [
  {
    id: "buscar_factura",
    intents: ["buscar", "factura", "importe"],
    risk: "read",
    description: "Busca una factura por numero, cliente o rango de fechas y devuelve su detalle completo.",
    parameters: { type: "object", properties: { numero: { type: "string" } } },
  },
  {
    id: "exportar_contabilidad",
    intents: ["exportar", "contabilidad", "asiento"],
    risk: "read",
    description: "Exporta los asientos contables de un periodo al formato del ERP con todos sus apuntes.",
    parameters: { type: "object", properties: { desde: { type: "string" }, hasta: { type: "string" } } },
  },
  {
    id: "planificar_ruta_reparto",
    intents: ["ruta", "reparto", "logistica"],
    risk: "read",
    description: "Calcula la ruta optima de reparto para una flota dada, con ventanas horarias y capacidad.",
    parameters: { type: "object", properties: { vehiculos: { type: "array" } } },
  },
  {
    id: "consultar_inventario",
    intents: ["inventario", "stock", "almacen"],
    risk: "read",
    description: "Consulta el stock disponible de un articulo en todos los almacenes de la red.",
    parameters: { type: "object", properties: { articulo: { type: "string" } } },
  },
  {
    id: "resumir_contrato",
    intents: ["contrato", "clausula", "resumen"],
    risk: "read",
    description: "Resume las clausulas principales de un contrato mercantil y senala los plazos criticos.",
    parameters: { type: "object", properties: { contrato: { type: "string" } } },
  },
];

const CODEBOOK: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "confidence", "evidence"],
  properties: {
    decision: { type: "string", enum: ["human_review", "auto_approve", "auto_reject"] },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    evidence: { type: "array", maxItems: 4, items: { type: "string", maxLength: 16 } },
  },
};

describe("6 · E2/E3: una poblada que la capa tocó no deja contador", () => {
  it("(a) el selector descarta herramientas del catálogo", async () => {
    // Con `maxTools`: desde 0.4.33 el selector solo poda por relevancia si se le pide.
    const { layer } = montar(new ProveedorFijo(900, 20, { texto: "Tres vehiculos bastan." }), {
      toolSelector: new ToolSelector({ maxTools: 8 }),
    });
    const req = peticion({
      messages: [{ role: "user", content: "planifica la ruta de reparto de la flota del norte" }],
      tools: HERRAMIENTAS,
    });
    const primera = await layer.generate(req);
    expect(primera.report.tokens.eliminatedInput).toBeGreaterThan(0);
    expect(trazaDeReferencia(primera)?.outcome).toBe("not-written");
    expect(trazaDeReferencia(primera)?.detail?.["reason"]).toBe("layer-changed-request");

    const hit = await layer.generate(req);
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("absent");
  });

  it("(b) datos estructurados en tabla uniforme: el formato compacto gana", async () => {
    const filas = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      region: ["norte", "sur", "este", "oeste"][i % 4],
      ventas: 1000 + i * 37,
      margen: 0.1 + (i % 7) / 100,
    }));
    const { layer } = montar(new ProveedorFijo(900, 20, { texto: "El norte vende mas." }));
    const req = peticion({
      messages: [{ role: "user", content: "which region sells the most?" }],
      structuredData: filas,
    });
    const primera = await layer.generate(req);
    expect(primera.report.tokens.compressedInput).toBeGreaterThan(0);
    expect(trazaDeReferencia(primera)?.detail?.["reason"]).toBe("layer-changed-request");

    const hit = await layer.generate(req);
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("absent");
  });

  it("(c) el codebook de salida aplicado", async () => {
    const texto = JSON.stringify({ d: "H", c: 87, e: ["E17:4"] });
    const { layer } = montar(new ProveedorFijo(100, 12, { texto, structuredNatively: true, cable: CABLE_NATIVO }));
    const req: SavingsRequest = {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "clasifica el expediente 4711 y cita la evidencia" }],
      response: { contractId: "triage:v1", schema: CODEBOOK, maxOutputTokens: 200 },
      savings: { outputCodebook: true, outputCodebookMeasuredOutputDeltaTokens: 5 },
    };
    const primera = await layer.generate(req);
    expect(primera.report.traces.find((t) => t.stage === "output-codebook")?.outcome).toBe("applied");
    expect(trazaDeReferencia(primera)?.detail?.["reason"]).toBe("codebook");

    const hit = await layer.generate(req);
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("absent");
  });
});

describe("7 · el mensaje de datos que inserta la capa se descuenta", () => {
  it("datos pequeños que viajan como JSON: 8 tokens menos por el mensaje", async () => {
    const { layer } = montar(new ProveedorFijo(500, 10));
    const req = peticion({
      messages: [{ role: "user", content: "summarize this record in one sentence" }],
      structuredData: { id: "A-1", state: "shipped" },
    });
    const primera = await layer.generate(req);
    expect(primera.report.serialization.chosen).toBe("json-compact");
    expect(trazaDeReferencia(primera)?.outcome).toBe("written");
    expect(trazaDeReferencia(primera)?.detail?.["layerInsertions"]).toBe(1);

    const hit = await layer.generate(req);
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.cache.reference?.inputTokens).toBe(500);
    expect(hit.report.cache.reference?.creditedInputTokens).toBe(500 - 8);
  });
});

describe("8 · la reparación: su coste es nuestro, y su salida acota la acreditada", () => {
  it("un proveedor que no dice que impuso el esquema no deja contador, repare o no (E5)", async () => {
    // Sin `structuredNatively: true` el esquema pudo viajar como prompt, y esa
    // instrucción la cobra el proveedor sin que la cuenta local la vea. La
    // reparación con esquema NATIVO sí deja contador: ver el caso siguiente.
    let n = 0;
    const provider: Provider = {
      id: "repara",
      async generate(): Promise<ProviderResponse> {
        n++;
        return n === 1
          ? { text: "not json at all", usage: { inputTokens: 500, outputTokens: 300 } }
          : { text: '{"answer":"ok"}', usage: { inputTokens: 700, outputTokens: 120 } };
      },
    };
    const { layer } = montar(provider, { constraintBackends: [] });
    const req = peticion({ temperature: 0, response: { contractId: "a:v1", schema: CONTRATO } });
    const primera = await layer.generate(req);
    expect(primera.report.calls.retries).toBe(1);
    expect(trazaDeReferencia(primera)?.detail?.["reason"]).toBe("schema-in-prompt");

    const hit = await layer.generate(req);
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("absent");
  });

  it("de punta a punta, con el esquema nativo: la entrada es la de la primaria y la salida la menor de las dos", async () => {
    // Con la configuración por defecto el backend planeado es `none`, así que
    // una respuesta que el proveedor dio por buena pero que nuestro validador
    // rechaza (aquí, `maxLength`) se repara. La reparación es coste NUESTRO: su
    // entrada no entra en la referencia, y su salida solo acota la acreditada.
    const LARGO: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string", maxLength: 10 } },
    };
    let n = 0;
    const provider: Provider = {
      id: "repara-nativo",
      async generate(): Promise<ProviderResponse> {
        n++;
        return atestiguar(
          n === 1
            ? {
                text: '{"answer":"Paris is the capital of France"}',
                usage: { inputTokens: 500, outputTokens: 300, reasoningTokens: 0 },
                structuredNatively: true,
              }
            : {
                text: '{"answer":"Paris"}',
                usage: { inputTokens: 700, outputTokens: 120, reasoningTokens: 0 },
                structuredNatively: true,
              },
          CABLE_NATIVO,
        );
      },
    };
    const { layer } = montar(provider);
    const req = peticion({ temperature: 0, response: { contractId: "corto:v1", schema: LARGO } });
    const primera = await layer.generate(req);
    expect(primera.report.calls.retries).toBe(1);
    expect(trazaDeReferencia(primera)?.outcome).toBe("written");
    expect(trazaDeReferencia(primera)?.detail?.["inputTokens"]).toBe(500);
    expect(trazaDeReferencia(primera)?.detail?.["outputTokens"]).toBe(120);

    const hit = await layer.generate(req);
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("reference");
    // El envoltorio del esquema nativo se descuenta como una pieza de la capa.
    expect(hit.report.cache.reference?.creditedInputTokens).toBe(500 - 8);
    expect(hit.report.cache.reference?.creditedOutputTokens).toBe(114);
  });

  it("la regla de escritura: entrada de la primaria, salida la menor de las dos", () => {
    const registro = registroDeReferencia({
      ...HECHOS_INTACTOS,
      usoPrimario: { inputTokens: 500, outputTokens: 300, reasoningTokens: 0 },
      usoReparacion: { inputTokens: 700, outputTokens: 120, reasoningTokens: 0 },
    });
    if (typeof registro !== "object") throw new Error(`se esperaba registro, salió ${registro}`);
    expect(registro.inputTokens).toBe(500);
    expect(registro.outputTokens).toBe(120);

    const ev = evaluarReferencia(registro, {
      ahoraMs: 2_000,
      modeloPedido: MINI,
      modeloServido: MINI,
      huella: "huella",
      textoServidoSha256: registro.textSha256,
      calidadOk: true,
      precio: precioDeLista("gpt-4o-mini"),
      determinista: true,
      salidaDelModelo: undefined,
      diferible: false,
    });
    if (!ev.ok) throw new Error(`se esperaba crédito, salió ${ev.reason}`);
    expect(ev.credit.creditedOutputTokens).toBe(114);
  });
});

describe("9 · E6: la cascada", () => {
  const FUERTE = "openai/gpt-4o";
  const PRECIOS = { [FUERTE]: precioDeLista("gpt-4o")!, [MINI]: precioDeLista("gpt-4o-mini")! };
  const pet = (extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
    model: FUERTE,
    messages: [{ role: "user", content: "resume en una frase el informe adjunto" }],
    response: { contractId: "answer:v1", schema: CONTRATO },
    ...extra,
  });

  it("si sirve el barato no hay referencia, y la repetición sin cascada no acierta", async () => {
    const p = new ProveedorFijo(1000, 200, {
      texto: '{"answer":"del barato"}',
      structuredNatively: true,
      cable: CABLE_NATIVO,
    });
    const { layer } = montar(p, { costModels: PRECIOS, constraintBackends: [providerNativeBackend()] });
    const enrutada = await layer.generate(pet({ savings: { modelCascade: "on" } }));
    expect(enrutada.report.model).toBe(MINI);
    expect(trazaDeReferencia(enrutada)?.detail?.["reason"]).toBe("cheaper-model-served");

    const normal = await layer.generate(pet());
    expect(normal.report.cache.result).toBe("miss");
  });

  it("si escala, la referencia es el contador del fuerte; el intento barato queda fuera", async () => {
    const provider: Provider = {
      id: "escala",
      async generate(r: ProviderRequest): Promise<ProviderResponse> {
        return atestiguar(
          r.model === MINI
            ? { text: "no es json", usage: { inputTokens: 900, outputTokens: 150 }, structuredNatively: true }
            : {
                text: '{"answer":"del fuerte"}',
                usage: { inputTokens: 1000, outputTokens: 200 },
                structuredNatively: true,
              },
          CABLE_NATIVO,
        );
      },
    };
    const { layer } = montar(provider, { costModels: PRECIOS, constraintBackends: [providerNativeBackend()] });
    const escalada = await layer.generate(pet({ savings: { modelCascade: "on" } }));
    expect(escalada.report.modelCascade!.escalated).toBe(true);
    expect(trazaDeReferencia(escalada)?.outcome).toBe("written");
    expect(trazaDeReferencia(escalada)?.detail?.["inputTokens"]).toBe(1000);

    const normal = await layer.generate(pet());
    expect(normal.report.cache.result).toBe("exact");
    expect(normal.report.cost.basis).toBe("reference");
    expect(normal.report.cache.reference?.inputTokens).toBe(1000);
    expect(normal.report.cache.reference?.outputTokens).toBe(200);
    expect(normal.report.cache.reference?.cachedInputPer1k).toBe(0.00125);
  });
});

describe("10 · L3: el contador caduca con el período de facturación", () => {
  it("+31 días: expired; +29 días: reference", async () => {
    const a = montar(new ProveedorFijo(1736, 282));
    await a.layer.generate(peticion());
    a.reloj.t += 31 * DIA;
    const vieja = await a.layer.generate(peticion());
    expect(vieja.report.cache.result).toBe("exact");
    expect(vieja.report.cost.basis).toBe("estimated");
    expect(vieja.report.cache.referenceRejected).toBe("expired");

    const b = montar(new ProveedorFijo(1736, 282));
    await b.layer.generate(peticion());
    b.reloj.t += 29 * DIA;
    const reciente = await b.layer.generate(peticion());
    expect(reciente.report.cost.basis).toBe("reference");
  });
});

describe("11-12 · L0/L1: forma y testigo", () => {
  it("11 · un textSha256 que no es el del texto servido: witness", async () => {
    const exactCache = new CacheManipulada((a) => conReferencia(a, { textSha256: "0".repeat(64) }));
    const { layer } = montar(new ProveedorFijo(1736, 282), { exactCache });
    await layer.generate(peticion());
    const hit = await layer.generate(peticion());
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("witness");
  });

  it("11 · una cacheKey que no es la leída: witness", async () => {
    const exactCache = new CacheManipulada((a) => conReferencia(a, { cacheKey: "otra-clave" }));
    const { layer } = montar(new ProveedorFijo(1736, 282), { exactCache });
    await layer.generate(peticion());
    const hit = await layer.generate(peticion());
    expect(hit.report.cache.referenceRejected).toBe("witness");
  });

  it("12 · inputTokens negativo, un registro de la regla v1 o una versión desconocida: malformed", async () => {
    for (const cambio of [{ inputTokens: -5 }, { v: 1 }, { v: 3 }, { reasoningTokens: -1 }]) {
      const exactCache = new CacheManipulada((a) => conReferencia(a, cambio));
      const { layer } = montar(new ProveedorFijo(1736, 282), { exactCache });
      await layer.generate(peticion());
      const hit = await layer.generate(peticion());
      expect(hit.report.cost.basis).toBe("estimated");
      expect(hit.report.cache.referenceRejected).toBe("malformed");
    }
  });

  it("12 · una entrada sin meta (escritor anterior): absent", async () => {
    const exactCache = new CacheManipulada(({ meta: _fuera, ...a }) => a);
    const { layer } = montar(new ProveedorFijo(1736, 282), { exactCache });
    await layer.generate(peticion());
    const hit = await layer.generate(peticion());
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("absent");
  });
});

describe("13-14 · L4/L5: identidad byte a byte y calidad", () => {
  it("13 · misma clave normalizada, otros bytes: different-request", async () => {
    const { layer } = montar(new ProveedorFijo(1736, 282));
    await layer.generate(peticion({ messages: [{ role: "user", content: "What is the capital of France?" }] }));
    const hit = await layer.generate(
      peticion({ messages: [{ role: "user", content: "what is the capital of france" }] }),
    );
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("different-request");
  });

  it("14 · lo que se va a servir no cumple el esquema: quality", async () => {
    const exactCache = new CacheManipulada((a) => ({ ...a, data: { otra: 1 } }));
    const { layer } = montar(
      new ProveedorFijo(1736, 12, { texto: '{"answer":"ok"}', structuredNatively: true, cable: CABLE_NATIVO }),
      { exactCache },
    );
    const req = peticion({ response: { contractId: "a:v1", schema: CONTRATO } });
    const primera = await layer.generate(req);
    expect(trazaDeReferencia(primera)?.outcome).toBe("written");
    const hit = await layer.generate(req);
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.referenceRejected).toBe("quality");
  });
});

describe("15 · el tier: nunca por encima del más barato posible", () => {
  it("poblada servida en flex: tierFactor 0,5 y el baseline a la mitad", async () => {
    const { layer } = montar(new ProveedorFijo(1736, 282, { tier: "flex" }));
    await layer.generate(peticion());
    const hit = await layer.generate(peticion());
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.cache.reference?.tierFactor).toBe(0.5);
    expect(hit.report.cost.baselineEstimate).toBeCloseTo(1.302e-4 / 2, 10);
  });

  it("lector que declara la petición diferible: tierFactor 0,5", async () => {
    const { layer } = montar(new ProveedorFijo(1736, 282));
    await layer.generate(peticion());
    const hit = await layer.generate(peticion({ savings: { deferrable: true } }));
    expect(hit.report.cache.result).toBe("exact");
    expect(hit.report.cost.basis).toBe("reference");
    expect(hit.report.cache.reference?.tierFactor).toBe(0.5);
  });
});

/** Proveedor que no contesta hasta que el test lo dice: coalescencia real. */
class ProveedorContado implements Provider {
  readonly id = "contado";
  readonly recibidas: ProviderRequest[] = [];
  private readonly enVuelo: Array<(r: ProviderResponse) => void> = [];
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.recibidas.push(req);
    return new Promise<ProviderResponse>((cumplir) => this.enVuelo.push(cumplir));
  }
  responder(texto: string, uso = { inputTokens: 40, outputTokens: 12, reasoningTokens: 0 }): void {
    for (const c of this.enVuelo.splice(0)) c({ text: texto, usage: uso });
  }
}

async function asentar(turnos = 100): Promise<void> {
  for (let i = 0; i < turnos; i++) await Promise.resolve();
}

describe("16-17 · el seguidor de singleflight", () => {
  const PREG = "describe the lifecycle of a butterfly in three stages";

  for (const [nombre, temperatura, salidaEsperada] of [
    ["sin temperature: la salida no cuenta", undefined, 0],
    ["con temperature 0: el 95 % de la salida del líder", 0, 11],
  ] as const) {
    it(`16 · ${nombre}`, async () => {
      const proveedor = new ProveedorContado();
      const { layer } = montar(proveedor);
      const req = peticion({
        messages: [{ role: "user", content: PREG }],
        ...(temperatura !== undefined ? { temperature: temperatura } : {}),
      });
      const enCurso = Array.from({ length: 4 }, () => layer.generate(req));
      await asentar();
      expect(proveedor.recibidas).toHaveLength(1);
      proveedor.responder("compartida");
      const res = await Promise.all(enCurso);

      const lider = res.find((r) => r.report.cache.result === "miss")!;
      const seguidores = res.filter((r) => r.report.cache.result === "singleflight");
      expect(seguidores).toHaveLength(3);
      for (const s of seguidores) {
        expect(s.report.cost.basis).toBe("reference");
        expect(s.report.tokens.baselineInput).toBe(40);
        expect(s.report.tokens.baselineOutput).toBe(salidaEsperada);
        expect(s.report.cost.actual).toBe(0);
        expect(s.report.cost.netSavingsRatio).toBe(1);
        expect(s.report.cache.reference?.requestId).toBe(lider.report.requestId);
      }
      expect(res.reduce((t, r) => t + r.report.calls.actualLlm, 0)).toBe(1);
    });
  }

  it("17 · misma clave de vuelo, otros bytes: different-request", async () => {
    const proveedor = new ProveedorContado();
    const { layer } = montar(proveedor);
    const a = layer.generate(peticion({ messages: [{ role: "user", content: "What is the capital of France?" }] }));
    const b = layer.generate(peticion({ messages: [{ role: "user", content: "what is the capital of france" }] }));
    await asentar();
    expect(proveedor.recibidas).toHaveLength(1);
    proveedor.responder("Paris");
    const [ra, rb] = await Promise.all([a, b]);
    const seguidor = [ra, rb].find((r) => r.report.cache.result === "singleflight")!;
    expect(seguidor.report.cost.basis).toBe("estimated");
    expect(seguidor.report.cache.referenceRejected).toBe("different-request");
  });
});

describe("18-19 · lo que queda fuera, a propósito", () => {
  it("18 · un acierto semántico no es la misma petición: estimated y sin referencia", async () => {
    const embed = async (t: string): Promise<number[]> =>
      [0, 1, 2, 3].map((i) => [...t].filter((c) => c.charCodeAt(0) % 4 === i).length);
    const semanticCache = new InMemorySemanticCache({ embed, similarityThreshold: 0.3, acceptThreshold: 0.3 });
    const { layer } = montar(new ProveedorFijo(1736, 282), { semanticCacheStore: semanticCache });
    const base = {
      savings: { semanticCache: true as const, exactCache: false },
      context: { tenantId: "acme", knowledgeEpoch: "e1" },
    };
    await layer.generate(peticion({ ...base, messages: [{ role: "user", content: "explain the coalescing mechanism briefly" }] }));
    const hit = await layer.generate(
      peticion({ ...base, messages: [{ role: "user", content: "explain briefly the coalescing mechanism" }] }),
    );
    expect(hit.report.cache.result).toBe("semantic");
    expect(hit.report.cost.basis).toBe("estimated");
    expect(hit.report.cache.reference).toBeUndefined();
  });

  it("19 · el resolver determinista nunca tuvo contador", async () => {
    const { layer } = montar(new ProveedorFijo(1736, 282));
    const res = await layer.generate(peticion({ messages: [{ role: "user", content: "What is 2 + 2 * 3?" }] }));
    expect(res.report.cache.result).toBe("deterministic");
    expect(res.report.cost.basis).toBe("estimated");
    expect(res.report.cache.reference).toBeUndefined();
  });
});

describe("20 · el cable", () => {
  it("un acierto por referencia viaja con el puntero a la llamada que corrió", async () => {
    const { layer } = montar(new ProveedorFijo(1736, 282));
    const poblada = await layer.generate(peticion({ temperature: 0 }));
    const hit = await layer.generate(peticion({ temperature: 0 }));

    const calls: RequestInit[] = [];
    const fetchImpl = ((_u: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve({ ok: true, status: 202 } as Response);
    }) as unknown as typeof fetch;
    const em = new UsageEmitter({ url: "https://x.test/api/metering/usage", serviceAccountKey: "bvk_x", fetchImpl });
    em.record(hit.report);
    await em.flush();
    const rec = JSON.parse(calls[0]!.body as string)[0] as Record<string, unknown>;

    expect(rec["basis"]).toBe("reference");
    expect(rec["referenceRequestId"]).toBe(poblada.report.requestId);
    expect(Number.isInteger(rec["referenceAt"])).toBe(true);
    expect(rec["actualCost"]).toBe(0);
    expect(rec["netSavings"]).toBe(1);
    const PERMITIDAS = new Set([
      "orgId", "seatId", "ci", "requestId", "model", "at",
      "avoidedLlm", "actualLlm", "baselineInputTokens", "actualInputTokens",
      "eliminatedInputTokens", "compressedInputTokens", "baselineOutputTokens",
      "actualOutputTokens", "providerCachedInputTokens", "cacheResult",
      "baselineCost", "actualCost", "netSavings", "eliminatedInputFloorCost",
      "basis", "referenceRequestId", "referenceAt",
    ]);
    for (const k of Object.keys(rec)) expect(PERMITIDAS.has(k), k).toBe(true);
  });

  it("sin basis reference no viaja ningún puntero", async () => {
    const { layer } = montar(new ProveedorFijo(1736, 282));
    const poblada = await layer.generate(peticion());
    const report = { ...poblada.report } as SavingsReport;
    const calls: RequestInit[] = [];
    const fetchImpl = ((_u: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve({ ok: true, status: 202 } as Response);
    }) as unknown as typeof fetch;
    const em = new UsageEmitter({ url: "https://x.test/api/metering/usage", serviceAccountKey: "bvk_x", fetchImpl });
    em.record(report);
    await em.flush();
    const rec = JSON.parse(calls[0]!.body as string)[0] as Record<string, unknown>;
    expect(rec["basis"]).toBe("measured");
    expect(rec["referenceRequestId"]).toBeUndefined();
    expect(rec["referenceAt"]).toBeUndefined();
  });
});
