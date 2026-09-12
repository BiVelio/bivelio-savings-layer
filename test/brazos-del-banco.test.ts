import { describe, it, expect } from "vitest";

import {
  construirBrazoNaive,
  construirBrazoRazonable,
  mensajesDePrefijoRazonable,
  DEFINICION_DE_BRAZOS,
} from "../benchmarks/brazos.js";
import { conSalDeFrio, scenarios } from "../benchmarks/scenarios.js";
import type { SavingsRequest, ToolDescriptor } from "../src/index.js";

/**
 * LOS DOS BRAZOS DE CONTROL, AFIRMADOS SIN GASTAR.
 *
 * B1 solo puede diferir de B0 en dos cosas —la caché nativa configurada donde
 * el prefijo se repite de verdad, y las herramientas elegidas a mano— y en nada
 * más: si un día B1 cambiara también el payload, el contrato o los parámetros,
 * la diferencia B0→B1 dejaría de ser atribuible y el «valor adicional de
 * Savings» que publica el banco mediría otra cosa. Estos tests fijan esa
 * frontera con la misma petición que corre el banco.
 */

const tools: ToolDescriptor[] = [
  { id: "get_weather", intents: ["weather"], risk: "read", description: "El tiempo", parameters: { type: "object", properties: { city: { type: "string" } } } },
  { id: "send_email", intents: ["email"], risk: "write", description: "Enviar correo", parameters: { type: "object", properties: { to: { type: "string" } } } },
];

const peticion: SavingsRequest = {
  model: "anthropic/claude-sonnet-4-5",
  messages: [
    { role: "system", content: "Política de soporte, larga y estable." },
    { role: "user", content: "¿Qué tiempo hará mañana?" },
  ],
  tools,
  structuredData: { pedido: 40218 },
  response: { contractId: "answer:v1", schema: { type: "object" }, maxOutputTokens: 200 },
};

describe("brazo A (B0, naive)", () => {
  it("manda todo: JSON compacto, todas las herramientas, contrato y tope, y ninguna marca de caché", () => {
    const a = construirBrazoNaive(peticion, "claude-sonnet-4-5");
    expect(a.model).toBe("claude-sonnet-4-5");
    expect(a.messages.at(-1)).toEqual({ role: "user", content: '{"pedido":40218}' });
    expect(a.tools?.map((t) => t.id)).toEqual(["get_weather", "send_email"]);
    expect(a.schema).toEqual({ type: "object" });
    expect(a.maxOutputTokens).toBe(200);
    expect(a.temperature).toBe(0);
    expect(a.seed).toBe(7);
    expect(a.stablePrefixMessages).toBeUndefined();
    expect(a.promptCacheKey).toBeUndefined();
  });
});

describe("brazo A1 (B1, integración razonablemente optimizada)", () => {
  it("es B0 más la caché nativa configurada sobre el prefijo estable", () => {
    const a = construirBrazoNaive(peticion, "claude-sonnet-4-5");
    const a1 = construirBrazoRazonable(peticion, "claude-sonnet-4-5");
    // Lo mismo que B0 en todo lo que no es caché ni herramientas.
    expect(a1.messages).toEqual(a.messages);
    expect(a1.schema).toEqual(a.schema);
    expect(a1.maxOutputTokens).toBe(a.maxOutputTokens);
    expect(a1.temperature).toBe(a.temperature);
    expect(a1.seed).toBe(a.seed);
    expect(a1.tools).toEqual(a.tools);
    // Y la caché: el system inicial es el prefijo que un cliente razonable marca.
    expect(a1.stablePrefixMessages).toBe(1);
    expect(a1.promptCacheKey).toMatch(/^bvsala-ab-b1-/);
  });

  it("solo manda las herramientas declaradas a mano cuando el escenario las declara", () => {
    const a1 = construirBrazoRazonable(peticion, "claude-sonnet-4-5", { toolsB1: ["get_weather"] });
    expect(a1.tools?.map((t) => t.id)).toEqual(["get_weather"]);
  });

  it("revienta si el escenario declara una herramienta que la petición no tiene", () => {
    expect(() => construirBrazoRazonable(peticion, "claude-sonnet-4-5", { toolsB1: ["no_existe"] })).toThrow(/no_existe/);
  });

  it("no marca caché en una petición con sal de frío: ese prefijo no se repite nunca", () => {
    const salada = conSalDeFrio(peticion, "nonce-3");
    const a1 = construirBrazoRazonable(salada, "claude-sonnet-4-5");
    expect(a1.stablePrefixMessages).toBeUndefined();
    expect(a1.promptCacheKey).toBeUndefined();
    // Y sigue mandando exactamente los mensajes de B0, sal incluida.
    expect(a1.messages).toEqual(construirBrazoNaive(salada, "claude-sonnet-4-5").messages);
  });

  it("no marca caché cuando la petición no empieza por un system", () => {
    const sinSystem: SavingsRequest = { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hola" }] };
    expect(mensajesDePrefijoRazonable(sinSystem.messages)).toBe(0);
    expect(construirBrazoRazonable(sinSystem, "gpt-4o-mini").stablePrefixMessages).toBeUndefined();
  });

  it("cuenta como prefijo TODOS los system iniciales, y para en el primer turno de usuario", () => {
    const dos: SavingsRequest["messages"] = [
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "user", content: "c" },
      { role: "system", content: "d" },
    ];
    expect(mensajesDePrefijoRazonable(dos)).toBe(2);
  });
});

describe("los escenarios del banco y sus declaraciones B1", () => {
  it("toda herramienta declarada en toolsB1 existe en la petición del escenario", () => {
    for (const s of scenarios) {
      if (!s.toolsB1) continue;
      const ids = new Set((s.request.tools ?? []).map((t) => t.id));
      for (const id of s.toolsB1) expect(ids.has(id), `${s.name}: toolsB1 declara ${id}`).toBe(true);
      // Y construir el brazo no revienta con la petición real.
      expect(() => construirBrazoRazonable(s.request, s.request.model, { toolsB1: s.toolsB1 })).not.toThrow();
    }
  });

  it("los escenarios de prefijo estable marcan caché en B1, y los salados no", () => {
    const estable = scenarios.find((s) => s.name === "Anthropic stable-prefix agent turn")!;
    expect(construirBrazoRazonable(estable.request, estable.request.model).stablePrefixMessages).toBe(1);
    const salado = conSalDeFrio(estable.request, "x");
    expect(construirBrazoRazonable(salado, estable.request.model).stablePrefixMessages).toBeUndefined();
  });

  it("la definición de los brazos nombra a los tres y dice qué distingue a B1", () => {
    expect(Object.keys(DEFINICION_DE_BRAZOS)).toEqual(["A", "A1", "B"]);
    expect(DEFINICION_DE_BRAZOS.A1).toMatch(/cache_control/);
    expect(DEFINICION_DE_BRAZOS.A1).toMatch(/toolsB1/);
  });
});
