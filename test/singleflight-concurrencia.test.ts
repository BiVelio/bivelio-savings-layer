import { describe, it, expect } from "vitest";
import { createSavingsLayer, ExecutionRouter } from "../src/index.js";
import type {
  JsonSchema,
  Provider,
  ProviderRequest,
  ProviderResponse,
  SavingsRequest,
  SavingsResult,
  ToolDescriptor,
} from "../src/index.js";

/**
 * El singleflight, EJERCITADO DE VERDAD.
 *
 * La clase `Singleflight` suelta ya tenía cobertura, pero la palanca vive en el
 * pipeline: quien decide si dos peticiones son "la misma" es `buildInflightKey`,
 * y quien reparte la respuesta del líder es `asCoalescedFollower`. Nada de eso
 * lo prueba un test de la clase.
 *
 * Y solo se puede probar con CONCURRENCIA REAL: un escenario secuencial nunca
 * produce un `cache: "singleflight"` porque no hay nada que colapsar.
 *
 * DETERMINISMO. Ni un `setTimeout` en todo el fichero. El proveedor doble no
 * resuelve NUNCA por su cuenta: cada llamada se queda colgada de una promesa
 * cuyo `resolve` dispara el test. Entre lanzar las peticiones y liberar al
 * proveedor se vacía la cola de microtareas con `asentar()`. Así el orden de los
 * hechos lo fija el test, no el reloj.
 */

/**
 * Vacía la cola de microtareas.
 *
 * El camino del pipeline hasta el singleflight son SOLO microtareas (cachés en
 * memoria, tokenizador síncrono, políticas puras): no hay ni un temporizador.
 * Así que un número fijo de vueltas basta para que todas las peticiones lanzadas
 * hayan llegado al proveedor o se hayan colgado de la ejecución del líder. Si
 * esto fuera un `await sleep(10)`, el test fallaría una vez de cada veinte en
 * una máquina cargada.
 */
async function asentar(turnos = 100): Promise<void> {
  for (let i = 0; i < turnos; i++) await Promise.resolve();
}

/** Una llamada al proveedor que sigue en vuelo, esperando al test. */
interface EnVuelo {
  cumplir: (respuesta: ProviderResponse) => void;
  fallar: (error: unknown) => void;
}

/**
 * Proveedor doble que CUENTA y que no termina hasta que el test lo dice.
 *
 * La latencia controlada a mano es lo que hace que las peticiones se solapen: si
 * el proveedor respondiera al vuelo, la primera acabaría antes de que la segunda
 * llegara al singleflight y no habría nada que colapsar.
 */
class ProveedorContado implements Provider {
  readonly id = "contado";
  /** Todas las peticiones que ha visto, en orden. `length` es el contador. */
  readonly recibidas: ProviderRequest[] = [];
  private readonly enVuelo: EnVuelo[] = [];
  /** Cuando se arma, toda llamada NUEVA falla al instante (proveedor caído). */
  private caido: unknown;

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.recibidas.push(req);
    if (this.caido !== undefined) return Promise.reject(this.caido);
    return new Promise<ProviderResponse>((cumplir, fallar) => {
      this.enVuelo.push({ cumplir, fallar });
    });
  }

  get llamadas(): number {
    return this.recibidas.length;
  }

  /** Libera con éxito todo lo que esté en vuelo ahora mismo. */
  responder(texto: string, uso = { inputTokens: 40, outputTokens: 12 }): void {
    for (const p of this.enVuelo.splice(0)) p.cumplir({ text: texto, usage: uso });
  }

  /** Libera SOLO la llamada más antigua, para darle a cada una su propio texto. */
  responderLaPrimera(texto: string, uso = { inputTokens: 40, outputTokens: 12 }): void {
    this.enVuelo.shift()?.cumplir({ text: texto, usage: uso });
  }

  /**
   * Tira lo que está en vuelo y deja el proveedor CAÍDO: toda llamada posterior
   * falla al instante. Sin esto, un reintento que no debería existir dejaría el
   * test colgado en lugar de delatarse en el contador.
   */
  reventar(error: unknown): void {
    this.caido = error;
    for (const p of this.enVuelo.splice(0)) p.fallar(error);
  }

  /** Vuelve a estar sano. Sin esto no se puede reutilizar la MISMA capa, y sin
   *  reutilizarla el mapa de en-vuelo no se prueba: cada capa tiene el suyo. */
  recuperarse(): void {
    this.caido = undefined;
  }
}

/** Ni aritmética (resolver determinista), ni marcadores de frescura o de cuenta. */
const PREGUNTA = "describe the lifecycle of a butterfly in three stages";

const ESQUEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } },
};
const JSON_VALIDO = '{"answer":"ok"}';

const HERRAMIENTA = (id: string): ToolDescriptor => ({
  id,
  intents: ["look up a fact"],
  risk: "read",
  parameters: { type: "object", properties: { q: { type: "string" } } },
});

function peticion(extra: Partial<SavingsRequest> = {}): SavingsRequest {
  return {
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: PREGUNTA }],
    ...extra,
  };
}

let secuencia = 0;
function crearCapa(provider: Provider) {
  return createSavingsLayer({ exactTokenizer: false, provider, generateId: () => `req-${secuencia++}` });
}

/** Lanza N `generate()` a la vez y espera a que TODAS hayan llegado a donde van. */
async function lanzar(
  capa: ReturnType<typeof crearCapa>,
  peticiones: SavingsRequest[],
): Promise<Array<Promise<SavingsResult>>> {
  const enCurso = peticiones.map((p) => capa.generate(p));
  await asentar();
  return enCurso;
}

describe("singleflight de punta a punta (createSavingsLayer)", () => {
  it("N peticiones idénticas y simultáneas producen UNA sola llamada al proveedor", async () => {
    const proveedor = new ProveedorContado();
    const capa = crearCapa(proveedor);

    const enCurso = await lanzar(capa, Array.from({ length: 5 }, () => peticion()));
    // Las cinco están dentro: cuatro colgadas de la ejecución de la primera.
    expect(proveedor.llamadas).toBe(1);

    proveedor.responder("una sola ejecucion");
    const res = await Promise.all(enCurso);

    // Ni una llamada de más DESPUÉS de resolverse el líder (el error clásico:
    // los seguidores despiertan tarde, la clave ya no está en vuelo y cada uno
    // arranca su propia ejecución).
    expect(proveedor.llamadas).toBe(1);
    expect(res.map((r) => r.text)).toEqual(Array(5).fill("una sola ejecucion"));

    const resultados = res.map((r) => r.report.cache.result);
    expect(resultados.filter((r) => r === "miss")).toHaveLength(1);
    expect(resultados.filter((r) => r === "singleflight")).toHaveLength(4);

    // Un id por petición, y el del informe casa con el del resultado: sin eso no
    // se puede correlacionar una petición con su registro de medición.
    expect(new Set(res.map((r) => r.requestId)).size).toBe(5);
    for (const r of res) expect(r.report.requestId).toBe(r.requestId);
  });

  it("apagar la palanca (`savings.singleflight: false`) devuelve N llamadas", async () => {
    const proveedor = new ProveedorContado();
    const capa = crearCapa(proveedor);

    const enCurso = await lanzar(
      capa,
      Array.from({ length: 3 }, () => peticion({ savings: { singleflight: false } })),
    );
    expect(proveedor.llamadas).toBe(3);

    proveedor.responder("sin colapsar");
    const res = await Promise.all(enCurso);
    expect(res.every((r) => r.report.cache.result === "miss")).toBe(true);
  });
});

/**
 * La mitad que de verdad importa.
 *
 * Colapsar de MENOS solo cuesta dinero; colapsar de MÁS es servirle a alguien la
 * respuesta de otro. Cada campo de `buildInflightKey` tiene que separar, y aquí
 * se comprueba uno por uno atravesando `createSavingsLayer`, no hasheando claves
 * a mano: un cambio que dejara de canonicalizar el campo pasaría el test de la
 * clave y fallaría este.
 */
const CAMPOS_QUE_SEPARAN: Array<{
  campo: string;
  a: SavingsRequest;
  b: SavingsRequest;
  texto?: string;
}> = [
  {
    campo: "model",
    a: peticion(),
    b: peticion({ model: "openai/gpt-4o" }),
  },
  {
    campo: "tenant",
    a: peticion({ context: { tenantId: "acme" } }),
    b: peticion({ context: { tenantId: "globex" } }),
  },
  {
    campo: "authorizationScope",
    a: peticion({ context: { tenantId: "acme", authorizationScope: "reader" } }),
    b: peticion({ context: { tenantId: "acme", authorizationScope: "admin" } }),
  },
  {
    campo: "principal (context.sessionId)",
    a: peticion({ context: { tenantId: "acme", sessionId: "usuario-1" } }),
    b: peticion({ context: { tenantId: "acme", sessionId: "usuario-2" } }),
  },
  {
    campo: "texto de la conversación",
    a: peticion(),
    b: peticion({ messages: [{ role: "user", content: "describe the lifecycle of a beetle" }] }),
  },
  {
    campo: "prompt de sistema",
    a: peticion({
      messages: [
        { role: "system", content: "answer as a botanist" },
        { role: "user", content: PREGUNTA },
      ],
    }),
    b: peticion({
      messages: [
        { role: "system", content: "answer as a lawyer" },
        { role: "user", content: PREGUNTA },
      ],
    }),
  },
  {
    campo: "contractId",
    a: peticion({ response: { contractId: "contrato-1", schema: ESQUEMA } }),
    b: peticion({ response: { contractId: "contrato-2", schema: ESQUEMA } }),
    texto: JSON_VALIDO,
  },
  {
    campo: "schemaVersion (mismo contrato, otra versión)",
    a: peticion({ response: { contractId: "contrato-1", version: "v1", schema: ESQUEMA } }),
    b: peticion({ response: { contractId: "contrato-1", version: "v2", schema: ESQUEMA } }),
    texto: JSON_VALIDO,
  },
  {
    campo: "toolset",
    a: peticion({ tools: [HERRAMIENTA("buscar")] }),
    b: peticion({ tools: [HERRAMIENTA("buscar"), HERRAMIENTA("traducir")] }),
  },
  {
    campo: "structuredData",
    a: peticion({ structuredData: { filas: [{ id: 1 }] } }),
    b: peticion({ structuredData: { filas: [{ id: 2 }] } }),
  },
  {
    campo: "temperature",
    a: peticion({ temperature: 0.1 }),
    b: peticion({ temperature: 0.2 }),
  },
  {
    campo: "seed",
    a: peticion({ seed: 1 }),
    b: peticion({ seed: 2 }),
  },
  {
    // toolDiscovery sondea y RECORTA la vista de herramientas del líder: un
    // seguidor sin la palanca no puede recibir esa respuesta recortada. (Caza
    // del 27-08: la clave ignoraba este eje y lo servía con 100 % de ahorro.)
    campo: "toolDiscovery (líder recorta la vista de herramientas)",
    a: peticion({ tools: [HERRAMIENTA("buscar")], savings: { toolDiscovery: true } }),
    b: peticion({ tools: [HERRAMIENTA("buscar")] }),
  },
  {
    // maxOutputTokens corta la respuesta del líder (finishReason "length"): un
    // seguidor que pidió más tokens no puede recibir la respuesta truncada.
    campo: "maxOutputTokens (líder trunca la respuesta)",
    a: peticion({ response: { contractId: "c", schema: ESQUEMA, maxOutputTokens: 64 } }),
    b: peticion({ response: { contractId: "c", schema: ESQUEMA, maxOutputTokens: 4096 } }),
    texto: JSON_VALIDO,
  },
];

describe("el singleflight NO colapsa peticiones que solo parecen iguales", () => {
  for (const { campo, a, b, texto } of CAMPOS_QUE_SEPARAN) {
    it(`separa por ${campo}: dos llamadas, no una`, async () => {
      const proveedor = new ProveedorContado();
      const capa = crearCapa(proveedor);

      const enCurso = await lanzar(capa, [a, b]);
      expect(proveedor.llamadas).toBe(2);

      proveedor.responder(texto ?? "respuesta");
      const res = await Promise.all(enCurso);
      // Ninguna de las dos puede haberse servido de la ejecución de la otra.
      expect(res.map((r) => r.report.cache.result)).toEqual(["miss", "miss"]);
    });
  }

  it("un tenant distinto NO recibe la respuesta calculada para el otro", async () => {
    const proveedor = new ProveedorContado();
    const capa = crearCapa(proveedor);

    const enCurso = await lanzar(capa, [
      peticion({ context: { tenantId: "acme" } }),
      peticion({ context: { tenantId: "globex" } }),
    ]);
    expect(proveedor.llamadas).toBe(2);

    // Cada ejecución termina con SU propio texto: si hubieran colapsado, las dos
    // saldrían con el mismo y el segundo tenant leería datos del primero.
    proveedor.responderLaPrimera("secreto de acme");
    proveedor.responderLaPrimera("secreto de globex");
    const [uno, otro] = await Promise.all(enCurso);

    expect(uno!.text).toBe("secreto de acme");
    expect(otro!.text).toBe("secreto de globex");
  });
});

describe("cuando el líder falla", () => {
  it("los seguidores no se cuelgan y no vuelven a llamar al proveedor que acaba de fallar", async () => {
    const proveedor = new ProveedorContado();
    const capa = crearCapa(proveedor);

    const enCurso = await lanzar(capa, Array.from({ length: 4 }, () => peticion()));
    expect(proveedor.llamadas).toBe(1);

    const fallo = new Error("429 rate limited");
    proveedor.reventar(fallo);
    const resueltos = await Promise.allSettled(enCurso);

    // 1) Nadie se queda colgado, y nadie recibe una respuesta inventada.
    expect(resueltos.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    for (const r of resueltos) {
      expect((r as PromiseRejectedResult).reason).toBe(fallo);
    }

    // 2) Y —lo caro— el fallo del proveedor NO se amplifica. El fail-open existe
    //    para rescatar un error INTERNO del optimizador, no para reintentar
    //    contra un proveedor que acaba de decir 429. El líder ya lo sabía por su
    //    testigo de facturación; los seguidores tienen el suyo a cero, así que
    //    sin la marca que viaja con el error cada uno abría otra llamada
    //    completa: N-1 llamadas extra justo contra el proveedor caído.
    expect(proveedor.llamadas).toBe(1);
  });

  it("pero un error INTERNO que no costó nada sigue rescatándose con el fail-open", async () => {
    // La cara B del test anterior: cerrar la amplificación no puede cerrar el
    // contrato de fiabilidad. Un fallo del optimizador ANTES de gastar un euro
    // (aquí, el router) se rescata con una llamada directa — para el líder y
    // para el seguidor —, que es exactamente lo que habría pasado sin colapsar.
    class RouterQueRevienta extends ExecutionRouter {
      override classify(): never {
        throw new Error("bug interno del router");
      }
    }
    const proveedor = new ProveedorContado();
    const capa = createSavingsLayer({ exactTokenizer: false,
      provider: proveedor,
      router: new RouterQueRevienta(),
      generateId: () => `req-${secuencia++}`,
    });

    const enCurso = await lanzar(capa, [peticion(), peticion()]);
    expect(proveedor.llamadas).toBe(2);

    proveedor.responder("rescatada");
    const res = await Promise.all(enCurso);
    expect(res.map((r) => r.text)).toEqual(["rescatada", "rescatada"]);
    for (const r of res) {
      expect(r.report.traces.some((t) => t.stage === "fail-open")).toBe(true);
      // Un rescate no reclama ahorro: baseline == actual.
      expect(r.report.cost.netSavings).toBe(0);
    }
  });

  it("⛔ un fallo del líder no envenena la siguiente petición idéntica", async () => {
    // ESTE TEST ERA DECORATIVO. Creaba una capa NUEVA para la segunda ronda, y
    // `resolveDependencies` construye un `new Singleflight()` por capa: el mapa
    // que comprobaba estaba vacío por construcción. Se verificó borrando entero
    // el `finally { inflight.delete(key) }` de `src/cache/singleflight.ts` —un
    // mapa envenenado para siempre— y los 20 tests seguían pasando.
    //
    // Para probar algo hay que reutilizar la MISMA capa, que es lo que hace un
    // proceso real: una capa vive lo que vive el servidor y atiende miles de
    // peticiones. Si la clave no se libera, la segunda ronda se queda colgada
    // esperando a un líder que ya murió.
    const proveedor = new ProveedorContado();
    const capa = crearCapa(proveedor);

    const primeras = await lanzar(capa, [peticion(), peticion()]);
    proveedor.reventar(new Error("boom"));
    const caidas = await Promise.allSettled(primeras);
    expect(caidas.every((r) => r.status === "rejected")).toBe(true);

    // MISMA capa, mismo mapa de en-vuelo, misma clave.
    proveedor.recuperarse();
    const antes = proveedor.llamadas;
    const segundas = await lanzar(capa, [peticion()]);
    // Se mide el INCREMENTO, no el total: `llamadas` es acumulativo y la ronda
    // caída ya gastó la suya. Si la clave siguiera en el mapa, el incremento
    // sería 0 — la petición se habría enganchado como seguidora de un líder que
    // ya está muerto, y se quedaría esperando para siempre.
    expect(proveedor.llamadas - antes).toBe(1);
    proveedor.responder("ya va bien");
    expect((await segundas[0]!).text).toBe("ya va bien");
  });
});

describe("el ahorro que se le reporta a un seguidor", () => {
  it("no se apunta la llamada del líder ni la cuenta N veces", async () => {
    const proveedor = new ProveedorContado();
    const capa = crearCapa(proveedor);

    const enCurso = await lanzar(capa, Array.from({ length: 4 }, () => peticion()));
    proveedor.responder("compartida", { inputTokens: 40, outputTokens: 12 });
    const res = await Promise.all(enCurso);

    const lider = res.find((r) => r.report.cache.result === "miss")!;
    const seguidores = res.filter((r) => r.report.cache.result === "singleflight");
    expect(seguidores).toHaveLength(3);

    // El que pagó, paga: una llamada y los tokens que midió el proveedor.
    expect(lider.report.calls.actualLlm).toBe(1);
    expect(lider.report.calls.avoidedLlm).toBe(0);
    expect(lider.report.tokens.actualInput).toBe(40);
    expect(lider.report.tokens.actualOutput).toBe(12);

    for (const s of seguidores) {
      expect(s.report.calls.actualLlm).toBe(0);
      expect(s.report.calls.avoidedLlm).toBe(1);
      // Ni un token facturado: su llamada se coalesció, no tocó al proveedor.
      expect(s.report.tokens.actualInput).toBe(0);
      expect(s.report.tokens.actualOutput).toBe(0);
      expect(s.report.cost.actual).toBe(0);
      // Una llamada EVITADA se valora con el contador de la idéntica que corrió
      // (reference); sin muestreo determinista, su salida no cuenta.
      expect(s.report.cost.basis).toBe("reference");
      expect(s.report.tokens.baselineInput).toBe(40);
      expect(s.report.tokens.baselineOutput).toBe(0);
      expect(s.report.cache.reference?.requestId).toBe(lider.report.requestId);
      // Se evitó el 100% del coste de ESTA petición, sobre un baseline propio y
      // no nulo (un baseline 0 daría el mismo 1 sin significar nada).
      expect(s.report.cost.baselineEstimate).toBeGreaterThan(0);
      expect(s.report.cost.netSavings).toBe(1);
    }

    // Lo que ve el panel al sumar los N informes de la ráfaga: UNA llamada y los
    // tokens de UNA llamada. Si los seguidores heredaran el bloque `tokens` del
    // líder, esto saldría x4 en usage_daily.
    expect(res.reduce((t, r) => t + r.report.calls.actualLlm, 0)).toBe(1);
    expect(res.reduce((t, r) => t + r.report.tokens.actualInput, 0)).toBe(40);
    expect(res.reduce((t, r) => t + r.report.tokens.actualOutput, 0)).toBe(12);
    expect(res.reduce((t, r) => t + r.report.cost.actual, 0)).toBeCloseTo(
      lider.report.cost.actual,
      12,
    );
  });

  it("el seguidor sirve la respuesta del líder, no una fabricada", async () => {
    const proveedor = new ProveedorContado();
    const capa = crearCapa(proveedor);

    const enCurso = await lanzar(capa, [
      peticion({ response: { contractId: "c", schema: ESQUEMA } }),
      peticion({ response: { contractId: "c", schema: ESQUEMA } }),
    ]);
    expect(proveedor.llamadas).toBe(1);

    proveedor.responder(JSON_VALIDO);
    const [uno, otro] = await Promise.all(enCurso);

    expect(otro!.report.cache.result).toBe("singleflight");
    expect(otro!.text).toBe(uno!.text);
    expect(otro!.data).toEqual({ answer: "ok" });
    // La validez estructural se afirma sobre lo que de verdad se sirve.
    expect(otro!.report.constraints.structurallyValid).toBe(true);
  });
});
