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
 * LA SOMBRA OPCIONAL (`observeOnly: true`) Y LA LICENCIA MEDIR, DE PUNTA A PUNTA Y SIN RED.
 *
 * POR QUÉ CAMBIÓ ESTE FICHERO (1.2.4). Hasta la 1.2.3 fijaba, a propósito, lo
 * contrario: que una licencia Medir (plan `measure`) corría la capa en sombra
 * —ni una palanca, tres peticiones idénticas = tres llamadas— y que enviar un
 * lote lanzaba `LicenseError` con status «measure». Era el diseño del modelo
 * CERRADO anterior a la 1.0.0 (#417): sin licencia no había capa, y Medir era la
 * forma de probar sin regalar las palancas. Desde el open core (#523) las
 * palancas son gratis sin clave, así que aquel diseño dejaba la clave gratuita
 * de la nube PEOR que no poner ninguna. Decisión del dueño (21-11-2026): Medir
 * ahorra de verdad, igual que sin clave, y la sombra pasa a ser una opción
 * explícita en cualquier plan.
 *
 * Lo que este fichero fija ahora:
 *   1. la sombra OPCIONAL conserva, intacta, la promesa que antes daba Medir:
 *      con `observeOnly: true` la capa NO CAMBIA NI UN BYTE de lo que envía al
 *      proveedor, NO SIRVE NADA DE CACHÉ e INFORMA lo que habría ahorrado
 *      (`report.measure`, basis "shadow"), que viaja a la ingesta como registro
 *      sombra, nunca como medido — sin clave, con Medir y con una de pago;
 *   2. la licencia Medir SIN esa opción aplica las palancas (el detalle, contado
 *      por un proveedor falso, está en medir-ahorra-de-verdad.test.ts);
 *   3. el token que emite el servidor no cambia, y un cliente viejo lo sigue
 *      leyendo como siempre.
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
  // Todas las palancas pedidas: en modo solo-observar ninguna puede tocar nada.
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

/** Una capa con licencia Medir Y la sombra opcional encendida: lo que hasta la 1.2.3 hacía Medir sola. */
function capaQueObserva(provider: Provider, extra: Record<string, unknown> = {}) {
  return createSavingsLayer({
    provider,
    licenseKey: licenciaMedir(),
    licensePublicKey: TEST_KEYS.publicKey,
    observeOnly: true,
    silenceWarnings: true,
    ...extra,
  });
}

beforeEach(() => reiniciarAvisos());

describe("sombra opcional (observeOnly) · ni un byte distinto, nada de caché", () => {
  it("OpenAI: el cuerpo HTTP de cada llamada es IDÉNTICO al del adaptador sin capa, y tres peticiones iguales son tres llamadas", async () => {
    const conCapa = fetchQueGuarda(respuestaOpenAI);
    const capa = capaQueObserva(new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: conCapa.fetchImpl }));
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
    const capa = capaQueObserva(new AnthropicProvider({ fetchImpl: conCapa.fetchImpl }));
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

  it.each([
    ["sin clave", {}],
    ["con licencia Medir", { licenseKey: licenciaMedir(), licensePublicKey: TEST_KEYS.publicKey }],
    ["con licencia de pago", { licenseKey: licenciaPro(), licensePublicKey: TEST_KEYS.publicKey }],
  ])("EN CUALQUIER PLAN (%s): observeOnly deja pasar byte a byte y no sirve nada de caché", async (_nombre, claves) => {
    const conCapa = fetchQueGuarda(respuestaOpenAI);
    const capa = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: conCapa.fetchImpl }),
      observeOnly: true,
      silenceWarnings: true,
      ...claves,
    });
    const r1 = await capa.generate(PETICION);
    const r2 = await capa.generate(PETICION);
    const sinCapa = fetchQueGuarda(respuestaOpenAI);
    await new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: sinCapa.fetchImpl }).generate({
      model: PETICION.model,
      messages: PETICION.messages,
      temperature: 0,
    });
    expect(conCapa.cuerpos).toHaveLength(2);
    for (const cuerpo of conCapa.cuerpos) expect(cuerpo).toBe(sinCapa.cuerpos[0]);
    expect(r1.report.measure?.mode).toBe("shadow");
    expect(r2.report.measure?.wouldHaveSaved.avoidedCall).toBe("exact-repeat");
    expect(r2.report.calls.avoidedLlm).toBe(0);
    expect(r2.report.cost.netSavingsRatio).toBe(0);
    capa.close();
  });

  it("`observeOnly: false` (o ausente) NO es sombra: la licencia Medir sirve la repetida de caché", async () => {
    for (const extra of [{}, { observeOnly: false }]) {
      const s = fetchQueGuarda(respuestaOpenAI);
      const capa = createSavingsLayer({
        provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }),
        licenseKey: licenciaMedir(),
        licensePublicKey: TEST_KEYS.publicKey,
        silenceWarnings: true,
        ...extra,
      });
      await capa.generate(PETICION);
      const r2 = await capa.generate(PETICION);
      expect(s.cuerpos).toHaveLength(1);
      expect(r2.report.cache.result).toBe("exact");
      expect(r2.report.measure).toBeUndefined();
      capa.close();
    }
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
    const capa = capaQueObserva(provider, { priceLevers: { deferrable: true, standalone: true } });
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
    const capa = capaQueObserva(provider);
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

describe("sombra opcional (observeOnly) · informa lo que habría ahorrado", () => {
  it("la primera no habría ahorrado nada; la repetición idéntica habría evitado la llamada entera, valorada con SU contador", async () => {
    const s = fetchQueGuarda(respuestaOpenAI);
    const capa = capaQueObserva(new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }));
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
    const capa = capaQueObserva(new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }));
    const sinCache = { ...PETICION, savings: { exactCache: false } };
    await capa.generate(sinCache);
    const r2 = await capa.generate(sinCache);
    expect(r2.report.measure?.wouldHaveSaved.usd).toBe(0);
    capa.close();
  });

  it("dos idénticas a la vez: las dos llaman, y la segunda informa que se habría coalescido", async () => {
    const s = fetchQueGuarda(respuestaOpenAI, 20);
    const capa = capaQueObserva(new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }));
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
    const capa = capaQueObserva(new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }), {
      serviceAccountKey: "bvk_test",
      meteringUrl: "https://control.example/api/metering/usage",
      meteringFetch,
      metering: { seatId: "seat-1", flushIntervalMs: 3_600_000 },
    });
    await capa.generate(PETICION);
    const r2 = await capa.generate(PETICION);
    await capa.close();

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

describe("sombra opcional y licencia Medir · avisos, lotes y gates", () => {
  it("observeOnly avisa UNA vez, en inglés, de que solo observa y de cómo volver a ahorrar", async () => {
    const avisos: string[] = [];
    const original = console.warn;
    console.warn = (m: unknown) => void avisos.push(String(m));
    try {
      const s = fetchQueGuarda(respuestaOpenAI);
      const capa = createSavingsLayer({
        provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }),
        licenseKey: licenciaMedir(),
        licensePublicKey: TEST_KEYS.publicKey,
        observeOnly: true,
      });
      await capa.generate(PETICION);
      await capa.generate(PETICION);
      capa.close();
    } finally {
      console.warn = original;
    }
    const delModo = avisos.filter((a) => a.includes("OBSERVE-ONLY"));
    expect(delModo).toHaveLength(1);
    expect(delModo[0]).toContain("observeOnly");
    // Ya no manda a pagar: las palancas son gratis, se encienden quitando la opción.
    expect(delModo[0]).not.toContain("upgrade");
    expect(delModo[0]).not.toContain("SHADOW mode");
  });

  it("la licencia Medir SIN observeOnly no avisa de ninguna sombra (ya no la hay)", async () => {
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
      capa.close();
    } finally {
      console.warn = original;
    }
    expect(avisos.filter((a) => /SHADOW|OBSERVE-ONLY|Measure license/.test(a))).toEqual([]);
  });

  // Antes: «enviar un lote se rechaza con LicenseError status measure». Era la
  // consecuencia de la sombra forzada. Ahora un lote con Medir corre igual que
  // sin clave, y solo lo impide `observeOnly`, con un Error que nombra la opción
  // (no es un problema de licencia).
  it("enviar un lote con licencia Medir hace lo mismo que sin clave: no hay rechazo por licencia", async () => {
    const lote = [{ customId: "a", request: { model: "openai/gpt-4o-mini", messages: [{ role: "user" as const, content: "hola" }] } }];
    const desenlace = async (claves: Record<string, unknown>) => {
      const capa = createSavingsLayer({
        provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: fetchQueGuarda(respuestaOpenAI).fetchImpl }),
        silenceWarnings: true,
        ...claves,
      });
      const r = await capa.batches.submit(lote).then(
        () => "aceptado",
        (e: unknown) => `${(e as Error).constructor.name}: ${(e as Error).message}`,
      );
      capa.close();
      return r;
    };
    const sinClave = await desenlace({});
    const conMedir = await desenlace({ licenseKey: licenciaMedir(), licensePublicKey: TEST_KEYS.publicKey });
    expect(conMedir).toBe(sinClave);
    expect(conMedir).not.toContain("LicenseError");
    expect(conMedir).not.toContain("observeOnly");
  });

  it("enviar un lote en modo solo-observar se rechaza, y el error nombra la opción (no la licencia)", async () => {
    const capa = capaQueObserva(new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: fetchQueGuarda(respuestaOpenAI).fetchImpl }));
    const err = await capa.batches
      .submit([{ customId: "a", request: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hola" }] } }])
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LicenseError);
    expect((err as Error).message).toContain("observeOnly");
    capa.close();
  });

  // Antes: un gate con plan «measure» forzaba dos llamadas hasta conmutar a pago.
  // Ahora el plan no decide nada: la repetida sale de caché desde el principio,
  // y al conmutar el plan todo sigue igual.
  it("un gate con plan «measure» ya no fuerza la sombra, y conmutar a pago no cambia nada", async () => {
    let plan = "measure";
    const gate: LicenseGate = {
      isActive: () => true,
      isEntitled: () => true,
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
    const r2 = await capa.generate(PETICION);
    expect(s.cuerpos).toHaveLength(1);
    expect(r2.report.cache.result).toBe("exact");
    plan = "pro";
    const r3 = await capa.generate(PETICION);
    expect(s.cuerpos).toHaveLength(1);
    expect(r3.report.cache.result).toBe("exact");
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

  // Antes: «la lee vigente y corre en sombra». La lectura no cambia; lo que hace con ella, sí.
  it("este SDK la lee vigente y APLICA las palancas (features: [] no las apaga)", async () => {
    const s = fetchQueGuarda(respuestaOpenAI);
    const capa = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL_OPENAI, fetchImpl: s.fetchImpl }),
      licenseKey: tokenReal(),
      licensePublicKey: TEST_KEYS.publicKey,
      silenceWarnings: true,
    });
    await capa.generate(PETICION);
    const r = await capa.generate(PETICION);
    expect(s.cuerpos).toHaveLength(1);
    expect(r.report.cache.result).toBe("exact");
    expect(r.report.measure).toBeUndefined();
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
