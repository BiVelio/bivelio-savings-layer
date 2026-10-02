import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import {
  decidirDescubrimiento,
  descriptorLigero,
  herramientasDeLaSegunda,
  peorCasoDeEsquemas,
  MAX_LECTURAS_DE_LA_SEGUNDA,
  SALIDA_DEL_SONDEO_TOKENS,
} from "../src/router/schema-on-demand.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { JsonSchema, ToolDescriptor } from "../src/contracts/types.js";
import { ToolSelector } from "../src/router/tool-selector.js";

/**
 * SCHEMA-ON-DEMAND: el esquema completo solo viaja cuando se sabe cuál hace falta.
 *
 * Lo que estos tests fijan, por orden de gravedad si se rompiera:
 *
 *  1. Una herramienta de ESCRITURA nunca se pierde por el camino. El fallo que
 *     este repo ya sufrió una vez es mudo y se contabiliza como éxito.
 *  2. La verja económica manda. Sin ella el patrón cobra dos llamadas para
 *     ahorrar tokens que valían menos que la segunda llamada.
 *  3. El sondeo degrada, nunca revienta ni se sirve como respuesta.
 *  4. El sondeo no se paga a sí mismo: sus tokens no entran en el baseline.
 */

const PRECIOS = { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } };

/** Un esquema gordo, del tamaño al que este patrón empieza a tener sentido. */
function esquemaGordo(prefijo: string): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (let i = 0; i < 12; i++) {
    properties[`${prefijo}_field_${i}`] = {
      type: "string",
      description: `The ${prefijo} field number ${i}, expressed as a fully qualified value`,
      maxLength: 120,
    };
  }
  return { type: "object", properties, required: Object.keys(properties) };
}

function lectura(id: string): ToolDescriptor {
  return {
    id,
    intents: [`customer ${id} lookup`],
    risk: "read",
    description: `Look up ${id} for a customer`,
    parameters: esquemaGordo(id),
  };
}

const ENVIAR_FACTURA: ToolDescriptor = {
  id: "send_invoice",
  intents: ["send invoice"],
  risk: "write",
  description: "Send an invoice to a customer",
  parameters: esquemaGordo("invoice"),
};

/** 8 lecturas gordas: el catálogo donde el patrón gana. */
const CATALOGO_GRANDE = Array.from({ length: 8 }, (_, i) => lectura(`tool_${i}`));

class ProveedorGuionizado implements Provider {
  readonly id = "guion";
  llamadas: ProviderRequest[] = [];
  constructor(private readonly guion: Array<() => ProviderResponse>) {}
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas.push(r);
    const paso = this.guion[Math.min(this.llamadas.length - 1, this.guion.length - 1)]!;
    return paso();
  }
}

const eligeHerramientas = (...nombres: string[]) => (): ProviderResponse => ({
  text: "",
  usage: { inputTokens: 500, outputTokens: 10 },
  finishReason: "tool_calls",
  toolCalls: nombres.map((name, i) => ({ id: `call_${i}`, name, arguments: "{}" })),
});

const respuestaFinal = (texto: string, inputTokens = 800) => (): ProviderResponse => ({
  text: texto,
  usage: { inputTokens, outputTokens: 100 },
  finishReason: "stop",
});

const peticion = (tools: ToolDescriptor[], toolDiscovery = true) => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "look up the customer record for order 42" }],
  tools,
  // `router:false` para que el selector pase las herramientas del llamante tal
  // cual: lo que se prueba aquí es el descubrimiento, no la selección léxica.
  savings: { router: false, toolDiscovery },
});

// ---------------------------------------------------------------------------
// La verja económica, en aislamiento.
// ---------------------------------------------------------------------------

const VERJA_BASE = {
  promptTokens: 40,
  esquemasCompletos: 3200,
  descriptoresLigeros: 160,
  esquemasDeLaSegunda: 1200,
  salidaFinal: 256,
  salidaDelSondeo: 96,
  precio: { inputPer1k: 0.00015, outputPer1k: 0.0006 },
};

describe("la verja económica del descubrimiento", () => {
  it("aprueba un catálogo grande: los esquemas evitados pagan el prompt repetido", () => {
    const d = decidirDescubrimiento(VERJA_BASE);
    expect(d.aplicar).toBe(true);
    expect(d.ganancia).toBeGreaterThan(0);
    expect(d.costeDeDosLlamadas).toBeLessThan(d.costeDeUnaLlamada);
  });

  it("rechaza un catálogo pequeño: la segunda llamada cuesta más de lo que evita", () => {
    // Tres herramientas pequeñas: casi todo lo que hay ya viaja en la segunda.
    const d = decidirDescubrimiento({
      ...VERJA_BASE,
      esquemasCompletos: 300,
      descriptoresLigeros: 60,
      esquemasDeLaSegunda: 300,
    });
    expect(d.aplicar).toBe(false);
    expect(d.ganancia).toBeLessThan(0);
    expect(d.razon).toContain("twice");
  });

  it("exige que la ganancia cubra el coste de degradar, no solo que sea positiva", () => {
    // Caso construido en la franja: gana, pero menos de lo que cuesta un sondeo
    // que no sirva para nada. Ahí el patrón NO se aplica.
    const d = decidirDescubrimiento({
      ...VERJA_BASE,
      esquemasCompletos: 1900,
      esquemasDeLaSegunda: 1200,
    });
    expect(d.ganancia).toBeGreaterThan(0);
    expect(d.ganancia).toBeLessThan(d.perdidaSiDegrada);
    expect(d.aplicar).toBe(false);
    expect(d.razon).toContain("degrading");
  });

  it("decide en DINERO: encarecer la salida tumba una decisión que estaba aprobada", () => {
    const justa = { ...VERJA_BASE, esquemasCompletos: 2500, esquemasDeLaSegunda: 1200 };
    expect(decidirDescubrimiento(justa).aplicar).toBe(true);
    // Mismos tokens, exactamente. Solo cambia el precio de la salida, que es lo
    // que paga el sondeo: un modelo de razonamiento caro vuelve perdedor el mismo
    // catálogo. Una verja que decidiera por ratio de tokens no lo vería.
    const cara = decidirDescubrimiento({
      ...justa,
      precio: { inputPer1k: 0.00015, outputPer1k: 0.0025 },
    });
    expect(cara.aplicar).toBe(false);
  });

  it("un prompt enorme también la tumba: se paga dos veces", () => {
    const d = decidirDescubrimiento({ ...VERJA_BASE, promptTokens: 4000 });
    expect(d.aplicar).toBe(false);
  });
});

describe("el peor caso de la segunda llamada es una cota de verdad", () => {
  // Si esta cuenta se quedara corta, la verja aprobaría peticiones que pierden
  // dinero: decidiría con un presupuesto que la segunda llamada se salta.
  const costes: Record<string, number> = {};
  const candidatas: ToolDescriptor[] = [
    ...Array.from({ length: 6 }, (_, i) => lectura(`r${i}`)),
    ENVIAR_FACTURA,
    { id: "drop_table", intents: ["drop"], risk: "destructive", parameters: esquemaGordo("drop") },
  ];
  candidatas.forEach((t, i) => (costes[t.id] = 100 + i * 37));
  const tokensDe = (t: ToolDescriptor): number => costes[t.id]!;
  const cota = peorCasoDeEsquemas(
    candidatas.map((t) => ({ risk: t.risk, tokens: tokensDe(t) })),
    MAX_LECTURAS_DE_LA_SEGUNDA,
  );

  it("ninguna elección posible del modelo la supera", () => {
    const nombres = candidatas.map((t) => t.id);
    // Todos los subconjuntos de hasta 8 nombres, más basura inventada.
    for (let mascara = 0; mascara < 1 << nombres.length; mascara++) {
      const elegidos = nombres.filter((_, i) => (mascara >> i) & 1);
      const { tools } = herramientasDeLaSegunda(
        [...elegidos, "no_existe"],
        candidatas,
        MAX_LECTURAS_DE_LA_SEGUNDA,
      );
      const coste = tools.reduce((n, t) => n + tokensDe(t), 0);
      expect(coste).toBeLessThanOrEqual(cota);
    }
  });

  it("la cota son todas las de escritura más las lecturas más caras", () => {
    const escrituras = candidatas.filter((t) => t.risk !== "read").reduce((n, t) => n + tokensDe(t), 0);
    const lecturas = candidatas
      .filter((t) => t.risk === "read")
      .map(tokensDe)
      .sort((a, b) => b - a)
      .slice(0, MAX_LECTURAS_DE_LA_SEGUNDA)
      .reduce((n, t) => n + t, 0);
    expect(cota).toBe(escrituras + lecturas);
  });
});

describe("el descriptor ligero", () => {
  it("no lleva `parameters` — que es todo el volumen que se quiere evitar", () => {
    expect(descriptorLigero(ENVIAR_FACTURA).parameters).toBeUndefined();
    expect(descriptorLigero(ENVIAR_FACTURA).id).toBe("send_invoice");
    expect(descriptorLigero(ENVIAR_FACTURA).risk).toBe("write");
  });

  it("cuando no hay `description` usa los intents: un sondeo sobre nombres pelados es adivinar", () => {
    const sinTexto: ToolDescriptor = { id: "x", intents: ["refund an order", "cancel"], risk: "read" };
    expect(descriptorLigero(sinTexto).description).toBe("refund an order; cancel");
  });

  it("recorta a una línea", () => {
    const multilinea: ToolDescriptor = {
      id: "x",
      intents: [],
      risk: "read",
      description: "Primera línea\nSegunda línea con ejemplos largos",
    };
    expect(descriptorLigero(multilinea).description).toBe("Primera línea");
  });
});

// ---------------------------------------------------------------------------
// El patrón, extremo a extremo.
// ---------------------------------------------------------------------------

describe("schema-on-demand en el pipeline", () => {
  it("sondea con descriptores ligeros y solo entonces manda el esquema completo", async () => {
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("tool_3"),
      respuestaFinal("listo"),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const res = await capa.generate(peticion(CATALOGO_GRANDE));

    expect(proveedor.llamadas).toHaveLength(2);

    const sondeo = proveedor.llamadas[0]!;
    expect(sondeo.tools).toHaveLength(8);
    expect(sondeo.tools!.every((t) => t.parameters === undefined)).toBe(true);
    // El sondeo no arrastra el contrato de salida: pedirle la respuesta final es
    // justo lo que todavía no queremos.
    expect(sondeo.schema).toBeUndefined();

    const invocacion = proveedor.llamadas[1]!;
    expect(invocacion.tools!.map((t) => t.id)).toEqual(["tool_3"]);
    expect(invocacion.tools![0]!.parameters).toEqual(esquemaGordo("tool_3"));

    // La respuesta que se sirve es la de la SEGUNDA llamada.
    expect(res.text).toBe("listo");
    // Y el informe dice que hubo dos: el cliente no puede enterarse de esto por
    // su factura de latencia.
    expect(res.report.calls.actualLlm).toBe(2);
    expect(res.report.calls.actualTools).toBe(1);
    expect(
      res.report.traces.find((t) => t.stage === "tool-discovery")?.outcome,
    ).toContain("applied");
  });

  it("está APAGADO por defecto: el mismo catálogo sale en una sola llamada", async () => {
    const proveedor = new ProveedorGuionizado([respuestaFinal("listo")]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const res = await capa.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "look up the customer record for order 42" }],
      tools: CATALOGO_GRANDE,
      savings: { router: false },
    });
    expect(proveedor.llamadas).toHaveLength(1);
    expect(proveedor.llamadas[0]!.tools).toHaveLength(8);
    expect(res.report.calls.actualLlm).toBe(1);
    expect(res.report.traces.some((t) => t.stage === "tool-discovery")).toBe(false);
  });

  it("con un catálogo pequeño la verja lo desactiva sola: una llamada, no dos", async () => {
    const proveedor = new ProveedorGuionizado([respuestaFinal("listo")]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const res = await capa.generate(
      peticion([
        { id: "a", intents: ["a"], risk: "read" },
        { id: "b", intents: ["b"], risk: "read" },
      ]),
    );
    expect(proveedor.llamadas).toHaveLength(1);
    const traza = res.report.traces.find((t) => t.stage === "tool-discovery");
    expect(traza?.outcome).toContain("skipped");
  });
});

/**
 * EL CUIDADO QUE NO ES NEGOCIABLE.
 *
 * `retrieval:{mode:"off"}` dejaba `tools: []`, el proveedor no veía la capacidad,
 * el modelo contestaba «claro, la reenvío» y la factura NO se reenviaba — con el
 * informe presentándolo como éxito económico. Un descubrimiento que se coma una
 * herramienta de escritura reproduce ese fallo exacto.
 */
describe("una herramienta de escritura no se pierde en el descubrimiento", () => {
  const conEscritura = [...CATALOGO_GRANDE.slice(0, 7), ENVIAR_FACTURA];

  it("viaja con su esquema completo aunque el sondeo elija otra cosa", async () => {
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("tool_3"), // el sondeo NO elige send_invoice
      respuestaFinal("listo"),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    await capa.generate(peticion(conEscritura));

    const invocacion = proveedor.llamadas[1]!;
    const enviadas = invocacion.tools!.map((t) => t.id);
    expect(enviadas).toContain("send_invoice");
    expect(invocacion.tools!.find((t) => t.id === "send_invoice")!.parameters).toEqual(
      esquemaGordo("invoice"),
    );
  });

  it("y también cuando el sondeo no elige nada en absoluto", async () => {
    const proveedor = new ProveedorGuionizado([
      () => ({ text: "sure, I'll send it", usage: { inputTokens: 500, outputTokens: 8 }, finishReason: "stop" }),
      respuestaFinal("listo"),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    await capa.generate(peticion(conEscritura));

    expect(proveedor.llamadas[1]!.tools!.map((t) => t.id)).toContain("send_invoice");
  });

  it("con el router ENCENDIDO (selector real, TOOL_ACTION) tampoco se pierde", async () => {
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("tool_1"),
      respuestaFinal("listo"),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    await capa.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "send the invoice for the customer order 42" }],
      tools: conEscritura,
      savings: { toolDiscovery: true },
    });

    expect(proveedor.llamadas).toHaveLength(2);
    expect(proveedor.llamadas[1]!.tools!.map((t) => t.id)).toContain("send_invoice");
  });
});

describe("el sondeo degrada, nunca revienta ni se sirve como respuesta", () => {
  it("si la primera llamada falla, la petición sale con TODOS los esquemas", async () => {
    let primera = true;
    const proveedor = new ProveedorGuionizado([
      () => {
        if (primera) {
          primera = false;
          throw new Error("502 del proveedor en el sondeo");
        }
        return respuestaFinal("listo")();
      },
      respuestaFinal("listo"),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const res = await capa.generate(peticion(CATALOGO_GRANDE));

    // El cliente recibe su respuesta: el patrón no puede ser un punto de caída nuevo.
    expect(res.text).toBe("listo");
    expect(proveedor.llamadas).toHaveLength(2);
    expect(proveedor.llamadas[1]!.tools).toHaveLength(8);
    expect(proveedor.llamadas[1]!.tools!.every((t) => t.parameters !== undefined)).toBe(true);
    expect(
      res.report.traces.find((t) => t.stage === "tool-discovery")?.outcome,
    ).toContain("failed");
  });

  it("una respuesta de TEXTO del sondeo no se sirve: se manda la llamada de verdad", async () => {
    const proveedor = new ProveedorGuionizado([
      () => ({
        text: "sure, I'll look that up",
        usage: { inputTokens: 500, outputTokens: 8 },
        finishReason: "stop",
      }),
      respuestaFinal("la de verdad"),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const res = await capa.generate(peticion(CATALOGO_GRANDE));

    expect(res.text).toBe("la de verdad");
    expect(proveedor.llamadas[1]!.tools).toHaveLength(8);
    expect(
      res.report.traces.find((t) => t.stage === "tool-discovery")?.outcome,
    ).toContain("degraded");
  });

  it("nombres inventados por el modelo no abren ninguna capacidad y degradan", async () => {
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("herramienta_que_no_existe"),
      respuestaFinal("listo"),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const res = await capa.generate(peticion(CATALOGO_GRANDE));

    expect(proveedor.llamadas[1]!.tools).toHaveLength(8);
    const traza = res.report.traces.find((t) => t.stage === "tool-discovery");
    expect(traza?.outcome).toContain("degraded");
    expect(traza?.detail?.["unknownNames"]).toEqual(["herramienta_que_no_existe"]);
  });
});

/**
 * REVISIÓN. Dos verjas que la primera versión daba por hechas sin fijarlas.
 */
describe("el techo de salida del sondeo llega de verdad al proveedor", () => {
  // La verja presupuesta la salida del sondeo a `SALIDA_DEL_SONDEO_TOKENS` y su
  // docstring dice, literalmente, que ese número «no es una estimación sino un
  // límite que se le pasa al proveedor, así que la verja puede usarlo como peor
  // caso sin suponer nada». Nada lo comprobaba: quitando el `maxOutputTokens` de
  // la llamada del sondeo no caía NI UNO de los 1077 tests, ni el typecheck. Y
  // sin ese tope la aritmética decide con un peor caso que el proveedor no
  // respeta: un modelo que se pone a razonar en vez de elegir gasta salida —a 4x
  // el precio de la entrada— hasta el tope que tenga por defecto.
  it("la llamada del sondeo lleva el tope, y la de verdad NO lo hereda", async () => {
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("tool_3"),
      respuestaFinal("listo"),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    await capa.generate(peticion(CATALOGO_GRANDE));

    expect(proveedor.llamadas[0]!.maxOutputTokens).toBe(SALIDA_DEL_SONDEO_TOKENS);
    // El presupuesto de salida del CLIENTE es cosa suya: el techo del sondeo no
    // puede colarse en la llamada que sí le responde.
    expect(proveedor.llamadas[1]!.maxOutputTokens).toBeUndefined();
  });
});

/**
 * LA VISTA RECORTADA NO SE CACHEA.
 *
 * Reproducido antes del arreglo: el sondeo elige una herramienta, la invocación
 * solo ve esa, el modelo contesta «no tengo una herramienta para eso» —texto
 * válido, sin tool calls— y esa respuesta se guardaba 24 h. La petición idéntica
 * siguiente, INCLUSO SIN la palanca, la servía de caché con `avoidedLlm: 1` y
 * `netSavings: 1`: una capacidad que escondió la capa, congelada un día y
 * publicada como el mayor ahorro posible sobre trabajo que nadie hizo.
 */
describe("una respuesta dada con menos herramientas de las declaradas no se cachea", () => {
  // Una pregunta NO personalizada: con la del resto del fichero la política
  // apaga la caché exacta sola y el test pasaría por el motivo equivocado.
  const preguntaCacheable = "summarise the late returns policy for the team";
  const peticionCacheable = (toolDiscovery: boolean) => ({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user" as const, content: preguntaCacheable }],
    tools: CATALOGO_GRANDE,
    savings: { router: false, toolDiscovery },
  });

  it("y la siguiente petición, sin la palanca, no cobra una llamada evitada", async () => {
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("tool_3"),
      () => ({
        text: "I do not have a tool to look that up.",
        usage: { inputTokens: 800, outputTokens: 20 },
        finishReason: "stop",
      }),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });

    const conPalanca = await capa.generate(peticionCacheable(true));
    // El escenario es el peligroso de verdad: respuesta VÁLIDA (no incumple
    // ningún contrato) y sin tool calls, así que las dos verjas que ya existían
    // la dejarían pasar a la caché.
    expect(conPalanca.report.constraints.structurallyValid).not.toBe(false);
    expect(conPalanca.toolCalls).toBeUndefined();
    expect(proveedor.llamadas[1]!.tools!.map((t) => t.id)).toEqual(["tool_3"]);
    expect(
      conPalanca.report.traces.find((t) => t.stage === "cache-write")?.outcome,
    ).toContain("reduced tool view");

    const sinPalanca = await capa.generate(peticionCacheable(false));
    expect(sinPalanca.report.cache.result).toBe("miss");
    expect(sinPalanca.report.calls.avoidedLlm).toBe(0);
    // Y sale al proveedor con el catálogo entero, que es lo que pidió.
    expect(proveedor.llamadas).toHaveLength(3);
    expect(proveedor.llamadas[2]!.tools).toHaveLength(8);
  });

  it("sin descubrimiento la misma respuesta SÍ se cachea: la verja es del recorte, no de la caché", async () => {
    const proveedor = new ProveedorGuionizado([
      () => ({
        text: "I do not have a tool to look that up.",
        usage: { inputTokens: 800, outputTokens: 20 },
        finishReason: "stop",
      }),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });

    await capa.generate(peticionCacheable(false));
    const segunda = await capa.generate(peticionCacheable(false));
    expect(segunda.report.cache.result).toBe("exact");
    expect(proveedor.llamadas).toHaveLength(1);
  });
});

describe("la contabilidad del sondeo es honesta", () => {
  it("una petición degradada se publica como PÉRDIDA, no como ahorro", async () => {
    const proveedor = new ProveedorGuionizado([
      () => ({ text: "hmm", usage: { inputTokens: 500, outputTokens: 8 }, finishReason: "stop" }),
      respuestaFinal("listo", 4000),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const res = await capa.generate(peticion(CATALOGO_GRANDE));

    // Se pagaron dos llamadas para mandar exactamente lo mismo que se habría
    // mandado en una. Si el sondeo entrara en el baseline, se pagaría a sí mismo
    // y esto saldría en positivo.
    expect(res.report.calls.actualLlm).toBe(2);
    expect(res.report.tokens.actualInput).toBe(4500);
    expect(res.report.tokens.baselineInput).toBe(4000);
    expect(res.report.cost.netSavingsRatio).toBeLessThan(0);
  });

  it("cuando el patrón funciona, el baseline sigue contando los esquemas evitados", async () => {
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("tool_3"),
      respuestaFinal("listo"),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const res = await capa.generate(peticion(CATALOGO_GRANDE));

    expect(res.report.tokens.actualInput).toBe(1300); // 500 del sondeo + 800 de la buena
    expect(res.report.tokens.baselineInput).toBeGreaterThan(res.report.tokens.actualInput);
    expect(res.report.cost.netSavingsRatio).toBeGreaterThan(0);
    // Un baseline RECONSTRUIDO no es dinero comprobable contra la factura.
    expect(res.report.cost.basis).toBe("estimated");
  });

  it("la salida del sondeo no engorda el baseline de salida", async () => {
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("tool_3"),
      respuestaFinal("listo"),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const res = await capa.generate(peticion(CATALOGO_GRANDE));

    expect(res.report.tokens.actualOutput).toBe(110); // 10 del sondeo + 100 de la buena
    expect(res.report.tokens.baselineOutput).toBe(100); // solo la respuesta del cliente
  });
});

// ---------------------------------------------------------------------------
// EL PATRÓN CONVIVIENDO CON LO QUE ENTRÓ EN `main` DESPUÉS DE ESCRIBIRLO.
//
// El rebase puso este patrón encima de tres cambios que tocan justo lo que él
// toca, y una resolución de conflicto puede dejar una verja HUÉRFANA sin que
// caiga ni un test. Lo que sigue es lo que fija que las tres siguen atadas:
//
//   · #69 codebook de salida  — etapas 10a/10b alrededor de la llamada.
//   · #65 libro 2             — los tokens de las herramientas descartadas.
//   · #68 intents normalizados — el selector pliega diacríticos en los dos lados.
// ---------------------------------------------------------------------------

/** Un esquema MUCHO más gordo: aquí la verja económica aprueba con holgura. */
function esquemaEnorme(prefijo: string): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (let i = 0; i < 40; i++) {
    properties[`${prefijo}_field_${i}`] = {
      type: "string",
      description:
        `The ${prefijo} field number ${i}, expressed as a fully qualified value ` +
        `including its unit, its currency where applicable and its provenance`,
      maxLength: 120,
    };
  }
  return { type: "object", properties, required: Object.keys(properties) };
}

const CONTRATO_TRIAJE: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "confidence", "evidence"],
  properties: {
    decision: { type: "string", enum: ["human_review", "auto_approve", "auto_reject"] },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    evidence: { type: "array", maxItems: 4, items: { type: "string", maxLength: 16 } },
  },
};

describe("descubrimiento + codebook de salida (#69): son ortogonales y se aplican los dos", () => {
  // EL DELTA MEDIDO VA EXPLÍCITO, y no es adorno del fixture: sin él la capa se
  // niega a aplicar el codebook contra `gpt-4o-mini`, porque para ese modelo hay
  // una medición en vivo que dice que la salida CRECE (−16 tokens, −8,2 % neto;
  // ver `constraints/codebook-evidencia.ts`). Lo que estos tests fijan es que las
  // dos palancas son ORTOGONALES y que la etapa 10b deshace lo que hizo la 10a,
  // no que el codebook pague en este modelo — así que la precondición se declara
  // aquí en vez de esconderla eligiendo el modelo que sale bien.
  const peticionConContrato = (toolDiscovery: boolean) => ({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user" as const, content: "summarise the late returns policy for the team" }],
    tools: CATALOGO_GRANDE,
    response: { contractId: "triage:v1", schema: CONTRATO_TRIAJE, maxOutputTokens: 200 },
    savings: {
      router: false,
      toolDiscovery,
      outputCodebook: true,
      outputCodebookMeasuredOutputDeltaTokens: 5,
    },
  });

  it("el sondeo no lleva NINGÚN contrato; la llamada de verdad lleva el COMPACTO y las elegidas", async () => {
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("tool_3"),
      () => ({
        // En la forma COMPACTA, que es la única que el proveedor conoce.
        text: JSON.stringify({ d: "H", c: 87, e: ["E17:4"] }),
        usage: { inputTokens: 800, outputTokens: 30 },
        finishReason: "stop",
        structuredNatively: true,
      }),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    const res = await capa.generate(peticionConContrato(true));

    expect(proveedor.llamadas).toHaveLength(2);

    // El sondeo: descriptores ligeros y CERO contrato de salida. Ni el del
    // llamante ni el compacto — su respuesta no se sirve jamás, así que pagar
    // tokens de contrato ahí sería pagarlos para tirarlos.
    const sondeo = proveedor.llamadas[0]!;
    expect(sondeo.schema).toBeUndefined();
    expect(sondeo.tools!.every((t) => t.parameters === undefined)).toBe(true);

    // La llamada de verdad lleva LAS DOS COSAS a la vez: el contrato compacto de
    // la etapa 10a y solo las herramientas que el sondeo eligió.
    const invocacion = proveedor.llamadas[1]!;
    expect(Object.keys(invocacion.schema?.properties ?? {})).toEqual(["d", "c", "e"]);
    expect(invocacion.tools!.map((t) => t.id)).toEqual(["tool_3"]);

    // Y la etapa 10b deshace el codebook antes de validar y de servir: lo que
    // sale por la puerta está en la forma del LLAMANTE.
    expect(res.data).toEqual({ decision: "human_review", confidence: 87, evidence: ["E17:4"] });
    expect(JSON.parse(res.text)).toEqual(res.data);
    expect(res.report.constraints.structurallyValid).toBe(true);
  });

  it("el techo del sondeo NO le come el presupuesto de salida al llamante", async () => {
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("tool_3"),
      () => ({
        text: JSON.stringify({ d: "H", c: 87, e: ["E17:4"] }),
        usage: { inputTokens: 800, outputTokens: 30 },
        finishReason: "stop",
        structuredNatively: true,
      }),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    await capa.generate(peticionConContrato(true));

    // El otro test del techo comprueba que la segunda llamada no lo HEREDA
    // cuando el llamante no puso ninguno (`undefined`). Este es el caso que de
    // verdad duele: el llamante SÍ tiene presupuesto, y tiene que llegar entero.
    // Un 96 colado aquí trunca la respuesta del cliente y el fallo se lee como
    // "el modelo se corta", no como "la capa le bajó el tope".
    expect(proveedor.llamadas[0]!.maxOutputTokens).toBe(SALIDA_DEL_SONDEO_TOKENS);
    expect(proveedor.llamadas[1]!.maxOutputTokens).toBe(200);
  });

  it("expandida por el codebook y todo, una respuesta de vista recortada SIGUE sin cachearse", async () => {
    // La verja de la vista recortada mira `descubrimiento.aplicado`, no el texto.
    // Importa después del rebase porque con codebook lo que se cachea ya NO es
    // `response.text` sino `textoServido`: si la verja se hubiera atado al texto
    // crudo, la etapa 10b la habría dejado atrás sin que cayera nada.
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("tool_3"),
      () => ({
        text: JSON.stringify({ d: "H", c: 87, e: ["E17:4"] }),
        usage: { inputTokens: 800, outputTokens: 30 },
        finishReason: "stop",
        structuredNatively: true,
      }),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });

    const conPalanca = await capa.generate(peticionConContrato(true));
    // Respuesta VÁLIDA y sin tool calls: las dos verjas anteriores la dejarían
    // pasar. La única que la para es la del recorte.
    expect(conPalanca.report.constraints.structurallyValid).toBe(true);
    expect(conPalanca.toolCalls).toBeUndefined();
    expect(
      conPalanca.report.traces.find((t) => t.stage === "cache-write")?.outcome,
    ).toContain("reduced tool view");

    const sinPalanca = await capa.generate(peticionConContrato(false));
    expect(sinPalanca.report.cache.result).toBe("miss");
    expect(sinPalanca.report.calls.avoidedLlm).toBe(0);
    // Y la petición sin palanca sale con el catálogo entero, que es lo que pidió.
    expect(proveedor.llamadas).toHaveLength(3);
    expect(proveedor.llamadas[2]!.tools).toHaveLength(8);
  });
});

describe("descubrimiento + libro 2 (#65): lo escondido por el sondeo NO se acredita", () => {
  // 7 lecturas que el selector SÍ quiere, 3 que no, y una escritura.
  const lecturaEnorme = (id: string, intent: string): ToolDescriptor => ({
    id,
    intents: [intent],
    risk: "read",
    description: `Consulta ${id}`,
    parameters: esquemaEnorme(id),
  });
  const RELEVANTES = Array.from({ length: 7 }, (_, i) =>
    lecturaEnorme(`factura_${i}`, "factura"),
  );
  const IRRELEVANTES = Array.from({ length: 3 }, (_, i) =>
    lecturaEnorme(`orbital_${i}`, "meteorologia orbital"),
  );
  const ESCRITURA_ACENTUADA: ToolDescriptor = {
    id: "reenviar_envio",
    // Con tilde A PROPÓSITO: es el intent que #68 desatascó. `normalizeText`
    // pliega los dos lados, así que «envía» del texto casa con «envío» del intent.
    intents: ["envío"],
    risk: "write",
    description: "Reenvía el envío de una factura al cliente",
    parameters: esquemaEnorme("envio"),
  };
  const CATALOGO = [...RELEVANTES, ...IRRELEVANTES, ESCRITURA_ACENTUADA];

  const peticionReal = (toolDiscovery: boolean) => ({
    model: "openai/gpt-4o-mini",
    // Imperativo + herramienta de escritura ⇒ TOOL_ACTION, con el router REAL.
    messages: [
      { role: "user" as const, content: "envía la factura F-118 al cliente y confírmame el envío" },
    ],
    tools: CATALOGO,
    savings: { toolDiscovery, exactCache: false },
  });

  it("el libro 2 sale IDÉNTICO con y sin la palanca: no hay doble conteo", async () => {
    const conSondeo = new ProveedorGuionizado([
      eligeHerramientas("factura_2"),
      respuestaFinal("hecho"),
    ]);
    const sinSondeo = new ProveedorGuionizado([respuestaFinal("hecho")]);

    // Con `maxTools`: el libro 2 del selector solo existe si se le pide podar (0.4.33).
    const a = await createSavingsLayer({ provider: conSondeo, costModels: PRECIOS, toolSelector: new ToolSelector({ maxTools: 8 }) })
      .generate(peticionReal(true));
    const b = await createSavingsLayer({ provider: sinSondeo, costModels: PRECIOS, toolSelector: new ToolSelector({ maxTools: 8 }) })
      .generate(peticionReal(false));

    // El patrón se aplicó de verdad: si no, este test no prueba nada.
    expect(conSondeo.llamadas).toHaveLength(2);
    expect(sinSondeo.llamadas).toHaveLength(1);
    expect(a.report.calls.actualTools).toBeLessThan(b.report.calls.actualTools);

    // EL PUNTO. El libro 2 es el de lo que no costó NADA: las 3 herramientas que
    // tiró el selector. Los esquemas que esconde el sondeo no son de ese libro
    // —los pagó una llamada extra—, así que la cifra no puede moverse ni un token
    // por encender la palanca. Si se moviera, el mismo ahorro estaría contado dos
    // veces: una en el libro 2 y otra en el total, vía `removedInputLocal`.
    expect(b.report.tokens.eliminatedInput).toBeGreaterThan(0);
    expect(a.report.tokens.eliminatedInput).toBe(b.report.tokens.eliminatedInput);
  });

  it("la escritura con intent ACENTUADO sobrevive al selector Y al sondeo", async () => {
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("factura_2"), // el sondeo NO nombra la escritura
      respuestaFinal("hecho"),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });
    await capa.generate(peticionReal(true));

    // Dos filtros seguidos, y cada uno se comió esta herramienta alguna vez en la
    // historia de este repo: el selector por no plegar la tilde (#68) y el sondeo
    // por no elegirla. El resultado tiene que ser el mismo por los dos lados: la
    // capacidad llega al proveedor CON su esquema completo, porque perder una
    // escritura no se nota nunca — el modelo contesta «claro, la reenvío».
    expect(proveedor.llamadas[0]!.tools!.map((t) => t.id)).toContain("reenviar_envio");
    const invocacion = proveedor.llamadas[1]!;
    expect(invocacion.tools!.map((t) => t.id)).toContain("reenviar_envio");
    expect(invocacion.tools!.find((t) => t.id === "reenviar_envio")!.parameters).toEqual(
      esquemaEnorme("envio"),
    );
  });
});

// ---------------------------------------------------------------------------
// #71 CACHÉ DE PREFIJO DEL PROVEEDOR: la palanca APAGA el marcado, y a propósito.
//
// LA DECISIÓN, escrita para que no dependa del orden accidental del código: con
// `toolDiscovery` puesto NO se marca prefijo en NINGUNA de las dos llamadas. Ni
// el sondeo ni la invocación llevan `stablePrefixMessages` ni `promptCacheKey`.
//
// La tentación de marcar el sondeo es real y es falsa. Las instrucciones de
// sistema del cliente son idénticas en las dos llamadas, así que parece que
// escribir la caché en el sondeo le regalaría a la invocación una lectura a
// 0,10x. No, y la razón es el ORDEN DE RENDERIZADO —tools -> system ->
// messages—: el emparejamiento es por bytes DESDE EL PRINCIPIO y lo primero que
// hay es `tools`, que en el sondeo son descriptores ligeros y en la invocación
// esquemas completos de un subconjunto. El `system` compartido va DETRÁS de un
// bloque que difiere, así que el prefijo común de las dos peticiones mide CERO.
// No es que el punto de ruptura caiga mal: `cache_control` marca el FINAL de un
// tramo, así que no existe punto que pueda ir por delante de `tools`.
//
// Y tampoco se marca la invocación, aunque el selector no haya podado nada: qué
// esquemas viajan lo decide una respuesta NO DETERMINISTA, así que dos
// peticiones que la huella agruparía como el mismo prefijo pueden mandar
// catálogos distintos. Meter las herramientas ENVIADAS en la huella no arregla
// nada: parte el tráfico en un prefijo por subconjunto y cada uno paga sus 8
// peticiones de exploración a 1,25x para medir h = 0.
//
// Lo que se pierde es ahorro NO capturado; lo que se evita es factura de más. No
// cuestan lo mismo, y por eso la renuncia va de este lado.
// ---------------------------------------------------------------------------

const PRECIO_SONNET = {
  "anthropic/claude-sonnet-4-5": {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cachedInputPer1k: 0.0003,
  },
};

/** Cabecera larga de verdad: por debajo del mínimo de tramo no habría prefijo. */
const POLITICA = "Eres el asistente de una tienda de electrónica. ".repeat(200);

/** 8 lecturas con esquema ENORME: la verja del descubrimiento aprueba con holgura. */
const CATALOGO_CARO: ToolDescriptor[] = Array.from({ length: 8 }, (_, i) => ({
  id: `tool_${i}`,
  intents: [`customer tool_${i} lookup`],
  risk: "read" as const,
  description: `Look up tool_${i} for a customer`,
  parameters: esquemaEnorme(`tool_${i}`),
}));

const peticionConCabecera = (toolDiscovery: boolean) => ({
  model: "anthropic/claude-sonnet-4-5",
  messages: [
    { role: "system" as const, content: POLITICA },
    { role: "user" as const, content: "look up the customer record for order 42" },
  ],
  tools: CATALOGO_CARO,
  savings: { router: false, toolDiscovery },
});

describe("descubrimiento + caché de prefijo (#71): con la palanca puesta no se marca NADA", () => {
  it("ni el sondeo ni la invocación llevan `stablePrefixMessages` ni `promptCacheKey`", async () => {
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("tool_3"),
      respuestaFinal("listo"),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIO_SONNET });
    const res = await capa.generate(peticionConCabecera(true));

    // El test no puede pasar por vacío: el patrón TIENE que haberse aplicado.
    expect(proveedor.llamadas).toHaveLength(2);
    expect(
      res.report.traces.find((t) => t.stage === "tool-discovery")?.outcome,
    ).toContain("applied");

    for (const llamada of proveedor.llamadas) {
      expect(llamada.stablePrefixMessages).toBeUndefined();
      expect(llamada.promptCacheKey).toBeUndefined();
    }
  });

  it("y la traza dice POR QUÉ: una palanca que se apaga en silencio se descubre probando", async () => {
    const proveedor = new ProveedorGuionizado([
      eligeHerramientas("tool_3"),
      respuestaFinal("listo"),
    ]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIO_SONNET });
    const res = await capa.generate(peticionConCabecera(true));

    const traza = res.report.traces.find((t) => t.stage === "prefix-cache");
    expect(traza?.outcome).toBe("skipped");
    expect(String(traza?.detail?.["reason"])).toContain("toolDiscovery");
  });

  /**
   * EL CONTROL, y sin él los dos de arriba pasarían por accidente: bastaría con
   * que el modelo no tuviera tramo, o con que la cabecera no llegara a prefijo,
   * para que nadie marcara nada y nadie se enterase.
   */
  it("CONTROL: la MISMA petición sin la palanca SÍ reclama prefijo", async () => {
    const proveedor = new ProveedorGuionizado([respuestaFinal("listo")]);
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIO_SONNET });
    await capa.generate(peticionConCabecera(false));

    expect(proveedor.llamadas).toHaveLength(1);
    // La cabecera es el mensaje 0; la pregunta, el 1 — y la pregunta nunca entra.
    expect(proveedor.llamadas[0]!.stablePrefixMessages).toBe(1);
    expect(proveedor.llamadas[0]!.promptCacheKey).toEqual(expect.any(String));
  });

  /**
   * LA RAZÓN FÍSICA, medida sobre el cuerpo que sale por el cable y no sobre
   * nuestra intención: aunque alguien marcara el sondeo, la invocación no podría
   * leer nada, porque las dos peticiones no comparten ni un byte de prefijo.
   */
  it("el `system` compartido no es prefijo común: `tools` va delante y difiere", async () => {
    const cuerpos: Record<string, unknown>[] = [];
    const guion = [
      {
        content: [{ type: "tool_use", id: "c0", name: "tool_3", input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 500, output_tokens: 10 },
      },
      {
        content: [{ type: "text", text: "listo" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 800, output_tokens: 100 },
      },
    ];
    const fetchImpl = (async (_url: unknown, init: { body: string }) => {
      cuerpos.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => guion[Math.min(cuerpos.length - 1, guion.length - 1)],
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const capa = createSavingsLayer({
      provider: new AnthropicProvider({ fetchImpl }),
      costModels: PRECIO_SONNET,
    });
    await capa.generate(peticionConCabecera(true));

    expect(cuerpos).toHaveLength(2);
    const [sondeo, invocacion] = cuerpos as [Record<string, unknown>, Record<string, unknown>];

    // 1. El texto compartido existe y es EL MISMO. Aquí es donde nace la idea de
    //    que marcar el sondeo aprovecharía a la invocación.
    expect(sondeo["system"]).toEqual(invocacion["system"]);
    expect(JSON.stringify(sondeo["system"])).toContain("tienda de electrónica");

    // 2. Pero `tools` se renderiza DELANTE, y no es el mismo bloque: el sondeo
    //    manda 8 descriptores sin esquema, la invocación uno con el esquema
    //    entero. El prefijo común de las dos peticiones mide cero.
    expect(JSON.stringify(sondeo["tools"])).not.toEqual(JSON.stringify(invocacion["tools"]));
    expect((sondeo["tools"] as unknown[]).length).toBe(8);
    expect((invocacion["tools"] as unknown[]).length).toBe(1);

    // 3. Y como no se marca, no se paga ninguna prima de escritura por ese
    //    prefijo inexistente: ni un `cache_control` en todo el cable.
    for (const cuerpo of cuerpos) {
      expect(JSON.stringify(cuerpo)).not.toContain("cache_control");
    }
  });
});

describe("descriptorLigero con un catálogo real", () => {
  it("una herramienta sin intents ni description no revienta: descriptor vacío, no TypeError", () => {
    // Un catálogo MCP de verdad declara id y parameters, y a veces ni description.
    const cruda = { id: "read_file", parameters: esquemaGordo("file") } as unknown as ToolDescriptor;
    const ligero = descriptorLigero(cruda);
    expect(ligero.id).toBe("read_file");
    expect(ligero.parameters).toBeUndefined();
  });
});
