import {
  calcularComision,
  COMISIONAR_ELISION_SUELO,
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
  /** El carril SOMBRA (0021) — hipotético: SOLO contexto, jamás en la base.
   *  Opcionales: el cierre sellado no los lee y la vista puede no tenerlos. */
  shadow_requests?: number;
  shadow_baseline_cost?: number;
  shadow_actual_cost?: number;
  /** El carril del BORRADO DEL PROVEEDOR (0025) — contexto; entra en la base
   *  SOLO bajo COMISIONAR_ELISION_SUELO (hoy false). Opcionales como shadow_*. */
  eliminated_floor_cost?: number;
  eliminated_credited_requests?: number;
}

export interface OpcionesExtracto {
  orgId: string;
  /** Período del extracto, p. ej. "2026-09" (YYYY-MM, mes natural). */
  periodo: string;
  filas: FilaDiaria[];
  /** true → mes de calibración: comisión hipotética, cargo 0 €. */
  esCalibracion: boolean;
  /** Organización exenta de comisión (probadores, cortesía): cargo 0, comisión calculada igual. */
  esExento?: boolean;
  /** Versión del catálogo de precios con que se valoró el uso (PRECIOS_AL_DIA o la del cliente). */
  versionPrecios: string;
  /** Conversión USD→EUR del cierre: cuánto EUR es 1 USD, y su fuente. */
  fx: { eurPorUsd: number; fuente: string };
}

export interface Extracto {
  orgId: string;
  periodo: string;
  esCalibracion: boolean;
  esExento: boolean;
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
  /**
   * El carril sombra del período (contexto, nunca facturable): qué habría
   * ahorrado la elisión v0 según el gateway. `null` sin datos de sombra — la
   * línea no se pinta. El ahorro PUEDE ser negativo y se enseña tal cual: este
   * carril existe para decir la verdad antes de encender la palanca.
   */
  sombra: { requests: number; ahorroUsd: number } | null;
  /**
   * El carril del borrado del proveedor del período (0025): peticiones
   * acreditadas y su suelo en USD. CONTEXTO en su línea propia — jamás sumado a
   * `ahorroMedidoUsd` ni a la base mientras COMISIONAR_ELISION_SUELO sea false.
   * La vista enseña solo `requests`; el dólar viaja para auditoría. `null` sin
   * acreditadas — la línea no se pinta.
   */
  elisionProveedor: { requests: number; floorUsd: number } | null;
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
  let sombraRequests = 0;
  let sombraBaseUsd = 0;
  let sombraActualUsd = 0;
  let elisionRequests = 0;
  let elisionFloorUsd = 0;
  for (const f of enPeriodo) {
    baseUsd += f.measured_baseline_cost;
    actualUsd += f.measured_actual_cost;
    requestsMedidas += f.measured_requests;
    baselineTotalUsd += f.baseline_cost;
    actualTotalUsd += f.actual_cost;
    sombraRequests += f.shadow_requests ?? 0;
    sombraBaseUsd += f.shadow_baseline_cost ?? 0;
    sombraActualUsd += f.shadow_actual_cost ?? 0;
    elisionRequests += f.eliminated_credited_requests ?? 0;
    elisionFloorUsd += f.eliminated_floor_cost ?? 0;
  }
  // SELLO (2026-09-09) · `eliminated_floor_cost` es un BRUTO: cuenta lo que el
  // proveedor borró, a precio de lectura de caché, y JAMÁS resta la
  // invalidación de prefijo que ese mismo corte provoca. Medido sobre el
  // tráfico real del 08 y el 09 de septiembre, el NETO de esos días es
  // NEGATIVO (entre −$55 y −$322 según el método de enlace de ramas; el signo
  // no cambia con ninguno). Facturar este bruto sería cobrarle al cliente el
  // daño que le hemos causado.
  //
  // Por eso el interruptor ya no basta: mientras no exista una columna de
  // NETO medido (bruto − reescritura, por petición), encenderlo es un error de
  // programa y no una decisión de negocio. Quien quiera cobrarlo tiene que
  // borrar este guardia a mano, y eso se ve en el diff.
  if (COMISIONAR_ELISION_SUELO) {
    throw new Error(
      "COMISIONAR_ELISION_SUELO está encendido, pero eliminated_floor_cost es un BRUTO " +
        "sin restar la invalidación de prefijo: el neto medido del 2026-09-08/09 es NEGATIVO. " +
        "No se puede facturar. Ver db/migrations/0025_dinero_de_la_elision_suelo.sql.",
    );
  }
  const extraSuelo = 0;
  baseUsd += extraSuelo;
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
    esExento: opts.esExento === true,
    dias: enPeriodo.length,
    requestsMedidas,
    baseMedidaUsd: redondearCentimos(baseUsd),
    ahorroMedidoUsd: redondearCentimos(ahorroUsd),
    baseMedidaEur: baseEur,
    ahorroMedidoEur: ahorroEur,
    comision,
    // Calibración y exención cobran CERO; la comisión se calcula igual para que
    // el extracto diga lo que habría sido.
    cargoEur: opts.esCalibracion || opts.esExento === true ? 0 : comision.comisionEur,
    ahorroEstimadoExcluidoUsd: redondearCentimos(ahorroEstimadoExcluidoUsd),
    sombra:
      sombraRequests > 0 && sombraBaseUsd > 0
        ? { requests: sombraRequests, ahorroUsd: redondearCentimos(sombraBaseUsd - sombraActualUsd) }
        : null,
    elisionProveedor:
      elisionRequests > 0 ? { requests: elisionRequests, floorUsd: redondearCentimos(elisionFloorUsd) } : null,
    parametros: {
      versionPrecios: opts.versionPrecios,
      fx: opts.fx,
      // Sin umbral ni rampa desde el 2026-09-01 (decisión del dueño): un
      // extracto anterior a esa fecha sí trae umbralRatio/finRampaRatio.
      tramos: TRAMOS,
    },
  };
}
