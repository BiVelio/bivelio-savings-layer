import { performance } from "node:perf_hooks";

import { percentil } from "../latencia-gateways/nucleo.js";

export const PRESUPUESTOS_LATENCIA_B2 = { p95Ms: 3000, maxMs: 5000 } as const;
export const PROTOCOLO_LATENCIA_B2 = "B2-F0-v1" as const;

export type ModoDelBanco = "LIVE" | "MOCK";
export type EstadoDeMedicion = "measured" | "estimated";
export type BrazoLatencia = "A" | "A1" | "A2" | "B";
export type RelojMonotono = () => number;

export interface MuestraLatencia {
  totalMs: number;
  providerMs: number;
}

export type MuestrasPorBrazo = Partial<Record<BrazoLatencia, MuestraLatencia[]>>;

export interface PercentilesLatencia {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export interface ResumenLatenciaBrazo {
  total: PercentilesLatencia;
  provider: PercentilesLatencia;
  layerOverhead: PercentilesLatencia;
}

export interface InformeLatencia {
  protocol: typeof PROTOCOLO_LATENCIA_B2;
  unit: "ms";
  clock: "performance.now (monotonic)";
  status: EstadoDeMedicion;
  instrumental: boolean;
  productionSla: "assessed" | "not-applicable";
  budgets: typeof PRESUPUESTOS_LATENCIA_B2;
  activeArms: BrazoLatencia[];
  arms: Partial<Record<BrazoLatencia, ResumenLatenciaBrazo>>;
  note: string;
  gate?: { approved: boolean; reasons: string[] };
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

function resumirBrazo(muestras: readonly MuestraLatencia[]): ResumenLatenciaBrazo {
  return {
    total: percentilesLatencia(muestras.map((m) => m.totalMs)),
    provider: percentilesLatencia(muestras.map((m) => m.providerMs)),
    layerOverhead: percentilesLatencia(muestras.map((m) => Math.max(0, m.totalMs - m.providerMs))),
  };
}

export function resumirLatencias(muestras: MuestrasPorBrazo, mode: ModoDelBanco): InformeLatencia {
  const activeArms = (["A", "A1", "A2", "B"] as const).filter((b) => (muestras[b]?.length ?? 0) > 0);
  return {
    protocol: PROTOCOLO_LATENCIA_B2,
    unit: "ms",
    clock: "performance.now (monotonic)",
    status: mode === "LIVE" ? "measured" : "estimated",
    instrumental: mode === "MOCK",
    productionSla: mode === "LIVE" ? "assessed" : "not-applicable",
    budgets: PRESUPUESTOS_LATENCIA_B2,
    activeArms,
    arms: Object.fromEntries(activeArms.map((b) => [b, resumirBrazo(muestras[b]!)])),
    note:
      mode === "LIVE"
        ? "End-to-end durations measured with a monotonic clock. Provider time is nested in total time; layerOverhead is their difference. Passing this gate is an observed-budget result, not a future SLA guarantee."
        : "ESTIMATED / INSTRUMENTAL timings from the mock provider. They validate instrumentation and budget logic only; they are never a production SLA or evidence of production latency.",
  };
}

const BRAZOS = new Set<BrazoLatencia>(["A", "A1", "A2", "B"]);
const esNumero = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const esObjeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function revisarPercentiles(valor: unknown, donde: string, motivos: string[], presupuestar: boolean): void {
  if (!esObjeto(valor)) {
    motivos.push(`latency: falta ${donde}`);
    return;
  }
  const { n, p50, p95, max } = valor;
  if (!esNumero(n) || n <= 0 || !esNumero(p50) || !esNumero(p95) || !esNumero(max)) {
    motivos.push(`latency: ${donde} no tiene n>0 y percentiles p50/p95/max numéricos`);
    return;
  }
  if (p50 < 0 || p95 < p50 || max < p95) {
    motivos.push(`latency: percentiles incoherentes en ${donde} (p50=${p50}, p95=${p95}, max=${max})`);
  }
  if (presupuestar && p95 > PRESUPUESTOS_LATENCIA_B2.p95Ms) {
    motivos.push(`latency: ${donde} p95=${p95}ms supera el presupuesto de ${PRESUPUESTOS_LATENCIA_B2.p95Ms}ms`);
  }
  if (presupuestar && max > PRESUPUESTOS_LATENCIA_B2.maxMs) {
    motivos.push(`latency: ${donde} max=${max}ms supera el techo absoluto de ${PRESUPUESTOS_LATENCIA_B2.maxMs}ms`);
  }
}

function revisarInforme(informe: unknown, mode: ModoDelBanco, motivos: string[]): BrazoLatencia[] {
  if (!esObjeto(informe)) {
    motivos.push("latency: falta el informe agregado de duraciones; vuelve a medir con el protocolo B2-F0-v1");
    return [];
  }
  if (informe.protocol !== PROTOCOLO_LATENCIA_B2) motivos.push(`latency.protocol debe ser ${PROTOCOLO_LATENCIA_B2}`);
  if (informe.clock !== "performance.now (monotonic)") motivos.push("latency.clock debe declarar un reloj monótono performance.now");
  if (!esObjeto(informe.budgets) || informe.budgets.p95Ms !== PRESUPUESTOS_LATENCIA_B2.p95Ms || informe.budgets.maxMs !== PRESUPUESTOS_LATENCIA_B2.maxMs) {
    motivos.push(`latency.budgets debe fijar p95=${PRESUPUESTOS_LATENCIA_B2.p95Ms}ms y max=${PRESUPUESTOS_LATENCIA_B2.maxMs}ms`);
  }
  const estado: EstadoDeMedicion = mode === "LIVE" ? "measured" : "estimated";
  if (informe.status !== estado) motivos.push(`latency.status = ${String(informe.status)}; en ${mode} debe ser ${estado}`);
  if (informe.instrumental !== (mode === "MOCK")) motivos.push(`latency.instrumental debe ser ${mode === "MOCK"} en ${mode}`);
  const sla = mode === "MOCK" ? "not-applicable" : "assessed";
  if (informe.productionSla !== sla) motivos.push(`latency.productionSla = ${String(informe.productionSla)}; en ${mode} debe ser ${sla}`);

  const declarados = Array.isArray(informe.activeArms) ? informe.activeArms : [];
  const activeArms = declarados.filter((b): b is BrazoLatencia => typeof b === "string" && BRAZOS.has(b as BrazoLatencia));
  if (activeArms.length !== declarados.length) motivos.push("latency.activeArms contiene brazos desconocidos o tiene una forma inválida");
  const obligatorios = mode === "LIVE" ? ["A", "A1", "A2", "B"] as const : ["A", "B"] as const;
  for (const obligatorio of obligatorios) {
    if (!activeArms.includes(obligatorio)) motivos.push(`latency.activeArms no incluye el brazo ${obligatorio}; ningún brazo puede ocultarse a la verja`);
  }
  const arms = esObjeto(informe.arms) ? informe.arms : {};
  for (const brazo of activeArms) {
    const resumen = arms[brazo];
    if (!esObjeto(resumen)) {
      motivos.push(`latency.arms.${brazo} falta`);
      continue;
    }
    revisarPercentiles(resumen.total, `arms.${brazo}.total`, motivos, true);
    revisarPercentiles(resumen.provider, `arms.${brazo}.provider`, motivos, false);
    revisarPercentiles(resumen.layerOverhead, `arms.${brazo}.layerOverhead`, motivos, false);
  }
  return activeArms;
}

export function motivosBloqueoLatencia(
  informe: unknown,
  escenarios: unknown,
  mode: ModoDelBanco,
): string[] {
  const motivos: string[] = [];
  const activeArms = revisarInforme(informe, mode, motivos);
  if (!Array.isArray(escenarios)) return motivos;
  escenarios.forEach((escenario, i) => {
    if (!esObjeto(escenario)) {
      motivos.push(`latency: scenarios[${i}] no es un objeto`);
      return;
    }
    const nombre = typeof escenario.name === "string" ? escenario.name : `scenarios[${i}]`;
    if (!esObjeto(escenario.latency)) {
      motivos.push(`latency: falta el resumen por escenario ${nombre}`);
      return;
    }
    const porEscenario = escenario.latency.arms;
    for (const brazo of activeArms) {
      const resumen = esObjeto(porEscenario) ? porEscenario[brazo] : undefined;
      if (!esObjeto(resumen)) {
        motivos.push(`latency: ${nombre} no tiene el brazo ${brazo}`);
        continue;
      }
      revisarPercentiles(resumen.total, `scenario ${nombre} arms.${brazo}.total`, motivos, true);
    }
  });
  return motivos;
}

export function conVerjaDeLatencia(
  informe: InformeLatencia,
  escenarios: unknown,
  mode: ModoDelBanco,
): InformeLatencia {
  const reasons = motivosBloqueoLatencia(informe, escenarios, mode);
  return { ...informe, gate: { approved: reasons.length === 0, reasons } };
}
