import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

import { LicenseError } from "../src/license/errors.js";

/**
 * DX del paquete: lo que un instalador de npm toca de primeras.
 */

describe("empaquetado", () => {
  it("exports declara una condición `default` (require(esm) en Node ≥22, error legible en CJS viejo)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, { default?: string; import?: string }>;
    };
    const punto = pkg.exports["."];
    expect(punto, "falta el subpath \".\" en exports").toBeDefined();
    expect(punto?.default, "sin `default`, require() desde CJS da ERR_PACKAGE_PATH_NOT_EXPORTED").toBe("./dist/index.js");
    expect(punto?.import).toBe("./dist/index.js");
  });

  it("el bundle publicado NO tiene líneas gigantes (un LicenseError no vuelca 50 KB antes del mensaje)", () => {
    const distPath = new URL("../dist/index.js", import.meta.url);
    if (!existsSync(distPath)) {
      // El build aún no ha corrido en este entorno; la verja del tarball ya cubre
      // el bundle publicado. No se falla por ausencia de artefacto.
      return;
    }
    const dist = readFileSync(distPath, "utf8");
    const maxLinea = dist.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
    // El `minify: true` a secas daba ~52.000 chars en una línea. Con `lineLimit`
    // se acota. Umbral generoso (8.000) para no ser frágil pero cazar la regresión.
    expect(maxLinea, "el bundle volvió a colapsar en líneas gigantes: revisa lineLimit en tsup.config.ts").toBeLessThan(8000);
  });
});

describe("LicenseError", () => {
  it("conserva message y status, y su traza no empieza por el propio constructor", () => {
    const err = new LicenseError("necesitas una licencia", "none");
    expect(err.message).toBe("necesitas una licencia");
    expect(err.status).toBe("none");
    expect(err.name).toBe("LicenseError");
    // captureStackTrace(this, LicenseError) omite el frame del constructor.
    const primeraLinea = (err.stack ?? "").split("\n")[1] ?? "";
    expect(primeraLinea).not.toMatch(/new LicenseError|errors\.(ts|js)/);
  });
});
