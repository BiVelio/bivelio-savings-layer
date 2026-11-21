import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KEEP_TOOL_RESULTS, MUNON_ELISION } from "../src/pipeline/elision.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { ChatMessage, SavingsRequest } from "../src/contracts/types.js";
import { signLicense, testPayload, TEST_KEYS } from "./helpers/test-license.js";

/**
 * EL RECORTE DE RESULTADOS DE HERRAMIENTAS NO PUEDE ROMPER UNA CACHÉ QUE EL
 * PROVEEDOR YA ESTÁ LEYENDO.
 *
 * El recorte cambia por un muñón un tool_result VIEJO, a mitad del historial.
 * Con caché automática de TODO el prompt (gpt-5, gpt-4.1, serie o: la lectura
 * cuesta el 10-25 %) o con puntos de caché dentro del historial
 * (`cacheBreakpoints: "auto"` en Anthropic), todo lo que va detrás de ese
 * mensaje se vuelve a cobrar entero. Medido con un proveedor falso, agente de
 * 60 pasos: con Pro en la 1.2.4, gpt-5 pasaba de 0 % a +12,2 % frente a no
 * llevar capa, y "auto" en Anthropic de −84,4 % a −71,5 %.
 *
 * Aquí se fija, con el gate REAL de una licencia Pro y un proveedor falso en
 * proceso que guarda cada cuerpo:
 *   · gpt-5 y "auto" en Anthropic: el historial que sale es el de la petición
 *     anterior más lo nuevo (lo que la caché del proveedor puede leer), sin un
 *     solo muñón, y la traza dice por qué;
 *   · gpt-5 no cuesta más que sin capa con la caché automática de OpenAI;
 *   · gpt-4o-mini y Anthropic por defecto recortan como en la 1.2.4.
 */

const PRO = ["semantic_cache", "learned_thresholds", "dashboards", "long_context_compression", "context_elision", "cache_ttl_tuning", "sibling_model_routing", "per_turn_effort", "priority_support"];
const licenciaPro = () => ({ licenseKey: signLicense(testPayload({ plan: "pro", features: PRO })), licensePublicKey: TEST_KEYS.publicKey });

const fichero = (n: string, v: number): string =>
  Array.from({ length: 60 }, (_, i) => `${String(i + 1).padStart(3)}: export function ${n}_${i}(x) { return save("${n}", x, ${v}); }`).join("\n");

/** Un bucle de agente que relee los mismos ficheros: las lecturas viejas quedan sustituidas. */
function pasos(n: number): ChatMessage[][] {
  const ficheros = ["server", "store", "router"];
  const hist: ChatMessage[] = [
    { role: "system", content: "You are a coding agent. Read files with the tool, one at a time, then fix the bug." },
    { role: "user", content: "Fix the failing payload validation test." },
  ];
  const peticiones: ChatMessage[][] = [];
  for (let i = 0; i < n; i++) {
    const path = `src/${ficheros[i % 3]}.ts`;
    hist.push({ role: "assistant", content: "", toolCalls: [{ id: `call_${i}`, name: "read_file", arguments: JSON.stringify({ path }) }] });
    hist.push({ role: "tool", toolCallId: `call_${i}`, name: "read_file", content: fichero(ficheros[i % 3]!, 1 + (i >> 3)) });
    peticiones.push([...hist]);
  }
  return peticiones;
}

const HERRAMIENTAS: SavingsRequest["tools"] = [
  {
    id: "read_file",
    intents: ["read"],
    risk: "read",
    description: "Read a file from the repository.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
] as never;

/** OpenAI falso con caché automática del prefijo común (lectura al 10 %, como gpt-5). */
function openaiFalso() {
  const cuerpos: Record<string, unknown>[] = [];
  const vistos: string[] = [];
  let pleno = 0;
  let leido = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    cuerpos.push(body);
    const prompt = JSON.stringify(body["messages"]);
    let comun = 0;
    for (const v of vistos) {
      let i = 0;
      while (i < v.length && i < prompt.length && v.charCodeAt(i) === prompt.charCodeAt(i)) i++;
      comun = Math.max(comun, i);
    }
    vistos.push(prompt);
    const cacheado = comun >= 4096 ? Math.floor(comun / 512) * 512 : 0;
    leido += cacheado;
    pleno += prompt.length - cacheado;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Next." }, finish_reason: "stop" }],
        usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 5, prompt_tokens_details: { cached_tokens: Math.floor(cacheado / 4) } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { cuerpos, fetchImpl, coste: () => pleno + 0.1 * leido, sinCache: () => pleno + leido };
}

/** Anthropic falso que solo guarda los cuerpos. */
function anthropicFalso() {
  const cuerpos: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    cuerpos.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ id: "msg_falso", type: "message", role: "assistant", content: [{ type: "text", text: "Next." }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { cuerpos, fetchImpl };
}

const munones = (cuerpos: Record<string, unknown>[]): number => cuerpos.reduce((n, b) => n + (JSON.stringify(b).split(MUNON_ELISION).length - 1), 0);

/** ¿Cada cuerpo empieza por los mensajes del anterior, sin tocar ninguno? */
function historialSoloCrece(cuerpos: Record<string, unknown>[]): boolean {
  for (let k = 1; k < cuerpos.length; k++) {
    const antes = cuerpos[k - 1]!["messages"] as unknown[];
    const ahora = cuerpos[k]!["messages"] as unknown[];
    for (let i = 0; i < antes.length; i++) if (JSON.stringify(antes[i]) !== JSON.stringify(ahora[i])) return false;
  }
  return true;
}

let devOpenGuardado: string | undefined;
beforeEach(() => {
  reiniciarAvisos();
  // Que decida el gate REAL de la licencia (ver licencia-con-todas-las-palancas).
  devOpenGuardado = process.env.BVSALA_DEV_OPEN;
  delete process.env.BVSALA_DEV_OPEN;
});
afterEach(() => {
  if (devOpenGuardado !== undefined) process.env.BVSALA_DEV_OPEN = devOpenGuardado;
});

async function agenteOpenAI(modelo: string, config: Record<string, unknown>) {
  const f = openaiFalso();
  const capa = createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: "clave-inventada", fetchImpl: f.fetchImpl }),
    silenceWarnings: true,
    ...config,
  });
  const razones: string[] = [];
  for (const messages of pasos(30)) {
    const r = await capa.generate({ model: modelo, messages, tools: HERRAMIENTAS, temperature: 0 } as SavingsRequest);
    const t = r.report.traces.find((x) => x.stage === "elision");
    if (t) razones.push(`${t.outcome}: ${String(t.detail?.["reason"] ?? "")}`);
  }
  await capa.close();
  return { ...f, razones };
}

describe("el recorte no rompe la caché automática de gpt-5", () => {
  it("Pro con gpt-5 en un bucle de agente no cuesta más que sin capa: el historial solo crece y no hay muñones", async () => {
    const a = await agenteOpenAI("openai/gpt-5", licenciaPro());
    expect(a.cuerpos.length).toBe(30);
    expect(munones(a.cuerpos)).toBe(0);
    expect(historialSoloCrece(a.cuerpos)).toBe(true);
    // Lo que se manda es lo que mandaría la app sin capa (el historial entero,
    // que solo crece), así que la caché automática lo lee casi todo: la entrada
    // cuesta como sin capa con caché, no más. Con el recorte (1.2.4) cada muñón
    // nuevo a mitad del historial volvía a cobrar entero todo lo de detrás.
    expect(a.coste()).toBeLessThan(0.2 * a.sinCache());
    expect(a.razones.some((r) => /skipped: this model caches the whole prompt automatically/.test(r))).toBe(true);
  });

  it("también sin clave, y con gpt-4.1 y la serie o", async () => {
    for (const modelo of ["openai/gpt-5", "openai/gpt-4.1", "openai/o3", "openai/gpt-5-mini"]) {
      const a = await agenteOpenAI(modelo, {});
      expect(munones(a.cuerpos)).toBe(0);
      expect(historialSoloCrece(a.cuerpos)).toBe(true);
    }
  });

  it("gpt-4o-mini sigue recortando como en la 1.2.4 (cobra la lectura al 50 %)", async () => {
    const a = await agenteOpenAI("openai/gpt-4o-mini", licenciaPro());
    expect(munones(a.cuerpos)).toBeGreaterThan(0);
    // Pasados KEEP_TOOL_RESULTS pasos ya hay lecturas sustituidas que recortar.
    expect(a.razones.filter((r) => r.startsWith("applied")).length).toBeGreaterThan(30 - KEEP_TOOL_RESULTS - 6);
  });
});

describe('el recorte no rompe los puntos de caché de cacheBreakpoints: "auto" en Anthropic', () => {
  async function agenteAnthropic(config: Record<string, unknown>) {
    const f = anthropicFalso();
    const capa = createSavingsLayer({ provider: new AnthropicProvider({ apiKey: "clave-inventada", fetchImpl: f.fetchImpl }), silenceWarnings: true, ...config });
    for (const messages of pasos(30)) await capa.generate({ model: "anthropic/claude-sonnet-4-5", messages, tools: HERRAMIENTAS, temperature: 0 } as SavingsRequest);
    await capa.close();
    return f;
  }

  it('auto en Anthropic no pierde lecturas por el recorte: ningún muñón, el historial solo crece', async () => {
    const a = await agenteAnthropic({ ...licenciaPro(), cacheBreakpoints: "auto" });
    expect(a.cuerpos.length).toBe(30);
    expect(munones(a.cuerpos)).toBe(0);
    const sinCacheControl = a.cuerpos.map((b) => JSON.parse(JSON.stringify(b).replace(/,"cache_control":\{[^}]*\}/g, "")) as Record<string, unknown>);
    expect(historialSoloCrece(sinCacheControl)).toBe(true);
  });

  it("con la colocación por defecto (sin puntos en el historial) sigue recortando", async () => {
    const a = await agenteAnthropic(licenciaPro());
    expect(munones(a.cuerpos)).toBeGreaterThan(0);
  });
});
