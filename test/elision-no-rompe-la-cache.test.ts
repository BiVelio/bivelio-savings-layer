import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MUNON_ELISION, seleccionarSupersesion } from "../src/pipeline/elision.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { ChatMessage, SavingsRequest } from "../src/contracts/types.js";
import { signLicense, testPayload, TEST_KEYS } from "./helpers/test-license.js";

/**
 * EL RECORTE DE RESULTADOS DE HERRAMIENTAS SUSTITUIDOS EN LA 1.2.4, POR CLAVE.
 *
 * Regla del dueño (21-11-2026): sin clave ninguna carga puede costar más que con
 * la 1.2.3; con clave de pago, ninguna más que con la 1.2.3 de pago (que no
 * recortaba: a su token le faltaba `tool_result_elision`).
 *
 *  · SIN CLAVE el recorte es EXACTAMENTE el de la 1.2.3, sin ninguna guarda
 *    nueva. Las guardas de la verificación 2 (no recortar en gpt-5, gpt-4.1, la
 *    serie o, Gemini ni con `cacheBreakpoints: "auto"`, y E1: no recortar lo
 *    anterior al último turno del usuario) mejoraban unas cargas y empeoraban
 *    otras frente a la 1.2.3 (verificación 3, proveedor falso, coste con capa
 *    frente a sin capa): chat con herramientas y turnos a 6 min en Sonnet
 *    −73,7 % → −53,5 %; gpt-5 y Gemini con turnos a 12 min −36,8 % → 0 %;
 *    "auto" con turnos a 70 min −73,5 % → −56,9 %. Así que se quitan, y con ellas
 *    sus mejoras: gpt-5 en un agente de 60 pasos sigue en +12,2 %, como en la
 *    1.2.3 (salida: `savings: { elision: false }`).
 *  · CON CLAVE (Measure, Pro, Team, Enterprise) solo recorta dentro del bucle de
 *    herramientas en Anthropic con la colocación fija, nunca con
 *    `AnthropicProvider({ automaticCache: true })` ni con "auto", y solo los
 *    resultados posteriores al último turno del usuario (E1). En el resto no
 *    recorta, como la 1.2.3 de pago. Medido: agentes de Anthropic con Pro 0 % →
 *    −71,6 %; con automaticCache, recortar llevaba un agente de 60 pasos de
 *    −85,2 % a −69,0 %, y gpt-4o con una relectura tardía de 0 % a +1,8 %.
 *
 * Aquí se fija con el gate REAL de la licencia y proveedores falsos en proceso
 * que guardan cada cuerpo.
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

/**
 * Anthropic falso con la caché de prompt (reglas públicas): lee el prefijo más
 * largo ya escrito en un punto marcado. Con `reloj`, cada entrada caduca a los
 * 5 min de su última escritura o lectura; sin él, no caduca.
 */
function anthropicConCache(reloj?: () => number) {
  const TTL = 5 * 60_000;
  const ahora = reloj ?? (() => 0);
  const caduca = new Map<string, number>();
  const vivo = (clave: string): boolean => (caduca.get(clave) ?? -Infinity) > ahora() || (reloj == null && caduca.has(clave));
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
        if (pref[j]!.tokens >= 1024 && vivo(pref[j]!.clave)) {
          leidos = Math.max(leidos, pref[j]!.tokens);
          caduca.set(pref[j]!.clave, ahora() + TTL);
          break;
        }
      }
    }
    const ultimo = puntos.at(-1);
    if (ultimo != null && pref[ultimo]!.tokens >= 1024 && pref[ultimo]!.tokens > leidos) escritos = pref[ultimo]!.tokens - leidos;
    for (const p of puntos) if (pref[p]!.tokens >= 1024) caduca.set(pref[p]!.clave, ahora() + TTL);
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

const munonesDe = (b: Record<string, unknown>): number => JSON.stringify(b).split(MUNON_ELISION).length - 1;
const munones = (cuerpos: Record<string, unknown>[]): number => cuerpos.reduce((n, b) => n + munonesDe(b), 0);

/** ¿Cada cuerpo empieza por los mensajes del anterior, sin tocar ninguno? */
function historialSoloCrece(cuerpos: Record<string, unknown>[]): boolean {
  for (let k = 1; k < cuerpos.length; k++) {
    const antes = cuerpos[k - 1]!["messages"] as unknown[];
    const ahora = cuerpos[k]!["messages"] as unknown[];
    for (let i = 0; i < antes.length; i++) if (JSON.stringify(antes[i]) !== JSON.stringify(ahora[i])) return false;
  }
  return true;
}

const sinCacheControl = (cuerpos: Record<string, unknown>[]): Record<string, unknown>[] =>
  cuerpos.map((b) => JSON.parse(JSON.stringify(b).replace(/,"cache_control":\{[^}]*\}/g, "")) as Record<string, unknown>);

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

/**
 * Corre una lista de peticiones y apunta, por petición, los muñones que salen,
 * los que pondría la regla de la 1.2.3 (recortar TODO lo que selecciona
 * `seleccionarSupersesion`, sin guardas) y la traza de la etapa.
 */
async function correr(
  proveedor: (fetchImpl: typeof fetch) => AnthropicProvider | OpenAICompatibleProvider,
  f: { fetchImpl: typeof fetch; cuerpos: Record<string, unknown>[] },
  modelo: string,
  peticiones: (() => ChatMessage[])[] | ChatMessage[][],
  config: Record<string, unknown>,
  extra: Partial<SavingsRequest> = {},
  antesDeCada?: (k: number) => void,
) {
  const capa = createSavingsLayer({ provider: proveedor(f.fetchImpl), silenceWarnings: true, ...config });
  const trazas: string[] = [];
  const comoLa123: number[] = [];
  for (let k = 0; k < peticiones.length; k++) {
    antesDeCada?.(k);
    const p = peticiones[k]!;
    const messages = typeof p === "function" ? p() : p;
    comoLa123.push(seleccionarSupersesion(messages).indices.length);
    const r = await capa.generate({ model: modelo, messages, tools: HERRAMIENTAS, temperature: 0, ...extra } as SavingsRequest);
    const t = r.report.traces.find((x) => x.stage === "elision");
    trazas.push(t ? `${t.outcome}: ${String(t.detail?.["reason"] ?? "")}` : "");
  }
  await capa.close();
  return { trazas, comoLa123, porCuerpo: f.cuerpos.map(munonesDe) };
}

const openai = (fetchImpl: typeof fetch) => new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: "clave-inventada", fetchImpl });
const anthropic = (fetchImpl: typeof fetch) => new AnthropicProvider({ apiKey: "clave-inventada", fetchImpl });
const anthropicAuto = (fetchImpl: typeof fetch) => new AnthropicProvider({ apiKey: "clave-inventada", fetchImpl, automaticCache: true });

/** Ningún motivo de las guardas: la etapa recorta o no hay nada que recortar, como en la 1.2.3. */
const sinGuardas = (trazas: string[]): boolean => trazas.every((t) => t === "" || t.startsWith("applied") || /no old\/large tool_result/.test(t));

describe("sin clave, el recorte es exactamente el de la 1.2.3", () => {
  it("gpt-5, agente de 30 pasos: recorta todo lo sustituido, como la 1.2.3 (y cuesta más que no recortar: +12,2 % frente a sin capa en 60 pasos, medido)", async () => {
    const f = openaiFalso();
    const a = await correr(openai, f, "openai/gpt-5", pasos(30), {});
    expect(a.porCuerpo).toEqual(a.comoLa123);
    expect(munones(f.cuerpos)).toBeGreaterThan(0);
    expect(sinGuardas(a.trazas)).toBe(true);
    // El precio de la 1.2.3, que se mantiene: cada muñón nuevo a mitad del
    // historial vuelve a cobrar entero lo que va detrás.
    const g = openaiFalso();
    await correr(openai, g, "openai/gpt-5", pasos(30), {}, { savings: { elision: false } });
    expect(f.coste()).toBeGreaterThan(g.coste());
  });

  it("también gpt-4.1, la serie o, gpt-4o, Gemini y DeepSeek: el mismo recorte que la 1.2.3", async () => {
    for (const modelo of ["openai/gpt-4.1", "openai/o3", "openai/gpt-5-mini", "openai/gpt-4o-mini", "google/gemini-2.5-flash", "deepseek/deepseek-chat"]) {
      const f = openaiFalso();
      const a = await correr(openai, f, modelo, pasos(30), {});
      expect(a.porCuerpo).toEqual(a.comoLa123);
      expect(munones(f.cuerpos)).toBeGreaterThan(0);
      expect(sinGuardas(a.trazas)).toBe(true);
    }
  });

  it('cacheBreakpoints: "auto" en Anthropic: recorta como la 1.2.3', async () => {
    const f = anthropicConCache();
    const a = await correr(anthropic, f, "anthropic/claude-sonnet-4-5", pasos(30), { cacheBreakpoints: "auto" });
    expect(a.porCuerpo).toEqual(a.comoLa123);
    expect(munones(f.cuerpos)).toBeGreaterThan(0);
    expect(sinGuardas(a.trazas)).toBe(true);
  });

  it("soporte de 12 turnos con Sonnet: recorta también lo anterior al último turno del usuario, como la 1.2.3 (sin E1)", async () => {
    const f = anthropicConCache();
    const a = await correr(anthropic, f, "anthropic/claude-sonnet-4-5", soporte12(), {});
    expect(a.porCuerpo).toEqual(a.comoLa123);
    expect(munones(f.cuerpos)).toBeGreaterThan(0);
    expect(a.trazas.some((t) => t.startsWith("partial"))).toBe(false);
    expect(sinGuardas(a.trazas)).toBe(true);
  });

  it("chat con herramientas y turnos a 6 min (la caché ya caducó): recortar sale más barato que no recortar, como en la 1.2.3", async () => {
    // Con E1 sin clave (candidata de la verificación 3) los resultados viejos
    // viajaban enteros: −73,7 % → −53,5 % frente a sin capa en Sonnet y Haiku.
    for (const modelo of ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"]) {
      const chat = chatConHueco(6 * 60_000);
      const f = anthropicConCache(chat.reloj);
      const a = await correr(anthropic, f, modelo, chat.peticiones, {}, {}, chat.antesDeCada);
      expect(a.porCuerpo).toEqual(a.comoLa123);
      expect(munones(f.cuerpos)).toBeGreaterThan(0);
      expect(a.trazas.some((t) => t.startsWith("partial"))).toBe(false);

      const chat2 = chatConHueco(6 * 60_000);
      const g = anthropicConCache(chat2.reloj);
      await correr(anthropic, g, modelo, chat2.peticiones, {}, { savings: { elision: false } }, chat2.antesDeCada);
      expect(f.coste()).toBeLessThan(0.8 * g.coste());
    }
  });
});

describe("con clave, el recorte solo actúa dentro del bucle de herramientas en Anthropic con la colocación fija", () => {
  it("Pro, agente de Anthropic (Sonnet y Haiku): recorta igual que sin clave, byte a byte, y la factura baja (0 % → −71,6 % medido)", async () => {
    for (const modelo of ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"]) {
      const pro = anthropicConCache();
      await correr(anthropic, pro, modelo, pasos(30), licenciaPro());
      const libre = anthropicConCache();
      await correr(anthropic, libre, modelo, pasos(30), {});
      const apagado = anthropicConCache();
      await correr(anthropic, apagado, modelo, pasos(30), licenciaPro(), { savings: { elision: false } });
      expect(munones(pro.cuerpos)).toBeGreaterThan(0);
      expect(pro.cuerpos).toEqual(libre.cuerpos);
      // Con el recorte apagado es la 1.2.3 de pago.
      expect(pro.coste()).toBeLessThan(0.8 * apagado.coste());
    }
  });

  it("Pro con AnthropicProvider({ automaticCache: true }): no recorta (el proveedor cachea el historial entero: −85,2 % → −69,0 % si recortara)", async () => {
    const f = anthropicConCache();
    const a = await correr(anthropicAuto, f, "anthropic/claude-sonnet-4-5", pasos(30), licenciaPro());
    expect(f.cuerpos.length).toBe(30);
    expect(munones(f.cuerpos)).toBe(0);
    expect(historialSoloCrece(sinCacheControl(f.cuerpos))).toBe(true);
    expect(a.trazas.some((t) => t.startsWith("skipped") && /no automaticCache/.test(t))).toBe(true);
  });

  it("sin clave, automaticCache recorta como la 1.2.3", async () => {
    const f = anthropicConCache();
    const a = await correr(anthropicAuto, f, "anthropic/claude-sonnet-4-5", pasos(30), {});
    expect(a.porCuerpo).toEqual(a.comoLa123);
    expect(munones(f.cuerpos)).toBeGreaterThan(0);
  });

  it('Pro con cacheBreakpoints: "auto": no recorta (el colocador marca dentro del historial)', async () => {
    const f = anthropicConCache();
    const a = await correr(anthropic, f, "anthropic/claude-sonnet-4-5", pasos(30), { ...licenciaPro(), cacheBreakpoints: "auto" });
    expect(munones(f.cuerpos)).toBe(0);
    expect(historialSoloCrece(sinCacheControl(f.cuerpos))).toBe(true);
    expect(a.trazas.some((t) => t.startsWith("skipped"))).toBe(true);
  });

  it("Pro en gpt-4o, gpt-4o-mini, gpt-5, Gemini y DeepSeek: no recorta, el historial solo crece (como la 1.2.3 de pago)", async () => {
    for (const modelo of ["openai/gpt-4o", "openai/gpt-4o-mini", "openai/gpt-5", "google/gemini-2.5-flash", "gemini-2.5-flash", "google/gemini-2.5-pro", "deepseek/deepseek-chat"]) {
      const f = openaiFalso();
      const a = await correr(openai, f, modelo, pasos(60), licenciaPro());
      expect(f.cuerpos.length).toBe(60);
      expect(munones(f.cuerpos)).toBe(0);
      // Lo que sale es lo que mandaría la app sin capa (el historial entero, que
      // solo crece): la caché automática del proveedor lo lee igual que sin capa.
      expect(historialSoloCrece(f.cuerpos)).toBe(true);
      expect(f.coste()).toBeLessThan(0.2 * f.sinCache());
      expect(a.trazas.some((t) => t.startsWith("skipped") && /only acts inside a tool loop on Anthropic/.test(t))).toBe(true);
    }
  });

  it("Pro, Claude por OpenAICompatibleProvider, agente de 60 pasos: traza skipped y coste ≤ 1.2.3 Pro", async () => {
    // Verificación 4, bloqueante 2: la guarda miraba la familia del MODELO (Claude
    // tiene prima de escritura) y no el proveedor, así que con clave recortaba
    // Claude servido por un endpoint compatible con OpenAI (OpenRouter, LiteLLM,
    // pasarelas), que puede cachear el prompt por su cuenta. Medido con un
    // proveedor falso que cachea el prefijo común: de la 1.2.3 Pro (no recorta) a
    // la candidata, Sonnet 0 % → +12,67 % y Haiku 0 % → +23,31 %. Ahora decide el
    // proveedor: solo AnthropicProvider sin automaticCache declara
    // `cachesWholePrompt === false`; cualquier otro no recorta con clave.
    for (const modelo of ["claude-sonnet-4-5", "claude-haiku-4-5", "anthropic/claude-sonnet-4-5"]) {
      const pro = openaiFalso();
      const a = await correr(openai, pro, modelo, pasos(60), licenciaPro());
      // La 1.2.3 de pago no recortaba: es la misma capa con el recorte apagado.
      const como123 = openaiFalso();
      await correr(openai, como123, modelo, pasos(60), licenciaPro(), { savings: { elision: false } });
      expect(pro.cuerpos.length).toBe(60);
      expect(munones(pro.cuerpos)).toBe(0);
      expect(historialSoloCrece(pro.cuerpos)).toBe(true);
      expect(a.trazas.some((t) => t.startsWith("skipped") && /only acts inside a tool loop on Anthropic/.test(t))).toBe(true);
      expect(pro.coste()).toBeLessThanOrEqual(como123.coste());
      expect(pro.cuerpos).toEqual(como123.cuerpos);
    }
  });

  it("solo AnthropicProvider sin automaticCache declara que no cachea el prompt entero (el getter es interno)", () => {
    expect(new AnthropicProvider({ apiKey: "clave-inventada" }).cachesWholePrompt).toBe(false);
    expect(new AnthropicProvider({ apiKey: "clave-inventada", automaticCache: true }).cachesWholePrompt).toBe(true);
    expect((openai(fetch) as unknown as { cachesWholePrompt?: boolean }).cachesWholePrompt).toBeUndefined();
  });

  it("Pro en soporte de 12 turnos con Sonnet y Haiku: conserva las lecturas del historial (E1) y cuesta lo mismo que con el recorte apagado", async () => {
    for (const modelo of ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"]) {
      const pro = anthropicConCache();
      const a = await correr(anthropic, pro, modelo, soporte12(), licenciaPro());
      const apagado = anthropicConCache();
      await correr(anthropic, apagado, modelo, soporte12(), licenciaPro(), { savings: { elision: false } });
      expect(pro.cuerpos.length).toBe(24);
      // Ningún muñón en el historial marcado: los resultados viejos están todos
      // delante del último turno del usuario, y ahí no se recortan con clave.
      expect(munones(pro.cuerpos)).toBe(0);
      expect(a.trazas.some((t) => t.startsWith("partial"))).toBe(true);
      // El historial marcado se sigue leyendo: las últimas peticiones leen casi todo.
      for (const p of pro.porPeticion.slice(-4)) expect(p.leidos).toBeGreaterThan(0.8 * p.total);
      // El dinero: lo mismo que con el recorte apagado (lo que hacía la 1.2.3 de pago).
      expect(Math.round(pro.coste())).toBe(Math.round(apagado.coste()));
      expect(pro.coste()).toBeLessThan(0.6 * pro.sinCapa());
    }
  });
});

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
 * 24 peticiones, construidas en orden (cada una es una foto del historial).
 */
function soporte12(): ChatMessage[][] {
  const hist: ChatMessage[] = [{ role: "system", content: "You are a coding assistant for an invented repository. " + POLITICAS(40) }];
  const peticiones: ChatMessage[][] = [];
  for (let t = 0, id = 0; t < 12; t++) {
    hist.push({ role: "user", content: `Turn ${t + 1}: please check the config again and tell me what changed. ${registroDeBuild(t)}` });
    peticiones.push([...hist]);
    id++;
    hist.push({ role: "assistant", content: "", toolCalls: [{ id: `call_${id}`, name: "read_file", arguments: JSON.stringify({ path: "src/config.ts" }) }] });
    hist.push({ role: "tool", toolCallId: `call_${id}`, name: "read_file", content: configuracion(1 + (t >> 1)) });
    peticiones.push([...hist]);
    hist.push({ role: "assistant", content: `Summary of turn ${t + 1}: the config looks the same as before, version ${1 + (t >> 1)}.` });
  }
  return peticiones;
}

/**
 * Chat con herramientas de 10 turnos que vuelve a leer los mismos tres ficheros
 * en cada turno, con `hueco` ms entre turnos del usuario y 3 s entre pasos (la
 * carga «hueco/chat-herramientas-10» de la verificación 3).
 */
function chatConHueco(hueco: number) {
  let t = 0;
  const ficheros = ["server", "store", "router"];
  const hist: ChatMessage[] = [{ role: "system", content: "You are a coding assistant for an invented repository. " + POLITICAS(10) }];
  const peticiones: ChatMessage[][] = [];
  const instantes: number[] = [];
  for (let turno = 0, id = 0; turno < 10; turno++) {
    if (turno > 0) t += hueco;
    hist.push({ role: "user", content: `Turn ${turno + 1}: please check the handlers again and tell me what changed. ${"Context line. ".repeat(20)}` });
    for (const nombre of ficheros) {
      peticiones.push([...hist]);
      instantes.push(t);
      t += 3000;
      id++;
      hist.push({ role: "assistant", content: "", toolCalls: [{ id: `call_${id}`, name: "read_file", arguments: JSON.stringify({ path: `src/${nombre}.ts` }) }] });
      hist.push({ role: "tool", toolCallId: `call_${id}`, name: "read_file", content: fichero(nombre, 1 + (turno >> 1)) });
    }
    peticiones.push([...hist]);
    instantes.push(t);
    t += 3000;
    hist.push({ role: "assistant", content: `Summary of turn ${turno + 1}: the handlers look the same as before, version ${1 + (turno >> 1)}.` });
  }
  let ahora = 0;
  return { peticiones, reloj: () => ahora, antesDeCada: (k: number) => void (ahora = instantes[k]!) };
}
