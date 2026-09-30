import { describe, expect, it } from "vitest";

import {
  MODELOS_MEDIBLES,
  MODELOS_POR_DEFECTO,
  Tope,
  TOPE_GAMA_ALTA_POR_MODELO_USD,
  conRespuestasDe,
  diferenciasDeCuerpo,
  esDeGamaAlta,
  modeloDeMtBench,
  topeDelCuerpo,
  turnosValidos,
  usoDeFamilia,
  usoDeGoogle,
  type JuicioDeTurno,
  type PromptDelJuez,
} from "../benchmarks/publicados/mt-bench/nucleo.js";
import {
  juzgarHastaElTope,
  leerOpciones,
  type Credenciales,
  type Dataset,
  type ResultadoDePregunta,
} from "../benchmarks/publicados/mt-bench/mt-bench.js";
import { MODELOS_DEL_BANCO } from "../benchmarks/banco-semanal/plan.js";
import { GoogleProvider } from "../src/providers/google.js";
import { createSavingsLayer } from "../src/pipeline/create.js";

/**
 * MT-BENCH · GEMINI POR SU API NATIVA, LA GAMA ALTA EN EL BANCO SEMANAL Y EL
 * JUEZ EN SERIE. Todo sin red: las respuestas tienen la forma EXACTA que
 * devolvió `generateContent` en la sonda del 2026-09-29 contra
 * gemini-3.8-flash (la misma que test/proveedor-google.test.ts).
 */

const TEXTO_CON_PENSAMIENTO = {
  candidates: [
    {
      content: { parts: [{ text: "391", thoughtSignature: "Ev8BCvwBAWkUfROE" }], role: "model" },
      finishReason: "STOP",
      index: 0,
    },
  ],
  usageMetadata: {
    promptTokenCount: 16,
    candidatesTokenCount: 3,
    totalTokenCount: 92,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 16 }],
    thoughtsTokenCount: 73,
    serviceTier: "standard",
  },
  modelVersion: "gemini-3.8-flash",
  responseId: "I3i7ap6JG8zkxN8Pi8OhoAI",
};

describe("MT-Bench · el uso de la API nativa de Gemini", () => {
  it("lee usageMetadata con el pensamiento como SALIDA facturada", () => {
    const u = usoDeFamilia("google", TEXTO_CON_PENSAMIENTO);
    expect(u).toEqual({ entrada: 16, cacheLeida: 0, cacheEscrita: 0, salida: 76, razonamiento: 73 });
  });

  it("separa lo leído de la caché implícita de la entrada", () => {
    const u = usoDeGoogle({ usageMetadata: { promptTokenCount: 5000, cachedContentTokenCount: 4096, candidatesTokenCount: 10, totalTokenCount: 5010 } });
    expect(u).toMatchObject({ entrada: 904, cacheLeida: 4096, salida: 10, razonamiento: 0 });
  });

  it("sin contadores no inventa un 0", () => {
    expect(() => usoDeGoogle({ usageMetadata: {} })).toThrow(/sin usageMetadata/);
  });

  it("el endpoint compatible se sigue leyendo como antes", () => {
    expect(usoDeGoogle({ usage: { prompt_tokens: 13, completion_tokens: 3, total_tokens: 193 } })).toMatchObject({ salida: 180, razonamiento: 177 });
  });

  it("el tope de salida nativo (generationConfig.maxOutputTokens) cuenta como tope", () => {
    expect(topeDelCuerpo({ contents: [], generationConfig: { maxOutputTokens: 4096 } })).toBe(4096);
    expect(topeDelCuerpo({ contents: [], generationConfig: { temperature: 0.7 } })).toBeNull();
  });

  it("el diff del turno 2 pone las respuestas de B en los turnos `model` del cuerpo nativo", () => {
    const a = { contents: [{ role: "user", parts: [{ text: "q1" }] }, { role: "model", parts: [{ text: "respuesta de A" }] }, { role: "user", parts: [{ text: "q2" }] }] };
    const b = { contents: [{ role: "user", parts: [{ text: "q1" }] }, { role: "model", parts: [{ text: "respuesta de B" }] }, { role: "user", parts: [{ text: "q2" }] }] };
    expect(diferenciasDeCuerpo(a, b)).toEqual(["contents"]);
    expect(diferenciasDeCuerpo(conRespuestasDe(a, ["respuesta de B"]), b)).toEqual([]);
  });
});

describe("MT-Bench · el brazo A (GoogleProvider directo) y el B (dentro de la capa) mandan el mismo cuerpo", () => {
  it("mismo `generateContent` en los dos brazos, turno 1 y turno 2", async () => {
    const cuerpos: { url: string; cuerpo: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      cuerpos.push({ url, cuerpo: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(TEXTO_CON_PENSAMIENTO), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const base = "https://generativelanguage.googleapis.com/v1beta";
    const directo = new GoogleProvider({ baseUrl: base, fetchImpl });
    const capa = createSavingsLayer({ provider: new GoogleProvider({ baseUrl: base, fetchImpl }), devUnlicensed: true });
    try {
      const t1 = [{ role: "user" as const, content: "Compose an engaging travel blog post about Hawaii." }];
      await directo.generate({ model: "gemini-3.8-flash", messages: t1, maxOutputTokens: 4096, temperature: 0.7 });
      await capa.generate({ model: "google/gemini-3.8-flash", messages: t1, maxOutputTokens: 4096, temperature: 0.7 });
      const t2 = [...t1, { role: "assistant" as const, content: "391" }, { role: "user" as const, content: "Rewrite it starting every sentence with A." }];
      await directo.generate({ model: "gemini-3.8-flash", messages: t2, maxOutputTokens: 4096, temperature: 0.7 });
      await capa.generate({ model: "google/gemini-3.8-flash", messages: t2, maxOutputTokens: 4096, temperature: 0.7 });
    } finally {
      capa.close();
    }
    expect(cuerpos).toHaveLength(4);
    for (const c of cuerpos) expect(c.url).toBe(`${base}/models/gemini-3.8-flash:generateContent`);
    expect(diferenciasDeCuerpo(cuerpos[0]!.cuerpo, cuerpos[1]!.cuerpo)).toEqual([]);
    expect(diferenciasDeCuerpo(cuerpos[2]!.cuerpo, cuerpos[3]!.cuerpo)).toEqual([]);
    expect(topeDelCuerpo(cuerpos[0]!.cuerpo as Record<string, unknown>)).toBe(4096);
  });
});

describe("MT-Bench · la gama alta en el banco semanal (sin --gama-alta)", () => {
  it("cada modelo del banco semanal se resuelve en la batería", () => {
    for (const m of MODELOS_DEL_BANCO) expect(modeloDeMtBench(m.corto), m.corto).toBeDefined();
    expect(MODELOS_MEDIBLES.map((m) => m.id)).toEqual(expect.arrayContaining(MODELOS_DEL_BANCO.map((m) => m.corto)));
  });

  it("--modelos=gpt-5.6-sol sin --gama-alta: su tope (1,25 $), sin temperatura, 4096 de salida", () => {
    const op = leerOpciones(["--fuente-de-main", "--modelos=gpt-5.6-sol"]);
    expect(op.tirada.gamaAlta).toBe(false);
    const m = op.modelos[0]!;
    expect(m).toMatchObject({ id: "gpt-5.6-sol", familia: "openai", temperatura: false, maxSalida: 4096 });
    expect(esDeGamaAlta(m)).toBe(true);
    expect(op.tirada.topeDe(m)).toBe(TOPE_GAMA_ALTA_POR_MODELO_USD);
    // Los de siempre conservan el tope de su familia.
    expect(op.tirada.topeDe(MODELOS_POR_DEFECTO.find((x) => x.id === "gpt-4o-mini")!)).toBe(0.8);
  });

  it("Opus 5.5 y Sonnet 5.5 no mandan temperatura (la rechazan con 400)", () => {
    const op = leerOpciones(["--modelos=claude-opus-5-5,claude-sonnet-5-5"]);
    expect(op.modelos.map((m) => m.temperatura)).toEqual([false, false]);
  });

  it("con --gama-alta solo vale su lista, como siempre", () => {
    expect(() => leerOpciones(["--gama-alta", "--modelos=gpt-4o-mini"])).toThrow(/no previsto/);
    expect(() => leerOpciones(["--modelos=gpt-9"])).toThrow(/no previsto/);
  });
});

// ── El juez ─────────────────────────────────────────────────────────────────

function datasetDePrueba(n: number): Dataset {
  const preguntas = Array.from({ length: n }, (_, i) => ({ id: i + 1, categoria: "writing" as const, turnos: [`pregunta ${i + 1}`, `seguimiento ${i + 1}`] as [string, string] }));
  const sys = 'Juzga. Veredicto: "[[A]]", "[[B]]" o "[[C]]".';
  const prompts = new Map<string, PromptDelJuez>();
  prompts.set("pair-v2", { name: "pair-v2", type: "pairwise", system_prompt: sys, prompt_template: "{question}\n{answer_a}\n{answer_b}", output_format: "[[A]]" });
  prompts.set("pair-v2-multi-turn", {
    name: "pair-v2-multi-turn",
    type: "pairwise",
    system_prompt: sys,
    prompt_template: "{question_1}\n{answer_a_1}\n{question_2}\n{answer_a_2}\n{answer_b_1}\n{answer_b_2}",
    output_format: "[[A]]",
  });
  return { origen: "sintetico-mock", preguntas, referencias: new Map(), prompts };
}

const resultado = (id: number): ResultadoDePregunta => ({
  id,
  categoria: "writing",
  temperatura: 0.7,
  A: [{ texto: `A1-${id}`, fin: "stop", latenciaMs: 1 }, { texto: `A2-${id}`, fin: "stop", latenciaMs: 1 }],
  B: [{ texto: `B1-${id}`, fin: "stop", latenciaMs: 1 }, { texto: `B2-${id}`, fin: "stop", latenciaMs: 1 }],
  llamadas: [],
});

const cred = {
  juez: { base: "https://ai-gateway.invalid/v1", clave: "k", modelo: "openai/gpt-4o" },
} as unknown as Credenciales;
const precioJuez = { inputPer1k: 0.0025, outputPer1k: 0.01, cachedInputPer1k: 0.00125 };

/** El juez falso: siempre «[[A]]», 500 de entrada y 100 de salida (≈ 0,00225 $ por partida). */
function juezFalso(): { fetch: typeof fetch; enVuelo: () => number; maxEnVuelo: () => number } {
  let vuelo = 0;
  let max = 0;
  const f = (async () => {
    vuelo++;
    max = Math.max(max, vuelo);
    await new Promise((r) => setTimeout(r, 1));
    vuelo--;
    return new Response(JSON.stringify({ model: "gpt-4o", choices: [{ message: { content: "Razonado. [[A]]" }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 100 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: f, enVuelo: () => vuelo, maxEnVuelo: () => max };
}

describe("MT-Bench · el juez del banco semanal, en serie (run 36611942632)", () => {
  // Cada partida reserva ≈ 0,0215 $ (2048 de salida a 10 $/M); cuesta ≈ 0,00225 $.
  const TOPE = 0.05;

  it("a la vez, las cuatro reservas no caben y el juez se corta en la PRIMERA pregunta (el fallo)", async () => {
    const ds = datasetDePrueba(5);
    const juicios = new Map<number, JuicioDeTurno[]>();
    const j = juezFalso();
    const r = await juzgarHastaElTope(ds.preguntas.map((p) => resultado(p.id)), juicios, ds, cred, new Tope("juez", TOPE), precioJuez, j.fetch, false);
    expect(r.corte).toBe(true);
    expect(juicios.size).toBeLessThanOrEqual(1);
  });

  it("en serie, con sitio para UNA reserva viva, se juzgan varias preguntas", async () => {
    const ds = datasetDePrueba(5);
    const juicios = new Map<number, JuicioDeTurno[]>();
    const j = juezFalso();
    const tope = new Tope("juez", TOPE);
    const r = await juzgarHastaElTope(ds.preguntas.map((p) => resultado(p.id)), juicios, ds, cred, tope, precioJuez, j.fetch, true);
    expect(j.maxEnVuelo()).toBe(1);
    expect(juicios.size).toBeGreaterThanOrEqual(3);
    expect(r.llamadas).toBeGreaterThanOrEqual(12);
    expect(tope.gastado).toBeLessThanOrEqual(TOPE);
    // Todos los turnos completos tienen ganador (partidas coherentes: A en la 1, B-como-A en la 2 → empate inconsistente).
    const completos = [...juicios.values()].flat().filter((t) => !t.sinPresupuesto);
    expect(completos.every((t) => t.ganador !== "error")).toBe(true);
  });

  it("un turno cuya segunda partida no cupo no cuenta como empate, y el siguiente ni se intenta a medias", async () => {
    const ds = datasetDePrueba(1);
    const juicios = new Map<number, JuicioDeTurno[]>();
    const j = juezFalso();
    // Sitio para UNA reserva y poco más: la primera partida sale, la segunda ya no cabe.
    const tope = new Tope("juez", 0.022);
    const r = await juzgarHastaElTope([resultado(1)], juicios, ds, cred, tope, precioJuez, j.fetch, true);
    expect(r.corte).toBe(true);
    expect(r.llamadas).toBe(1);
    const turnos = juicios.get(1) ?? [];
    expect(turnos.every((t) => t.sinPresupuesto)).toBe(true);
    // Ninguno de los dos turnos tiene ganador válido: nada entra en la tasa como ½.
    expect(turnosValidos(turnos)).toEqual([]);
  });

  it("turnosValidos deja fuera los turnos sin presupuesto y los ilegibles", () => {
    const base = { prompt: "pair-v2", partida1: "A", partida2: "A", inconsistente: false, identicas: false } as const;
    const js: JuicioDeTurno[] = [
      { ...base, turno: 1, ganador: "B" },
      { ...base, turno: 2, ganador: "error", sinPresupuesto: true, partida2: "error" },
      { ...base, turno: 1, ganador: "error", partida1: "error" },
      { ...base, turno: 2, ganador: "empate", inconsistente: true },
    ];
    expect(turnosValidos(js).map((j) => j.ganador)).toEqual(["B", "empate"]);
  });
});
