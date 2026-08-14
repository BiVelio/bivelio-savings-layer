import { describe, it, expect } from "vitest";

import { CATALOGO, precioDeLista } from "../src/pricing/catalogo.js";
import {
  CAPTURA_OBJETIVO,
  PARES_POR_DEFECTO,
  VerjaDeCascada,
  economiaDelPar,
  equilibrioDeEscalado,
  escaladoMaximo,
  modeloBarato,
  razonDeCoste,
  razonPeorCaso,
  tablaDePares,
} from "../src/economics/cascada-de-modelos.js";
import type { CostModel } from "../src/tokenizer/accounting.js";

/**
 * LA ARITMÉTICA DE LA CASCADA, DERIVADA DEL CATÁLOGO Y NO COPIADA DE ÉL.
 *
 * La tabla de go/no-go se escribió a mano una vez, en la nota de diseño. Si aquí
 * volviera a escribirse a mano, el día que un proveedor baje un precio habría dos
 * tablas: la del catálogo, que es la que cobra, y la de la nota, que es la que
 * decide. Este fichero calcula la tabla desde `CATALOGO` y comprueba las cifras
 * que la nota afirma, así que un cambio de precio que rompa un par lo pone rojo
 * en vez de dejarlo mintiendo.
 */

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const precio = (m: string): CostModel => {
  const p = precioDeLista(m);
  if (!p) throw new Error(`el catálogo no tiene "${m}"`);
  return p;
};

describe("la tabla de go/no-go sale del catálogo", () => {
  // Exactamente los pares de la nota de diseño, con su `r` esperada. Lo que se
  // comprueba no son estas cifras: es que salgan de los precios publicados.
  const ESPERADO: ReadonlyArray<readonly [string, string, number]> = [
    ["gpt-4o", "gpt-4o-mini", 0.06],
    ["gpt-4.1", "gpt-4.1-nano", 0.05],
    ["gpt-4.1", "gpt-4.1-mini", 0.2],
    ["claude-opus-4", "claude-haiku-4-5", 0.067],
    ["claude-sonnet-4", "claude-haiku-4-5", 0.333],
    ["gpt-4o-mini", "gpt-4.1-nano", 0.667],
    ["claude-haiku-4-5", "claude-3-5-haiku", 0.8],
  ];

  it.each(ESPERADO)("%s → %s tiene r=%f y su equilibrio y Pmax se derivan", (fuerte, barato, r) => {
    const economia = economiaDelPar(precio(barato), precio(fuerte));
    expect(economia).not.toBeNull();
    expect(r3(economia!.r)).toBe(r);
    // Las dos columnas de la tabla salen de `r` y de nada más.
    expect(r3(economia!.equilibrio)).toBe(r3(1 - r));
    expect(r3(economia!.escaladoMaximo)).toBe(r3(CAPTURA_OBJETIVO - r));
  });

  it("los dos pares IMPOSIBLES salen imposibles, y por su Pmax negativo", () => {
    // r=0,667 y r=0,800: el modelo "barato" cuesta dos tercios y cuatro quintos
    // del otro. Ni escalando CERO veces llegan al objetivo, así que no son un par.
    for (const [fuerte, barato] of [
      ["gpt-4o-mini", "gpt-4.1-nano"],
      ["claude-haiku-4-5", "claude-3-5-haiku"],
    ] as const) {
      const economia = economiaDelPar(precio(barato), precio(fuerte))!;
      expect(economia.escaladoMaximo).toBeLessThan(0);
      expect(economia.viable).toBe(false);
      expect(economia.razon).toMatch(/cannot reach/);
    }
  });

  it("TODOS los pares por defecto son viables con los precios de hoy", () => {
    const tabla = tablaDePares();
    expect(tabla.length).toBe(Object.keys(PARES_POR_DEFECTO).length);
    for (const { fuerte, barato, economia } of tabla) {
      expect(economia, `${fuerte} → ${barato} no tiene precio en el catálogo`).not.toBeNull();
      expect(economia!.viable, `${fuerte} → ${barato}: Pmax ${economia!.escaladoMaximo}`).toBe(true);
    }
  });

  it("ningún modelo por defecto se enruta a otro más CARO", () => {
    for (const { economia } of tablaDePares()) expect(economia!.r).toBeLessThan(1);
  });

  it("un par nuevo calcula su propio veredicto sin tocar el código", () => {
    // La tabla es un argumento, no una constante escondida: quien declare un par
    // suyo obtiene la misma aritmética.
    const mio = tablaDePares({ "claude-3-opus": "claude-3-5-haiku" });
    expect(mio).toHaveLength(1);
    expect(mio[0]!.economia!.viable).toBe(true);
    // 0,0008/0,015 en entrada y 0,004/0,075 en salida: manda el mayor.
    expect(r3(mio[0]!.economia!.r)).toBe(r3(0.0008 / 0.015));
  });

  it("sin precio de alguno de los dos no hay veredicto, y NO se enruta", () => {
    // Enrutar sin poder hacer la cuenta es apostar con dinero ajeno.
    expect(economiaDelPar(undefined, precio("gpt-4o"))).toBeNull();
    expect(economiaDelPar(precio("gpt-4o-mini"), undefined)).toBeNull();
  });
});

describe("`r` depende de la MEZCLA, y el peor caso es una cota de verdad", () => {
  it("un par con razones distintas en entrada y salida mueve su r con la mezcla", () => {
    // gpt-4 → gpt-4o: 0,083 en entrada, 0,167 en salida. Es el par que demuestra
    // que `r` no puede ser un escalar y que la cota tiene que existir.
    const fuerte = precio("gpt-4");
    const barato = precio("gpt-4o");
    const soloEntrada = razonDeCoste({ entrada: 10_000, salida: 0 }, barato, fuerte)!;
    const soloSalida = razonDeCoste({ entrada: 0, salida: 10_000 }, barato, fuerte)!;
    expect(r3(soloEntrada)).toBe(r3(barato.inputPer1k / fuerte.inputPer1k));
    expect(r3(soloSalida)).toBe(r3(barato.outputPer1k / fuerte.outputPer1k));
    expect(soloEntrada).not.toBeCloseTo(soloSalida, 3);
  });

  it("el peor caso ACOTA la r de cualquier mezcla, en todos los pares del catálogo", () => {
    // La verja decide con el peor caso. Si ese número se quedara corto, aprobaría
    // pares que pierden dinero — que es justo el fallo que no se puede cometer.
    const mezclas = [
      { entrada: 1, salida: 0 },
      { entrada: 0, salida: 1 },
      { entrada: 1000, salida: 256 },
      { entrada: 100, salida: 4000 },
      { entrada: 50_000, salida: 10 },
      { entrada: 7, salida: 3 },
    ];
    const modelos = Object.keys(CATALOGO);
    for (const f of modelos) {
      for (const b of modelos) {
        const cota = razonPeorCaso(CATALOGO[b]!, CATALOGO[f]!)!;
        for (const mezcla of mezclas) {
          const r = razonDeCoste(mezcla, CATALOGO[b]!, CATALOGO[f]!)!;
          expect(r, `${f} → ${b} con ${JSON.stringify(mezcla)}`).toBeLessThanOrEqual(cota + 1e-12);
        }
      }
    }
  });

  it("una mezcla sin coste no inventa una razón", () => {
    expect(razonDeCoste({ entrada: 0, salida: 0 }, precio("gpt-4o-mini"), precio("gpt-4o"))).toBeNull();
  });

  it("las dos fórmulas publicadas son exactamente `1 − r` y `captura − r`", () => {
    for (const r of [0, 0.06, 0.2, 0.5, 0.8, 1]) {
      expect(equilibrioDeEscalado(r)).toBeCloseTo(1 - r, 12);
      expect(escaladoMaximo(r)).toBeCloseTo(CAPTURA_OBJETIVO - r, 12);
      expect(escaladoMaximo(r, 0.3)).toBeCloseTo(0.3 - r, 12);
    }
  });

  it("el ahorro sobre el tráfico enrutado es `1 − r − P`, comprobado en dinero", () => {
    // No es una identidad algebraica sino la cuenta que justifica la palanca, así
    // que se simula: N peticiones, una fracción P escala y paga las dos llamadas.
    const fuerte = precio("gpt-4o");
    const barato = precio("gpt-4o-mini");
    const mezcla = { entrada: 1200, salida: 300 };
    const coste = (p: CostModel): number =>
      (mezcla.entrada / 1000) * p.inputPer1k + (mezcla.salida / 1000) * p.outputPer1k;
    const r = razonDeCoste(mezcla, barato, fuerte)!;

    for (const P of [0, 0.1, 0.44, 0.94, 1]) {
      const n = 1000;
      const escaladas = Math.round(n * P);
      const gastoCascada = n * coste(barato) + escaladas * coste(fuerte);
      const gastoSinCascada = n * coste(fuerte);
      const ahorro = 1 - gastoCascada / gastoSinCascada;
      expect(ahorro).toBeCloseTo(1 - r - P, 6);
    }
    // Y el equilibrio hace lo que promete: justo ahí el ahorro es cero.
    expect(1 - r - equilibrioDeEscalado(r)).toBeCloseTo(0, 12);
  });
});

describe("qué modelo barato le toca a cada id", () => {
  it("conserva el prefijo de proveedor del llamante", () => {
    expect(modeloBarato("openai/gpt-4o")).toBe("openai/gpt-4o-mini");
    expect(modeloBarato("gpt-4o")).toBe("gpt-4o-mini");
    expect(modeloBarato("anthropic/claude-opus-4")).toBe("anthropic/claude-haiku-4-5");
  });

  it("una instantánea fechada hereda el par de su id base", () => {
    expect(modeloBarato("openai/gpt-4o-2024-08-06")).toBe("openai/gpt-4o-mini");
  });

  it("gana el prefijo MÁS LARGO, no el primero que case", () => {
    // `gpt-4.1` y `gpt-4` casan los dos con "gpt-4.1-2025": si ganara el corto, se
    // enrutaría a `gpt-4o` en vez de a `gpt-4.1-mini`.
    expect(modeloBarato("gpt-4.1-2025-04-14")).toBe("gpt-4.1-mini");
  });

  it("un modelo sin par declarado no se enruta a nada", () => {
    expect(modeloBarato("claude-haiku-4-5")).toBeNull();
    expect(modeloBarato("mistral-large")).toBeNull();
    expect(modeloBarato("")).toBeNull();
  });

  it("⛔ un sufijo de TAMAÑO no hereda el par de su base, o se enruta a sí mismo", () => {
    // `gpt-4o-mini` empieza por `gpt-4o`. Con la regla de prefijo laxa heredaba su
    // par y salía `gpt-4o-mini → gpt-4o-mini`: un cambio de modelo por él mismo,
    // presentado como ahorro hasta que la verja económica lo tumbara al final.
    expect(modeloBarato("gpt-4o-mini")).toBeNull();
    expect(modeloBarato("gpt-4o-mini-2024-07-18")).toBeNull();
  });

  it("⛔ una VERSIÓN MENOR tampoco: `gpt-4.1-nano` no puede acabar en `gpt-4o`", () => {
    // Con el punto admitido como separador, `gpt-4.1-nano` casaba con la clave
    // `gpt-4` y salía enrutado a `gpt-4o`, que cuesta VEINTICINCO veces más. Ése
    // ya no es el error barato (ahorro no capturado) sino el caro (factura de
    // más), y por eso la regla exige un AÑO detrás del guion.
    expect(modeloBarato("openai/gpt-4.1-nano")).toBeNull();
    expect(modeloBarato("gpt-4.1-mini")).toBeNull();
    // Y una versión menor de Anthropic es otro modelo, no una instantánea.
    expect(modeloBarato("claude-sonnet-4-5-20250929")).toBeNull();
  });

  it("⛔ nadie se enruta a sí mismo, ni declarándolo a mano", () => {
    expect(modeloBarato("gpt-4o", { "gpt-4o": "gpt-4o" })).toBeNull();
  });

  it("es determinista aunque dos claves midan lo mismo", () => {
    // El orden de recorrido no puede depender del orden de inserción del objeto:
    // dos despliegues del mismo SDK tienen que enrutar igual.
    const tabla = { aaaa: "z1", bbbb: "z2" };
    const alReves = { bbbb: "z2", aaaa: "z1" };
    expect(modeloBarato("aaaa-1", tabla)).toBe(modeloBarato("aaaa-1", alReves));
  });
});

describe("la verja: explora, mide y se apaga sola", () => {
  const economia = economiaDelPar(precio("gpt-4o-mini"), precio("gpt-4o"))!;

  it("enruta durante la exploración porque la tasa no es observable sin enrutar", () => {
    const verja = new VerjaDeCascada({ exploracion: 5 });
    for (let i = 0; i < 5; i++) {
      const d = verja.decidir("w", economia);
      expect(d.enrutar).toBe(true);
      expect(d.razon).toMatch(/measuring this workload/);
      verja.registrar("w", true); // escala SIEMPRE: el peor caso posible
    }
    // Y en cuanto hay medición suficiente, manda la medición.
    const despues = verja.decidir("w", economia);
    expect(despues.enrutar).toBe(false);
    expect(despues.observada).toBe(1);
    expect(despues.razon).toMatch(/model cascade OFF/);
  });

  it("una tasa por debajo del equilibrio deja la cascada encendida", () => {
    const verja = new VerjaDeCascada({ exploracion: 4 });
    for (let i = 0; i < 4; i++) {
      verja.decidir("w", economia);
      verja.registrar("w", i === 0); // 25% de escalado, muy por debajo del 94%
    }
    const d = verja.decidir("w", economia);
    expect(d.enrutar).toBe(true);
    expect(d.observada).toBe(0.25);
    expect(d.razon).toMatch(/MONEY check, not a quality one/);
  });

  it("el apagado es un LATCH: no se reabre solo con más tráfico", () => {
    const verja = new VerjaDeCascada({ exploracion: 2 });
    for (let i = 0; i < 2; i++) {
      verja.decidir("w", economia);
      verja.registrar("w", true);
    }
    expect(verja.decidir("w", economia).enrutar).toBe(false);
    // Aunque ahora dejara de escalar, no vuelve: reabrir sería pagar otra vez la
    // exploración de un workload que ya demostró no salir a cuenta.
    for (let i = 0; i < 50; i++) verja.registrar("w", false);
    expect(verja.decidir("w", economia).enrutar).toBe(false);
  });

  it("POR BUCKET: un workload que escala siempre no apaga al de al lado", () => {
    // Es la razón de ser del bucket. Con una tasa global, la media de «uno escala
    // siempre y otro nunca» se queda en la mitad y los dos siguen enrutando —
    // tirando dinero en el primero.
    const verja = new VerjaDeCascada({ exploracion: 3 });
    for (let i = 0; i < 3; i++) {
      verja.decidir("malo", economia);
      verja.registrar("malo", true);
      verja.decidir("bueno", economia);
      verja.registrar("bueno", false);
    }
    expect(verja.decidir("malo", economia).enrutar).toBe(false);
    expect(verja.decidir("bueno", economia).enrutar).toBe(true);
  });

  it("el coste de explorar está acotado y se puede publicar", () => {
    const verja = new VerjaDeCascada({ exploracion: 20 });
    // Peor caso: cada exploración escala y paga `r` de más sobre el fuerte.
    expect(verja.costeDeExploracion(economia.r)).toBeCloseTo(20 * economia.r, 12);
  });

  it("sin medición todavía, la tasa observada es `null` y no un 0 optimista", () => {
    const verja = new VerjaDeCascada();
    expect(verja.decidir("nuevo", economia).observada).toBeNull();
    expect(verja.estado("nuevo")).toBeUndefined();
  });
});
