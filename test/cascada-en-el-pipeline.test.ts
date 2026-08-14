import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemorySemanticCache } from "../src/cache/semantic.js";
import { precioDeLista } from "../src/pricing/catalogo.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsLayerConfig } from "../src/pipeline/config.js";
import type { SavingsRequest, ToolDescriptor } from "../src/contracts/types.js";

/**
 * LA CASCADA DE MODELOS, DE PUNTA A PUNTA.
 *
 * Lo que se fija aquí no es que la palanca «funcione»: es que las cuatro cosas
 * que la harían inaceptable no puedan pasar.
 *
 *  1. Que cambie el modelo de un cliente SIN QUE SE ENTERE (por defecto, por una
 *     caché, o por un informe que siga nombrando al modelo que se pidió).
 *  2. Que el ahorro del cambio se sume a `netSavings`, que es la cifra que el
 *     cliente contrasta contra su factura, siendo un contrafactual.
 *  3. Que una escalada se publique como si hubiera salido gratis.
 *  4. Que una respuesta del modelo barato acabe sirviéndosele a quien pidió el
 *     fuerte, por la caché exacta o por la semántica.
 */

// Precios REALES del catálogo: la aritmética que se comprueba tiene que ser la
// del producto, no una de juguete. r = 0,060 → equilibrio 94,0%.
const FUERTE = "openai/gpt-4o";
const BARATO = "openai/gpt-4o-mini";
const PRECIOS = {
  [FUERTE]: precioDeLista("gpt-4o")!,
  [BARATO]: precioDeLista("gpt-4o-mini")!,
};

const CONTRATO = {
  contractId: "answer:v1",
  schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" as const, maxLength: 200 } },
  },
};

/** Proveedor que contesta distinto según el modelo, y lleva la cuenta. */
class ProveedorPorModelo implements Provider {
  readonly id = "por-modelo";
  readonly llamadas: string[] = [];
  constructor(private readonly respuestas: Record<string, Partial<ProviderResponse>>) {}
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas.push(r.model);
    const base = this.respuestas[r.model] ?? this.respuestas["*"] ?? {};
    return {
      text: base.text ?? '{"answer":"por defecto"}',
      usage: base.usage ?? { inputTokens: 1000, outputTokens: 200 },
      ...(base.finishReason !== undefined ? { finishReason: base.finishReason } : {}),
      ...(base.toolCalls !== undefined ? { toolCalls: base.toolCalls } : {}),
    };
  }
}

const capa = (provider: Provider, extra: Partial<SavingsLayerConfig> = {}) =>
  createSavingsLayer({ provider, costModels: PRECIOS, silenceWarnings: true, ...extra });

const peticion = (extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: FUERTE,
  messages: [{ role: "user", content: "resume en una frase el informe adjunto" }],
  response: CONTRATO,
  ...extra,
});

describe("`off` es el defecto y no toca absolutamente nada", () => {
  it("sin la palanca no hay bloque de informe ni cambio de modelo", () => {
    // Ni siquiera se publica el bloque: un informe que aparece siempre convertiría
    // una palanca apagada en ruido en el panel de todo el mundo.
    const p = new ProveedorPorModelo({});
    return capa(p)
      .generate(peticion())
      .then((res) => {
        expect(res.report.modelCascade).toBeUndefined();
        expect(res.report.model).toBe(FUERTE);
        expect(p.llamadas).toEqual([FUERTE]);
      });
  });
});

describe("`shadow` mide y NO decide: el corazón del encargo", () => {
  it("la petición va al modelo que pidió el llamante, y solo a ése", async () => {
    const p = new ProveedorPorModelo({});
    const res = await capa(p).generate(peticion({ savings: { modelCascade: "shadow" } }));

    expect(p.llamadas).toEqual([FUERTE]);
    expect(res.report.model).toBe(FUERTE);
    expect(res.report.modelCascade!.servedModel).toBe(FUERTE);
    expect(res.report.qualityStatus).toBe("not_verified");
  });

  it("publica la aritmética del par: r, equilibrio y Pmax, sacados del catálogo", async () => {
    const res = await capa(new ProveedorPorModelo({})).generate(
      peticion({ savings: { modelCascade: "shadow" } }),
    );
    const c = res.report.modelCascade!;

    expect(c.mode).toBe("shadow");
    expect(c.eligible).toBe(true);
    expect(c.candidateModel).toBe(BARATO);
    expect(c.costRatio).toBeCloseTo(0.06, 6);
    expect(c.breakEvenEscalationRate).toBeCloseTo(0.94, 6);
    expect(c.targetEscalationRate).toBeCloseTo(0.44, 6);
    expect(c.verifier).toBe("value-constrained");
    expect(c.workload).toMatch(/^[0-9a-f]{16,}$/);
  });

  it("dice lo que HABRÍA valido el cambio, en dinero y sin tocar `netSavings`", async () => {
    const res = await capa(new ProveedorPorModelo({})).generate(
      peticion({ savings: { modelCascade: "shadow" } }),
    );
    const c = res.report.modelCascade!;
    // Es la cifra por la que existe el modo sombra: los tokens MEDIDOS de esta
    // petición (1000 de entrada, 200 de salida, cobrados al fuerte) tarifados
    // también con el barato.
    const conFuerte = (1000 / 1000) * 0.0025 + (200 / 1000) * 0.01;
    const conBarato = (1000 / 1000) * 0.00015 + (200 / 1000) * 0.0006;
    expect(c.estimatedSwapSaving).toBeCloseTo(conFuerte - conBarato, 10);
    // Y no está en `netSavings`, que sigue midiendo lo que hicieron las otras
    // palancas: aquí, nada.
    expect(res.report.cost.netSavings).toBe(0);
    expect(c.creditedLedger).toBe("none");
  });

  it("no promete un ahorro sobre una petición que NUNCA podría enrutarse", async () => {
    // Sin contrato el cambio no está en la mesa, así que publicar su cifra sería
    // enseñar un ahorro inalcanzable en el panel.
    const res = await capa(new ProveedorPorModelo({ "*": { text: "hola" } })).generate({
      model: FUERTE,
      messages: [{ role: "user", content: "escribe un parrafo largo sobre el clima" }],
      savings: { modelCascade: "shadow" },
    });
    expect(res.report.modelCascade!.eligible).toBe(false);
    expect(res.report.modelCascade!.estimatedSwapSaving).toBeUndefined();
  });

  it("cuesta exactamente lo mismo que no tenerla puesta", async () => {
    // El modo sombra es el que permite empezar a medir HOY, y solo lo es si el
    // cliente no arriesga ni paga nada por participar.
    const sin = await capa(new ProveedorPorModelo({})).generate(peticion());
    const con = await capa(new ProveedorPorModelo({})).generate(
      peticion({ savings: { modelCascade: "shadow" } }),
    );
    expect(con.report.cost.actual).toBe(sin.report.cost.actual);
    expect(con.report.cost.netSavings).toBe(sin.report.cost.netSavings);
    expect(con.report.calls.actualLlm).toBe(sin.report.calls.actualLlm);
  });

  it("dice POR QUÉ no aplica cuando no aplica, en vez de callarse", async () => {
    // «No se enrutó esto, y por esto» es la respuesta que más veces hace falta.
    const sinContrato = await capa(new ProveedorPorModelo({ "*": { text: "hola" } })).generate({
      model: FUERTE,
      messages: [{ role: "user", content: "cuentame algo largo del mar" }],
      savings: { modelCascade: "shadow" },
    });
    expect(sinContrato.report.modelCascade!.eligible).toBe(false);
    expect(sinContrato.report.modelCascade!.reason).toMatch(/no output contract/);

    const sinPar = await capa(new ProveedorPorModelo({})).generate(
      peticion({ model: BARATO, savings: { modelCascade: "shadow" } }),
    );
    expect(sinPar.report.modelCascade!.eligible).toBe(false);
    expect(sinPar.report.modelCascade!.reason).toMatch(/no cheaper model is paired/);
  });
});

describe("`shadow` con muestreo: la única forma de medir P(escalar), y se paga", () => {
  const conMuestreo = (p: Provider) => capa(p, { modelCascade: { shadowSampleRate: 1 } });

  it("llama TAMBIÉN al barato, y lo declara con su precio", async () => {
    const p = new ProveedorPorModelo({
      [FUERTE]: { text: '{"answer":"la del fuerte"}', usage: { inputTokens: 1000, outputTokens: 200 } },
      [BARATO]: { text: '{"answer":"la del barato"}', usage: { inputTokens: 1000, outputTokens: 200 } },
    });
    const res = await conMuestreo(p).generate(peticion({ savings: { modelCascade: "shadow" } }));

    expect(p.llamadas).toEqual([FUERTE, BARATO]);
    // Lo que se sirve sigue siendo lo del fuerte: la muestra NO se sirve jamás.
    expect(res.text).toBe('{"answer":"la del fuerte"}');
    expect(res.report.model).toBe(FUERTE);
    expect(res.report.calls.actualLlm).toBe(2);
    expect(res.report.modelCascade!.sampled).toBe(true);
    // El precio exacto de medir: 1000 tokens de entrada y 200 de salida al precio
    // del barato.
    const esperado = (1000 / 1000) * 0.00015 + (200 / 1000) * 0.0006;
    expect(res.report.modelCascade!.sampleCost).toBeCloseTo(esperado, 10);
  });

  it("la muestra se suma a `actual` y NO al baseline: medir no se paga a sí mismo", async () => {
    const sin = await capa(new ProveedorPorModelo({})).generate(
      peticion({ savings: { modelCascade: "shadow" } }),
    );
    const con = await conMuestreo(new ProveedorPorModelo({})).generate(
      peticion({ savings: { modelCascade: "shadow" } }),
    );

    expect(con.report.cost.actual).toBeGreaterThan(sin.report.cost.actual);
    expect(con.report.cost.baselineEstimate).toBe(sin.report.cost.baselineEstimate);
    // Y por tanto la petición muestreada reporta MENOS ahorro, que es lo que le
    // pasó a la factura.
    expect(con.report.cost.netSavings).toBeLessThan(sin.report.cost.netSavings);
  });

  it("un fallo del proveedor en la muestra NO toca la respuesta del cliente", async () => {
    const p: Provider = {
      id: "muestra-rota",
      async generate(r: ProviderRequest): Promise<ProviderResponse> {
        if (r.model === BARATO) throw new Error("boom en la muestra");
        return { text: '{"answer":"buena"}', usage: { inputTokens: 900, outputTokens: 100 } };
      },
    };
    const res = await conMuestreo(p).generate(peticion({ savings: { modelCascade: "shadow" } }));

    expect(res.text).toBe('{"answer":"buena"}');
    expect(res.report.modelCascade!.sampled).toBeUndefined();
    expect(res.report.traces.some((t) => t.outcome.startsWith("sample failed"))).toBe(true);
  });

  it("el muestreo es DETERMINISTA: la misma petición cae siempre del mismo lado", async () => {
    // Con `Math.random` el gasto del cliente dependería de un dado y dos procesos
    // decidirían distinto sobre la misma petición.
    const tirada = async () => {
      const p = new ProveedorPorModelo({});
      await capa(p, { modelCascade: { shadowSampleRate: 0.5 } }).generate(
        peticion({ savings: { modelCascade: "shadow" }, context: { tenantId: "t9" } }),
      );
      return p.llamadas.length;
    };
    const tiradas = await Promise.all([tirada(), tirada(), tirada(), tirada(), tirada()]);
    expect(new Set(tiradas).size).toBe(1);
  });

  it("con tasa 0 (el defecto) no hay llamada extra", async () => {
    const p = new ProveedorPorModelo({});
    await capa(p).generate(peticion({ savings: { modelCascade: "shadow" } }));
    expect(p.llamadas).toEqual([FUERTE]);
  });

  it("la divergencia se publica cuando las DOS respuestas cumplen el contrato", async () => {
    const p = new ProveedorPorModelo({
      [FUERTE]: { text: '{"answer":"el total es 42"}' },
      [BARATO]: { text: '{"answer":"el total es 7"}' },
    });
    const res = await conMuestreo(p).generate(peticion({ savings: { modelCascade: "shadow" } }));
    expect(res.report.modelCascade!.divergedOnSample).toBe(true);
  });
});

describe("`on` enruta de verdad, y nunca en silencio", () => {
  it("sirve el barato cuando la verja acepta, y el informe lo DICE", async () => {
    const p = new ProveedorPorModelo({ [BARATO]: { text: '{"answer":"del barato"}' } });
    const res = await capa(p).generate(peticion({ savings: { modelCascade: "on" } }));

    expect(p.llamadas).toEqual([BARATO]);
    expect(res.text).toBe('{"answer":"del barato"}');
    // Las tres declaraciones que impiden que el cambio sea invisible.
    expect(res.report.model).toBe(BARATO);
    expect(res.report.modelCascade!.requestedModel).toBe(FUERTE);
    expect(res.report.modelCascade!.servedModel).toBe(BARATO);
  });

  it("una respuesta de un modelo más barato es `bounded_degradation`", async () => {
    const res = await capa(new ProveedorPorModelo({})).generate(
      peticion({ savings: { modelCascade: "on" } }),
    );
    expect(res.report.qualityStatus).toBe("bounded_degradation");
  });

  it("`cost.actual` se tarifa con el modelo QUE CONTESTÓ", async () => {
    // Es la única cifra del informe que se contrasta contra la factura. Con el
    // precio del fuerte sobre tokens del barato saldría 16 veces por encima.
    const res = await capa(new ProveedorPorModelo({})).generate(
      peticion({ savings: { modelCascade: "on" } }),
    );
    const esperado = (1000 / 1000) * 0.00015 + (200 / 1000) * 0.0006;
    expect(res.report.cost.actual).toBeCloseTo(esperado, 10);
  });

  it("escala cuando la verja rechaza, y la escalada se VE como pérdida", async () => {
    const p = new ProveedorPorModelo({
      [BARATO]: { text: "esto no es json", usage: { inputTokens: 1000, outputTokens: 200 } },
      [FUERTE]: { text: '{"answer":"del fuerte"}', usage: { inputTokens: 1000, outputTokens: 200 } },
    });
    const res = await capa(p).generate(peticion({ savings: { modelCascade: "on" } }));

    expect(p.llamadas).toEqual([BARATO, FUERTE]);
    expect(res.text).toBe('{"answer":"del fuerte"}');
    expect(res.report.model).toBe(FUERTE);
    expect(res.report.modelCascade!.escalated).toBe(true);
    // Y no vuelve a ser `bounded_degradation`: contestó el modelo que se pidió.
    expect(res.report.qualityStatus).toBe("not_verified");
    // La llamada descartada está pagada y contada.
    expect(res.report.calls.actualLlm).toBe(2);
    expect(res.report.modelCascade!.estimatedSwapSaving!).toBeLessThan(0);
  });

  it("una escalada cuesta MÁS que no haber enrutado, y el informe lo publica", async () => {
    const roto = { [BARATO]: { text: "no json" }, [FUERTE]: { text: '{"answer":"ok"}' } };
    const conCascada = await capa(new ProveedorPorModelo(roto)).generate(
      peticion({ savings: { modelCascade: "on" } }),
    );
    const sinCascada = await capa(new ProveedorPorModelo(roto)).generate(peticion());

    expect(conCascada.report.cost.actual).toBeGreaterThan(sinCascada.report.cost.actual);
    expect(conCascada.report.cost.netSavings).toBeLessThan(sinCascada.report.cost.netSavings);
  });

  it("⛔ sin contrato de salida NO enruta, aunque se pida `on`", async () => {
    const p = new ProveedorPorModelo({ "*": { text: "cualquier cosa" } });
    const res = await capa(p).generate({
      model: FUERTE,
      messages: [{ role: "user", content: "escribe algo largo sobre el clima" }],
      savings: { modelCascade: "on" },
    });
    expect(p.llamadas).toEqual([FUERTE]);
    expect(res.report.model).toBe(FUERTE);
    expect(res.report.modelCascade!.eligible).toBe(false);
  });

  it("⛔ con una herramienta de ESCRITURA NO enruta", async () => {
    const enviar: ToolDescriptor = { id: "enviar_factura", intents: ["enviar factura"], risk: "write" };
    const p = new ProveedorPorModelo({});
    const res = await capa(p).generate(
      peticion({ tools: [enviar], savings: { modelCascade: "on" } }),
    );
    expect(p.llamadas).toEqual([FUERTE]);
    expect(res.report.modelCascade!.reason).toMatch(/write\/destructive/);
  });
});

describe("EL LIBRO: el cambio de modelo no acredita ninguno, y no mueve `netSavings`", () => {
  it("`netSavings` es IDÉNTICO con la cascada enrutando y sin ella", async () => {
    // La verja de verdad de esta palanca. `netSavings` es la comparación a UN
    // precio de lo que hicieron las otras palancas; meterle el cambio de modelo
    // le sumaría un contrafactual (el fuerte no se ejecutó) sobre la cifra que el
    // cliente contrasta contra su factura.
    const texto = '{"answer":"lo mismo"}';
    const uso = { inputTokens: 1000, outputTokens: 200 };
    const con = await capa(new ProveedorPorModelo({ [BARATO]: { text: texto, usage: uso } })).generate(
      peticion({ savings: { modelCascade: "on" } }),
    );
    const sin = await capa(new ProveedorPorModelo({ [FUERTE]: { text: texto, usage: uso } })).generate(
      peticion(),
    );

    expect(con.report.model).toBe(BARATO);
    expect(sin.report.model).toBe(FUERTE);
    expect(con.report.cost.netSavings).toBe(sin.report.cost.netSavings);
    // Y los cuatro libros tampoco se mueven: enrutar no evita una llamada, no
    // quita tokens, no los comprime y no es caché de proveedor.
    expect(con.report.calls.avoidedLlm).toBe(sin.report.calls.avoidedLlm);
    expect(con.report.tokens.eliminatedInput).toBe(sin.report.tokens.eliminatedInput);
    expect(con.report.tokens.compressedInput).toBe(sin.report.tokens.compressedInput);
    expect(con.report.tokens.providerCachedInput).toBe(sin.report.tokens.providerCachedInput);
    expect(con.report.modelCascade!.creditedLedger).toBe("none");
  });

  it("el ahorro del cambio se publica APARTE, y con la cuenta correcta", async () => {
    const res = await capa(new ProveedorPorModelo({})).generate(
      peticion({ savings: { modelCascade: "on" } }),
    );
    // 1000 tokens de entrada y 200 de salida: lo que se pagó con el barato contra
    // lo que habrían costado con el fuerte.
    const conBarato = (1000 / 1000) * 0.00015 + (200 / 1000) * 0.0006;
    const conFuerte = (1000 / 1000) * 0.0025 + (200 / 1000) * 0.01;
    expect(res.report.modelCascade!.estimatedSwapSaving).toBeCloseTo(conFuerte - conBarato, 10);
    // Y esa cifra NO está dentro de netSavings.
    expect(res.report.cost.netSavings).not.toBeCloseTo(1 - conBarato / conFuerte, 3);
  });
});

describe("LA CACHÉ: una respuesta del barato no se le sirve a quien pidió el fuerte", () => {
  it("la clave exacta lleva el modelo SERVIDO", async () => {
    // Sin esto, el cambio de modelo se vuelve silencioso Y diferido: la respuesta
    // del barato se sirve durante 24 h a quien pidió el fuerte, incluso con la
    // palanca apagada y desde otro proceso que comparta el Redis.
    const p = new ProveedorPorModelo({
      [BARATO]: { text: '{"answer":"la del barato"}' },
      [FUERTE]: { text: '{"answer":"la del fuerte"}' },
    });
    const capaUnica = capa(p);

    const enrutada = await capaUnica.generate(peticion({ savings: { modelCascade: "on" } }));
    expect(enrutada.text).toBe('{"answer":"la del barato"}');

    // Misma pregunta, byte a byte, pero SIN la cascada: tiene que pagar el fuerte.
    const normal = await capaUnica.generate(peticion());
    expect(normal.report.cache.result).toBe("miss");
    expect(normal.text).toBe('{"answer":"la del fuerte"}');
    expect(p.llamadas).toEqual([BARATO, FUERTE]);
  });

  it("un acierto de caché sobre la clave del barato no asciende a `exact`", async () => {
    // Repetir una respuesta no mejora su calidad: la escribió un modelo más flojo
    // del que se pidió, y eso es lo que hay que leer en el informe.
    const p = new ProveedorPorModelo({ [BARATO]: { text: '{"answer":"del barato"}' } });
    const capaUnica = capa(p);
    const req = peticion({ savings: { modelCascade: "on" } });

    await capaUnica.generate(req);
    const segunda = await capaUnica.generate(req);

    expect(segunda.report.cache.result).toBe("exact");
    expect(segunda.report.qualityStatus).toBe("bounded_degradation");
    expect(segunda.report.model).toBe(BARATO);
    expect(p.llamadas).toEqual([BARATO]);
  });

  it("tras ESCALAR, la respuesta se guarda bajo la clave del modelo que la escribió", async () => {
    // La clave de LECTURA era la del barato (la cascada iba a llamarle a él).
    // Guardar ahí la respuesta del fuerte la archivaría como suya: la siguiente
    // petición idéntica saldría de caché etiquetada `bounded_degradation` sobre
    // un texto que escribió el modelo bueno, y la escalada —la parte cara—
    // desaparecería del historial.
    const p = new ProveedorPorModelo({
      [BARATO]: { text: "no es json" },
      [FUERTE]: { text: '{"answer":"la del fuerte"}' },
    });
    const capaUnica = capa(p);

    const escalada = await capaUnica.generate(peticion({ savings: { modelCascade: "on" } }));
    expect(escalada.report.modelCascade!.escalated).toBe(true);

    // Misma pregunta SIN cascada: la clave del fuerte, y ahí SÍ está.
    const normal = await capaUnica.generate(peticion());
    expect(normal.report.cache.result).toBe("exact");
    expect(normal.text).toBe('{"answer":"la del fuerte"}');
    expect(normal.report.qualityStatus).toBe("exact");
    expect(p.llamadas).toEqual([BARATO, FUERTE]);
  });

  it("la caché SEMÁNTICA no guarda una respuesta enrutada", async () => {
    // Su identidad la fija el modelo que PIDIÓ el llamante, no el que contestó,
    // así que guardar ahí una respuesta del barato se la serviría después a quien
    // pidiera el fuerte. La clave exacta sí lo separa; ésta no puede.
    const embed = async (t: string): Promise<number[]> =>
      [0, 1, 2, 3].map((i) => [...t].filter((c) => c.charCodeAt(0) % 4 === i).length);
    const semanticCache = new InMemorySemanticCache({
      embed,
      similarityThreshold: 0.3,
      acceptThreshold: 0.3,
    });
    const p = new ProveedorPorModelo({
      [BARATO]: { text: '{"answer":"del barato"}' },
      [FUERTE]: { text: '{"answer":"del fuerte"}' },
    });
    const capaUnica = capa(p, { semanticCache });
    const base = {
      model: FUERTE,
      response: CONTRATO,
      context: { tenantId: "acme", knowledgeEpoch: "e1" },
    };

    await capaUnica.generate({
      ...base,
      messages: [{ role: "user", content: "explica brevemente el mecanismo de coalescencia" }],
      savings: { modelCascade: "on" as const, semanticCache: true as const, exactCache: false },
    });
    // Misma pregunta reformulada, SIN cascada: no puede recibir la del barato.
    const reformulada = await capaUnica.generate({
      ...base,
      messages: [{ role: "user", content: "explica el mecanismo de coalescencia brevemente" }],
      savings: { semanticCache: true as const, exactCache: false },
    });

    expect(reformulada.report.cache.result).toBe("miss");
    expect(reformulada.text).toBe('{"answer":"del fuerte"}');
  });
});

describe("EL APAGADO AUTOMÁTICO, que es una verja de DINERO y no de calidad", () => {
  it("con escalado del 100% deja de enrutar sola, y lo dice", async () => {
    const p = new ProveedorPorModelo({
      [BARATO]: { text: "nunca es json" },
      [FUERTE]: { text: '{"answer":"ok"}' },
    });
    const capaUnica = capa(p, { modelCascade: { exploration: 3 } });
    const req = peticion({ savings: { modelCascade: "on" }, context: { tenantId: "t" } });

    // La exploración: tres peticiones enrutadas, tres escaladas.
    for (let i = 0; i < 3; i++) {
      const res = await capaUnica.generate({
        ...req,
        messages: [{ role: "user", content: `pregunta distinta numero ${i}` }],
      });
      expect(res.report.modelCascade!.escalated).toBe(true);
    }

    // La cuarta ya no se enruta: la medición mandó.
    const cuarta = await capaUnica.generate({
      ...req,
      messages: [{ role: "user", content: "pregunta distinta numero 99" }],
    });
    expect(cuarta.report.model).toBe(FUERTE);
    expect(cuarta.report.modelCascade!.escalationRate).toBe(1);
    expect(cuarta.report.modelCascade!.reason).toMatch(/model cascade OFF/);
    expect(p.llamadas.filter((m) => m === BARATO)).toHaveLength(3);
  });

  it("no se apaga con un escalado por debajo del equilibrio", async () => {
    // El equilibrio de este par es 94%: hay que escalar casi siempre para que
    // enrutar pierda dinero. Eso NO es tranquilizador — significa que esta verja
    // casi nunca salta, y por tanto que no puede ser la red de la calidad.
    let n = 0;
    const p: Provider = {
      id: "uno-de-cada-tres",
      async generate(r: ProviderRequest): Promise<ProviderResponse> {
        const roto = r.model === BARATO && n++ % 3 === 0;
        return {
          text: roto ? "no json" : '{"answer":"ok"}',
          usage: { inputTokens: 1000, outputTokens: 200 },
        };
      },
    };
    const capaUnica = capa(p, { modelCascade: { exploration: 3 } });
    for (let i = 0; i < 4; i++) {
      await capaUnica.generate(
        peticion({
          savings: { modelCascade: "on" },
          messages: [{ role: "user", content: `otra pregunta ${i}` }],
        }),
      );
    }
    const ultima = await capaUnica.generate(
      peticion({
        savings: { modelCascade: "on" },
        messages: [{ role: "user", content: "una mas" }],
      }),
    );
    expect(ultima.report.modelCascade!.servedModel).toBe(BARATO);
    expect(ultima.report.modelCascade!.reason).toMatch(/MONEY check, not a quality one/);
  });

  it("⚠️ el apagado NO ve el falso válido: contenido equivocado, P(escalar) = 0", async () => {
    // Fija por escrito el agujero que ninguna verja cubre. El modelo barato
    // contesta un JSON impecable con el número EQUIVOCADO: el verificador acepta,
    // la tasa de escalado sale 0 —inmejorable—, el ahorro reportado es máximo y
    // la cascada sigue encendida para siempre. La firma es idéntica a la del
    // éxito, y la degradación solo aparece en las quejas del cliente.
    const p = new ProveedorPorModelo({ [BARATO]: { text: '{"answer":"el total es 7"}' } });
    const capaUnica = capa(p, { modelCascade: { exploration: 2 } });

    for (let i = 0; i < 4; i++) {
      const res = await capaUnica.generate(
        peticion({
          savings: { modelCascade: "on" },
          messages: [{ role: "user", content: `cual es el total del informe ${i}` }],
        }),
      );
      expect(res.report.modelCascade!.servedModel).toBe(BARATO);
    }
    const ultima = await capaUnica.generate(
      peticion({
        savings: { modelCascade: "on" },
        messages: [{ role: "user", content: "cual es el total del informe final" }],
      }),
    );
    expect(ultima.report.modelCascade!.escalationRate).toBe(0);
    expect(ultima.report.modelCascade!.servedModel).toBe(BARATO);
    // Y el informe NO llama a esto calidad: publica la tasa de ESCALADO, que es
    // dinero, y la etiqueta de calidad reconoce la degradación.
    expect(ultima.report.qualityStatus).toBe("bounded_degradation");
    expect(Object.keys(ultima.report.modelCascade!)).not.toContain("acceptanceRate");
  });

  it("POR WORKLOAD: un contrato que escala siempre no apaga al de al lado", async () => {
    // Un P(escalar) medio esconde que un tipo de petición escala siempre y otro
    // nunca. Los dos contratos son workloads distintos y se miden por separado.
    const OTRO = { contractId: "otro:v1", schema: CONTRATO.schema };
    const p: Provider = {
      id: "por-contrato",
      async generate(r: ProviderRequest): Promise<ProviderResponse> {
        // El contrato viaja en el esquema; se distingue por el texto del prompt.
        const malo = r.messages.some((m) => m.content.includes("MALO"));
        return {
          text: malo && r.model === BARATO ? "no json" : '{"answer":"ok"}',
          usage: { inputTokens: 1000, outputTokens: 200 },
        };
      },
    };
    const capaUnica = capa(p, { modelCascade: { exploration: 2 } });

    for (let i = 0; i < 3; i++) {
      await capaUnica.generate(
        peticion({
          response: OTRO,
          savings: { modelCascade: "on" },
          messages: [{ role: "user", content: `peticion MALO numero ${i}` }],
        }),
      );
      await capaUnica.generate(
        peticion({
          savings: { modelCascade: "on" },
          messages: [{ role: "user", content: `peticion buena numero ${i}` }],
        }),
      );
    }

    const malo = await capaUnica.generate(
      peticion({
        response: OTRO,
        savings: { modelCascade: "on" },
        messages: [{ role: "user", content: "peticion MALO final" }],
      }),
    );
    const bueno = await capaUnica.generate(
      peticion({
        savings: { modelCascade: "on" },
        messages: [{ role: "user", content: "peticion buena final" }],
      }),
    );

    expect(malo.report.modelCascade!.reason).toMatch(/model cascade OFF/);
    expect(malo.report.modelCascade!.servedModel).toBe(FUERTE);
    expect(bueno.report.modelCascade!.servedModel).toBe(BARATO);
  });
});

describe("COMPOSICIÓN con la caché de prefijo: las cachés son POR MODELO", () => {
  const ANTHROPIC_FUERTE = "anthropic/claude-opus-4";
  const ANTHROPIC_BARATO = "anthropic/claude-haiku-4-5";
  const PRECIOS_ANTHROPIC = {
    [ANTHROPIC_FUERTE]: precioDeLista("claude-opus-4")!,
    [ANTHROPIC_BARATO]: precioDeLista("claude-haiku-4-5")!,
  };
  const LARGO = "instrucciones fijas del sistema. ".repeat(200);

  /** Petición con un prefijo estable largo, que es lo que hace marcable la caché. */
  const conPrefijo = (extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
    model: ANTHROPIC_FUERTE,
    messages: [
      { role: "system", content: LARGO },
      { role: "user", content: "resume el informe" },
    ],
    response: CONTRATO,
    ...extra,
  });

  it("la huella lleva el modelo SERVIDO: enrutar no mezcla dos cachés en una medición", async () => {
    // Un prefijo cacheado del fuerte y uno del barato son cachés DISTINTAS. Con
    // la huella del modelo pedido, las dos poblaciones se sumarían en una sola
    // tasa de aciertos y la verja decidiría sobre un promedio que no es la tasa
    // de ninguna de las dos.
    const p = new ProveedorPorModelo({});
    const capaUnica = capa(p, { costModels: PRECIOS_ANTHROPIC });

    const enrutada = await capaUnica.generate(conPrefijo({ savings: { modelCascade: "on" } }));
    const directa = await capaUnica.generate(conPrefijo());

    const huella = (r: typeof enrutada): unknown =>
      r.report.traces.find((t) => t.stage === "prefix-cache" && t.outcome === "marked")?.detail;
    expect(huella(enrutada)).toBeDefined();
    expect(huella(directa)).toBeDefined();
    expect(enrutada.report.modelCascade!.servedModel).toBe(ANTHROPIC_BARATO);
    // Y la exploración de cada una es suya: cuatro llamadas, dos por modelo.
    expect(p.llamadas).toEqual([ANTHROPIC_BARATO, ANTHROPIC_FUERTE]);
  });

  it("al ESCALAR, la medición del prefijo es la de la llamada que se marcó", async () => {
    // La marca viaja con la llamada al BARATO. Al escalar, la segunda llamada sale
    // sin marcar y contra la caché de OTRO modelo; leer SU uso apuntaría un
    // «no acertó» sobre un prefijo que nunca tuvo ocasión de acertar, y la verja
    // se apagaría por una medición que no es sobre ella.
    const p: Provider = {
      id: "marca-solo-el-barato",
      async generate(r: ProviderRequest): Promise<ProviderResponse> {
        const marcada = r.promptCacheKey !== undefined;
        return {
          text: r.model === ANTHROPIC_BARATO ? "no es json" : '{"answer":"del fuerte"}',
          usage: {
            inputTokens: 2000,
            outputTokens: 100,
            // Solo la llamada marcada (la del barato) reporta acierto de prefijo.
            ...(marcada ? { cachedInputTokens: 1800 } : {}),
          },
        };
      },
    };
    const res = await capa(p, { costModels: PRECIOS_ANTHROPIC }).generate(
      conPrefijo({ savings: { modelCascade: "on" } }),
    );

    expect(res.report.modelCascade!.escalated).toBe(true);
    const medida = res.report.traces.find(
      (t) => t.stage === "prefix-cache" && t.outcome === "measured",
    );
    expect(medida).toBeDefined();
    // 1800, el de la llamada MARCADA — no 0, el de la escalada sin marcar.
    expect(medida!.detail!["cacheRead"]).toBe(1800);
  });

  it("y la VERJA de prefijo decide con esa misma lectura, no solo la traza", async () => {
    // La comprobación de arriba mira la TRAZA, que es lo que se publica. Ésta mira
    // lo que la verja HACE con la medición, que es lo que decide el dinero: si se
    // le apuntara el uso de la llamada escalada (sin marcar, 0 aciertos), tras la
    // ventana de exploración concluiría que el prefijo no acierta nunca y dejaría
    // de marcar — perdiendo un descuento del 90% que sí estaba ahí.
    const p: Provider = {
      id: "el-barato-siempre-acierta-el-prefijo",
      async generate(r: ProviderRequest): Promise<ProviderResponse> {
        const marcada = r.promptCacheKey !== undefined;
        return {
          text: r.model === ANTHROPIC_BARATO ? "no es json" : '{"answer":"del fuerte"}',
          usage: {
            inputTokens: 2000,
            outputTokens: 100,
            ...(marcada ? { cachedInputTokens: 1900 } : {}),
          },
        };
      },
    };
    // Exploración de la cascada alta para que siga enrutando (y escalando) todo
    // el rato: lo que se prueba es la verja del PREFIJO, no la de la cascada.
    const capaUnica = capa(p, {
      costModels: PRECIOS_ANTHROPIC,
      modelCascade: { exploration: 100 },
    });

    // La verja del prefijo explora 8 peticiones antes de juzgar.
    let ultima!: Awaited<ReturnType<typeof capaUnica.generate>>;
    for (let i = 0; i < 12; i++) {
      ultima = await capaUnica.generate(conPrefijo({ savings: { modelCascade: "on" } }));
    }

    const decision = ultima.report.traces.find((t) => t.stage === "prefix-cache");
    expect(decision!.outcome).toBe("marked");
    expect(decision!.detail!["observedHitRate"]).toBe(1);
  });
});

describe("determinismo", () => {
  it("la misma entrada produce la misma decisión, y el mismo workload", async () => {
    const uno = await capa(new ProveedorPorModelo({})).generate(
      peticion({ savings: { modelCascade: "shadow" }, context: { tenantId: "acme" } }),
    );
    const dos = await capa(new ProveedorPorModelo({})).generate(
      peticion({ savings: { modelCascade: "shadow" }, context: { tenantId: "acme" } }),
    );
    expect(uno.report.modelCascade!.workload).toBe(dos.report.modelCascade!.workload);
    expect(uno.report.modelCascade!.reason).toBe(dos.report.modelCascade!.reason);
  });

  it("dos tenants distintos miden por separado", async () => {
    const uno = await capa(new ProveedorPorModelo({})).generate(
      peticion({ savings: { modelCascade: "shadow" }, context: { tenantId: "a" } }),
    );
    const dos = await capa(new ProveedorPorModelo({})).generate(
      peticion({ savings: { modelCascade: "shadow" }, context: { tenantId: "b" } }),
    );
    expect(uno.report.modelCascade!.workload).not.toBe(dos.report.modelCascade!.workload);
  });

  it("el workload no lleva texto del cliente ni siquiera legible", async () => {
    const res = await capa(new ProveedorPorModelo({})).generate(
      peticion({
        savings: { modelCascade: "shadow" },
        messages: [{ role: "user", content: "el secreto es platano" }],
      }),
    );
    expect(res.report.modelCascade!.workload).not.toMatch(/platano|secreto/);
  });
});
