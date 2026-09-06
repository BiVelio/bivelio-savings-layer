import type { UsageRollup } from "@/app/[locale]/dashboard/data";

import { calcularComision, type ComisionCalculada } from "./tarifa";

/**
 * RITMO Y PROYECCIÓN — «¿a cuánto voy y en cuánto acabo el mes?».
 *
 * El panel sabía decir lo que llevas y lo que llevabas; no sabía decir a qué
 * velocidad va ni dónde acaba. Es la primera pregunta que hace quien paga una
 * comisión sobre lo ahorrado, y hasta ahora la única proyección del producto
 * estaba en la calculadora de la portada, con números que teclea el visitante.
 *
 * Se construye sobre las MISMAS filas medidas que el extracto (`measured_*`),
 * no sobre el estimado: proyectar sobre una base que jamás se factura sería
 * prometer un dinero que no existe. De ahí salen tres cosas distintas que la
 * vista NO debe mezclar:
 *
 *   · hasta la fecha → MEDIDO, es el extracto en sombra;
 *   · ritmo          → MEDIDO dividido entre días, aritmética pura;
 *   · proyección     → ESTIMACIÓN, y se etiqueta como tal siempre.
 *
 * Tres decisiones que hacen que la cifra no mienta:
 *
 * 1. El día de HOY está a medias. Entra en «hasta la fecha» (es dinero real ya
 *    ahorrado) pero NO en el divisor del ritmo: un mes se proyectaría siempre a
 *    la baja si cada cálculo arrastra una jornada incompleta.
 * 2. El divisor son los días COMPLETOS transcurridos desde el primero con
 *    tráfico, no los días que tienen filas. Un fin de semana a cero es un cero
 *    de verdad y tiene que tirar del ritmo hacia abajo — el mes que se proyecta
 *    también tiene fines de semana.
 * 3. Con menos de tres días completos no se proyecta NADA. Dos puntos siempre
 *    dan una recta, y esa recta es puro ruido a principios de mes.
 */

/** Días completos que hacen falta antes de atreverse a proyectar. */
export const DIAS_MINIMOS_PARA_PROYECTAR = 3;

/** Días que entran en la media móvil del ritmo reciente. */
export const VENTANA_RITMO_DIAS = 7;

export type EstadoRitmo =
  /** Sin una sola fila medida en el período: no hay nada que promediar. */
  | "sin_datos"
  /** Hay medida, pero aún no bastan días completos para proyectar. */
  | "pocos_dias"
  /** El período ya terminó: se enseña lo que fue, no hacia dónde va. */
  | "cerrado"
  | "ok";

export interface Ritmo {
  estado: EstadoRitmo;
  periodo: string;
  /** Días naturales del período (28-31). */
  diasDelPeriodo: number;
  /** Días ya empezados, HOY incluido. */
  diasTranscurridos: number;
  /** Días que quedan DESPUÉS de hoy. */
  diasRestantes: number;
  /** Días completos con los que se ha calculado el ritmo (el divisor). */
  diasDeRitmo: number;

  /** MEDIDO, lo mismo que el extracto: base y ahorro del período hasta ahora. */
  baseHastaLaFechaUsd: number;
  ahorroHastaLaFechaUsd: number;

  /** MEDIDO ÷ días: ahorro por día de todo el tramo completo, y de los últimos 7. */
  ahorroPorDiaUsd: number;
  ahorroPorDiaRecienteUsd: number;

  /**
   * ESTIMACIÓN. `null` salvo en estado "ok" — un número aquí cuando no hay con
   * qué calcularlo es exactamente la clase de cifra inventada que este producto
   * no puede permitirse.
   */
  proyeccion: {
    baseUsd: number;
    ahorroUsd: number;
    ahorroEur: number;
    comision: ComisionCalculada;
    /** El ritmo con el que se ha proyectado (el reciente). */
    ritmoUsdDia: number;
  } | null;
}

/** Días naturales de un período YYYY-MM. */
export function diasDelPeriodo(periodo: string): number {
  const [anio, mes] = periodo.split("-").map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

/**
 * El ritmo del período a partir de las filas que ya carga el panel.
 *
 * @param hoyIso día actual en UTC (YYYY-MM-DD) — el mismo huso que los `day` de
 *        usage_daily, para que «hoy» no se corra de día según dónde esté quien mira.
 */
export function calcularRitmo(args: {
  rows: UsageRollup[];
  periodo: string;
  hoyIso: string;
  eurPorUsd: number;
}): Ritmo {
  const { rows, periodo, hoyIso, eurPorUsd } = args;
  const total = diasDelPeriodo(periodo);
  const enPeriodo = rows.filter((r) => r.day.startsWith(periodo));

  const medidas = enPeriodo.filter((r) => r.measuredRequests > 0);
  const ahorroDe = (r: UsageRollup) => r.measuredBaselineCost - r.measuredActualCost;
  const baseHastaLaFechaUsd = medidas.reduce((s, r) => s + r.measuredBaselineCost, 0);
  const ahorroHastaLaFechaUsd = medidas.reduce((s, r) => s + ahorroDe(r), 0);

  const periodoDeHoy = hoyIso.slice(0, 7);
  const cerrado = periodoDeHoy > periodo;
  // Un período FUTURO no tiene días transcurridos; el actual, los del día de hoy.
  const diasTranscurridos = cerrado ? total : periodoDeHoy === periodo ? Number.parseInt(hoyIso.slice(8, 10), 10) : 0;
  const diasRestantes = Math.max(0, total - diasTranscurridos);

  const vacio = {
    periodo,
    diasDelPeriodo: total,
    diasTranscurridos,
    diasRestantes,
    diasDeRitmo: 0,
    baseHastaLaFechaUsd,
    ahorroHastaLaFechaUsd,
    ahorroPorDiaUsd: 0,
    ahorroPorDiaRecienteUsd: 0,
    proyeccion: null,
  };

  if (medidas.length === 0) return { ...vacio, estado: "sin_datos" };

  // Días COMPLETOS: todo lo anterior a hoy. El de hoy va a medias y solo cuenta
  // en «hasta la fecha».
  const completas = medidas.filter((r) => r.day < hoyIso);
  if (completas.length === 0) return { ...vacio, estado: "pocos_dias" };

  // El divisor arranca en el primer día con tráfico y llega a AYER, contando los
  // días a cero que haya en medio.
  const primero = completas.reduce((min, r) => (r.day < min ? r.day : min), completas[0]!.day);
  const ultimoCompleto = cerrado ? `${periodo}-${String(total).padStart(2, "0")}` : anteriorA(hoyIso);
  const diasDeRitmo = Math.max(1, diasEntre(primero, ultimoCompleto) + 1);

  const ahorroCompleto = completas.reduce((s, r) => s + ahorroDe(r), 0);
  const baseCompleta = completas.reduce((s, r) => s + r.measuredBaselineCost, 0);
  const ahorroPorDiaUsd = ahorroCompleto / diasDeRitmo;

  // Ritmo RECIENTE: la misma cuenta sobre la última ventana. El divisor es la
  // ventana de verdad (o el tramo entero si es más corto), no el número de filas.
  const desdeReciente = maximo(primero, restarDias(ultimoCompleto, VENTANA_RITMO_DIAS - 1));
  const diasRecientes = Math.max(1, diasEntre(desdeReciente, ultimoCompleto) + 1);
  const recientes = completas.filter((r) => r.day >= desdeReciente);
  const ahorroPorDiaRecienteUsd = recientes.reduce((s, r) => s + ahorroDe(r), 0) / diasRecientes;
  const basePorDiaRecienteUsd = recientes.reduce((s, r) => s + r.measuredBaselineCost, 0) / diasRecientes;

  const comun = {
    ...vacio,
    diasDeRitmo,
    ahorroPorDiaUsd,
    ahorroPorDiaRecienteUsd,
  };

  if (cerrado) return { ...comun, estado: "cerrado" };
  if (diasDeRitmo < DIAS_MINIMOS_PARA_PROYECTAR) return { ...comun, estado: "pocos_dias" };

  // La proyección suma a lo ya medido el ritmo reciente por los días que
  // QUEDAN. Lo que falta de hoy no se proyecta: sale una cifra ligeramente
  // conservadora, que es el lado por el que conviene equivocarse cuando lo que
  // se proyecta es una comisión.
  const ahorroUsd = ahorroHastaLaFechaUsd + ahorroPorDiaRecienteUsd * diasRestantes;
  const baseUsd = baseHastaLaFechaUsd + basePorDiaRecienteUsd * diasRestantes;
  const ahorroEur = ahorroUsd * eurPorUsd;

  return {
    ...comun,
    estado: "ok",
    proyeccion: {
      baseUsd,
      ahorroUsd,
      ahorroEur,
      comision: calcularComision(baseUsd * eurPorUsd, ahorroEur),
      ritmoUsdDia: ahorroPorDiaRecienteUsd,
    },
  };
}

const DIA_MS = 86_400_000;
const aUtc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const deUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function diasEntre(desde: string, hasta: string): number {
  return Math.round((aUtc(hasta) - aUtc(desde)) / DIA_MS);
}
function restarDias(iso: string, dias: number): string {
  return deUtc(aUtc(iso) - dias * DIA_MS);
}
function anteriorA(iso: string): string {
  return restarDias(iso, 1);
}
function maximo(a: string, b: string): string {
  return a > b ? a : b;
}
