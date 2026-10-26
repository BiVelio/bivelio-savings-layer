import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemorySemanticCache } from "../src/cache/semantic.js";
import { canonicalize } from "../src/canonicalization/canonicalize.js";
import { evaluatePolicy } from "../src/policy/policy.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import { CALIBRACION_DE_PRUEBA, certificarRespuestaSemantica } from "./helpers/semantic-cache.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { ChatMessage, SavingsRequest, SavingsToggles, ToolDescriptor } from "../src/contracts/types.js";

/**
 * LA CACHÉ SEMÁNTICA SE APARTA DEL TRÁFICO AGÉNTICO SALVO QUE SE PIDA.
 *
 * LiteLLM lo dice sin rodeos («Semantic caching is designed for single-shot
 * prompts. On multi-turn or agentic traffic it will replay stale responses.»,
 * https://docs.litellm.ai/docs/proxy/caching_semantic, 2026-09-27). Aquí el
 * fallo que describen —cada turno casa con el anterior— ya estaba bloqueado por
 * `keyTokensMatch` (mismo número de turnos y roles), pero entre ejecuciones dos
 * historias iguales salvo en lo que devolvió una herramienta pasaban la verja.
 *
 * Y el filtro duro no miraba el catálogo de herramientas ni el muestreo, aunque
 * su JSDoc prometía la misma identidad que la clave exacta. Este fichero fija
 * las dos cosas: el veto por defecto con su salida explícita, y la identidad.
 */

const PRECIOS = { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } };

class ProveedorFijo implements Provider {
  readonly id = "fijo";
  llamadas = 0;
  constructor(private readonly texto = "the answer") {}
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas++;
    return { text: this.texto, usage: { inputTokens: 100, outputTokens: 10 }, finishReason: "stop" };
  }
}

// Embebedor de juguete (el de estado-de-calidad): cuenta caracteres por clase,
// así que reordenar las palabras da el MISMO vector. Lo que se prueba es la
// política y la identidad, no la calidad del embebedor.
const embed = async (t: string): Promise<number[]> =>
  [0, 1, 2, 3].map((i) => [...t].filter((c) => c.charCodeAt(0) % 4 === i).length);

const nuevaCache = () =>
  new InMemorySemanticCache({ embed, similarityThreshold: 0.3, acceptThreshold: 0.3, calibration: CALIBRACION_DE_PRUEBA });

const LECTURA: ToolDescriptor = { id: "search_docs", intents: ["search the docs"], risk: "read" };
const OTRA_LECTURA: ToolDescriptor = { id: "read_wiki", intents: ["read the wiki"], risk: "read" };
const ESCRITURA: ToolDescriptor = { id: "send_report", intents: ["send the report"], risk: "write" };

const PREGUNTA = "explain the coalescing mechanism briefly";
const REFORMULADA = "explain briefly the coalescing mechanism";

function peticion(
  mensajes: ChatMessage[],
  savings: SavingsToggles,
  extra: Partial<SavingsRequest> = {},
): SavingsRequest {
  return {
    model: "openai/gpt-4o-mini",
    messages: mensajes,
    savings: { exactCache: false, singleflight: false, ...savings },
    context: { tenantId: "acme" },
    ...extra,
  };
}

async function generarYCertificar(
  capa: ReturnType<typeof createSavingsLayer>,
  cache: InMemorySemanticCache,
  request: SavingsRequest,
  agentic = false,
): Promise<void> {
  const primera = await capa.generate(request);
  await certificarRespuestaSemantica(cache, request, primera, { agentic });
}

/** Las cuatro formas de tráfico agéntico, cada una con su reformulación. */
const FORMAS: { nombre: string; original: ChatMessage[]; reformulada: ChatMessage[]; tools?: ToolDescriptor[] }[] = [
  {
    nombre: "declara herramientas (de solo lectura)",
    original: [{ role: "user", content: PREGUNTA }],
    reformulada: [{ role: "user", content: REFORMULADA }],
    tools: [LECTURA],
  },
  {
    nombre: "lleva un resultado de herramienta (role: tool)",
    original: [
      { role: "user", content: PREGUNTA },
      { role: "tool", content: "docs say it merges identical requests", toolCallId: "c1" },
    ],
    reformulada: [
      { role: "user", content: REFORMULADA },
      { role: "tool", content: "docs say it merges identical requests", toolCallId: "c1" },
    ],
  },
  {
    nombre: "lleva una llamada a herramienta del asistente (assistant.toolCalls)",
    original: [
      { role: "user", content: PREGUNTA },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "search_docs", arguments: "{}" }] },
    ],
    reformulada: [
      { role: "user", content: REFORMULADA },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "search_docs", arguments: "{}" }] },
    ],
  },
  {
    nombre: "tiene dos turnos de usuario",
    original: [
      { role: "user", content: PREGUNTA },
      { role: "assistant", content: "it merges identical requests" },
      { role: "user", content: "give an example please" },
    ],
    reformulada: [
      { role: "user", content: REFORMULADA },
      { role: "assistant", content: "it merges identical requests" },
      { role: "user", content: "give an example please" },
    ],
  },
];

describe("la política: qué es tráfico agéntico", () => {
  for (const f of FORMAS) {
    it(`${f.nombre} → isAgentic, semántica apagada y la razón dicha`, () => {
      const pol = evaluatePolicy(
        canonicalize(peticion(f.original, { semanticCache: true }, f.tools ? { tools: f.tools } : {})),
      );
      expect(pol.isAgentic).toBe(true);
      expect(pol.allowSemanticCache).toBe(false);
      expect(pol.reasons.join("; ")).toMatch(/agentic request .* semantic cache off by default/);
    });
  }

  it("single-shot (system + user) NO es agéntico y la semántica sigue permitida", () => {
    const pol = evaluatePolicy(
      canonicalize(
        peticion(
          [
            { role: "system", content: "you are a helpful assistant" },
            { role: "user", content: PREGUNTA },
          ],
          { semanticCache: true },
        ),
      ),
    );
    expect(pol.isAgentic).toBe(false);
    expect(pol.allowSemanticCache).toBe(true);
    expect(pol.reasons.join("; ")).not.toMatch(/agentic/);
  });

  it('"include-agentic" levanta SOLO ese veto: con herramienta de escritura sigue apagada', () => {
    const lectura = evaluatePolicy(
      canonicalize(peticion([{ role: "user", content: PREGUNTA }], { semanticCache: "include-agentic" }, { tools: [LECTURA] })),
    );
    expect(lectura.isAgentic).toBe(true);
    expect(lectura.allowSemanticCache).toBe(true);
    expect(lectura.reasons.join("; ")).toMatch(/admitted to the semantic cache/);

    const escritura = evaluatePolicy(
      canonicalize(peticion([{ role: "user", content: PREGUNTA }], { semanticCache: "include-agentic" }, { tools: [ESCRITURA] })),
    );
    expect(escritura.allowSemanticCache).toBe(false);
  });

  it("la elisión NO hereda el veto agéntico: allowElision igual con y sin tráfico agéntico", () => {
    const sola = evaluatePolicy(canonicalize(peticion([{ role: "user", content: PREGUNTA }], {})));
    for (const f of FORMAS) {
      const ag = evaluatePolicy(canonicalize(peticion(f.original, {}, f.tools ? { tools: f.tools } : {})));
      expect(ag.isAgentic).toBe(true);
      expect(ag.allowElision).toBe(sola.allowElision);
    }
    expect(sola.allowElision).toBe(true);
  });

  it("la caché exacta tampoco cambia: tráfico agéntico de lectura la sigue permitiendo", () => {
    const pol = evaluatePolicy(
      canonicalize(peticion([{ role: "user", content: PREGUNTA }], { semanticCache: true }, { tools: [LECTURA] })),
    );
    expect(pol.allowExactCache).toBe(true);
  });
});

describe("por la capa: por defecto, ni se lee ni se escribe", () => {
  for (const f of FORMAS) {
    it(`${f.nombre}: la reformulación sale miss y la caché queda vacía`, async () => {
      const cache = nuevaCache();
      const proveedor = new ProveedorFijo();
      const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS, silenceWarnings: true, semanticCacheStore: cache });
      const extra = f.tools ? { tools: f.tools } : {};
      await capa.generate(peticion(f.original, { semanticCache: true }, extra));
      const segunda = await capa.generate(peticion(f.reformulada, { semanticCache: true }, extra));

      expect(segunda.report.cache.result).toBe("miss");
      expect(proveedor.llamadas).toBe(2);
      // Tampoco escribe: la política es la fuente única de la lectura y la escritura.
      expect(cache.size).toBe(0);
      expect(
        segunda.report.traces.some(
          (t) => t.stage === "semantic-cache" && t.outcome.startsWith("skipped: agentic traffic (default)"),
        ),
      ).toBe(true);
    });
  }

  it('"safe-only" se comporta igual que true', async () => {
    const f = FORMAS[0]!;
    const cache = nuevaCache();
    const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, silenceWarnings: true, semanticCacheStore: cache });
    await capa.generate(peticion(f.original, { semanticCache: "safe-only" }, { tools: f.tools! }));
    const segunda = await capa.generate(peticion(f.reformulada, { semanticCache: "safe-only" }, { tools: f.tools! }));
    expect(segunda.report.cache.result).toBe("miss");
    expect(cache.size).toBe(0);

    // Y en single-shot acierta, exactamente como `true`.
    await generarYCertificar(capa, cache, peticion([{ role: "user", content: PREGUNTA }], { semanticCache: "safe-only" }));
    const sola = await capa.generate(peticion([{ role: "user", content: REFORMULADA }], { semanticCache: "safe-only" }));
    expect(sola.report.cache.result).toBe("semantic");
  });

  it("single-shot con semanticCache: true sigue acertando con calibración", async () => {
    const cache = nuevaCache();
    const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, silenceWarnings: true, semanticCacheStore: cache });
    await generarYCertificar(capa, cache, peticion([{ role: "user", content: PREGUNTA }], { semanticCache: true }));
    const r = await capa.generate(peticion([{ role: "user", content: REFORMULADA }], { semanticCache: true }));
    expect(r.report.cache.result).toBe("semantic");
    expect(r.report.qualityStatus).toBe("task_equivalent");
  });
});

describe('"include-agentic": se activa, y con la identidad completa', () => {
  for (const f of FORMAS) {
    it(`${f.nombre}: la reformulación acierta`, async () => {
      const cache = nuevaCache();
      const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, silenceWarnings: true, semanticCacheStore: cache });
      const extra = f.tools ? { tools: f.tools } : {};
      await generarYCertificar(capa, cache, peticion(f.original, { semanticCache: "include-agentic" }, extra), true);
      const r = await capa.generate(peticion(f.reformulada, { semanticCache: "include-agentic" }, extra));
      expect(r.report.cache.result).toBe("semantic");
    });
  }

  it("mismo texto y OTRO catálogo de herramientas → miss (el filtro duro mira toolsetHash)", async () => {
    const cache = nuevaCache();
    const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, silenceWarnings: true, semanticCacheStore: cache });
    const msgs: ChatMessage[] = [{ role: "user", content: PREGUNTA }];
    const original = peticion(msgs, { semanticCache: "include-agentic" }, { tools: [LECTURA] });
    const primera = await capa.generate(original);
    const otro = await capa.generate(peticion(msgs, { semanticCache: "include-agentic" }, { tools: [OTRA_LECTURA] }));
    expect(otro.report.cache.result).toBe("miss");
    await certificarRespuestaSemantica(cache, original, primera, { agentic: true });
    // Con el MISMO catálogo, el mismo texto sí acierta: el miss de arriba es el catálogo.
    const mismo = await capa.generate(original);
    expect(mismo.report.cache.result).toBe("semantic");
  });

  it("temperature o seed distintos → miss (también son identidad)", async () => {
    const cache = nuevaCache();
    const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, silenceWarnings: true, semanticCacheStore: cache });
    const msgs: ChatMessage[] = [{ role: "user", content: PREGUNTA }];
    const original = peticion(msgs, { semanticCache: true }, { temperature: 0, seed: 1 });
    const primera = await capa.generate(original);
    const otraTemp = await capa.generate(peticion(msgs, { semanticCache: true }, { temperature: 0.2, seed: 1 }));
    expect(otraTemp.report.cache.result).toBe("miss");
    const otraSemilla = await capa.generate(peticion(msgs, { semanticCache: true }, { temperature: 0, seed: 2 }));
    expect(otraSemilla.report.cache.result).toBe("miss");
    await certificarRespuestaSemantica(cache, original, primera);
    const igual = await capa.generate(peticion([{ role: "user", content: REFORMULADA }], { semanticCache: true }, { temperature: 0, seed: 1 }));
    expect(igual.report.cache.result).toBe("semantic");
  });

  // LA PROPIEDAD DE DINERO DEL OPT-IN. `"include-agentic"` abre la caché
  // semántica a más tráfico, y un acierto semántico sirve la respuesta a OTRA
  // pregunta: no hay contador del proveedor que lo respalde frente a la factura.
  // Tiene que seguir en `estimated` y sin referencia, que es lo que deja la
  // llamada evitada fuera de la base de la comisión (measured / reference).
  for (const f of FORMAS) {
    it(`${f.nombre}: el acierto admitido queda en estimated y sin referencia (fuera de la comisión)`, async () => {
      const cache = nuevaCache();
      const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, silenceWarnings: true, semanticCacheStore: cache });
      const extra = f.tools ? { tools: f.tools } : {};
      await generarYCertificar(capa, cache, peticion(f.original, { semanticCache: "include-agentic" }, extra), true);
      const r = await capa.generate(peticion(f.reformulada, { semanticCache: "include-agentic" }, extra));
      expect(r.report.cache.result).toBe("semantic");
      expect(r.report.cost.basis).toBe("estimated");
      expect(r.report.cache.reference).toBeUndefined();
    });
  }

  it('herramienta de escritura con "include-agentic": sigue apagada', async () => {
    const cache = nuevaCache();
    const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, silenceWarnings: true, semanticCacheStore: cache });
    await capa.generate(peticion([{ role: "user", content: PREGUNTA }], { semanticCache: "include-agentic" }, { tools: [ESCRITURA] }));
    const r = await capa.generate(peticion([{ role: "user", content: REFORMULADA }], { semanticCache: "include-agentic" }, { tools: [ESCRITURA] }));
    expect(r.report.cache.result).toBe("miss");
    expect(cache.size).toBe(0);
  });
});

describe("no es silencioso: un aviso por proceso", () => {
  let aviso: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reiniciarAvisos();
    aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => aviso.mockRestore());

  const agentica = (s: SavingsToggles["semanticCache"]) =>
    peticion([{ role: "user", content: PREGUNTA }], { semanticCache: s }, { tools: [LECTURA] });
  const delAviso = () =>
    aviso.mock.calls.filter((c: unknown[]) => String(c[0]).includes('"include-agentic"'));

  it("se emite UNA vez aunque haya muchas peticiones agénticas", async () => {
    const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, semanticCacheStore: nuevaCache() });
    await capa.generate(agentica(true));
    await capa.generate(agentica(true));
    await capa.generate(agentica("safe-only"));
    expect(delAviso()).toHaveLength(1);
    expect(String(delAviso()[0]![0])).toMatch(/neither consulted nor written/);
  });

  it("nada con silenceWarnings", async () => {
    const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, silenceWarnings: true, semanticCacheStore: nuevaCache() });
    await capa.generate(agentica(true));
    expect(aviso).not.toHaveBeenCalled();
  });

  it("nada si la capa no tiene caché semántica (habla el aviso que ya existía)", async () => {
    const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS });
    await capa.generate(agentica(true));
    expect(delAviso()).toHaveLength(0);
    expect(aviso.mock.calls.some((c: unknown[]) => String(c[0]).includes("has no semantic cache"))).toBe(true);
  });

  // EL CONSEJO TIENE QUE SER VERDAD. Si otro veto cierra la caché igual
  // (muestreo estocástico, frescura), pedir `"include-agentic"` no cambia nada:
  // ni el aviso ni la traza pueden mandar a pedirlo.
  const OTROS_VETOS: { nombre: string; extra: Partial<SavingsRequest> }[] = [
    { nombre: "muestreo estocástico (temperature 0.9 sin seed)", extra: { temperature: 0.9 } },
    { nombre: 'frescura ("hour")', extra: { context: { tenantId: "acme", freshnessBucket: "hour" } } },
  ];
  for (const v of OTROS_VETOS) {
    it(`nada si otro veto la cierra igual: ${v.nombre}`, async () => {
      const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, semanticCacheStore: nuevaCache() });
      const pedir = (s: SavingsToggles["semanticCache"], content: string) =>
        peticion([{ role: "user", content }], { semanticCache: s }, { tools: [LECTURA], ...v.extra });
      const r = await capa.generate(pedir(true, PREGUNTA));
      expect(delAviso()).toHaveLength(0);
      expect(r.report.traces.some((t) => t.stage === "semantic-cache" && t.outcome.includes("agentic"))).toBe(false);
      // Y es verdad que no habría cambiado nada: con el opt-in tampoco acierta.
      await capa.generate(pedir("include-agentic", PREGUNTA));
      const otra = await capa.generate(pedir("include-agentic", REFORMULADA));
      expect(otra.report.cache.result).toBe("miss");
    });
  }

  it('nada con "include-agentic": lo pidió explícitamente', async () => {
    const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, semanticCacheStore: nuevaCache() });
    await capa.generate(agentica("include-agentic"));
    expect(delAviso()).toHaveLength(0);
  });
});
