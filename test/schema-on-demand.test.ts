import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import {
  decidirDescubrimiento,
  descriptorLigero,
  herramientasDeLaSegunda,
  peorCasoDeEsquemas,
  MAX_LECTURAS_DE_LA_SEGUNDA,
} from "../src/router/schema-on-demand.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { JsonSchema, ToolDescriptor } from "../src/contracts/types.js";

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
    expect(d.razon).toContain("dos veces");
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
    expect(d.razon).toContain("degradar");
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
    expect(res.report.cost.netSavings).toBeLessThan(0);
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
    expect(res.report.cost.netSavings).toBeGreaterThan(0);
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
