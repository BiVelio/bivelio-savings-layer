/**
 * `pnpm cache-semantica` — precisión y recall de la caché semántica contra
 * conjuntos públicos, por la capa completa y con la configuración que se envía.
 *
 *   --seco                      en seco, con el fixture sintético propio (sin red); lo que corre la CI
 *   --descargar                 baja y verifica las revisiones fijadas (y extrae LmArena por rangos)
 *   --verificar-puntuador       recalcula las cifras del proyecto con este puntuador (364/365, 364/505)
 *   --conjunto tripletas|lmarena|todos   (por defecto: todos)
 *   --n <N>                     filas del stream de LmArena (por defecto 20000; 0 = todas)
 *   --incluir-orcas             incluye los brazos derivados de ORCAS (uso interno; el publicador los rechaza)
 *   --max-registros <N>         tope de la caché en el stream (por defecto, el que se envía)
 *   --embebedor built_in|dataset:<columna>   (dataset:* solo con --conjunto lmarena; ~1 GB de red;
 *                               es un diagnóstico: el publicador no lo convierte en documento)
 *   --datos <dir>               dónde viven los datos descargados (por defecto benchmarks/out/cache-semantica/datos)
 *
 * Escribe `benchmarks/out/cache-semantica/resultado.json` (git lo ignora). El
 * documento público sale SOLO de ese artefacto, con `pnpm cache-semantica:publicar`.
 *
 * Sin llamadas a ningún LLM y sin secretos: el proveedor es falso y lo único
 * que sale a la red son descargas públicas de revisiones fijadas.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { InMemorySemanticCache, type SemanticCacheOptions } from "../../src/cache/semantic.js";
import { canonicalize } from "../../src/canonicalization/canonicalize.js";
import { BV_SALA_VERSION } from "../../src/version.js";
import {
  cargarVectoresLmArena,
  descargarTripletas,
  DIR_DATOS,
  DIR_SALIDA,
  extraerLmArena,
  leerBaselineJev,
  leerCasos,
  leerEtiquetas,
  leerJsonl,
  leerLmArena,
} from "./datos.js";
import { FUENTE_BASELINE_JEV, FUENTE_CASOS, FUENTE_ETIQUETAS, FUENTE_LMARENA } from "./fuentes.js";
import {
  AHORROS,
  conducirStream,
  conducirTripletas,
  conducirTripletasComponentes,
  contar,
  filtrarBrazos,
  metricas,
  metricasStream,
  MODELO,
  puntuarBaseline,
  puntuarTripletas,
  sondearMaxRegistros,
  sondearSuelos,
  streamDesdeTripletas,
  verificarPuntuador,
  type CasoTripleta,
  type FilaBaseline,
  type FilaEtiqueta,
  type FilaStream,
  type ResultadoStream,
  type ResultadoTripleta,
} from "./nucleo.js";
import { intervalo, pct, type Artefacto, type FuenteUsada } from "./publicar-verja.js";

export const RUTA_FIXTURE = fileURLToPath(new URL("./fixture-seco.jsonl", import.meta.url));
export const RUTA_ARTEFACTO = join(DIR_SALIDA, "resultado.json");

export interface OpcionesArnes {
  seco: boolean;
  descargar: boolean;
  verificarPuntuador: boolean;
  conjunto: "tripletas" | "lmarena" | "todos";
  n: number;
  incluirOrcas: boolean;
  maxRegistros?: number;
  embebedor: string;
  dirDatos: string;
}

export function parsearArgumentos(argv: string[]): OpcionesArnes {
  const o: OpcionesArnes = {
    seco: false, descargar: false, verificarPuntuador: false, conjunto: "todos", n: 20_000,
    incluirOrcas: false, embebedor: "built_in", dirDatos: DIR_DATOS,
  };
  const valor = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v == null || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--seco": o.seco = true; break;
      case "--descargar": o.descargar = true; break;
      case "--verificar-puntuador": o.verificarPuntuador = true; break;
      case "--incluir-orcas": o.incluirOrcas = true; break;
      case "--conjunto": {
        const v = valor(i++, a);
        if (v !== "tripletas" && v !== "lmarena" && v !== "todos") throw new Error(`--conjunto: unknown set "${v}"`);
        o.conjunto = v;
        break;
      }
      case "--n": {
        const v = Number(valor(i++, a));
        if (!Number.isInteger(v) || v < 0) throw new Error("--n must be a non-negative integer");
        o.n = v;
        break;
      }
      case "--max-registros": {
        const v = Number(valor(i++, a));
        if (!Number.isInteger(v) || v < 1) throw new Error("--max-registros must be a positive integer");
        o.maxRegistros = v;
        break;
      }
      case "--embebedor": {
        const v = valor(i++, a);
        if (v !== "built_in" && !/^dataset:[\w.-]+$/.test(v)) throw new Error(`--embebedor: "${v}" is not built_in or dataset:<column>`);
        o.embebedor = v;
        break;
      }
      case "--datos": o.dirDatos = valor(i++, a); break;
      default:
        throw new Error(`unknown flag ${a}`);
    }
  }
  if (o.embebedor !== "built_in" && o.conjunto !== "lmarena") {
    throw new Error("--embebedor dataset:<column> only applies to --conjunto lmarena (the triplets carry no vectors)");
  }
  return o;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Procedencia del código que corre: commit y si el árbol estaba limpio (incluye no rastreados). */
export function procedencia(): { commit: string | null; dirty: boolean } {
  const commit = git(["rev-parse", "HEAD"]);
  const estado = git(["status", "--porcelain"]);
  return { commit, dirty: estado == null ? true : estado.length > 0 };
}

const r6 = (x: number | undefined) => (x == null ? undefined : Math.round(x * 1e6) / 1e6);

function evidenciaDeCasos(rs: ResultadoTripleta[]): Artefacto["casos"] {
  return rs.map((r) => ({
    uid: r.uid,
    arm: r.arm,
    split: r.split,
    decision: r.acierto ? "hit" : "miss",
    ...(r.similarity !== undefined ? { similarity: r6(r.similarity)! } : {}),
  }));
}

function resumenStream(r: ResultadoStream, ms: number): NonNullable<Artefacto["lmarena"]> {
  return {
    n: r.n, consultas: r.consultas, aciertos: r.aciertos, correctos: r.correctos, erroneos: r.erroneos,
    alcanzables: r.alcanzables, desalojos: r.desalojos, maxRegistros: r.maxRegistros,
    erroresConPromptIdentico: r.erroresConPromptIdentico,
    promptsIdenticosEnVariasClases: r.promptsIdenticosEnVariasClases,
    correctosNoAlcanzables: r.correctosNoAlcanzables, noConsultados: r.noConsultados.length,
    clases: r.porClase.length, metricas: metricasStream(r), ms,
  };
}

function evidenciaStream(r: ResultadoStream): NonNullable<Artefacto["evidenciaStream"]> {
  return {
    aciertos: r.aciertosDetalle.map((h) => [h.id, h.servedBy, h.correcto ? 1 : 0, r6(h.similarity) ?? null]),
    noConsultados: r.noConsultados,
  };
}

interface FilaFixture extends CasoTripleta {
  label: FilaEtiqueta["label"];
  reason_categories: string[];
  baseline_decision: FilaBaseline["decision"];
}

/**
 * EN SECO: el fixture sintético propio, por la capa real. Prueba el harness de
 * punta a punta sin red; su artefacto sale con `mode: "dry-run"` y el
 * publicador se niega a convertirlo en documento.
 */
export async function ejecutarSeco(o: OpcionesArnes, rutaFixture = RUTA_FIXTURE): Promise<Artefacto> {
  const fixture = leerJsonl<FilaFixture>(rutaFixture);
  const etiquetas: FilaEtiqueta[] = fixture.map((f) => ({ uid: f.uid, label: f.label, reason_categories: f.reason_categories }));
  const baseline: FilaBaseline[] = fixture.map((f) => ({ uid: f.uid, decision: f.baseline_decision }));
  const casos = filtrarBrazos<CasoTripleta>(fixture, o.incluirOrcas);
  const fabrica = () => new InMemorySemanticCache();
  const suelos = await sondearSuelos(fabrica);
  const maxDefecto = await sondearMaxRegistros(fabrica);
  const maxRegistros = o.maxRegistros ?? maxDefecto;

  const resultados = await conducirTripletas(casos, fabrica);
  const t0 = Date.now();
  const stream = await conducirStream(streamDesdeTripletas(casos, etiquetas), { maxRegistros });
  const { commit, dirty } = procedencia();
  return {
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    commit,
    dirty,
    sdkVersion: BV_SALA_VERSION,
    node: process.version,
    config: {
      embedder: suelos.embedder, similarityFloor: suelos.similarityFloor, acceptFloor: suelos.acceptFloor,
      effectiveFloor: suelos.effectiveFloor, maxRecords: maxRegistros, maxRecordsIsDefault: o.maxRegistros == null,
      policy: true, incluirOrcas: o.incluirOrcas, savings: { ...AHORROS },
    },
    fuentes: [
      {
        id: "dry-run-fixture", nombre: "Synthetic dry-run fixture (not a benchmark)", url: "benchmarks/cache-semantica/fixture-seco.jsonl",
        revision: "", bytes: 0, filas: fixture.length, licencia: "own synthetic cases", urlLicencia: "", consultado: "",
        origenNoComercial: false,
      },
    ],
    tripletas: {
      brazos: [...new Set(casos.map((c) => c.arm))].sort(),
      puntuacion: puntuarTripletas(resultados, etiquetas),
      contexto: { evaluador: "synthetic baseline decisions from the fixture", metricas: puntuarBaseline(casos, etiquetas, baseline) },
      diagnosticoComponentes: metricas(contar(await etiquetar(conducirTripletasComponentes(casos, fabrica), etiquetas))),
    },
    lmarena: resumenStream(stream, Date.now() - t0),
    casos: evidenciaDeCasos(resultados),
    evidenciaStream: evidenciaStream(stream),
  };
}

async function etiquetar(p: Promise<ResultadoTripleta[]>, etiquetas: FilaEtiqueta[]) {
  const label = new Map(etiquetas.map((e) => [e.uid, e.label]));
  return (await p).map((r) => ({ acierto: r.acierto, label: label.get(r.uid)! }));
}

/** EN VIVO: los conjuntos públicos ya descargados (`--descargar`). */
export async function ejecutarEnVivo(o: OpcionesArnes): Promise<Artefacto> {
  const conTripletas = o.conjunto !== "lmarena";
  const conLmArena = o.conjunto !== "tripletas";
  const fuentes: FuenteUsada[] = [];

  // El embebedor del stream: el propio (lo que se envía) o, opcionalmente, los
  // vectores precomputados de una columna del dataset.
  let opcionesCache: SemanticCacheOptions = {};
  let filasStream: FilaStream[] = [];
  let shaExtraido: string | undefined;
  if (conLmArena) {
    const { filas, extraccion } = leerLmArena(o.dirDatos, o.n);
    filasStream = filas;
    shaExtraido = extraccion.sha256;
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
    }
  }
  const fabrica = () => new InMemorySemanticCache(opcionesCache);
  // Las sondas usan textos que no están en el dataset: con vectores
  // precomputados, un vector fijo (la sonda solo compara un texto consigo mismo).
  const fabricaSonda = opcionesCache.embed
    ? () => new InMemorySemanticCache({ ...opcionesCache, embed: () => [1, 0, 0] })
    : fabrica;
  const suelos = await sondearSuelos(fabricaSonda);
  const maxDefecto = await sondearMaxRegistros(() => new InMemorySemanticCache());
  const maxRegistros = o.maxRegistros ?? maxDefecto;

  let tripletas: Artefacto["tripletas"];
  let verificacion: Artefacto["verificacionPuntuador"];
  let casosEvidencia: Artefacto["casos"] = [];
  if (conTripletas) {
    const todos = leerCasos<CasoTripleta>(o.dirDatos);
    const etiquetas = leerEtiquetas<FilaEtiqueta>(o.dirDatos);
    const baseline = leerBaselineJev<FilaBaseline>(o.dirDatos);
    verificacion = verificarPuntuador(etiquetas, baseline);
    const casos = filtrarBrazos(todos, o.incluirOrcas);
    console.log(`Triplets: ${casos.length} cases (arms: ${[...new Set(casos.map((c) => c.arm))].join(", ")})...`);
    const resultados = await conducirTripletas(casos, fabrica);
    tripletas = {
      brazos: [...new Set(casos.map((c) => c.arm))].sort(),
      puntuacion: puntuarTripletas(resultados, etiquetas),
      contexto: {
        evaluador:
          "the project's own evaluator (JEV, an LLM judge) at threshold 0.70, recomputed from `baseline_jev_070.jsonl` with this scorer",
        metricas: puntuarBaseline(casos, etiquetas, baseline),
      },
      diagnosticoComponentes: metricas(contar(await etiquetar(conducirTripletasComponentes(casos, fabrica), etiquetas))),
    };
    casosEvidencia = evidenciaDeCasos(resultados);
    fuentes.push(FUENTE_CASOS, FUENTE_ETIQUETAS, FUENTE_BASELINE_JEV);
  }

  let lmarena: Artefacto["lmarena"];
  let evidencia: Artefacto["evidenciaStream"];
  if (conLmArena) {
    console.log(`SemBenchmarkLmArena stream: ${filasStream.length} prompts, maxRecords ${maxRegistros}...`);
    const t0 = Date.now();
    const r = await conducirStream(filasStream, { maxRegistros, opcionesCache });
    lmarena = resumenStream(r, Date.now() - t0);
    evidencia = evidenciaStream(r);
    fuentes.push({ ...FUENTE_LMARENA, ...(shaExtraido ? { sha256Extraido: shaExtraido } : {}) });
  }

  const { commit, dirty } = procedencia();
  return {
    mode: "live",
    generatedAt: new Date().toISOString(),
    commit,
    dirty,
    sdkVersion: BV_SALA_VERSION,
    node: process.version,
    config: {
      embedder: o.embebedor === "built_in" ? suelos.embedder : o.embebedor,
      similarityFloor: suelos.similarityFloor,
      acceptFloor: suelos.acceptFloor,
      effectiveFloor: suelos.effectiveFloor,
      maxRecords: maxRegistros,
      maxRecordsIsDefault: o.maxRegistros == null,
      policy: true,
      incluirOrcas: o.incluirOrcas,
      savings: { ...AHORROS },
    },
    fuentes,
    ...(verificacion ? { verificacionPuntuador: verificacion } : {}),
    ...(tripletas ? { tripletas } : {}),
    ...(lmarena ? { lmarena } : {}),
    casos: casosEvidencia,
    ...(evidencia ? { evidenciaStream: evidencia } : {}),
  };
}

export function resumen(a: Artefacto): string {
  const l: string[] = [];
  l.push(`mode=${a.mode} commit=${a.commit?.slice(0, 7) ?? "?"}${a.dirty ? " (dirty)" : ""} sdk=${a.sdkVersion}`);
  l.push(
    `config: embedder=${a.config.embedder} similarityFloor=${a.config.similarityFloor} acceptFloor=${a.config.acceptFloor} ` +
      `effectiveFloor=${a.config.effectiveFloor} maxRecords=${a.config.maxRecords}`,
  );
  if (a.verificacionPuntuador) {
    const v = a.verificacionPuntuador;
    l.push(`scorer self-check: ${v.ok ? "OK" : "FAILED"} (precision ${v.precision.k}/${v.precision.n}, recall ${v.recall.k}/${v.recall.n})`);
  }
  if (a.tripletas) {
    const t = a.tripletas.puntuacion.total;
    l.push(
      `triplets [${a.tripletas.brazos.join(", ")}]: precision ${intervalo(t.precision)} (${t.conteo.tp}/${t.conteo.tp + t.conteo.fp}), ` +
        `recall ${intervalo(t.recall)} (${t.conteo.tp}/${t.conteo.tp + t.conteo.fn}), wrong reuses ${t.wrongReuses}, ` +
        `uncertain ${t.conteo.inciertos}`,
    );
    if (a.tripletas.contexto) {
      const c = a.tripletas.contexto.metricas;
      l.push(`  context (${a.tripletas.contexto.evaluador}): precision ${intervalo(c.precision)}, recall ${intervalo(c.recall)}`);
    }
  }
  if (a.lmarena) {
    const s = a.lmarena;
    l.push(
      `stream N=${s.n} consulted=${s.consultas}: hit rate ${intervalo(s.metricas.hitRate)}, precision ${intervalo(s.metricas.precision)}, ` +
        `error rate ${intervalo(s.metricas.errorRate)}, recall vs reachable ${intervalo(s.metricas.recallAlcanzable)}; ` +
        `evictions ${s.desalojos}, identical-prompt disagreements ${s.erroresConPromptIdentico} (${(s.ms / 1000).toFixed(1)} s)`,
    );
  }
  l.push(`headline candidate: precision floor ${pct(a.tripletas?.puntuacion.total.precision?.lower)}`);
  return l.join("\n");
}

/**
 * JSON legible, pero con los arrays de valores sueltos en UNA línea: la
 * evidencia del stream son miles de tuplas [id, servedBy, correcto, similitud]
 * y, sangradas elemento a elemento, multiplicarían por seis las líneas del
 * fichero que se versiona como evidencia.
 */
export function serializarArtefacto(a: Artefacto): string {
  return (
    JSON.stringify(a, null, 1).replace(/\[\n([^[\]{}]*?)\n\s*\]/g, (_, cuerpo: string) =>
      `[${cuerpo.split("\n").map((l) => l.trim()).join(" ")}]`,
    ) + "\n"
  );
}

export function escribirArtefacto(a: Artefacto, ruta = RUTA_ARTEFACTO): void {
  mkdirSync(DIR_SALIDA, { recursive: true });
  writeFileSync(ruta, serializarArtefacto(a));
}

async function main(): Promise<void> {
  const o = parsearArgumentos(process.argv.slice(2));
  if (o.descargar) {
    if (o.conjunto !== "lmarena") {
      await descargarTripletas(o.dirDatos);
      console.log("GPTCache reuse_compatibility: cases, labels and baseline downloaded and sha256-verified.");
    }
    if (o.conjunto !== "tripletas") {
      const e = await extraerLmArena(o.dirDatos);
      console.log(`SemBenchmarkLmArena: ${e.filas} rows extracted at ${e.revision.slice(0, 7)} (sha256 ${e.sha256.slice(0, 12)}…).`);
    }
    return;
  }
  if (o.verificarPuntuador) {
    const v = verificarPuntuador(leerEtiquetas<FilaEtiqueta>(o.dirDatos), leerBaselineJev<FilaBaseline>(o.dirDatos));
    console.log(
      `scorer self-check: precision ${v.precision.k}/${v.precision.n} (expected ${v.esperado.precision.k}/${v.esperado.precision.n}), ` +
        `recall ${v.recall.k}/${v.recall.n} (expected ${v.esperado.recall.k}/${v.esperado.recall.n}) → ${v.ok ? "OK" : "FAILED"}`,
    );
    process.exitCode = v.ok ? 0 : 1;
    return;
  }
  const a = o.seco ? await ejecutarSeco(o) : await ejecutarEnVivo(o);
  escribirArtefacto(a);
  console.log(resumen(a));
  console.log(`artifact: ${RUTA_ARTEFACTO}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

