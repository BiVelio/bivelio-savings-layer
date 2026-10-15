import { motivoAcotado, MOTIVOS, type Motivo } from "./contrato.js";
import type { EstadoCortacircuitos } from "./guardas.js";

/**
 * LAS MÉTRICAS DEL TRANSFORMADOR (D09): contadores EN PROCESO, sin dependencias
 * y sin enviar nada a ningún sitio. Quien opera las lee con `instantanea()` o
 * las expone él mismo en texto Prometheus (`aTextoPrometheus()`).
 *
 * Cardinalidad acotada POR CONSTRUCCIÓN, porque una métrica con un id de
 * usuario o de documento en la etiqueta es una fuga con forma de gráfica:
 *
 *   · Motivos: sólo los del catálogo cerrado `MOTIVOS`; el resto cuenta como
 *     `other`. Un motor no puede inventar etiquetas.
 *   · Tamaños: cuatro cubos fijos de bytes de la petición.
 *   · Proyecto: los primeros `maxProyectos` (32 por defecto) que aparecen; los
 *     demás se suman en `_otros`. Ni tenant, ni sesión, ni handle, ni contenido.
 *   · Versión: sólo las que registra quien opera (no vienen del tráfico).
 *
 * Latencia: un anillo de las últimas `muestrasPorCubo` (1024) por cubo, y
 * percentiles por rango más cercano sobre él. Memoria fija; describe el
 * presente reciente, no la historia entera — para tendencia, que lo raspe un
 * Prometheus.
 */

export const CUBOS_DE_TAMANO = ["lt_4k", "lt_64k", "lt_1m", "ge_1m"] as const;
export type CuboDeTamano = (typeof CUBOS_DE_TAMANO)[number];

export function cuboDeTamano(bytes: number): CuboDeTamano {
  if (bytes < 4 * 1024) return "lt_4k";
  if (bytes < 64 * 1024) return "lt_64k";
  if (bytes < 1024 * 1024) return "lt_1m";
  return "ge_1m";
}

export const RESULTADOS_DE_RECUPERACION = [
  "ok",
  "not_found",
  "policy_changed",
  "policy_unverified",
  "integrity_failure",
  "scope_revoked",
  "error",
] as const;
export type ResultadoDeRecuperacion = (typeof RESULTADOS_DE_RECUPERACION)[number];

const PROYECTO_OTROS = "_otros";

/** Percentil por rango más cercano (p en [0,100]) de una lista ORDENADA. */
export function percentil(ordenados: readonly number[], p: number): number | null {
  if (ordenados.length === 0) return null;
  const rango = Math.max(1, Math.ceil((p / 100) * ordenados.length));
  return ordenados[Math.min(rango, ordenados.length) - 1]!;
}

class Anillo {
  private readonly datos: number[] = [];
  private siguiente = 0;
  total = 0;
  constructor(private readonly capacidad: number) {}
  meter(v: number): void {
    this.total += 1;
    if (this.datos.length < this.capacidad) this.datos.push(v);
    else {
      this.datos[this.siguiente] = v;
      this.siguiente = (this.siguiente + 1) % this.capacidad;
    }
  }
  ordenados(): number[] {
    return [...this.datos].sort((a, b) => a - b);
  }
}

export interface InstantaneaDeMetricas {
  latenciaMs: Record<CuboDeTamano, { muestras: number; total: number; p50: number | null; p95: number | null; p99: number | null }>;
  decisiones: Record<Motivo | "other", number>;
  decisionesPorProyecto: Record<string, Record<"applied" | "bypassed", number>>;
  recuperaciones: Record<ResultadoDeRecuperacion, number>;
  planesInvalidos: number;
  fallosDeIntegridad: number;
  cortacircuitos: Record<string, EstadoCortacircuitos>;
}

export interface OpcionesMetricas {
  muestrasPorCubo?: number;
  maxProyectos?: number;
}

export class MetricasTransformador {
  private readonly latencias: Record<CuboDeTamano, Anillo>;
  private readonly decisiones = new Map<Motivo | "other", number>();
  private readonly porProyecto = new Map<string, { applied: number; bypassed: number }>();
  private readonly recuperaciones = new Map<ResultadoDeRecuperacion, number>();
  private readonly maxProyectos: number;
  private planesInvalidos = 0;
  private fallosDeIntegridad = 0;
  private readonly fuentesDeCortacircuitos = new Map<string, () => EstadoCortacircuitos>();

  constructor(o: OpcionesMetricas = {}) {
    const n = Math.max(1, o.muestrasPorCubo ?? 1024);
    this.latencias = { lt_4k: new Anillo(n), lt_64k: new Anillo(n), lt_1m: new Anillo(n), ge_1m: new Anillo(n) };
    this.maxProyectos = Math.max(0, o.maxProyectos ?? 32);
  }

  /** Latencia añadida de una optimización, por tamaño de la petición (bytes de sus segmentos). */
  latencia(bytes: number, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.latencias[cuboDeTamano(bytes)].meter(ms);
  }

  /** Una decisión de `optimize`: su motivo (acotado) y, opcionalmente, el proyecto (acotado). */
  decision(motivo: string, aplicada: boolean, proyecto?: string): void {
    const m = motivoAcotado(motivo);
    this.decisiones.set(m, (this.decisiones.get(m) ?? 0) + 1);
    if (m === "invalid_plan") this.planesInvalidos += 1;
    if (proyecto !== undefined) {
      const clave =
        this.porProyecto.has(proyecto) || this.porProyecto.size < this.maxProyectos ? proyecto : PROYECTO_OTROS;
      const c = this.porProyecto.get(clave) ?? { applied: 0, bypassed: 0 };
      if (aplicada) c.applied += 1;
      else c.bypassed += 1;
      this.porProyecto.set(clave, c);
    }
  }

  recuperacion(resultado: string): void {
    const r = (RESULTADOS_DE_RECUPERACION as readonly string[]).includes(resultado)
      ? (resultado as ResultadoDeRecuperacion)
      : "error";
    this.recuperaciones.set(r, (this.recuperaciones.get(r) ?? 0) + 1);
    if (r === "integrity_failure") this.fallosDeIntegridad += 1;
  }

  /** Registra de dónde leer el estado del cortacircuitos de una versión (sin E/S). */
  vigilarCortacircuitos(version: string, leer: () => EstadoCortacircuitos): void {
    this.fuentesDeCortacircuitos.set(version, leer);
  }

  instantanea(): InstantaneaDeMetricas {
    const latenciaMs = {} as InstantaneaDeMetricas["latenciaMs"];
    for (const c of CUBOS_DE_TAMANO) {
      const a = this.latencias[c];
      const o = a.ordenados();
      latenciaMs[c] = { muestras: o.length, total: a.total, p50: percentil(o, 50), p95: percentil(o, 95), p99: percentil(o, 99) };
    }
    const decisiones = {} as InstantaneaDeMetricas["decisiones"];
    for (const m of [...MOTIVOS, "other" as const]) decisiones[m] = this.decisiones.get(m) ?? 0;
    const recuperaciones = {} as InstantaneaDeMetricas["recuperaciones"];
    for (const r of RESULTADOS_DE_RECUPERACION) recuperaciones[r] = this.recuperaciones.get(r) ?? 0;
    const cortacircuitos: Record<string, EstadoCortacircuitos> = {};
    for (const [v, leer] of this.fuentesDeCortacircuitos) {
      try {
        cortacircuitos[v] = leer();
      } catch {
        cortacircuitos[v] = "open";
      }
    }
    return {
      latenciaMs,
      decisiones,
      decisionesPorProyecto: Object.fromEntries([...this.porProyecto].map(([k, v]) => [k, { ...v }])),
      recuperaciones,
      planesInvalidos: this.planesInvalidos,
      fallosDeIntegridad: this.fallosDeIntegridad,
      cortacircuitos,
    };
  }

  /** Texto de exposición Prometheus (HELP/TYPE). Las etiquetas salen sólo de conjuntos acotados. */
  aTextoPrometheus(): string {
    const i = this.instantanea();
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    const l: string[] = [];
    l.push("# HELP bvsala_transformador_latencia_ms Latencia añadida por optimize, por cubo de tamaño (ventana reciente).");
    l.push("# TYPE bvsala_transformador_latencia_ms summary");
    for (const c of CUBOS_DE_TAMANO) {
      const x = i.latenciaMs[c];
      for (const [q, v] of [["0.5", x.p50], ["0.95", x.p95], ["0.99", x.p99]] as const) {
        if (v !== null) l.push(`bvsala_transformador_latencia_ms{cubo="${c}",quantile="${q}"} ${v}`);
      }
      l.push(`bvsala_transformador_latencia_ms_count{cubo="${c}"} ${x.total}`);
    }
    l.push("# HELP bvsala_transformador_decisiones_total Decisiones de optimize por motivo.");
    l.push("# TYPE bvsala_transformador_decisiones_total counter");
    for (const [m, n] of Object.entries(i.decisiones)) if (n > 0) l.push(`bvsala_transformador_decisiones_total{motivo="${m}"} ${n}`);
    l.push("# HELP bvsala_transformador_proyecto_total Decisiones por proyecto (acotado; el resto en _otros).");
    l.push("# TYPE bvsala_transformador_proyecto_total counter");
    for (const [p, c] of Object.entries(i.decisionesPorProyecto)) {
      l.push(`bvsala_transformador_proyecto_total{proyecto="${esc(p)}",resultado="applied"} ${c.applied}`);
      l.push(`bvsala_transformador_proyecto_total{proyecto="${esc(p)}",resultado="bypassed"} ${c.bypassed}`);
    }
    l.push("# HELP bvsala_transformador_recuperaciones_total Retrieves por resultado.");
    l.push("# TYPE bvsala_transformador_recuperaciones_total counter");
    for (const [r, n] of Object.entries(i.recuperaciones)) l.push(`bvsala_transformador_recuperaciones_total{resultado="${r}"} ${n}`);
    l.push("# HELP bvsala_transformador_integridad_total Planes inválidos y fallos de integridad al recuperar.");
    l.push("# TYPE bvsala_transformador_integridad_total counter");
    l.push(`bvsala_transformador_integridad_total{tipo="plan_invalido"} ${i.planesInvalidos}`);
    l.push(`bvsala_transformador_integridad_total{tipo="recuperacion"} ${i.fallosDeIntegridad}`);
    l.push("# HELP bvsala_transformador_cortacircuitos Estado del cortacircuitos por versión (1 = en ese estado).");
    l.push("# TYPE bvsala_transformador_cortacircuitos gauge");
    for (const [v, e] of Object.entries(i.cortacircuitos)) {
      for (const s of ["closed", "open", "half_open"] as const) {
        l.push(`bvsala_transformador_cortacircuitos{version="${esc(v)}",estado="${s}"} ${e === s ? 1 : 0}`);
      }
    }
    return l.join("\n") + "\n";
  }
}
