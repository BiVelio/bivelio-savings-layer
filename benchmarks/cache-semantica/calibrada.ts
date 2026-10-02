/**
 * `pnpm cache-semantica:calibrada` — la caché semántica CALIBRADA (opt-in)
 * frente a la que se envía por defecto, sobre los mismos conjuntos públicos y
 * por la capa completa.
 *
 *   --n <N>              filas del stream de SemBenchmarkLmArena (por defecto 20000)
 *   --delta <d,d,...>    tasas máximas de reutilización errónea a probar (por defecto 0.15,0.12,0.1,0.05,0.02)
 *   --solo-etiquetas     solo las etiquetas del stream y su calibración fuera de línea, sin los brazos
 *   --auditoria <r>      tasa de auditoría (por defecto 0.05, la del SDK)
 *   --embebedor built_in|dataset:<columna>   (dataset:* baja ~1 GB por rangos; diagnóstico)
 *   --datos <dir>        dónde viven los datos (`pnpm cache-semantica --descargar` primero)
 *
 * Escribe `benchmarks/out/cache-semantica/calibrada.json` (git lo ignora). Sin
 * llamadas a ningún LLM y sin secretos: el proveedor es falso, el juez es la
 * definición de correcto del dataset (misma clase) y la única red es la de las
 * descargas públicas ya fijadas en `fuentes.ts`.
 *
 * LO QUE MIDE Y LO QUE NO. Mide si la cota que promete la calibración (a lo sumo
 * δ de reutilizaciones erróneas, con 95 % de confianza) se cumple en un stream
 * que la caché no ha visto, cuánto cuesta en reutilizaciones (el arranque en
 * frío y las auditorías) y si el suelo por registro ayuda. No mide ahorro: una
 * reutilización no es dinero hasta que el contador del proveedor lo diga.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { calibrateSemanticFloor, type CalibrationObservation } from "../../src/cache/calibration.js";
import { InMemorySemanticCache, type SemanticCacheOptions } from "../../src/cache/semantic.js";
import { canonicalize } from "../../src/canonicalization/canonicalize.js";
import { evaluatePolicy } from "../../src/policy/policy.js";
import { BV_SALA_VERSION } from "../../src/version.js";
import { mulberry32, type CI } from "../stats.js";
import { procedencia } from "./arnes.js";
import { cargarVectoresLmArena, DIR_DATOS, DIR_SALIDA, leerCasos, leerEtiquetas, leerLmArena } from "./datos.js";
import { createSavingsLayer } from "../../src/pipeline/create.js";
import type { CachedAnswer } from "../../src/cache/exact.js";
import {
  AHORROS,
  conducirStream,
  filtrarBrazos,
  leerRespuesta,
  metricasStream,
  MODELO,
  respuestaDe,
  type CasoTripleta,
  type FilaEtiqueta,
  type FilaStream,
  type ResultadoStream,
  type ResumenCalibracionStream,
} from "./nucleo.js";

export const RUTA_CALIBRADA = join(DIR_SALIDA, "calibrada.json");

interface Opciones {
  n: number;
  deltas: number[];
  auditoria: number;
  embebedor: string;
  dirDatos: string;
  /** Solo las etiquetas del stream y su calibración fuera de línea (sin los brazos, que con vectores de 1.024 dimensiones tardan minutos cada uno). */
  soloEtiquetas: boolean;
}

export function parsear(argv: string[]): Opciones {
  const o: Opciones = {
    n: 20_000, deltas: [0.15, 0.12, 0.1, 0.05, 0.02], auditoria: 0.05, embebedor: "built_in", dirDatos: DIR_DATOS,
    soloEtiquetas: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--solo-etiquetas") {
      o.soloEtiquetas = true;
      continue;
    }
    const v = argv[i + 1];
    if (v == null) throw new Error(`${a} needs a value`);
    i++;
    if (a === "--n") o.n = Number(v);
    else if (a === "--delta") o.deltas = v.split(",").map(Number);
    else if (a === "--auditoria") o.auditoria = Number(v);
    else if (a === "--embebedor") o.embebedor = v;
    else if (a === "--datos") o.dirDatos = v;
    else throw new Error(`unknown flag ${a}`);
  }
  if (!Number.isInteger(o.n) || o.n < 0) throw new Error("--n must be a non-negative integer");
  if (o.deltas.some((d) => !(d > 0 && d <= 0.5))) throw new Error("--delta values must be in (0, 0.5]");
  if (!(o.auditoria >= 0 && o.auditoria < 1)) throw new Error("--auditoria must be in [0, 1)");
  return o;
}

export interface Brazo {
  nombre: string;
  config: { delta?: number; confianza?: number; auditoria?: number; suelosPorRegistro?: boolean };
  consultas: number;
  aciertos: number;
  correctos: number;
  erroneos: number;
  hitRate: CI | null;
  precision: CI | null;
  errorRate: CI | null;
  /** Precisión puntual y si su punto cumple la cota 1 − δ (la cota es sobre la tasa, no sobre el punto). */
  precisionPuntual: number | null;
  cumpleLaCota: boolean | null;
  calibracion?: ResumenCalibracionStream;
  ms: number;
}

function brazo(nombre: string, config: Brazo["config"], r: ResultadoStream, ms: number): Brazo {
  const m = metricasStream(r);
  const puntual = r.aciertos > 0 ? r.correctos / r.aciertos : null;
  return {
    nombre,
    config,
    consultas: r.consultas,
    aciertos: r.aciertos,
    correctos: r.correctos,
    erroneos: r.erroneos,
    hitRate: m.hitRate,
    precision: m.precision,
    errorRate: m.errorRate,
    precisionPuntual: puntual,
    cumpleLaCota: config.delta == null || puntual == null ? null : 1 - puntual <= config.delta,
    ...(r.calibracion ? { calibracion: r.calibracion } : {}),
    ms,
  };
}

/**
 * LAS ETIQUETAS QUE LA CALIBRACIÓN VERÍA EN ESTE STREAM, todas: una caché
 * calibrada cuyo juez nunca da por buena una reutilización no certifica nunca,
 * así que TODA candidata sale como sonda y se etiqueta. El juez anota la
 * verdad del dataset (misma clase) aparte, y la puntuación sale de la traza de
 * esa misma petición. Es el conjunto etiquetado que un cliente tendría tras
 * calibrar sobre este tráfico, y sobre él se corre la calibración fuera de
 * línea y la tabla de error por tramo de puntuación.
 *
 * OJO AL ORDEN, que ya mordió una vez: `observe` llama al juez DENTRO de la
 * etapa 12, antes de que `generate` devuelva el informe con la traza. Una
 * primera versión apuntaba desde el juez la puntuación de la traza ANTERIOR,
 * y la tabla salía plana por construcción (cada veredicto con la puntuación de
 * otra candidata). Por eso aquí veredictos y puntuaciones van en dos listas, en
 * el orden en que ocurren, y se casan al final comprobando que miden lo mismo.
 */
export interface EtiquetaDelStream extends CalibrationObservation {
  /** El `id` de la fila consultada y el de la fila cuya respuesta estaba guardada. */
  consulta: number;
  guardada: number;
}

export async function etiquetasDelStream(
  filas: FilaStream[],
  opcionesCache: SemanticCacheOptions,
): Promise<EtiquetaDelStream[]> {
  const veredictos: { correct: boolean; consulta: number; guardada: number }[] = [];
  const puntuaciones: number[] = [];
  const semanticCache = new InMemorySemanticCache({
    ...opcionesCache,
    maxRecords: 5_000,
    calibration: {
      maxErrorRate: 0.5,
      auditRate: 0,
      perRecordFloors: false,
      judge: (guardada: CachedAnswer, fresca: CachedAnswer) => {
        const a = leerRespuesta(guardada.text);
        const b = leerRespuesta(fresca.text);
        if (a == null || b == null) throw new Error("label without a class");
        veredictos.push({ correct: a.idSet === b.idSet, consulta: b.id, guardada: a.id });
        return false;
      },
    },
  });
  let siguiente = "";
  const layer = createSavingsLayer({
    provider: {
      id: "bench-semantic-cache",
      async generate() {
        return { text: siguiente, usage: { inputTokens: 10, outputTokens: 10 }, finishReason: "stop" };
      },
    },
    semanticCacheStore: semanticCache,
    devUnlicensed: true,
    silenceWarnings: true,
  });
  try {
    for (const f of filas) {
      siguiente = respuestaDe(f.idSet, f.id);
      const r = await layer.generate({
        model: MODELO,
        savings: { ...AHORROS },
        context: { tenantId: "stream" },
        messages: [{ role: "user", content: f.prompt }],
      });
      await semanticCache.settled();
      const t = r.report.traces.find((x) => x.stage === "semantic-calibration" && x.outcome === "label requested");
      if (t) puntuaciones.push(Number(t.detail?.["score"]));
      if (veredictos.length !== puntuaciones.length) {
        throw new Error(`row ${f.id}: ${veredictos.length} verdicts for ${puntuaciones.length} scores`);
      }
    }
  } finally {
    await layer.close();
  }
  return veredictos.map((v, i) => ({ score: puntuaciones[i]!, ...v }));
}

/**
 * ¿Cuántas «erróneas» son ruido de etiqueta? Una etiqueta errónea cuyo prompt
 * guardado es IDÉNTICO al consultado no es un error de la caché: el dataset
 * pone el mismo texto en dos clases. Se cuenta en total y a puntuación 1,00.
 */
export function ruidoDeEtiqueta(obs: EtiquetaDelStream[], filas: FilaStream[]) {
  const texto = new Map(filas.map((f) => [f.id, f.prompt]));
  const erroneas = obs.filter((o) => !o.correct);
  const identica = (o: EtiquetaDelStream) => texto.get(o.consulta) === texto.get(o.guardada);
  const enUno = erroneas.filter((o) => o.score >= 0.9995);
  return {
    erroneas: erroneas.length,
    conPromptIdentico: erroneas.filter(identica).length,
    aPuntuacionUno: { erroneas: enUno.length, conPromptIdentico: enUno.filter(identica).length },
  };
}

/** Error por tramo de puntuación (de 0,05 en 0,05) y acumulado desde arriba: si la puntuación separa o no. */
export function tablaPorTramos(obs: CalibrationObservation[]): { desde: number; n: number; erroneas: number; nAcumulado: number; errorAcumulado: number }[] {
  const tramos = new Map<number, { n: number; e: number }>();
  for (const o of obs) {
    const k = Math.min(1, Math.floor(o.score * 20 + 1e-9) / 20);
    const t = tramos.get(k) ?? { n: 0, e: 0 };
    t.n++;
    if (!o.correct) t.e++;
    tramos.set(k, t);
  }
  let n = 0;
  let e = 0;
  return [...tramos.entries()]
    .sort(([a], [b]) => b - a)
    .map(([desde, t]) => {
      n += t.n;
      e += t.e;
      return { desde, n: t.n, erroneas: t.e, nAcumulado: n, errorAcumulado: e / n };
    });
}

/**
 * Las tripletas `arena` (las no derivadas de ORCAS), como ETIQUETAS fuera de
 * línea: la puntuación que la caché calibrada daría a la candidata (similitud,
 * con la verja determinista y la política ya aplicadas) y la etiqueta del
 * dataset. Se calibra en el split `calibration` y se comprueba en `test`.
 */
export async function tripletasFueraDeLinea(dir: string, delta: number) {
  const casos = filtrarBrazos(leerCasos<CasoTripleta>(dir), false);
  const etiquetas = new Map(leerEtiquetas<FilaEtiqueta>(dir).map((e) => [e.uid, e]));
  const porSplit: Record<string, CalibrationObservation[]> = {};
  let sinCandidata = 0;
  for (const c of casos) {
    const e = etiquetas.get(c.uid);
    if (!e || e.label === "uncertain") continue;
    const guardada = canonicalize({ model: MODELO, messages: [{ role: "user", content: c.cached_request }], context: { tenantId: c.uid } });
    const actual = canonicalize({ model: MODELO, messages: [{ role: "user", content: c.current_request }], context: { tenantId: c.uid } });
    if (!evaluatePolicy(actual).allowSemanticCache || !evaluatePolicy(guardada).allowSemanticCache) continue;
    // Una caché calibrada sin suelo aún: toda candidata sale como sonda con su puntuación.
    const cache = new InMemorySemanticCache({ calibration: { maxErrorRate: delta } });
    await cache.store(guardada, { text: "", storedAtMs: 0 });
    const { probe } = await cache.lookup(actual);
    if (!probe) {
      sinCandidata++;
      continue;
    }
    (porSplit[c.split] ??= []).push({ score: probe.score, correct: e.label === "reuse" });
  }
  const cal = porSplit["calibration"] ?? [];
  const test = porSplit["test"] ?? [];
  const certificado = calibrateSemanticFloor(cal, { maxErrorRate: delta });
  const todo = calibrateSemanticFloor([...cal, ...test], { maxErrorRate: delta });
  const enTest = (suelo: number | null) => {
    if (suelo == null) return null;
    const servidas = test.filter((o) => o.score >= suelo);
    const erroneas = servidas.filter((o) => !o.correct).length;
    return { servidas: servidas.length, erroneas };
  };
  return {
    delta,
    candidatas: { calibration: cal.length, test: test.length, sinCandidata },
    reutilizablesEnCandidatas: {
      calibration: cal.filter((o) => o.correct).length,
      test: test.filter((o) => o.correct).length,
    },
    calibradoEnCalibration: { ...certificado, enTest: enTest(certificado.floor) },
    calibradoEnTodo: todo,
  };
}

async function main(): Promise<void> {
  const o = parsear(process.argv.slice(2));
  const { filas, extraccion } = leerLmArena(o.dirDatos, o.n);
  let opcionesCache: SemanticCacheOptions = {};
  if (o.embebedor.startsWith("dataset:")) {
    const columna = o.embebedor.slice("dataset:".length);
    console.log(`Loading precomputed vectors from column ${columna} (large download)...`);
    const vectores = await cargarVectoresLmArena(columna, filas.length);
    const porTexto = new Map<string, number[]>();
    for (const f of filas) {
      const v = vectores.get(f.id);
      if (!v) throw new Error(`no vector for row ${f.id}`);
      const t = canonicalize({ model: MODELO, messages: [{ role: "user", content: f.prompt }], context: { tenantId: "stream" } }).normalizedText;
      porTexto.set(t, v);
    }
    opcionesCache = {
      embed: (t: string) => {
        const v = porTexto.get(t);
        if (!v) throw new Error("embed: text without a precomputed vector");
        return v;
      },
    };
  } else if (o.embebedor !== "built_in") {
    throw new Error(`--embebedor: "${o.embebedor}" is not built_in or dataset:<column>`);
  }

  console.log("Stream labels (every candidate, judged by the dataset's class)...");
  const t0 = Date.now();
  const etiquetas = await etiquetasDelStream(filas, opcionesCache);
  const etiquetasStream = {
    n: etiquetas.length,
    ms: Date.now() - t0,
    ruidoDeEtiqueta: ruidoDeEtiqueta(etiquetas, filas),
    tramos: tablaPorTramos(etiquetas),
    fueraDeLinea: o.deltas.map((d) => calibrateSemanticFloor(etiquetas, { maxErrorRate: d })),
  };

  const brazos: Brazo[] = [];
  const correr = async (nombre: string, config: Brazo["config"]) => {
    console.log(`${nombre}...`);
    const t0 = Date.now();
    const r = await conducirStream(filas, {
      maxRegistros: 5_000,
      opcionesCache,
      ...(config.delta != null
        ? {
            calibracion: {
              maxErrorRate: config.delta,
              confidence: config.confianza ?? 0.95,
              auditRate: config.auditoria ?? o.auditoria,
              perRecordFloors: config.suelosPorRegistro ?? true,
              // Semilla fija: las auditorías son reproducibles tirada a tirada.
              random: mulberry32(20260927),
            },
          }
        : {}),
    });
    brazos.push(brazo(nombre, config, r, Date.now() - t0));
  };

  if (!o.soloEtiquetas) {
    await correr("static (as shipped)", {});
    for (const d of o.deltas) {
      await correr(`calibrated δ=${d}`, { delta: d, confianza: 0.95, auditoria: o.auditoria, suelosPorRegistro: true });
      await correr(`calibrated δ=${d}, no per-record floors`, { delta: d, confianza: 0.95, auditoria: o.auditoria, suelosPorRegistro: false });
    }
  }

  const tripletas = o.embebedor === "built_in" ? await Promise.all(o.deltas.map((d) => tripletasFueraDeLinea(o.dirDatos, d))) : [];
  const { commit, dirty } = procedencia();
  const artefacto = {
    generatedAt: new Date().toISOString(),
    commit,
    dirty,
    sdkVersion: BV_SALA_VERSION,
    node: process.version,
    embedder: o.embebedor,
    stream: { dataset: "vCache/SemBenchmarkLmArena", revision: extraccion.revision, extractSha256: extraccion.sha256, n: filas.length },
    etiquetasStream,
    brazos,
    tripletas,
  };
  mkdirSync(DIR_SALIDA, { recursive: true });
  writeFileSync(RUTA_CALIBRADA, JSON.stringify(artefacto, null, 1) + "\n");
  const pct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(1)} %`);
  const ci = (c: CI | null) => (c == null ? "—" : `${pct(c.point)} [${pct(c.lower)} – ${pct(c.upper)}]`);
  for (const b of brazos) {
    console.log(
      `${b.nombre}: hits ${b.aciertos}/${b.consultas} (${ci(b.hitRate)}), precision ${ci(b.precision)}, ` +
        `wrong ${b.erroneos} (${ci(b.errorRate)})` +
        (b.calibracion
          ? `; floor ${b.calibracion.estadoFinal.floor ?? "none"}, labels ${b.calibracion.etiquetas}, first hit at ${b.calibracion.primerAcierto ?? "never"}, ` +
            `probes ${JSON.stringify(b.calibracion.sondas)}, held-out at floor ${b.calibracion.estadoFinal.heldOutAtFloor} ` +
            `(${b.calibracion.estadoFinal.wrongHeldOutAtFloor} wrong)`
          : "") +
        ` (${(b.ms / 1000).toFixed(1)} s)`,
    );
  }
  console.log(`stream labels: ${etiquetasStream.n} (${(etiquetasStream.ms / 1000).toFixed(1)} s); label noise ${JSON.stringify(etiquetasStream.ruidoDeEtiqueta)}`);
  for (const t of etiquetasStream.tramos) {
    console.log(`  score ≥ ${t.desde.toFixed(2)}: ${t.n} labels, ${t.erroneas} wrong; cumulative ${t.nAcumulado}, ${pct(t.errorAcumulado)} wrong`);
  }
  for (const f of etiquetasStream.fueraDeLinea) {
    console.log(`  offline δ=${f.maxErrorRate}: floor ${f.floor ?? "none"} (held-out at floor ${f.heldOutAtFloor}, ${f.wrongHeldOutAtFloor} wrong)`);
  }
  for (const t of tripletas) console.log(`triplets δ=${t.delta}: ${JSON.stringify(t)}`);
  console.log(`artifact: ${RUTA_CALIBRADA}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
