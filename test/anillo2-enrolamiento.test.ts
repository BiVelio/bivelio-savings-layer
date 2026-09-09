import { describe, it, expect } from "vitest";

import { brazoDelDia, leerEnrolamiento, planDeAnillo2 } from "../gateway/anillo2.js";

/**
 * El encadenado del A/B vivía SOLO en una función de ~/.zshrc. Toda sesión
 * nacida por otro camino se medía pero no entraba en el corpus, y el A/B se
 * quedaba sin datos sin que nada fallara a la vista: ocho días de brazo control
 * y CERO de palanca, con $498,2491 de $624,1437 fuera del A/B el 5-09.
 *
 * Estas verjas cubren lo que puede volver a romperlo en silencio: que los dos
 * caminos deriven brazos distintos, que un fichero olvidado encadene a un espía
 * muerto, y que el enrolamiento pise una bandera puesta a mano.
 */
describe("anillo 2 · brazo del día", () => {
  it("dice lo MISMO que bvsala-ab-brazo del .zshrc: día del mes par = palanca", () => {
    expect(brazoDelDia("2026-09-06")).toBe("palanca");
    expect(brazoDelDia("2026-09-05")).toBe("control");
    // El «08» y el «09» son la trampa clásica: en zsh hace falta 10# porque
    // si no se leen como octal. Aquí se comprueba que no hay tal agujero.
    expect(brazoDelDia("2026-09-08")).toBe("palanca");
    expect(brazoDelDia("2026-09-09")).toBe("control");
  });
});

describe("anillo 2 · lectura del enrolamiento", () => {
  const leerQueDa = (t: string) => () => t;

  it("lee un fichero válido", () => {
    expect(leerEnrolamiento(leerQueDa('{"activo":true,"espia":8402}'))).toEqual({ activo: true, espia: 8402 });
  });

  it("sin fichero, JSON roto o puerto imposible → no enrolado, jamás una excepción", () => {
    const explota = () => {
      throw new Error("ENOENT");
    };
    expect(leerEnrolamiento(explota)).toBeNull();
    expect(leerEnrolamiento(leerQueDa("{no es json"))).toBeNull();
    expect(leerEnrolamiento(leerQueDa('{"activo":true}'))).toBeNull();
    expect(leerEnrolamiento(leerQueDa('{"espia":0}'))).toBeNull();
    expect(leerEnrolamiento(leerQueDa('{"espia":70000}'))).toBeNull();
    expect(leerEnrolamiento(leerQueDa('{"espia":"8402"}'))).toBeNull();
  });

  it("activo se presume verdadero y solo `false` lo apaga", () => {
    expect(leerEnrolamiento(leerQueDa('{"espia":8402}'))?.activo).toBe(true);
    expect(leerEnrolamiento(leerQueDa('{"activo":false,"espia":8402}'))?.activo).toBe(false);
  });
});

describe("anillo 2 · plan de arranque", () => {
  const base = {
    espiaVivo: true,
    upstreamEnv: undefined,
    elisionEnv: undefined,
    hoyUtcIso: "2026-09-06",
  };

  it("sin enrolamiento no toca NADA y no dice nada: el cliente jamás se encadena", () => {
    const plan = planDeAnillo2({ ...base, enrolamiento: null });
    expect(plan).toEqual({ linea: "", aviso: false });
  });

  it("día par: encadena al espía y el brazo YA NO toca la bandera del canal (2026-09-09)", () => {
    const plan = planDeAnillo2({ ...base, enrolamiento: { activo: true, espia: 8402 } });
    expect(plan.upstream).toBe("http://127.0.0.1:8402");
    // El brazo ya no devuelve `elision`: ese "0"/"1" abría y CERRABA el canal
    // de entitlements entero, y al cerrarlo mataba la rebaja de TTL — la única
    // palanca con dinero medido. Los diales tienen bandera propia y nacen
    // apagados, así que el brazo se queda en etiqueta informativa.
    expect(plan.elision).toBeUndefined();
    expect(plan.brazo).toBe("palanca");
    expect(plan.linea).toContain("diales de elisión APAGADOS");
  });

  it("día impar: encadena igual y TAMPOCO apaga el canal — apagarlo mataba la palanca A", () => {
    const plan = planDeAnillo2({ ...base, hoyUtcIso: "2026-09-05", enrolamiento: { activo: true, espia: 8402 } });
    expect(plan.upstream).toBe("http://127.0.0.1:8402");
    expect(plan.elision).toBeUndefined();
    expect(plan.brazo).toBe("control");
  });

  it("espía muerto: NO encadena, avisa, y no fuerza brazo — un día sin capturar no se cuenta como bueno", () => {
    const plan = planDeAnillo2({ ...base, espiaVivo: false, enrolamiento: { activo: true, espia: 8402 } });
    expect(plan.upstream).toBeUndefined();
    expect(plan.elision).toBeUndefined();
    expect(plan.brazo).toBeUndefined();
    expect(plan.aviso).toBe(true);
    expect(plan.linea).toContain("NO encadeno");
  });

  it("en pausa: ni encadena ni arma", () => {
    const plan = planDeAnillo2({ ...base, enrolamiento: { activo: false, espia: 8402 } });
    expect(plan.upstream).toBeUndefined();
    expect(plan.elision).toBeUndefined();
  });

  it("lo explícito del entorno manda: el .zshrc y el fichero conviven sin pelearse", () => {
    const plan = planDeAnillo2({
      ...base,
      enrolamiento: { activo: true, espia: 8402 },
      upstreamEnv: "http://127.0.0.1:9999",
      elisionEnv: "0",
    });
    expect(plan.upstream).toBeUndefined();
    expect(plan.elision).toBeUndefined();
    expect(plan.brazo).toBe("palanca");
    expect(plan.linea).toContain("respetado");
  });
});
