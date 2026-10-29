import { performance } from "node:perf_hooks";

import { percentil } from "../latencia-gateways/nucleo.js";

export const PRESUPUESTOS_LATENCIA_B2 = { p95Ms: 3000, maxMs: 5000 } as const;
export const PRESUPUESTOS_TRABAJO_CAPA_B2 = { p95Ms: 250, maxMs: 500 } as const;
export const PROTOCOLO_LATENCIA_B2 = "B2-F1-v1" as const;
export const PROTOCOLO_LATENCIA_B2_F0 = "B2-F0-v1" as const;
export const PROTOCOLO_LATENCIA_B2_LEGACY = PROTOCOLO_LATENCIA_B2_F0;

export type ModoDelBanco = "LIVE" | "MOCK";
export type EstadoDeMedicion = "measured" | "estimated";
export type EstadoDeMuestra = "completed" | "deadline_exceeded" | "provider_error";
export type BrazoLatencia = "A" | "A1" | "A2" | "B" | "S" | "E";
export type RelojMonotono = () => number;

export interface MuestraLatenciaF1 {
  totalMs: number;
  providerWaitMs: number;
  layerWorkMs: number;
  harnessMs: number;
  estado: EstadoDeMuestra;
}

export interface MuestraLatenciaLegacy {
  totalMs: number;
  providerMs: number;
}

export type MuestraLatencia = MuestraLatenciaF1 | MuestraLatenciaLegacy;
export type MuestrasPorBrazoF1 = Partial<Record<BrazoLatencia, MuestraLatenciaF1[]>>;
export type MuestrasPorBrazoLegacy = Partial<Record<BrazoLatencia, MuestraLatenciaLegacy[]>>;
export type MuestrasPorBrazo = Partial<Record<BrazoLatencia, MuestraLatencia[]>>;

export interface PercentilesLatencia {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export interface ConteosDeEstado {
  completed: number;
  deadline_exceeded: number;
  provider_error: number;
}

export interface ResultadoDePresupuesto {
  ok: boolean;
  budgets: { p95Ms: number; maxMs: number };
  reasons: string[];
}

export interface ResumenLatenciaBrazoF1 {
  total: PercentilesLatencia;
  providerWait: PercentilesLatencia;
  layerWork: PercentilesLatencia;
  harness: PercentilesLatencia;
  outcomes: ConteosDeEstado;
  interactiveSlo: ResultadoDePresupuesto;
  layerWorkBudget: ResultadoDePresupuesto;
}

export interface ResumenLatenciaBrazoLegacy {
  total: PercentilesLatencia;
  provider: PercentilesLatencia;
  layerOverhead: PercentilesLatencia;
}

export type ResumenLatenciaBrazo = ResumenLatenciaBrazoF1 | ResumenLatenciaBrazoLegacy;

interface InformeLatenciaBase<P extends string, R> {
  protocol: P;
  unit: "ms";
  clock: "performance.now (monotonic)";
  status: EstadoDeMedicion;
  instrumental: boolean;
  productionSla: "assessed" | "not-applicable";
  budgets: typeof PRESUPUESTOS_LATENCIA_B2;
  activeArms: BrazoLatencia[];
  arms: Partial<Record<BrazoLatencia, R>>;
  note: string;
  gate?: { approved: boolean; reasons: string[] };
}

export interface InformeLatenciaF1 extends InformeLatenciaBase<typeof PROTOCOLO_LATENCIA_B2, ResumenLatenciaBrazoF1> {
  layerWorkBudgets: typeof PRESUPUESTOS_TRABAJO_CAPA_B2;
  interactiveSloOk: boolean;
  layerOk: boolean;
}

export type InformeLatenciaLegacy = InformeLatenciaBase<typeof PROTOCOLO_LATENCIA_B2_F0, ResumenLatenciaBrazoLegacy>;
export type InformeLatencia = InformeLatenciaF1 | InformeLatenciaLegacy;

export interface EvaluacionLatencia {
  interactiveSloOk: boolean;
  /** null en F0: el artefacto legacy no contiene evidencia separada del trabajo de capa. */
  layerOk: boolean | null;
  releaseOk: boolean;
  structuralReasons: string[];
  interactiveSloReasons: string[];
  deadlineReasons: string[];
  layerReasons: string[];
  reasons: string[];
}

export async function cronometrar<T>(
  operacion: () => Promise<T>,
  ahora: RelojMonotono = () => performance.now(),
): Promise<{ value: T; durationMs: number }> {
  const inicio = ahora();
  const value = await operacion();
  return { value, durationMs: ahora() - inicio };
}

export function percentilesLatencia(xs: readonly number[]): PercentilesLatencia {
  const ordenados = [...xs].sort((a, b) => a - b);
  return {
    n: ordenados.length,
    p50: percentil(ordenados, 0.5),
    p95: percentil(ordenados, 0.95),
    max: ordenados.length ? ordenados[ordenados.length - 1]! : Number.NaN,
  };
}

function esMuestraF1(m: MuestraLatencia): m is MuestraLatenciaF1 {
  return "providerWaitMs" in m;
}

export function estadoDeMuestra(error: unknown, deadlineExcedido = false): EstadoDeMuestra {
  if (deadlineExcedido) return "deadline_exceeded";
  if (error === undefined || error === null || error === "") return "completed";
  const nombre = error instanceof Error ? error.name : "";
  const texto = error instanceof Error ? error.message : String(error);
  return /timeout|timed[ -]?out|deadline[ _-]?exceeded|deadline exceeded|plazo agotado/i.test(`${nombre} ${texto}`)
    ? "deadline_exceeded"
    : "provider_error";
}

function resultadoInteractiveSlo(
  brazo: BrazoLatencia,
  total: PercentilesLatencia,
  outcomes: ConteosDeEstado,
): ResultadoDePresupuesto {
  const reasons: string[] = [];
  if (total.p95 > PRESUPUESTOS_LATENCIA_B2.p95Ms) {
    reasons.push(`interactiveSlo: arms.${brazo}.total p95=${total.p95}ms supera el presupuesto de ${PRESUPUESTOS_LATENCIA_B2.p95Ms}ms`);
  }
  if (total.max > PRESUPUESTOS_LATENCIA_B2.maxMs) {
    reasons.push(`interactiveSlo: arms.${brazo}.total max=${total.max}ms supera el techo absoluto de ${PRESUPUESTOS_LATENCIA_B2.maxMs}ms`);
  }
  if (outcomes.deadline_exceeded > 0) {
    reasons.push(`interactiveSlo: arms.${brazo} tiene ${outcomes.deadline_exceeded} petición(es) deadline_exceeded; un deadline siempre falla la petición y el SLO`);
  }
  return { ok: reasons.length === 0, budgets: PRESUPUESTOS_LATENCIA_B2, reasons };
}

function resultadoTrabajoDeCapa(brazo: BrazoLatencia, layerWork: PercentilesLatencia): ResultadoDePresupuesto {
  const reasons: string[] = [];
  if (layerWork.p95 > PRESUPUESTOS_TRABAJO_CAPA_B2.p95Ms) {
    reasons.push(`layerWorkBudget: arms.${brazo}.layerWork p95=${layerWork.p95}ms supera el presupuesto observado de ${PRESUPUESTOS_TRABAJO_CAPA_B2.p95Ms}ms`);
  }
  if (layerWork.max > PRESUPUESTOS_TRABAJO_CAPA_B2.maxMs) {
    reasons.push(`layerWorkBudget: arms.${brazo}.layerWork max=${layerWork.max}ms supera el presupuesto observado de ${PRESUPUESTOS_TRABAJO_CAPA_B2.maxMs}ms`);
  }
  return { ok: reasons.length === 0, budgets: PRESUPUESTOS_TRABAJO_CAPA_B2, reasons };
}

function resumirBrazoF1(brazo: BrazoLatencia, muestras: readonly MuestraLatenciaF1[]): ResumenLatenciaBrazoF1 {
  const total = percentilesLatencia(muestras.map((m) => m.totalMs));
  const layerWork = percentilesLatencia(muestras.map((m) => m.layerWorkMs));
  const outcomes: ConteosDeEstado = { completed: 0, deadline_exceeded: 0, provider_error: 0 };
  for (const m of muestras) outcomes[m.estado]++;
  return {
    total,
    providerWait: percentilesLatencia(muestras.map((m) => m.providerWaitMs)),
    layerWork,
    harness: percentilesLatencia(muestras.map((m) => m.harnessMs)),
    outcomes,
    interactiveSlo: resultadoInteractiveSlo(brazo, total, outcomes),
    layerWorkBudget: resultadoTrabajoDeCapa(brazo, layerWork),
  };
}

function resumirBrazoLegacy(muestras: readonly MuestraLatenciaLegacy[]): ResumenLatenciaBrazoLegacy {
  return {
    total: percentilesLatencia(muestras.map((m) => m.totalMs)),
    provider: percentilesLatencia(muestras.map((m) => m.providerMs)),
    layerOverhead: percentilesLatencia(muestras.map((m) => Math.max(0, m.totalMs - m.providerMs))),
  };
}

const BRAZOS_F1 = ["A", "A1", "A2", "B", "S", "E"] as const;
const BRAZOS_F0 = ["A", "A1", "A2", "B"] as const;

function baseDelInforme(mode: ModoDelBanco) {
  return {
    unit: "ms" as const,
    clock: "performance.now (monotonic)" as const,
    status: mode === "LIVE" ? "measured" as const : "estimated" as const,
    instrumental: mode === "MOCK",
    productionSla: mode === "LIVE" ? "assessed" as const : "not-applicable" as const,
    budgets: PRESUPUESTOS_LATENCIA_B2,
  };
}

export function resumirLatencias(muestras: MuestrasPorBrazoF1, mode: ModoDelBanco): InformeLatenciaF1;
export function resumirLatencias(muestras: MuestrasPorBrazoLegacy, mode: ModoDelBanco): InformeLatenciaLegacy;
export function resumirLatencias(muestras: MuestrasPorBrazo, mode: ModoDelBanco): InformeLatencia;
export function resumirLatencias(muestras: MuestrasPorBrazo, mode: ModoDelBanco): InformeLatencia {
  const todas = Object.values(muestras).flatMap((xs) => xs ?? []);
  const algunaF1 = todas.some(esMuestraF1);
  if (algunaF1 && !todas.every(esMuestraF1)) throw new Error("B2-F1-v1: no se pueden mezclar muestras F0 y F1 en un mismo informe");
  if (algunaF1 || todas.length === 0) {
    const nuevas = muestras as MuestrasPorBrazoF1;
    const activeArms = BRAZOS_F1.filter((b) => (nuevas[b]?.length ?? 0) > 0);
    const arms = Object.fromEntries(activeArms.map((b) => [b, resumirBrazoF1(b, nuevas[b]!)])) as InformeLatenciaF1["arms"];
    return {
      protocol: PROTOCOLO_LATENCIA_B2,
      ...baseDelInforme(mode),
      layerWorkBudgets: PRESUPUESTOS_TRABAJO_CAPA_B2,
      activeArms: [...activeArms],
      arms,
      interactiveSloOk: activeArms.every((b) => arms[b]!.interactiveSlo.ok),
      layerOk: activeArms.every((b) => arms[b]!.layerWorkBudget.ok),
      note:
        mode === "LIVE"
          ? "B2-F1-v1 separates provider wait, local layer work and harness time without dropping failed or timed-out requests. interactiveSlo and layerWorkBudget are observed-budget results, not a future SLA or certification that every model completes within 5 s."
          : "ESTIMATED / INSTRUMENTAL B2-F1-v1 timings from the mock provider. They validate separated instrumentation and budget logic only; they are never a production SLA or evidence of production latency.",
    };
  }
  const activeArms = BRAZOS_F0.filter((b) => (muestras[b]?.length ?? 0) > 0);
  return {
    protocol: PROTOCOLO_LATENCIA_B2_F0,
    ...baseDelInforme(mode),
    activeArms: [...activeArms],
    arms: Object.fromEntries(activeArms.map((b) => [b, resumirBrazoLegacy((muestras[b] ?? []) as MuestraLatenciaLegacy[])])),
    note:
      mode === "LIVE"
        ? "Legacy B2-F0-v1 durations. Provider time is nested in total time; layerOverhead is their historical difference, not separated F1 evidence. The interactive budget is an observed result, not a future SLA guarantee."
        : "ESTIMATED / INSTRUMENTAL legacy B2-F0-v1 timings from the mock provider. They validate instrumentation and budget logic only; they are never a production SLA or evidence of production latency.",
  };
}

const BRAZOS_CONOCIDOS_F1 = new Set<BrazoLatencia>(BRAZOS_F1);
const BRAZOS_CONOCIDOS_F0 = new Set<BrazoLatencia>(BRAZOS_F0);
const esNumero = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const esObjeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function revisarPercentiles(valor: unknown, donde: string, motivos: string[]): PercentilesLatencia | null {
  if (!esObjeto(valor)) {
    motivos.push(`latency: falta ${donde}`);
    return null;
  }
  const { n, p50, p95, max } = valor;
  if (!esNumero(n) || n <= 0 || !esNumero(p50) || !esNumero(p95) || !esNumero(max)) {
    motivos.push(`latency: ${donde} no tiene n>0 y percentiles p50/p95/max numéricos`);
    return null;
  }
  if (p50 < 0 || p95 < p50 || max < p95) {
    motivos.push(`latency: percentiles incoherentes en ${donde} (p50=${p50}, p95=${p95}, max=${max})`);
  }
  return { n, p50, p95, max };
}

function revisarPresupuestoTotal(total: PercentilesLatencia, donde: string, motivos: string[]): void {
  if (total.p95 > PRESUPUESTOS_LATENCIA_B2.p95Ms) {
    motivos.push(`latency: ${donde} p95=${total.p95}ms supera el presupuesto de ${PRESUPUESTOS_LATENCIA_B2.p95Ms}ms`);
  }
  if (total.max > PRESUPUESTOS_LATENCIA_B2.maxMs) {
    motivos.push(`latency: ${donde} max=${total.max}ms supera el techo absoluto de ${PRESUPUESTOS_LATENCIA_B2.maxMs}ms`);
  }
}

function revisarPresupuestoCapa(layerWork: PercentilesLatencia, donde: string, motivos: string[]): void {
  if (layerWork.p95 > PRESUPUESTOS_TRABAJO_CAPA_B2.p95Ms) {
    motivos.push(`layerWorkBudget: ${donde} p95=${layerWork.p95}ms supera el presupuesto observado de ${PRESUPUESTOS_TRABAJO_CAPA_B2.p95Ms}ms`);
  }
  if (layerWork.max > PRESUPUESTOS_TRABAJO_CAPA_B2.maxMs) {
    motivos.push(`layerWorkBudget: ${donde} max=${layerWork.max}ms supera el presupuesto observado de ${PRESUPUESTOS_TRABAJO_CAPA_B2.maxMs}ms`);
  }
}

interface RevisionDeBrazo {
  structural: string[];
  interactive: string[];
  layer: string[];
}

function revisarResultadoVisible(
  valor: unknown,
  campo: "interactiveSlo" | "layerWorkBudget",
  donde: string,
  okRecalculado: boolean,
  budgets: { p95Ms: number; maxMs: number },
  structural: string[],
): void {
  if (!esObjeto(valor) || typeof valor.ok !== "boolean" || !Array.isArray(valor.reasons)) {
    structural.push(`latency: ${donde}.${campo} debe exponer ok y reasons recalculables`);
    return;
  }
  if (!esObjeto(valor.budgets) || valor.budgets.p95Ms !== budgets.p95Ms || valor.budgets.maxMs !== budgets.maxMs) {
    structural.push(`latency: ${donde}.${campo}.budgets no conserva p95=${budgets.p95Ms}ms y max=${budgets.maxMs}ms`);
  }
  if (valor.ok !== okRecalculado) {
    structural.push(`latency: ${donde}.${campo}.ok=${String(valor.ok)} contradice el recálculo (${okRecalculado})`);
  }
}

function revisarBrazoF1(resumen: unknown, _brazo: BrazoLatencia, donde: string): RevisionDeBrazo {
  const out: RevisionDeBrazo = { structural: [], interactive: [], layer: [] };
  if (!esObjeto(resumen)) {
    out.structural.push(`latency: ${donde} falta`);
    return out;
  }
  const total = revisarPercentiles(resumen.total, `${donde}.total`, out.structural);
  const providerWait = revisarPercentiles(resumen.providerWait, `${donde}.providerWait`, out.structural);
  const layerWork = revisarPercentiles(resumen.layerWork, `${donde}.layerWork`, out.structural);
  const harness = revisarPercentiles(resumen.harness, `${donde}.harness`, out.structural);
  if (total) revisarPresupuestoTotal(total, `${donde}.total`, out.interactive);
  if (layerWork) revisarPresupuestoCapa(layerWork, `${donde}.layerWork`, out.layer);
  const ns = [total?.n, providerWait?.n, layerWork?.n, harness?.n].filter((n): n is number => n !== undefined);
  if (ns.length === 4 && ns.some((n) => n !== total!.n)) {
    out.structural.push(`latency: ${donde} tiene distintos n por componente; ninguna muestra puede desaparecer al separar evidencia`);
  }
  const outcomes: ConteosDeEstado = { completed: 0, deadline_exceeded: 0, provider_error: 0 };
  if (!esObjeto(resumen.outcomes)) {
    out.structural.push(`latency: falta ${donde}.outcomes`);
  } else {
    for (const estado of ["completed", "deadline_exceeded", "provider_error"] as const) {
      const n = resumen.outcomes[estado];
      if (!esNumero(n) || !Number.isInteger(n) || n < 0) out.structural.push(`latency: ${donde}.outcomes.${estado} debe ser un entero no negativo`);
      else outcomes[estado] = n;
    }
    const suma = outcomes.completed + outcomes.deadline_exceeded + outcomes.provider_error;
    if (total && suma !== total.n) out.structural.push(`latency: ${donde}.outcomes suma ${suma}, pero total.n=${total.n}; ninguna muestra puede desaparecer`);
  }
  if (outcomes.deadline_exceeded > 0) {
    out.interactive.push(`interactiveSlo: ${donde} tiene ${outcomes.deadline_exceeded} petición(es) deadline_exceeded; un deadline siempre falla la petición y el SLO`);
  }
  if (total) revisarResultadoVisible(resumen.interactiveSlo, "interactiveSlo", donde, out.interactive.length === 0 && out.structural.length === 0, PRESUPUESTOS_LATENCIA_B2, out.structural);
  if (layerWork) revisarResultadoVisible(resumen.layerWorkBudget, "layerWorkBudget", donde, out.layer.length === 0 && out.structural.length === 0, PRESUPUESTOS_TRABAJO_CAPA_B2, out.structural);
  return out;
}

function revisarBrazoLegacy(resumen: unknown, donde: string, completo = true): RevisionDeBrazo {
  const out: RevisionDeBrazo = { structural: [], interactive: [], layer: [] };
  if (!esObjeto(resumen)) {
    out.structural.push(`latency: ${donde} falta`);
    return out;
  }
  const total = revisarPercentiles(resumen.total, `${donde}.total`, out.structural);
  if (completo) {
    revisarPercentiles(resumen.provider, `${donde}.provider`, out.structural);
    revisarPercentiles(resumen.layerOverhead, `${donde}.layerOverhead`, out.structural);
  }
  if (total) revisarPresupuestoTotal(total, `${donde}.total`, out.interactive);
  return out;
}

interface RevisionDelInforme {
  activeArms: BrazoLatencia[];
  protocol: typeof PROTOCOLO_LATENCIA_B2 | typeof PROTOCOLO_LATENCIA_B2_F0 | null;
  structural: string[];
  interactive: string[];
  layer: string[];
}

function revisarInforme(informe: unknown, mode: ModoDelBanco): RevisionDelInforme {
  const out: RevisionDelInforme = { activeArms: [], protocol: null, structural: [], interactive: [], layer: [] };
  if (!esObjeto(informe)) {
    out.structural.push(`latency: falta el informe agregado de duraciones; vuelve a medir con el protocolo ${PROTOCOLO_LATENCIA_B2} (o conserva uno legacy ${PROTOCOLO_LATENCIA_B2_F0})`);
    return out;
  }
  const protocol = informe.protocol === PROTOCOLO_LATENCIA_B2 || informe.protocol === PROTOCOLO_LATENCIA_B2_F0 ? informe.protocol : null;
  out.protocol = protocol;
  if (!protocol) out.structural.push(`latency.protocol debe ser ${PROTOCOLO_LATENCIA_B2} o el legacy ${PROTOCOLO_LATENCIA_B2_F0}`);
  if (informe.clock !== "performance.now (monotonic)") out.structural.push("latency.clock debe declarar un reloj monótono performance.now");
  if (!esObjeto(informe.budgets) || informe.budgets.p95Ms !== PRESUPUESTOS_LATENCIA_B2.p95Ms || informe.budgets.maxMs !== PRESUPUESTOS_LATENCIA_B2.maxMs) {
    out.structural.push(`latency.budgets debe fijar p95=${PRESUPUESTOS_LATENCIA_B2.p95Ms}ms y max=${PRESUPUESTOS_LATENCIA_B2.maxMs}ms`);
  }
  if (protocol === PROTOCOLO_LATENCIA_B2 && (!esObjeto(informe.layerWorkBudgets) || informe.layerWorkBudgets.p95Ms !== PRESUPUESTOS_TRABAJO_CAPA_B2.p95Ms || informe.layerWorkBudgets.maxMs !== PRESUPUESTOS_TRABAJO_CAPA_B2.maxMs)) {
    out.structural.push(`latency.layerWorkBudgets debe fijar el presupuesto observado p95=${PRESUPUESTOS_TRABAJO_CAPA_B2.p95Ms}ms y max=${PRESUPUESTOS_TRABAJO_CAPA_B2.maxMs}ms`);
  }
  const estado: EstadoDeMedicion = mode === "LIVE" ? "measured" : "estimated";
  if (informe.status !== estado) out.structural.push(`latency.status = ${String(informe.status)}; en ${mode} debe ser ${estado}`);
  if (informe.instrumental !== (mode === "MOCK")) out.structural.push(`latency.instrumental debe ser ${mode === "MOCK"} en ${mode}`);
  const sla = mode === "MOCK" ? "not-applicable" : "assessed";
  if (informe.productionSla !== sla) out.structural.push(`latency.productionSla = ${String(informe.productionSla)}; en ${mode} debe ser ${sla}`);

  const declarados = Array.isArray(informe.activeArms) ? informe.activeArms : [];
  const conocidos = protocol === PROTOCOLO_LATENCIA_B2 ? BRAZOS_CONOCIDOS_F1 : BRAZOS_CONOCIDOS_F0;
  const activeArms = declarados.filter((b): b is BrazoLatencia => typeof b === "string" && conocidos.has(b as BrazoLatencia));
  out.activeArms = activeArms;
  if (activeArms.length !== declarados.length) out.structural.push("latency.activeArms contiene brazos desconocidos o tiene una forma inválida");
  const obligatorios = mode === "LIVE" ? ["A", "A1", "A2", "B"] as const : ["A", "B"] as const;
  for (const obligatorio of obligatorios) {
    if (!activeArms.includes(obligatorio)) out.structural.push(`latency.activeArms no incluye el brazo ${obligatorio}; ningún brazo puede ocultarse a la verja`);
  }
  const arms = esObjeto(informe.arms) ? informe.arms : {};
  for (const brazo of activeArms) {
    const revision = protocol === PROTOCOLO_LATENCIA_B2
      ? revisarBrazoF1(arms[brazo], brazo, `arms.${brazo}`)
      : revisarBrazoLegacy(arms[brazo], `arms.${brazo}`);
    out.structural.push(...revision.structural);
    out.interactive.push(...revision.interactive);
    out.layer.push(...revision.layer);
  }
  return out;
}

export function evaluarLatencia(informe: unknown, escenarios: unknown, mode: ModoDelBanco): EvaluacionLatencia {
  const revision = revisarInforme(informe, mode);
  if (Array.isArray(escenarios)) {
    escenarios.forEach((escenario, i) => {
      if (!esObjeto(escenario)) {
        revision.structural.push(`latency: scenarios[${i}] no es un objeto`);
        return;
      }
      const nombre = typeof escenario.name === "string" ? escenario.name : `scenarios[${i}]`;
      if (!esObjeto(escenario.latency)) {
        revision.structural.push(`latency: falta el resumen por escenario ${nombre}`);
        return;
      }
      const protocoloEscenario = escenario.latency.protocol === undefined ? revision.protocol : escenario.latency.protocol;
      if (protocoloEscenario !== revision.protocol) {
        revision.structural.push(`latency: scenario ${nombre} usa protocolo ${String(protocoloEscenario)}; se esperaba ${String(revision.protocol)}`);
        return;
      }
      const porEscenario = escenario.latency.arms;
      for (const brazo of revision.activeArms) {
        const resumen = esObjeto(porEscenario) ? porEscenario[brazo] : undefined;
        const r = revision.protocol === PROTOCOLO_LATENCIA_B2
          ? revisarBrazoF1(resumen, brazo, `scenario ${nombre} arms.${brazo}`)
          : revisarBrazoLegacy(resumen, `scenario ${nombre} arms.${brazo}`, false);
        revision.structural.push(...r.structural);
        revision.interactive.push(...r.interactive);
        revision.layer.push(...r.layer);
      }
    });
  }
  const interactiveSloOk = revision.structural.length === 0 && revision.interactive.length === 0;
  const layerOk = revision.protocol === PROTOCOLO_LATENCIA_B2_F0
    ? null
    : revision.structural.length === 0 && revision.layer.length === 0;
  const reasons = [...revision.structural, ...revision.interactive, ...revision.layer];
  const deadlineReasons = revision.interactive.filter((reason) => reason.includes("deadline_exceeded"));
  return {
    interactiveSloOk,
    layerOk,
    releaseOk: revision.structural.length + revision.layer.length + deadlineReasons.length === 0,
    structuralReasons: revision.structural,
    interactiveSloReasons: revision.interactive,
    deadlineReasons,
    layerReasons: revision.layer,
    reasons,
  };
}

export function motivosBloqueoLatencia(informe: unknown, escenarios: unknown, mode: ModoDelBanco): string[] {
  return evaluarLatencia(informe, escenarios, mode).reasons;
}

export function conVerjaDeLatencia<T extends InformeLatencia>(informe: T, escenarios: unknown, mode: ModoDelBanco): T {
  const reasons = motivosBloqueoLatencia(informe, escenarios, mode);
  return { ...informe, gate: { approved: reasons.length === 0, reasons } };
}
