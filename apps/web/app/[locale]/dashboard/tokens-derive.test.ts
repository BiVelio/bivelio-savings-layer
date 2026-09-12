import { describe, it, expect } from "vitest";

import { deriveTokens, type FilaUso } from "./derive";

/**
 * «Cuántos tokens he gastado» y «cuántos me habéis ahorrado».
 *
 * Lo que se comprueba aquí NO es la aritmética —eso es una resta— sino las tres
 * formas de mentir que tiene esta tarjeta:
 *
 *   1. decir CERO cuando la respuesta es NO LO SÉ (la base aún no trae los
 *      contadores). Un cero se lee como "no ahorraste nada", sobre datos que no
 *      tenemos;
 *   2. pintar en verde una pérdida real. `actual > baseline` ocurre de verdad
 *      cuando una reparación gasta una segunda llamada completa cuya entrada NO
 *      entra en el baseline;
 *   3. publicar un ahorro de salida que la doctrina de la capa no permite
 *      acreditar en llamadas ejecutadas.
 */

const fila = (p: Partial<FilaUso> = {}): FilaUso => ({
  requests: 1,
  baselineCost: 0,
  actualCost: 0,
  ...p,
});

describe("tokens gastados y ahorrados", () => {
  it("sin las columnas es NO DISPONIBLE, nunca cero", () => {
    // El caso del proyecto que va por detrás de la migración 0015. Decir "0
    // ahorrados" aquí es afirmar algo falso sobre datos que sí existen en el SDK.
    const r = deriveTokens([fila({ requests: 120 })]);
    expect(r.kind).toBe("unavailable");
  });

  it("cero filas es «sin tráfico», nunca «sin columnas»: lo primero que ve un cliente nuevo", () => {
    // Antes `some` se evaluaba antes que `length === 0`, así que el array vacío
    // caía en «unavailable» y el recién registrado leía «falta aplicar la
    // migración 0015» sin haber hecho una sola petición.
    expect(deriveTokens([])).toEqual({ kind: "empty" });
  });

  it("con las columnas a cero y sin tráfico es VACÍO, que sí es un cero legítimo", () => {
    const r = deriveTokens([
      fila({
        requests: 0,
        baselineInputTokens: 0,
        actualInputTokens: 0,
        baselineOutputTokens: 0,
        actualOutputTokens: 0,
      }),
    ]);
    expect(r.kind).toBe("empty");
  });

  it("suma los dos ejes y reparte el desglose", () => {
    const r = deriveTokens([
      fila({
        baselineInputTokens: 1000,
        actualInputTokens: 600,
        baselineOutputTokens: 200,
        actualOutputTokens: 200,
      }),
      fila({
        baselineInputTokens: 500,
        actualInputTokens: 400,
        baselineOutputTokens: 100,
        actualOutputTokens: 100,
      }),
    ]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.spent).toBe(600 + 200 + 400 + 100); // lo que pagó de verdad
    expect(r.savedInput).toBe(500);
    expect(r.savedOutput).toBe(0); // la capa no encoge la respuesta de una llamada ejecutada
    expect(r.saved).toBe(500);
    expect(r.fraction).toBeCloseTo(500 / 1800, 6);
    expect(r.tone).toBe("pos");
  });

  it("UNA PÉRDIDA NO SE PINTA EN VERDE", () => {
    // Reparación: la segunda llamada suma a `actual` y se descuenta del baseline,
    // así que el ahorro sale negativo. Es el escenario que contra
    // claude-sonnet-4-5 llegó a ser un 60% de sobrecoste.
    const r = deriveTokens([
      fila({
        baselineInputTokens: 800,
        actualInputTokens: 1500,
        baselineOutputTokens: 200,
        actualOutputTokens: 400,
      }),
    ]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.saved).toBeLessThan(0);
    expect(r.tone).toBe("neg");
    // Y el gasto sigue siendo el gasto: no se recorta para maquillar el signo.
    expect(r.spent).toBe(1900);
  });

  it("una llamada EVITADA acredita su baseline entero, que es donde vive el ahorro de salida", () => {
    // avoided: actual = 0 en los dos ejes. Es el único caso en que la salida
    // ahorra, porque la generación no llegó a ocurrir.
    const r = deriveTokens([
      fila({
        baselineInputTokens: 900,
        actualInputTokens: 0,
        baselineOutputTokens: 300,
        actualOutputTokens: 0,
      }),
    ]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.spent).toBe(0);
    expect(r.savedOutput).toBe(300);
    expect(r.saved).toBe(1200);
    expect(r.fraction).toBeCloseTo(1, 6);
  });

  it("basta con que UNA fila traiga los contadores para no declarar no-disponible", () => {
    // La ventana de 120 días puede arrancar en días sin tráfico; mirar solo la
    // primera fila declararía "no disponible" con datos delante.
    const r = deriveTokens([
      fila({ requests: 0 }),
      fila({
        baselineInputTokens: 100,
        actualInputTokens: 40,
        baselineOutputTokens: 0,
        actualOutputTokens: 0,
      }),
    ]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.saved).toBe(60);
  });

  it("sin baseline y sin gasto no se fabrica un 100%", () => {
    const r = deriveTokens([
      fila({
        baselineInputTokens: 0,
        actualInputTokens: 0,
        baselineOutputTokens: 0,
        actualOutputTokens: 0,
      }),
    ]);
    expect(r.kind).toBe("empty");
  });
});
