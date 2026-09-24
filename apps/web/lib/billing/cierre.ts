import { construirExtracto, type Extracto, type FilaDiaria } from "./extracto";
import { VERSION_PRECIOS_CATALOGO } from "./extracto-sombra";
import type { Fx } from "./fx";

/**
 * EL CIERRE MENSUAL — la lógica pura que el cron ejecuta el día 1.
 *
 * Toma las filas de usage_daily del período YA AGRUPADAS por organización y
 * produce, por cada una, la fila inmutable que se fija en bvsala.extractos.
 *
 * La CALIBRACIÓN aquí es la real, no la heurística de la vista: una
 * organización está en calibración en su PRIMER período con uso — decidido
 * con `primerPeriodoConUso` (el min(day) de TODA su historia, no de una
 * ventana). La vista en sombra puede equivocarse hacia el lado que no cobra;
 * el cierre no se puede equivocar hacia ninguno.
 */

export interface UsoDeOrg {
  orgId: string;
  filas: FilaDiaria[];
  /** El período (YYYY-MM) del primer día con uso en TODA la historia de la org. */
  primerPeriodoConUso: string;
  /** `organizations.comision_exenta`: probadores y cortesías. Cargo 0. */
  comisionExenta?: boolean;
}

export interface FilaDeCierre {
  org_id: string;
  periodo: string;
  es_calibracion: boolean;
  es_exento: boolean;
  dias: number;
  requests_medidas: number;
  base_medida_usd: number;
  ahorro_medido_usd: number;
  base_medida_eur: number;
  ahorro_medido_eur: number;
  ratio: number;
  factor_rampa: number;
  comision_eur: number;
  cargo_eur: number;
  ahorro_estimado_excluido_usd: number;
  version_precios: string;
  fx_eur_por_usd: number;
  fx_fuente: string;
  tramos: { desdeEur: number; hastaEur: number | null; tipo: number; baseEur: number; comisionEur: number }[];
  /**
   * El carril MEDIDO POR REFERENCIA (0029), sellado con la regla que lo valoró.
   * Con la referencia comisionada, estas cifras YA están dentro de
   * requests_medidas / base_medida_usd / ahorro_medido_usd; aquí van aparte
   * para auditarlas. `regla_referencia`: "" sin referencia, la versión de la
   * regla si entró en la base y la versión + ":excluida" si solo se enseñó.
   */
  requests_referencia: number;
  base_referencia_usd: number;
  ahorro_referencia_usd: number;
  regla_referencia: string;
}

/** El período anterior al de la fecha dada (el que el cron del día 1 cierra). */
export function periodoAnterior(ahora: Date): string {
  const y = ahora.getUTCFullYear();
  const m = ahora.getUTCMonth(); // 0-11; el mes anterior en UTC
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * El cierre facturable. El `fx` es OBLIGATORIO y lo aporta quien llama (el cron,
 * con el cambio del BCE del día): antes se usaba FX_SOMBRA (0,9 fijo) y esa cifra
 * de mentira acababa sellada en la fila inmutable y cobrada en Stripe. La sombra
 * (una estimación en pantalla) sigue usando FX_SOMBRA; el cierre real, no.
 */
export function cerrarPeriodo(usoPorOrg: UsoDeOrg[], periodo: string, fx: Fx): FilaDeCierre[] {
  return usoPorOrg.map((org) => {
    const e = construirExtracto({
      orgId: org.orgId,
      periodo,
      filas: org.filas,
      esCalibracion: org.primerPeriodoConUso >= periodo,
      esExento: org.comisionExenta === true,
      versionPrecios: VERSION_PRECIOS_CATALOGO,
      fx,
    });
    return aFilaDeCierre(e);
  });
}

function aFilaDeCierre(e: Extracto): FilaDeCierre {
  return {
    org_id: e.orgId,
    periodo: e.periodo,
    es_calibracion: e.esCalibracion,
    es_exento: e.esExento,
    dias: e.dias,
    requests_medidas: e.requestsMedidas,
    base_medida_usd: e.baseMedidaUsd,
    ahorro_medido_usd: e.ahorroMedidoUsd,
    base_medida_eur: e.baseMedidaEur,
    ahorro_medido_eur: e.ahorroMedidoEur,
    ratio: redondear6(e.comision.ratio),
    // La rampa 30→35% se retiró el 2026-09-01 (sin mínimo): desde entonces la
    // comisión aplica entera y este factor es constante. La columna (0016, not
    // null) se conserva para que las filas históricas sigan siendo legibles.
    factor_rampa: 1,
    comision_eur: e.comision.comisionEur,
    cargo_eur: e.cargoEur,
    ahorro_estimado_excluido_usd: e.ahorroEstimadoExcluidoUsd,
    version_precios: e.parametros.versionPrecios,
    fx_eur_por_usd: e.parametros.fx.eurPorUsd,
    fx_fuente: e.parametros.fx.fuente,
    // Infinity no viaja en JSON: el último tramo se fija con hasta=null.
    tramos: e.comision.tramos.map((t) => ({
      desdeEur: t.desdeEur,
      hastaEur: Number.isFinite(t.hastaEur) ? t.hastaEur : null,
      tipo: t.tipo,
      baseEur: t.baseEur,
      comisionEur: t.comisionEur,
    })),
    requests_referencia: e.referencia?.requests ?? 0,
    base_referencia_usd: e.referencia?.baseUsd ?? 0,
    // El CHECK de 0029 exige ≥ 0: un ahorro de referencia negativo es imposible
    // por construcción (coste real 0), pero la fila inmutable no se juega a eso.
    ahorro_referencia_usd: Math.max(0, e.referencia?.ahorroUsd ?? 0),
    regla_referencia: reglaSellada(e),
  };
}

/** El sello de la regla del carril por referencia en la fila cerrada. */
function reglaSellada(e: Extracto): string {
  if (e.referencia === null) return "";
  const version = e.parametros.referencia.version;
  return e.referencia.comisionada ? version : `${version}:excluida`;
}

function redondear6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Lo que el ensayo en seco del cierre (`?seco=1`) devuelve por organización:
 * las cifras que deciden el dinero, sin los tramos ni las columnas en USD.
 */
export interface ResumenDeCierre {
  org_id: string;
  periodo: string;
  es_calibracion: boolean;
  es_exento: boolean;
  dias: number;
  requests_medidas: number;
  /** Cuántas de las medidas lo son POR REFERENCIA (0029): las que hay que revisar a mano antes del primer cierre. */
  requests_referencia: number;
  base_medida_eur: number;
  ahorro_medido_eur: number;
  ratio: number;
  comision_eur: number;
  cargo_eur: number;
  fx_eur_por_usd: number;
  fx_fuente: string;
}

export function resumenDelCierre(cierre: FilaDeCierre[]): ResumenDeCierre[] {
  return cierre.map((c) => ({
    org_id: c.org_id,
    periodo: c.periodo,
    es_calibracion: c.es_calibracion,
    es_exento: c.es_exento,
    dias: c.dias,
    requests_medidas: c.requests_medidas,
    requests_referencia: c.requests_referencia,
    base_medida_eur: c.base_medida_eur,
    ahorro_medido_eur: c.ahorro_medido_eur,
    ratio: c.ratio,
    comision_eur: c.comision_eur,
    cargo_eur: c.cargo_eur,
    fx_eur_por_usd: c.fx_eur_por_usd,
    fx_fuente: c.fx_fuente,
  }));
}
