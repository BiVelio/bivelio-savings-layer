import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KEEP_TOOL_RESULTS, MUNON_ELISION } from "../src/pipeline/elision.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { communityGate } from "../src/license/community.js";
import { liveGateFromKey } from "../src/license/live-gate.js";
import { RevocationSnapshot } from "../src/license/revocation.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { ChatMessage, SavingsRequest } from "../src/contracts/types.js";
import { signLicense, testPayload, TEST_KEYS } from "./helpers/test-license.js";

/**
 * UNA LICENCIA DE PAGO LLEVA TODAS LAS PALANCAS DEL OPEN CORE (1.2.4).
 *
 * Regla del dueño: «solo debemos cobrar si utilizan nuestro CLOUD». Las palancas
 * son gratis para todos; la clave solo añade la nube. Hasta la 1.2.3 una
 * licencia Pro o Team tenía UNA PALANCA MENOS que no poner clave: el recorte de
 * resultados de herramientas sustituidos pedía `tool_result_elision`, que no
 * está en PRO_FEATURES ni en ningún token emitido, mientras que el gate
 * comunitario lo concede todo.
 *
 * Con un proveedor falso que guarda cada cuerpo que sale, este fichero fija:
 *   · Pro, Team y Enterprise mandan EXACTAMENTE lo mismo que sin clave (antes:
 *     el historial entero, sin recortar), con el token tal cual se emite hoy;
 *   · sin clave y con Measure no cambia nada;
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

/** Dos ficheros releídos al final: sus lecturas viejas quedan sustituidas. */
function transcripcion(): ChatMessage[] {
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
  messages.push({ role: "user", content: "resume lo que has leído" });
  return messages;
}

const peticion = (extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: transcripcion(),
  temperature: 0,
  ...extra,
});

function proveedorFalso() {
  const cuerpos: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    cuerpos.push(String(init.body));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Resumen." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 9000, completion_tokens: 12 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { cuerpos, fetchImpl };
}

const lic = (plan: string, features: string[], over: Record<string, unknown> = {}) => ({
  licenseKey: signLicense(testPayload({ plan, features, ...over })),
  licensePublicKey: TEST_KEYS.publicKey,
});

async function correr(config: Record<string, unknown>, extra: Partial<SavingsRequest> = {}) {
  const p = proveedorFalso();
  const capa = createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl: p.fetchImpl }),
    silenceWarnings: true,
    ...config,
  });
  const res = await capa.generate(peticion(extra));
  await capa.close();
  const traza = res.report.traces.find((t) => t.stage === "elision");
  const cuerpo = p.cuerpos[0] ?? "";
  return {
    llamadas: p.cuerpos.length,
    cuerpo,
    munones: cuerpo.split(MUNON_ELISION).length - 1,
    resultadosEnteros: cuerpo.split(cuerpoGordo(4000)).length - 1,
    traza: traza?.outcome,
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
  it("SIN CLAVE (no cambia): recorta las 2 lecturas sustituidas y deja el resto entero", async () => {
    const r = await correr({});
    expect(r.llamadas).toBe(1);
    expect(r.traza).toBe("applied");
    expect(r.elididos).toBe(2);
    expect(r.munones).toBe(2);
    expect(r.resultadosEnteros).toBe(KEEP_TOOL_RESULTS + 2);
  });

  it("MEASURE (no cambia desde #612): el mismo cuerpo, byte a byte, que sin clave", async () => {
    const sinClave = await correr({});
    const measure = await correr(lic("measure", []));
    expect(measure.cuerpo).toBe(sinClave.cuerpo);
    expect(measure.elididos).toBe(2);
  });

  it.each(["pro", "team", "enterprise"])(
    "%s con el token que se emite hoy (sin tool_result_elision): recorta igual que sin clave, byte a byte",
    async (plan) => {
      const sinClave = await correr({});
      const dePago = await correr(lic(plan, PRO_EMITIDAS));
      // Hasta la 1.2.3: 0 muñones y KEEP_TOOL_RESULTS + 4 resultados enteros.
      expect(dePago.traza).toBe("applied");
      expect(dePago.elididos).toBe(2);
      expect(dePago.munones).toBe(2);
      expect(dePago.resultadosEnteros).toBe(KEEP_TOOL_RESULTS + 2);
      expect(dePago.cuerpo).toBe(sinClave.cuerpo);
    },
  );

  it.each([
    ["una licencia vieja con la lista corta", "pro", ["semantic_cache"]],
    ["una licencia sin ninguna feature", "team", []],
    ["el plan free", "free", []],
  ])("%s tampoco se queda con menos que sin clave", async (_n, plan, features) => {
    const sinClave = await correr({});
    const r = await correr(lic(plan, features));
    expect(r.cuerpo).toBe(sinClave.cuerpo);
  });

  it.each([
    ["sin clave", {}],
    ["Measure", lic("measure", [])],
    ["Pro", lic("pro", PRO_EMITIDAS)],
    ["Team", lic("team", PRO_EMITIDAS)],
  ])("el opt-out por petición `savings: { elision: false }` manda (%s): viaja todo entero", async (_n, config) => {
    const r = await correr(config, { savings: { elision: false } });
    expect(r.llamadas).toBe(1);
    expect(r.traza).toBeUndefined();
    expect(r.munones).toBe(0);
    expect(r.resultadosEnteros).toBe(KEEP_TOOL_RESULTS + 4);
  });

  it("⛔ una licencia de pago CADUCADA sigue fallando cerrado: lanza y el proveedor no recibe nada", async () => {
    const hace = Math.floor(Date.now() / 1000) - 400 * 86_400;
    const p = proveedorFalso();
    const capa = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl: p.fetchImpl }),
      silenceWarnings: true,
      ...lic("pro", PRO_EMITIDAS, { issued_at: hace, expires_at: hace + 86_400, grace_days: 0 }),
    });
    await expect(capa.generate(peticion())).rejects.toThrow(/license/i);
    expect(p.cuerpos).toHaveLength(0);
    await capa.close();
  });

  it("⛔ una clave que no verifica sigue fallando cerrado", async () => {
    const p = proveedorFalso();
    const capa = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl: p.fetchImpl }),
      silenceWarnings: true,
      licenseKey: `${signLicense(testPayload({ plan: "pro", features: PRO_EMITIDAS })).slice(0, -6)}AAAAAA`,
      licensePublicKey: TEST_KEYS.publicKey,
    });
    await expect(capa.generate(peticion())).rejects.toThrow(/license/i);
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
