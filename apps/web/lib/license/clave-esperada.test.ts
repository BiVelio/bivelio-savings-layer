import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CLAVE_PUBLICA_DEL_SDK, cuerpoDelPem } from "./clave-esperada.js";

/**
 * La copia de la clave pública que tiene la web debe ser la MISMA que `tsup` embebe
 * en el SDK. Si derivan, la sonda de salud compararía contra una clave que ningún
 * cliente tiene, y daría 200 justo cuando todo está roto — una sonda que miente es
 * peor que no tener sonda.
 *
 * Solo la mitad PÚBLICA está commiteada (`keys/license.pub.pem`); la privada no, y
 * por eso ningún test de aquí puede depender de ella.
 */
describe("la clave pública que la web da por buena", () => {
  const delRepo = readFileSync(new URL("../../../../keys/license.pub.pem", import.meta.url), "utf8");

  it("es exactamente la que el SDK embebe desde keys/license.pub.pem", () => {
    expect(cuerpoDelPem(CLAVE_PUBLICA_DEL_SDK)).toBe(cuerpoDelPem(delRepo));
  });

  it("es una clave Ed25519 en formato SPKI, no un texto cualquiera", () => {
    expect(CLAVE_PUBLICA_DEL_SDK).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    // SPKI de Ed25519: 12 bytes de prefijo DER + 32 de clave = 44 → 60 en base64.
    expect(cuerpoDelPem(CLAVE_PUBLICA_DEL_SDK)).toHaveLength(60);
  });
});

describe("cuerpoDelPem", () => {
  it("ignora cabeceras, espacios y saltos de línea al comparar", () => {
    const a = "-----BEGIN PUBLIC KEY-----\nAAAA\nBBBB\n-----END PUBLIC KEY-----\n";
    const b = "-----BEGIN PUBLIC KEY-----\r\n  AAAABBBB  \r\n-----END PUBLIC KEY-----";
    expect(cuerpoDelPem(a)).toBe(cuerpoDelPem(b));
    expect(cuerpoDelPem(a)).toBe("AAAABBBB");
  });
});
