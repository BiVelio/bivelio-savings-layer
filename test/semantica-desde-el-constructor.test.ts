import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemorySemanticCache, type SemanticCacheOptions } from "../src/cache/semantic.js";
import { InMemoryCacheBreakpointStore } from "../src/cache/breakpoint-store.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import { CALIBRACION_DE_PRUEBA, certificarRespuestaSemantica } from "./helpers/semantic-cache.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { ChatMessage, SavingsRequest, SavingsToggles } from "../src/contracts/types.js";

/**
 * DAR LA CACHÉ SEMÁNTICA AL CONSTRUCTOR NO LA ENCIENDE, Y NADIE LO DECÍA.
 *
 * Visto en el banco GSM8K con 0.4.30: `createSavingsLayer({ semanticCache })`,
 * como en el ejemplo «Serverless» del README, y 0 registros en la caché tras
 * 5.813 peticiones. El diseño es deliberado —el constructor pone el ALMACÉN, la
 * petición decide si se reutiliza una respuesta ajena— y no se cambia: activarla
 * sola serviría respuestas a preguntas reformuladas a quien no lo pidió. Lo que
 * estaba mal era el silencio y un ejemplo que no hacía lo que su texto dice.
 *
 * Ahora: `semanticCacheDefault` la pide para todas las peticiones de la capa
 * (opt-in explícito, gana siempre la petición), y una capa con caché que recibe
 * una petición que no dice nada avisa una vez.
 */

const RAIZ = new URL("..", import.meta.url).pathname;
const PRECIOS = { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } };

class ProveedorFijo implements Provider {
  readonly id = "fijo";
  llamadas = 0;
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas++;
    return { text: "the answer", usage: { inputTokens: 100, outputTokens: 10 }, finishReason: "stop" };
  }
}

// El de cache-semantica-agentica: reordenar palabras da el MISMO vector.
const embed = async (t: string): Promise<number[]> =>
  [0, 1, 2, 3].map((i) => [...t].filter((c) => c.charCodeAt(0) % 4 === i).length);
const nuevaCache = () => new InMemorySemanticCache({ embed, similarityThreshold: 0.3, acceptThreshold: 0.3, calibration: CALIBRACION_DE_PRUEBA });

const PREGUNTA = "explain the coalescing mechanism briefly";
const REFORMULADA = "explain briefly the coalescing mechanism";

const peticion = (content: string, savings?: SavingsToggles, extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content }],
  context: { tenantId: "acme" },
  ...(savings ? { savings } : {}),
  ...extra,
});

let avisos: string[];
beforeEach(() => {
  reiniciarAvisos();
  avisos = [];
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    avisos.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});
const sinPedir = () => avisos.filter((a) => a.includes("does not ask for it"));

// ─── El ejemplo del README, ejecutado tal cual ──────────────────────────────

/**
 * El bloque «Serverless» del README, sin sus `import` (se inyectan), compilado
 * a JS y evaluado. Lo que se ejecuta es el TEXTO del README: si alguien quita la
 * línea que enciende la caché, este test lo ve. El tipado de ese mismo bloque lo
 * compila `fragmento-instalacion.test.ts` contra los tipos reales.
 */
function ejemploServerless(inyectado: {
  createSavingsLayer: unknown;
  InMemorySemanticCache: unknown;
  provider: Provider;
}): (kv: unknown) => Promise<{ layer: ReturnType<typeof createSavingsLayer>; save: () => Promise<void> }> {
  const readme = readFileSync(join(RAIZ, "README.md"), "utf8");
  const bloque = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)]
    .map((m) => m[1] ?? "")
    .find((b) => b.includes("async function serverlessLayer"));
  if (!bloque) throw new Error("no está el ejemplo Serverless en el README");
  const sinImports = bloque
    .split("\n")
    .filter((l) => !/^\s*import\s/.test(l))
    .join("\n");
  const js = ts.transpileModule(`${sinImports}\nreturn serverlessLayer;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const f = new Function("createSavingsLayer", "InMemorySemanticCache", "provider", "process", js);
  return f(
    inyectado.createSavingsLayer,
    inyectado.InMemorySemanticCache,
    inyectado.provider,
    { env: {} },
  );
}

describe("el ejemplo «Serverless» del README hace lo que dice", () => {
  it("la caché calibrada recibe las peticiones: guarda respuestas y acumula etiquetas", async () => {
    const instancias: InMemorySemanticCache[] = [];
    class CacheEspiada extends InMemorySemanticCache {
      constructor(o: SemanticCacheOptions) {
        super(o);
        instancias.push(this);
      }
    }
    const kv = new Map<string, string>();
    const serverlessLayer = ejemploServerless({
      // El ejemplo pasa `licenseKey: process.env...`, que aquí es undefined:
      // la suite corre en modo desarrollo abierto.
      createSavingsLayer: (c: Parameters<typeof createSavingsLayer>[0]) =>
        createSavingsLayer({ ...c, costModels: PRECIOS }),
      InMemorySemanticCache: CacheEspiada,
      provider: new ProveedorFijo(),
    });
    const { layer, save } = await serverlessLayer({
      get: async (k: string) => kv.get(k),
      set: async (k: string, v: string) => void kv.set(k, v),
    });
    expect(instancias).toHaveLength(1);
    const cache = instancias[0]!;

    // Peticiones SIN `savings`, como las de quien sigue el ejemplo.
    const preguntas = ["what is the capital of france", "what is the capital of spain", "how tall is everest"];
    for (const q of preguntas) await layer.generate(peticion(q));
    for (const q of preguntas) await layer.generate(peticion(q.split(" ").reverse().join(" ")));
    await save();

    // Con 0.4.30: 0 registros y ninguna etiqueta — la caché no se consultaba.
    expect(cache.size).toBeGreaterThan(0);
    expect(kv.has("bvsala:semantic-calibration")).toBe(true);
    expect(sinPedir()).toEqual([]);
  });
});

// ─── semanticCacheDefault ───────────────────────────────────────────────────

describe("semanticCacheDefault: la capa la pide, la petición gana", () => {
  it("true: una petición sin `savings` usa la caché y la reformulación acierta", async () => {
    const cache = nuevaCache();
    const capa = createSavingsLayer({
      provider: new ProveedorFijo(),
      costModels: PRECIOS,
      semanticCacheStore: cache,
      semanticCacheDefault: true,
    });
    const original = peticion(PREGUNTA, { exactCache: false });
    const primera = await capa.generate(original);
    await certificarRespuestaSemantica(cache, original, primera);
    const r = await capa.generate(peticion(REFORMULADA, { exactCache: false }));
    expect(cache.size).toBeGreaterThan(0);
    expect(r.report.cache.result).toBe("semantic");
  });

  it("un `false` de la petición gana al valor de la capa", async () => {
    const cache = nuevaCache();
    const capa = createSavingsLayer({
      provider: new ProveedorFijo(),
      costModels: PRECIOS,
      semanticCacheStore: cache,
      semanticCacheDefault: true,
    });
    await capa.generate(peticion(PREGUNTA, { exactCache: false, semanticCache: false }));
    const r = await capa.generate(peticion(REFORMULADA, { exactCache: false, semanticCache: false }));
    expect(cache.size).toBe(0);
    expect(r.report.cache.result).toBe("miss");
  });

  it('"include-agentic" de la capa vale como el de la petición (la política lo lee)', async () => {
    const dosTurnos = (primera: string): ChatMessage[] => [
      { role: "user", content: primera },
      { role: "assistant", content: "it merges identical requests" },
      { role: "user", content: "give an example please" },
    ];
    for (const [defecto, esperado] of [[true, "miss"], ["include-agentic", "semantic"]] as const) {
      const cache = nuevaCache();
      const capa = createSavingsLayer({
        provider: new ProveedorFijo(),
        costModels: PRECIOS,
        silenceWarnings: true,
        semanticCacheStore: cache,
        semanticCacheDefault: defecto,
      });
      const extra = { savings: { exactCache: false } };
      const original = { ...peticion("", undefined, extra), messages: dosTurnos(PREGUNTA) };
      const primera = await capa.generate(original);
      if (defecto === "include-agentic") {
        await certificarRespuestaSemantica(cache, original, primera, { agentic: true });
      }
      const r = await capa.generate({ ...peticion("", undefined, extra), messages: dosTurnos(REFORMULADA) });
      expect(r.report.cache.result).toBe(esperado);
    }
  });

  it("sin semanticCacheDefault nada cambia: sin pedirla, la caché no se toca", async () => {
    const cache = nuevaCache();
    const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, silenceWarnings: true, semanticCacheStore: cache });
    await capa.generate(peticion(PREGUNTA, { exactCache: false }));
    const r = await capa.generate(peticion(REFORMULADA, { exactCache: false }));
    expect(cache.size).toBe(0);
    expect(r.report.cache.result).toBe("miss");
  });
});

// ─── El aviso ───────────────────────────────────────────────────────────────

describe("una caché semántica que ninguna petición pide se avisa", () => {
  it("una vez, por muchas peticiones, y dice cómo encenderla", async () => {
    const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, semanticCacheStore: nuevaCache() });
    for (const q of ["a b c", "d e f", "g h i"]) await capa.generate(peticion(q));
    expect(sinPedir()).toHaveLength(1);
    expect(sinPedir()[0]).toContain("semanticCacheDefault: true");
    expect(sinPedir()[0]).toContain("savings: { semanticCache: true }");
  });

  it("silenceWarnings lo calla", async () => {
    const capa = createSavingsLayer({
      provider: new ProveedorFijo(),
      costModels: PRECIOS,
      semanticCacheStore: nuevaCache(),
      silenceWarnings: true,
    });
    await capa.generate(peticion("a b c"));
    expect(avisos).toEqual([]);
  });

  it("no avisa cuando es una decisión: `false` en la petición, o semanticCacheDefault (también false)", async () => {
    const conFalse = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS, semanticCacheStore: nuevaCache() });
    await conFalse.generate(peticion("a b c", { semanticCache: false }));
    await conFalse.generate(peticion("a b c", { semanticCache: true }));
    for (const defecto of [false, true] as const) {
      const capa = createSavingsLayer({
        provider: new ProveedorFijo(),
        costModels: PRECIOS,
        semanticCacheStore: nuevaCache(),
        semanticCacheDefault: defecto,
      });
      await capa.generate(peticion("d e f"));
    }
    expect(sinPedir()).toEqual([]);
  });

  it("sin caché semántica en la capa no hay nada de qué avisar", async () => {
    const capa = createSavingsLayer({ provider: new ProveedorFijo(), costModels: PRECIOS });
    await capa.generate(peticion("a b c"));
    expect(sinPedir()).toEqual([]);
  });
});

// ─── El otro «se acepta y no hace nada» del constructor ─────────────────────

describe("cacheBreakpointStore sin cacheBreakpoints: \"auto\" se avisa al construir", () => {
  const almacen = () => new InMemoryCacheBreakpointStore();
  const sobreAlmacen = () => avisos.filter((a) => a.includes("`cacheBreakpointStore` was given"));

  it("con \"fixed\" (o sin decir nada) avisa una vez; con \"auto\", no", () => {
    createSavingsLayer({ provider: new ProveedorFijo(), cacheBreakpointStore: almacen() });
    createSavingsLayer({ provider: new ProveedorFijo(), cacheBreakpoints: "fixed", cacheBreakpointStore: almacen() });
    expect(sobreAlmacen()).toHaveLength(1);
    reiniciarAvisos();
    avisos.length = 0;
    createSavingsLayer({ provider: new ProveedorFijo(), cacheBreakpoints: "auto", cacheBreakpointStore: almacen() });
    expect(sobreAlmacen()).toEqual([]);
  });

  it("silenceWarnings lo calla", () => {
    createSavingsLayer({ provider: new ProveedorFijo(), silenceWarnings: true, cacheBreakpointStore: almacen() });
    expect(avisos).toEqual([]);
  });
});
