import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { createMockProvider } from "../src/providers/mock.js";
import { InMemorySemanticCache } from "../src/cache/semantic.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { Provider, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * PEDIR UNA PALANCA Y NO RECIBIR NADA, SIN UNA SOLA SEÑAL.
 *
 * Medido contra el paquete publicado con 51.956 tokens de contexto redundante y
 * `savings: { compression: "auto" }`: los 16 modelos devolvieron
 * `compression: null` y `eliminatedInput: 0`. Lo mismo con una pregunta
 * reformulada y `semanticCache: true`: `cache: "miss"` 16 de 16.
 *
 * La causa —que ni el compresor ni la caché semántica tengan valor por defecto—
 * es una decisión deliberada y CORRECTA: los dos son gasto y proveedor del
 * cliente. Lo que no puede ser es que la petición se ignore en silencio, porque
 * `compression: null` es indistinguible de "corrió y no había nada que quitar",
 * y el fragmento de instalación del README no configura ninguna de las dos.
 */

class ProveedorTonto implements Provider {
  readonly id = "tonto";
  async generate(): Promise<ProviderResponse> {
    return { text: "ok", usage: { inputTokens: 100, outputTokens: 10 } };
  }
}

const compresorInerte = {
  async compress({ text }: { text: string }) {
    return {
      compressed: text,
      skipped: true,
      fidelityPassed: true,
      originalTokens: text.length,
      compressedTokens: text.length,
      protectedSpans: 0,
      reason: "no se toca nada: aqui solo importa que el compresor EXISTA",
    };
  },
};

/** Contexto largo de verdad, para que "el contexto era grande" sea un hecho del test. */
const CONTEXTO_LARGO = "dato redundante que se repite sin aportar nada nuevo. ".repeat(2_000);

const peticion = (savings?: SavingsRequest["savings"]): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: [
    { role: "user", content: CONTEXTO_LARGO },
    { role: "user", content: "resume lo anterior" },
  ],
  ...(savings ? { savings } : {}),
});

const capa = (extra: Record<string, unknown> = {}) =>
  createSavingsLayer({
    provider: new ProveedorTonto(),
    costModels: { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } },
    ...extra,
  });

let avisos: string[];
beforeEach(() => {
  // `avisarUnaVez` recuerda por proceso, y vitest comparte proceso entre tests:
  // sin este reinicio el segundo test que espera un aviso lo daría por no emitido.
  reiniciarAvisos();
  avisos = [];
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    avisos.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const sobreCompresion = () => avisos.filter((a) => a.includes("savings.compression"));
const sobreCacheSemantica = () => avisos.filter((a) => a.includes("savings.semanticCache"));

describe("pedir compresión sin compresor AVISA", () => {
  it('`compression: "auto"` sin compresor dice qué no pasa, qué se pierde y cómo encenderlo', async () => {
    await capa().generate(peticion({ compression: "auto" }));

    const aviso = sobreCompresion();
    expect(aviso).toHaveLength(1);
    // El aviso vale por lo que le AHORRA al cliente en depuración: si no dice el
    // síntoma que ya está viendo, seguirá creyendo que el compresor corrió.
    expect(aviso[0]).toContain("AUSENTE");
    expect(aviso[0]).toContain("`tokens.eliminatedInput` a 0");
    expect(aviso[0]).toContain("createSavingsLayer({ compressor })");
  });

  it("`compression: true` avisa igual (las dos formas piden lo mismo)", async () => {
    await capa().generate(peticion({ compression: true }));
    expect(sobreCompresion()).toHaveLength(1);
  });

  it("el informe sigue saliendo: esto añade ruido en consola, nunca una excepción", async () => {
    const res = await capa().generate(peticion({ compression: "auto" }));
    expect(res.report.compression).toBeUndefined();
    expect(res.report.tokens.eliminatedInput).toBe(0);
    expect(res.text).toBe("ok");
  });

  it("con compresor configurado NO avisa", async () => {
    await capa({ compressor: compresorInerte }).generate(peticion({ compression: "auto" }));
    expect(sobreCompresion()).toEqual([]);
  });

  /**
   * LA DECISIÓN, CONVERTIDA EN VERJA. El aviso salta solo con petición explícita.
   * Un aviso disparado por "el contexto es grande" le hablaría de una palanca a
   * quien no la pidió —puede haber decidido a conciencia no pagar un compresor— y
   * a la larga se dejaría de leer, junto con los que sí importan.
   */
  it("NO avisa a quien no pidió la palanca, por muy largo que sea el contexto", async () => {
    await capa().generate(peticion());
    await capa().generate(peticion({ exactCache: false }));
    await capa().generate(peticion({ compression: false }));
    expect(avisos).toEqual([]);
  });

  it("avisa UNA vez por proceso, no en cada petición", async () => {
    const c = capa();
    await c.generate(peticion({ compression: "auto" }));
    await c.generate(peticion({ compression: "auto" }));
    await capa().generate(peticion({ compression: true }));
    expect(sobreCompresion()).toHaveLength(1);
  });
});

describe("pedir caché semántica sin caché semántica AVISA", () => {
  it("`semanticCache: true` sin caché dice qué no pasa, qué se pierde y cómo encenderlo", async () => {
    await capa().generate(peticion({ semanticCache: true }));

    const aviso = sobreCacheSemantica();
    expect(aviso).toHaveLength(1);
    expect(aviso[0]).toContain('cache: "miss"');
    expect(aviso[0]).toContain("createSavingsLayer({ semanticCache:");
  });

  it('`semanticCache: "safe-only"` avisa igual', async () => {
    await capa().generate(peticion({ semanticCache: "safe-only" }));
    expect(sobreCacheSemantica()).toHaveLength(1);
  });

  it("con caché semántica configurada NO avisa", async () => {
    const semanticCache = new InMemorySemanticCache({ embed: () => [1, 0, 0] });
    await capa({ semanticCache }).generate(peticion({ semanticCache: true }));
    expect(sobreCacheSemantica()).toEqual([]);
  });
});

describe("el interruptor de avisos", () => {
  it("`silenceWarnings: true` calla las dos palancas", async () => {
    await capa({ silenceWarnings: true }).generate(
      peticion({ compression: "auto", semanticCache: true }),
    );
    expect(avisos).toEqual([]);
  });

  it("sin el interruptor, dos palancas pedidas dan dos avisos distintos", async () => {
    await capa().generate(peticion({ compression: "auto", semanticCache: true }));
    expect(sobreCompresion()).toHaveLength(1);
    expect(sobreCacheSemantica()).toHaveLength(1);
  });
});

/**
 * UN SOLO INTERRUPTOR PARA TODA LA CAPA.
 *
 * El sondeo de revocaciones y el emisor de uso ya tenían su `silenceWarnings`,
 * pero era inalcanzable desde la configuración pública: los construye
 * `createSavingsLayer` y nadie le pasaba el suyo. Sin estas dos verjas,
 * `silenceWarnings: true` callaría el pipeline y dejaría hablando a los otros
 * dos, que es la peor versión de un interruptor: la que hay que descubrir
 * probando.
 */
describe("`silenceWarnings` llega también al poller y al emisor", () => {
  const CLAVE_DE_PRUEBA =
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAWBiklf0kmDIVmM7nMiCxwiEAkwQIiqWGuRiRDJonsFY=\n-----END PUBLIC KEY-----";

  /** Una capa con sondeo de revocaciones contra un plano de control caído. */
  async function conElPollerCaido(silenceWarnings?: boolean) {
    vi.useFakeTimers();
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "ok" }),
      // El token no verifica a propósito: aquí solo importa que se construya el
      // poller, y montar un par de claves no probaría nada más.
      licenseKey: "no.es.un.token",
      licensePublicKey: CLAVE_DE_PRUEBA,
      licenseServerUrl: "https://cp.example",
      licenseFetch: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      ...(silenceWarnings != null ? { silenceWarnings } : {}),
    });
    // El aviso llega al tercer fallo seguido, no al primero.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    layer.close();
  }

  /** Una capa que reporta uso a una URL que contesta 404. */
  async function conElEnvioDeUsoRoto(silenceWarnings?: boolean) {
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "ok" }),
      serviceAccountKey: "bvk_de_prueba",
      meteringUrl: "https://cp.example/api/metering/usage",
      meteringFetch: (async () => ({ ok: false, status: 404 }) as Response) as unknown as typeof fetch,
      // Un registro por lote: así cada petición fuerza su envío y no hace falta
      // esperar al temporizador.
      metering: { maxBatch: 1, seatId: "seat" },
      ...(silenceWarnings != null ? { silenceWarnings } : {}),
    });
    for (let i = 0; i < 4; i++) {
      await layer.generate({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: `pregunta ${i}` }],
      });
      await new Promise((r) => setTimeout(r, 0));
    }
    layer.close();
  }

  it("el sondeo de revocaciones habla por defecto y calla con el interruptor", async () => {
    await conElPollerCaido();
    expect(avisos.filter((a) => a.includes("revocaciones"))).toHaveLength(1);

    avisos = [];
    reiniciarAvisos();
    await conElPollerCaido(true);
    expect(avisos).toEqual([]);
  });

  it("el envío de uso habla por defecto y calla con el interruptor", async () => {
    await conElEnvioDeUsoRoto();
    expect(avisos.filter((a) => a.includes("el envío de uso"))).toHaveLength(1);

    avisos = [];
    reiniciarAvisos();
    await conElEnvioDeUsoRoto(true);
    expect(avisos).toEqual([]);
  });
});
