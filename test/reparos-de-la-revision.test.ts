import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { createMockProvider } from "../src/providers/mock.js";

/**
 * LOS REPAROS QUE ENCONTRÓ LA REVISIÓN ADVERSARIAL.
 *
 * Tres arreglos volvieron con reparos y ninguno era cosmético. Estos tests son
 * cada reparo convertido en verja, para que el arreglo del arreglo no se deshaga.
 */

let avisos: string[];
beforeEach(() => {
  avisos = [];
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    avisos.push(a.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

const capa = (extra: Record<string, unknown> = {}) =>
  createSavingsLayer({ provider: createMockProvider(), devUnlicensed: true, ...extra } as never);

const pedir = (layer: ReturnType<typeof capa>, model = "un-modelo-sin-precio") =>
  layer.generate({ model, messages: [{ role: "user", content: "hola" }] } as never);

describe("`silenceWarnings` calla el pipeline ENTERO, como promete su documentación", () => {
  /**
   * EL REPARO. El interruptor se consultaba en UN solo sitio mientras su JSDoc
   * —ya publicado en npm, que es inmutable— decía «applies to the pipeline, the
   * usage emitter and the revocation poller alike». El revisor lo demostró con el
   * aviso del precio ilustrativo, que seguía imprimiéndose con el switch puesto.
   */
  it("⛔ el aviso del precio ilustrativo obedece al interruptor", async () => {
    await pedir(capa({ silenceWarnings: true }));
    expect(avisos.filter((a) => /ILLUSTRATIVE/.test(a))).toEqual([]);
  });

  it("y sin el interruptor, habla", async () => {
    // La otra mitad: un test que solo comprueba el silencio pasaría también si el
    // aviso no existiera. Hay que probar que existe antes de probar que se calla.
    await pedir(capa());
    expect(avisos.filter((a) => /ILLUSTRATIVE/.test(a)).length).toBeGreaterThan(0);
  });

  it("un modelo del catálogo no avisa de nada, con o sin interruptor", async () => {
    await pedir(capa(), "gpt-4o-mini");
    expect(avisos.filter((a) => /ILLUSTRATIVE/.test(a))).toEqual([]);
  });

  /**
   * LA VERJA DE VERDAD. Los tests de arriba cubren los avisos que existen HOY;
   * éste cubre los que alguien añada mañana. Si aparece un `console.warn` suelto
   * en el pipeline, la promesa del JSDoc vuelve a ser mentira y esto se pone rojo.
   */
  it("⛔ ningún `console.warn` suelto en el pipeline: todos pasan por el portero", () => {
    const fuente = readFileSync(fileURLToPath(new URL("../src/pipeline/pipeline.ts", import.meta.url)), "utf8");
    const sueltos = fuente
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /\bconsole\.warn\s*\(/.test(l))
      .map(([n, l]) => `${n}: ${l.trim()}`);
    expect(sueltos).toEqual([]);
  });

  it("⛔ ni `avisarUnaVez` a pelo, que se salta el interruptor", () => {
    // `avisarUnaVez` respeta el "una vez por causa" pero NO mira
    // `silenceWarnings`: llamarlo directo reabre exactamente el mismo agujero.
    const fuente = readFileSync(fileURLToPath(new URL("../src/pipeline/pipeline.ts", import.meta.url)), "utf8");
    const directos = fuente
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      // La única línea legítima es la de dentro del propio portero.
      .filter(([, l]) => /(?<!\.)\bavisarUnaVez\s*\(/.test(l) && !/^\s*avisarUnaVez\(clave, mensaje\);/.test(l))
      .map(([n, l]) => `${n}: ${l.trim()}`);
    expect(directos).toEqual([]);
  });
});

describe("el aviso de las palancas no promete un síntoma que el SDK no produce", () => {
  /**
   * EL REPARO. El texto decía que «el informe dirá `compression: null`», pero el
   * campo solo se añade cuando la compresión corrió: sale AUSENTE, nunca `null`.
   * Un cliente buscando `"compression": null` en su JSON no encontraría nada. El
   * texto estaba medido contra el arnés del banco de pruebas (`?? null`), no
   * contra el contrato.
   */
  it("⛔ el informe NO trae `compression: null`, así que el aviso no puede decirlo", async () => {
    const res = await capa().generate({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hola" }],
      savings: { compression: "auto" },
    } as never);
    // Se fija el CONTRATO real, que es lo que el aviso tiene que describir.
    expect(res.report.compression).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(res.report, "compression")).toBe(false);
  });

  it("⛔ el texto del aviso no menciona `compression: null`", () => {
    const fuente = readFileSync(fileURLToPath(new URL("../src/pipeline/pipeline.ts", import.meta.url)), "utf8");
    expect(fuente).not.toMatch(/compression:\s*null/);
  });
});
