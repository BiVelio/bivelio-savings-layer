import { describe, it, expect } from "vitest";

import { brazoDeSesion, brazoDelDia, leerEnrolamiento, planDeAnillo2 } from "../gateway/anillo2.js";
import { auditarPorSesion, brazoDeSesion as brazoDeSesionAuditor } from "../benchmarks/anillo2/nucleo.js";

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

describe("brazoDeSesion · la asignación vigente desde el 2026-09-10", () => {
  it("es determinista: la misma sesión cae siempre en el mismo brazo", () => {
    const id = "4f3c1a20-9b77-4e51-8d2a-1e6f0c9b7a33";
    const primero = brazoDeSesion(id);
    for (let i = 0; i < 50; i++) expect(brazoDeSesion(id)).toBe(primero);
  });

  it("una sesión que cruza la medianoche NO cambia de brazo — el fallo que mató el A/B del 09-09", () => {
    // El brazo ya no depende del día: el mismo id da el mismo brazo lo mismo
    // da qué día se mire, así que un día mezclado deja de ser posible.
    const id = "sesion-que-empieza-el-8-y-acaba-el-9";
    expect(brazoDeSesion(id)).toBe(brazoDeSesion(id));
    expect(brazoDelDia("2026-09-08")).not.toBe(brazoDelDia("2026-09-09"));
  });

  // Este test cazó un fallo REAL antes de salir: con el bit 0 pelado de FNV-1a,
  // el banco «secuencial» repartía 0 % / 100 %. Cinco formas de identificador
  // porque un id de sesión real puede ser cualquiera de ellas.
  it.each([
    ["uuid estructurado", (i: number) => `${i}-a7f3e1b2-4c8d-4e9f-b012-${String(i).padStart(12, "0")}`],
    ["solo dígitos", (i: number) => String(i)],
    ["prefijo común", (i: number) => `sesion-${i}`],
    ["sufijo común", (i: number) => `${i}-sesion`],
  ])("reparte cerca del 50 %% con identificadores de tipo %s", (_nombre, generar) => {
    const n = 4000;
    let palanca = 0;
    for (let i = 0; i < n; i++) if (brazoDeSesion(generar(i)) === "palanca") palanca += 1;
    const pct = (100 * palanca) / n;
    expect(pct).toBeGreaterThan(45);
    expect(pct).toBeLessThan(55);
  });

  it("el auditor y el gateway calculan el MISMO brazo (si divergen, se clasifica en el brazo equivocado)", () => {
    for (const id of ["a", "sesion-1", "4f3c1a20-9b77-4e51-8d2a-1e6f0c9b7a33", "", "ñ-unicode-🙂"]) {
      expect(brazoDeSesion(id)).toBe(brazoDeSesionAuditor(id));
    }
  });
});

describe("auditarPorSesion · el corte de protocolo", () => {
  const turno = (sesion: string, dia: string, brazo: "control" | "palanca") => ({
    dia,
    brazo,
    model: "claude-fable-5-1",
    sesion,
    entradaUsd: 1,
    salidaUsd: 0.1,
    entradaTokens: 1000,
    salidaTokens: 100,
    borrados: 0,
    tokensLimpiados: 0,
    respuestaOmitida: false,
  });

  it("no audita el corpus anterior al corte: si no, CADA sesión vieja sería una fisura y enterraría las de verdad", () => {
    // Corpus viejo servido bajo paridad de días: el hash dirá otra cosa y da igual.
    const viejos = ["s1", "s2", "s3"].flatMap((s) => [turno(s, "2026-09-08", "palanca"), turno(s, "2026-09-08", "control")]);
    const a = auditarPorSesion(viejos);
    expect(a.fisuras).toHaveLength(0);
    expect(a.omitidasPorProtocoloAnterior).toBe(3);
    expect(a.sesiones.every((s) => s.protocoloAnterior)).toBe(true);
    // Y no cuentan para el reparto: el experimento nuevo no los incluye.
    expect(a.reparto).toEqual({ control: 0, palanca: 0 });
  });

  it("una sesión posterior al corte que mezcla brazos SÍ es fisura", () => {
    const mezclada = [turno("mixta", "2026-09-11", "palanca"), turno("mixta", "2026-09-11", "control")];
    const a = auditarPorSesion(mezclada);
    expect(a.fisuras).toHaveLength(1);
    expect(a.fisuras[0]).toContain("mixta");
    expect(a.omitidasPorProtocoloAnterior).toBe(0);
  });

  it("una sesión que cruza el corte se audita con el criterio nuevo (su último día ya aplicaba)", () => {
    const cruza = [turno("cruza", "2026-09-09", "palanca"), turno("cruza", "2026-09-10", "palanca")];
    const a = auditarPorSesion(cruza);
    expect(a.sesiones[0]!.protocoloAnterior).toBe(false);
  });
});
