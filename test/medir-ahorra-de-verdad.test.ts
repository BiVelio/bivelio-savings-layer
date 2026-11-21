import { beforeEach, describe, expect, it } from "vitest";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { SavingsRequest } from "../src/contracts/types.js";
import { signLicense, testPayload, TEST_KEYS } from "./helpers/test-license.js";

/**
 * EL PLAN GRATIS «MEASURE» AHORRA DE VERDAD (1.2.4) — antes y después, con un
 * proveedor falso que CUENTA llamadas y tokens.
 *
 * Hasta la 1.2.3 una licencia Measure corría la capa en sombra: la misma carga
 * que sin clave cuesta 2 llamadas al proveedor aquí, con Measure costaba 6 (y
 * 5 frente a 21 en la carga de la investigación del 21-11-2026). Poner la clave
 * gratuita de la nube era PEOR que no poner ninguna: un resto del modelo cerrado
 * anterior a la 1.0.0 (#417), que el open core (#523) no actualizó.
 *
 * Este fichero fija lo que cambia Y LO QUE NO:
 *   · Measure hace EXACTAMENTE lo mismo que una capa sin clave: mismas llamadas,
 *     mismos cuerpos byte a byte, mismos tokens, mismo ahorro informado;
 *   · sin clave, Pro, Team y Enterprise siguen como estaban: sus cifras están
 *     clavadas con los números medidos ANTES del cambio (origin/main 7214e616).
 */

const OFICIAL_OPENAI = "https://api.openai.com/v1";
const SISTEMA = "Eres un clasificador de incidencias. ".repeat(120);
const PRO = [
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

const repetida = (pregunta: string, model = "openai/gpt-4o-mini"): SavingsRequest => ({
  model,
  messages: [
    { role: "system", content: SISTEMA },
    { role: "user", content: pregunta },
  ],
  temperature: 0,
});

/** El proveedor falso: guarda cada cuerpo que sale y cuenta los tokens que «factura». */
function proveedorFalso(dialecto: "openai" | "anthropic", retrasoMs = 5) {
  const cuerpos: string[] = [];
  let tokens = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    cuerpos.push(String(init.body));
    await new Promise((r) => setTimeout(r, retrasoMs));
    tokens += 3040;
    const cuerpo =
      dialecto === "openai"
        ? { choices: [{ message: { content: "No, es rutinaria." }, finish_reason: "stop" }], usage: { prompt_tokens: 3000, completion_tokens: 40 } }
        : {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [{ type: "text", text: "No, es rutinaria." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 3000, output_tokens: 40 },
          };
    return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { cuerpos, fetchImpl, tokens: () => tokens };
}

type Caso = { nombre: string; config: Record<string, unknown> };
const lic = (plan: string, features: string[]) => ({
  licenseKey: signLicense(testPayload({ plan, features })),
  licensePublicKey: TEST_KEYS.publicKey,
});
const SIN_CLAVE: Caso = { nombre: "sin clave (open core)", config: {} };
const MEASURE: Caso = { nombre: "licencia Measure (features: [])", config: lic("measure", []) };
const DE_PAGO: Caso[] = [
  { nombre: "Pro", config: lic("pro", PRO) },
  { nombre: "Team", config: lic("team", PRO) },
  { nombre: "Enterprise", config: lic("enterprise", PRO) },
];

/** La carga: 3 idénticas seguidas, 2 idénticas a la vez, y una cuenta aritmética. */
async function cargaOpenAI(caso: Caso) {
  const p = proveedorFalso("openai");
  const capa = createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: p.fetchImpl }),
    silenceWarnings: true,
    ...caso.config,
  });
  const r1 = await capa.generate(repetida("¿Es urgente la incidencia 42?"));
  const r2 = await capa.generate(repetida("¿Es urgente la incidencia 42?"));
  const r3 = await capa.generate(repetida("¿Es urgente la incidencia 42?"));
  const tras3 = p.cuerpos.length;
  const [a, b] = await Promise.all([
    capa.generate(repetida("¿Es urgente la incidencia 77?")),
    capa.generate(repetida("¿Es urgente la incidencia 77?")),
  ]);
  const tras5 = p.cuerpos.length;
  const arit = await capa.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "What is 2 + 2 * 3?" }] });
  await capa.close();
  return {
    llamadas: p.cuerpos.length,
    enLasTresIdenticas: tras3,
    enLasDosALaVez: tras5 - tras3,
    enLaAritmetica: p.cuerpos.length - tras5,
    tokensFacturados: p.tokens(),
    cuerpos: p.cuerpos,
    cache: [r1, r2, r3].map((r) => r.report.cache.result),
    evitadas: [r1, r2, r3, a, b, arit].reduce((s, r) => s + r.report.calls.avoidedLlm, 0),
    ahorroDeLaTercera: r3.report.cost.netSavingsRatio,
    conBloqueMeasure: [r1, r2, r3, a, b, arit].some((r) => r.report.measure !== undefined),
  };
}

async function cargaAnthropic(caso: Caso) {
  const p = proveedorFalso("anthropic");
  const capa = createSavingsLayer({
    provider: new AnthropicProvider({ fetchImpl: p.fetchImpl }),
    silenceWarnings: true,
    ...caso.config,
  });
  await capa.generate(repetida("¿Es urgente la incidencia 42?", "anthropic/claude-sonnet-4-5"));
  await capa.generate(repetida("¿Es urgente la incidencia 43?", "anthropic/claude-sonnet-4-5"));
  await capa.generate(repetida("¿Es urgente la incidencia 42?", "anthropic/claude-sonnet-4-5"));
  await capa.close();
  return { llamadas: p.cuerpos.length, cuerpos: p.cuerpos, tokensFacturados: p.tokens() };
}

beforeEach(() => reiniciarAvisos());

describe("Measure ahorra de verdad · la misma carga, contada por el proveedor falso", () => {
  it("SIN CLAVE no cambia: 2 llamadas para 6 peticiones (cifras de antes del cambio)", async () => {
    const r = await cargaOpenAI(SIN_CLAVE);
    expect(r.enLasTresIdenticas).toBe(1);
    expect(r.enLasDosALaVez).toBe(1);
    expect(r.enLaAritmetica).toBe(ARITMETICA_SIN_CLAVE);
    expect(r.llamadas).toBe(2 + ARITMETICA_SIN_CLAVE);
    expect(r.cache).toEqual(["miss", "exact", "exact"]);
    expect(r.ahorroDeLaTercera).toBe(1);
    expect(r.conBloqueMeasure).toBe(false);
  });

  it("MEASURE hace lo mismo que sin clave: mismas llamadas, mismos cuerpos byte a byte, mismos tokens, mismo ahorro", async () => {
    const sinClave = await cargaOpenAI(SIN_CLAVE);
    const measure = await cargaOpenAI(MEASURE);
    // Antes de la 1.2.4: measure.llamadas === 6 (3 + 2 + 1) y 18 240 tokens facturados, frente a 2 y 6 080.
    expect(measure.llamadas).toBe(sinClave.llamadas);
    expect(measure.enLasTresIdenticas).toBe(1);
    expect(measure.enLasDosALaVez).toBe(1);
    expect(measure.enLaAritmetica).toBe(sinClave.enLaAritmetica);
    expect(measure.cuerpos).toEqual(sinClave.cuerpos);
    expect(measure.tokensFacturados).toBe(sinClave.tokensFacturados);
    expect(measure.cache).toEqual(sinClave.cache);
    expect(measure.evitadas).toBe(sinClave.evitadas);
    expect(measure.ahorroDeLaTercera).toBe(1);
    // Sin `observeOnly` no hay sombra: el bloque hipotético no aparece.
    expect(measure.conBloqueMeasure).toBe(false);
  });

  it("MEASURE en Anthropic: las marcas de caché de prefijo y la caché exacta, igual que sin clave", async () => {
    const sinClave = await cargaAnthropic(SIN_CLAVE);
    const measure = await cargaAnthropic(MEASURE);
    expect(measure.llamadas).toBe(sinClave.llamadas);
    // Antes de la 1.2.4: 3 llamadas (la repetida también se pagaba) y sin marcas de caché.
    expect(measure.llamadas).toBe(2);
    expect(measure.cuerpos).toEqual(sinClave.cuerpos);
    expect(measure.tokensFacturados).toBe(sinClave.tokensFacturados);
  });

  it("una licencia Measure que TRAJERA features de pago en el token tampoco cambia nada respecto a sin clave", async () => {
    const sinClave = await cargaOpenAI(SIN_CLAVE);
    const conFeatures = await cargaOpenAI({ nombre: "measure+features", config: lic("measure", PRO) });
    expect(conFeatures.cuerpos).toEqual(sinClave.cuerpos);
    expect(conFeatures.llamadas).toBe(sinClave.llamadas);
  });

  it.each(DE_PAGO)("$nombre no cambia: las cifras de antes del cambio", async (caso) => {
    const r = await cargaOpenAI(caso);
    expect(r.enLasTresIdenticas).toBe(1);
    expect(r.enLasDosALaVez).toBe(1);
    expect(r.enLaAritmetica).toBe(ARITMETICA_DE_PAGO);
    expect(r.tokensFacturados).toBe(3040 * (2 + ARITMETICA_DE_PAGO));
    expect(r.cache).toEqual(["miss", "exact", "exact"]);
    expect(r.conBloqueMeasure).toBe(false);
    const a = await cargaAnthropic(caso);
    expect(a.llamadas).toBe(2);
  });

  it("una licencia de pago SIN un feature sigue sin él (Measure no ha abierto las licencias de pago)", async () => {
    const { liveGateFromKey } = await import("../src/license/live-gate.js");
    const { RevocationSnapshot } = await import("../src/license/revocation.js");
    const gate = (plan: string, features: string[]) =>
      liveGateFromKey(signLicense(testPayload({ plan, features })), TEST_KEYS.publicKey, { revocation: new RevocationSnapshot() });
    const pro = gate("pro", ["semantic_cache"]);
    expect(pro.isEntitled("semantic_cache")).toBe(true);
    expect(pro.isEntitled("context_elision")).toBe(false);
    const measure = gate("measure", []);
    // Como el gate comunitario: todo, mientras la licencia está viva.
    for (const f of PRO) expect(measure.isEntitled(f)).toBe(true);
    expect(measure.plan?.()).toBe("measure");
  });

  it("una licencia Measure CADUCADA no concede nada (el fail-closed de una clave presente sigue en pie)", async () => {
    const { liveGateFromKey } = await import("../src/license/live-gate.js");
    const { RevocationSnapshot } = await import("../src/license/revocation.js");
    const hace = Math.floor(Date.now() / 1000) - 400 * 86_400;
    const caducada = signLicense(
      testPayload({ plan: "measure", features: [], issued_at: hace, expires_at: hace, grace_days: 0, measure_expires_at: hace + 86_400, measure_grace_days: 0 }),
    );
    const gate = liveGateFromKey(caducada, TEST_KEYS.publicKey, { revocation: new RevocationSnapshot() });
    expect(gate.isActive()).toBe(false);
    expect(gate.isEntitled("semantic_cache")).toBe(false);
  });
});

// Medido en origin/main (7214e616) antes del cambio, con esta misma carga.
const ARITMETICA_SIN_CLAVE = 0;
const ARITMETICA_DE_PAGO = 0;
