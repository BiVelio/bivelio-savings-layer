import { describe, it, expect } from "vitest";

import { ObservadorSse, costeMedido, informeMedido, PRIMA_ESCRITURA_CACHE } from "../gateway/medidor.js";

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
