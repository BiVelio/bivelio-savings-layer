import * as zlib from "node:zlib";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, it, expect } from "vitest";

import {
  ObservadorSse,
  ObservadorResponses,
  costeMedido,
  modeloDelCuerpo,
  primaDeEscritura,
  MAX_CUERPO_DESCOMPRIMIDO,
  informeMedido,
  informeCoalescido,
  usoDeJson,
  PRIMA_ESCRITURA_CACHE,
  PRIMA_ESCRITURA_CACHE_1H,
} from "../gateway/medidor.js";

/** Un stream SSE como el del catálogo F0 (docs/PASARELA-F0.md). */
function streamF0(): string {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":2000,"cache_read_input_tokens":46792,"output_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start"}\n\n',
    "event: ping\ndata: {}\n\n",
    'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
    'event: content_block_stop\ndata: {}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":10,"cache_read_input_tokens":46792,"output_tokens":91}}\n\n',
    'event: message_stop\ndata: {}\n\n',
  ].join("");
}

describe("ObservadorSse — observa sin tocar", () => {
  it("fusiona usage de message_start y message_delta (el delta pisa)", () => {
    const o = new ObservadorSse();
    o.observar(streamF0());
    expect(o.usage()).toEqual({
      input_tokens: 10,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 46792,
      output_tokens: 91,
    });
  });

  it("aguanta chunks cortados en cualquier punto (incluido dentro de un data:)", () => {
    const s = streamF0();
    for (const corte of [1, 7, 63, 128, 200]) {
      const o = new ObservadorSse();
      for (let i = 0; i < s.length; i += corte) o.observar(s.slice(i, i + corte));
      expect(o.usage()?.output_tokens, `corte=${corte}`).toBe(91);
    }
  });

  it("un data ilegible no revienta ni borra lo ya observado", () => {
    const o = new ObservadorSse();
    o.observar('event: message_start\ndata: {"message":{"usage":{"input_tokens":5}}}\n\n');
    o.observar("event: message_delta\ndata: {esto no es json}\n\n");
    expect(o.usage()).toEqual({ input_tokens: 5 });
  });

  it("sin eventos de usage devuelve null (nada se inventa)", () => {
    const o = new ObservadorSse();
    o.observar("event: ping\ndata: {}\n\n");
    expect(o.usage()).toBeNull();
  });

  it("⛔ un delta con cache_creation PARCIAL se fusiona, no pisa: el desglose 1h sobrevive", () => {
    // Si la API hiciera acumulativos los campos de caché en los deltas (como ya
    // hizo con input_tokens), un spread superficial borraba ephemeral_1h y la
    // escritura 1h volvía a tarifarse a 1,25× — la infra-medición de siempre.
    const o = new ObservadorSse();
    o.observar(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":3000,"cache_creation":{"ephemeral_5m_input_tokens":1000,"ephemeral_1h_input_tokens":2000}}}}\n\n',
    );
    o.observar(
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5,"cache_creation":{"ephemeral_5m_input_tokens":1000}}}\n\n',
    );
    expect(o.usage()?.cache_creation).toEqual({ ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 });
  });

  it("conserva el desglose cache_creation de message_start cuando el delta no lo trae", () => {
    const o = new ObservadorSse();
    o.observar(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":3000,"cache_creation":{"ephemeral_5m_input_tokens":1000,"ephemeral_1h_input_tokens":2000}}}}\n\n',
    );
    o.observar('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n');
    expect(o.usage()).toEqual({
      input_tokens: 10,
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
      output_tokens: 42,
    });
  });
});

/** Un stream de la Responses API como el que emite Codex CLI (usage en response.completed). */
function streamResponses(usage: Record<string, unknown>): string {
  return [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n',
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", usage } })}\n\n`,
  ].join("");
}

describe("ObservadorResponses — el dialecto de Codex CLI, mapeado a UsoSse", () => {
  it("mapea con la fórmula OFICIAL de OpenAI: entrada = input − cached − writes; reasoning no se suma", () => {
    const o = new ObservadorResponses();
    o.observar(
      streamResponses({
        input_tokens: 10_000,
        input_tokens_details: { cached_tokens: 6_000, cache_write_tokens: 1_000 },
        output_tokens: 500,
        output_tokens_details: { reasoning_tokens: 300 },
        total_tokens: 10_500,
      }),
    );
    expect(o.usage()).toEqual({
      input_tokens: 3_000,
      output_tokens: 500,
      cache_read_input_tokens: 6_000,
      cache_creation_input_tokens: 1_000,
    });
    expect(o.eventos["response.completed"]).toBe(1);
  });

  it("y costeMedido lo tarifa: cached a cachedInputPer1k, writes a 1,25× (la prima oficial de OpenAI), jamás al bucket 1h", () => {
    const o = new ObservadorResponses();
    o.observar(streamResponses({ input_tokens: 10_000, input_tokens_details: { cached_tokens: 6_000, cache_write_tokens: 1_000 }, output_tokens: 500 }));
    const m = costeMedido("gpt-5.6-sol", o.usage()!)!;
    // gpt-5.6-sol: in 0.004, out 0.020, cacheIn 0.0004 (catálogo)
    expect(m.costeUsd).toBeCloseTo(3 * 0.004 + 6 * 0.0004 + 1 * 0.004 * PRIMA_ESCRITURA_CACHE + 0.5 * 0.02, 10);
    expect(m.tokens.cacheEscrita1h).toBe(0);
  });

  it("aguanta chunks cortados en cualquier punto", () => {
    const s = streamResponses({ input_tokens: 100, output_tokens: 7 });
    for (const corte of [1, 5, 64, 200]) {
      const o = new ObservadorResponses();
      for (let i = 0; i < s.length; i += corte) o.observar(s.slice(i, i + corte));
      expect(o.usage()?.output_tokens, `corte=${corte}`).toBe(7);
    }
  });

  it("plausibilidad: cached + writes > input se recorta al lado que infra-mide, nunca negativo", () => {
    const o = new ObservadorResponses();
    o.observar(streamResponses({ input_tokens: 1_000, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 500 }, output_tokens: 1 }));
    expect(o.usage()).toEqual({ input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 });
  });

  it("sin response.completed (usage_not_included, corte) devuelve null: nada se inventa", () => {
    const o = new ObservadorResponses();
    o.observar('event: response.created\ndata: {"type":"response.created"}\n\n');
    o.observar('event: error\ndata: {"type":"error","code":"usage_not_included"}\n\n');
    expect(o.usage()).toBeNull();
  });

  it("reconoce response.completed también por data.type cuando no hay línea event:", () => {
    const o = new ObservadorResponses();
    o.observar('data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}\n\n');
    expect(o.usage()).toEqual({ input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });
});

describe("costeMedido — a precio de lista, con la caché bien contada", () => {
  it("separa entrada, lectura de caché (tarifa cacheada) y escritura (prima 1,25×)", () => {
    const m = costeMedido("claude-haiku-4-5-20251001", {
      input_tokens: 1000,
      output_tokens: 1000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 1000,
    });
    expect(m).not.toBeNull();
    // haiku-4-5: in 0.001, out 0.005, cacheIn 0.0001 (catálogo)
    const esperado = 0.001 + 10 * 0.0001 + 0.001 * PRIMA_ESCRITURA_CACHE + 0.005;
    expect(m!.costeUsd).toBeCloseTo(esperado, 10);
  });

  it("resuelve el id fechado por prefijo (claude-haiku-4-5-20251001 → claude-haiku-4-5)", () => {
    expect(costeMedido("claude-haiku-4-5-20251001", { input_tokens: 1000 })!.precio.inputPer1k).toBe(0.001);
  });

  it("modelo desconocido → null: se reenvía pero no se mide (nunca se inventa precio)", () => {
    expect(costeMedido("modelo-inexistente-9000", { input_tokens: 5 })).toBeNull();
  });
});

describe("costeMedido — la escritura 1h se tarifa a 2×, no a 1,25×", () => {
  // haiku-4-5: in 0.001, out 0.005, cacheIn 0.0001 (catálogo)
  it("⛔ con desglose por TTL, la parte 1h va a 2× (antes TODO iba a 1,25× y el gateway infra-medía)", () => {
    const m = costeMedido("claude-haiku-4-5-20251001", {
      input_tokens: 1000,
      output_tokens: 1000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
    })!;
    const esperado =
      0.001 + 10 * 0.0001 + 0.001 * PRIMA_ESCRITURA_CACHE + 2 * 0.001 * PRIMA_ESCRITURA_CACHE_1H + 0.005;
    expect(m.costeUsd).toBeCloseTo(esperado, 10);
    expect(m.tokens.cacheEscrita).toBe(3000); // el total sigue siendo la cifra del informe
    expect(m.tokens.cacheEscrita1h).toBe(2000);
  });

  it("sin desglose (usage legacy): todo a 1,25× y cacheEscrita1h = 0", () => {
    const m = costeMedido("claude-haiku-4-5", { cache_creation_input_tokens: 1000 })!;
    expect(m.costeUsd).toBeCloseTo(0.001 * PRIMA_ESCRITURA_CACHE, 10);
    expect(m.tokens.cacheEscrita1h).toBe(0);
  });

  it("desglose incompleto: lo que no cubre se tarifa a 1,25× (quedarse corto por defecto, jamás inventar)", () => {
    const m = costeMedido("claude-haiku-4-5", {
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_1h_input_tokens: 1000 },
    })!;
    expect(m.costeUsd).toBeCloseTo(2 * 0.001 * PRIMA_ESCRITURA_CACHE + 0.001 * PRIMA_ESCRITURA_CACHE_1H, 10);
    expect(m.tokens.cacheEscrita).toBe(3000);
    expect(m.tokens.cacheEscrita1h).toBe(1000);
  });

  it("sin total pero con desglose, el total se reconstruye del desglose", () => {
    const m = costeMedido("claude-haiku-4-5", {
      cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 500 },
    })!;
    expect(m.tokens.cacheEscrita).toBe(1000);
    expect(m.tokens.cacheEscrita1h).toBe(500);
    expect(m.costeUsd).toBeCloseTo(0.5 * 0.001 * PRIMA_ESCRITURA_CACHE + 0.5 * 0.001 * PRIMA_ESCRITURA_CACHE_1H, 10);
  });
});

describe("primaDeEscritura — 1,25× solo donde el proveedor la cobra", () => {
  it("Anthropic 1,25×; gpt-5.6+ 1,25×; gpt anteriores y Gemini 1× (jamás inventar de más)", () => {
    expect(primaDeEscritura("claude-haiku-4-5")).toBe(PRIMA_ESCRITURA_CACHE);
    expect(primaDeEscritura("gpt-5.6-sol")).toBe(PRIMA_ESCRITURA_CACHE);
    expect(primaDeEscritura("gpt-5.5")).toBe(1);
    expect(primaDeEscritura("gpt-4o")).toBe(1);
    expect(primaDeEscritura("gemini-2.5-pro")).toBe(1);
  });

  it("y costeMedido la aplica: cache_write_tokens de gpt-5.5 a 1×, no a 1,25×", () => {
    const m = costeMedido("gpt-5.5", { input_tokens: 0, cache_creation_input_tokens: 1000 })!;
    expect(m.costeUsd).toBeCloseTo(0.005, 10); // gpt-5.5: in 0.005/1k
  });
});

describe("usageFinal — solo con el evento terminal del proveedor", () => {
  it("Anthropic: null tras message_start, usage tras message_delta", () => {
    const o = new ObservadorSse();
    o.observar('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n');
    expect(o.usage()).not.toBeNull();
    expect(o.usageFinal()).toBeNull();
    o.observar('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n');
    expect(o.usageFinal()?.output_tokens).toBe(42);
  });

  it("Responses: el usage solo existe en response.completed, así que es el mismo", () => {
    const o = new ObservadorResponses();
    expect(o.usageFinal()).toBeNull();
    o.observar(streamResponses({ input_tokens: 5, output_tokens: 2 }));
    expect(o.usageFinal()).toEqual(o.usage());
  });
});

describe("modeloDelCuerpo — lee el model a través del content-encoding (Codex manda zstd)", () => {
  const cuerpo = Buffer.from(JSON.stringify({ model: "gpt-5.5", input: "hola", stream: true }));

  it("sin codificación, gzip, deflate y br", () => {
    expect(modeloDelCuerpo(cuerpo)).toBe("gpt-5.5");
    expect(modeloDelCuerpo(gzipSync(cuerpo), "gzip")).toBe("gpt-5.5");
    expect(modeloDelCuerpo(deflateSync(cuerpo), "deflate")).toBe("gpt-5.5");
    expect(modeloDelCuerpo(brotliCompressSync(cuerpo), "br")).toBe("gpt-5.5");
  });

  it("zstd (lo que manda Codex CLI) cuando el Node lo trae; si no, «» y nunca se inventa", () => {
    const z = zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer };
    if (typeof z.zstdCompressSync === "function") {
      expect(modeloDelCuerpo(z.zstdCompressSync(cuerpo), "zstd")).toBe("gpt-5.5");
    } else {
      expect(modeloDelCuerpo(cuerpo, "zstd")).toBe("");
    }
  });

  it("cuerpo ilegible, codificación que no casa o model no-string → «» (se reenvía, no se mide)", () => {
    expect(modeloDelCuerpo(Buffer.from("no json"))).toBe("");
    expect(modeloDelCuerpo(cuerpo, "gzip")).toBe(""); // dice gzip pero no lo es
    expect(modeloDelCuerpo(Buffer.from("{}"))).toBe("");
    expect(modeloDelCuerpo(Buffer.from('{"model":{"x":1}}'))).toBe("");
    expect(modeloDelCuerpo(Buffer.from('{"model":5}'))).toBe("");
  });

  it("⛔ bomba de descompresión: un cuerpo pequeño que expande por encima del tope no se lee (ni bloquea)", () => {
    const bomba = brotliCompressSync(Buffer.alloc(MAX_CUERPO_DESCOMPRIMIDO + 1024, 0));
    expect(bomba.length).toBeLessThan(10_000);
    expect(modeloDelCuerpo(bomba, "br")).toBe("");
  });
});

describe("usoDeJson — el usage de una respuesta stream:false", () => {
  it("extrae usage del JSON, desglose por TTL incluido", () => {
    const cuerpo = JSON.stringify({
      id: "msg_1",
      usage: {
        input_tokens: 100,
        output_tokens: 42,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_1h_input_tokens: 1000 },
      },
    });
    expect(usoDeJson(Buffer.from(cuerpo))).toEqual({
      input_tokens: 100,
      output_tokens: 42,
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_1h_input_tokens: 1000 },
    });
  });

  it("sin usage, o con un cuerpo ilegible, devuelve null (nada se inventa)", () => {
    expect(usoDeJson('{"input_tokens":2095}')).toBeNull(); // count_tokens: sin `usage`, no factura
    expect(usoDeJson("esto no es json")).toBeNull();
  });
});

describe("informeMedido — v1: baseline = actual, basis measured, ahorro 0", () => {
  it("produce exactamente los campos que UsageEmitter.toWire lee", () => {
    const medido = costeMedido("claude-haiku-4-5", { input_tokens: 10, output_tokens: 91, cache_read_input_tokens: 46792 })!;
    const r = informeMedido("req-1", "claude-haiku-4-5", medido) as unknown as {
      requestId: string;
      model: string;
      calls: { avoidedLlm: number; actualLlm: number };
      tokens: Record<string, number>;
      cache: { result: string };
      cost: { baselineEstimate: number; actual: number; netSavings: number; basis: string };
    };
    expect(r.requestId).toBe("req-1");
    expect(r.calls).toEqual({ avoidedLlm: 0, actualLlm: 1 });
    expect(r.tokens.baselineInput).toBe(10 + 46792);
    expect(r.tokens.actualInput).toBe(10 + 46792);
    expect(r.tokens.providerCachedInput).toBe(46792);
    expect(r.tokens.baselineOutput).toBe(91);
    expect(r.cache.result).toBe("miss");
    expect(r.cost.actual).toBe(medido.costeUsd);
    expect(r.cost.baselineEstimate).toBe(medido.costeUsd);
    expect(r.cost.netSavings).toBe(0);
    expect(r.cost.basis).toBe("measured");
  });
});

describe("atribución — la sesión y el subagente viajan en el informe, o no existen", () => {
  it("con atribución el informe lleva attribution; sin ella, el campo NO existe (nada de objetos vacíos)", () => {
    const medido = costeMedido("claude-haiku-4-5", { input_tokens: 1 })!;
    const con = informeMedido("r", "m", medido, { sessionId: "s-1", agentId: "a-2" }) as unknown as { attribution?: unknown };
    expect(con.attribution).toEqual({ sessionId: "s-1", agentId: "a-2" });
    const sin = informeMedido("r", "m", medido) as unknown as { attribution?: unknown };
    expect("attribution" in sin).toBe(false);
    const coal = informeCoalescido("r", "m", medido, { sessionId: "s-1" }) as unknown as { attribution?: { sessionId?: string } };
    expect(coal.attribution).toEqual({ sessionId: "s-1" });
  });
});

describe("informeCoalescido — netSavings es una PROPORCIÓN, no dólares", () => {
  it("⛔ una primaria cara (> $1) reporta netSavings 1, no su coste en USD", () => {
    // El bug (27-08): netSavings iba en dólares; el ingest lo valida como ratio
    // [-100,1] y rechazaba el LOTE entero cuando la primaria costaba > $1.
    const medido = costeMedido("claude-opus-4", { input_tokens: 400000, output_tokens: 4000 })!;
    expect(medido.costeUsd).toBeGreaterThan(1); // la petición cara que dispara el bug
    const r = informeCoalescido("req-c", "claude-opus-4", medido) as unknown as {
      calls: { avoidedLlm: number; actualLlm: number };
      cache: { result: string };
      cost: { baselineEstimate: number; actual: number; netSavings: number; basis: string };
    };
    expect(r.calls).toEqual({ avoidedLlm: 1, actualLlm: 0 });
    expect(r.cache.result).toBe("singleflight");
    expect(r.cost.actual).toBe(0);
    expect(r.cost.baselineEstimate).toBe(medido.costeUsd);
    expect(r.cost.netSavings).toBe(1); // 100 % evitado, dentro de [-100, 1]
    expect(r.cost.netSavings).toBeLessThanOrEqual(1); // la verja del ingest ya no lo rechaza
    expect(r.cost.basis).toBe("estimated");
  });
});
