import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { textoDeVectores } from "../test/helpers/paridad.js";

/**
 * LOS VECTORES DE PARIDAD TS ↔ Python, regenerados desde la implementación de TS.
 *
 *   pnpm paridad:vectores              reescribe test/fixtures/paridad/*.json
 *   pnpm paridad:vectores --comprobar  sale con 1 si alguno no está fresco
 *
 * Los casos viven en test/helpers/paridad.ts; lo esperado lo calcula TS. Python
 * (packages/python/tests/test_paridad.py) los consume tal cual, y
 * test/paridad-python.test.ts exige que lo que hay en disco sea esto.
 */

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const comprobar = process.argv.includes("--comprobar");
let rancios = 0;
for (const [ruta, texto] of Object.entries(textoDeVectores())) {
  const absoluta = join(RAIZ, ruta);
  let actual: string | undefined;
  try {
    actual = readFileSync(absoluta, "utf8");
  } catch {
    actual = undefined;
  }
  if (actual === texto) {
    console.log(`fresco   ${ruta}`);
    continue;
  }
  if (comprobar) {
    rancios++;
    console.log(`RANCIO   ${ruta}  (pnpm paridad:vectores lo regenera)`);
    continue;
  }
  mkdirSync(dirname(absoluta), { recursive: true });
  writeFileSync(absoluta, texto);
  console.log(`escrito  ${ruta}`);
}
if (rancios > 0) process.exit(1);
