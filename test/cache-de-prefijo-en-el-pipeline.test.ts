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
          { role: "user", content: "pregunta de hoy" },
        ],
      }),
    );
    // Los bytes de ayer siguen siendo los bytes de hoy, así que el prefijo puede
    // crecer con la conversación. Ahí es donde vive el dinero de un agente.
    expect(p.vistas[0]!.stablePrefixMessages).toBe(3);
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
    { role: "user" as const, content: "la pregunta de hoy" },
  ];

  it("si la compresión reescribe el historial, el prefijo se recorta a `system`", async () => {
    const p = new Testigo();
    await capa(p, {
      compressor: compresor,
      entitlements: ["long_context_compression"],
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
    expect(p.vistas[0]!.stablePrefixMessages).toBe(3);
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
    expect(r.report.cost.netSavings).toBe(0);
  });
});
