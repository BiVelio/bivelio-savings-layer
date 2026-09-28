/**
 * GSM8K (Cobbe et al. 2021, «Training Verifiers to Solve Math Word Problems»),
 * repositorio `openai/grade-school-math`, licencia MIT.
 *
 * Se baja SIEMPRE el commit fijado y se comprueba su sha256 y su tamaño antes de
 * leer una sola línea. Los ficheros van a `benchmarks/out/gsm8k/datos/`, que git
 * ignora: este repositorio no redistribuye el conjunto.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { descargarVerificado, sha256Hex } from "../../cache-semantica/datos.js";
import type { Fuente } from "../../cache-semantica/fuentes.js";

export const DIR_SALIDA_GSM8K = fileURLToPath(new URL("../../out/gsm8k/", import.meta.url));
export const DIR_DATOS_GSM8K = join(DIR_SALIDA_GSM8K, "datos");

/** Último commit de `main` en openai/grade-school-math (2021-11-19, «update readme»). */
export const GSM8K_COMMIT = "3101c7d5072418e28b9008a6636bde82a006892c";
const RAW = `https://raw.githubusercontent.com/openai/grade-school-math/${GSM8K_COMMIT}/grade_school_math/data`;
const COMUN = {
  revision: GSM8K_COMMIT,
  licencia: "MIT",
  urlLicencia: `https://github.com/openai/grade-school-math/blob/${GSM8K_COMMIT}/LICENSE`,
  consultado: "2026-09-28",
  origenNoComercial: false,
} as const;

export const FUENTE_GSM8K_TEST: Fuente = {
  id: "gsm8k-test",
  nombre: "GSM8K test split (openai/grade-school-math)",
  url: `${RAW}/test.jsonl`,
  sha256: "3730d312f6e3440559ace48831e51066acaca737f6eabec99bccb9e4b3c39d14",
  bytes: 749_738,
  filas: 1319,
  ...COMUN,
};

/** El split de entrenamiento: solo de aquí salen los 8 ejemplos del few-shot. */
export const FUENTE_GSM8K_TRAIN: Fuente = {
  id: "gsm8k-train",
  nombre: "GSM8K train split (openai/grade-school-math)",
  url: `${RAW}/train.jsonl`,
  sha256: "17f347dc51477c50d4efb83959dbb7c56297aba886e5544ee2aaed3024813465",
  bytes: 4_166_206,
  filas: 7473,
  ...COMUN,
};

export interface FilaGsm8k {
  question: string;
  answer: string;
}

export function rutaDe(f: Fuente, dir = DIR_DATOS_GSM8K): string {
  return join(dir, f.url.split("/").pop()!);
}

/** Baja lo que falte; lo que ya está se vuelve a verificar al leerlo. */
export async function asegurarDatos(dir = DIR_DATOS_GSM8K, fetchImpl: typeof fetch = fetch): Promise<void> {
  for (const f of [FUENTE_GSM8K_TEST, FUENTE_GSM8K_TRAIN]) {
    if (!existsSync(rutaDe(f, dir))) await descargarVerificado(f, rutaDe(f, dir), fetchImpl);
  }
}

/** Lee un split y RE-VERIFICA su huella: un fichero tocado después de bajarlo no pasa. */
export function leerSplit(f: Fuente, dir = DIR_DATOS_GSM8K): FilaGsm8k[] {
  const bytes = readFileSync(rutaDe(f, dir));
  const sha = sha256Hex(bytes);
  if (sha !== f.sha256) throw new Error(`${f.id}: sha256 mismatch on read (got ${sha}, pinned ${f.sha256})`);
  const filas = bytes
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as FilaGsm8k);
  if (filas.length !== f.filas) throw new Error(`${f.id}: ${filas.length} rows, pinned ${f.filas}`);
  return filas;
}
