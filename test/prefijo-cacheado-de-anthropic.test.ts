import { describe, it, expect } from "vitest";

import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * LO QUE SE CACHEA TIENE QUE SER EL MISMO BYTE A BYTE ENTRE PETICIONES.
 *
 * Anthropic empareja por PREFIJO: el `cache_control` no dice «cachea esto», dice
 * «hasta aquí se puede reutilizar». Si un solo byte por delante del punto de
 * ruptura cambia entre dos peticiones, no acierta a medias — no acierta nunca, y
 * cada petición paga la prima de escritura (1,25x) del tramo entero.
 *
 * Por eso estos tests NO comprueban dónde está la marca. Comprueban la PROPIEDAD
 * que hace que la caché funcione: se reconstruye el tramo cacheado en el orden en
 * que el proveedor lo renderiza (tools -> system -> messages) y se exige que dos
 * peticiones distintas produzcan exactamente los mismos bytes. Un test que solo
 * mirase el índice de la marca pasaría con el prefijo roto.
 */

function fetchEspia(capturas: Record<string, unknown>[]): typeof fetch {
  return (async (_url: unknown, init: { body: string }) => {
    capturas.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

interface Unidad {
  texto: string;
  corta: boolean;
}

/**
 * Aplana el cuerpo en las unidades que el proveedor renderiza, EN ORDEN, y marca
 * cuáles llevan punto de ruptura. El orden es el de la API: `tools` primero,
 * luego `system`, luego `messages`.
 */
function unidadesRenderizadas(body: Record<string, unknown>): Unidad[] {
  const u: Unidad[] = [];
  const tools = body["tools"] as unknown[] | undefined;
  if (tools) u.push({ texto: `tools:${JSON.stringify(tools)}`, corta: false });

  const system = (body["system"] as { text: string; cache_control?: unknown }[]) ?? [];
  for (const b of system) {
    u.push({ texto: `system:${b.text}`, corta: b.cache_control != null });
  }

  const messages =
    (body["messages"] as {
      role: string;
      content: { text: string; cache_control?: unknown }[];
    }[]) ?? [];
  for (const m of messages) {
    for (const b of m.content) {
      u.push({ texto: `${m.role}:${b.text}`, corta: b.cache_control != null });
    }
  }
  return u;
}

/** Los tramos que el proveedor puede reutilizar: uno por punto de ruptura. */
function tramosCacheados(body: Record<string, unknown>): string[] {
  const u = unidadesRenderizadas(body);
  const tramos: string[] = [];
  const acumulado: string[] = [];
  for (const unidad of u) {
    acumulado.push(unidad.texto);
    if (unidad.corta) tramos.push(acumulado.join("\n"));
  }
  return tramos;
}

const POLITICA = "Eres el asistente de una tienda de electrónica. ".repeat(40);

function capa(provider: AnthropicProvider): SavingsPipeline {
  return new SavingsPipeline({
    provider,
    tokenizer: new TokenizerRegistry(),
    devUnlicensed: true,
  } as never);
}

function conversacion(payload: unknown): SavingsRequest {
  return {
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      { role: "system", content: POLITICA },
      { role: "user", content: "turno viejo" },
      { role: "assistant", content: "respuesta vieja" },
      { role: "user", content: "pregunta de hoy" },
    ],
    structuredData: payload,
  } as unknown as SavingsRequest;
}

describe("el tramo cacheado de Anthropic no puede contener texto variable", () => {
  it("dos peticiones con payloads distintos comparten los MISMOS bytes cacheados", async () => {
    const capturas: Record<string, unknown>[] = [];
    const provider = new AnthropicProvider({ fetchImpl: fetchEspia(capturas) });
    const bvsala = capa(provider);

    await bvsala.generate(conversacion({ pedido: "AAA-111" }));
    await bvsala.generate(conversacion({ pedido: "ZZZ-999" }));

    expect(capturas).toHaveLength(2);
    const [a, b] = capturas as [Record<string, unknown>, Record<string, unknown>];

    // El test no puede pasar por vacío: los dos prompts TIENEN que diferir.
    expect(JSON.stringify(a)).toContain("AAA-111");
    expect(JSON.stringify(b)).toContain("ZZZ-999");
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));

    const tramosA = tramosCacheados(a);
    const tramosB = tramosCacheados(b);

    // Y tiene que haber algo marcado: cero puntos de ruptura también "coincide".
    expect(tramosA.length).toBeGreaterThan(0);
    expect(tramosB.length).toEqual(tramosA.length);

    // LA PROPIEDAD: cada tramo reutilizable es idéntico byte a byte. Sin esto el
    // proveedor lo trata como nuevo, cobra la prima de escritura y no acierta.
    expect(tramosB).toEqual(tramosA);
  });

  it("el payload de la petición queda FUERA de todo tramo cacheado", async () => {
    const capturas: Record<string, unknown>[] = [];
    const provider = new AnthropicProvider({ fetchImpl: fetchEspia(capturas) });

    await capa(provider).generate(conversacion({ pedido: "AAA-111" }));

    const cuerpo = capturas[0]!;
    // Está en el prompt (se envía: el modelo lo necesita)...
    expect(JSON.stringify(cuerpo)).toContain("AAA-111");
    // ...pero no dentro de nada que se declare reutilizable.
    for (const tramo of tramosCacheados(cuerpo)) {
      expect(tramo).not.toContain("AAA-111");
    }
  });

  it("la evidencia de retrieval tampoco entra en el tramo cacheado", async () => {
    const capturas: Record<string, unknown>[] = [];
    const provider = new AnthropicProvider({ fetchImpl: fetchEspia(capturas) });
    const bvsala = new SavingsPipeline({
      provider,
      tokenizer: new TokenizerRegistry(),
      devUnlicensed: true,
      retriever: {
        retrieve: async () => [{ id: "d1", text: "Canarias tarda CINCO-DIAS-HABILES." }],
      },
    } as never);

    await bvsala.generate({
      model: "anthropic/claude-sonnet-4-5",
      messages: [
        { role: "system", content: POLITICA },
        { role: "user", content: "turno viejo" },
        { role: "assistant", content: "respuesta vieja" },
        { role: "user", content: "¿Cuánto tarda un envío a Canarias?" },
      ],
      retrieval: { query: "envíos Canarias" },
    } as unknown as SavingsRequest);

    const cuerpo = capturas[0]!;
    // La evidencia cambia con la pregunta: es lo más variable del prompt.
    expect(JSON.stringify(cuerpo)).toContain("CINCO-DIAS-HABILES");
    const tramos = tramosCacheados(cuerpo);
    expect(tramos.length).toBeGreaterThan(0);
    for (const tramo of tramos) {
      expect(tramo).not.toContain("CINCO-DIAS-HABILES");
    }
  });

  it("un `system` de la CABECERA que el llamante no declaró estable queda fuera", async () => {
    // Contra el adaptador directamente. Dos bloques de sistema seguidos, pero el
    // llamante solo declara estable el primero: el segundo puede cambiar en cada
    // petición, así que el punto de ruptura tiene que quedarse en el primero.
    // Marcar «el último de `system`» a secas mete el segundo en el tramo.
    const capturas: Record<string, unknown>[] = [];
    const provider = new AnthropicProvider({ fetchImpl: fetchEspia(capturas) });

    await provider.generate({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "system", content: POLITICA },
        { role: "system", content: "NOTA-VOLATIL de hoy" },
        { role: "user", content: "pregunta de hoy" },
      ],
      stablePrefixMessages: 1,
    });

    const cuerpo = capturas[0]!;
    expect(JSON.stringify(cuerpo)).toContain("NOTA-VOLATIL");
    const tramos = tramosCacheados(cuerpo);
    expect(tramos.length).toBeGreaterThan(0);
    for (const tramo of tramos) {
      expect(tramo).not.toContain("NOTA-VOLATIL");
    }
  });

  it("un `system` a media conversación se emite en su sitio, no se iza al principio", async () => {
    // Izarlo lo pondría por delante del historial, y entonces el punto de
    // ruptura del historial abarcaría texto que cambia por petición.
    const capturas: Record<string, unknown>[] = [];
    const provider = new AnthropicProvider({ fetchImpl: fetchEspia(capturas) });

    await provider.generate({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "system", content: POLITICA },
        { role: "user", content: "turno viejo" },
        { role: "assistant", content: "respuesta vieja" },
        { role: "system", content: "NOTA-VOLATIL de hoy" },
        { role: "user", content: "pregunta de hoy" },
      ],
      stablePrefixMessages: 3,
    });

    const cuerpo = capturas[0]!;
    const system = cuerpo["system"] as { text: string }[];
    // La cabecera es SOLO la política: el `system` de más abajo no sube.
    expect(system).toHaveLength(1);
    expect(system[0]!.text).toEqual(POLITICA);
    for (const tramo of tramosCacheados(cuerpo)) {
      expect(tramo).not.toContain("NOTA-VOLATIL");
    }
  });
});
