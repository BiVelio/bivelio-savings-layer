import { describe, expect, it } from "vitest";

import {
  agregar,
  bootstrap,
  costeDeUso,
  DecisorComoElGateway,
  prepararCuerpo,
  simular,
  TTL_5M_MS,
  type PeticionTtl,
  type UsoTtl,
} from "../benchmarks/ttl/nucleo.js";
import { informeDe, restaurarAntesDelGateway, restaurarMarcas, usageDe, usoTtlDe } from "../benchmarks/ttl/replay.js";
import { rebajarTtlDeCache } from "../gateway/tarifa.js";
import { precioDeLista } from "../src/pricing/catalogo.js";

/**
 * El replay de la palanca de TTL contra fixtures SINTÉTICAS: cuerpos y usages
 * inventados. Jamás una captura real en el repo — es tráfico privado del dueño.
 */

const MIN = 60_000;
const T0 = Date.parse("2026-09-01T10:00:00.000Z");

function cuerpo(mensajes: string[], opciones: { ttl?: "1h" | "5m" | null; tools?: unknown[] } = {}): Buffer {
  const ttl = opciones.ttl === undefined ? "1h" : opciones.ttl;
  const marca = ttl === null ? { type: "ephemeral" } : { type: "ephemeral", ttl };
  const json = {
    model: "claude-fable-5",
    max_tokens: 1024,
    system: [{ type: "text", text: "Eres un asistente de pruebas.", cache_control: marca }],
    ...(opciones.tools ? { tools: opciones.tools } : {}),
    messages: mensajes.map((texto, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: texto, ...(i === mensajes.length - 1 ? { cache_control: marca } : {}) }],
    })),
  };
  return Buffer.from(JSON.stringify(json), "utf8");
}

const largo = (n: number, c = "x") => c.repeat(n);

describe("DecisorComoElGateway — la decisión con el código real de gateway/tarifa.ts", () => {
  it("rebaja el arranque, no el turno encadenado, y sí la compactación", () => {
    const d = new DecisorComoElGateway();
    const h1 = [largo(4000, "a")];
    const h2 = [...h1, largo(200, "b"), largo(200, "c")];
    const compactado = [largo(3000, "r")];

    const arranque = d.decidir(prepararCuerpo(cuerpo(h1)), "s1", T0);
    expect(arranque.rebajada).toBe(true);
    expect(arranque.fraccion).toBe(1);

    const encadenado = d.decidir(prepararCuerpo(cuerpo(h2)), "s1", T0 + MIN);
    expect(encadenado.rebajada).toBe(false);
    expect(encadenado.fraccion).toBeLessThan(0.3);
    expect(encadenado.hilo).toBe(arranque.hilo);

    const compactacion = d.decidir(prepararCuerpo(cuerpo(compactado)), "s1", T0 + 2 * MIN);
    expect(compactacion.rebajada).toBe(true);
  });

  it("sin marcas de 1h no hay nada que rebajar, aunque todo sea nuevo", () => {
    const d = new DecisorComoElGateway();
    expect(d.decidir(prepararCuerpo(cuerpo(["hola"], { ttl: null })), "s1", T0).rebajada).toBe(false);
    expect(d.decidir(prepararCuerpo(cuerpo(["hola"], { ttl: "5m" })), "s2", T0).rebajada).toBe(false);
  });

  it("con herramientas de servidor rebaja pero no acredita", () => {
    const d = new DecisorComoElGateway();
    const r = d.decidir(prepararCuerpo(cuerpo(["hola"], { tools: [{ type: "web_search_20250305", name: "web_search" }] })), "s1", T0);
    expect(r.rebajada).toBe(true);
    expect(r.herramientaDeServidor).toBe(true);
  });

  it("un cuerpo que no es /v1/messages viaja intacto", () => {
    const d = new DecisorComoElGateway();
    const r = d.decidir(prepararCuerpo(Buffer.from("no es json")), "s1", T0);
    expect(r.intacto).toBe(true);
    expect(r.rebajada).toBe(false);
  });

  it("sesión + system: dos sesiones con el mismo system son hilos distintos", () => {
    const d = new DecisorComoElGateway();
    const a = d.decidir(prepararCuerpo(cuerpo(["hola"])), "s1", T0);
    const b = d.decidir(prepararCuerpo(cuerpo(["hola"])), "s2", T0);
    expect(a.hilo).not.toBe(b.hilo);
    expect(a.prefijoComun).toBe(b.prefijoComun);
  });
});

const uso = (u: Partial<UsoTtl>): UsoTtl => ({ entrada: 0, lectura: 0, escritura5m: 0, escritura1h: 0, escrituraSinDesglose: 0, salida: 0, ...u });

function pet(atMs: number, u: Partial<UsoTtl>, rebajada: boolean, extra: Partial<PeticionTtl> = {}): PeticionTtl {
  return {
    atMs,
    sesion: "s1",
    hilo: "s1:sys",
    prefijoComun: "tools:sys",
    modelo: "claude-fable-5",
    uso: uso(u),
    rebajada,
    yaEran5m: 0,
    herramientaDeServidor: false,
    ...extra,
  };
}

// fable-5: $0,01/1K de entrada, lectura $0,001/1K (catálogo). Por token:
const IN = 0.01 / 1000;
const RD = 0.001 / 1000;

describe("simular — la factura con y sin la palanca", () => {
  it("el catálogo no repite la fe de erratas del 06-09: fable-5 a $10/MTok", () => {
    expect(precioDeLista("claude-fable-5", T0)?.inputPer1k).toBe(0.01);
  });

  it("la línea base es el usage facturado, a las primas públicas", () => {
    const p = { entradaPorToken: IN, lecturaPorToken: RD, salidaPorToken: 0.05 / 1000 };
    const c = costeDeUso(uso({ entrada: 1000, lectura: 10_000, escritura5m: 1000, escritura1h: 1000, salida: 100 }), p);
    expect(c).toBeCloseTo(1000 * IN + 10_000 * RD + 1000 * IN * 1.25 + 1000 * IN * 2 + 100 * 0.05 / 1000, 12);
  });

  it("un arranque rebajado ahorra 0,75× la entrada sobre lo escrito a 1h", () => {
    const [f] = simular([pet(T0, { escritura1h: 100_000 }, true)], { prefijoCompartido: false });
    expect(f!.ahorroPrima).toBeCloseTo(100_000 * IN * 0.75, 10);
    expect(f!.ahorroAcreditable).toBeCloseTo(f!.ahorroPrima, 10);
    expect(f!.costeFallos).toBe(0);
  });

  it("el turno siguiente a más de 5 min reescribe lo que la entrada de 5m cubría, a 2× (no se rebaja)", () => {
    const filas = simular(
      [
        pet(T0, { lectura: 20_000, escritura1h: 80_000 }, true),
        pet(T0 + 10 * MIN, { lectura: 100_000, escritura1h: 2_000 }, false),
      ],
      { prefijoCompartido: false },
    );
    // La base leyó 100K; 20K estaban bajo 1h (lo que el arranque leyó), 80K bajo la entrada de 5m.
    expect(filas[1]!.tokensPerdidos).toBe(80_000);
    expect(filas[1]!.costeFallos).toBeCloseTo(80_000 * (IN * 2 - RD), 10);
    const a = agregar(filas);
    expect(a.fallos).toBe(1);
    expect(a.neto).toBeCloseTo(80_000 * IN * 0.75 - 80_000 * (IN * 2 - RD), 10);
  });

  it("con la aritmética del 06-09 el mismo fallo se cobra a 1,25×", () => {
    const filas = simular(
      [pet(T0, { escritura1h: 80_000 }, true), pet(T0 + 10 * MIN, { lectura: 80_000 }, false)],
      { prefijoCompartido: false, primaFallo: "5m" },
    );
    expect(filas[1]!.costeFallos).toBeCloseTo(80_000 * (IN * 1.25 - RD), 10);
  });

  it("dentro de los 5 min no hay fallo; pasada la hora tampoco (la base también habría fallado)", () => {
    for (const hueco of [TTL_5M_MS, 61 * MIN]) {
      const filas = simular([pet(T0, { escritura1h: 80_000 }, true), pet(T0 + hueco, { lectura: 80_000 }, false)], { prefijoCompartido: false });
      expect(filas[1]!.fallo).toBe(false);
    }
  });

  it("tras un turno NO rebajado el prefijo vuelve a estar bajo 1h: la ventana de riesgo dura un turno", () => {
    const filas = simular(
      [
        pet(T0, { escritura1h: 80_000 }, true),
        pet(T0 + MIN, { lectura: 80_000, escritura1h: 1_000 }, false),
        pet(T0 + 30 * MIN, { lectura: 81_000, escritura1h: 1_000 }, false),
      ],
      { prefijoCompartido: false },
    );
    expect(filas.map((f) => f.fallo)).toEqual([false, false, false]);
  });

  it("variante conservadora: un arranque que leía la entrada de OTRO hilo la pierde si el último arranque fue hace > 5 min", () => {
    const otro = { sesion: "s2", hilo: "s2:sys" };
    const peticiones = [pet(T0, { escritura1h: 30_000 }, true), pet(T0 + 20 * MIN, { lectura: 30_000, escritura1h: 500 }, true, otro)];
    expect(simular(peticiones, { prefijoCompartido: false })[1]!.fallo).toBe(false);
    const f = simular(peticiones, { prefijoCompartido: true })[1]!;
    expect(f.falloEntreHilos).toBe(true);
    expect(f.costeFallos).toBeCloseTo(30_000 * (IN * 1.25 - RD), 10);
  });

  it("un modelo sin precio queda fuera de las sumas y se cuenta", () => {
    const a = agregar(simular([pet(T0, { escritura1h: 1000 }, true, { modelo: "modelo-inventado-9" })], { prefijoCompartido: false }));
    expect(a.sinPrecio).toBe(1);
    expect(a.peticiones).toBe(0);
  });
});

describe("bootstrap por cluster", () => {
  const peticiones = Array.from({ length: 40 }, (_, i) =>
    pet(T0 + i * 3_600_000 * 6, { escritura1h: 10_000 + i * 1000, lectura: 50_000 }, i % 3 === 0, { sesion: `s${i % 8}`, hilo: `s${i % 8}:sys` }),
  );
  const filas = simular(peticiones, { prefijoCompartido: false });

  it("es determinista y contiene la estimación puntual", () => {
    const a = bootstrap(filas, "sesion", 2000);
    const b = bootstrap(filas, "sesion", 2000);
    expect(a).toEqual(b);
    expect(a.clusters).toBe(8);
    const punto = agregar(filas);
    expect(a.netoUsd[0]).toBeLessThanOrEqual(punto.neto);
    expect(a.netoUsd[1]).toBeGreaterThanOrEqual(punto.neto);
    expect(bootstrap(filas, "dia", 2000).clusters).toBe(new Set(filas.map((f) => f.dia)).size);
  });

  it("el informe no lleva ids de sesión, ni hasheados", () => {
    const texto = JSON.stringify(informeDe(filas, 200));
    for (let i = 0; i < 8; i++) expect(texto).not.toContain(`"s${i}`);
    expect(texto).not.toContain("sys");
  });
});

describe("lectura de la captura", () => {
  it("fusiona el usage del SSE: message_delta pisa, el desglose por TTL se fusiona", () => {
    const u = usageDe({
      sse: {
        usage: [
          { usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 50 } } },
          { usage: { output_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 0 } } },
        ],
      },
    });
    expect(usoTtlDe(u!)).toEqual({ entrada: 3, lectura: 100, escritura5m: 0, escritura1h: 50, escrituraSinDesglose: 0, salida: 7 });
  });

  it("una escritura sin desglose por TTL se queda en 5m (sin ahorro que acreditar)", () => {
    expect(usoTtlDe({ cache_creation_input_tokens: 40 }).escrituraSinDesglose).toBe(40);
  });
});

describe("la línea base de un tramo grabado DETRÁS del gateway", () => {
  it("deshace exactamente lo que hizo rebajarTtlDeCache, y nada más", () => {
    const original = JSON.parse(cuerpo(["hola", "qué tal", "bien"]).toString("utf8")) as Record<string, unknown>;
    const rebajado = JSON.parse(rebajarTtlDeCache(structuredClone(original))!.cuerpo.toString("utf8")) as Record<string, unknown>;
    expect(JSON.stringify(rebajado)).not.toEqual(JSON.stringify(original));
    expect(restaurarMarcas(rebajado)).toBe(true);
    expect(rebajado).toEqual(original);
  });

  it("no toca marcas sin ttl (el 5m del cliente) ni cuerpos con alguna de 1h", () => {
    const sinTtl = JSON.parse(cuerpo(["hola"], { ttl: null }).toString("utf8")) as Record<string, unknown>;
    expect(restaurarMarcas(sinTtl)).toBe(false);
    const de1h = JSON.parse(cuerpo(["hola"]).toString("utf8")) as Record<string, unknown>;
    expect(restaurarMarcas(de1h)).toBe(false);
  });

  it("devuelve la escritura de 5m a 1h y deshace el fallo que la rebaja real provocó", () => {
    const pets = [
      { atMs: T0, hilo: "h", modelo: "claude-fable-5", uso: uso({ lectura: 20_000, escritura5m: 80_000 }), rebajadaEnOrigen: true },
      // 10 min después: la entrada de 5m caducó y el turno reescribió 80K a 1h.
      { atMs: T0 + 10 * MIN, hilo: "h", modelo: "claude-fable-5", uso: uso({ lectura: 20_000, escritura1h: 82_000 }), rebajadaEnOrigen: false },
    ];
    const real = restaurarAntesDelGateway(pets)["claude-fable-5"]!;
    expect(pets[0]!.uso).toEqual(uso({ lectura: 20_000, escritura1h: 80_000 }));
    expect(pets[1]!.uso).toEqual(uso({ lectura: 100_000, escritura1h: 2_000 }));
    expect(real.rebajas).toBe(1);
    expect(real.bruto).toBeCloseTo(80_000 * IN * 0.75, 10);
    expect(real.fallos).toBe(1);
    expect(real.costeFallos).toBeCloseTo(80_000 * (IN * 2 - RD), 10);
  });
});
