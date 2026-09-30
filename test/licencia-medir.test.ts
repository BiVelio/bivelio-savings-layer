import { beforeEach, describe, expect, it } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { LicenseError } from "../src/license/errors.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import { parseUsageRecords } from "../packages/protocol/src/index.js";
import type { Provider, ProviderRequest, ProviderResponse, ProviderStreamEvent } from "../src/providers/types.js";
import type { LicenseGate, SavingsRequest } from "../src/contracts/types.js";
import { signLicense, testPayload, TEST_KEYS } from "./helpers/test-license.js";

/**
 * LA LICENCIA MEDIR, DE PUNTA A PUNTA Y SIN RED.
 *
 * Lo que este fichero fija es la promesa entera del plan gratuito:
 *   1. una capa con licencia Medir NO CAMBIA NI UN BYTE de lo que envía al
 *      proveedor: el cuerpo HTTP es idéntico, carácter a carácter, al que manda
 *      el mismo adaptador llamado a pelo, sin capa;
 *   2. NO SIRVE NADA DE CACHÉ: tres peticiones idénticas son tres llamadas;
 *   3. INFORMA lo que habría ahorrado (`report.measure`, basis "shadow"), y ese
 *      hipotético viaja a la ingesta como registro sombra, nunca como medido;
 *   4. con la licencia de pago, las mismas palancas SÍ actúan (el contraste que
 *      demuestra que el test de arriba mira donde tiene que mirar), y el cambio
 *      de licencia las enciende sin reiniciar.
 */

const OFICIAL_OPENAI = "https://api.openai.com/v1";
const SISTEMA = "Eres un clasificador de incidencias. ".repeat(120);

const PETICION: SavingsRequest = {
  model: "openai/gpt-4o-mini",
  messages: [
    { role: "system", content: SISTEMA },
    { role: "user", content: "¿Es urgente la incidencia 42?" },
  ],
  temperature: 0,
  // Todas las palancas pedidas: en sombra ninguna puede tocar nada.
  savings: { exactCache: true, semanticCache: true, singleflight: true, compression: true, router: true },
};

const licenciaMedir = () => signLicense(testPayload({ plan: "measure", features: [] }));
const licenciaPro = () => signLicense(testPayload({ plan: "pro", features: ["semantic_cache", "long_context_compression"] }));

/** Un `fetch` que guarda el cuerpo CRUDO (la cadena exacta que salió) de cada llamada. */
function fetchQueGuarda(respuesta: () => unknown, retrasoMs = 0) {
  const cuerpos: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    cuerpos.push(String(init.body));
    if (retrasoMs > 0) await new Promise((r) => setTimeout(r, retrasoMs));
    return new Response(JSON.stringify(respuesta()), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { cuerpos, fetchImpl };
}

const respuestaOpenAI = () => ({
  choices: [{ message: { content: "No, es rutinaria." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3000, completion_tokens: 40 },
});

const respuestaAnthropic = () => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "No, es rutinaria." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3000, output_tokens: 40 },
});

function capaMedir(provider: Provider, extra: Record<string, unknown> = {}) {
  return createSavingsLayer({
    provider,
    licenseKey: licenciaMedir(),
    licensePublicKey: TEST_KEYS.publicKey,
    silenceWarnings: true,
    ...extra,
  });
}

beforeEach(() => reiniciarAvisos());

describe("licencia Medir · ni un byte distinto, nada de caché", () => {
  it("OpenAI: el cuerpo HTTP de cada llamada es IDÉNTICO al del adaptador sin capa, y tres peticiones iguales son tres llamadas", async () => {
    const conCapa = fetchQueGuarda(respuestaOpenAI);
    const capa = capaMedir(new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: conCapa.fetchImpl }));
    const r1 = await capa.generate(PETICION);
    const r2 = await capa.generate(PETICION);
    const r3 = await capa.generate(PETICION);

    const sinCapa = fetchQueGuarda(respuestaOpenAI);
    await new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: sinCapa.fetchImpl }).generate({
      model: PETICION.model,
      messages: PETICION.messages,
      temperature: 0,
    });

    expect(conCapa.cuerpos).toHaveLength(3);
    for (const cuerpo of conCapa.cuerpos) expect(cuerpo).toBe(sinCapa.cuerpos[0]);
    for (const r of [r1, r2, r3]) {
      expect(r.report.cache.result).toBe("miss");
      expect(r.report.calls.avoidedLlm).toBe(0);
      expect(r.report.cost.netSavingsRatio).toBe(0);
      expect(r.report.cost.baselineEstimate).toBe(r.report.cost.actual);
      expect(r.report.measure?.applied).toBe(false);
      expect(r.text).toBe("No, es rutinaria.");
    }
    capa.close();
  });

  it("Anthropic: el mismo cuerpo, byte a byte, que el adaptador sin capa (sin cache_control añadido)", async () => {
    const peticion: SavingsRequest = { ...PETICION, model: "anthropic/claude-sonnet-4-5" };
    const conCapa = fetchQueGuarda(respuestaAnthropic);
    const capa = capaMedir(new AnthropicProvider({ fetchImpl: conCapa.fetchImpl }));
    await capa.generate(peticion);
    await capa.generate(peticion);

    const sinCapa = fetchQueGuarda(respuestaAnthropic);
    await new AnthropicProvider({ fetchImpl: sinCapa.fetchImpl }).generate({
      model: peticion.model,
      messages: peticion.messages,
      temperature: 0,
    });

    expect(conCapa.cuerpos).toHaveLength(2);
    for (const cuerpo of conCapa.cuerpos) {
      expect(cuerpo).toBe(sinCapa.cuerpos[0]);
      expect(cuerpo).not.toContain("cache_control");
    }
    capa.close();
  });

  it("CONTRASTE: con la licencia de pago la segunda petición idéntica SÍ sale de caché (el test de arriba mira donde debe)", async () => {
    const s = fetchQueGuarda(respuestaOpenAI);
    const capa = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }),
      licenseKey: licenciaPro(),
      licensePublicKey: TEST_KEYS.publicKey,
      silenceWarnings: true,
    });
    await capa.generate(PETICION);
    const r2 = await capa.generate(PETICION);
    expect(s.cuerpos).toHaveLength(1);
    expect(r2.report.cache.result).toBe("exact");
    expect(r2.report.measure).toBeUndefined();
    capa.close();
  });

  it("el ProviderRequest es exactamente {model, messages, temperature}: sin herramientas podadas, sin marcas, sin tier", async () => {
    const vistas: ProviderRequest[] = [];
    const provider: Provider = {
      id: "espia",
      async generate(req: ProviderRequest): Promise<ProviderResponse> {
        vistas.push(req);
        return { text: "ok", usage: { inputTokens: 100, outputTokens: 5 }, finishReason: "stop" } as ProviderResponse;
      },
    };
    const capa = capaMedir(provider, { priceLevers: { deferrable: true, standalone: true } });
    await capa.generate(PETICION);
    expect(vistas).toHaveLength(1);
    expect(vistas[0]).toEqual({ model: PETICION.model, messages: PETICION.messages, temperature: 0 });
    capa.close();
  });

  it("un stream en vivo también sale intacto por generateStream, y el texto llega según viene", async () => {
    const vistas: ProviderRequest[] = [];
    const provider: Provider = {
      id: "espia-stream",
      async generate(): Promise<ProviderResponse> {
        throw new Error("no debería usarse: la entrega es en vivo");
      },
      async *generateStream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
        vistas.push(req);
        yield { type: "text", delta: "No, " };
        yield { type: "text", delta: "es rutinaria." };
        yield {
          type: "done",
          response: { text: "No, es rutinaria.", usage: { inputTokens: 100, outputTokens: 5 }, finishReason: "stop" } as ProviderResponse,
        };
      },
    };
    const capa = capaMedir(provider);
    const stream = capa.generateStream({ ...PETICION, savings: {} });
    let texto = "";
    for await (const d of stream) texto += typeof d === "string" ? d : ((d as { delta?: string }).delta ?? "");
    const r = await stream.result;
    expect(vistas).toEqual([{ model: PETICION.model, messages: PETICION.messages, temperature: 0 }]);
    expect(r.text).toBe("No, es rutinaria.");
    expect(r.report.measure?.mode).toBe("shadow");
    capa.close();
  });
});

describe("licencia Medir · informa lo que habría ahorrado", () => {
  it("la primera no habría ahorrado nada; la repetición idéntica habría evitado la llamada entera, valorada con SU contador", async () => {
    const s = fetchQueGuarda(respuestaOpenAI);
    const capa = capaMedir(new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }));
    const r1 = await capa.generate(PETICION);
    const r2 = await capa.generate(PETICION);

    expect(r1.report.measure?.wouldHaveSaved).toEqual({ usd: 0, basis: "shadow", avoidedCall: null });
    expect(r2.report.measure?.wouldHaveSaved.avoidedCall).toBe("exact-repeat");
    expect(r2.report.cost.basis).toBe("measured");
    expect(r2.report.cost.actual).toBeGreaterThan(0);
    expect(r2.report.measure?.wouldHaveSaved.usd).toBeCloseTo(r2.report.cost.actual, 10);
    // El hipotético no se cuela en el coste medido.
    expect(r2.report.cost.netSavingsRatio).toBe(0);
    expect(r2.report.measure?.notSimulated).toContain("semantic_cache");
    expect(r2.report.measure?.upgradeUrl).toBe("https://savings.bivelio.com/dashboard/account");
    capa.close();
  });

  it("con `exactCache: false` la repetición no cuenta: el hipotético respeta lo que el cliente apagó", async () => {
    const s = fetchQueGuarda(respuestaOpenAI);
    const capa = capaMedir(new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }));
    const sinCache = { ...PETICION, savings: { exactCache: false } };
    await capa.generate(sinCache);
    const r2 = await capa.generate(sinCache);
    expect(r2.report.measure?.wouldHaveSaved.usd).toBe(0);
    capa.close();
  });

  it("dos idénticas a la vez: las dos llaman, y la segunda informa que se habría coalescido", async () => {
    const s = fetchQueGuarda(respuestaOpenAI, 20);
    const capa = capaMedir(new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }));
    const [a, b] = await Promise.all([capa.generate(PETICION), capa.generate(PETICION)]);
    expect(s.cuerpos).toHaveLength(2);
    const evitadas = [a, b].map((r) => r.report.measure?.wouldHaveSaved.avoidedCall);
    expect(evitadas).toContain("in-flight-duplicate");
    expect(evitadas).toContain(null);
    capa.close();
  });

  it("el uso medido viaja como siempre y el hipotético como registro `shadow` aparte, que la ingesta acepta", async () => {
    const s = fetchQueGuarda(respuestaOpenAI);
    const lotes: unknown[][] = [];
    const meteringFetch = (async (_url: string, init: RequestInit) => {
      lotes.push(JSON.parse(String(init.body)) as unknown[]);
      return new Response(JSON.stringify({ ingested: 1 }), { status: 202 });
    }) as unknown as typeof fetch;
    const capa = capaMedir(new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }), {
      serviceAccountKey: "bvk_test",
      meteringUrl: "https://control.example/api/metering/usage",
      meteringFetch,
      metering: { seatId: "seat-1", flushIntervalMs: 3_600_000 },
    });
    await capa.generate(PETICION);
    const r2 = await capa.generate(PETICION);
    capa.close();
    await new Promise((r) => setTimeout(r, 10));

    const registros = lotes.flat() as Record<string, unknown>[];
    const medidos = registros.filter((x) => x["basis"] === "measured");
    const sombra = registros.filter((x) => x["basis"] === "shadow");
    expect(medidos).toHaveLength(2);
    for (const m of medidos) expect(m["baselineCost"]).toBe(m["actualCost"]);
    expect(sombra).toHaveLength(1);
    expect(sombra[0]!["requestId"]).toBe(`${r2.report.requestId}:shadow`);
    expect(sombra[0]!["baselineCost"]).toBeCloseTo(r2.report.cost.actual, 10);
    expect(sombra[0]!["actualCost"]).toBe(0);
    // La lista blanca de la ingesta lo acepta tal cual.
    expect(() => parseUsageRecords(registros, "org-x")).not.toThrow();
  });
});

describe("licencia Medir · el camino a pago", () => {
  it("avisa UNA vez, en inglés, de que corre en sombra y de dónde se activan las palancas", async () => {
    const avisos: string[] = [];
    const original = console.warn;
    console.warn = (m: unknown) => void avisos.push(String(m));
    try {
      const s = fetchQueGuarda(respuestaOpenAI);
      const capa = createSavingsLayer({
        provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }),
        licenseKey: licenciaMedir(),
        licensePublicKey: TEST_KEYS.publicKey,
      });
      await capa.generate(PETICION);
      await capa.generate(PETICION);
      capa.close();
    } finally {
      console.warn = original;
    }
    const delMedir = avisos.filter((a) => a.includes("Measure license"));
    expect(delMedir).toHaveLength(1);
    expect(delMedir[0]).toContain("SHADOW");
    expect(delMedir[0]).toContain("https://savings.bivelio.com/dashboard/account");
  });

  it("enviar un lote (una palanca) se rechaza con LicenseError status «measure»", async () => {
    const capa = capaMedir(new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: fetchQueGuarda(respuestaOpenAI).fetchImpl }));
    const err = await capa.batches
      .submit([{ customId: "a", request: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hola" }] } }])
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LicenseError);
    expect((err as LicenseError).status).toBe("measure");
    capa.close();
  });

  it("al pasar a pago (el gate conmuta), la siguiente petición ya aplica palancas, sin reiniciar", async () => {
    let plan = "measure";
    const gate: LicenseGate = {
      isActive: () => true,
      isEntitled: () => plan !== "measure",
      status: () => "active",
      plan: () => plan,
    };
    const s = fetchQueGuarda(respuestaOpenAI);
    const capa = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }),
      licenseGate: gate,
      silenceWarnings: true,
    });
    await capa.generate(PETICION);
    await capa.generate(PETICION);
    expect(s.cuerpos).toHaveLength(2); // en sombra: dos llamadas
    plan = "pro";
    await capa.generate(PETICION); // de pago: escribe la caché
    const r = await capa.generate(PETICION); // y la sirve
    expect(s.cuerpos).toHaveLength(3);
    expect(r.report.cache.result).toBe("exact");
    capa.close();
  });
});

describe("licencia Medir · el token que emite el servidor", () => {
  const ahora = Math.floor(Date.now() / 1000);
  // La forma exacta de lib/license/medir.ts: «caducada» en los campos de siempre,
  // la vigencia real en los suyos.
  const tokenReal = () =>
    signLicense(
      testPayload({
        plan: "measure",
        features: [],
        seats: 5,
        issued_at: ahora,
        expires_at: ahora,
        grace_days: 0,
        measure_expires_at: ahora + 3650 * 86_400,
        measure_grace_days: 30,
      }),
    );

  it("este SDK la lee vigente y corre en sombra", async () => {
    const s = fetchQueGuarda(respuestaOpenAI);
    const capa = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }),
      licenseKey: tokenReal(),
      licensePublicKey: TEST_KEYS.publicKey,
      silenceWarnings: true,
    });
    const r = await capa.generate(PETICION);
    expect(r.report.measure?.mode).toBe("shadow");
    capa.close();
  });

  it("un verificador ANTERIOR al modo sombra (sin vigenciaEfectiva) la ve CADUCADA: falla cerrado, no regala palancas", async () => {
    const { deriveStatus } = await import("../src/license/verify.js");
    const cuerpo = JSON.parse(Buffer.from(tokenReal().split(".")[1]!, "base64url").toString("utf8")) as {
      jti: string;
      expires_at: number;
      grace_days: number;
    };
    // Lo que hace un SDK ≤ 0.4.32 con el payload crudo, un segundo después de emitirla.
    expect(deriveStatus(cuerpo, ahora + 1)).toBe("expired");
  });
});
