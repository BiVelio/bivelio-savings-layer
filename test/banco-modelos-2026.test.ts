import { describe, it, expect } from "vitest";

import { PRESETS, configDesdeEntorno, modoDe, resolverModelos, veredictoDePrevuelo, type EntradaDelPrevuelo } from "../benchmarks/modelos.js";
import { endpointDeModelo, sinSecretos, type ConfigDeTransporte } from "../benchmarks/transporte.js";
import type { PrecioYPrima } from "../benchmarks/coste.js";

/**
 * LOS MODELOS DE 2026, SUS ENDPOINTS Y EL PREVUELO QUE DECIDE SI SE GASTA.
 *
 * Todo aquí es en seco: el entorno es un objeto, el catálogo se inyecta (así
 * estas verjas no dependen de que la unidad del catálogo de 2026 haya llegado)
 * y ningún test puede convertirse en una tirada de pago.
 */

const FILA = { inputPer1k: 0.001, outputPer1k: 0.004, cachedInputPer1k: 0.0001 };
/** Un catálogo de mentira: todo tiene fila y la prima que tocaría con la unidad de 2026. */
const catalogo2026 = (m: string): PrecioYPrima => ({
  precio: FILA,
  conocido: true,
  prima: /gpt-(5\.6|6)|claude/.test(m) ? 1.25 : 1,
});

const TODO: ConfigDeTransporte = {
  openaiBaseUrl: "https://api.openai.invalido/v1",
  anthropicBaseUrl: "https://api.anthropic.invalido/v1",
  googleBaseUrl: "https://gemini.invalido/v1beta/openai",
};

const entrada = (over: Partial<EntradaDelPrevuelo> = {}): EntradaDelPrevuelo => ({
  modelos: PRESETS["2026"].modelos.map((m) => ({ id: m.id, obligatorio: true, exigeNativo: "exigeNativo" in m && m.exigeNativo })),
  modo: "LIVE",
  cfg: TODO,
  presupuesto: 5,
  esfuerzo: "low",
  permitirIlustrativo: false,
  margen: 300,
  b2: true,
  precioYPrima: catalogo2026,
  ...over,
});

describe("resolverModelos", () => {
  it("el preset 2026: gpt-6-luna, claude-sonnet-5 (nativo obligatorio) y gemini-3.8-flash", () => {
    const r = resolverModelos({ BVSALA_AB_PRESET: "2026" });
    expect(r.error).toBeUndefined();
    expect(r.modelos).toEqual(["openai/gpt-6-luna", "anthropic/claude-sonnet-5", "google/gemini-3.8-flash"]);
    expect(r.exigenNativo).toEqual(["anthropic/claude-sonnet-5"]);
    expect(resolverModelos({ BVSALA_AB_PRESET: "2026+optional" }).modelos).toHaveLength(5);
  });

  it("preset y DEMO_MODEL(S) a la vez: no adivina, aborta", () => {
    expect(resolverModelos({ BVSALA_AB_PRESET: "2026", BVSALA_DEMO_MODEL: "openai/gpt-4o-mini" }).error).toMatch(/both set/);
    expect(resolverModelos({ BVSALA_AB_PRESET: "2026", BVSALA_DEMO_MODELS: "a,b" }).error).toMatch(/both set/);
    expect(resolverModelos({ BVSALA_AB_PRESET: "2025" }).error).toMatch(/unknown BVSALA_AB_PRESET/);
    expect(resolverModelos({ BVSALA_AB_PRESET: "2026+todo" }).error).toMatch(/unknown BVSALA_AB_PRESET/);
  });

  it("sin preset, lo de siempre: lista, uno, o el de cada escenario", () => {
    expect(resolverModelos({ BVSALA_DEMO_MODELS: " a , b ,," }).modelos).toEqual(["a", "b"]);
    expect(resolverModelos({ BVSALA_DEMO_MODEL: "x" }).modelos).toEqual(["x"]);
    expect(resolverModelos({}).modelos).toEqual([null]);
    expect(resolverModelos({ BVSALA_DEMO_MODELS: "a", BVSALA_DEMO_MODEL: "x" }).aviso).toMatch(/the list wins/);
  });
});

describe("endpointDeModelo: nativo de Anthropic → directo por familia → pasarela", () => {
  it("sin ningún endpoint es MOCK, y el modo lo dice", () => {
    expect(endpointDeModelo("openai/gpt-6-luna", {})).toEqual({ transporte: "mock", quitarPrefijo: false, host: null });
    expect(modoDe({})).toBe("MOCK");
  });

  it("un solo endpoint de familia ya hace LIVE la tirada", () => {
    expect(modoDe({ googleBaseUrl: "https://g.invalido" })).toBe("LIVE");
    expect(modoDe(configDesdeEntorno({ BVSALA_DEMO_OPENAI_BASE_URL: "https://o.invalido/v1" }))).toBe("LIVE");
  });

  it("precedencia, host publicado (solo el nombre) y prefijo quitado siempre en un directo", () => {
    const cfg: ConfigDeTransporte = { ...TODO, baseUrl: "https://usuario:secreto@pasarela.invalido/v1", keepPrefix: true };
    expect(endpointDeModelo("anthropic/claude-sonnet-5", cfg)).toMatchObject({
      transporte: "anthropic-nativo", host: "api.anthropic.invalido", quitarPrefijo: true,
    });
    expect(endpointDeModelo("openai/gpt-6-luna", cfg)).toMatchObject({ transporte: "openai-compatible", host: "api.openai.invalido", quitarPrefijo: true });
    expect(endpointDeModelo("google/gemini-3.8-flash", cfg)).toMatchObject({ host: "gemini.invalido", quitarPrefijo: true });
    // Sin directo, la pasarela — con su regla de prefijo y SIN credenciales en el host.
    const pasarela = endpointDeModelo("openai/gpt-6-luna", { baseUrl: cfg.baseUrl, keepPrefix: true });
    expect(pasarela).toMatchObject({ transporte: "openai-compatible", host: "pasarela.invalido", quitarPrefijo: false });
    // Con endpoints pero ninguno para esta familia: null (el prevuelo aborta).
    expect(endpointDeModelo("google/gemini-3.8-flash", { openaiBaseUrl: "https://o.invalido" })).toBeNull();
  });

  it("configDesdeEntorno lee los nombres de siempre y los nuevos, y trata vacío como ausente", () => {
    const c = configDesdeEntorno({
      BVSALA_DEMO_BASE_URL: "",
      BVSALA_DEMO_ANTHROPIC_BASE_URL: "https://a.invalido",
      BVSALA_DEMO_GOOGLE_BASE_URL: "https://g.invalido",
      BVSALA_DEMO_GOOGLE_API_KEY: "no-es-una-clave",
    });
    expect(c.baseUrl).toBeUndefined();
    expect(c.anthropicBaseUrl).toBe("https://a.invalido");
    expect(c.googleApiKey).toBe("no-es-una-clave");
  });
});

describe("veredictoDePrevuelo: lo que haría inservible una tirada de pago, antes de la primera llamada", () => {
  it("con todo en orden, empieza (y avisa de lo que avisa)", () => {
    const v = veredictoDePrevuelo(entrada({ escenariosSinTope: ["Local arithmetic"] }));
    expect(v.motivos).toEqual([]);
    expect(v.aborta).toBe(false);
    expect(v.avisos.join(" ")).toMatch(/without an output cap/);
  });

  it("sin presupuesto en LIVE, aborta", () => {
    expect(veredictoDePrevuelo(entrada({ presupuesto: NaN })).motivos.join(" ")).toMatch(/BVSALA_AB_BUDGET_USD is mandatory/);
    expect(veredictoDePrevuelo(entrada({ presupuesto: 0 })).aborta).toBe(true);
    // En MOCK no hace falta: no se gasta.
    expect(veredictoDePrevuelo(entrada({ modo: "MOCK", presupuesto: NaN, cfg: {} })).aborta).toBe(false);
  });

  it("un modelo sin endpoint para su familia, aborta (o se declara, si viene de un escenario)", () => {
    const cfg: ConfigDeTransporte = { anthropicBaseUrl: TODO.anthropicBaseUrl! };
    const v = veredictoDePrevuelo(entrada({ cfg }));
    expect(v.motivos.join(" ")).toMatch(/openai\/gpt-6-luna: no endpoint declared.*BVSALA_DEMO_OPENAI_BASE_URL/);
    expect(v.motivos.join(" ")).toMatch(/google\/gemini-3\.8-flash: no endpoint declared.*BVSALA_DEMO_GOOGLE_BASE_URL/);
    const porEscenario = veredictoDePrevuelo(entrada({ cfg, modelos: [{ id: "openai/gpt-4o-mini", obligatorio: false }] }));
    expect(porEscenario.aborta).toBe(false);
    expect(porEscenario.avisos.join(" ")).toMatch(/declared not measurable/);
  });

  it("un modelo sin fila de catálogo, aborta salvo el permiso ilustrativo (que corre y no publica)", () => {
    const sinFila = (m: string): PrecioYPrima => ({ ...catalogo2026(m), conocido: !m.includes("gemini") });
    expect(veredictoDePrevuelo(entrada({ precioYPrima: sinFila })).motivos.join(" ")).toMatch(/gemini-3\.8-flash: no row in the SDK price catalogue/);
    const permitido = veredictoDePrevuelo(entrada({ precioYPrima: sinFila, permitirIlustrativo: true }));
    expect(permitido.aborta).toBe(false);
    expect(permitido.avisos.join(" ")).toMatch(/cannot be published/);
  });

  it("un GPT-5.6+/GPT-6 sin la prima de escritura de 1,25 (falta la unidad del catálogo), aborta", () => {
    const sinPrima = (m: string): PrecioYPrima => ({ ...catalogo2026(m), prima: m.includes("gpt-6") ? 1 : catalogo2026(m).prima });
    expect(veredictoDePrevuelo(entrada({ precioYPrima: sinPrima })).motivos.join(" ")).toMatch(/cache write premium is 1.*rec\. 1/);
    // Con el catálogo de verdad de hoy (#333), gpt-6-luna tiene fila y prima de 1,25: el prevuelo deja gastar.
    const hoy = veredictoDePrevuelo(entrada({ precioYPrima: undefined }));
    expect(hoy.aborta).toBe(false);
    expect(hoy.motivos).toEqual([]);
  });

  it("un esfuerzo que el modelo no admite, aborta", () => {
    expect(veredictoDePrevuelo(entrada({ esfuerzo: "minimal" })).motivos.join(" ")).toMatch(/gpt-6-luna does not accept reasoning_effort "minimal"/);
    expect(veredictoDePrevuelo(entrada({ esfuerzo: "none" })).motivos.join(" ")).toMatch(/Anthropic effort levels|cannot be turned off/);
    expect(veredictoDePrevuelo(entrada({ esfuerzo: "altísimo" as never })).motivos.join(" ")).toMatch(/is not one of/);
    // Con B2 apagado, el esfuerzo no se valida: no se va a mandar.
    expect(veredictoDePrevuelo(entrada({ esfuerzo: "minimal", b2: false })).aborta).toBe(false);
  });

  it("un modelo que exige endpoint nativo y va por la pasarela, aborta", () => {
    const cfg: ConfigDeTransporte = { baseUrl: "https://pasarela.invalido/v1" };
    expect(veredictoDePrevuelo(entrada({ cfg })).motivos.join(" ")).toMatch(/claude-sonnet-5 needs the native Anthropic endpoint/);
  });

  it("avisa de los modelos que razonan sin margen, y de los escenarios con herramientas que gpt-6-luna no admite por Chat Completions", () => {
    const v = veredictoDePrevuelo(entrada({ margen: 0, escenariosConHerramientas: ["Tool-heavy request"] }));
    expect(v.aborta).toBe(false);
    expect(v.avisos.join(" ")).toMatch(/BVSALA_AB_MARGEN_RAZONAMIENTO is 0/);
    expect(v.avisos.join(" ")).toMatch(/gpt-6-luna: Chat Completions supports function calling only with reasoning_effort "none"/);
  });
});

describe("sinSecretos: un error del proveedor se guarda y se imprime sin nada con forma de clave", () => {
  it("quita claves enmascaradas o no, Bearer y credenciales en URLs, y deja el resto", () => {
    const t = sinSecretos(
      "provider 401: Incorrect API key provided: sk-proj-****abcd. Bearer abc.def-123 at https://usuario:secreto@x.invalido/v1 (AIzaSyA1234567890)",
    );
    expect(t).toBe(
      "provider 401: Incorrect API key provided: [redacted]. Bearer [redacted] at https://[redacted]@x.invalido/v1 ([redacted])",
    );
    expect(sinSecretos("provider 400: max_tokens is not supported with this model")).toBe(
      "provider 400: max_tokens is not supported with this model",
    );
  });
});
