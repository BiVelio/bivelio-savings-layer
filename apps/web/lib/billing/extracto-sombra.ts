import type { UsageRollup } from "@/app/[locale]/dashboard/data";

import { construirExtracto, type Extracto, type FilaDiaria } from "./extracto";

/**
 * EL EXTRACTO EN SOMBRA — la vista del dashboard del mes de calibración.
 *
 * Desde el día uno, cada organización ve el extracto que su período actual
 * HABRÍA producido: misma máquina (`construirExtracto`), mismo documento que
 * la futura factura. Nada de esto cobra: es la sombra del plan maestro.
 */

/**
 * Versión del catálogo de precios del SDK (PRECIOS_AL_DIA). apps/web es un
 * proyecto aparte y no puede importar de src/, así que la constante vive
 * duplicada AQUÍ y un test la ancla al fichero fuente del catálogo — si el
 * catálogo se actualiza sin tocar esto, el build se pone rojo (mismo patrón
 * que precio-publicado.test.ts).
 */
export const VERSION_PRECIOS_CATALOGO = "2026-09-27";

/**
 * FX de la SOMBRA: una referencia fija y declarada, no un tipo de mercado.
 * El cierre facturable usará el tipo BCE del último día del período; hasta
 * entonces mentiría menos un número fijo etiquetado que uno "casi real" sin
 * fuente. La fuente viaja en el extracto y la UI la enseña tal cual.
 */
export const FX_SOMBRA = { eurPorUsd: 0.9, fuente: "referencia fija del modo sombra (el cierre usará BCE)" } as const;

/** El período natural (YYYY-MM) de una fecha, en UTC — como los `day` de usage_daily. */
export function periodoDe(fecha: Date): string {
  return fecha.toISOString().slice(0, 7);
}

/**
 * ¿Es el período actual el de CALIBRACIÓN de esta organización?
 *
 * Heurística de la sombra: lo es si no existe uso en ningún período anterior
 * dentro de la ventana que carga el panel (120 días). El cierre facturable
 * real usará la fecha de alta de la suscripción — esto solo decide qué
 * etiqueta enseña la vista, y ante la duda etiqueta calibración, que es el
 * lado que nunca cobra de más.
 */
export function esPeriodoDeCalibracion(rows: UsageRollup[], periodo: string): boolean {
  return !rows.some((r) => r.day.slice(0, 7) < periodo);
}

function aFila(r: UsageRollup): FilaDiaria {
  return {
    day: r.day,
    baseline_cost: r.baselineCost,
    actual_cost: r.actualCost,
    requests: r.requests,
    measured_requests: r.measuredRequests,
    measured_baseline_cost: r.measuredBaselineCost,
    measured_actual_cost: r.measuredActualCost,
    // El carril sombra (0021), si el panel lo trae: contexto del extracto,
    // jamás base. Sin columnas, undefined — la línea no se pinta.
    ...(r.shadowRequests !== undefined
      ? {
          shadow_requests: r.shadowRequests,
          shadow_baseline_cost: r.shadowBaselineCost ?? 0,
          shadow_actual_cost: r.shadowActualCost ?? 0,
        }
      : {}),
    // El carril del borrado del proveedor (0025): misma regla que la sombra —
    // contexto, jamás base (salvo COMISIONAR_ELISION_SUELO). Sin columnas, nada.
    ...(r.eliminatedCreditedRequests !== undefined
      ? {
          eliminated_credited_requests: r.eliminatedCreditedRequests,
          eliminated_floor_cost: r.eliminatedFloorCost ?? 0,
        }
      : {}),
    // El carril medido por referencia (0029): a diferencia de los dos de arriba,
    // entra en la base bajo COMISIONAR_REFERENCIA (lo decide construirExtracto).
    // Sin columnas, nada — el extracto sale igual que antes de 0029.
    ...(r.referenceRequests !== undefined
      ? {
          reference_requests: r.referenceRequests,
          reference_baseline_cost: r.referenceBaselineCost ?? 0,
          reference_actual_cost: r.referenceActualCost ?? 0,
        }
      : {}),
  };
}

/** El extracto en sombra del período dado, desde las filas que ya carga el panel. */
export function extractoEnSombra(orgId: string, rows: UsageRollup[], periodo: string, esExento = false): Extracto {
  return construirExtracto({
    orgId,
    esExento,
    periodo,
    filas: rows.map(aFila),
    esCalibracion: esPeriodoDeCalibracion(rows, periodo),
    versionPrecios: VERSION_PRECIOS_CATALOGO,
    fx: FX_SOMBRA,
  });
}
