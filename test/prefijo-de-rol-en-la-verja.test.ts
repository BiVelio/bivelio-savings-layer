import { describe, it, expect } from "vitest";

import { keyTokensMatch } from "../src/cache/semantic.js";

/**
 * LA VERJA SE PRUEBA EN LA FORMA EN QUE LA LLAMA PRODUCCIÓN, no con cadenas
 * peladas.
 *
 * `canonicalize` escribe un turno por línea como `${rol}:${texto}`
 * (canonicalize.ts:236), así que la PRIMERA palabra de cada turno llega fundida
 * con el rol: `user:nunca`. Partir por espacios no la separa, `user:nunca` no
 * está en NEGATIONS, y la negación no se cuenta.
 *
 * Por eso este fichero existe: `negaciones-es-ca.test.ts` (del #144) probaba con
 * cadenas SIN prefijo y pasaba en verde mientras producción seguía abierta. Es la
 * forma más cara de tener un test: uno que da confianza sin dar cobertura.
 *
 * Medido contra el main de antes del arreglo: la pareja larga de aspirina daba
 * `true` con prefijo y `false` sin él. Con textos cortos el Jaccard lo tapaba por
 * accidente; con un texto realista, una palabra más apenas lo mueve.
 */
const LARGO = "es seguro tomar aspirina en el embarazo con anticoagulantes orales y antecedentes de trombosis";

describe("la verja con prefijo de rol (la forma real)", () => {
  const debeCortar: [string, string, string][] = [
    ["negación inicial, texto largo", `user:${LARGO}`, `user:nunca ${LARGO}`],
    ["jamás inicial", "user:el contrato incluye clausula de rescision", "user:jamas el contrato incluye clausula de rescision"],
    ["sense inicial (ca)", "user:aquest pacient te al·lergia coneguda al iode", "user:sense al·lergia coneguda al iode aquest pacient"],
    ["never inicial (en)", `user:${LARGO}`, `user:never ${LARGO}`],
  ];
  it.each(debeCortar)("corta: %s", (_n, a, b) => {
    expect(keyTokensMatch(a, b)).toBe(false);
  });

  // El otro lado del mismo fallo: `user:por` tampoco estaba en STOPWORDS, así que
  // la cortesía inicial contaba como CONTENIDO y hundía el Jaccard. Cada uno de
  // estos es un acierto de caché que se perdía —una llamada completa al proveedor
  // pagada de más— en cada petición cortés.
  const debePasar: [string, string, string][] = [
    ["cortesía inicial (es)", "user:resume este informe trimestral de ventas", "user:por favor resume este informe trimestral de ventas"],
    ["cortesía inicial (ca)", "user:resumeix aquest informe trimestral de vendes", "user:sisplau resumeix aquest informe trimestral de vendes"],
    ["cortesía inicial (en)", "user:summarize this quarterly sales report", "user:please summarize this quarterly sales report"],
  ];
  it.each(debePasar)("deja pasar: %s", (_n, a, b) => {
    expect(keyTokensMatch(a, b)).toBe(true);
  });

  it("un turno del USUARIO no casa con el mismo texto dicho por el ASISTENTE", () => {
    // Quitar el prefijo sin comparar el rol confundiría quién dijo qué.
    expect(keyTokensMatch("user:el pago se ha completado", "assistant:el pago se ha completado")).toBe(false);
  });

  it("conversaciones con distinto número de turnos no casan", () => {
    expect(keyTokensMatch("user:hola\nassistant:hola\nuser:sigue", "user:hola\nassistant:hola")).toBe(false);
  });

  it("los hechos se comparan turno CONTRA TURNO, no en un saco común", () => {
    // Mismos tokens en el conjunto, repartidos al revés entre los turnos: es otra
    // conversación, y sin la comparación por turnos pasaría.
    const a = "user:cobra 100 euros\nassistant:cobrados 200 euros";
    const b = "user:cobra 200 euros\nassistant:cobrados 100 euros";
    expect(keyTokensMatch(a, b)).toBe(false);
  });

  it("una cadena SIN prefijo se comporta exactamente como antes", () => {
    expect(keyTokensMatch("es seguro tomar aspirina", "nunca es seguro tomar aspirina")).toBe(false);
    expect(keyTokensMatch("cual es la capital de francia", "capital de francia cual es")).toBe(true);
  });
});
