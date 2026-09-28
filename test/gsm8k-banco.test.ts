/**
 * La batería GSM8K sin red: el flujo, la extracción de la respuesta, las cuentas
 * y el arnés completo contra un proveedor falso. Nada aquí llama a un modelo.
 */
import { describe, expect, it } from "vitest";

import { conContador, medirModelo, PresupuestoAgotado, proveedorSeco, topeDeSalida } from "../benchmarks/publicados/gsm8k/arnes.js";
import { fabricaDeCapa, SinLicencia } from "../benchmarks/publicados/gsm8k/capa.js";
import {
  construirFlujo,
  extraerNumeroFinal,
  mensajeDeUsuario,
  oroDe,
  parafrasisSuperficie,
  varianteCifra,
  variantePalabra,
} from "../benchmarks/publicados/gsm8k/flujo.js";
import type { FilaGsm8k } from "../benchmarks/publicados/gsm8k/fuente.js";
import { resumir, type Ensayo } from "../benchmarks/publicados/gsm8k/medir.js";
import { preguntasSinRed, repetirSinRed } from "../benchmarks/publicados/gsm8k/sin-red.js";

const NOMBRES = ["Ana", "Luis", "Marta", "Pere", "Joan", "Eva", "Iker", "Nora", "Olga", "Raul"];
/** Un test sintético con la forma de GSM8K: cifras, números en letra y «####». */
function testSintetico(n = 60): FilaGsm8k[] {
  return Array.from({ length: n }, (_, i) => {
    const a = 3 + (i % 7);
    const b = 10 + i;
    return {
      question: `${NOMBRES[i % NOMBRES.length]} has ${b} marbles and buys two bags with ${a} marbles each. How many marbles does ${NOMBRES[i % NOMBRES.length]} have in total?`,
      answer: `${b} + 2*${a} = <<${b}+2*${a}=${b + 2 * a}>>${b + 2 * a}\n#### ${b + 2 * a}`,
    };
  });
}

describe("GSM8K: oro y respuesta final", () => {
  it("lee el oro tras ####, sin separadores de miles", () => {
    expect(oroDe("... \n#### 1,200")).toBe(1200);
    expect(oroDe("x\n#### -3")).toBe(-3);
    expect(() => oroDe("sin marca")).toThrow();
  });

  it("extrae el número tras el último ####, o el último número del texto", () => {
    expect(extraerNumeroFinal("so 5 + 3 = 8\n#### 8")).toBe(8);
    expect(extraerNumeroFinal("#### $1,234.50")).toBe(1234.5);
    expect(extraerNumeroFinal("The answer is 42.")).toBe(42);
    expect(extraerNumeroFinal("no numbers")).toBeNull();
  });
});

describe("GSM8K: plantillas", () => {
  it("la variante de cifra cambia el primer entero y la de palabra no toca dígitos", () => {
    expect(varianteCifra("A robe takes 2 bolts and 3.5 more")).toBe("A robe takes 3 bolts and 3.5 more");
    expect(varianteCifra("sin cifras")).toBeNull();
    expect(variantePalabra("She eats three eggs and Two more")).toBe("She eats four eggs and Two more");
    expect(variantePalabra("Twice a day")).toBe("Three times a day");
    expect(variantePalabra("nothing")).toBeNull();
  });

  it("la paráfrasis de superficie no toca cifras", () => {
    expect(parafrasisSuperficie("Ana has $1,200. How much?")).toBe("ana  has  $1,200.  how  much");
  });
});

describe("GSM8K: el flujo", () => {
  const test = testSintetico(150);

  it("con 100 únicos: 200 peticiones, 60 repeticiones y 10 de cada clase derivada", () => {
    const f = construirFlujo(test, { nUnicos: 100, semilla: 7 });
    expect(f.peticiones).toHaveLength(200);
    expect(f.cuenta).toEqual({
      original: 100,
      repeticion: 60,
      superficie: 10,
      lexica: 10,
      "variante-cifra": 10,
      "variante-palabra": 10,
    });
  });

  it("es determinista y cada derivada va DESPUÉS de su original", () => {
    const a = construirFlujo(test, { nUnicos: 40, semilla: 11 });
    const b = construirFlujo(test, { nUnicos: 40, semilla: 11 });
    expect(a.peticiones).toEqual(b.peticiones);
    const posOriginal = new Map(a.peticiones.filter((q) => q.clase === "original").map((q) => [q.familia, q.pos]));
    for (const q of a.peticiones) {
      if (q.clase !== "original") expect(q.pos).toBeGreaterThan(posOriginal.get(q.familia)!);
    }
  });

  it("las variantes no tienen oro y su texto difiere del original", () => {
    const f = construirFlujo(test, { nUnicos: 40, semilla: 3 });
    const orig = new Map(f.problemas.map((p) => [p.idx, p.pregunta]));
    for (const q of f.peticiones.filter((x) => x.clase.startsWith("variante"))) {
      expect(q.oro).toBeNull();
      expect(q.texto).not.toBe(orig.get(q.familia));
    }
  });
});

describe("GSM8K: las cuentas", () => {
  const base = (p: Partial<Ensayo>): Ensayo => ({
    pos: 0, familia: 0, clase: "original", oro: 5, huella: "h0", brazo: "A", numero: 5, correcto: true,
    coste: 1, llamadas: 1, entrada: 100, cacheada: 0, escrita: 0, salida: 10, latenciaMs: 10, fuente: "provider",
    ...p,
  });

  it("una variante servida de caché sin texto previo idéntico es un hallazgo grave; con texto previo, no", () => {
    const ensayos: Ensayo[] = [
      base({ pos: 0, brazo: "A" }),
      base({ pos: 0, brazo: "E", coste: 1 }),
      base({ pos: 1, brazo: "A", clase: "variante-palabra", oro: null, correcto: null, huella: "h1", numero: 7 }),
      base({ pos: 1, brazo: "E", clase: "variante-palabra", oro: null, correcto: null, huella: "h1", numero: 5, fuente: "semantic_cache", coste: 0, similitud: 0.97 }),
      base({ pos: 2, brazo: "A", clase: "variante-palabra", oro: null, correcto: null, huella: "h1", numero: 7 }),
      base({ pos: 2, brazo: "E", clase: "variante-palabra", oro: null, correcto: null, huella: "h1", numero: 5, fuente: "exact_cache", coste: 0 }),
    ];
    const r = resumir(ensayos);
    expect(r.variantesPorBrazo.E).toEqual({ n: 2, deCache: 2, deOtra: 1 });
    expect(r.variantesServidasDeOtra[0]).toMatchObject({ pos: 1, numeroServido: 5, numeroA: 7, numeroDelOriginal: 5 });
    const c = r.comparaciones.find((x) => x.brazo === "E")!;
    expect(c.costeA).toBe(3);
    expect(c.costeBrazo).toBe(1);
  });

  it("la caja corta ANTES de la llamada que la pasaría", async () => {
    const caja = { tope: 0.001, gasto: 0.0009, peorLlamada: 0.0005 };
    const c = { coste: 0, llamadas: 0, entrada: 0, cacheada: 0, escrita: 0, salida: 0 };
    let llamadas = 0;
    const p = conContador(
      { id: "x", generate: async () => { llamadas++; return { text: "#### 1", usage: { inputTokens: 1, outputTokens: 1 } }; } },
      "openai/gpt-4o-mini",
      caja,
      c,
    );
    await expect(p.generate({ model: "openai/gpt-4o-mini", messages: [] })).rejects.toBeInstanceOf(PresupuestoAgotado);
    expect(llamadas).toBe(0);
  });
});

describe("GSM8K: la capa y el arnés, sin red", () => {
  it("sin BIVELIO_LICENSE_KEY y sin --desde-fuente, aborta antes de gastar", async () => {
    await expect(fabricaDeCapa({ desdeFuente: false, env: {} })).rejects.toBeInstanceOf(SinLicencia);
  });

  it("ningún brazo declara tope de salida (la capa no puede llevarlo en texto libre)", () => {
    expect(topeDeSalida("openai/gpt-4o-mini")).toBeNull();
  });

  it("mide un modelo de punta a punta con el proveedor falso: A y los tres brazos con capa", async () => {
    const test = testSintetico(80);
    const f = construirFlujo(test, { nUnicos: 20, semilla: 20260928 });
    const oros = new Map<string, number>();
    for (const q of f.peticiones) if (q.oro !== null) oros.set(mensajeDeUsuario(q.texto), q.oro);
    const capa = await fabricaDeCapa({ desdeFuente: true, env: {} });
    const m = await medirModelo({
      model: "openai/gpt-4o-mini",
      test,
      sistema: "Solve it.\n\nQuestion: 1+1\nAnswer: 2\n#### 2",
      brazos: ["A", "B", "S", "E"],
      nUnicosMax: 20,
      topeUsd: 1.25,
      crudo: () => proveedorSeco(oros),
      host: null,
      runId: "test",
      capa,
    });
    expect(m.estado).toBe("medido");
    expect(m.peticionesCompletadas).toBe(40);
    const r = m.resumen!;
    expect(r.brazos.A!.exactitud.aciertos).toBe(r.brazos.A!.exactitud.n);
    // Las repeticiones exactas salen de la caché exacta en B: B llama menos que A.
    expect(r.brazos.B!.llamadasAlProveedor).toBeLessThan(r.brazos.A!.llamadasAlProveedor);
    expect(r.brazos.B!.fuentes["exact_cache"]).toBeGreaterThan(0);
    expect(m.gasto.totalUsd).toBeLessThan(1.25);
  });

  it("la repetición sin red recorre cada problema con sus derivadas", async () => {
    const test = testSintetico(12);
    const ps = preguntasSinRed(test, 1);
    expect(ps.filter((p) => p.clase === "original")).toHaveLength(12);
    const capa = await fabricaDeCapa({ desdeFuente: true, env: {} });
    const r = await repetirSinRed(ps, "defecto", "SYS", capa);
    expect(r.peticiones).toBe(ps.length);
    expect(r.erroneas).toBe(0);
  });
});
