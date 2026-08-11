import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { BV_SALA_VERSION } from "../src/index.js";

/**
 * La versión que el SDK declara de sí mismo tiene que ser la que se publica.
 *
 * POR QUÉ EXISTE: `BV_SALA_VERSION` está escrita a mano en src/index.ts (no puede
 * leerse de package.json, porque el bundle publicado no lo incluye). El paquete
 * subió a 0.2.0 y la constante se quedó en "0.1.0" — la versión que vamos a
 * marcar como rota en npm. Se habría publicado un SDK que se presenta como la
 * versión defectuosa: soporte y telemetría no podrían distinguir a quien
 * actualizó de quien no, que es justo la pregunta que se hace tras deprecar.
 *
 * No lo cazó nadie porque la constante no tenía ni un test.
 */
describe("la versión declarada", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };

  it("coincide con la de package.json, que es la que se etiqueta y publica", () => {
    expect(BV_SALA_VERSION).toBe(pkg.version);
  });

  it("es una versión semántica de tres partes, no un texto cualquiera", () => {
    expect(BV_SALA_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
