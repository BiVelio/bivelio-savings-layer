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

/**
 * VERIFICACIÓN 2 DE LA 1.2.4: CON LICENCIA, NINGUNA CARGA CUESTA MÁS QUE EN LA 1.2.3.
 *
 * En la 1.2.3 una licencia de pago no recortaba (le faltaba el literal). En la
 * 1.2.4 toda licencia recorta, y eso rompía cachés que la 1.2.3 de pago no
 * rompía (proveedor falso; coste con capa frente a sin capa, 1.2.3 → 1.2.4):
 *   · Anthropic con la colocación por defecto, conversación de 12 turnos que
 *     vuelve a leer el mismo fichero: el recorte de un resultado ANTERIOR al
 *     último turno del usuario dejaba la marca en el `system` el resto de la
 *     conversación. Sonnet −67,2 % → −30,1 %. Ahora solo se recortan los del
 *     bucle en curso (E1).
 *   · Gemini (lectura al 10 %, sin prima de escritura): 0 % → +11,9 % en un
 *     agente de 60 pasos. Ahora no recorta (E2), con licencia y sin ella.
 *   · DeepSeek (proveedor que la capa no reconoce): 0 % → +13,7 %. Con licencia
 *     ya no recorta, como en la 1.2.3 (E3). Sin clave, como en la 1.2.3.
 */

/** Anthropic falso con la caché de prompt (reglas públicas, sin TTL): lee el prefijo más largo ya escrito en un punto marcado. */
function anthropicConCache() {
  const escrito = new Set<string>();
  const cuerpos: Record<string, unknown>[] = [];
  const porPeticion: { total: number; leidos: number; escritos: number }[] = [];
  const tok = (s: string): number => Math.ceil(s.length / 4);
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    cuerpos.push(body);
    const bloques: { texto: string; bp: boolean }[] = [];
    for (const t of (body["tools"] as Record<string, unknown>[] | undefined) ?? []) {
      const { cache_control, ...resto } = t;
      bloques.push({ texto: "T:" + JSON.stringify(resto), bp: cache_control != null });
    }
    const system = body["system"];
    if (typeof system === "string") bloques.push({ texto: "S:" + system, bp: false });
    else for (const b of (system as Record<string, unknown>[] | undefined) ?? []) bloques.push({ texto: "S:" + String(b["text"] ?? ""), bp: b["cache_control"] != null });
    for (const m of body["messages"] as { role: string; content: string | Record<string, unknown>[] }[]) {
      if (typeof m.content === "string") bloques.push({ texto: `M:${m.role}:${m.content}`, bp: false });
      else for (const b of m.content) {
        const { cache_control, ...resto } = b;
        bloques.push({ texto: `M:${m.role}:${JSON.stringify(resto)}`, bp: cache_control != null });
      }
    }
    let acumulado = `modelo:${String(body["model"])}|`;
    const pref = bloques.map((b) => {
      acumulado += b.texto + "\u0001";
      return { clave: acumulado, tokens: tok(acumulado) };
    });
    const total = pref.at(-1)?.tokens ?? 0;
    const puntos = bloques.flatMap((b, i) => (b.bp ? [i] : []));
    let leidos = 0;
    let escritos = 0;
    for (const p of puntos) {
      for (let j = p; j >= Math.max(0, p - 20); j--) {
        if (pref[j]!.tokens >= 1024 && escrito.has(pref[j]!.clave)) {
          leidos = Math.max(leidos, pref[j]!.tokens);
          break;
        }
      }
    }
    const ultimo = puntos.at(-1);
    if (ultimo != null && pref[ultimo]!.tokens >= 1024 && pref[ultimo]!.tokens > leidos) escritos = pref[ultimo]!.tokens - leidos;
    for (const p of puntos) if (pref[p]!.tokens >= 1024) escrito.add(pref[p]!.clave);
    porPeticion.push({ total, leidos, escritos });
    const usage = { input_tokens: total - leidos - escritos, output_tokens: 5, cache_read_input_tokens: leidos, cache_creation_input_tokens: escritos };
    return new Response(
      JSON.stringify({ id: "msg_falso", type: "message", role: "assistant", content: [{ type: "text", text: "Next." }], stop_reason: "end_turn", usage }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const suma = (k: "total" | "leidos" | "escritos"): number => porPeticion.reduce((s, x) => s + x[k], 0);
  /** Entrada a precio lleno: lectura 0,10×, escritura 1,25×. */
  const coste = (): number => suma("total") - suma("leidos") - suma("escritos") + 0.1 * suma("leidos") + 1.25 * suma("escritos");
  return { cuerpos, porPeticion, fetchImpl, coste, sinCapa: () => suma("total") };
}

const POLITICAS = (n: number): string =>
  Array.from({ length: n }, (_, i) => `Policy ${i}: orders of kind ${i} ship within ${i + 1} days and may be returned within thirty days.`).join(" ");
const configuracion = (version: number): string =>
  Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(3)}: export function handlerconfig_${i}(input) { return validate(input) && store.save("config", input, ${version}); }`).join("\n");
const registroDeBuild = (t: number): string =>
  `Here is the build log ${t}:\n` + Array.from({ length: 40 }, (_, i) => `[build ${t}] step ${i}: compiled module m${i} in ${i * 7 + t} ms, 0 warnings`).join("\n");

/**
 * Soporte de 12 turnos: en cada turno el usuario pega un registro largo y el
 * asistente vuelve a leer el MISMO fichero pequeño. Las lecturas viejas quedan
 * sustituidas y DELANTE del último turno del usuario: en el historial marcado.
 */
async function soporte12(modelo: string, config: Record<string, unknown>) {
  const f = anthropicConCache();
  const capa = createSavingsLayer({ provider: new AnthropicProvider({ apiKey: "clave-inventada", fetchImpl: f.fetchImpl }), silenceWarnings: true, ...config });
  const hist: ChatMessage[] = [{ role: "system", content: "You are a coding assistant for an invented repository. " + POLITICAS(40) }];
  const elision: string[] = [];
  const pedir = async (): Promise<void> => {
    const r = await capa.generate({ model: modelo, messages: [...hist], tools: HERRAMIENTAS, temperature: 0 } as SavingsRequest);
    for (const t of r.report.traces) if (t.stage === "elision") elision.push(t.outcome);
  };
  for (let t = 0, id = 0; t < 12; t++) {
    hist.push({ role: "user", content: `Turn ${t + 1}: please check the config again and tell me what changed. ${registroDeBuild(t)}` });
    await pedir();
    id++;
    hist.push({ role: "assistant", content: "", toolCalls: [{ id: `call_${id}`, name: "read_file", arguments: JSON.stringify({ path: "src/config.ts" }) }] });
    hist.push({ role: "tool", toolCallId: `call_${id}`, name: "read_file", content: configuracion(1 + (t >> 1)) });
    await pedir();
    hist.push({ role: "assistant", content: `Summary of turn ${t + 1}: the config looks the same as before, version ${1 + (t >> 1)}.` });
  }
  await capa.close();
  return { ...f, elision };
}

describe("verificación 2: con licencia el recorte no cuesta más que la 1.2.3", () => {
  it("Pro en soporte de 12 turnos con Sonnet conserva las lecturas del historial", async () => {
    const pro = await soporte12("anthropic/claude-sonnet-4-5", licenciaPro());
    const conElisionApagada = await (async () => {
      const f = anthropicConCache();
      const capa = createSavingsLayer({ provider: new AnthropicProvider({ apiKey: "clave-inventada", fetchImpl: f.fetchImpl }), silenceWarnings: true, ...licenciaPro() });
      const hist: ChatMessage[] = [{ role: "system", content: "You are a coding assistant for an invented repository. " + POLITICAS(40) }];
      for (let t = 0, id = 0; t < 12; t++) {
        hist.push({ role: "user", content: `Turn ${t + 1}: please check the config again and tell me what changed. ${registroDeBuild(t)}` });
        await capa.generate({ model: "anthropic/claude-sonnet-4-5", messages: [...hist], tools: HERRAMIENTAS, temperature: 0, savings: { elision: false } } as SavingsRequest);
        id++;
        hist.push({ role: "assistant", content: "", toolCalls: [{ id: `call_${id}`, name: "read_file", arguments: JSON.stringify({ path: "src/config.ts" }) }] });
        hist.push({ role: "tool", toolCallId: `call_${id}`, name: "read_file", content: configuracion(1 + (t >> 1)) });
        await capa.generate({ model: "anthropic/claude-sonnet-4-5", messages: [...hist], tools: HERRAMIENTAS, temperature: 0, savings: { elision: false } } as SavingsRequest);
        hist.push({ role: "assistant", content: `Summary of turn ${t + 1}: the config looks the same as before, version ${1 + (t >> 1)}.` });
      }
      await capa.close();
      return f;
    })();
    expect(pro.cuerpos.length).toBe(24);
    // Ningún muñón en el historial marcado: los resultados viejos están todos
    // delante del último turno del usuario, y ahí no se recortan.
    expect(munones(pro.cuerpos)).toBe(0);
    expect(pro.elision).toContain("partial");
    // El historial marcado se sigue leyendo: desde el segundo turno lo leído
    // crece con la conversación y las últimas peticiones leen casi todo (con el
    // fallo, tras el primer recorte solo se marcaba el `system`).
    const leidos = pro.porPeticion.map((p) => p.leidos);
    for (let k = 5; k < leidos.length; k++) expect(leidos[k]).toBeGreaterThanOrEqual(leidos[k - 1]!);
    for (const p of pro.porPeticion.slice(-4)) expect(p.leidos).toBeGreaterThan(0.8 * p.total);
    // El dinero: lo mismo que con el recorte apagado (lo que hacía la 1.2.3 de
    // pago), y muy por debajo de no llevar capa (−67 % medido con el banco).
    expect(Math.round(pro.coste())).toBe(Math.round(conElisionApagada.coste()));
    expect(pro.coste()).toBeLessThan(0.45 * pro.sinCapa());
  });

  it("también sin clave y con Haiku 4.5: el historial marcado no pierde lecturas", async () => {
    for (const [modelo, config] of [
      ["anthropic/claude-sonnet-4-5", {}],
      ["anthropic/claude-haiku-4-5", licenciaPro()],
    ] as const) {
      const a = await soporte12(modelo, config);
      expect(munones(a.cuerpos)).toBe(0);
      expect(a.coste()).toBeLessThan(0.6 * a.sinCapa());
    }
  });

  it("Pro en Gemini y DeepSeek, agente de 60 pasos, no cuesta más que sin capa: ni un muñón y el historial solo crece", async () => {
    for (const [modelo, motivo] of [
      ["google/gemini-2.5-flash", /bills cached input at 25% or less/],
      ["gemini-2.5-flash", /bills cached input at 25% or less/],
      ["google/gemini-2.5-pro", /bills cached input at 25% or less/],
      ["deepseek/deepseek-chat", /unrecognised provider/],
    ] as const) {
      const f = openaiFalso();
      const capa = createSavingsLayer({
        provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: "clave-inventada", fetchImpl: f.fetchImpl }),
        silenceWarnings: true,
        ...licenciaPro(),
      });
      const razones: string[] = [];
      for (const messages of pasos(60)) {
        const r = await capa.generate({ model: modelo, messages, tools: HERRAMIENTAS, temperature: 0 } as SavingsRequest);
        const t = r.report.traces.find((x) => x.stage === "elision");
        if (t) razones.push(`${t.outcome}: ${String(t.detail?.["reason"] ?? "")}`);
      }
      await capa.close();
      expect(f.cuerpos.length).toBe(60);
      expect(munones(f.cuerpos)).toBe(0);
      // Lo que sale es lo que mandaría la app sin capa (el historial entero, que
      // solo crece): la caché automática del proveedor lo lee igual que sin capa.
      expect(historialSoloCrece(f.cuerpos)).toBe(true);
      expect(f.coste()).toBeLessThan(0.2 * f.sinCache());
      expect(razones.some((r) => r.startsWith("skipped") && motivo.test(r))).toBe(true);
    }
  });

  it("Gemini sin clave tampoco recorta (antes: +11,9 % en el agente)", async () => {
    const a = await agenteOpenAI("google/gemini-2.5-flash", {});
    expect(munones(a.cuerpos)).toBe(0);
    expect(historialSoloCrece(a.cuerpos)).toBe(true);
  });

  it("gpt-4o-mini y los agentes de Anthropic siguen recortando, con Pro y sin clave", async () => {
    for (const config of [licenciaPro(), {}]) {
      const mini = await agenteOpenAI("openai/gpt-4o-mini", config);
      expect(munones(mini.cuerpos)).toBeGreaterThan(0);
      for (const modelo of ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"]) {
        const agente = async (elision: boolean) => {
          const f = anthropicConCache();
          const capa = createSavingsLayer({ provider: new AnthropicProvider({ apiKey: "clave-inventada", fetchImpl: f.fetchImpl }), silenceWarnings: true, ...config });
          for (const messages of pasos(30)) {
            await capa.generate({ model: modelo, messages, tools: HERRAMIENTAS, temperature: 0, ...(elision ? {} : { savings: { elision: false } }) } as SavingsRequest);
          }
          await capa.close();
          return f;
        };
        const con = await agente(true);
        const sin = await agente(false);
        // En un bucle de agente los resultados viejos van DETRÁS del último
        // turno del usuario: el recorte sigue actuando y la factura baja.
        expect(munones(con.cuerpos)).toBeGreaterThan(0);
        expect(con.coste()).toBeLessThan(0.8 * sin.coste());
      }
    }
  });
});
