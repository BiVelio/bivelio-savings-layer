/**
 * BFCL con Gemini por su API NATIVA y gpt-5.6-sol con herramientas. Sin red:
 * las respuestas tienen la forma EXACTA que devolvió `generateContent` en la
 * sonda del 2026-09-29 contra gemini-3.8-flash (test/proveedor-google.test.ts),
 * y el 400 de gpt-5.6-sol es el del banco semanal del mismo día (run
 * 36611942632), reproducido en vivo con una sola herramienta.
 */
import { describe, expect, it } from "vitest";

import { baseDeGoogle, dialectoDelModelo, TOPE_MAXIMO } from "../benchmarks/publicados/bfcl/arnes.js";
import {
  cuerpoBrazoA,
  diferenciasDelCable,
  esfuerzoConHerramientas,
  herramientasDelCuerpo,
  leerRespuesta,
  llamarBrazoB,
  peticionSinCapa,
  type Turno,
} from "../benchmarks/publicados/bfcl/brazos.js";
import { costeDeUso, crearCable, Presupuesto, Semaforo, unidadEnCurso, usoDeRespuesta, type LlamadaDelCable } from "../benchmarks/publicados/bfcl/cable.js";
import { herramientaDe } from "../benchmarks/publicados/bfcl/esquema.js";
import type { FuncionBfcl } from "../benchmarks/publicados/bfcl/datos.js";
import { claveSimulada, fetchSimulado } from "../benchmarks/publicados/bfcl/simulador.js";
import { createSavingsLayer, GoogleProvider } from "../src/index.js";

const tiempo: FuncionBfcl = {
  name: "get_weather",
  description: "Get the weather for a city.",
  parameters: { type: "dict", properties: { city: { type: "string", description: "city" } }, required: ["city"] },
};

/** Grabada (sonda en vivo, 2026-09-29): dos llamadas en paralelo, la primera con su firma. */
const LLAMADAS_PARALELAS = {
  candidates: [
    {
      content: {
        parts: [
          { functionCall: { name: "get_weather", args: { city: "Madrid" }, id: "call_50130" }, thoughtSignature: "EqECCp4CAWkUfRNe" },
          { functionCall: { name: "get_weather", args: { city: "Paris" }, id: "call_50131" } },
        ],
        role: "model",
      },
      finishReason: "STOP",
      index: 0,
      finishMessage: "Model generated function call(s).",
    },
  ],
  usageMetadata: { promptTokenCount: 58, candidatesTokenCount: 32, totalTokenCount: 133, thoughtsTokenCount: 43, serviceTier: "standard" },
  modelVersion: "gemini-3.8-flash",
  responseId: "K3i7aqjiG_KPxN8Pkce2kQY",
};

const RESPUESTA_TRAS_HERRAMIENTAS = {
  candidates: [{ content: { parts: [{ text: "Madrid: 21°C, clear. Paris: 21°C, clear.", thoughtSignature: "EvMBCvABAWkU" }], role: "model" }, finishReason: "STOP", index: 0 }],
  usageMetadata: { promptTokenCount: 173, candidatesTokenCount: 34, totalTokenCount: 248, thoughtsTokenCount: 41, serviceTier: "standard" },
  responseId: "LXi7ao24J87VxN8Pxuvr4QE",
};

const PRECIO = { inputPer1k: 0.0005, outputPer1k: 0.003 };

function servidorGrabado(responder: (cuerpo: Record<string, unknown>) => unknown) {
  const urls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    const cuerpo = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify(responder(cuerpo)), { status: 200, headers: { "content-type": "application/json; charset=UTF-8" } });
  }) as unknown as typeof fetch;
  return { urls, f };
}

describe("BFCL · Gemini por su API nativa", () => {
  it("el dialecto lo decide la URL: nativa por defecto y en --mock, el compatible solo con …/openai", () => {
    expect(dialectoDelModelo("google/gemini-3.8-flash", {}, false)).toBe("google");
    expect(dialectoDelModelo("google/gemini-3.8-flash", { BVSALA_DEMO_GOOGLE_BASE_URL: "https://generativelanguage.googleapis.com/v1beta" }, false)).toBe("google");
    expect(dialectoDelModelo("google/gemini-3.8-flash", { BVSALA_DEMO_GOOGLE_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai" }, false)).toBe("openai");
    expect(dialectoDelModelo("google/gemini-3.8-flash", { BVSALA_SONDA_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai" }, true)).toBe("google");
    expect(dialectoDelModelo("openai/gpt-5.6-sol", {}, false)).toBe("openai");
    expect(dialectoDelModelo("anthropic/claude-opus-5-5", {}, false)).toBe("anthropic");
    expect(baseDeGoogle({})).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(baseDeGoogle({ BVSALA_DEMO_GOOGLE_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/" })).toBe("https://generativelanguage.googleapis.com/v1beta");
    // La sonda de antes, solo si es el host oficial.
    expect(baseDeGoogle({ BVSALA_SONDA_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai" })).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(baseDeGoogle({ BVSALA_SONDA_BASE_URL: "https://otro.example/v1beta" })).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(TOPE_MAXIMO.google).toBe(0.8);
  });

  it("uso y llamadas de la respuesta cruda: el pensamiento se cobra como salida y la firma se conserva", () => {
    const u = usoDeRespuesta("google", LLAMADAS_PARALELAS)!;
    expect(u).toEqual({ entrada: 58, lecturaCache: 0, escrituraCache: 0, escritura1h: 0, salida: 75, razonamiento: 43 });
    expect(costeDeUso(u, PRECIO, 1)).toBeCloseTo((58 / 1000) * 0.0005 + (75 / 1000) * 0.003, 12);
    expect(usoDeRespuesta("google", { candidates: [] })).toBeNull();
    const l = leerRespuesta("google", LLAMADAS_PARALELAS);
    expect(l.parada).toBe("STOP");
    expect(l.llamadas).toEqual([
      { id: "call_50130", name: "get_weather", arguments: '{"city":"Madrid"}', extra: { google: { thought_signature: "EqECCp4CAWkUfRNe" } } },
      { id: "call_50131", name: "get_weather", arguments: '{"city":"Paris"}' },
    ]);
  });

  it("el brazo A (GoogleProvider directo, sin capa) y el B (la capa) mandan el mismo cuerpo, y la capa devuelve las llamadas crudas", async () => {
    const hs = [herramientaDe(tiempo)];
    const turnos: Turno[] = [{ role: "user", content: "Weather in Madrid and Paris?" }];
    const srv = servidorGrabado(() => LLAMADAS_PARALELAS);
    const reg: LlamadaDelCable[] = [];
    const cable = crearCable({ familia: "google", presupuesto: new Presupuesto("google/gemini-3.8-flash", 1), precio: PRECIO, prima: 1, semaforo: new Semaforo(2), base: srv.f });
    const base = "https://generativelanguage.googleapis.com/v1beta";
    const directo = new GoogleProvider({ apiKey: "k", baseUrl: base, fetchImpl: cable, requireUsage: true });
    const capa = createSavingsLayer({ provider: new GoogleProvider({ apiKey: "k", baseUrl: base, fetchImpl: cable, requireUsage: true }), devUnlicensed: true, silenceWarnings: true });
    const muestreo = { temperature: 0, seed: 7 };
    await unidadEnCurso.run({ unidad: "u", brazo: "A", registro: reg }, () => directo.generate(peticionSinCapa("google/gemini-3.8-flash", turnos, hs, muestreo)));
    const rb = await unidadEnCurso.run({ unidad: "u", brazo: "B", registro: reg }, () => llamarBrazoB(capa, "google/gemini-3.8-flash", turnos, hs, muestreo));

    expect(srv.urls).toEqual([`${base}/models/gemini-3.8-flash:generateContent`, `${base}/models/gemini-3.8-flash:generateContent`]);
    const [a, b] = reg;
    expect(a!.brazo).toBe("A");
    expect(b!.brazo).toBe("B");
    expect(diferenciasDelCable(a!.peticion!, b!.peticion!).diferencias).toEqual([]);
    expect(herramientasDelCuerpo(a!.peticion).map((t) => t["name"])).toEqual(["get_weather"]);
    expect((a!.peticion!["generationConfig"] as Record<string, unknown>)["temperature"]).toBe(0);
    // Los dos brazos se cobran con la misma aritmética, del `usageMetadata` crudo.
    expect(a!.coste).toBeCloseTo(b!.coste, 12);
    expect(a!.uso?.salida).toBe(75);
    // La capa devuelve EXACTAMENTE las llamadas que trajo el proveedor.
    const crudas = leerRespuesta("google", b!.respuesta);
    expect(rb.toolCalls?.map((t) => [t.id, t.name, t.arguments])).toEqual(crudas.llamadas.map((t) => [t.id, t.name, t.arguments]));
  });

  it("en el turno siguiente los dos brazos devuelven la thoughtSignature de la llamada (sin ella Gemini 3 da 400)", async () => {
    const hs = [herramientaDe(tiempo)];
    const firma = { google: { thought_signature: "EqECCp4CAWkUfRNe" } };
    const turnos: Turno[] = [
      { role: "user", content: "Weather in Madrid?" },
      { role: "assistant", content: "", llamadas: [{ id: "call_50130", name: "get_weather", arguments: '{"city":"Madrid"}', extra: firma }] },
      { role: "tool", id: "call_50130", name: "get_weather", content: '{"status":"ok"}' },
    ];
    const srv = servidorGrabado(() => RESPUESTA_TRAS_HERRAMIENTAS);
    const reg: LlamadaDelCable[] = [];
    const cable = crearCable({ familia: "google", presupuesto: new Presupuesto("g", 1), precio: PRECIO, prima: 1, semaforo: new Semaforo(2), base: srv.f });
    const directo = new GoogleProvider({ apiKey: "k", fetchImpl: cable, requireUsage: true });
    const capa = createSavingsLayer({ provider: new GoogleProvider({ apiKey: "k", fetchImpl: cable, requireUsage: true }), devUnlicensed: true, silenceWarnings: true });
    await unidadEnCurso.run({ unidad: "u", brazo: "A", registro: reg }, () => directo.generate(peticionSinCapa("google/gemini-3.8-flash", turnos, hs, {})));
    await unidadEnCurso.run({ unidad: "u", brazo: "B", registro: reg }, () => llamarBrazoB(capa, "google/gemini-3.8-flash", turnos, hs, {}));
    for (const c of reg) {
      const contents = c.peticion!["contents"] as { role: string; parts: Record<string, unknown>[] }[];
      const modelo = contents.find((x) => x.role === "model")!;
      expect(modelo.parts[0]).toMatchObject({ functionCall: { name: "get_weather", args: { city: "Madrid" } }, thoughtSignature: "EqECCp4CAWkUfRNe" });
      expect(contents.at(-1)!.parts[0]).toMatchObject({ functionResponse: { name: "get_weather", response: { status: "ok" } } });
    }
    expect(diferenciasDelCable(reg[0]!.peticion!, reg[1]!.peticion!).diferencias).toEqual([]);
  });

  it("el simulador del --mock contesta con la forma nativa y el arnés la lee", async () => {
    const hs = [herramientaDe(tiempo)];
    const respuestas = new Map([[claveSimulada("Weather?", ["get_weather"]), [{ nombre: "get_weather", args: { city: "Madrid" } }]]]);
    const reg: LlamadaDelCable[] = [];
    const cable = crearCable({ familia: "google", presupuesto: new Presupuesto("g", 1), precio: PRECIO, prima: 1, semaforo: new Semaforo(2), base: fetchSimulado(respuestas) });
    const directo = new GoogleProvider({ apiKey: "mock", baseUrl: "https://mock-google.invalid/v1beta", fetchImpl: cable, requireUsage: true });
    const r = await unidadEnCurso.run({ unidad: "u", brazo: "A", registro: reg }, () =>
      directo.generate(peticionSinCapa("google/gemini-3.8-flash", [{ role: "user", content: "Weather?" }], hs, {})),
    );
    expect(r.toolCalls?.[0]?.name).toBe("get_weather");
    expect(leerRespuesta("google", reg[0]!.respuesta).llamadas[0]).toMatchObject({ name: "get_weather", arguments: '{"city":"Madrid"}' });
    expect(reg[0]!.uso?.razonamiento).toBe(7);
  });
});

describe("BFCL · gpt-5.6-sol con herramientas", () => {
  it("gpt-5.6-* (y gpt-6-luna) llevan reasoning_effort \"none\"; el resto, nada", () => {
    expect(esfuerzoConHerramientas("openai/gpt-5.6-sol")).toBe("none");
    expect(esfuerzoConHerramientas("openai/gpt-5.6-terra")).toBe("none");
    expect(esfuerzoConHerramientas("gpt-5.6")).toBe("none");
    expect(esfuerzoConHerramientas("openai/gpt-6-luna")).toBe("none");
    expect(esfuerzoConHerramientas("openai/gpt-5.5")).toBeUndefined();
    expect(esfuerzoConHerramientas("openai/gpt-5.60")).toBeUndefined();
    expect(esfuerzoConHerramientas("openai/gpt-4o-mini")).toBeUndefined();
  });

  it("el esfuerzo viaja IGUAL en los dos brazos: A en el cuerpo, B por la capa, y el cable sale idéntico", async () => {
    const hs = [herramientaDe(tiempo)];
    const turnos: Turno[] = [{ role: "user", content: "Weather?" }];
    const muestreo = { reasoningEffort: "none" };
    const cuerpoA = cuerpoBrazoA("openai", "openai/gpt-5.6-sol", turnos, hs, muestreo);
    expect(cuerpoA["reasoning_effort"]).toBe("none");
    // Sin el esfuerzo, el cuerpo del brazo A no lo lleva (es lo que dio 400 en el banco).
    expect(cuerpoBrazoA("openai", "openai/gpt-5.6-sol", turnos, hs, {})["reasoning_effort"]).toBeUndefined();

    // El B por la capa contra un OpenAI que, como el de verdad, rechaza herramientas sin "none".
    const cuerpos: Record<string, unknown>[] = [];
    const openai = (async (_url: string, init?: RequestInit) => {
      const c = JSON.parse(String(init?.body)) as Record<string, unknown>;
      cuerpos.push(c);
      if (c["tools"] && c["reasoning_effort"] !== "none") {
        return new Response(
          JSON.stringify({ error: { message: "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.", type: "invalid_request_error" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          model: "gpt-5.6-sol",
          choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 135, completion_tokens: 17, total_tokens: 152, completion_tokens_details: { reasoning_tokens: 0 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { OpenAICompatibleProvider } = await import("../src/index.js");
    const capa = createSavingsLayer({ provider: new OpenAICompatibleProvider({ apiKey: "k", baseUrl: "https://api.openai.com/v1", fetchImpl: openai }), devUnlicensed: true, silenceWarnings: true });
    const r = await llamarBrazoB(capa, "openai/gpt-5.6-sol", turnos, hs, muestreo);
    expect(r.toolCalls?.[0]?.name).toBe("get_weather");
    expect(cuerpos[0]!["reasoning_effort"]).toBe("none");
    expect(diferenciasDelCable(cuerpoA, cuerpos[0]!).diferencias.filter((d) => !/^max_completion_tokens|^prompt_cache_key/.test(d))).toEqual([]);
  });
});
