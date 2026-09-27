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
 * Con `--reinicios`, cada tirada se REINICIA a intervalos al azar (de 1 a 2·N
 * etiquetas, semilla aparte): el estado se exporta, pasa por JSON y se importa
 * en un estado nuevo, como haría un despliegue serverless entre invocaciones.
 * Los suelos tienen que salir idénticos a los de la tirada sin reinicios, y las
 * violaciones también; el artefacto cuenta cuántas tiradas divergieron (0).
 *
 * Escribe `benchmarks/out/cache-semantica/simulacion.json` (git lo ignora).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  EstadoDeCalibracion,
  escribirEstado,
  leerEstado,
  mulberry32,
  umbralDeIndice,
  type IdentidadDeCalibracion,
} from "../../src/cache/calibracion.js";
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

/**
 * Un reinicio de verdad: el estado sale por `exportCalibration`, pasa por JSON
 * (lo que haría cualquier almacén) y entra por `importCalibration`, con todas
 * sus validaciones. Lo que no sobreviva a este viaje no sobrevive a un despliegue.
 */
export function reiniciarPorJson(estado: EstadoDeCalibracion, delta: number, alfa: number): EstadoDeCalibracion {
  const id: IdentidadDeCalibracion = {
    embedder: "built_in:simulacion",
    verifier: null,
    judge: "built_in:simulacion",
    maxErrorRate: delta,
    confidence: 1 - alfa,
    similarityThreshold: 0.6,
  };
  const guardado = JSON.stringify(escribirEstado(id, new Map([["single_shot", estado]])));
  return leerEstado(JSON.parse(guardado), id).get("single_shot")!;
}

export function simular(delta: number, alfa: number, tiradas: number, etiquetas: number, reinicioCada = 0) {
  const primeras: number[] = [];
  const suelosFinales: number[] = [];
  let conViolacion = 0;
  let sinCertificar = 0;
  let reinicios = 0;
  let divergentes = 0;
  for (let t = 0; t < tiradas; t++) {
    let estado = new EstadoDeCalibracion(delta, alfa);
    // La tirada de referencia, sin reiniciar nunca: con reinicios, cada suelo
    // tiene que coincidir con el suyo etiqueta a etiqueta.
    const referencia = reinicioCada > 0 ? new EstadoDeCalibracion(delta, alfa) : null;
    const rng = mulberry32(5000 + t);
    const cuandoReiniciar = mulberry32(77_000 + t);
    let siguienteReinicio = reinicioCada > 0 ? 1 + Math.floor(cuandoReiniciar() * 2 * reinicioCada) : Infinity;
    let divergio = false;
    let primera: number | null = null;
    let violo = false;
    let previo: number | null = null;
    for (let i = 0; i < etiquetas; i++) {
      const s = 0.6 + 0.4 * rng();
      const correcta = rng() >= qVerdad(s);
      estado.anotar(s, correcta);
      referencia?.anotar(s, correcta);
      if (i + 1 >= siguienteReinicio) {
        estado = reiniciarPorJson(estado, delta, alfa);
        reinicios++;
        siguienteReinicio = i + 1 + 1 + Math.floor(cuandoReiniciar() * 2 * reinicioCada);
      }
      if (referencia && referencia.suelo !== estado.suelo) divergio = true;
      const suelo = estado.suelo;
      if (suelo != null && primera == null) primera = i + 1;
      if (suelo != null && suelo !== previo && tasaVerdadera(umbralDeIndice(suelo)) > delta) violo = true;
      previo = suelo;
    }
    if (primera == null) sinCertificar++;
    else primeras.push(primera);
    if (estado.suelo != null) suelosFinales.push(umbralDeIndice(estado.suelo));
    if (violo) conViolacion++;
    if (divergio) divergentes++;
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
    ...(reinicioCada > 0
      ? { reinicios: { cadaMedia: reinicioCada, total: reinicios, tiradasQueDivergieron: divergentes } }
      : {}),
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
  // `--reinicios [N]`: reiniciar cada N etiquetas de media (500 si no se da N).
  const i = process.argv.indexOf("--reinicios");
  const reinicioCada = i < 0 ? 0 : Number(process.argv[i + 1] ?? "") > 0 ? Number(process.argv[i + 1]) : 500;
  const resultados = casos.map(([d, a]) => simular(d, a, 300, 20_000, reinicioCada));
  mkdirSync(DIR_SALIDA, { recursive: true });
  const ruta = join(DIR_SALIDA, reinicioCada > 0 ? "simulacion-reinicios.json" : "simulacion.json");
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
