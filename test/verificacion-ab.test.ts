import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { UsageEmitter } from "../src/metering/emitter.js";
import { precioDeLista } from "../src/pricing/catalogo.js";
import { sha256 } from "../src/canonicalization/canonicalize.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import { construirPeticionSinCapa } from "../src/verification/brazo-sin-capa.js";
import { precioDelUso } from "../src/verification/precio.js";
import { enLaMuestraDeVerificacion } from "../src/verification/muestreo.js";
import { clasificar } from "../src/verification/clasificar.js";
import { ComprobadorAB } from "../src/verification/comprobador.js";
import { avisoDeVerificacionActiva } from "../src/verification/ajustes.js";
import type { SavingsLayerConfig } from "../src/pipeline/config.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderStreamOptions,
} from "../src/providers/types.js";
import type { SavingsReport, SavingsRequest, SavingsResult, ToolDescriptor } from "../src/contracts/types.js";
import type { VerificationCheck } from "../src/contracts/verification.js";
import { ToolSelector } from "../src/router/tool-selector.js";

/**
 * «TU PROPIO BANCO»: la verificación A/B opcional del SDK.
 *
 * Instrumento, nunca base: la copia sin capa se manda DESPUÉS de servir, al
 * proveedor del cliente, se descarta su respuesta y el par viaja por su canal
 * propio. Estos tests fijan las garantías de la especificación §10.1 (1-18):
 * apagada por defecto, la copia es el brazo B0 del banco, la copia no contamina
 * nada de la capa, `close()` decide lo que queda en vuelo, y ante cualquier
 * fallo el resultado servido queda intacto.
 */

const MODELO = "openai/gpt-4o-mini";
const FUERTE = "openai/gpt-4o";

/**
 * Proveedor que es FUNCIÓN PURA de la petición: mismo cuerpo, misma respuesta.
 * El texto lleva un hash de la petición, así que la copia sin capa (otra
 * petición) contesta distinto que la petición optimizada: si su texto se
 * colara en la caché, se vería.
 */
class ProveedorPuro implements Provider {
  readonly id = "puro";
  readonly llamadas: Array<{ req: ProviderRequest; options?: ProviderStreamOptions }> = [];
  constructor(
    private readonly o: {
      log?: string[];
      /** Retraso de cada respuesta (ms): hace solapar las peticiones concurrentes. */
      retraso?: number;
      /** Ajustes de la respuesta según la petición y según si es la copia (lleva `signal`). */
      ajuste?: (req: ProviderRequest, esCopia: boolean) => Partial<ProviderResponse> | "lanza" | "cuelga";
    } = {},
  ) {}

  async generate(req: ProviderRequest, options?: ProviderStreamOptions): Promise<ProviderResponse> {
    const esCopia = options?.signal !== undefined;
    this.llamadas.push({ req, ...(options ? { options } : {}) });
    this.o.log?.push(esCopia ? "copia" : "servida");
    if (this.o.retraso) await new Promise((r) => setTimeout(r, this.o.retraso));
    const ajuste = this.o.ajuste?.(req, esCopia) ?? {};
    if (ajuste === "lanza") throw new Error("provider 503: la copia falló");
    if (ajuste === "cuelga") {
      return new Promise<ProviderResponse>((_res, rej) => {
        options?.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
      });
    }
    const inputTokens =
      10 +
      req.messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0) +
      (req.tools?.length ?? 0) * 40 +
      (req.schema ? 20 : 0);
    const huella = sha256(JSON.stringify(req)).slice(0, 10);
    return {
      text: req.schema ? JSON.stringify({ answer: `ok-${huella}` }) : `ans-${huella}`,
      usage: { inputTokens, outputTokens: 12 },
      finishReason: "stop",
      ...ajuste,
    };
  }

  get copias(): ProviderRequest[] {
    return this.llamadas.filter((l) => l.options?.signal !== undefined).map((l) => l.req);
  }
  get servidas(): ProviderRequest[] {
    return this.llamadas.filter((l) => l.options?.signal === undefined).map((l) => l.req);
  }
}

/** Deja correr el `setTimeout(0)` de la copia y las microtareas de su respuesta. */
const asentar = async (ms = 5): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
  await new Promise((r) => setTimeout(r, 0));
};

const ids = (prefijo = "req") => {
  let i = 0;
  return () => `${prefijo}-${String(++i).padStart(4, "0")}`;
};

const CONTRATO = {
  contractId: "answer:v1",
  schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" as const, maxLength: 200 } },
  },
  maxOutputTokens: 120,
};

const HERRAMIENTAS: ToolDescriptor[] = [
  {
    id: "buscar_factura",
    intents: ["buscar", "factura", "importe"],
    risk: "read",
    description: "Busca una factura por número, cliente o rango de fechas y devuelve su detalle completo.",
    parameters: { type: "object", properties: { numero: { type: "string" }, cliente: { type: "string" } } },
  },
  {
    id: "exportar_contabilidad",
    intents: ["exportar", "contabilidad", "asiento"],
    risk: "read",
    description:
      "Exporta los asientos contables de un periodo al formato del ERP, incluyendo desgloses de IVA, " +
      "retenciones, cuentas de contrapartida y el diario completo con todos sus apuntes.",
    parameters: { type: "object", properties: { desde: { type: "string" }, hasta: { type: "string" } } },
  },
  {
    id: "planificar_ruta_reparto",
    intents: ["ruta", "reparto", "logistica"],
    risk: "read",
    description:
      "Calcula la ruta óptima de reparto para una flota dada, con ventanas horarias, capacidad por " +
      "vehículo, restricciones de acceso urbano y previsión de tráfico.",
    parameters: { type: "object", properties: { vehiculos: { type: "array" }, paradas: { type: "array" } } },
  },
];

const tablaDeUsuarios = {
  users: Array.from({ length: 50 }, (_, i) => ({
    id: 1000 + i,
    name: `user_${i}`,
    role: i % 3 === 0 ? "admin" : "member",
    plan: i % 2 ? "pro" : "free",
    active: i % 4 !== 0,
  })),
};

let avisos: string[] = [];
let espia: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  reiniciarAvisos();
  avisos = [];
  espia = vi.spyOn(console, "warn").mockImplementation((m: unknown) => {
    avisos.push(String(m));
  });
});
afterEach(() => {
  espia.mockRestore();
  vi.useRealTimers();
});

// Con `maxTools`: el estrato `tokens_removed` de estas pruebas sale de la poda del
// selector, que desde 0.4.33 es opt-in.
const capa = (provider: Provider, extra: Partial<SavingsLayerConfig> = {}) =>
  createSavingsLayer({ provider, generateId: ids(), toolSelector: new ToolSelector({ maxTools: 8 }), ...extra });

describe("1 · sin `verification` no hay nada", () => {
  it("cero llamadas extra, sin bloque en el informe y sin aviso", async () => {
    const p = new ProveedorPuro();
    const r = await capa(p).generate({ model: MODELO, messages: [{ role: "user", content: "resume el informe" }] });
    await asentar();
    expect(p.llamadas).toHaveLength(1);
    expect(r.report.verification).toBeUndefined();
    expect(avisos.filter((a) => /verification/i.test(a))).toEqual([]);
  });
});

describe("2 · un valor inválido APAGA (nunca recorta) y avisa una vez", () => {
  const malos: Array<[string, unknown]> = [
    ["NaN", { sampleRate: Number.NaN }],
    ["negativo", { sampleRate: -1 }],
    ["mayor que 1", { sampleRate: 1.5 }],
    ["texto", { sampleRate: "0.1" }],
    ["50 (quería decir 50 %)", { sampleRate: 50 }],
    ["tope negativo", { sampleRate: 0.5, maxCheckCostUsd: -1 }],
  ];
  for (const [nombre, verification] of malos) {
    it(nombre, async () => {
      const p = new ProveedorPuro();
      const layer = capa(p, { verification: verification as SavingsLayerConfig["verification"] });
      const r = await layer.generate({ model: MODELO, messages: [{ role: "user", content: "hola qué tal" }] });
      await layer.generate({ model: MODELO, messages: [{ role: "user", content: "otra cosa distinta" }] });
      await asentar();
      expect(p.copias).toHaveLength(0);
      expect(r.report.verification).toBeUndefined();
      const w2 = avisos.filter((a) => a.includes("`verification.sampleRate` must be a number from 0 to 1"));
      expect(w2).toHaveLength(1);
      expect(w2[0]).toMatch(/verification sampling is OFF\.$/);
    });
  }

  it("`sampleRate: 0` es un apagado legítimo: sin aviso y sin bloque", async () => {
    const p = new ProveedorPuro();
    const r = await capa(p, { verification: { sampleRate: 0 } }).generate({
      model: MODELO,
      messages: [{ role: "user", content: "hola" }],
    });
    expect(r.report.verification).toBeUndefined();
    expect(avisos).toEqual([]);
  });
});

describe("3 · la copia es el brazo B0 del banco y sale DESPUÉS de servir", () => {
  const peticionRica = (): SavingsRequest => ({
    model: FUERTE,
    messages: [
      { role: "system", content: "Eres el asistente de facturación. Contesta en JSON." },
      { role: "user", content: "¿Cuál es el importe de la factura F-118?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "buscar_factura", arguments: '{"numero":"F-118"}' }],
      },
      { role: "tool", content: '{"importe": 118.5}', toolCallId: "call_1", name: "buscar_factura" },
    ],
    tools: HERRAMIENTAS,
    structuredData: { cliente: "ACME", pedido: 40218 },
    response: CONTRATO,
    temperature: 0,
    seed: 7,
    savings: { modelCascade: "on" },
  });

  it("una sola llamada extra, que empieza cuando la continuación del llamante ya corrió", async () => {
    const log: string[] = [];
    const p = new ProveedorPuro({ log });
    const checks: VerificationCheck[] = [];
    const layer = capa(p, { verification: { sampleRate: 1, onCheck: (c) => checks.push(c) }, silenceWarnings: true });
    const req = peticionRica();
    const r = await layer.generate(req);
    log.push("continuacion-del-llamante");
    await asentar();

    expect(p.copias).toHaveLength(1);
    expect(log.indexOf("copia")).toBeGreaterThan(log.indexOf("continuacion-del-llamante"));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.requestId).toBe(r.report.requestId);
  });

  it("es exactamente construirPeticionSinCapa: mensajes enteros, datos en línea, todas las herramientas, sin marcas", async () => {
    const p = new ProveedorPuro();
    const layer = capa(p, { verification: { sampleRate: 1, onCheck: () => {} }, silenceWarnings: true });
    const req = peticionRica();
    const r = await layer.generate(req);
    await asentar();
    const copia = p.copias[0]!;

    expect(copia).toEqual(construirPeticionSinCapa(req));
    // El modelo PEDIDO aunque la cascada haya servido el barato.
    expect(r.report.model).toBe(MODELO);
    expect(copia.model).toBe(FUERTE);
    // Mensajes enteros: el ciclo de herramientas sigue siendo válido.
    expect(copia.messages[2]!.toolCalls).toEqual([{ id: "call_1", name: "buscar_factura", arguments: '{"numero":"F-118"}' }]);
    expect(copia.messages[3]!.toolCallId).toBe("call_1");
    // Los datos, como un `user` con JSON compacto al final.
    expect(copia.messages.at(-1)).toEqual({ role: "user", content: JSON.stringify(req.structuredData) });
    expect(copia.tools).toEqual(HERRAMIENTAS);
    expect(copia.schema).toEqual(CONTRATO.schema);
    expect(copia.maxOutputTokens).toBe(120);
    expect(copia.temperature).toBe(0);
    expect(copia.seed).toBe(7);
    for (const clave of ["stablePrefixMessages", "promptCacheKey", "deferrable", "constraintBackend"]) {
      expect(copia).not.toHaveProperty(clave);
    }
    expect(r.report.verification).toEqual({ sampled: true, stratum: "cheaper_model" });
  });
});

describe("4 · la copia no contamina NADA de la capa", () => {
  // El guion: miss, acierto exacto, resolver, seguidor coalescido concurrente,
  // poda de herramientas, compresión y reparación. Dos capas gemelas —una con
  // verificación al 100 %, otra sin ella— tienen que servir lo MISMO.
  const guion: Array<SavingsRequest | [SavingsRequest, SavingsRequest]> = [
    { model: MODELO, messages: [{ role: "user", content: "Resume en una línea la política de devoluciones." }] },
    { model: MODELO, messages: [{ role: "user", content: "Resume en una línea la política de devoluciones." }] },
    { model: MODELO, messages: [{ role: "user", content: "What is 2 + 2 * 3?" }] },
    [
      { model: MODELO, messages: [{ role: "user", content: "Dame tres ideas para el boletín de octubre." }] },
      { model: MODELO, messages: [{ role: "user", content: "Dame tres ideas para el boletín de octubre." }] },
    ],
    {
      model: MODELO,
      messages: [{ role: "user", content: "¿Cuál es el importe de la factura F-118?" }],
      tools: HERRAMIENTAS,
      savings: { exactCache: false },
    },
    { model: MODELO, messages: [{ role: "user", content: "Summarize the attached user table." }], structuredData: tablaDeUsuarios },
    {
      model: MODELO,
      messages: [{ role: "user", content: "REPARA: devuelve la respuesta en JSON." }],
      response: CONTRATO,
    },
  ];

  // La reparación: el primer intento (último mensaje del cliente) sale roto.
  const ajuste = (req: ProviderRequest): Partial<ProviderResponse> =>
    req.messages.at(-1)?.content.startsWith("REPARA") ? { text: "{roto" } : {};

  const sinRuido = (rep: SavingsReport): unknown => {
    const { verification: _v, latencyMs: _l, traces, ...resto } = rep;
    return { ...resto, traces: traces.map(({ atMs: _a, ...t }) => t) };
  };

  async function correr(layer: ReturnType<typeof createSavingsLayer>): Promise<SavingsResult[]> {
    const out: SavingsResult[] = [];
    for (const paso of guion) {
      if (Array.isArray(paso)) {
        out.push(...(await Promise.all(paso.map((q) => layer.generate(q)))));
      } else {
        out.push(await layer.generate(paso));
      }
      await asentar(8);
    }
    // Al final, el acierto exacto del primer paso otra vez.
    out.push(await layer.generate(guion[0] as SavingsRequest));
    return out;
  }

  it("los informes servidos son iguales en profundidad, salvo `verification`, la latencia y los `atMs`", async () => {
    const pA = new ProveedorPuro({ retraso: 2, ajuste });
    const pB = new ProveedorPuro({ retraso: 2, ajuste });
    const checks: VerificationCheck[] = [];
    const comun = { now: () => 1_790_000_000_000, silenceWarnings: true };
    const A = capa(pA, { ...comun, verification: { sampleRate: 1, onCheck: (c) => checks.push(c) } });
    const B = capa(pB, comun);
    const rA = await correr(A);
    const rB = await correr(B);

    expect(rA).toHaveLength(rB.length);
    for (let i = 0; i < rA.length; i++) {
      expect(rA[i]!.text, `paso ${i}`).toBe(rB[i]!.text);
      expect(sinRuido(rA[i]!.report), `paso ${i}`).toEqual(sinRuido(rB[i]!.report));
      expect(rA[i]!.report.verification, `paso ${i}`).toBeDefined();
      expect(rB[i]!.report.verification).toBeUndefined();
    }
    // Lo que sirvió la capa gemela es lo que sirvió ésta: las copias fueron aparte.
    expect(pA.servidas).toEqual(pB.servidas);
    // Cada paso cubrió su estrato.
    const estratos = new Set(rA.map((r) => r.report.verification?.stratum));
    for (const e of ["unchanged", "avoided_call", "tokens_removed", "tokens_compressed"]) {
      expect(estratos, e).toContain(e);
    }
    expect(rA.map((r) => r.report.cache.result)).toContain("singleflight");
    expect(rA.map((r) => r.report.cache.result)).toContain("exact");
    // El acierto exacto final sirve el texto SERVIDO, nunca el de la copia.
    expect(rA.at(-1)!.report.cache.result).toBe("exact");
    expect(rA.at(-1)!.text).toBe(rA[0]!.text);
    const textosDeCopias = await Promise.all(pA.copias.map((c) => new ProveedorPuro({ ajuste }).generate(c)));
    expect(textosDeCopias.map((t) => t.text)).not.toContain(rA[0]!.text);
    expect(checks.length).toBeGreaterThan(5);
  });
});

describe("5 · los dos lados del par salen del contador del proveedor", () => {
  it("naive = precioDelUso(uso de la copia, precio del modelo pedido); optimized = report.cost.actual", async () => {
    const p = new ProveedorPuro();
    const checks: VerificationCheck[] = [];
    const layer = capa(p, { verification: { sampleRate: 1, onCheck: (c) => checks.push(c) }, silenceWarnings: true });
    const r = await layer.generate({
      model: MODELO,
      messages: [{ role: "user", content: "¿Cuál es el importe de la factura F-118?" }],
      tools: HERRAMIENTAS,
    });
    await asentar();
    const c = checks[0]!;
    const usoDeLaCopia = (await new ProveedorPuro().generate(p.copias[0]!)).usage;
    expect(c.outcome).toBe("paired");
    expect(c.naive!.cost).toBe(precioDelUso(usoDeLaCopia, precioDeLista("gpt-4o-mini")!));
    expect(c.naive!.inputTokens).toBe(usoDeLaCopia.inputTokens);
    expect(c.optimized.cost).toBe(r.report.cost.actual);
    expect(c.optimized.inputTokens).toBe(r.report.tokens.actualInput);
    expect(c.stratum).toBe("tokens_removed");
    // La copia lleva las tres herramientas; la servida, menos.
    expect(c.naive!.inputTokens).toBeGreaterThan(c.optimized.inputTokens);
  });

  it("en una evitada, optimized.cost es 0", async () => {
    const checks: VerificationCheck[] = [];
    const layer = capa(new ProveedorPuro(), {
      verification: { sampleRate: 1, onCheck: (c) => checks.push(c) },
      silenceWarnings: true,
    });
    await layer.generate({ model: MODELO, messages: [{ role: "user", content: "What is 2 + 2 * 3?" }] });
    await asentar();
    expect(checks[0]!.stratum).toBe("avoided_call");
    expect(checks[0]!.optimized).toEqual({ cost: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    expect(checks[0]!.naive!.cost).toBeGreaterThan(0);
  });
});

describe("6 · cada exclusión: su motivo, cero copias y su conteo", () => {
  /** Una capa con emisor de verdad (fetch falso), para leer los conteos del sobre. */
  function conEmisor(provider: Provider, extra: Partial<SavingsLayerConfig> = {}) {
    const sobres: Array<{ counts: Array<{ category: string; requests: number }>; samples: unknown[] }> = [];
    const fetchFalso = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/metering/verification")) sobres.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const layer = capa(provider, {
      serviceAccountKey: "bvk_prueba",
      licenseServerUrl: "https://savings.example.test",
      meteringFetch: fetchFalso,
      silenceWarnings: true,
      ...extra,
    });
    return { layer, sobres };
  }
  const conteos = (sobres: Array<{ counts: Array<{ category: string; requests: number }> }>) => {
    const m: Record<string, number> = {};
    for (const s of sobres) for (const c of s.counts) m[c.category] = (m[c.category] ?? 0) + c.requests;
    return m;
  };

  const casos: Array<{
    motivo: string;
    peticion: SavingsRequest;
    ajuste?: (req: ProviderRequest, esCopia: boolean) => Partial<ProviderResponse>;
    extra?: Partial<SavingsLayerConfig>;
  }> = [
    {
      motivo: "fail_open",
      peticion: { model: MODELO, messages: [{ role: "user", content: "hola" }] },
      extra: {
        exactCache: {
          get() {
            throw new Error("boom: fallo interno del optimizador");
          },
          async set() {},
          async delete() {},
        },
      },
    },
    { motivo: "opted_out", peticion: { model: MODELO, messages: [{ role: "user", content: "hola" }], savings: { verification: false } } },
    { motivo: "truncated", peticion: { model: MODELO, messages: [{ role: "user", content: "hola" }] }, ajuste: () => ({ finishReason: "length" }) },
    { motivo: "incomplete", peticion: { model: MODELO, messages: [{ role: "user", content: "hola" }] }, ajuste: () => ({ finishReason: "content_filter" }) },
    {
      motivo: "contract_failed",
      peticion: { model: MODELO, messages: [{ role: "user", content: "hola" }], response: CONTRATO },
      ajuste: () => ({ text: "{roto" }),
    },
    {
      motivo: "unmeasured",
      peticion: { model: MODELO, messages: [{ role: "user", content: "hola" }] },
      ajuste: () => ({ usage: { inputTokens: 0, outputTokens: 0, complete: false } }),
    },
    { motivo: "no_price", peticion: { model: "acme/modelo-casero-sin-precio", messages: [{ role: "user", content: "hola" }] } },
    {
      motivo: "over_cap",
      peticion: { model: MODELO, messages: [{ role: "user", content: "hola" }] },
      extra: { verification: { sampleRate: 1, maxCheckCostUsd: 1e-12 } },
    },
    {
      motivo: "retrieval",
      peticion: {
        model: MODELO,
        messages: [{ role: "user", content: "¿Qué dice el informe anual sobre la política de devoluciones?" }],
        retrieval: { mode: "single" },
      },
      extra: {
        retriever: {
          async retrieve() {
            return [{ id: "doc-1", text: "La política de devoluciones admite 30 días.", score: 0.9 }];
          },
        },
      },
    },
  ];

  for (const caso of casos) {
    it(caso.motivo, async () => {
      const p = new ProveedorPuro(caso.ajuste ? { ajuste: caso.ajuste } : {});
      const { layer, sobres } = conEmisor(p, { verification: { sampleRate: 1 }, ...caso.extra });
      const r = await layer.generate(caso.peticion);
      await asentar();
      layer.close();
      await asentar();
      expect(r.report.verification).toEqual({ sampled: true, excluded: caso.motivo });
      expect(p.copias).toHaveLength(0);
      expect(conteos(sobres)).toEqual({ [caso.motivo]: 1 });
      expect(sobres.flatMap((s) => s.samples)).toEqual([]);
    });
  }

  it("el orden de las reglas: fail-open gana a todo, luego la exclusión manual", () => {
    const base = {
      request: { model: MODELO, messages: [], savings: { verification: false } } as SavingsRequest,
      result: {
        requestId: "x",
        data: undefined,
        text: "",
        finishReason: "length",
        report: {
          model: MODELO,
          calls: { avoidedLlm: 0, actualRetrieval: 1 },
          constraints: { structurallyValid: false },
          cost: { basis: "unmeasured", baselineEstimate: 1 },
          tokens: { eliminatedInput: 0, compressedInput: 0 },
        },
      } as unknown as SavingsResult,
      precio: () => undefined,
    };
    expect(clasificar({ ...base, via: "fail-open" })).toEqual({ excluida: "fail_open" });
    expect(clasificar({ ...base, via: "optimizado" })).toEqual({ excluida: "opted_out" });
  });
});

describe("7 · la copia se congela al decidir", () => {
  it("`messages.push(respuesta)` justo después del `await` no la cambia", async () => {
    const p = new ProveedorPuro();
    const layer = capa(p, { verification: { sampleRate: 1, onCheck: () => {} }, silenceWarnings: true });
    const messages: SavingsRequest["messages"] = [{ role: "user", content: "Escribe un haiku sobre el otoño." }];
    const r = await layer.generate({ model: MODELO, messages });
    messages.push({ role: "assistant", content: r.text });
    messages.push({ role: "user", content: "Ahora otro sobre el invierno." });
    await asentar();
    expect(p.copias[0]!.messages).toEqual([{ role: "user", content: "Escribe un haiku sobre el otoño." }]);
  });
});

describe("8-9 · la copia falla o vuelve sin contador", () => {
  it("el proveedor lanza en la copia → check_failed, y ningún rechazo sin manejar", async () => {
    const sinManejar: unknown[] = [];
    const oyente = (e: unknown) => sinManejar.push(e);
    process.on("unhandledRejection", oyente);
    try {
      const p = new ProveedorPuro({ ajuste: (_r, esCopia) => (esCopia ? ("lanza" as never) : {}) });
      const checks: VerificationCheck[] = [];
      const layer = capa(p, { verification: { sampleRate: 1, onCheck: (c) => checks.push(c) }, silenceWarnings: true });
      const r = await layer.generate({ model: MODELO, messages: [{ role: "user", content: "hola" }] });
      await asentar(20);
      expect(r.text).toMatch(/^ans-/);
      expect(checks.map((c) => c.outcome)).toEqual(["check_failed"]);
      expect(checks[0]!.naive).toBeUndefined();
      expect(sinManejar).toEqual([]);
    } finally {
      process.off("unhandledRejection", oyente);
    }
  });

  for (const [nombre, uso] of [
    ["uso incompleto", { inputTokens: 50, outputTokens: 5, complete: false }],
    ["uso a cero", { inputTokens: 0, outputTokens: 0 }],
    ["contador no finito", { inputTokens: Number.NaN, outputTokens: 5 }],
  ] as const) {
    it(`${nombre} → check_unmeasured`, async () => {
      const p = new ProveedorPuro({ ajuste: (_r, esCopia) => (esCopia ? { usage: { ...uso } } : {}) });
      const checks: VerificationCheck[] = [];
      const layer = capa(p, { verification: { sampleRate: 1, onCheck: (c) => checks.push(c) }, silenceWarnings: true });
      await layer.generate({ model: MODELO, messages: [{ role: "user", content: "hola" }] });
      await asentar();
      expect(checks.map((c) => c.outcome)).toEqual(["check_unmeasured"]);
    });
  }
});

describe("10 · close() no deja pares en vuelo sin decidir", () => {
  it("decide `abandoned` en el acto, aborta la señal, y nada llega después", async () => {
    let soltar: ((r: ProviderResponse) => void) | undefined;
    const senales: AbortSignal[] = [];
    const p: Provider = {
      id: "manual",
      async generate(_req, options) {
        if (!options?.signal) return { text: "servida", usage: { inputTokens: 40, outputTokens: 5 }, finishReason: "stop" };
        senales.push(options.signal);
        return new Promise<ProviderResponse>((res) => {
          soltar = res; // no atiende la señal: la respuesta tardía llega igual
        });
      },
    };
    const checks: VerificationCheck[] = [];
    const layer = capa(p, { verification: { sampleRate: 1, onCheck: (c) => checks.push(c) }, silenceWarnings: true });
    await layer.generate({ model: MODELO, messages: [{ role: "user", content: "hola" }] });
    await asentar();
    expect(senales).toHaveLength(1);
    expect(checks).toEqual([]);

    layer.close();
    // Síncrono: sin un solo `await` de por medio.
    expect(checks.map((c) => c.outcome)).toEqual(["abandoned"]);
    expect(senales[0]!.aborted).toBe(true);

    soltar!({ text: "tarde", usage: { inputTokens: 90, outputTokens: 9 }, finishReason: "stop" });
    await asentar();
    expect(checks.map((c) => c.outcome)).toEqual(["abandoned"]);
  });

  it("una copia que aún no había salido no llega a llamar al proveedor", async () => {
    const p = new ProveedorPuro();
    const checks: VerificationCheck[] = [];
    const layer = capa(p, { verification: { sampleRate: 1, onCheck: (c) => checks.push(c) }, silenceWarnings: true });
    await layer.generate({ model: MODELO, messages: [{ role: "user", content: "hola" }] });
    layer.close(); // antes del setTimeout(0)
    await asentar();
    expect(p.copias).toHaveLength(0);
    expect(checks.map((c) => c.outcome)).toEqual(["abandoned"]);
  });

  it("después de cerrar no se decide nada más: el resultado sale intacto y sin bloque", async () => {
    const p = new ProveedorPuro();
    const layer = capa(p, { verification: { sampleRate: 1, onCheck: () => {} }, silenceWarnings: true });
    layer.close();
    const r = await layer.generate({ model: MODELO, messages: [{ role: "user", content: "hola" }] });
    await asentar();
    expect(r.report.verification).toBeUndefined();
    expect(p.copias).toHaveLength(0);
  });
});

describe("11 · el muestreo es Bernoulli por requestId", () => {
  it("estable con `generateId` inyectado", async () => {
    const decisiones = async () => {
      const layer = capa(new ProveedorPuro(), { verification: { sampleRate: 0.5, onCheck: () => {} }, silenceWarnings: true });
      const out: boolean[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await layer.generate({ model: MODELO, messages: [{ role: "user", content: `pregunta ${i}` }], savings: { exactCache: false } });
        out.push(r.report.verification!.sampled);
      }
      layer.close();
      return out;
    };
    expect(await decisiones()).toEqual(await decisiones());
  });

  it("5000 ids a r = 0,1 → entre 400 y 600 muestreados", () => {
    let n = 0;
    for (let i = 0; i < 5000; i++) if (enLaMuestraDeVerificacion(`id-${i}-${i * 7919}`, 0.1)) n++;
    expect(n).toBeGreaterThanOrEqual(400);
    expect(n).toBeLessThanOrEqual(600);
  });

  it("dos peticiones idénticas con ids distintos pueden recibir decisiones distintas (no es un hash del contenido)", async () => {
    let dentro: string | undefined;
    let fuera: string | undefined;
    for (let i = 0; i < 200 && (!dentro || !fuera); i++) {
      const id = `mismo-contenido-${i}`;
      if (enLaMuestraDeVerificacion(id, 0.5)) dentro ??= id;
      else fuera ??= id;
    }
    const cola = [dentro!, fuera!];
    const layer = createSavingsLayer({
      provider: new ProveedorPuro(),
      generateId: () => cola.shift()!,
      verification: { sampleRate: 0.5, onCheck: () => {} },
      silenceWarnings: true,
    });
    const q: SavingsRequest = { model: MODELO, messages: [{ role: "user", content: "idéntica" }], savings: { exactCache: false } };
    const a = await layer.generate(q);
    const b = await layer.generate(q);
    layer.close();
    expect(a.report.verification!.sampled).toBe(true);
    expect(b.report.verification!.sampled).toBe(false);
  });
});

describe("12 · sin destino no se gasta", () => {
  it("sin emisor ni onCheck → W3 y cero copias", async () => {
    const p = new ProveedorPuro();
    const r = await capa(p, { verification: { sampleRate: 1 } }).generate({
      model: MODELO,
      messages: [{ role: "user", content: "hola" }],
    });
    await asentar();
    expect(p.copias).toHaveLength(0);
    expect(r.report.verification).toBeUndefined();
    expect(avisos.filter((a) => a.startsWith("[bvsala] Verification sampling is set, but its pairs have nowhere to go"))).toHaveLength(1);
    expect(avisos.some((a) => a.includes("Verification sampling is ON"))).toBe(false);
  });

  it("con la medición apagada tampoco hay destino", async () => {
    const p = new ProveedorPuro();
    await capa(p, {
      verification: { sampleRate: 1 },
      serviceAccountKey: "bvk_prueba",
      licenseServerUrl: "https://savings.example.test",
      metering: { enabled: false },
    }).generate({ model: MODELO, messages: [{ role: "user", content: "hola" }] });
    await asentar();
    expect(p.copias).toHaveLength(0);
    expect(avisos.some((a) => a.includes("nowhere to go"))).toBe(true);
  });

  it("con onCheck y sin destino, funciona", async () => {
    const p = new ProveedorPuro();
    const checks: VerificationCheck[] = [];
    await capa(p, { verification: { sampleRate: 1, onCheck: (c) => checks.push(c) } }).generate({
      model: MODELO,
      messages: [{ role: "user", content: "hola" }],
    });
    await asentar();
    expect(p.copias).toHaveLength(1);
    expect(checks.map((c) => c.outcome)).toEqual(["paired"]);
  });
});

describe("13 · el aviso W1, exacto", () => {
  it("r = 0,02 → «2%» y r = 0,005 → «0.5%»", () => {
    capa(new ProveedorPuro(), { verification: { sampleRate: 0.02, onCheck: () => {} } });
    capa(new ProveedorPuro(), { verification: { sampleRate: 0.005, onCheck: () => {} } });
    expect(avisos).toEqual([
      "[bvsala] Verification sampling is ON (sampleRate 0.02): about 2% of eligible requests are sent a second time, unoptimized, to your own provider — in the background, after your answer is returned — and the second answer is discarded. You pay your provider for those calls: roughly 2% of what that traffic would cost without the layer. The pairs appear under Proof › Your bench in your dashboard; they are informational and never enter your statement or any commission.",
      "[bvsala] Verification sampling is ON (sampleRate 0.005): about 0.5% of eligible requests are sent a second time, unoptimized, to your own provider — in the background, after your answer is returned — and the second answer is discarded. You pay your provider for those calls: roughly 0.5% of what that traffic would cost without the layer. The pairs appear under Proof › Your bench in your dashboard; they are informational and never enter your statement or any commission.",
    ]);
    expect(avisoDeVerificacionActiva(0.07)).toContain("about 7% of eligible");
    expect(avisoDeVerificacionActiva(0.0125)).toContain("about 1.25% of eligible");
  });

  it("`silenceWarnings` los calla todos", () => {
    capa(new ProveedorPuro(), { verification: { sampleRate: 0.02, onCheck: () => {} }, silenceWarnings: true });
    capa(new ProveedorPuro(), { verification: { sampleRate: 2 }, silenceWarnings: true });
    capa(new ProveedorPuro(), { verification: { sampleRate: 0.1 }, silenceWarnings: true });
    expect(avisos).toEqual([]);
  });
});

describe("14 · waitUntil para serverless", () => {
  it("recibe una promesa que se resuelve después del evento y del envío del emisor, y nunca rechaza", async () => {
    const orden: string[] = [];
    const promesas: Array<Promise<void>> = [];
    const fetchFalso = (async (url: string) => {
      if (String(url).endsWith("/api/metering/verification")) {
        await new Promise((r) => setTimeout(r, 3));
        orden.push("post");
      }
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const layer = capa(new ProveedorPuro({ ajuste: (_r, esCopia) => (esCopia ? ("lanza" as never) : {}) }), {
      serviceAccountKey: "bvk_prueba",
      licenseServerUrl: "https://savings.example.test",
      meteringFetch: fetchFalso,
      silenceWarnings: true,
      verification: {
        sampleRate: 1,
        onCheck: (c) => orden.push(`evento:${c.outcome}`),
        waitUntil: (p) => promesas.push(p),
      },
    });
    await layer.generate({ model: MODELO, messages: [{ role: "user", content: "hola" }] });
    expect(promesas).toHaveLength(1);
    await expect(promesas[0]).resolves.toBeUndefined();
    orden.push("resuelta");
    expect(orden).toEqual(["evento:check_failed", "post", "resuelta"]);
    layer.close();
  });
});

describe("15 · topes: 32 en vuelo y 10 minutos", () => {
  it("la 33.ª muestreada elegible sale `dropped`, sin llamada", async () => {
    const p = new ProveedorPuro({ ajuste: (_r, esCopia) => (esCopia ? ("cuelga" as never) : {}) });
    const checks: VerificationCheck[] = [];
    const layer = capa(p, { verification: { sampleRate: 1, onCheck: (c) => checks.push(c) }, silenceWarnings: true });
    for (let i = 0; i < 33; i++) {
      await layer.generate({ model: MODELO, messages: [{ role: "user", content: `pregunta ${i}` }] });
    }
    await asentar();
    expect(p.copias).toHaveLength(32);
    expect(checks.map((c) => c.outcome)).toEqual(["dropped"]);
    layer.close();
    expect(checks.filter((c) => c.outcome === "abandoned")).toHaveLength(32);
  });

  it("a los 10 minutos: check_failed y la señal abortada", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const senales: AbortSignal[] = [];
    const p: Provider = {
      id: "lento",
      async generate(_req, options) {
        if (!options?.signal) return { text: "servida", usage: { inputTokens: 40, outputTokens: 5 }, finishReason: "stop" };
        senales.push(options.signal);
        return new Promise<ProviderResponse>(() => {});
      },
    };
    const checks: VerificationCheck[] = [];
    const layer = capa(p, { verification: { sampleRate: 1, onCheck: (c) => checks.push(c) }, silenceWarnings: true });
    await layer.generate({ model: MODELO, messages: [{ role: "user", content: "hola" }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(senales).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(599_998);
    expect(checks).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(checks.map((c) => c.outcome)).toEqual(["check_failed"]);
    expect(senales[0]!.aborted).toBe(true);
    layer.close();
    expect(checks).toHaveLength(1);
  });
});

describe("16 · generateStream decide una vez", () => {
  class ProveedorStream extends ProveedorPuro {
    async *generateStream(req: ProviderRequest, options?: ProviderStreamOptions): AsyncGenerator<ProviderStreamEvent> {
      const r = await this.generate(req);
      for (const trozo of r.text.match(/.{1,4}/g) ?? []) {
        if (options?.signal?.aborted) return;
        yield { type: "text", delta: trozo };
        await new Promise((res) => setTimeout(res, 1));
      }
      yield { type: "done", response: r };
    }
  }

  it("en vivo: un bloque, una copia", async () => {
    const p = new ProveedorStream();
    const checks: VerificationCheck[] = [];
    const layer = capa(p, { verification: { sampleRate: 1, onCheck: (c) => checks.push(c) }, silenceWarnings: true });
    const s = layer.generateStream({ model: MODELO, messages: [{ role: "user", content: "cuéntame algo" }] });
    for await (const _e of s) {
      /* consumir */
    }
    const r = await s.result;
    await asentar();
    expect(r.report.streaming?.delivery).toBe("live");
    expect(r.report.verification).toEqual({ sampled: true, stratum: "unchanged" });
    expect(checks).toHaveLength(1);
    expect(p.copias).toHaveLength(1);
  });

  it("entera (con contrato): pasa por generate() y no decide dos veces", async () => {
    const p = new ProveedorStream();
    const checks: VerificationCheck[] = [];
    const layer = capa(p, { verification: { sampleRate: 1, onCheck: (c) => checks.push(c) }, silenceWarnings: true });
    const s = layer.generateStream({ model: MODELO, messages: [{ role: "user", content: "hola" }], response: CONTRATO });
    const r = await s.result;
    await asentar();
    expect(r.report.streaming?.delivery).toBe("whole");
    expect(r.report.verification?.sampled).toBe(true);
    expect(checks).toHaveLength(1);
    expect(p.copias).toHaveLength(1);
  });

  it("un stream abortado no cuenta ni copia", async () => {
    const p = new ProveedorStream();
    const checks: VerificationCheck[] = [];
    const sobres: Array<{ counts: unknown[] }> = [];
    const fetchFalso = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/metering/verification")) sobres.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const layer = capa(p, {
      serviceAccountKey: "bvk_prueba",
      licenseServerUrl: "https://savings.example.test",
      meteringFetch: fetchFalso,
      verification: { sampleRate: 1, onCheck: (c) => checks.push(c) },
      silenceWarnings: true,
    });
    const s = layer.generateStream({
      model: MODELO,
      messages: [{ role: "user", content: "una respuesta larga que se cortará a medias" }],
    });
    for await (const _e of s) {
      s.abort();
    }
    await expect(s.result).rejects.toThrow();
    await asentar();
    layer.close();
    await asentar();
    expect(checks).toEqual([]);
    expect(p.copias).toHaveLength(0);
    expect(sobres.flatMap((x) => x.counts)).toEqual([]);
  });
});

describe("17 · ante cualquier fallo, el resultado servido queda intacto", () => {
  it("un onCheck que lanza no toca nada", async () => {
    const p = new ProveedorPuro();
    const layer = capa(p, {
      verification: {
        sampleRate: 1,
        onCheck: () => {
          throw new Error("el callback del cliente revienta");
        },
      },
      silenceWarnings: true,
    });
    const r = await layer.generate({ model: MODELO, messages: [{ role: "user", content: "hola" }] });
    await asentar();
    expect(r.text).toMatch(/^ans-/);
    expect(r.report.verification).toEqual({ sampled: true, stratum: "unchanged" });
  });

  it("un precio que lanza devuelve el MISMO objeto, sin bloque, y avisa una vez", async () => {
    const avisados: string[] = [];
    const comprobador = new ComprobadorAB({
      ajustes: { activo: true, tasa: 1 },
      provider: new ProveedorPuro(),
      precio: () => {
        throw new Error("tabla de precios rota");
      },
      contrato: () => "none",
      now: () => 1_790_000_000_000,
      sumidero: { encolar: () => {}, enReposo: () => {} },
      avisar: (_k, m) => avisados.push(m),
    });
    const servido = await capa(new ProveedorPuro()).generate({ model: MODELO, messages: [{ role: "user", content: "hola" }] });
    const antes = JSON.stringify(servido);
    const r = comprobador.decidir({ model: MODELO, messages: [{ role: "user", content: "hola" }] }, servido, "optimizado");
    expect(r).toBe(servido);
    expect(JSON.stringify(servido)).toBe(antes);
    expect(avisados).toEqual([
      "[bvsala] verification sampling hit an internal error and skipped a request; your request was not affected.",
    ]);
  });

  it("decidir nunca muta el resultado recibido (el del líder de singleflight es compartido)", async () => {
    const comprobador = new ComprobadorAB({
      ajustes: { activo: true, tasa: 1 },
      provider: new ProveedorPuro(),
      precio: (m) => precioDeLista(m),
      contrato: () => "none",
      now: () => 1_790_000_000_000,
      sumidero: { encolar: () => {}, enReposo: () => {} },
      avisar: () => {},
    });
    const servido = await capa(new ProveedorPuro()).generate({ model: MODELO, messages: [{ role: "user", content: "hola" }] });
    const congelado = structuredClone(servido);
    const r = comprobador.decidir({ model: MODELO, messages: [{ role: "user", content: "hola" }] }, servido, "optimizado");
    comprobador.cerrar();
    expect(r).not.toBe(servido);
    expect(r.report).not.toBe(servido.report);
    expect(servido).toEqual(congelado);
    expect(r.report.verification).toEqual({ sampled: true, stratum: "unchanged" });
  });
});

describe("18 · el uso que se mide no cambia", () => {
  it("la copia no pasa por el emisor de uso: un registro por petición SERVIDA, ni uno más", async () => {
    const usos: Array<Record<string, unknown>> = [];
    const fetchFalso = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/metering/usage")) usos.push(...(JSON.parse(String(init?.body)) as Array<Record<string, unknown>>));
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const p = new ProveedorPuro();
    const layer = capa(p, {
      serviceAccountKey: "bvk_prueba",
      licenseServerUrl: "https://savings.example.test",
      meteringFetch: fetchFalso,
      silenceWarnings: true,
      verification: { sampleRate: 1 },
    });
    const servidas = [];
    for (const q of ["uno", "dos", "tres"]) {
      servidas.push(await layer.generate({ model: MODELO, messages: [{ role: "user", content: `resume el punto ${q}` }] }));
    }
    await asentar();
    expect(p.copias).toHaveLength(3);
    layer.close();
    await asentar();
    expect(usos.map((u) => u["requestId"])).toEqual(servidas.map((r) => r.report.requestId));
    expect(usos.every((u) => u["basis"] !== "verification")).toBe(true);
  });

  it("`toWire` de un informe con `verification` produce las mismas claves que sin él", async () => {
    const r = await capa(new ProveedorPuro(), { verification: { sampleRate: 1, onCheck: () => {} }, silenceWarnings: true }).generate({
      model: MODELO,
      messages: [{ role: "user", content: "hola" }],
    });
    expect(r.report.verification).toBeDefined();
    const emisor = new UsageEmitter({ url: "https://x.test/api/metering/usage", serviceAccountKey: "bvk_x" });
    const toWire = (emisor as unknown as { toWire: (e: { report: SavingsReport; at: number }) => Record<string, unknown> }).toWire.bind(emisor);
    const { verification: _v, ...sin } = r.report;
    const con = toWire({ report: r.report, at: 1 });
    expect(Object.keys(con).sort()).toEqual(Object.keys(toWire({ report: sin as SavingsReport, at: 1 })).sort());
    expect(JSON.stringify(con)).not.toMatch(/verification|sampled|stratum/);
  });
});
