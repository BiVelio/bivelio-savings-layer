import { describe, it, expect } from "vitest";

import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { ToolSelector } from "../src/router/tool-selector.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest, ToolDescriptor } from "../src/contracts/types.js";

/**
 * EL MONTAJE SEGMENTADO DEL PROMPT, visto desde el pipeline.
 *
 *   [PREFIJO ESTÁTICO]   instrucciones, esquemas de herramientas, política
 *   [ESTADO APPEND-ONLY] historial y resultados de herramientas
 *   [COLA DE LA CONSULTA] evidencia, payload, mensaje actual del usuario
 *
 * Lo que se comprueba aquí es la FRONTERA: qué acaba dentro del prefijo que se
 * le declara al proveedor y qué no. Meter de más ahí cuesta dinero de verdad
 * (prima de escritura sobre texto que no se repite); meter de menos sólo deja
 * de capturar un descuento. Los dos errores no empatan, y la frontera está
 * puesta del lado seguro.
 */

/** Proveedor que sólo apunta lo que le llega. */
class Testigo implements Provider {
  readonly id = "testigo";
  readonly vistas: ProviderRequest[] = [];
  constructor(private readonly usage: ProviderResponse["usage"] = { inputTokens: 100, outputTokens: 10 }) {}
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.vistas.push(req);
    return { text: "ok", usage: this.usage };
  }
}

function capa(provider: Provider, extra: Record<string, unknown> = {}): SavingsPipeline {
  return new SavingsPipeline({
    provider,
    tokenizer: new TokenizerRegistry(),
    devUnlicensed: true,
    ...extra,
  } as never);
}

const POLITICA = "Eres el asistente de una tienda. ".repeat(40);

function peticion(over: Partial<SavingsRequest> = {}): SavingsRequest {
  return {
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      { role: "system", content: POLITICA },
      { role: "user", content: "¿Cuánto tarda un envío a Canarias?" },
    ],
    ...over,
  } as SavingsRequest;
}

describe("la frontera del prefijo estable", () => {
  it("el prefijo llega hasta la última pregunta, y NO la incluye", async () => {
    const p = new Testigo();
    await capa(p).generate(peticion());
    // 2 mensajes, la pregunta es el índice 1 -> prefijo = 1 mensaje (la política).
    expect(p.vistas[0]!.stablePrefixMessages).toBe(1);
  });

  it("el historial entra en el prefijo: es append-only", async () => {
    const p = new Testigo();
    await capa(p).generate(
      peticion({
        messages: [
          { role: "system", content: POLITICA },
          { role: "user", content: "turno viejo" },
          { role: "assistant", content: "respuesta vieja" },
          // Un segundo intercambio: la conversación ya siguió una vez, que es la
          // evidencia de reenvío que exige marcar el historial con prima de
          // escritura (ver el bloque «el primer seguimiento» más abajo).
          { role: "user", content: "otro turno viejo" },
          { role: "assistant", content: "otra respuesta vieja" },
          { role: "user", content: "pregunta de hoy" },
        ],
      }),
    );
    // Los bytes de ayer siguen siendo los bytes de hoy, así que el prefijo puede
    // crecer con la conversación. Ahí es donde vive el dinero de un agente.
    expect(p.vistas[0]!.stablePrefixMessages).toBe(5);
  });

  it("los bloques que inyecta la capa quedan FUERA del prefijo", async () => {
    const p = new Testigo();
    await capa(p).generate(peticion({ structuredData: { filas: [1, 2, 3] } }));

    const req = p.vistas[0]!;
    const prefijo = req.messages.slice(0, req.stablePrefixMessages);
    // El payload serializado cambia en cada petición: si entrara en el prefijo
    // se pagaría prima de escritura por texto que no se repite jamás.
    expect(JSON.stringify(prefijo)).not.toContain("filas");
    expect(JSON.stringify(req.messages)).toContain("filas");
    expect(prefijo.every((m) => m.role === "system")).toBe(true);
    expect(prefijo[0]!.content).toBe(POLITICA);
  });

  it("la última pregunta NUNCA está dentro del prefijo", async () => {
    const p = new Testigo();
    await capa(p).generate(peticion({ structuredData: { x: 1 } }));
    const req = p.vistas[0]!;
    const prefijo = req.messages.slice(0, req.stablePrefixMessages);
    expect(prefijo.map((m) => m.content)).not.toContain("¿Cuánto tarda un envío a Canarias?");
  });

  it("no se mete NADA variable en el prefijo: dos peticiones distintas comparten prefijo", async () => {
    const p = new Testigo();
    const c = capa(p);
    await c.generate(peticion({ messages: [
      { role: "system", content: POLITICA },
      { role: "user", content: "pregunta A" },
    ] }));
    await c.generate(peticion({ messages: [
      { role: "system", content: POLITICA },
      { role: "user", content: "pregunta B totalmente distinta" },
    ] }));

    const [a, b] = p.vistas;
    const prefA = a!.messages.slice(0, a!.stablePrefixMessages).map((m) => m.content);
    const prefB = b!.messages.slice(0, b!.stablePrefixMessages).map((m) => m.content);
    // Si aquí hubiera un timestamp, un id de petición o el orden de un mapa, el
    // acierto de caché sería CERO y nadie se enteraría: no rompe ningún test que
    // no sea éste.
    expect(prefA).toEqual(prefB);
    // Y la clave de enrutado que se le pasa a OpenAI es la misma, que es lo que
    // hace que las dos caigan en la instancia que ya tiene el prefijo caliente.
    expect(a!.promptCacheKey).toBe(b!.promptCacheKey);
  });

  it("la clave de enrutado no lleva texto del cliente", async () => {
    const p = new Testigo();
    await capa(p).generate(peticion());
    // Va hasheada: es una pista de enrutado, no una frontera de aislamiento, y
    // no puede filtrar el prompt de nadie.
    expect(p.vistas[0]!.promptCacheKey).toMatch(/^[0-9a-f]{16,}$/);
    expect(p.vistas[0]!.promptCacheKey).not.toContain("asistente");
  });
});

describe("cuándo el pipeline NO reclama prefijo", () => {
  it("un modelo de proveedor desconocido no se marca", async () => {
    const p = new Testigo();
    await capa(p).generate(peticion({ model: "algun-modelo-casero-v2" }));
    // Marcar un prefijo cuyo precio no sabemos poner es apostar con dinero del
    // cliente. Dejar de capturar un descuento sólo es un ahorro no capturado.
    expect(p.vistas[0]!.stablePrefixMessages).toBeUndefined();
  });

  it("si el selector PODA herramientas, el prefijo no se puede llamar estable", async () => {
    const p = new Testigo();
    const tools: ToolDescriptor[] = [
      { id: "envios", intents: ["envío"], risk: "read" },
      { id: "facturas", intents: ["factura"], risk: "read" },
    ];
    await capa(p, { toolSelector: new ToolSelector({ maxTools: 8 }) }).generate(
      peticion({ tools }),
    );

    const req = p.vistas[0]!;
    // Sólo "envios" casa con la pregunta: el conjunto depende de la consulta.
    expect(req.tools?.map((t) => t.id)).toEqual(["envios"]);
    // Y `tools` se renderiza LO PRIMERO, así que un conjunto que cambia con la
    // pregunta mueve el principio del prompt e invalida todo lo que va detrás.
    // Marcar ahí sería pagar la prima de escritura a cambio de nada.
    expect(req.stablePrefixMessages).toBeUndefined();
  });

  it("sin poda, el conjunto no depende de la pregunta y el prefijo vuelve", async () => {
    const p = new Testigo();
    const tools: ToolDescriptor[] = [
      { id: "envios", intents: ["envío"], risk: "read" },
      { id: "canarias", intents: ["canarias"], risk: "read" },
    ];
    await capa(p, { toolSelector: new ToolSelector({ maxTools: 8 }) }).generate(
      peticion({ tools }),
    );
    const req = p.vistas[0]!;
    expect(req.tools?.map((t) => t.id)).toEqual(["canarias", "envios"]);
    expect(req.stablePrefixMessages).toBe(1);
  });
});

describe("la compresión y el prefijo, que se pisan", () => {
  /** Compresor que de verdad acorta: sustituye el texto por una versión corta. */
  const compresor = {
    async compress({ text }: { text: string }) {
      const compressed = text.length > 20 ? text.slice(0, 10) : text;
      return {
        compressed,
        originalTokens: text.length,
        compressedTokens: compressed.length,
        protectedSpans: 0,
        fidelityPassed: true,
        skipped: false,
        reason: "test",
      };
    },
  };

  const CONVERSACION = [
    { role: "system" as const, content: POLITICA },
    { role: "user" as const, content: "un turno viejo bastante largo del historial" },
    { role: "assistant" as const, content: "una respuesta vieja bastante larga del historial" },
    // Tercer turno: con uno solo detrás, el historial no se marca (no hay
    // evidencia de reenvío) y este bloque no probaría nada sobre el recorte.
    { role: "user" as const, content: "otro turno viejo bastante largo del historial" },
    { role: "assistant" as const, content: "otra respuesta vieja bastante larga del historial" },
    { role: "user" as const, content: "la pregunta de hoy" },
  ];

  /**
   * LAS VERJAS ECONÓMICAS DE LA COMPRESIÓN, ABIERTAS A PROPÓSITO.
   *
   * Desde que comprimir pasa por la caja, `shouldCompress` corta por TAMAÑO
   * antes de nada: por defecto no toca un contexto de menos de 2000 tokens, y el
   * historial de este fichero tiene ~30. Con los valores por defecto la etapa 9
   * se salta entera, `messages` no se sustituye, y el recorte del prefijo que
   * este bloque existe para probar NO LLEGA A EJECUTARSE NUNCA: los tests
   * pasarían en verde sobre una guarda muerta, que es justo el fallo que la
   * mutación encontró la primera vez.
   *
   * Así que se declara una economía que deja pasar la compresión. No es aflojar
   * la verja: es ponerla donde el escenario del test la necesita para que lo que
   * se prueba —la interacción entre compresión y prefijo— ocurra de verdad.
   */
  const ECONOMIA_PERMISIVA = {
    minimumContextTokens: 1,
    minimumNetTokens: 1,
    compressorCostTokens: 0,
  };

  it("si la compresión reescribe el historial, el prefijo se recorta a `system`", async () => {
    const p = new Testigo();
    await capa(p, {
      compressor: compresor,
      entitlements: ["long_context_compression"],
      compressionEconomics: ECONOMIA_PERMISIVA,
    }).generate(peticion({ messages: CONVERSACION, savings: { compression: true } }));

    const req = p.vistas[0]!;
    // EL FALLO QUE ESTO CIERRA. La compresión reescribe mensajes que no son
    // `system`, o sea que puede tocar el historial que habíamos metido en el
    // prefijo. Si el prefijo siguiera declarando 3 mensajes, los bytes ya no
    // coincidirían con los de la petición anterior: el proveedor lo trataría
    // como nuevo, cobraría la PRIMA de escritura, y no acertaría nunca. Se
    // pagaría de más en cada petición, para siempre, por un prefijo que ya no
    // existe.
    const prefijo = req.messages.slice(0, req.stablePrefixMessages);
    expect(prefijo.every((m) => m.role === "system")).toBe(true);
    expect(req.stablePrefixMessages).toBe(1);
    // Y se comprueba que la compresión de verdad corrió sobre el historial: sin
    // eso el test pasaría por el motivo equivocado.
    expect(req.messages.some((m) => m.role === "user" && m.content.length <= 10)).toBe(true);
  });

  it("sin compresión, el mismo historial SÍ cuenta como prefijo", async () => {
    const p = new Testigo();
    await capa(p).generate(peticion({ messages: CONVERSACION }));
    // El contraste es el que hace portante al test de arriba: la diferencia la
    // provoca la compresión, no la forma de la conversación.
    expect(p.vistas[0]!.stablePrefixMessages).toBe(5);
  });

  it("si la verja económica RECHAZA la compresión, el prefijo NO se recorta", async () => {
    const p = new Testigo();
    await capa(p, {
      compressor: compresor,
      entitlements: ["long_context_compression"],
      // Sin economía permisiva mandan los valores por defecto y la verja de
      // tamaño (2000 tokens) rechaza este contexto de ~30.
    }).generate(peticion({ messages: CONVERSACION, savings: { compression: true } }));

    const req = p.vistas[0]!;
    // EL CASO QUE NACIÓ AL COMPONER LAS DOS PALANCAS. Ahora el compresor puede
    // correr y que su resultado se DESCARTE por no salir a cuenta. El prompt que
    // recibe el proveedor es entonces el original, byte a byte, así que el
    // prefijo sigue intacto y recortarlo sería regalar el descuento por una
    // reescritura que nadie llegó a ver. La pérdida sería muda: ningún test
    // falla, sólo bajan los aciertos.
    expect(req.stablePrefixMessages).toBe(5);
    // Y se comprueba que el prompt NO se comprimió, para que el test no pase por
    // el motivo equivocado.
    expect(req.messages.some((m) => m.role === "user" && m.content.length <= 10)).toBe(false);
  });
});

describe("el orden de las herramientas, que va lo PRIMERO del prompt", () => {
  const TOOLS: ToolDescriptor[] = [
    { id: "zeta_envios", intents: ["envío", "envio"], risk: "read" },
    { id: "alfa_facturas", intents: ["factura"], risk: "read" },
  ];

  it("el mismo conjunto sale en el mismo ORDEN, gane quien gane la puntuación", () => {
    const sel = new ToolSelector({ maxTools: 8 });
    // Dos preguntas que seleccionan LAS MISMAS DOS herramientas, pero que las
    // puntúan al revés la una de la otra.
    const a = sel.select("necesito la factura del envío", TOOLS, "NO_RETRIEVAL");
    const b = sel.select("el envío de la factura, la factura sobre todo", TOOLS, "NO_RETRIEVAL");

    expect(a.tools.map((t) => t.id)).toEqual(["alfa_facturas", "zeta_envios"]);
    // ANTES esto ordenaba por puntuación descendente, así que el bloque `tools`
    // cambiaba de orden entre estas dos preguntas. Como `tools` se renderiza lo
    // primero, ese reordenado invalida la caché de prefijo ENTERA y el acierto
    // se va a ~0 en tráfico con herramientas.
    expect(b.tools.map((t) => t.id)).toEqual(a.tools.map((t) => t.id));
  });

  it("estabilizar el orden no le quita nada a la poda ni al libro 2", () => {
    const sel = new ToolSelector({ maxTools: 8 });
    const r = sel.select("quiero la factura", TOOLS, "NO_RETRIEVAL");
    // El CONJUNTO lo sigue eligiendo la puntuación: se poda igual que antes y lo
    // descartado sigue disponible para el libro 2. Sólo cambia el orden de
    // emisión, que es gratis.
    expect(r.tools.map((t) => t.id)).toEqual(["alfa_facturas"]);
    expect(r.droppedIds).toEqual(["zeta_envios"]);
  });

  it("el selector DECLARA si el conjunto depende de la pregunta", () => {
    const sel = new ToolSelector({ maxTools: 8 });
    expect(sel.select("quiero la factura", TOOLS, "NO_RETRIEVAL").setIsStable).toBe(false);
    expect(sel.select("factura del envio", TOOLS, "NO_RETRIEVAL").setIsStable).toBe(true);
    // Con el router apagado el conjunto lo fija el llamante y el corte es
    // posicional: sale el mismo pase lo que pase.
    expect(sel.passthrough(TOOLS).setIsStable).toBe(true);
  });
});

describe("el libro 4 y la prima de escritura", () => {
  it("los tokens leídos de caché alimentan el libro 4", async () => {
    const p = new Testigo({ inputTokens: 1000, outputTokens: 10, cachedInputTokens: 800 });
    const r = await capa(p).generate(peticion());
    expect(r.report.tokens.providerCachedInput).toBe(800);
  });

  it("la PRIMA de escritura no se acredita como ahorro en ningún libro", async () => {
    const p = new Testigo({ inputTokens: 1000, outputTokens: 10, cacheWriteInputTokens: 800 });
    const r = await capa(p).generate(peticion());
    // `cache_creation_input_tokens` es dinero que el cliente paga DE MÁS por
    // escribir la caché (1,25x). Si apareciera en el libro 4 estaríamos
    // publicando un sobrecoste como si fuera un descuento.
    expect(r.report.tokens.providerCachedInput).toBeUndefined();
  });

  it("el descuento del proveedor NO se acredita como ahorro de BV-SALA", async () => {
    const p = new Testigo({ inputTokens: 1000, outputTokens: 10, cachedInputTokens: 900 });
    const r = await capa(p).generate(peticion());
    // Se CUENTA (libro 4) pero no se COBRA: `accounting.ts` tarifa los tokens
    // cacheados a la tarifa cacheada en los DOS lados del cociente. Sin eso, una
    // petición en la que la capa no hiciera nada reportaría ahorro sólo porque
    // el proveedor aplicó un descuento que habría aplicado igual.
    expect(r.report.tokens.providerCachedInput).toBe(900);
    expect(r.report.cost.netSavingsRatio).toBe(0);
  });
});

/**
 * LA FRONTERA DEL PREFIJO CONTRA LOS TRES BLOQUES QUE INYECTA LA CAPA.
 *
 * Estas dos palancas se escribieron a la vez y sin verse: el montaje segmentado
 * calcula la frontera sobre `request.messages`, y el orden del prompt mete
 * límites · payload · evidencia DELANTE de la última pregunta. Componen porque
 * los tres bloques entran por `insertarAntesDeLaPregunta`, o sea DESPUÉS del
 * corte —empujan la pregunta a la derecha y no tocan los `q` mensajes de
 * delante—, pero eso es un razonamiento, y un razonamiento no es una verja.
 *
 * Lo que se fija aquí es la propiedad de la que depende el dinero: los tres
 * bloques quedan FUERA del tramo que se le declara estable al proveedor. El caso
 * peligroso es la evidencia de retrieval, que es el bloque más grande y el más
 * variable —cambia con cada consulta—: si entrara en el prefijo, cada petición
 * pagaría la prima de escritura (1,25x) sobre texto que no se repite jamás y no
 * leería nada. El test que ya había sólo miraba el payload, que es el bloque que
 * respetaba la posición ANTES de que los otros dos se movieran.
 */
class TestigoDeContrato implements Provider {
  readonly id = "testigo-contrato";
  readonly vistas: ProviderRequest[] = [];
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.vistas.push(req);
    // La primera respuesta incumple `maxLength` para que el contrato "aprenda" y
    // la SIGUIENTE petición lleve el aviso de límites JSON: es la única forma de
    // tener los tres bloques a la vez en un mismo prompt.
    const texto =
      this.vistas.length === 1
        ? JSON.stringify({ answer: "x".repeat(3000) })
        : JSON.stringify({ answer: "ok" });
    return { text: texto, usage: { inputTokens: 100, outputTokens: 10 } };
  }
}

const RECUPERADOR = {
  async retrieve() {
    return [
      { id: "doc-1", text: "El envío a Canarias tarda 5 días hábiles.", source: "logistica" },
      { id: "doc-2", text: "Los pedidos de más de 50 EUR no pagan portes.", source: "tarifas" },
    ];
  },
};

const CONTRATO = {
  contractId: "prefijo-vs-orden:v1",
  schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" as const, maxLength: 40 } },
  },
  maxOutputTokens: 120,
};

describe("la frontera del prefijo con los TRES bloques de la capa dentro", () => {
  /** Una petición que dispara los tres bloques: límites, payload y evidencia. */
  const conLosTres = (pregunta: string, importe: number) =>
    peticion({
      messages: [
        { role: "system", content: POLITICA },
        { role: "user", content: pregunta },
      ],
      response: CONTRATO,
      retrieval: { mode: "single" },
      structuredData: [{ id: 1, concepto: "portes", importe }],
      savings: { exactCache: false },
    } as Partial<SavingsRequest>);

  async function dosPeticiones() {
    const p = new TestigoDeContrato();
    const c = capa(p, { retriever: RECUPERADOR });
    // La primera enseña el incumplimiento; la segunda ya lleva los tres bloques.
    await c.generate(conLosTres("¿Cuánto tarda un envío a Canarias?", 100));
    await c.generate(conLosTres("¿Y a Baleares, con portes incluidos?", 250));
    // Las llamadas de REPARACIÓN se descartan: llevan un prompt propio (la
    // respuesta anterior y la lista de fallos) que no es el montaje segmentado
    // que se está probando aquí. Contarlas comparaba peras con manzanas.
    return p.vistas.filter((r) => r.messages[0]?.content === POLITICA);
  }

  it("los tres bloques —límites, payload y evidencia— quedan FUERA del prefijo", async () => {
    const vistas = await dosPeticiones();
    const req = vistas.find((r) => r.messages.some((m) => m.content.includes("JSON limits")));
    expect(req, "ninguna petición llevó el aviso de límites").toBeDefined();

    const prefijo = req!.messages.slice(0, req!.stablePrefixMessages);
    const texto = JSON.stringify(prefijo);
    // Los tres, de más estable a más variable. Ninguno puede estar dentro.
    expect(texto).not.toContain("JSON limits");
    expect(texto).not.toContain("concepto");
    expect(texto).not.toContain("Retrieved context");
    // …y sí están en el prompt: no se comprueba el vacío por accidente.
    const todo = JSON.stringify(req!.messages);
    expect(todo).toContain("JSON limits");
    expect(todo).toContain("concepto");
    expect(todo).toContain("Retrieved context");
  });

  it("la frontera sigue cayendo donde debe: el prefijo es la cabecera del llamante", async () => {
    const vistas = await dosPeticiones();
    const req = vistas.find((r) => r.messages.some((m) => m.content.includes("JSON limits")))!;
    // Se calcula sobre `request.messages`, así que vale 1 (la política) aunque el
    // array que sale lleve tres mensajes más. Si la frontera se calculara sobre el
    // array YA montado, aquí saldría 4 y los tres bloques entrarían en el prefijo.
    expect(req.stablePrefixMessages).toBe(1);
    expect(req.messages.slice(0, req.stablePrefixMessages)[0]!.content).toBe(POLITICA);
    expect(req.messages.length).toBeGreaterThan(req.stablePrefixMessages! + 1);
  });

  it("la evidencia, que es lo más variable, queda por detrás del payload y fuera del prefijo", async () => {
    const vistas = await dosPeticiones();
    const req = vistas.find((r) => r.messages.some((m) => m.content.includes("JSON limits")))!;
    const idx = (aguja: string) => req.messages.findIndex((m) => m.content.includes(aguja));

    const limites = idx("JSON limits");
    const payload = idx("concepto");
    const evidencia = idx("Retrieved context");
    const pregunta = req.messages.map((m) => m.role).lastIndexOf("user");

    // El orden medido de #64 sigue en pie…
    expect(limites).toBeLessThan(payload);
    expect(payload).toBeLessThan(evidencia);
    expect(evidencia).toBeLessThan(pregunta);
    // …y entero por detrás de la frontera del prefijo, que es lo que esta rama
    // necesita que se cumpla.
    expect(req.stablePrefixMessages!).toBeLessThanOrEqual(limites);
  });

  it("dos consultas distintas comparten los MISMOS bytes de prefijo", async () => {
    const [a, b] = await dosPeticiones();
    const bytes = (r: ProviderRequest) =>
      JSON.stringify(r.messages.slice(0, r.stablePrefixMessages));
    // Evidencia distinta, payload distinto y pregunta distinta en las dos, y aun
    // así el prefijo es idéntico: es exactamente de lo que depende que el
    // proveedor pueda servirlo a 0,10x. Si un bloque de la capa se colara en el
    // prefijo, este igualdad se rompería y el acierto se iría a cero.
    expect(bytes(a!)).toBe(bytes(b!));
    expect(a!.promptCacheKey).toBe(b!.promptCacheKey);
  });
});
