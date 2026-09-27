/**
 * La verja del publicador (D21): qué artefacto puede convertirse en
 * `docs/SEMANTIC-CACHE-PRECISION.md` y cuál no. Pura, sin E/S, para probarla
 * con artefactos sintéticos.
 *
 * Se niega a publicar: un artefacto en seco (no midió nada), uno medido sobre un
 * árbol sucio (el código que corrió no es ningún commit), uno sin commit, uno
 * al que le falte la revisión o la huella de alguna fuente, y uno que lleve
 * datos de origen NO COMERCIAL (lo derivado de ORCAS) salvo que el dueño lo
 * haya autorizado explícitamente. «Se publica el suelo» empieza por no publicar
 * nada que no se pueda reproducir.
 */
import type { CI } from "../stats.js";
import type { Metricas, MetricasStream, PuntuacionTripletas, Verificacion } from "./nucleo.js";
import { esBrazoNoComercial, type Fuente } from "./fuentes.js";

/** Una fuente tal como la usó una tirada: la fijada, más el sha256 del extracto si lo hubo. */
export interface FuenteUsada extends Fuente {
  /** sha256 del JSONL extraído (fuentes leídas por rangos, sin fichero completo). */
  sha256Extraido?: string;
}

export interface Artefacto {
  mode: "live" | "dry-run";
  generatedAt: string;
  commit: string | null;
  dirty: boolean;
  sdkVersion: string;
  node: string;
  config: {
    embedder: string;
    similarityFloor: number;
    acceptFloor: number;
    effectiveFloor: number;
    maxRecords: number;
    maxRecordsIsDefault: boolean;
    policy: true;
    incluirOrcas: boolean;
    savings: Record<string, boolean>;
  };
  fuentes: FuenteUsada[];
  verificacionPuntuador?: Verificacion;
  tripletas?: {
    brazos: string[];
    puntuacion: PuntuacionTripletas;
    /** El evaluador del propio proyecto sobre los mismos casos, con este puntuador. */
    contexto?: { evaluador: string; metricas: Metricas };
    /** Diagnóstico: caché y política sueltas, sin la capa. */
    diagnosticoComponentes?: Metricas;
  };
  lmarena?: {
    n: number;
    consultas: number;
    aciertos: number;
    correctos: number;
    erroneos: number;
    alcanzables: number;
    desalojos: number;
    maxRegistros: number;
    erroresConPromptIdentico: number;
    promptsIdenticosEnVariasClases: number;
    correctosNoAlcanzables: number;
    noConsultados: number;
    clases: number;
    metricas: MetricasStream;
    ms: number;
  };
  /** Evidencia por caso, sin texto: uid, brazo, decisión y similitud. */
  casos: { uid: string; arm: string; split: string; decision: "hit" | "miss"; similarity?: number }[];
  /** Evidencia del stream, sin texto: [id, servedBy, correcto 0|1, similitud] por acierto; ids no consultados. */
  evidenciaStream?: { aciertos: [number, number, 0 | 1, number | null][]; noConsultados: number[] };
}

export interface DecisionDePublicacion {
  ok: boolean;
  blockers: string[];
  warnings: string[];
}

export function decidirPublicacion(
  a: Artefacto,
  opts: { permitirOrigenNoComercial?: boolean } = {},
): DecisionDePublicacion {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (a.mode !== "live") blockers.push(`artifact mode is "${a.mode}": a dry run measures nothing`);
  if (!a.commit) blockers.push("no commit recorded: the code that ran cannot be identified");
  if (a.dirty) blockers.push("measured on a dirty working tree: the code that ran is not any commit");

  if (a.fuentes.length === 0) blockers.push("no sources recorded");
  for (const f of a.fuentes) {
    if (!f.revision) blockers.push(`source ${f.id}: no pinned revision`);
    const huella = f.sha256 ?? f.sha256Extraido;
    if (!huella) blockers.push(`source ${f.id}: no sha256`);
    if (f.lfsOid && !f.sha256Extraido) blockers.push(`source ${f.id}: read by ranges but no sha256 of the extract`);
  }

  const noComercial: string[] = [];
  for (const f of a.fuentes) if (f.origenNoComercial) noComercial.push(`source ${f.id}`);
  if (a.config.incluirOrcas) noComercial.push("config.incluirOrcas");
  const brazos = new Set(a.casos.filter((c) => esBrazoNoComercial(c.arm)).map((c) => c.arm));
  for (const b of brazos) noComercial.push(`arm ${b}`);
  if (noComercial.length > 0) {
    const msg = `non-commercial-origin data (ORCAS-derived): ${noComercial.join(", ")}`;
    if (opts.permitirOrigenNoComercial) warnings.push(`${msg}; published only because the owner allowed it`);
    else blockers.push(`${msg}; publishing it needs the owner's legal decision (--permitir-origen-no-comercial)`);
  }

  // El documento dice «la caché tal como se envía». Una tirada con vectores del
  // dataset es un diagnóstico, no esa medición; un tope de registros distinto
  // del de fábrica se puede publicar, pero el documento lo dice.
  if (a.config.embedder !== "built_in") {
    blockers.push(`embedder "${a.config.embedder}" is not the one that ships: that run is a diagnostic, not the published measurement`);
  }
  if (!a.config.maxRecordsIsDefault) warnings.push(`maxRecords ${a.config.maxRecords} is not the default; the page says so`);

  if (!a.tripletas) blockers.push("no triplet measurement: the headline is the precision floor on the triplets");
  else if (!a.tripletas.puntuacion.total.precision) blockers.push("no hits on the triplets: precision is undefined");

  if (!a.verificacionPuntuador) warnings.push("the scorer self-check did not run");
  else if (!a.verificacionPuntuador.ok) blockers.push("the scorer self-check failed: it does not reproduce the project's figures");

  if (!a.lmarena) warnings.push("no SemBenchmarkLmArena stream in this artifact");
  else if (a.lmarena.correctosNoAlcanzables > 0) {
    blockers.push("stream: correct hits on classes the FIFO mirror says were not cached; the reachability count is wrong");
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

/** Porcentaje con un decimal, para el documento. */
export function pct(x: number | undefined | null): string {
  return x == null ? "n/a" : `${(x * 100).toFixed(1)} %`;
}

export function intervalo(ci: CI | null | undefined): string {
  return ci ? `${pct(ci.point)} [${pct(ci.lower)} – ${pct(ci.upper)}]` : "n/a";
}
