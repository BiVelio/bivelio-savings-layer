/**
 * `pnpm cache-semantica:simulacion` — la calibración de la caché semántica con
 * una VERDAD CONOCIDA: puntuaciones uniformes en [0,6; 1] y una probabilidad de
 * reutilización errónea q(s) = 0,5 / (1 + e^{40 (s − 0,85)}), que baja con la
 * puntuación (el supuesto de monotonía). Sin red, sin modelos, semillas fijas.
 *
 * Mide lo que el stream público no puede medir, porque en él no hay ningún
 * umbral que separe (ver el informe): si la cota se cumple (en qué fracción de
 * tiradas el suelo certificado incumple δ, que tiene que ser ≤ α), cuántas
 * etiquetas hacen falta para la primera certificación en línea, y a qué
 * distancia queda el suelo certificado del óptimo verdadero.
 *
 * Escribe `benchmarks/out/cache-semantica/simulacion.json` (git lo ignora).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { EstadoDeCalibracion, mulberry32, umbralDeIndice } from "../../src/cache/calibracion.js";
import { calibrateSemanticFloor } from "../../src/cache/calibration.js";
import { procedencia } from "./arnes.js";
import { DIR_SALIDA } from "./datos.js";

export const qVerdad = (s: number): number => 0.5 / (1 + Math.exp(40 * (s - 0.85)));

/** La tasa VERDADERA de erróneas entre las reutilizaciones con puntuación ≥ t. */
export function tasaVerdadera(t: number): number {
  const a = Math.max(0.6, t);
  const pasos = 2000;
  let s = 0;
  for (let i = 0; i < pasos; i++) s += qVerdad(a + ((i + 0.5) * (1 - a)) / pasos);
  return s / pasos;
}

/** El suelo más bajo cuya tasa verdadera no pasa de δ (en la rejilla de 0,001). */
export function sueloOptimo(delta: number): number {
  let optimo = 1;
  for (let i = 1000; i >= 600; i--) {
    if (tasaVerdadera(i / 1000) <= delta) optimo = i / 1000;
    else break;
  }
  return optimo;
}

const percentil = (xs: number[], p: number) => {
  const o = [...xs].sort((a, b) => a - b);
  return o.length ? o[Math.min(o.length - 1, Math.floor(p * o.length))]! : null;
};

export function simular(delta: number, alfa: number, tiradas: number, etiquetas: number) {
  const primeras: number[] = [];
  const suelosFinales: number[] = [];
  let conViolacion = 0;
  let sinCertificar = 0;
  for (let t = 0; t < tiradas; t++) {
    const estado = new EstadoDeCalibracion(delta, alfa);
    const rng = mulberry32(5000 + t);
    let primera: number | null = null;
    let violo = false;
    let previo: number | null = null;
    for (let i = 0; i < etiquetas; i++) {
      const s = 0.6 + 0.4 * rng();
      estado.anotar(s, rng() >= qVerdad(s));
      const suelo = estado.suelo;
      if (suelo != null && primera == null) primera = i + 1;
      if (suelo != null && suelo !== previo && tasaVerdadera(umbralDeIndice(suelo)) > delta) violo = true;
      previo = suelo;
    }
    if (primera == null) sinCertificar++;
    else primeras.push(primera);
    if (estado.suelo != null) suelosFinales.push(umbralDeIndice(estado.suelo));
    if (violo) conViolacion++;
  }
  // Fuera de línea, con el mismo número de etiquetas y otras semillas.
  let fueraCertificadas = 0;
  let fueraViolaciones = 0;
  const suelosFuera: number[] = [];
  for (let t = 0; t < tiradas; t++) {
    const rng = mulberry32(9000 + t);
    const obs = Array.from({ length: etiquetas }, () => {
      const s = 0.6 + 0.4 * rng();
      return { score: s, correct: rng() >= qVerdad(s) };
    });
    const r = calibrateSemanticFloor(obs, { maxErrorRate: delta, confidence: 1 - alfa });
    if (r.floor == null) continue;
    fueraCertificadas++;
    suelosFuera.push(r.floor);
    if (tasaVerdadera(r.floor) > delta) fueraViolaciones++;
  }
  return {
    delta,
    alfa,
    tiradas,
    etiquetas,
    sueloOptimo: sueloOptimo(delta),
    enLinea: {
      tiradasConAlgunaViolacion: conViolacion,
      sinCertificarNunca: sinCertificar,
      etiquetasHastaLaPrimera: { p50: percentil(primeras, 0.5), p90: percentil(primeras, 0.9) },
      sueloFinal: { p50: percentil(suelosFinales, 0.5), certificadasAlFinal: suelosFinales.length },
    },
    fueraDeLinea: {
      certificadas: fueraCertificadas,
      violaciones: fueraViolaciones,
      sueloP50: percentil(suelosFuera, 0.5),
    },
  };
}

function main(): void {
  const casos = [
    [0.05, 0.1],
    [0.05, 0.05],
    [0.02, 0.05],
  ] as const;
  const resultados = casos.map(([d, a]) => simular(d, a, 300, 20_000));
  mkdirSync(DIR_SALIDA, { recursive: true });
  const ruta = join(DIR_SALIDA, "simulacion.json");
  const { commit, dirty } = procedencia();
  const artefacto = {
    generatedAt: new Date().toISOString(),
    commit,
    dirty,
    curva: "q(s) = 0.5 / (1 + exp(40 (s - 0.85))), s ~ U(0.6, 1)",
    resultados,
  };
  writeFileSync(ruta, JSON.stringify(artefacto, null, 1) + "\n");
  for (const r of resultados) console.log(JSON.stringify(r));
  console.log(`artifact: ${ruta}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
