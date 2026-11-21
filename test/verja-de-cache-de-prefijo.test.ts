import { describe, it, expect } from "vitest";

import {
  costeEsperado,
  ANTHROPIC_CACHE_TIER,
  OPENAI_CACHE_TIER,
} from "../src/economics/cache-tier.js";
import {
  umbralDeMarcado,
  VerjaDeCacheDePrefijo,
} from "../src/economics/prefix-cache-gate.js";

/**
 * LA VERJA QUE IMPIDE PERDER DINERO MARCANDO LA CACHÉ.
 *
 * Marcar no es gratis: la escritura lleva prima. Con lectura a 0,10x y escritura
 * a 1,25x, marcar compensa sólo si la tasa de aciertos h cumple
 *
 *     h·0,10 + (1−h)·1,25 < 1   =>   h > 0,25/1,15 = 0,217391…
 *
 * Los tests de abajo no dan esa cifra por buena: la COMPRUEBAN contra
 * `costeEsperado`, que es quien de verdad tarifa. Una constante que sólo se
 * compara consigo misma no prueba nada.
 */

const T = 4000; // tokens del prompt entero
const P = 3000; // tokens del prefijo estable

describe("el punto de equilibrio de marcar la caché", () => {
  it("está en 21,74%, y se comprueba contra el tarifador, no contra sí mismo", () => {
    const h = umbralDeMarcado({
      totalTokens: T,
      stablePrefixTokens: P,
      tier: ANTHROPIC_CACHE_TIER,
    })!;
    expect(h).toBeCloseTo(0.25 / 1.15, 6);
    expect(h).toBeCloseTo(0.2174, 4);

    // JUSTO POR DEBAJO marcar sale MÁS CARO que no marcar; justo por encima,
    // más barato. `costeEsperado(total, prefijo, h, tier)` es marcar;
    // `totalTokens` a secas es no marcar (todo a precio lleno).
    expect(costeEsperado(T, P, h - 0.01, ANTHROPIC_CACHE_TIER)).toBeGreaterThan(T);
    expect(costeEsperado(T, P, h + 0.01, ANTHROPIC_CACHE_TIER)).toBeLessThan(T);
    expect(costeEsperado(T, P, h, ANTHROPIC_CACHE_TIER)).toBeCloseTo(T, 6);
  });

  it("con 0% de aciertos marcar cuesta un 25% más del prefijo", () => {
    // La prima de escritura, desnuda: 3000 tokens escritos a 1,25x = 750 de más.
    expect(costeEsperado(T, P, 0, ANTHROPIC_CACHE_TIER) - T).toBeCloseTo(0.25 * P, 6);
  });

  it("sin prima de escritura no hay umbral: marcar no puede perder", () => {
    // OpenAI cobra la escritura a 1x. Ahí la verja no tiene nada que vigilar.
    expect(
      umbralDeMarcado({ totalTokens: T, stablePrefixTokens: P, tier: OPENAI_CACHE_TIER }),
    ).toBeNull();
  });

  it("por debajo del mínimo de tramo tampoco hay umbral: marcar no hace nada", () => {
    expect(
      umbralDeMarcado({ totalTokens: 500, stablePrefixTokens: 400, tier: ANTHROPIC_CACHE_TIER }),
    ).toBeNull();
  });
});

describe("la verja mide antes de juzgar", () => {
  const ENTRADA = { totalTokens: T, stablePrefixTokens: P, tier: ANTHROPIC_CACHE_TIER };

  it("explora un número ACOTADO de peticiones, porque h no se puede saber sin marcar", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 3 });
    for (let i = 0; i < 3; i++) {
      expect(verja.decidir("h1", ENTRADA).marcar).toBe(true);
      // El proveedor no acierta NUNCA: sólo escribe.
      verja.registrar("h1", { cacheWriteInputTokens: P });
    }
    // Con la medición hecha, la verja se apaga: seguir marcando sería pagar la
    // prima a cambio de nada, en cada petición, para siempre.
    const d = verja.decidir("h1", ENTRADA);
    expect(d.marcar).toBe(false);
    expect(d.observada).toBe(0);
    expect(d.razon).toMatch(/did not reach/);
  });

  it("el coste máximo de esa exploración está acotado y se puede publicar", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 8 });
    // 8 escrituras a 0,25 de prima sobre 3000 tokens de prefijo.
    expect(verja.costeDeExploracion(P, ANTHROPIC_CACHE_TIER)).toBeCloseTo(8 * 0.25 * P, 6);
    // Con OpenAI explorar es gratis: no hay prima que pagar.
    expect(verja.costeDeExploracion(P, OPENAI_CACHE_TIER)).toBe(0);
  });

  it("con aciertos POR ENCIMA del equilibrio sigue marcando", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 2 });
    verja.decidir("h2", ENTRADA);
    verja.registrar("h2", { cacheWriteInputTokens: P });
    verja.decidir("h2", ENTRADA);
    // 3 lecturas por 1 escritura = 75% de aciertos, muy por encima del 21,7%.
    verja.registrar("h2", { cachedInputTokens: P * 3 });

    const d = verja.decidir("h2", ENTRADA);
    expect(d.marcar).toBe(true);
    expect(d.observada).toBeCloseTo(0.75, 6);
  });

  it("con aciertos POR DEBAJO del equilibrio deja de marcar", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 2 });
    verja.decidir("h3", ENTRADA);
    verja.registrar("h3", { cacheWriteInputTokens: 900 });
    verja.decidir("h3", ENTRADA);
    verja.registrar("h3", { cachedInputTokens: 100 }); // 100/1000 = 10%

    const d = verja.decidir("h3", ENTRADA);
    expect(d.observada).toBeCloseTo(0.1, 6);
    expect(d.observada!).toBeLessThan(d.umbral!);
    expect(d.marcar).toBe(false);
  });

  it("la tasa se mide en TOKENS, no en peticiones", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 1 });
    verja.decidir("h4", ENTRADA);
    // «Acertó algo» en las dos peticiones -> contando PETICIONES daría 100%.
    // Pero sólo 10 de 1010 tokens se sirvieron baratos: 1%, muy por debajo del
    // equilibrio. Lo que decide el dinero es la fracción de TOKENS.
    verja.registrar("h4", { cachedInputTokens: 10, cacheWriteInputTokens: 1000 });
    const d = verja.decidir("h4", ENTRADA);
    expect(d.observada).toBeCloseTo(10 / 1010, 6);
    expect(d.marcar).toBe(false);
  });

  it("sin prefijo estable no se marca, por bueno que sea el tramo", () => {
    const verja = new VerjaDeCacheDePrefijo();
    const d = verja.decidir("h5", { ...ENTRADA, stablePrefixTokens: 0 });
    expect(d.marcar).toBe(false);
    expect(d.razon).toMatch(/no stable prefix/);
  });

  it("cada prefijo aprende por su cuenta", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 1 });
    verja.decidir("bueno", ENTRADA);
    verja.registrar("bueno", { cachedInputTokens: 1000 });
    verja.decidir("malo", ENTRADA);
    verja.registrar("malo", { cacheWriteInputTokens: 1000 });

    // Un prefijo que no acierta no puede apagar el de al lado: son tráficos
    // distintos y el dinero de cada uno se decide por separado.
    expect(verja.decidir("bueno", ENTRADA).marcar).toBe(true);
    expect(verja.decidir("malo", ENTRADA).marcar).toBe(false);
  });

  it("una vez apagada se queda apagada, sin volver a pagar la exploración", () => {
    const verja = new VerjaDeCacheDePrefijo({ exploracion: 1 });
    verja.decidir("h6", ENTRADA);
    verja.registrar("h6", { cacheWriteInputTokens: 1000 });
    expect(verja.decidir("h6", ENTRADA).marcar).toBe(false);
    for (let i = 0; i < 20; i++) {
      expect(verja.decidir("h6", ENTRADA).marcar).toBe(false);
    }
  });
});

/**
 * EL PREFIJO QUE CAMBIA EN CADA PETICIÓN (fecha y hora, UUID, epoch en el `system`).
 *
 * La huella lleva el texto del prefijo, así que cada petición trae una huella
 * nueva y la exploración volvía a empezar en 0/8: 60 de 60 peticiones marcadas,
 * 0 lecturas, +21,6 % de factura frente a no llevar capa (medido con un
 * proveedor falso contra la 1.2.3). La clase —la huella sin el texto— es lo que
 * acota ese experimento.
 */
describe("un prefijo que cambia en cada petición deja de marcarse", () => {
  const ENTRADA = { totalTokens: T, stablePrefixTokens: P, tier: ANTHROPIC_CACHE_TIER };
  const CLASE = "modelo+herramientas+cabecera";

  /** Manda `n` peticiones con una huella distinta cada una; el proveedor solo escribe. */
  function mandarDistintas(verja: VerjaDeCacheDePrefijo, n: number, desde = 0, conClase = true): boolean[] {
    const clase = conClase ? CLASE : undefined;
    const marcas: boolean[] = [];
    for (let i = desde; i < desde + n; i++) {
      const d = verja.decidir(`fecha-${i}`, ENTRADA, clase);
      marcas.push(d.marcar);
      if (d.marcar) verja.registrar(`fecha-${i}`, { cacheWriteInputTokens: P }, clase);
    }
    return marcas;
  }

  it("de 60 peticiones marca 8 y no 60: el fallo medido", () => {
    const verja = new VerjaDeCacheDePrefijo();
    const marcas = mandarDistintas(verja, 60);
    expect(marcas.slice(0, 8)).toEqual(Array(8).fill(true));
    expect(marcas.slice(8)).toEqual(Array(52).fill(false));
    // El sobrecoste es el de UNA exploración, no un 25 % del prefijo para siempre.
    const prima = marcas.filter(Boolean).length * 0.25 * P;
    expect(prima).toBeCloseTo(verja.costeDeExploracion(P, ANTHROPIC_CACHE_TIER), 6);
  });

  it("la razón dice qué pasa y qué hará la capa", () => {
    const verja = new VerjaDeCacheDePrefijo();
    mandarDistintas(verja, 8);
    const d = verja.decidir("fecha-nueva", ENTRADA, CLASE);
    expect(d.marcar).toBe(false);
    expect(d.observada).toBe(0);
    expect(d.razon).toMatch(/differs on every request/);
    expect(d.razon).toMatch(/re-probing in 63 requests/);
  });

  it("sin clase decide como siempre: cada huella nueva explora (la llave estable del catálogo de herramientas)", () => {
    // Quien llama sin clase usa llaves que NO llevan el texto del prefijo; para
    // ellas el comportamiento no cambia.
    const verja = new VerjaDeCacheDePrefijo();
    expect(mandarDistintas(verja, 60, 0, false)).toEqual(Array(60).fill(true));
  });

  it("vuelve a probar de vez en cuando, cada vez más espaciado", () => {
    const verja = new VerjaDeCacheDePrefijo();
    const marcas = mandarDistintas(verja, 2000);
    const donde = marcas.flatMap((m, i) => (m ? [i] : []));
    // 8 de exploración; 64 sin marcar y 8 de reintento; 128 y 8; 256 y 8; 512 y 8; 1024…
    const esperado = [
      ...Array.from({ length: 8 }, (_, k) => k),
      ...Array.from({ length: 8 }, (_, k) => 8 + 64 + k),
      ...Array.from({ length: 8 }, (_, k) => 80 + 128 + k),
      ...Array.from({ length: 8 }, (_, k) => 216 + 256 + k),
      ...Array.from({ length: 8 }, (_, k) => 480 + 512 + k),
    ];
    expect(donde).toEqual(esperado);
    // 40 marcas de 2000: un 2 % de las peticiones paga la prima, no el 100 %.
    expect(donde.length).toBe(40);
  });

  it("el intervalo de reintento tiene techo: a la larga, 8 marcas por cada 1024 sin marcar", () => {
    const verja = new VerjaDeCacheDePrefijo();
    mandarDistintas(verja, 5000);
    expect(verja.estadoDeLaClase(CLASE)!.intervalo).toBe(1024);
    const marcas = mandarDistintas(verja, 1032 * 3, 5000);
    expect(marcas.filter(Boolean).length).toBe(24);
  });

  it("un prefijo que SÍ se repite se marca desde su segunda petición, aunque su clase esté apagada", () => {
    const verja = new VerjaDeCacheDePrefijo();
    mandarDistintas(verja, 20);
    // Primera vez: huella nunca vista en una clase apagada. No se marca.
    expect(verja.decidir("estable", ENTRADA, CLASE).marcar).toBe(false);
    // Segunda: verla repetirse es la prueba que faltaba, y es gratis.
    const d = verja.decidir("estable", ENTRADA, CLASE);
    expect(d.marcar).toBe(true);
    expect(d.razon).toMatch(/sent before/);
    verja.registrar("estable", { cacheWriteInputTokens: P }, CLASE);
    // A partir de aquí decide con su propio contador, como cualquier prefijo.
    for (let i = 0; i < 30; i++) {
      expect(verja.decidir("estable", ENTRADA, CLASE).marcar).toBe(true);
      verja.registrar("estable", { cachedInputTokens: P }, CLASE);
    }
    expect(verja.estado("estable")!.tokensLeidos).toBe(30 * P);
  });

  it("un prefijo estable con mucho tráfico no tapa al que cambia en la misma clase", () => {
    const verja = new VerjaDeCacheDePrefijo();
    // 200 peticiones del estable: 1 escritura y 199 lecturas.
    for (let i = 0; i < 200; i++) {
      expect(verja.decidir("estable", ENTRADA, CLASE).marcar).toBe(true);
      verja.registrar("estable", i === 0 ? { cacheWriteInputTokens: P } : { cachedInputTokens: P }, CLASE);
    }
    // Y ahora, en la misma clase, un system con fecha: se apaga igual de pronto.
    // (8 escrituras sin lectura contra la única lectura que el estable aportó
    // a la clase antes de dejar de contar: 1/10 < 21,7 %.)
    const marcas = mandarDistintas(verja, 60);
    expect(marcas.filter(Boolean).length).toBeLessThanOrEqual(8);
    expect(marcas.slice(8)).toEqual(Array(52).fill(false));
    // El estable sigue marcando y leyendo.
    expect(verja.decidir("estable", ENTRADA, CLASE).marcar).toBe(true);
  });

  it("muchos prefijos estables distintos (un system por cliente) no apagan la clase", () => {
    const verja = new VerjaDeCacheDePrefijo();
    for (let c = 0; c < 200; c++) {
      for (let i = 0; i < 5; i++) {
        expect(verja.decidir(`cliente-${c}`, ENTRADA, CLASE).marcar).toBe(true);
        verja.registrar(`cliente-${c}`, i === 0 ? { cacheWriteInputTokens: P } : { cachedInputTokens: P }, CLASE);
      }
    }
  });

  it("un historial que crece (huella nueva en cada paso, pero el paso lee lo anterior) sigue marcándose", () => {
    const verja = new VerjaDeCacheDePrefijo();
    const H = "modelo+herramientas+historial";
    for (let paso = 0; paso < 200; paso++) {
      const d = verja.decidir(`paso-${paso}`, ENTRADA, H);
      expect(d.marcar).toBe(true);
      // Cada paso lee el prefijo del anterior y escribe solo lo nuevo.
      verja.registrar(`paso-${paso}`, paso === 0 ? { cacheWriteInputTokens: P } : { cachedInputTokens: P, cacheWriteInputTokens: 300 }, H);
    }
  });

  it("si en un reintento las huellas nuevas vuelven a leerse, la clase se enciende otra vez", () => {
    const verja = new VerjaDeCacheDePrefijo();
    const H = "modelo+herramientas+historial";
    // Una racha en la que nada se lee (p. ej. turnos separados más que el TTL).
    for (let i = 0; i < 8 + 64; i++) {
      const d = verja.decidir(`frio-${i}`, ENTRADA, H);
      if (d.marcar) verja.registrar(`frio-${i}`, { cacheWriteInputTokens: P }, H);
    }
    // Toca reintento, y ahora cada paso lee el anterior.
    for (let i = 0; i < 8; i++) {
      const d = verja.decidir(`templado-${i}`, ENTRADA, H);
      expect(d.marcar).toBe(true);
      // La primera es de reintento; en cuanto la clase supera el equilibrio
      // las siguientes ya son exploración normal.
      if (i === 0) expect(d.razon).toMatch(/re-probing/);
      verja.registrar(`templado-${i}`, { cachedInputTokens: P, cacheWriteInputTokens: 300 }, H);
    }
    for (let i = 0; i < 100; i++) {
      const d = verja.decidir(`caliente-${i}`, ENTRADA, H);
      expect(d.marcar).toBe(true);
      verja.registrar(`caliente-${i}`, { cachedInputTokens: P, cacheWriteInputTokens: 300 }, H);
    }
    // Y el siguiente apagón, si llega, vuelve a empezar por el intervalo corto.
    expect(verja.estadoDeLaClase(H)!.intervalo).toBe(64);
  });

  it("una clase no apaga a otra", () => {
    const verja = new VerjaDeCacheDePrefijo();
    mandarDistintas(verja, 60);
    expect(verja.decidir("otra-huella", ENTRADA, "otro-modelo").marcar).toBe(true);
  });

  it("un proveedor que no reporta tokens de caché no dice nada de la clase", () => {
    // Sin escritura no hay prima que evitar: esas respuestas no cuentan.
    const verja = new VerjaDeCacheDePrefijo();
    for (let i = 0; i < 60; i++) {
      expect(verja.decidir(`mudo-${i}`, ENTRADA, CLASE).marcar).toBe(true);
      verja.registrar(`mudo-${i}`, {}, CLASE);
    }
    expect(verja.estadoDeLaClase(CLASE)).toBeUndefined();
  });

  it("la memoria no crece con el número de peticiones", () => {
    // Antes: una entrada por petición, para siempre.
    const verja = new VerjaDeCacheDePrefijo({ maxHuellas: 100 });
    mandarDistintas(verja, 5000);
    expect(verja.huellasRecordadas).toBeLessThanOrEqual(200);
  });
});
