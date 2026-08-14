import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemorySemanticCache } from "../src/cache/semantic.js";
import { QUALITY_STATUSES } from "../src/contracts/types.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { ExactCache } from "../src/cache/exact.js";
import type { QualityStatus, SavingsRequest, ToolDescriptor } from "../src/contracts/types.js";

/**
 * EL ESTADO DE CALIDAD DEJA DE SER UN BOOLEANO.
 *
 * `constraints.structurallyValid` metía en la misma casilla lo que CALCULÓ un
 * resolver determinista y lo que escribió el modelo sin que nadie comprobara
 * nada más que la forma. Este fichero fija, camino por camino, qué etiqueta
 * lleva cada respuesta — y sobre todo que el defecto es el suelo (`not_verified`)
 * y no algo más halagüeño, porque un defecto optimista es una afirmación de
 * calidad que nadie ha medido.
 *
 * La regla que hay detrás: NUNCA decir «sin pérdida» cuando lo único medido es
 * coseno, BLEU, ROUGE o el juicio de otro LLM. De ahí que el único atajo no
 * exacto que sube de `not_verified` sea el que pasa una verja DETERMINISTA.
 */

const PRECIOS = { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } };

class ProveedorFijo implements Provider {
  readonly id = "fijo";
  llamadas = 0;
  constructor(
    private readonly texto: string,
    private readonly retardoMs = 0,
  ) {}
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas++;
    if (this.retardoMs) await new Promise((r) => setTimeout(r, this.retardoMs));
    return { text: this.texto, usage: { inputTokens: 100, outputTokens: 10 } };
  }
}

const capa = (provider: Provider, extra: Record<string, unknown> = {}) =>
  createSavingsLayer({ provider, costModels: PRECIOS, silenceWarnings: true, ...extra });

/** Precios reales del par que usa la cascada de modelos (r = 0,060). */
const PRECIOS_DEL_PAR = {
  "openai/gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
};

/** Como `ProveedorFijo`, pero apunta a QUÉ modelo se llamó. */
class ProveedorPorModelo implements Provider {
  readonly id = "por-modelo";
  readonly modelos: string[] = [];
  constructor(private readonly texto = '{"answer":"ok"}') {}
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.modelos.push(r.model);
    return { text: this.texto, usage: { inputTokens: 100, outputTokens: 10 } };
  }
}

/** Contrato que pide `{answer: string}` y prohíbe lo demás. */
const CONTRATO = {
  contractId: "answer:v1",
  schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" as const } },
  },
};

// Embebedor de juguete: cuenta caracteres por clase, así que dos redacciones
// parecidas salen casi idénticas. Sirve para llegar a la verja determinista,
// que es lo que de verdad se está probando.
const embed = async (t: string): Promise<number[]> =>
  [0, 1, 2, 3].map((i) => [...t].filter((c) => c.charCodeAt(0) % 4 === i).length);

describe("exact — la respuesta es exacta POR CONSTRUCCIÓN", () => {
  it("resolver determinista: la respuesta se CALCULÓ, no se generó", async () => {
    const proveedor = new ProveedorFijo("no debería llamarse");
    const res = await capa(proveedor).generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is (2 + 2) * 3?" }],
    });

    expect(res.report.cache.result).toBe("deterministic");
    expect(proveedor.llamadas).toBe(0);
    expect(res.report.qualityStatus).toBe("exact");
  });

  it("acierto de caché exacta: misma pregunta, misma respuesta", async () => {
    const proveedor = new ProveedorFijo("el teorema dice que a2+b2=c2");
    const capaUnica = capa(proveedor);
    const peticion: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "explica el teorema de pitagoras en una frase" }],
    };

    const primera = await capaUnica.generate(peticion);
    const segunda = await capaUnica.generate(peticion);

    // La primera pagó al proveedor y no puede llamarse exacta: nadie verificó
    // nada. Es la segunda —la que REPITE una respuesta ya dada a esta misma
    // pregunta— la que se gana la etiqueta.
    expect(primera.report.qualityStatus).toBe("not_verified");
    expect(segunda.report.cache.result).toBe("exact");
    expect(segunda.report.qualityStatus).toBe("exact");
    expect(proveedor.llamadas).toBe(1);
  });
});

describe("task_equivalent — no es idéntico, pero pasó una verja determinista", () => {
  it("acierto de caché semántica: otra redacción de la MISMA pregunta", async () => {
    const proveedor = new ProveedorFijo("paris");
    const semanticCache = new InMemorySemanticCache({
      embed,
      similarityThreshold: 0.3,
      acceptThreshold: 0.3,
    });
    const capaUnica = capa(proveedor, { semanticCache });
    const base = {
      model: "openai/gpt-4o-mini",
      savings: { semanticCache: true as const, exactCache: false },
      context: { tenantId: "acme", knowledgeEpoch: "e1" },
    };

    await capaUnica.generate({
      ...base,
      messages: [{ role: "user", content: "explain the coalescing mechanism briefly" }],
    });
    // Mismas palabras, otro orden: para la verja determinista es la MISMA
    // pregunta (mismos números, misma paridad de negaciones, mismas entidades).
    const reformulada = await capaUnica.generate({
      ...base,
      messages: [{ role: "user", content: "explain briefly the coalescing mechanism" }],
    });

    expect(reformulada.report.cache.result).toBe("semantic");
    // NO es `exact` (el texto no se derivó de esta pregunta) y NO es
    // `not_verified` (pasó la verja determinista que corre bajo el embebedor:
    // números y fechas, paridad de negaciones, entidades). El coseno solo no
    // habría comprado la etiqueta.
    expect(reformulada.report.qualityStatus).toBe("task_equivalent");
  });
});

describe("not_verified — el defecto honesto, y el caso mayoritario", () => {
  it("una llamada normal al modelo NO se presenta como verificada", async () => {
    const res = await capa(new ProveedorFijo("cualquier cosa")).generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "escribe algo sobre el clima de galicia" }],
    });

    expect(res.report.cache.result).toBe("miss");
    expect(res.report.qualityStatus).toBe("not_verified");
    // Y explícitamente: nada de subir de categoría por el camino corriente.
    expect(res.report.qualityStatus).not.toBe("exact");
    expect(res.report.qualityStatus).not.toBe("task_equivalent");
  });

  it("cumplir el contrato NO sube la nota: la forma no es la fidelidad", async () => {
    const res = await capa(new ProveedorFijo('{"answer":"ok"}')).generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "dame el json del resumen" }],
      response: CONTRATO,
    });

    // El contrato se cumple…
    expect(res.report.constraints.structurallyValid).toBe(true);
    // …y aun así nadie ha comprobado que la respuesta sea buena: que el JSON
    // tenga la forma pedida no dice nada de si desapareció una cifra.
    expect(res.report.qualityStatus).toBe("not_verified");
  });

  it("el fail-open no inventa un estado peor: lo degradado es el optimizador", async () => {
    // Una caché que revienta al leer hace las veces de CUALQUIER fallo interno.
    const cacheRota: ExactCache = {
      get() {
        throw new Error("boom: fallo interno del optimizador");
      },
      async set() {},
      async delete() {},
    };
    const res = await capa(new ProveedorFijo("respuesta directa del proveedor"), {
      exactCache: cacheRota,
    }).generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hola" }],
    });

    // Se confirma que estamos en el camino que interesa.
    expect(res.report.traces.some((t) => t.stage === "fail-open")).toBe(true);
    // La respuesta está tan verificada (o tan poco) como en el camino normal, y
    // la degradación ya se ve en la traza. Una etiqueta peor contaría dos veces
    // lo mismo y culparía a la respuesta de un problema que no es suyo.
    expect(res.report.qualityStatus).toBe("not_verified");
  });

  it("un turno de herramientas SÍ lleva etiqueta, aunque omita structurallyValid", async () => {
    const enviarFactura: ToolDescriptor = {
      id: "send_invoice",
      intents: ["send invoice"],
      risk: "write",
    };
    const proveedor: Provider = {
      id: "tools",
      async generate(): Promise<ProviderResponse> {
        return {
          text: "",
          usage: { inputTokens: 120, outputTokens: 18 },
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "send_invoice", arguments: '{"id":"F-1"}' }],
        };
      },
    };
    const res = await capa(proveedor).generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "send the invoice to accounting" }],
      tools: [enviarFactura],
      response: CONTRATO,
    });

    // `structurallyValid` se omite porque `true`/`false` certificarían o
    // acusarían sobre un contrato que nadie ha mirado…
    expect(res.report.constraints.structurallyValid).toBeUndefined();
    // …pero `not_verified` no afirma nada del contrato: dice que nadie verificó,
    // que es literalmente lo que pasa. Y así la AUSENCIA del campo conserva un
    // único significado: «este SDK es anterior a la etiqueta».
    expect(res.report.qualityStatus).toBe("not_verified");
  });
});

describe("rejected — no cumplió el contrato, ni después de reparar", () => {
  it("el modelo devuelve algo que no valida y la reparación tampoco", async () => {
    const proveedor = new ProveedorFijo("{roto");
    const res = await capa(proveedor).generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "dame el json del resumen" }],
      response: CONTRATO,
    });

    expect(res.report.constraints.structurallyValid).toBe(false);
    expect(res.report.qualityStatus).toBe("rejected");
  });

  it("el incumplimiento MANDA sobre la procedencia: un resolver también es rechazable", async () => {
    // El resolver aritmético devuelve `{value: 8}` a quien pidió `{answer}`:
    // acierta el número y falla el contrato. Es exacto por construcción y aun
    // así no puede quedarse la etiqueta `exact` — la calidad solo degrada.
    const res = await capa(new ProveedorFijo("no debería llamarse")).generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is (2 + 2) * 3?" }],
      response: { contractId: "calc:v1", schema: CONTRATO.schema },
    });

    expect(res.report.cache.result).toBe("deterministic");
    expect(res.report.constraints.structurallyValid).toBe(false);
    expect(res.report.qualityStatus).toBe("rejected");
  });
});

describe("bounded_degradation — contestó un modelo MÁS BARATO del que se pidió", () => {
  it("la cascada sirve el barato tras pasar la verja determinista", async () => {
    const proveedor = new ProveedorPorModelo();
    const res = await capa(proveedor, { costModels: PRECIOS_DEL_PAR }).generate({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "dame el json del resumen" }],
      response: CONTRATO,
      savings: { modelCascade: "on" },
    });

    // Contestó otro modelo, y el informe lo dice en los tres sitios.
    expect(proveedor.modelos).toEqual(["openai/gpt-4o-mini"]);
    expect(res.report.model).toBe("openai/gpt-4o-mini");
    expect(res.report.modelCascade!.requestedModel).toBe("openai/gpt-4o");
    // NO es `not_verified` —sí pasó una verja determinista— y NO es
    // `task_equivalent`, que afirmaría una equivalencia que nadie ha medido: la
    // verja mira la FORMA. Lo que se declara es exactamente lo que pasó.
    expect(res.report.qualityStatus).toBe("bounded_degradation");
  });

  it("el incumplimiento del contrato sigue mandando sobre la degradación", async () => {
    // Un JSON válido para la cascada y roto para el contrato no puede existir
    // (es el mismo validador), así que se prueba por el otro lado: la cascada NO
    // enruta y el modelo pedido incumple. Sigue siendo `rejected`.
    const proveedor = new ProveedorPorModelo("{roto");
    const res = await capa(proveedor, { costModels: PRECIOS_DEL_PAR }).generate({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "dame el json del resumen" }],
      response: CONTRATO,
      savings: { modelCascade: "shadow" },
    });
    expect(res.report.qualityStatus).toBe("rejected");
  });
});

describe("el seguidor de singleflight hereda la calidad del líder", () => {
  it("sirve el texto del líder, así que lleva la etiqueta del líder", async () => {
    // Líder que acaba en `rejected`: si el seguidor no heredara, saldría con el
    // defecto `not_verified` y estaría presentando como «sin verificar» una
    // respuesta que YA SABEMOS que incumple el contrato que sirve.
    const proveedor = new ProveedorFijo("{roto", 40);
    const capaUnica = capa(proveedor);
    const peticion: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "explica el mecanismo de coalescencia en detalle" }],
      response: CONTRATO,
      context: { tenantId: "t1" },
    };

    const [a, b, c] = await Promise.all([
      capaUnica.generate(peticion),
      capaUnica.generate(peticion),
      capaUnica.generate(peticion),
    ]);

    const seguidores = [a, b, c].filter((r) => r.report.cache.result === "singleflight");
    expect(seguidores.length).toBe(2);
    for (const s of seguidores) {
      expect(s.report.qualityStatus).toBe("rejected");
    }
  });
});

/**
 * EL TRINQUETE: NINGÚN ESTADO DECLARADO SIN PRODUCTOR.
 *
 * Es la misma regla que cerró `report.compression` (declarado en el contrato y
 * relleno por nadie) y las palancas mudas: un estado que nadie emite es una
 * promesa que el cliente no puede comprobar, y este cambio existe justo para
 * dejar de mezclar afirmaciones con esperanzas. Por eso `insufficient_evidence`
 * y `bounded_degradation` —que corresponden a palancas que aún no existen— NO
 * están declarados: se declararán el día que algo los produzca.
 *
 * En los dos sentidos: si alguien añade un estado al tipo sin emitirlo, esto se
 * pone rojo; si alguien deja de emitir uno, también.
 *
 * `bounded_degradation` ya está declarado porque YA HAY QUIEN LO EMITE: la
 * cascada de modelos, cuando sirve la respuesta de un modelo más barato del que
 * pidió el llamante. `insufficient_evidence` sigue fuera, y por la misma regla.
 */
describe("el vocabulario declarado es exactamente el que se produce", () => {
  it("cada estado de QUALITY_STATUSES tiene un camino que lo emite", async () => {
    const vistos = new Set<QualityStatus>();
    const anota = (s: QualityStatus | undefined) => {
      expect(s).toBeDefined();
      vistos.add(s!);
    };

    // exact — resolver determinista.
    anota(
      (
        await capa(new ProveedorFijo("x")).generate({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "What is 7 * 6?" }],
        })
      ).report.qualityStatus,
    );

    // not_verified — camino del proveedor.
    anota(
      (
        await capa(new ProveedorFijo("una respuesta")).generate({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "cuentame algo del mar cantabrico" }],
        })
      ).report.qualityStatus,
    );

    // rejected — no valida contra su contrato.
    anota(
      (
        await capa(new ProveedorFijo("{roto")).generate({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "dame el json" }],
          response: CONTRATO,
        })
      ).report.qualityStatus,
    );

    // bounded_degradation — la cascada sirvió un modelo más barato.
    anota(
      (
        await capa(new ProveedorPorModelo(), { costModels: PRECIOS_DEL_PAR }).generate({
          model: "openai/gpt-4o",
          messages: [{ role: "user", content: "dame el json del resumen" }],
          response: CONTRATO,
          savings: { modelCascade: "on" },
        })
      ).report.qualityStatus,
    );

    // task_equivalent — acierto de caché semántica.
    const semanticCache = new InMemorySemanticCache({
      embed,
      similarityThreshold: 0.3,
      acceptThreshold: 0.3,
    });
    const capaSemantica = capa(new ProveedorFijo("berlin"), { semanticCache });
    const base = {
      model: "openai/gpt-4o-mini",
      savings: { semanticCache: true as const, exactCache: false },
      context: { tenantId: "acme", knowledgeEpoch: "e2" },
    };
    await capaSemantica.generate({
      ...base,
      messages: [{ role: "user", content: "describe the water cycle briefly" }],
    });
    anota(
      (
        await capaSemantica.generate({
          ...base,
          messages: [{ role: "user", content: "describe briefly the water cycle" }],
        })
      ).report.qualityStatus,
    );

    expect([...vistos].sort()).toEqual([...QUALITY_STATUSES].sort());
  });
});
