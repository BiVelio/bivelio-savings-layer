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
 * LA CABECERA QUE NO VUELVE (herramientas + `system`, sin historial).
 *
 * Un `system` con la hora de cada petición (o un UUID v7, o un id de petición)
 * da una huella nueva en cada llamada: en la 1.2.3 se marcaban 60 de 60 y no se
 * leía ninguna (+21,6 % de factura). La 1.2.4 lo adivinaba con un detector de
 * «contenido mutable» y fallaba en los dos sentidos. Aquí no se adivina: se mira
 * si la cabecera VUELVE antes de que caduque su entrada de caché. Reloj
 * inyectado: el TTL se prueba sin esperar cinco minutos.
 */
describe("la verja mira si la cabecera vuelve antes de caducar", () => {
  const ENTRADA = { totalTokens: T, stablePrefixTokens: P, tier: ANTHROPIC_CACHE_TIER };
  const CLASE = "modelo+herramientas+fija";
  const MIN = 60_000;

  function conReloj(opts: ConstructorParameters<typeof VerjaDeCacheDePrefijo>[0] = {}) {
    let t = Date.UTC(2026, 10, 21, 10);
    const verja = new VerjaDeCacheDePrefijo({ ...opts, ahora: () => t });
    return { verja, pasar: (ms: number) => void (t += ms) };
  }

  /** Una petición: observa su cabecera, decide y, si marcó, apunta lo que contestó el proveedor. */
  function peticion(verja: VerjaDeCacheDePrefijo, cabecera: string, prefijo = cabecera, leido = 0): boolean {
    const vistazo = verja.observarCabecera({ clase: CLASE, huella: cabecera });
    const d = verja.decidir(prefijo, ENTRADA, vistazo);
    if (d.marcar) verja.registrar(prefijo, leido > 0 ? { cachedInputTokens: leido } : { cacheWriteInputTokens: P });
    return d.marcar;
  }

  // it.skip: regla apagada hasta la 1.2.5 (`VERJA_DE_CABECERAS_ACTIVA = false` en
  // src/economics/prefix-cache-gate.ts). Fija la regla encendida; vuelve con ella.
  it.skip("una cabecera nueva en cada petición: marca como la 1.2.3 hasta que las primeras caducan sin volver, y luego deja de marcar", () => {
    const { verja, pasar } = conReloj();
    const marcas: boolean[] = [];
    for (let i = 0; i < 600; i++) {
      marcas.push(peticion(verja, `hora-${i}`));
      pasar(2000);
    }
    // 5 min a 2 s por petición: la petición 150 (contando desde 0) llega justo
    // cuando la 0 caduca sin haber vuelto; en la 165 ya hay 16 maduras de un
    // solo uso (todas) y la clase es volátil.
    const primeraSinMarcar = marcas.indexOf(false);
    expect(primeraSinMarcar).toBe(150 + 15);
    expect(marcas.slice(0, primeraSinMarcar).every(Boolean)).toBe(true);
    expect(marcas.slice(primeraSinMarcar).some(Boolean)).toBe(false);
    expect(verja.estadoDeCabeceras(CLASE)!.volatil).toBe(true);
    // La razón dice lo que pasa, con la proporción medida.
    const v = verja.observarCabecera({ clase: CLASE, huella: "otra-nueva" });
    const d = verja.decidir("otra-nueva", ENTRADA, v);
    expect(d.marcar).toBe(false);
    expect(d.razon).toMatch(/not seen before: 100\.0% of the last 32 system prompts of this shape were never sent again/);
  });

  it("mientras ninguna ha podido caducar (sin reloj que avance) decide exactamente como la 1.2.3", () => {
    const { verja } = conReloj();
    const marcas = Array.from({ length: 5000 }, (_, i) => peticion(verja, `id-${i}`));
    expect(marcas.every(Boolean)).toBe(true);
    expect(verja.estadoDeCabeceras(CLASE)!.volatil).toBe(false);
  });

  it("sin cabecera (la llave estable del catálogo de herramientas) decide como siempre", () => {
    const { verja, pasar } = conReloj();
    for (let i = 0; i < 600; i++) {
      expect(verja.decidir(`h-${i}`, ENTRADA).marcar).toBe(true);
      verja.registrar(`h-${i}`, { cacheWriteInputTokens: P });
      pasar(2000);
    }
  });

  it("FALSO POSITIVO de la 1.2.4: 20 chats a la vez con su UUID de sesión en el system nunca dejan de marcarse", () => {
    const { verja, pasar } = conReloj();
    for (let turno = 0; turno < 30; turno++) {
      for (let chat = 0; chat < 20; chat++) {
        // El historial estrena huella de prefijo en cada turno; la cabecera, no.
        const marcada = peticion(verja, `sesion-${chat}`, `sesion-${chat}|turno-${turno}`, turno > 0 ? P : 0);
        expect(marcada).toBe(true);
        pasar(3000);
      }
    }
    const e = verja.estadoDeCabeceras(CLASE)!;
    expect(e.volatil).toBe(false);
    expect(e.repetidas).toBe(20);
  });

  it("FALSO POSITIVO de la 1.2.4: la fecha del día (y un número de cliente estable) se repiten y no cuentan como un solo uso", () => {
    const { verja, pasar } = conReloj();
    for (let i = 0; i < 400; i++) {
      // Una escritura y, desde ahí, lecturas: la verja por huella de la 1.2.3 sigue encendida.
      expect(peticion(verja, "Today is Sat, 21 Nov 2026", "fecha", i > 0 ? P : 0)).toBe(true);
      const cuenta = `Customer account ${1734567890 + (i % 10)}`;
      expect(peticion(verja, cuenta, cuenta, i >= 10 ? P : 0)).toBe(true);
      pasar(5000);
    }
    expect(verja.estadoDeCabeceras(CLASE)!.unSoloUso).toBe(0);
  });

  it("MUCHAS conversaciones a la vez no se confunden con un solo uso: 1.500 sesiones que llegan de golpe tras un rato tranquilo", () => {
    // Con «N peticiones sin volver» (N = 1.024) este caso se tomaba por un solo
    // uso y la factura pasaba de −27,4 % a −16,1 % (medido con un proveedor
    // falso). Con el TTL no puede: todas vuelven antes de caducar.
    const { verja, pasar } = conReloj();
    for (let s = 0; s < 12; s++) {
      pasar(30_000);
      peticion(verja, `tranquila-${s}`);
      peticion(verja, `tranquila-${s}`, `tranquila-${s}|2`);
    }
    const marcas: boolean[] = [];
    for (let turno = 0; turno < 2; turno++) {
      for (let s = 0; s < 1500; s++) {
        marcas.push(peticion(verja, `sesion-${s}`, `sesion-${s}|${turno}`));
        pasar(100);
      }
    }
    expect(marcas.every(Boolean)).toBe(true);
    expect(verja.estadoDeCabeceras(CLASE)).toMatchObject({ unSoloUso: 0, volatil: false });
  });

  it("una cabecera que vuelve justo antes de caducar se repite; justo después, no", () => {
    const { verja, pasar } = conReloj({ minimoDeMaduras: 1, memoriaDeMaduras: 1 });
    peticion(verja, "a");
    pasar(5 * MIN - 1);
    peticion(verja, "a");
    expect(verja.estadoDeCabeceras(CLASE)).toMatchObject({ seRepiten: 1, unSoloUso: 0, volatil: false });
    peticion(verja, "b");
    pasar(5 * MIN);
    peticion(verja, "b");
    expect(verja.estadoDeCabeceras(CLASE)).toMatchObject({ seRepiten: 0, unSoloUso: 1, volatil: true });
  });

  it("una petición que escribe a 1 h tarda una hora en contar como de un solo uso", () => {
    const { verja, pasar } = conReloj({ minimoDeMaduras: 1 });
    verja.observarCabecera({ clase: CLASE, huella: "larga" }).conTtl(60 * MIN);
    pasar(30 * MIN);
    verja.observarCabecera({ clase: CLASE, huella: "otra" });
    expect(verja.estadoDeCabeceras(CLASE)!.unSoloUso).toBe(0);
    pasar(29 * MIN);
    // A los 59 min «larga» vuelve: se repite (con 5 min habría contado como perdida).
    verja.observarCabecera({ clase: CLASE, huella: "larga" });
    expect(verja.estadoDeCabeceras(CLASE)).toMatchObject({ seRepiten: 1 });
  });

  // it.skip: regla apagada hasta la 1.2.5 (`VERJA_DE_CABECERAS_ACTIVA = false` en
  // src/economics/prefix-cache-gate.ts). Fija la regla encendida; vuelve con ella.
  it.skip("en modo volátil una cabecera ya vista se marca como en la 1.2.3, y lee", () => {
    const { verja, pasar } = conReloj();
    for (let i = 0; i < 200; i++) {
      peticion(verja, `hora-${i}`);
      pasar(2000);
    }
    expect(verja.estadoDeCabeceras(CLASE)!.volatil).toBe(true);
    // Primera vez: nunca vista en una clase volátil. No se marca.
    expect(peticion(verja, "estable")).toBe(false);
    pasar(2000);
    // Segunda: verla volver es la prueba, y es gratis.
    expect(peticion(verja, "estable")).toBe(true);
    for (let i = 0; i < 20; i++) {
      pasar(2000);
      expect(peticion(verja, "estable", "estable", P)).toBe(true);
    }
    expect(verja.estado("estable")!.tokensLeidos).toBe(20 * P);
  });

  it("1.2.4, regla apagada: en una clase volátil una cabecera nunca vista se marca como en la 1.2.3 (se sigue observando)", () => {
    const { verja, pasar } = conReloj();
    const marcas: boolean[] = [];
    for (let i = 0; i < 600; i++) {
      marcas.push(peticion(verja, `hora-${i}`));
      pasar(2000);
    }
    // La verja sigue viendo que la clase es volátil…
    expect(verja.estadoDeCabeceras(CLASE)!.volatil).toBe(true);
    // …pero decide como la 1.2.3: todas marcadas, también una nueva después.
    expect(marcas.every(Boolean)).toBe(true);
    expect(peticion(verja, "estable")).toBe(true);
    const v = verja.observarCabecera({ clase: CLASE, huella: "otra-nueva" });
    expect(verja.decidir("otra-nueva", ENTRADA, v).razon).not.toMatch(/not seen before/);
  });

  it("sale del modo volátil en cuanto vuelven a llegar cabeceras que se repiten", () => {
    const { verja, pasar } = conReloj();
    for (let i = 0; i < 200; i++) {
      peticion(verja, `hora-${i}`);
      pasar(2000);
    }
    expect(verja.estadoDeCabeceras(CLASE)!.volatil).toBe(true);
    // Diez sesiones nuevas, cada una con su cabecera estable, a 2 s entre peticiones.
    const marcas: boolean[] = [];
    for (let turno = 0; turno < 3; turno++) {
      for (let s = 0; s < 10; s++) {
        marcas.push(peticion(verja, `sesion-${s}`, `sesion-${s}|${turno}`));
        pasar(2000);
      }
    }
    expect(verja.estadoDeCabeceras(CLASE)!.volatil).toBe(false);
    // Del turno 2 en adelante todas marcan; las primeras del turno 1 no.
    expect(marcas.slice(10)).toEqual(Array(20).fill(true));
    // Y una sesión nueva vuelve a marcarse desde su primera petición.
    expect(peticion(verja, "sesion-nueva")).toBe(true);
  });

  it("evidencia fuerte: con menos de 16 maduras, o con menos del 90 % de un solo uso, no entra en modo volátil", () => {
    const { verja, pasar } = conReloj();
    // 15 de un solo uso: aún no.
    for (let i = 0; i < 15; i++) peticion(verja, `x-${i}`);
    pasar(5 * MIN);
    expect(peticion(verja, "y-0")).toBe(true);
    expect(verja.estadoDeCabeceras(CLASE)).toMatchObject({ unSoloUso: 15, volatil: false });
    // 4 de cada 32 se repiten (87,5 % de un solo uso): tampoco.
    const { verja: v2, pasar: p2 } = conReloj();
    for (let i = 0; i < 32; i++) {
      peticion(v2, i % 8 === 0 ? `r-${i}` : `u-${i}`);
      if (i % 8 === 0) peticion(v2, `r-${i}`);
    }
    p2(5 * MIN);
    expect(peticion(v2, "nueva")).toBe(true);
    expect(v2.estadoDeCabeceras(CLASE)).toMatchObject({ unSoloUso: 28, seRepiten: 4, volatil: false });
  });

  it("una clase no apaga a otra", () => {
    const { verja, pasar } = conReloj();
    for (let i = 0; i < 200; i++) {
      peticion(verja, `hora-${i}`);
      pasar(2000);
    }
    const v = verja.observarCabecera({ clase: "otro-modelo", huella: "nueva" });
    expect(verja.decidir("nueva", ENTRADA, v).marcar).toBe(true);
  });

  it("OpenAI (sin prima de escritura): la clase volátil no cambia nada", () => {
    const { verja, pasar } = conReloj();
    const SIN_PRIMA = { totalTokens: T, stablePrefixTokens: P, tier: OPENAI_CACHE_TIER };
    for (let i = 0; i < 400; i++) {
      const v = verja.observarCabecera({ clase: CLASE, huella: `hora-${i}` });
      expect(verja.decidir(`hora-${i}`, SIN_PRIMA, v).marcar).toBe(true);
      pasar(2000);
    }
  });

  it("un torrente de cabeceras de un solo uso no echa de la memoria a las que vuelven", () => {
    // 512 recordadas como mucho; llegan 300 cabeceras nuevas por TTL y 2.000 en total.
    const { verja, pasar } = conReloj({ maxHuellas: 512 });
    peticion(verja, "estable");
    pasar(1000);
    peticion(verja, "estable", "estable", P);
    for (let i = 0; i < 2000; i++) {
      peticion(verja, `hora-${i}`);
      pasar(1000);
      if (i % 100 === 0) peticion(verja, "estable", "estable", P);
    }
    expect(verja.estadoDeCabeceras(CLASE)!.volatil).toBe(true);
    // Sigue recordada (vista), así que se marca aunque la clase sea volátil.
    expect(peticion(verja, "estable", "estable", P)).toBe(true);
  });

  // Limitado a `estadoDeCabeceras` en la 1.2.4: el tope del registro de
  // prefijos (`huellasRecordadas`) se quitó porque olvidaba prefijos ya apagados
  // y los volvía a explorar (verificación 3: +17,65 % → +18,31 % frente a la
  // 1.2.3). Ese registro vuelve a no tener tope, como en la 1.2.3; un tope que no
  // olvide prefijos en exploración ni apagados queda para la 1.2.5.
  it("la memoria de cabeceras no crece con el número de peticiones", () => {
    const { verja, pasar } = conReloj({ maxHuellas: 100 });
    for (let i = 0; i < 5000; i++) {
      peticion(verja, `hora-${i}`);
      pasar(i % 2 === 0 ? 0 : 1000);
    }
    const e = verja.estadoDeCabeceras(CLASE)!;
    expect(e.pendientes + e.repetidas).toBeLessThanOrEqual(200);
  });

  it("1.2.4 como la 1.2.3: un prefijo apagado sigue apagado tras 5.000 prefijos nuevos (el registro no olvida)", () => {
    const { verja, pasar } = conReloj({ exploracion: 1, maxHuellas: 100 });
    // Se apaga: se marcó una vez y no leyó nada.
    expect(peticion(verja, "documento")).toBe(true);
    expect(peticion(verja, "documento")).toBe(false);
    for (let i = 0; i < 5000; i++) {
      peticion(verja, `suelta-${i}`);
      pasar(1000);
    }
    // Con el tope de la 1.2.4 candidata se olvidaba y volvía a pagar la prima.
    expect(peticion(verja, "documento")).toBe(false);
    expect(verja.estado("documento")!.marcadas).toBe(1);
    expect(verja.huellasRecordadas).toBe(5001);
  });
});
