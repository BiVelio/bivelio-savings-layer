import {
  calcularComision,
  redondearCentimos,
  TRAMOS,
  type ComisionCalculada,
} from "./tarifa";

/**
 * EL EXTRACTO — el documento único del modelo a comisión.
 *
 * Regla del plan maestro: el extracto en sombra (mes de calibración) y el
 * extracto facturable son EL MISMO documento; solo cambia si al final lleva un
 * cargo o la etiqueta «período de calibración: 0 €». Así, lo que el cliente vio
 * el mes 1 es, por construcción, idéntico a lo que paga el mes 2.
 *
 * Principios que este módulo hace imposibles de violar:
 *   · Solo entra dinero MEDIDO (`measured_*` de usage_daily, migración 0010).
 *     El estimado se enseña APARTE, como contexto, y jamás suma en la base.
 *   · Cada extracto fija su versión de precios y su tipo de cambio: dos
 *     extractos del mismo período son byte a byte comparables.
 *   · La comisión sale de `calcularComision` (tramos × rampa) — nunca se
 *     recalcula aquí ni en ningún otro sitio.
 */

/** Una fila diaria de usage_daily, ya escopada a la organización. */
export interface FilaDiaria {
  day: string;
  /** Totales (medido + estimado mezclados — SOLO contexto, jamás base). */
  baseline_cost: number;
  actual_cost: number;
  requests: number;
  /** El subconjunto MEDIDO (migración 0010) — la única base facturable. */
  measured_requests: number;
  measured_baseline_cost: number;
  measured_actual_cost: number;
}

export interface OpcionesExtracto {
  orgId: string;
  /** Período del extracto, p. ej. "2026-09" (YYYY-MM, mes natural). */
  periodo: string;
  filas: FilaDiaria[];
  /** true → mes de calibración: comisión hipotética, cargo 0 €. */
  esCalibracion: boolean;
  /** Versión del catálogo de precios con que se valoró el uso (PRECIOS_AL_DIA o la del cliente). */
  versionPrecios: string;
  /** Conversión USD→EUR del cierre: cuánto EUR es 1 USD, y su fuente. */
  fx: { eurPorUsd: number; fuente: string };
}

export interface Extracto {
  orgId: string;
  periodo: string;
  esCalibracion: boolean;
  dias: number;
  requestsMedidas: number;
  /** Base y ahorro medidos en USD (la moneda de los precios de proveedor). */
  baseMedidaUsd: number;
  ahorroMedidoUsd: number;
  /** Lo mismo convertido a EUR al fx declarado — la moneda de la factura. */
  baseMedidaEur: number;
  ahorroMedidoEur: number;
  /** El cálculo completo de la comisión (ratio, rampa, tramos, neto). */
  comision: ComisionCalculada;
  /**
   * Lo que se cobra de verdad este período: la comisión, o 0 en calibración.
   * En calibración `comision.comisionEur` es la cifra «habría sido».
   */
  cargoEur: number;
  /** Ahorro estimado excluido de la base (contexto, nunca facturable). */
  ahorroEstimadoExcluidoUsd: number;
  /** Los parámetros que hacen el extracto auto-contenido y auditable. */
  parametros: {
    versionPrecios: string;
    fx: { eurPorUsd: number; fuente: string };
    tramos: readonly { hastaEur: number; tipo: number }[];
  };
}

export function construirExtracto(opts: OpcionesExtracto): Extracto {
  if (!/^\d{4}-\d{2}$/.test(opts.periodo)) {
    throw new Error(`período inválido: "${opts.periodo}" (se espera YYYY-MM)`);
  }
  if (!(opts.fx.eurPorUsd > 0)) {
    throw new Error("fx.eurPorUsd debe ser > 0");
  }

  const enPeriodo = opts.filas.filter((f) => f.day.startsWith(opts.periodo));

  let baseUsd = 0;
  let actualUsd = 0;
  let requestsMedidas = 0;
  let baselineTotalUsd = 0;
  let actualTotalUsd = 0;
  for (const f of enPeriodo) {
    baseUsd += f.measured_baseline_cost;
    actualUsd += f.measured_actual_cost;
    requestsMedidas += f.measured_requests;
    baselineTotalUsd += f.baseline_cost;
    actualTotalUsd += f.actual_cost;
  }
  const ahorroUsd = Math.max(0, baseUsd - actualUsd);
  // El ahorro total (medido+estimado) menos el medido = lo estimado, que se
  // enseña como contexto. Nunca negativo: una reparación cara puede dejar el
  // total por debajo del medido.
  const ahorroTotalUsd = Math.max(0, baselineTotalUsd - actualTotalUsd);
  const ahorroEstimadoExcluidoUsd = Math.max(0, ahorroTotalUsd - ahorroUsd);

  const baseEur = redondearCentimos(baseUsd * opts.fx.eurPorUsd);
  const ahorroEur = redondearCentimos(ahorroUsd * opts.fx.eurPorUsd);
  const comision = calcularComision(baseEur, ahorroEur);

  return {
    orgId: opts.orgId,
    periodo: opts.periodo,
    esCalibracion: opts.esCalibracion,
    dias: enPeriodo.length,
    requestsMedidas,
    baseMedidaUsd: redondearCentimos(baseUsd),
    ahorroMedidoUsd: redondearCentimos(ahorroUsd),
    baseMedidaEur: baseEur,
    ahorroMedidoEur: ahorroEur,
    comision,
    cargoEur: opts.esCalibracion ? 0 : comision.comisionEur,
    ahorroEstimadoExcluidoUsd: redondearCentimos(ahorroEstimadoExcluidoUsd),
    parametros: {
      versionPrecios: opts.versionPrecios,
      fx: opts.fx,
      // Sin umbral ni rampa desde el 2026-09-01 (decisión del dueño): un
      // extracto anterior a esa fecha sí trae umbralRatio/finRampaRatio.
      tramos: TRAMOS,
    },
  };
}
