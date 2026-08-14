import { describe, it, expect } from "vitest";

import { scenarios, politicaEstable, MINIMO_DE_TRAMO_TOKENS, LIBROS } from "../benchmarks/scenarios.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";

/**
 * EL BANCO NO PODÍA VER LAS PALANCAS QUE MÁS DINERO VALEN.
 *
 * Ningún escenario alcanzaba el mínimo de tramo de la caché de prefijo del
 * proveedor: el mayor manda 1212 tokens en el brazo naive y el resto se mueve
 * entre 19 y 300. La tirada del 2026-08-13 contra el proveedor real corrió con
 * preguntas de ~16 tokens de entrada. Resultado: `cached_tokens` sale 0 en LOS
 * DOS BRAZOS —está en `benchmarks/out/ab-live.json`, los siete escenarios con
 * `providerCachedInputTokens: 0`— y el banco es estructuralmente incapaz de
 * medir esa palanca.
 *
 * Es peor que no medirla: el brazo naive TAMBIÉN pierde el descuento, así que
 * tampoco se ve si nuestra compresión se lo estaría quitando al cliente.
 *
 * Este fichero fija el sustrato para que no se degrade en silencio. Un prefijo
 * que alguien acorte "para que el test corra más rápido" devuelve el banco a
 * ciegas sin que nada falle.
 */

const registro = new TokenizerRegistry();
const contar = (texto: string): number => registro.count(texto, { model: "openai/gpt-4o-mini" });

describe("sustrato del banco", () => {
  it("el prefijo estable supera el mínimo de tramo de la caché de prefijo", () => {
    const tokens = contar(politicaEstable);
    expect(
      tokens,
      `el prefijo mide ${tokens} tokens y el mínimo de tramo es ${MINIMO_DE_TRAMO_TOKENS}: ` +
        "por debajo, el proveedor no cachea y el escenario mide lo contrario de lo que pretende",
    ).toBeGreaterThan(MINIMO_DE_TRAMO_TOKENS);
  });

  it("el prefijo es ESTABLE: dos lecturas dan exactamente el mismo texto", () => {
    // Un solo byte distinto entre peticiones —una fecha, un id, el orden de
    // iteración de un objeto— tira el acierto de caché a cero. El módulo no
    // puede tener nada no determinista dentro.
    expect(politicaEstable).toBe(politicaEstable);
    expect(politicaEstable).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // sin timestamps
    expect(politicaEstable.length).toBeGreaterThan(0);
  });

  it("existe al menos un escenario capaz de enganchar la caché de prefijo", () => {
    const capaces = scenarios.filter((s) => {
      const texto = s.request.messages.map((m) => m.content).join("\n");
      return contar(texto) > MINIMO_DE_TRAMO_TOKENS;
    });
    expect(
      capaces.map((s) => s.name),
      "sin un escenario por encima del mínimo de tramo, el titular del banco ignora " +
        "una de las mayores palancas de la entrada",
    ).not.toEqual([]);
  });

  it("el prefijo va DELANTE de la pregunta en ese escenario", () => {
    const s = scenarios.find((x) => x.name === "Stable-prefix agent turn");
    expect(s).toBeDefined();
    const roles = s!.request.messages.map((m) => m.role);
    const ultimoUsuario = roles.lastIndexOf("user");
    const indicePrefijo = s!.request.messages.findIndex((m) => m.content === politicaEstable);
    // Lo estable delante y lo variable al final: es la condición del proveedor
    // para cachear, y coincide con lo que ya medimos sobre calidad de salida.
    expect(indicePrefijo).toBeGreaterThanOrEqual(0);
    expect(indicePrefijo).toBeLessThan(ultimoUsuario);
  });

  it("cada escenario declara un libro conocido", () => {
    // La lista viene de `scenarios.ts`, que es donde vive también el tipo. Antes
    // se copiaba aquí a mano y las dos copias divergieron: el cuarto libro
    // (`provider_cached`) entró en el tipo y esta verja siguió sin conocerlo,
    // así que rechazaba un escenario perfectamente válido. Una verja que se
    // mantiene sola no protege de nada.
    const libros = new Set<string>(LIBROS);
    for (const s of scenarios) {
      expect(libros.has(s.ledger), `${s.name} declara un libro desconocido: ${s.ledger}`).toBe(true);
    }
  });
});
