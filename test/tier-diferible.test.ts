import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import {
  ahorroDelTier,
  latenciaDelTier,
  veredictoDelTier,
} from "../src/economics/tier-diferido.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * EL DESCUENTO POR DIFERIR TRABAJO, Y LA CONDICIÓN QUE LO HACE PUBLICABLE.
 *
 * Un tier degradado se cobra a precio estándar EN SILENCIO: la respuesta llega
 * con exactamente la misma pinta. OpenAI lo dice con todas las letras — «the
 * response body will include the `service_tier` value based on the processing
 * mode actually used to serve the request. This response value may be different
 * from the value set in the parameter».
 *
 * Así que el eje de todo este fichero es UNO: se acredita por el tier SERVIDO,
 * nunca por el pedido. Acreditar por haber pedido publicaría un descuento que la
 * factura del cliente no trae, y eso es exactamente lo que este producto no
 * puede permitirse.
 */

/** `fetch` de mentira que captura el cuerpo enviado y devuelve lo que se le diga. */
function espia(respuesta: unknown, estado = 200) {
  const enviados: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    enviados.push(JSON.parse(String(init.body)));
    return {
      ok: estado >= 200 && estado < 300,
      status: estado,
      json: async () => respuesta,
      text: async () => JSON.stringify(respuesta),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { enviados, fetchImpl };
}

const PETICION_OPENAI: ProviderRequest = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "clasifica esta fila" }],
};

const PETICION_ANTHROPIC: ProviderRequest = {
  model: "claude-haiku-4-5",
  messages: [{ role: "user", content: "clasifica esta fila" }],
};

function respuestaOpenAI(extra: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
    ...extra,
  };
}

beforeEach(() => {
  reiniciarAvisos();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── El adaptador de OpenAI: pedir el tier, y leer el que sirvió ──────────────

describe("adaptador OpenAI: el tier diferible en el cable", () => {
  it("una petición diferible viaja con `service_tier: \"flex\"`", async () => {
    const { enviados, fetchImpl } = espia(respuestaOpenAI());
    await new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl }).generate({
      ...PETICION_OPENAI,
      deferrable: true,
    });
    expect(enviados[0]!["service_tier"]).toBe("flex");
  });

  it("sin declararlo NO se manda nada — ni siquiera `default`", async () => {
    const { enviados, fetchImpl } = espia(respuestaOpenAI());
    await new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl }).generate(
      PETICION_OPENAI,
    );
    // Mandar `default` parece inocuo y no lo es: el valor por defecto de OpenAI
    // es `auto`, o sea «lo que diga la configuración del proyecto», así que
    // fijarlo desde aquí anularía una elección que el cliente hizo en su panel.
    expect(enviados[0]!).not.toHaveProperty("service_tier");
  });

  it("compone con la caché de prefijo: las DOS palancas viajan juntas", async () => {
    const { enviados, fetchImpl } = espia(respuestaOpenAI());
    await new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl }).generate({
      ...PETICION_OPENAI,
      deferrable: true,
      promptCacheKey: "huella-del-prefijo",
    });
    // La guía de flex de OpenAI dice que los descuentos de la caché de prefijo se
    // SUMAN encima del precio de batch. Si una palanca pisara a la otra, aquí es
    // donde se vería.
    expect(enviados[0]!["service_tier"]).toBe("flex");
    expect(enviados[0]!["prompt_cache_key"]).toBe("huella-del-prefijo");
  });

  it("lee el tier SERVIDO de la raíz de la respuesta", async () => {
    const { fetchImpl } = espia(respuestaOpenAI({ service_tier: "flex" }));
    const r = await new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl }).generate({
      ...PETICION_OPENAI,
      deferrable: true,
    });
    expect(r.servedServiceTier).toBe("flex");
    expect(r.requestedServiceTier).toBe("flex");
  });

  it("un tier DEGRADADO se propaga tal cual, no se normaliza al pedido", async () => {
    const { fetchImpl } = espia(respuestaOpenAI({ service_tier: "default" }));
    const r = await new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl }).generate({
      ...PETICION_OPENAI,
      deferrable: true,
    });
    expect(r.requestedServiceTier).toBe("flex");
    expect(r.servedServiceTier).toBe("default");
  });

  it("si el proveedor no dice nada, el campo queda AUSENTE (no se inventa)", async () => {
    const { fetchImpl } = espia(respuestaOpenAI());
    const r = await new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl }).generate({
      ...PETICION_OPENAI,
      deferrable: true,
    });
    // Ausente significa «no se puede saber», que NO es lo mismo que «estándar».
    expect(r.servedServiceTier).toBeUndefined();
  });
});

// ── El adaptador de Anthropic: no hay tier barato síncrono, y se dice ───────

describe("adaptador Anthropic: no existe un tier síncrono más barato", () => {
  const respuestaAnthropic = (usage: Record<string, unknown>) => ({
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage,
  });

  it("una petición diferible NO añade `service_tier` al cuerpo", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { enviados, fetchImpl } = espia(
      respuestaAnthropic({ input_tokens: 100, output_tokens: 20 }),
    );
    await new AnthropicProvider({ fetchImpl }).generate({
      ...PETICION_ANTHROPIC,
      deferrable: true,
    });
    // El `service_tier` de esta API elige entre capacidad PRIORITARIA (más cara)
    // y estándar. Mandarlo porque el llamante declaró la petición diferible no
    // abarataría nada, y `standard_only` podría anularle a un cliente con tier
    // prioritario contratado una latencia que está pagando.
    expect(enviados[0]!).not.toHaveProperty("service_tier");
  });

  it("avisa una vez de que aquí el descuento no existe", async () => {
    const avisos: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      avisos.push(a.map(String).join(" "));
    });
    const { fetchImpl } = espia(respuestaAnthropic({ input_tokens: 100, output_tokens: 20 }));
    await new AnthropicProvider({ fetchImpl }).generate({
      ...PETICION_ANTHROPIC,
      deferrable: true,
    });
    expect(avisos.filter((a) => a.includes("Message Batches"))).toHaveLength(1);
  });

  it("lee `usage.service_tier`, que es donde viaja aquí", async () => {
    const { fetchImpl } = espia(
      respuestaAnthropic({ input_tokens: 100, output_tokens: 20, service_tier: "standard" }),
    );
    const r = await new AnthropicProvider({ fetchImpl }).generate(PETICION_ANTHROPIC);
    // No es decorativo: es lo que permite al informe DEMOSTRAR que no hubo
    // descuento en vez de suponerlo.
    expect(r.servedServiceTier).toBe("standard");
    expect(r.requestedServiceTier).toBeUndefined();
  });
});

// ── La aritmética: qué vale cada tier, y qué NO vale ────────────────────────

describe("el precio de un tier servido", () => {
  it("`flex` y `batch` facturan a la mitad; el resto, entero", () => {
    expect(veredictoDelTier("flex")).toEqual({ servido: "flex", factor: 0.5, conDescuento: true });
    expect(veredictoDelTier("batch")).toEqual({ servido: "batch", factor: 0.5, conDescuento: true });
    for (const t of ["default", "auto", "priority", "fast", "scale", "standard"]) {
      expect(veredictoDelTier(t)!.conDescuento, `${t} no puede llevar descuento`).toBe(false);
    }
  });

  it("un tier DESCONOCIDO no acredita nada, y se dice cuál era", () => {
    const v = veredictoDelTier("tier-que-openai-invente-manana");
    expect(v).toEqual({
      servido: "tier-que-openai-invente-manana",
      factor: null,
      conDescuento: false,
    });
    expect(ahorroDelTier(v, 10)).toBeNull();
  });

  it("sin tier reportado no hay veredicto: ausente NO es «estándar»", () => {
    expect(veredictoDelTier(undefined)).toBeNull();
    expect(veredictoDelTier("")).toBeNull();
    expect(ahorroDelTier(null, 10)).toBeNull();
  });

  it("el ahorro es `coste · (1 − factor)`, y solo con descuento", () => {
    expect(ahorroDelTier(veredictoDelTier("flex"), 8)).toBeCloseTo(4, 12);
    expect(ahorroDelTier(veredictoDelTier("default"), 8)).toBeNull();
  });

  it("la latencia se CITA, no se estima", () => {
    // OpenAI no publica una latencia comprometida para flex. Lo que sí publica es
    // la forma del fallo, y eso es lo que se repite. Un «diez veces más lento»
    // inventado aquí sería justo la cifra que este producto no puede escribir.
    expect(latenciaDelTier("flex")).toMatch(/no latency commitment/i);
    expect(latenciaDelTier("flex")).toMatch(/429/);
    expect(latenciaDelTier(undefined)).toMatch(/no cheaper synchronous/i);
  });
});

// ── El informe: la verja de honestidad, al nivel al que se lee ──────────────

class ProveedorConTier implements Provider {
  readonly id = "con-tier";
  vistas: ProviderRequest[] = [];
  /**
   * `pedidoQueDeclara` en `null` imita a un adaptador que NO pide tier (el de
   * Anthropic). Se distingue de omitirlo a propósito: con un valor por defecto,
   * pasar `undefined` volvería a caer en "flex" y el test sería un falso verde.
   */
  constructor(
    private readonly servido: string | undefined,
    private readonly pedidoQueDeclara: string | null = "flex",
  ) {}
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.vistas.push(req);
    return {
      text: "ok",
      usage: { inputTokens: 1000, outputTokens: 200 },
      ...(this.servido ? { servedServiceTier: this.servido } : {}),
      ...(req.deferrable === true && this.pedidoQueDeclara
        ? { requestedServiceTier: this.pedidoQueDeclara }
        : {}),
    };
  }
}

const PRECIO = { inputPer1k: 0.002, outputPer1k: 0.008 };

const capa = (provider: Provider) =>
  createSavingsLayer({
    provider,
    costModels: { "openai/gpt-4o-mini": PRECIO },
  });

const peticion = (deferrable?: boolean): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "clasifica esta fila del backfill" }],
  ...(deferrable === undefined ? {} : { savings: { deferrable } }),
});

describe("el informe del tier diferible", () => {
  it("SE ACREDITA cuando el proveedor dice haber servido el tier con descuento", async () => {
    const p = new ProveedorConTier("flex");
    const { report } = await capa(p).generate(peticion(true));

    expect(p.vistas[0]!.deferrable).toBe(true);
    expect(report.deferred).toBeDefined();
    expect(report.deferred!.credited).toBe(true);
    expect(report.deferred!.requestedTier).toBe("flex");
    expect(report.deferred!.servedTier).toBe("flex");
    expect(report.deferred!.discountRate).toBe(0.5);
    // 1000 tokens de entrada a 0,002/1k + 200 de salida a 0,008/1k = 0,0036.
    // La mitad de eso es lo que el tier valió.
    expect(report.deferred!.estimatedTierSaving).toBeCloseTo(0.0018, 10);
  });

  it("⛔ NO SE ACREDITA un tier DEGRADADO, aunque se haya pedido", async () => {
    // ESTE ES EL TEST QUE JUSTIFICA LA PALANCA ENTERA. El proveedor recibió
    // `flex` y contestó `default`: se cobra entero, en silencio. Acreditar aquí
    // publicaría un ahorro que la factura no trae.
    const p = new ProveedorConTier("default");
    const { report } = await capa(p).generate(peticion(true));

    expect(p.vistas[0]!.deferrable).toBe(true);
    expect(report.deferred!.requestedTier).toBe("flex");
    expect(report.deferred!.servedTier).toBe("default");
    expect(report.deferred!.credited).toBe(false);
    expect(report.deferred!.discountRate).toBeUndefined();
    expect(report.deferred!.estimatedTierSaving).toBeUndefined();
    expect(report.deferred!.reason).toMatch(/standard rate/);
  });

  it("⛔ NO SE ACREDITA cuando el proveedor no reporta ningún tier", async () => {
    const p = new ProveedorConTier(undefined);
    const { report } = await capa(p).generate(peticion(true));
    expect(report.deferred!.credited).toBe(false);
    expect(report.deferred!.servedTier).toBeUndefined();
    expect(report.deferred!.reason).toMatch(/cannot be known/);
  });

  it("⛔ NO SE ACREDITA un tier que esta capa no sabe tarifar", async () => {
    const p = new ProveedorConTier("un-tier-nuevo");
    const { report } = await capa(p).generate(peticion(true));
    expect(report.deferred!.credited).toBe(false);
    expect(report.deferred!.servedTier).toBe("un-tier-nuevo");
    expect(report.deferred!.reason).toMatch(/no published rate/);
  });

  it("un proveedor SIN tier barato lo dice, y no acredita", async () => {
    // El adaptador no pidió nada (Anthropic), así que no hay descuento posible.
    const p = new ProveedorConTier("standard", null);
    const { report } = await capa(p).generate(peticion(true));
    expect(report.deferred!.requestedTier).toBeUndefined();
    expect(report.deferred!.credited).toBe(false);
    expect(report.deferred!.reason).toMatch(/no cheaper synchronous/);
    expect(report.deferred!.latency).toMatch(/unchanged/);
  });

  it("sin declararlo, el bloque NO existe y la petición sale sin marca", async () => {
    const p = new ProveedorConTier("flex");
    const { report } = await capa(p).generate(peticion());
    expect(p.vistas[0]!.deferrable).toBeUndefined();
    expect(report.deferred).toBeUndefined();
  });

  it("la LATENCIA está en el informe, y avisa de que no es para un usuario", async () => {
    // Un cliente no puede descubrir por su monitorización que sus peticiones
    // tardan más.
    const { report } = await capa(new ProveedorConTier("flex")).generate(peticion(true));
    expect(report.deferred!.latency).toMatch(/slower and variable/i);
    expect(report.deferred!.latency).toMatch(/user-facing/i);
  });
});

// ── La contabilidad: cambia el PRECIO de los tokens, no los libros ──────────

describe("contabilidad: diferir no toca ninguno de los cuatro libros", () => {
  it("`creditedLedger` es \"none\" y los cuatro libros salen intactos", async () => {
    const { report } = await capa(new ProveedorConTier("flex")).generate(peticion(true));
    expect(report.deferred!.creditedLedger).toBe("none");
    // Diferir no evita una llamada (libro 1), no quita tokens (2), no reescribe
    // nada (3) y no es caché del proveedor (4). Cambia el PRECIO, igual que la
    // cascada, y para eso no hay libro.
    expect(report.calls.avoidedLlm).toBe(0);
    expect(report.tokens.eliminatedInput).toBe(0);
    expect(report.tokens.compressedInput).toBe(0);
    expect(report.tokens.providerCachedInput).toBeUndefined();
  });

  it("⛔ `netSavings` y `cost.actual` son IDÉNTICOS con y sin la palanca", async () => {
    // La verja de verdad. `netSavings` es una comparación a UN SOLO precio, así
    // que un descuento que escala los dos lados no puede moverla; y `cost.actual`
    // se sigue tarifando con el catálogo estándar, o sea que el sesgo va en la
    // dirección segura: la factura del cliente saldrá MENOR de lo publicado,
    // nunca mayor. Si un día alguien suma `estimatedTierSaving` a `netSavings`,
    // este test se pone rojo.
    const sin = await capa(new ProveedorConTier("flex")).generate(peticion());
    const con = await capa(new ProveedorConTier("flex")).generate(peticion(true));

    expect(con.report.cost.actual).toBe(sin.report.cost.actual);
    expect(con.report.cost.netSavings).toBe(sin.report.cost.netSavings);
    expect(con.report.cost.baselineEstimate).toBe(sin.report.cost.baselineEstimate);
    // Y el ahorro del tier sí está publicado, aparte y con su nombre.
    expect(con.report.deferred!.estimatedTierSaving).toBeGreaterThan(0);
  });
});

// ── La caché: el tier NO parte la clave ────────────────────────────────────

/**
 * Coalesce dos peticiones en una: el LÍDER siempre declara `deferrable`, el
 * seguidor declara lo que se le pase. Devuelve el informe del seguidor.
 */
async function coalescer(
  seguidorDeclara: boolean,
): Promise<{ seguidor: Awaited<ReturnType<ReturnType<typeof capa>["generate"]>>; llamadas: number }> {
  let soltar: (() => void) | undefined;
  const puerta = new Promise<void>((res) => {
    soltar = res;
  });
  let llamadas = 0;
  const lento: Provider = {
    id: "lento",
    async generate(): Promise<ProviderResponse> {
      llamadas += 1;
      await puerta;
      return {
        text: "ok",
        usage: { inputTokens: 1000, outputTokens: 200 },
        servedServiceTier: "flex",
        requestedServiceTier: "flex",
      };
    },
  };
  const capaUnica = capa(lento);
  const a = capaUnica.generate(peticion(true));
  const b = capaUnica.generate(peticion(seguidorDeclara));
  await new Promise((r) => setTimeout(r, 0));
  soltar!();
  const [ra, rb] = await Promise.all([a, b]);
  const seguidor = ra.report.cache.result === "singleflight" ? ra : rb;
  return { seguidor, llamadas };
}

describe("la clave de caché no se parte por el tier", () => {
  it("una petición diferible acierta en la caché de una que no lo era", async () => {
    // Una respuesta servida por `flex` es la MISMA respuesta: mismo modelo, mismo
    // prompt, mismo temperature y mismo seed. El tier elige la cola, no cómo se
    // genera. Y partir la caché por él iría justo contra el tráfico que esta
    // palanca sirve —enriquecimiento y backfill repiten peticiones—, cambiando el
    // libro 1 (100% de una llamada) por el 50% del tier.
    const p = new ProveedorConTier("flex");
    const capaUnica = capa(p);

    await capaUnica.generate(peticion(false));
    const segunda = await capaUnica.generate(peticion(true));

    expect(segunda.report.cache.result).toBe("exact");
    expect(p.vistas).toHaveLength(1);
  });

  it("⛔ un SEGUIDOR de singleflight no hereda el descuento del líder", async () => {
    // EL FALLO QUE ESTO CIERRA, y es el mismo que el informe ya documenta para
    // los tokens: el seguidor construía su informe con `{...leader.report}`, así
    // que un `estimatedTierSaving` de UNA llamada se republicaba N+1 veces —una
    // por seguidor— sobre peticiones que no tocaron al proveedor.
    const { seguidor, llamadas } = await coalescer(true);
    expect(llamadas).toBe(1);
    expect(seguidor.report.cache.result).toBe("singleflight");
    expect(seguidor.report.calls.actualLlm).toBe(0);
    // No llamó al proveedor: no se le sirvió ningún tier y no se le acredita nada.
    expect(seguidor.report.deferred!.credited).toBe(false);
    expect(seguidor.report.deferred!.estimatedTierSaving).toBeUndefined();
    expect(seguidor.report.deferred!.servedTier).toBeUndefined();
    expect(seguidor.report.deferred!.reason).toMatch(/no provider call was made/);
  });

  it("⛔ un seguidor que NO declaró nada no recibe el bloque del líder que SÍ", async () => {
    // LA FUGA DE VERDAD, y la que el caso de arriba no cubre. La clave de
    // singleflight no lleva el flag —a propósito, igual que la de caché—, así que
    // un seguidor que nunca pidió diferir puede coalescerse con un líder que sí.
    // Heredando el informe del líder, ese seguidor recibía un bloque `deferred`
    // acreditado sobre una palanca que él no encendió y una llamada que no hizo.
    const { seguidor, llamadas } = await coalescer(false);
    expect(llamadas).toBe(1);
    expect(seguidor.report.cache.result).toBe("singleflight");
    expect(seguidor.report.deferred).toBeUndefined();
    expect("deferred" in seguidor.report).toBe(false);
  });

  it("en un acierto de caché el bloque se publica igual, diciendo que no hubo llamada", async () => {
    // Sin esta rama la palanca desaparecería del informe justo en las peticiones
    // donde MÁS ahorró, y un panel que condiciona por su presencia habría dado
    // por apagada una palanca que el cliente sí encendió.
    const capaUnica = capa(new ProveedorConTier("flex"));
    await capaUnica.generate(peticion(true));
    const segunda = await capaUnica.generate(peticion(true));

    expect(segunda.report.cache.result).toBe("exact");
    expect(segunda.report.deferred).toBeDefined();
    expect(segunda.report.deferred!.credited).toBe(false);
    expect(segunda.report.deferred!.reason).toMatch(/no provider call was made/);
  });
});
