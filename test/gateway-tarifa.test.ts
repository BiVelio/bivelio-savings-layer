import { describe, it, expect } from "vitest";

import { costeMedido, informeMedido } from "../gateway/medidor.js";
import {
  ahorroDeRebaja,
  decidirRebaja,
  PRIMA_1H,
  PRIMA_5M,
  rebajarTtlDeCache,
  RitmoDeSesiones,
  UMBRAL_FRIO_MS,
} from "../gateway/tarifa.js";

/**
 * LA PALANCA DE TARIFA — la que ahorra dinero sin tocar un token.
 *
 * Se prueban las tres piezas por separado (rebaja del cuerpo, decisión por
 * ritmo, aritmética del ahorro) y luego el nudo que de verdad importa: que el
 * informe medido deje de escribir un 0 € estructural cuando la palanca actuó,
 * y que lo siga escribiendo cuando no.
 */

const cuerpoDe = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8");

const PETICION = {
  model: "claude-opus-5",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "hola", cache_control: { type: "ephemeral", ttl: "1h" } }],
    },
  ],
  system: [{ type: "text", text: "sistema", cache_control: { type: "ephemeral", ttl: "1h" } }],
  tools: [{ name: "leer", cache_control: { type: "ephemeral", ttl: "1h" } }],
};

describe("rebajarTtlDeCache", () => {
  it("reescribe a 5m todas las marcas de 1h — system, messages y tools", () => {
    const r = rebajarTtlDeCache(cuerpoDe(PETICION));
    expect(r).not.toBeNull();
    expect(r?.rebajadas).toBe(3);
    expect(r?.yaEran5m).toBe(0);
    const salida = JSON.parse(r!.cuerpo.toString("utf8"));
    expect(JSON.stringify(salida)).not.toContain('"1h"');
    expect(JSON.stringify(salida).match(/"ttl":"5m"/g)).toHaveLength(3);
  });

  it("NO toca un solo token del contenido: solo cambia el ttl", () => {
    const r = rebajarTtlDeCache(cuerpoDe(PETICION));
    const salida = JSON.parse(r!.cuerpo.toString("utf8"));
    const sinTtl = (o: unknown): unknown => JSON.parse(JSON.stringify(o).replace(/"ttl":"[^"]*"/g, '"ttl":"X"'));
    expect(sinTtl(salida)).toEqual(sinTtl(PETICION));
  });

  it("devuelve null —reenviar intacto— si no hay ni una marca de 1h", () => {
    expect(rebajarTtlDeCache(cuerpoDe({ model: "claude-opus-5", messages: [{ role: "user", content: "x" }] }))).toBeNull();
  });

  it("devuelve null ante cuerpo comprimido, JSON roto o forma que no es /v1/messages", () => {
    expect(rebajarTtlDeCache(cuerpoDe(PETICION), "zstd")).toBeNull();
    expect(rebajarTtlDeCache(Buffer.from("{no json", "utf8"))).toBeNull();
    expect(rebajarTtlDeCache(cuerpoDe({ model: "claude-opus-5" }))).toBeNull();
    expect(rebajarTtlDeCache(cuerpoDe([1, 2, 3]))).toBeNull();
  });

  it("cuenta como 5m preexistente tanto el ttl explícito como el ausente (defecto de la API)", () => {
    const mixto = {
      model: "claude-opus-5",
      messages: [
        { role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } }] },
        { role: "user", content: [{ type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "5m" } }] },
        { role: "user", content: [{ type: "text", text: "c", cache_control: { type: "ephemeral" } }] },
      ],
    };
    const r = rebajarTtlDeCache(cuerpoDe(mixto));
    expect(r?.rebajadas).toBe(1);
    expect(r?.yaEran5m).toBe(2);
  });
});

describe("decidirRebaja", () => {
  it("sesión nueva: rebaja (la primera escritura es la gorda y el 99,1 % encadena)", () => {
    expect(decidirRebaja({ ahoraMs: 1_000_000 })).toBe(true);
  });
  it("sesión caliente: rebaja", () => {
    expect(decidirRebaja({ ultimoTurnoMs: 1_000_000, ahoraMs: 1_000_000 + 30_000 })).toBe(true);
  });
  it("sesión que se demostró fría: NO rebaja — ahí la hora sí compra vida", () => {
    expect(decidirRebaja({ ultimoTurnoMs: 1_000_000, ahoraMs: 1_000_000 + UMBRAL_FRIO_MS })).toBe(false);
    expect(decidirRebaja({ ultimoTurnoMs: 1_000_000, ahoraMs: 1_000_000 + 10 * 60_000 })).toBe(false);
  });
});

describe("ahorroDeRebaja", () => {
  it("es la resta entre dos tarifas públicas sobre el MISMO conteo", () => {
    // 100.000 tokens de escritura a $0,005/1k de entrada: 2× = $1,00 · 1,25× = $0,625.
    const ahorro = ahorroDeRebaja({ cacheEscrita5m: 100_000, inputPer1k: 0.005, yaEran5m: 0 });
    expect(ahorro).toBeCloseTo(100 * 0.005 * (PRIMA_1H - PRIMA_5M), 10);
    expect(ahorro).toBeCloseTo(0.375, 10);
  });

  it("declara 0 —y no miente— si el cliente ya traía marcas de 5m propias", () => {
    expect(ahorroDeRebaja({ cacheEscrita5m: 100_000, inputPer1k: 0.005, yaEran5m: 1 })).toBe(0);
  });

  it("declara 0 sin escritura o sin precio", () => {
    expect(ahorroDeRebaja({ cacheEscrita5m: 0, inputPer1k: 0.005, yaEran5m: 0 })).toBe(0);
    expect(ahorroDeRebaja({ cacheEscrita5m: 100_000, inputPer1k: 0, yaEran5m: 0 })).toBe(0);
  });
});

describe("RitmoDeSesiones", () => {
  it("recuerda el último turno y olvida lo que ya no informa", () => {
    const r = new RitmoDeSesiones(3, 60_000);
    r.anotar("a", 1_000);
    expect(r.ultimo("a", 2_000)).toBe(1_000);
    expect(r.ultimo("a", 1_000 + 60_001)).toBeUndefined();
    expect(r.ultimo("desconocida", 2_000)).toBeUndefined();
  });

  it("está ACOTADA: un gateway de escritorio no crece sin techo", () => {
    const r = new RitmoDeSesiones(3, 60_000);
    for (const k of ["a", "b", "c", "d", "e"]) r.anotar(k, 1_000);
    expect(r.tamano).toBe(3);
    expect(r.ultimo("a", 1_000)).toBeUndefined();
    expect(r.ultimo("e", 1_000)).toBe(1_000);
  });
});

describe("el 0 € estructural del informe medido", () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 200_000,
    cache_creation_input_tokens: 100_000,
  };

  it("SIN palanca sigue escribiendo baseline == actual y netSavings 0", () => {
    const medido = costeMedido("claude-opus-5", usage);
    const inf = informeMedido("req-1", "claude-opus-5", medido!) as unknown as {
      cost: { baselineEstimate: number; actual: number; netSavings: number; basis: string };
    };
    expect(inf.cost.basis).toBe("measured");
    expect(inf.cost.netSavings).toBe(0);
    expect(inf.cost.baselineEstimate).toBe(inf.cost.actual);
  });

  it("CON palanca el baseline es el mismo usage a la tarifa que el cliente pidió", () => {
    const medido = costeMedido("claude-opus-5", usage);
    const inf = informeMedido("req-2", "claude-opus-5", medido!, undefined, null, {
      rebajadas: 3,
      yaEran5m: 0,
    }) as unknown as {
      cost: { baselineEstimate: number; actual: number; netSavings: number; basis: string };
    };
    // 100.000 tokens escritos a 1,25× en vez de 2×: $0,375 de sobrecoste evitado.
    expect(inf.cost.basis).toBe("measured");
    expect(inf.cost.baselineEstimate - inf.cost.actual).toBeCloseTo(0.375, 9);
    expect(inf.cost.netSavings).toBeGreaterThan(0);
    expect(inf.cost.netSavings).toBeLessThanOrEqual(1);
    expect(inf.cost.netSavings).toBeCloseTo(0.375 / inf.cost.baselineEstimate, 9);
  });

  it("con atribución sucia (marcas 5m del cliente) NO se cobra nada", () => {
    const medido = costeMedido("claude-opus-5", usage);
    const inf = informeMedido("req-3", "claude-opus-5", medido!, undefined, null, {
      rebajadas: 1,
      yaEran5m: 2,
    }) as unknown as { cost: { netSavings: number; baselineEstimate: number; actual: number } };
    expect(inf.cost.netSavings).toBe(0);
    expect(inf.cost.baselineEstimate).toBe(inf.cost.actual);
  });
});

describe("la costura entre las dos palancas", () => {
  it("componen sin pisarse: los diales añaden context_management, la tarifa rebaja el ttl", async () => {
    const { ajustarDiales } = await import("../gateway/palanca.js");
    const original = cuerpoDe(PETICION);
    const conDiales = ajustarDiales(original, undefined);
    expect(conDiales).not.toBeNull();
    // El cuerpo que sale de los diales es JSON plano: la codificación original
    // dejó de describirlo, por eso el servidor pasa "identity" a partir de aquí.
    const conAmbas = rebajarTtlDeCache(conDiales!, "identity");
    expect(conAmbas).not.toBeNull();
    const salida = JSON.parse(conAmbas!.cuerpo.toString("utf8"));
    expect(salida.context_management).toBeDefined();
    expect(JSON.stringify(salida)).not.toContain('"1h"');
    expect(conAmbas!.rebajadas).toBe(3);
  });

  it("la rebaja NO toca el cuerpo si llega comprimido — reenviar intacto manda", () => {
    expect(rebajarTtlDeCache(cuerpoDe(PETICION), "gzip")).toBeNull();
  });
});
