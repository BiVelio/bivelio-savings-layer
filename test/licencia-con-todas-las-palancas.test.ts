import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KEEP_TOOL_RESULTS, MUNON_ELISION } from "../src/pipeline/elision.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { communityGate } from "../src/license/community.js";
import { liveGateFromKey } from "../src/license/live-gate.js";
import { RevocationSnapshot } from "../src/license/revocation.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { ChatMessage, SavingsRequest } from "../src/contracts/types.js";
import { signLicense, testPayload, TEST_KEYS } from "./helpers/test-license.js";

/**
 * UNA LICENCIA DE PAGO LLEVA LAS PALANCAS DEL OPEN CORE (1.2.4), CON UNA EXCEPCIÓN.
 *
 * Regla del dueño: «solo debemos cobrar si utilizan nuestro CLOUD». Las palancas
 * son gratis para todos; la clave solo añade la nube. Hasta la 1.2.3 una
 * licencia Pro o Team no recortaba resultados de herramientas sustituidos: el
 * recorte pedía `tool_result_elision`, que no está en PRO_FEATURES ni en ningún
 * token emitido, mientras que el gate comunitario lo concede todo.
 *
 * La excepción (decisión del dueño, 21-11-2026), SOLO PARA LAS LICENCIAS DE
 * PAGO (Pro, Team, Enterprise): el recorte solo actúa dentro del bucle de
 * herramientas en Anthropic con la colocación fija, y solo sobre los resultados
 * posteriores al último turno del usuario. En el resto (gpt-4o, Gemini,
 * DeepSeek...) no recorta, como la 1.2.3 de pago: ahí un muñón a mitad del
 * historial rompía la caché automática del proveedor y una carga de pago costaba
 * más que en la 1.2.3 (verificación 3; ver elision-no-rompe-la-cache.test.ts).
 * La licencia gratuita Measure NO lleva la excepción (decisión del dueño, 21:45
 * UTC): manda EXACTAMENTE lo mismo que sin clave en todas las cargas.
 *
 * Con un proveedor falso que guarda cada cuerpo que sale, este fichero fija:
 *   · sin clave no cambia nada;
 *   · Measure manda EXACTAMENTE lo mismo que sin clave, en Anthropic y en
 *     gpt-4o-mini, también delante del último turno del usuario;
 *   · en el bucle de herramientas de Anthropic, Pro, Team y Enterprise mandan
 *     EXACTAMENTE lo mismo que sin clave, con el token tal cual se emite;
 *   · en gpt-4o-mini, con una licencia de pago, el cuerpo sale entero, como la
 *     1.2.3 de pago;
 *   · una licencia caducada o revocada sigue fallando cerrado: ni una llamada;
 *   · el opt-out por petición `savings: { elision: false }` sigue mandando.
 */

/** PRO_FEATURES tal cual sale hoy en los tokens: SIN `tool_result_elision`. */
const PRO_EMITIDAS = [
  "semantic_cache",
  "learned_thresholds",
  "dashboards",
  "long_context_compression",
  "context_elision",
  "cache_ttl_tuning",
  "sibling_model_routing",
  "per_turn_effort",
  "priority_support",
];

const cuerpoGordo = (n: number): string => "x".repeat(n);

/**
 * Dos ficheros releídos al final: sus lecturas viejas quedan sustituidas. Con
 * `pregunta`, la transcripción acaba en un turno nuevo del usuario (los
 * resultados quedan delante de él); sin ella, el bucle de herramientas sigue en
 * curso (los resultados van detrás del último turno del usuario).
 */
function transcripcion(pregunta = true): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: "revisa el repositorio y resume" }];
  const leer = (id: string, path: string) => {
    messages.push({ role: "assistant", content: "", toolCalls: [{ id, name: "read_file", arguments: JSON.stringify({ path }) }] });
    messages.push({ role: "tool", content: cuerpoGordo(4000), toolCallId: id, name: "read_file" });
  };
  leer("a1", "a.ts");
  leer("b1", "b.ts");
  for (let j = 0; j < KEEP_TOOL_RESULTS; j++) leer(`f${j}`, `filler-${j}.ts`);
  leer("a2", "a.ts");
  leer("b2", "b.ts");
  if (pregunta) messages.push({ role: "user", content: "resume lo que has leído" });
  return messages;
}

type Destino = "gpt-4o-mini" | "anthropic-bucle" | "anthropic-pregunta";

const peticion = (destino: Destino, extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: destino === "gpt-4o-mini" ? "openai/gpt-4o-mini" : "anthropic/claude-sonnet-4-5",
  messages: transcripcion(destino !== "anthropic-bucle"),
  temperature: 0,
  ...extra,
});

function proveedorFalso(destino: Destino) {
  const cuerpos: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    cuerpos.push(String(init.body));
    const respuesta =
      destino === "gpt-4o-mini"
        ? { choices: [{ message: { content: "Resumen." }, finish_reason: "stop" }], usage: { prompt_tokens: 9000, completion_tokens: 12 } }
        : { id: "msg_falso", type: "message", role: "assistant", content: [{ type: "text", text: "Resumen." }], stop_reason: "end_turn", usage: { input_tokens: 9000, output_tokens: 12 } };
    return new Response(JSON.stringify(respuesta), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const provider =
    destino === "gpt-4o-mini"
      ? new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl })
      : new AnthropicProvider({ apiKey: "clave-inventada", fetchImpl });
  return { cuerpos, provider };
}

const lic = (plan: string, features: string[], over: Record<string, unknown> = {}) => ({
  licenseKey: signLicense(testPayload({ plan, features, ...over })),
  licensePublicKey: TEST_KEYS.publicKey,
});

async function correr(destino: Destino, config: Record<string, unknown>, extra: Partial<SavingsRequest> = {}) {
  const p = proveedorFalso(destino);
  const capa = createSavingsLayer({ provider: p.provider, silenceWarnings: true, ...config });
  const res = await capa.generate(peticion(destino, extra));
  await capa.close();
  const traza = res.report.traces.find((t) => t.stage === "elision");
  const cuerpo = p.cuerpos[0] ?? "";
  return {
    llamadas: p.cuerpos.length,
    cuerpo,
    munones: cuerpo.split(MUNON_ELISION).length - 1,
    resultadosEnteros: cuerpo.split(cuerpoGordo(4000)).length - 1,
    traza: traza?.outcome,
    motivo: String(traza?.detail?.["reason"] ?? ""),
    elididos: (traza?.detail as { elided?: number } | undefined)?.elided,
  };
}

// La suite corre con BVSALA_DEV_OPEN=1 (vitest.config.ts), y en modo dev-open
// `entitled()` concede todo sin mirar el gate: estas pruebas pasarían aunque la
// licencia no concediera nada. Aquí se quita, para que decida el gate REAL, que
// es lo que corre en el paquete publicado.
let devOpenGuardado: string | undefined;
beforeEach(() => {
  reiniciarAvisos();
  devOpenGuardado = process.env.BVSALA_DEV_OPEN;
  delete process.env.BVSALA_DEV_OPEN;
});
afterEach(() => {
  if (devOpenGuardado !== undefined) process.env.BVSALA_DEV_OPEN = devOpenGuardado;
});

describe("SDK · el recorte de resultados sustituidos, por plan", () => {
  it.each(["gpt-4o-mini", "anthropic-bucle"] as const)("SIN CLAVE (no cambia, %s): recorta las 2 lecturas sustituidas y deja el resto entero", async (destino) => {
    const r = await correr(destino, {});
    expect(r.llamadas).toBe(1);
    expect(r.traza).toBe("applied");
    expect(r.elididos).toBe(2);
    expect(r.munones).toBe(2);
    expect(r.resultadosEnteros).toBe(KEEP_TOOL_RESULTS + 2);
  });

  it("SIN CLAVE, también delante del último turno del usuario en Anthropic, como en la 1.2.3", async () => {
    const r = await correr("anthropic-pregunta", {});
    expect(r.traza).toBe("applied");
    expect(r.munones).toBe(2);
  });

  it.each(["gpt-4o-mini", "anthropic-bucle", "anthropic-pregunta"] as const)(
    "MEASURE (%s): exactamente lo mismo que sin clave, byte a byte, sin la excepción de las licencias de pago",
    async (destino) => {
      const sinClave = await correr(destino, {});
      const measure = await correr(destino, lic("measure", []));
      expect(measure.llamadas).toBe(1);
      expect(measure.traza).toBe("applied");
      expect(measure.elididos).toBe(2);
      expect(measure.munones).toBe(2);
      expect(measure.resultadosEnteros).toBe(KEEP_TOOL_RESULTS + 2);
      expect(measure.cuerpo).toBe(sinClave.cuerpo);
      expect(measure.motivo).not.toMatch(/only acts inside a tool loop on Anthropic/);
    },
  );

  it.each(["measure", "pro", "team", "enterprise"])(
    "%s con el token que se emite hoy, en el bucle de herramientas de Anthropic: recorta igual que sin clave, byte a byte",
    async (plan) => {
      const sinClave = await correr("anthropic-bucle", {});
      const conClave = await correr("anthropic-bucle", lic(plan, plan === "measure" ? [] : PRO_EMITIDAS));
      // Hasta la 1.2.3, Pro: 0 muñones y KEEP_TOOL_RESULTS + 4 resultados enteros.
      expect(conClave.traza).toBe("applied");
      expect(conClave.elididos).toBe(2);
      expect(conClave.munones).toBe(2);
      expect(conClave.resultadosEnteros).toBe(KEEP_TOOL_RESULTS + 2);
      expect(conClave.cuerpo).toBe(sinClave.cuerpo);
    },
  );

  it.each(["pro", "team", "enterprise"])(
    "%s (de pago) en gpt-4o-mini (caché automática del proveedor): no recorta, el cuerpo sale entero como en la 1.2.3 de pago",
    async (plan) => {
      const r = await correr("gpt-4o-mini", lic(plan, PRO_EMITIDAS));
      expect(r.llamadas).toBe(1);
      expect(r.traza).toBe("skipped");
      expect(r.motivo).toMatch(/only acts inside a tool loop on Anthropic/);
      expect(r.munones).toBe(0);
      expect(r.resultadosEnteros).toBe(KEEP_TOOL_RESULTS + 4);
    },
  );

  it.each(["pro", "team", "enterprise"])("%s (de pago) en Anthropic con un turno nuevo del usuario: los resultados de delante se conservan (E1)", async (plan) => {
    const r = await correr("anthropic-pregunta", lic(plan, PRO_EMITIDAS));
    expect(r.traza).toBe("partial");
    expect(r.munones).toBe(0);
    expect(r.resultadosEnteros).toBe(KEEP_TOOL_RESULTS + 4);
  });

  it.each([
    ["una licencia vieja con la lista corta", "pro", ["semantic_cache"]],
    ["una licencia sin ninguna feature", "team", []],
    ["el plan free", "free", []],
  ])("%s tampoco se queda con menos que sin clave en el bucle de Anthropic", async (_n, plan, features) => {
    const sinClave = await correr("anthropic-bucle", {});
    const r = await correr("anthropic-bucle", lic(plan, features));
    expect(r.cuerpo).toBe(sinClave.cuerpo);
  });

  it.each([
    ["sin clave", {}],
    ["Measure", lic("measure", [])],
    ["Pro", lic("pro", PRO_EMITIDAS)],
    ["Team", lic("team", PRO_EMITIDAS)],
  ])("el opt-out por petición `savings: { elision: false }` manda (%s): viaja todo entero", async (_n, config) => {
    for (const destino of ["gpt-4o-mini", "anthropic-bucle"] as const) {
      const r = await correr(destino, config, { savings: { elision: false } });
      expect(r.llamadas).toBe(1);
      expect(r.traza).toBeUndefined();
      expect(r.munones).toBe(0);
      expect(r.resultadosEnteros).toBe(KEEP_TOOL_RESULTS + 4);
    }
  });

  it("⛔ una licencia de pago CADUCADA sigue fallando cerrado: lanza y el proveedor no recibe nada", async () => {
    const hace = Math.floor(Date.now() / 1000) - 400 * 86_400;
    const p = proveedorFalso("gpt-4o-mini");
    const capa = createSavingsLayer({
      provider: p.provider,
      silenceWarnings: true,
      ...lic("pro", PRO_EMITIDAS, { issued_at: hace, expires_at: hace + 86_400, grace_days: 0 }),
    });
    await expect(capa.generate(peticion("gpt-4o-mini"))).rejects.toThrow(/license/i);
    expect(p.cuerpos).toHaveLength(0);
    await capa.close();
  });

  it("⛔ una clave que no verifica sigue fallando cerrado", async () => {
    const p = proveedorFalso("gpt-4o-mini");
    const capa = createSavingsLayer({
      provider: p.provider,
      silenceWarnings: true,
      licenseKey: `${signLicense(testPayload({ plan: "pro", features: PRO_EMITIDAS })).slice(0, -6)}AAAAAA`,
      licensePublicKey: TEST_KEYS.publicKey,
    });
    await expect(capa.generate(peticion("gpt-4o-mini"))).rejects.toThrow(/license/i);
    expect(p.cuerpos).toHaveLength(0);
    await capa.close();
  });
});

describe("el gate vivo · una licencia concede lo que concede no traer clave, y solo mientras vive", () => {
  const gate = (over: Record<string, unknown>, revocation = new RevocationSnapshot(), now?: () => number) =>
    liveGateFromKey(signLicense(testPayload(over)), TEST_KEYS.publicKey, { revocation, ...(now ? { now } : {}) });
  const FEATURES = [...PRO_EMITIDAS, "tool_result_elision"];

  it.each(["measure", "free", "pro", "team", "enterprise"])("plan %s, viva: cada feature que concede el gate comunitario", (plan) => {
    const g = gate({ plan, features: [] });
    const comunidad = communityGate();
    for (const f of FEATURES) expect(g.isEntitled(f)).toBe(comunidad.isEntitled(f));
    expect(g.plan?.()).toBe(plan);
  });

  it("caducada (pasada la gracia): nada, con o sin la feature firmada", () => {
    const hace = Math.floor(Date.now() / 1000) - 400 * 86_400;
    const g = gate({ plan: "pro", features: FEATURES, issued_at: hace, expires_at: hace + 86_400, grace_days: 0 });
    expect(g.isActive()).toBe(false);
    for (const f of FEATURES) expect(g.isEntitled(f)).toBe(false);
  });

  it("en gracia: sigue concediendo (como hasta ahora)", () => {
    const ahora = Math.floor(Date.now() / 1000);
    const g = gate({ plan: "pro", features: [], issued_at: ahora - 40 * 86_400, expires_at: ahora - 86_400, grace_days: 14 });
    expect(g.status()).toBe("grace");
    expect(g.isEntitled("tool_result_elision")).toBe(true);
  });

  it("revocada en caliente: deja de conceder sin reiniciar", () => {
    const revocation = new RevocationSnapshot();
    const g = gate({ plan: "team", features: [], jti: "lic-revocable" }, revocation);
    expect(g.isEntitled("tool_result_elision")).toBe(true);
    revocation.apply({ seq: 1, asOf: Math.floor(Date.now() / 1000), revoked: ["lic-revocable"] });
    expect(g.isActive()).toBe(false);
    expect(g.isEntitled("tool_result_elision")).toBe(false);
    expect(g.isEntitled("semantic_cache")).toBe(false);
  });

  it("no verifica: nada", () => {
    const g = liveGateFromKey(`${signLicense(testPayload({ plan: "pro", features: FEATURES })).slice(0, -6)}AAAAAA`, TEST_KEYS.publicKey, {
      revocation: new RevocationSnapshot(),
    });
    expect(g.status()).toBe("invalid");
    for (const f of FEATURES) expect(g.isEntitled(f)).toBe(false);
  });
});
