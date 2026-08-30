import { describe, it, expect } from "vitest";

import {
  ObservadorSse,
  costeMedido,
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
