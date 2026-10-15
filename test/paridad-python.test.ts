import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RUTA_JSON_ESTRICTO, RUTA_USO, textoDeVectores, vectoresJsonEstricto, vectoresUso } from "./helpers/paridad.js";
import { compactToolOutput } from "../src/compression/cola.js";

/**
 * D10 · PARIDAD TS ↔ Python.
 *
 * Tres cosas, en este orden:
 *   1. LOS VECTORES ESTÁN FRESCOS: lo que hay en test/fixtures/paridad/ es
 *      exactamente lo que la implementación de TS calcula hoy. Cambiar la regla
 *      sin `pnpm paridad:vectores` falla aquí, no en silencio en Python.
 *   2. LOS VECTORES DICEN LA VERDAD con oráculos que no son el código: lo
 *      compactado vuelve a leerse igual con JSON.parse y solo perdió espacio;
 *      nada incompleto sale tarifado.
 *   3. PYTHON DICE LO MISMO: pytest sobre los mismos ficheros
 *      (packages/python/tests/test_paridad.py). Sin Python ≥ 3.10 con pytest se
 *      salta en local; en CI es obligatorio.
 */

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const EN_CI = process.env.CI === "true";
const PY = process.env.BVSALA_PYTHON ?? "python3";
const sonda = spawnSync(PY, ["-c", "import sys, pytest; assert sys.version_info >= (3, 10)"], { encoding: "utf8" });
const hayPytest = sonda.status === 0;

describe("los vectores de paridad están frescos", () => {
  it.each(Object.entries(textoDeVectores()))("%s es lo que TS calcula hoy", (ruta, esperado) => {
    expect(readFileSync(`${RAIZ}${ruta}`, "utf8"), "pnpm paridad:vectores lo regenera").toBe(esperado);
  });

  it("el script de comprobación lo dice igual (sale 0 con los ficheros al día)", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", `${RAIZ}scripts/paridad-vectores.ts`, "--comprobar"], {
      encoding: "utf8",
      cwd: RAIZ,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`fresco   ${RUTA_JSON_ESTRICTO}`);
    expect(r.stdout).toContain(`fresco   ${RUTA_USO}`);
  }, 30_000);
});

describe("los vectores dicen la verdad (oráculos que no son el código)", () => {
  const json = vectoresJsonEstricto();
  const uso = vectoresUso();

  it("cubren cada código de motivo del perfil, y los dos estados", () => {
    const motivos = new Set(json.casos.map((c) => c.esperado.reason));
    for (const m of ["applied", "not_json", "invalid_json", "duplicate_keys", "invalid_unicode", "not_smaller", "below_threshold"]) {
      expect(motivos, m).toContain(m);
    }
    // `protected` es de la selección por mensaje (vista de fichero, herramienta exceptuada), no del texto.
    expect(motivos).not.toContain("protected");
    const estados = new Set(uso.casos.map((c) => c.esperado.precio.state));
    expect([...estados].sort()).toEqual(["priced", "uncertain", "unpriced"]);
  });

  it("lo aplicado se lee igual con JSON.parse y solo perdió espacio JSON", () => {
    const aplicados = json.casos.filter((c) => c.esperado.changed);
    expect(aplicados.length).toBeGreaterThanOrEqual(8);
    const espacio = (s: string) => s.replace(/[^ \t\n\r]/g, "").length;
    for (const c of aplicados) {
      const { texto } = c.entrada;
      expect(JSON.parse(c.esperado.text), c.nombre).toEqual(JSON.parse(texto));
      expect(texto.length - c.esperado.text.length, c.nombre).toBe(espacio(texto) - espacio(c.esperado.text));
      expect(c.esperado.tokensAfter, c.nombre).toBeLessThan(c.esperado.tokensBefore);
    }
  });

  it("lo desviado sale byte a byte, con los tokens de antes", () => {
    for (const c of json.casos.filter((x) => !x.esperado.changed)) {
      expect(c.esperado.text, c.nombre).toBe(c.entrada.texto);
      expect(c.esperado.status).toBe("bypassed");
      expect(c.esperado.tokensAfter).toBe(c.esperado.tokensBefore);
    }
  });

  it("una clave duplicada que JSON.parse aplana nunca se compacta", () => {
    const c = json.casos.find((x) => x.nombre === "clave duplicada en la raíz")!;
    // JSON.parse se queda con el último valor: dos textos distintos «dicen lo mismo».
    expect(JSON.parse(c.entrada.texto).a).toBe(2);
    expect(c.esperado.reason).toBe("duplicate_keys");
    // Y el perfil de siempre (sin `lossless-data`) sí lo compactaría: por eso existe el estricto.
    expect(compactToolOutput(c.entrada.texto, { transforms: ["json"], minSavedChars: 1 }).changed).toBe(true);
  });

  it("nada incompleto, estimado o contado por el cliente sale `priced`", () => {
    for (const c of uso.casos) {
      const { uso: u, precio } = c.esperado;
      if (u.completeness !== "complete" || u.basis !== "provider_reported" || c.fila === null || !c.fila.propio) {
        expect(precio.state, c.nombre).not.toBe("priced");
      }
    }
  });

  it("el coste a mano: claude-sonnet-4-5 con caché es 20 400 µUSD", () => {
    // 1000×3 + 8000×0,3 + 2000×3,75 + 500×15 µ$ (precio de lista, no leído del código).
    const c = uso.casos.find((x) => x.nombre === "anthropic completo con caché")!;
    expect(c.esperado.precio).toMatchObject({ state: "priced", amountMicroUsd: 20_400 });
  });
});

describe("Python dice lo mismo sobre los mismos vectores", () => {
  it.skipIf(!hayPytest && !EN_CI)("pytest packages/python/tests/test_paridad.py pasa entero", () => {
    expect(hayPytest, `${PY} with pytest is required in CI: ${sonda.stderr}`).toBe(true);
    const r = spawnSync(PY, ["-m", "pytest", "-q", "-p", "no:cacheprovider", "packages/python/tests/test_paridad.py"], {
      cwd: RAIZ,
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 60_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\b\d+ passed\b/);
    expect(r.stdout).not.toMatch(/skipped|failed/);
  }, 90_000);
});
