import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import {
  admiteReferencia,
  CABECERA_VERSION,
  sellarVersion,
  VERSION_MINIMA_REFERENCIA,
  versionDeclarada,
} from "./version";
import { compararVersiones } from "@/lib/version/semver";
import { parseUsageRecord, UsageValidationError } from "./usage";

/**
 * El canal de versión no puede ni romper un lote ni abrir el canal cerrado:
 * lo raro es «sin declarar» (null), nunca un 400; y el cuerpo sigue sin poder
 * traer la versión por su cuenta.
 */
describe("versionDeclarada — valida sin lanzar jamás", () => {
  it("acepta superficie/semver, con o sin sufijo, y devuelve el valor tal cual (sin espacios)", () => {
    for (const ok of ["gateway/0.4.16", "sdk/0.4.16", "gateway/0.10.0", "sdk/1.2.3-beta.1", " gateway/0.4.17 "]) {
      expect(versionDeclarada(ok), ok).toBe(ok.trim());
    }
  });

  it("rechaza (→ null) lo que no casa el patrón, incluida una cabecera repetida «a, b»", () => {
    for (const mal of [
      "0.4.16",                          // sin superficie
      "cli/0.4.16",                      // superficie desconocida
      "gateway/0.4",                     // sin parche
      "gateway/0.4.16, gateway/0.4.16",  // repetida: dos procesos a la vez
      "gateway/00000.4.16",              // más de 4 dígitos
      "gateway/0.4.16-",                 // sufijo vacío
      "gateway/0.4.16-" + "x".repeat(17), // sufijo largo
      "GATEWAY/0.4.16",                  // mayúsculas
      "gateway/0.4.16\nx-otra: 1",       // salto de línea
      "",
      "   ",
    ]) {
      expect(versionDeclarada(mal), JSON.stringify(mal)).toBeNull();
    }
  });

  it("null/undefined y valores de más de 40 caracteres → null", () => {
    expect(versionDeclarada(null)).toBeNull();
    expect(versionDeclarada(undefined)).toBeNull();
    // Formalmente casaría el patrón, pero pasa del tope de longitud.
    expect(versionDeclarada("gateway/9999.9999.9999-" + "a".repeat(16) + "b")).toBeNull();
    expect(versionDeclarada("gateway/9999.9999.9999-" + "a".repeat(16))).toBe("gateway/9999.9999.9999-" + "a".repeat(16));
  });

  it("el nombre de la cabecera es el MISMO que declara src/version.ts (espejo atado por texto)", () => {
    const fuente = readFileSync(new URL("../../../../src/version.ts", import.meta.url), "utf8");
    const m = /export const CABECERA_VERSION = "([^"]+)";/.exec(fuente);
    expect(m, "src/version.ts tiene que declarar CABECERA_VERSION").not.toBeNull();
    expect(CABECERA_VERSION).toBe(m![1]);
    expect(CABECERA_VERSION).toBe("x-bvsala-version");
  });
});

describe("sellarVersion — solo el servidor escribe la versión", () => {
  it("sella clientVersion en todos los registros cuando hay versión", () => {
    const recs: Array<Record<string, unknown>> = [{ requestId: "a" }, { requestId: "b" }];
    sellarVersion(recs, "gateway/0.4.16");
    expect(recs.map((r) => r["clientVersion"])).toEqual(["gateway/0.4.16", "gateway/0.4.16"]);
  });

  it("con null no toca nada (ni siquiera añade la clave)", () => {
    const recs: Array<Record<string, unknown>> = [{ requestId: "a" }];
    sellarVersion(recs, null);
    expect("clientVersion" in recs[0]!).toBe(false);
  });

  it("sobre un array vacío no lanza", () => {
    expect(() => sellarVersion([], "gateway/0.4.16")).not.toThrow();
    expect(() => sellarVersion([], null)).not.toThrow();
  });

  it("la lista blanca sigue rechazando un cuerpo que traiga clientVersion", () => {
    const cuerpo = {
      requestId: "req-1", model: "claude-haiku-4-5", cacheResult: "miss", at: Date.now(),
      avoidedLlm: 0, actualLlm: 1, baselineInputTokens: 10, actualInputTokens: 10,
      eliminatedInputTokens: 0, compressedInputTokens: 0, baselineOutputTokens: 5, actualOutputTokens: 5,
      providerCachedInputTokens: 0, baselineCost: 0.01, actualCost: 0.01, netSavings: 0,
      clientVersion: "gateway/0.4.16",
    };
    expect(() => parseUsageRecord(cuerpo, "org-1")).toThrow(UsageValidationError);
    expect(() => parseUsageRecord(cuerpo, "org-1")).toThrow(/disallowed field "clientVersion"/);
  });
});

describe("admiteReferencia — la verja de la regla de la referencia", () => {
  const fuente = readFileSync(new URL("../../../../src/version.ts", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };

  it("la mínima es la MISMA que declara src/version.ts (espejo atado por texto)", () => {
    const m = /export const VERSION_MINIMA_REFERENCIA = "([^"]+)";/.exec(fuente);
    expect(m, "src/version.ts tiene que declarar VERSION_MINIMA_REFERENCIA").not.toBeNull();
    expect(VERSION_MINIMA_REFERENCIA).toBe(m![1]);
    expect(VERSION_MINIMA_REFERENCIA).toMatch(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
  });

  it("va por delante de la etiqueta v0.4.23, que se cortó con la regla v1", () => {
    expect(compararVersiones(VERSION_MINIMA_REFERENCIA, "0.4.23")).toBeGreaterThan(0);
  });

  it("no está más allá del siguiente parche de la versión actual (una errata degradaría para siempre)", () => {
    const [a, b, c] = pkg.version.split(".").map(Number) as [number, number, number];
    expect(compararVersiones(VERSION_MINIMA_REFERENCIA, `${a}.${b}.${c + 1}`)).toBeLessThanOrEqual(0);
  });

  it("sdk/ desde la mínima: sí; anteriores, preliminares de la mínima o sin versión: no", () => {
    for (const si of ["sdk/0.4.24", "sdk/0.4.25", "sdk/0.5.0", "sdk/1.0.0", "sdk/0.4.25-rc.1"]) {
      expect(admiteReferencia(si), si).toBe(true);
    }
    for (const no of [null, "sdk/0.4.23", "sdk/0.4.22", "sdk/0.4.24-rc.1", "0.4.24"]) {
      expect(admiteReferencia(no), String(no)).toBe(false);
    }
  });

  it("gateway/ nunca, sea cual sea la versión: la regla v2 vive en el pipeline del SDK y el gateway no pasa por él", () => {
    for (const no of ["gateway/0.4.23", "gateway/0.4.24", "gateway/0.4.24-dev", "gateway/0.5.0", "gateway/9.9.9"]) {
      expect(admiteReferencia(no), no).toBe(false);
    }
  });

  it("encadenada con versionDeclarada: una cabecera rara es «sin versión» y tampoco admite", () => {
    expect(admiteReferencia(versionDeclarada("sdk/0.4.24, sdk/0.4.24"))).toBe(false);
    expect(admiteReferencia(versionDeclarada("cli/0.4.24"))).toBe(false);
    expect(admiteReferencia(versionDeclarada(" sdk/0.4.24 "))).toBe(true);
  });
});
