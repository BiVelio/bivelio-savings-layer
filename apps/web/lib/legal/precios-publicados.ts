import { DIAS_ACTIVOS_PARA_CONTAR_ASIENTO, MAX_ASIENTOS } from "@/lib/billing/asientos";
import { MINIMO_FACTURABLE_EUR } from "@/lib/billing/facturacion";
import {
  COMISIONAR_ELISION_SUELO,
  COMISIONAR_REFERENCIA,
  GARANTIA_NETA_RATIO,
  MONEDA_DE_LA_COMISION,
  REGLA_REFERENCIA,
  TRAMOS,
} from "@/lib/billing/tarifa";
import { formatearPrecio } from "@/lib/format/precio";
import { ETIQUETAS_DE_BASIS } from "@/lib/metering/usage";
import type { PreciosDelPlan, TarifasDeLosPlanes } from "@/lib/stripe/pricing";

/**
 * LA «PUBLISHED PRICING» QUE CITA LA LICENSE §6, en puro.
 *
 * La página `/[locale]/pricing` no escribe ni una cifra: todo lo que enseña
 * sale de aquí, y aquí todo sale de las constantes que COBRAN —
 *   · la cuota de Pro y de Equipo: sus Prices de Stripe (`tarifasDeLosPlanes`,
 *     con `PRECIOS_DE_LOS_PLANES` de `lib/billing/planes.ts` como respaldo);
 *   · la cuota por asiento de la modalidad con comisión (cerrada a clientes
 *     nuevos; la conserva quien la tiene): el Price de siempre
 *     (`preciosDelPlan`, con su respaldo en `lib/stripe/pricing.ts`);
 *   · los tramos, la moneda de la comisión, la regla por referencia y los dos
 *     interruptores: `lib/billing/tarifa.ts`;
 *   · el mínimo facturable: `lib/billing/facturacion.ts`;
 *   · qué cuenta como asiento: `lib/billing/asientos.ts` (espejo del SQL);
 *   · qué etiquetas de `basis` existen: la lista blanca del ingest.
 * Los mensajes de la página no llevan dígitos (tarifa-en-parametros.test.ts) y
 * `precios-publicados.test.ts` prohíbe literales numéricos en la página y en
 * este módulo: cambiar la tarifa real cambia la página sola, en los doce idiomas.
 *
 * Se llama SOLO en el servidor, con el `locale` explícito (misma regla que
 * `formatearPrecio`): el texto formateado baja ya hecho.
 */

/** Las etiquetas de `basis` que entran en la base de la comisión, según los interruptores de tarifa.ts. */
export function etiquetasComisionables(): string[] {
  return ["measured", ...(COMISIONAR_REFERENCIA ? ["reference"] : [])];
}

/** Las que nunca llevan comisión: todas las que admite el ingest menos las comisionables. */
export function etiquetasSinComision(): string[] {
  const comisionables = new Set(etiquetasComisionables());
  return ETIQUETAS_DE_BASIS.filter((b) => !comisionables.has(b));
}

export interface TramoPublicado {
  /** «hasta» (primer tramo), «entre» (intermedio) o «desde» (el último, sin techo). */
  forma: "hasta" | "entre" | "desde";
  desde: string;
  hasta: string;
  tipo: string;
}

export interface TerminosDePrecio {
  mensual: string;
  anual: string;
  /** El código ISO de la cuota («EUR»), tal como lo devuelve Stripe. */
  monedaCuota: string;
  maxAsientos: string;
  diasActivos: string;
  /** «"measured" or "reference"», con la conjunción del idioma. */
  comisionables: string;
  sinComision: string;
  /** Solo con COMISIONAR_REFERENCIA: la regla publicada que valora las repeticiones. */
  reglaReferencia: string | null;
  /** Si el suelo de elisión se enseña fuera de la base (COMISIONAR_ELISION_SUELO = false). */
  elisionFueraDeLaBase: boolean;
  monedaComision: string;
  tramos: TramoPublicado[];
  /** El tipo más alto de los tramos (la cota de la comisión antes de redondear). */
  tipoMaximo: string;
  /** Lo que el cliente conserva como mínimo, derivado del tramo más caro. */
  garantia: string;
  minimoFacturable: string;
}

const entreComillas = (etiqueta: string) => `"${etiqueta}"`;

export function terminosDePrecio(locale: string, precios: PreciosDelPlan): TerminosDePrecio {
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 });
  const entero = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const umbral = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: MONEDA_DE_LA_COMISION,
    maximumFractionDigits: 0,
  });
  const centimos = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: MONEDA_DE_LA_COMISION,
    minimumFractionDigits: 2,
  });
  const o = new Intl.ListFormat(locale, { type: "disjunction" });

  let desde = 0;
  const tramos: TramoPublicado[] = TRAMOS.map((t, i) => {
    const forma: TramoPublicado["forma"] = !Number.isFinite(t.hastaEur) ? "desde" : i === 0 ? "hasta" : "entre";
    const fila = {
      forma,
      desde: umbral.format(desde),
      hasta: Number.isFinite(t.hastaEur) ? umbral.format(t.hastaEur) : "",
      tipo: pct.format(t.tipo),
    };
    desde = t.hastaEur;
    return fila;
  });

  return {
    mensual: formatearPrecio(locale, precios.monthly),
    anual: formatearPrecio(locale, precios.yearly),
    monedaCuota: precios.monthly.currency.toUpperCase(),
    maxAsientos: entero.format(MAX_ASIENTOS),
    diasActivos: entero.format(DIAS_ACTIVOS_PARA_CONTAR_ASIENTO),
    comisionables: o.format(etiquetasComisionables().map(entreComillas)),
    sinComision: o.format(etiquetasSinComision().map(entreComillas)),
    reglaReferencia: COMISIONAR_REFERENCIA ? REGLA_REFERENCIA.version : null,
    elisionFueraDeLaBase: !COMISIONAR_ELISION_SUELO,
    monedaComision: MONEDA_DE_LA_COMISION,
    tramos,
    tipoMaximo: pct.format(Math.max(...TRAMOS.map((t) => t.tipo))),
    garantia: pct.format(GARANTIA_NETA_RATIO),
    minimoFacturable: centimos.format(MINIMO_FACTURABLE_EUR),
  };
}

export interface TerminosDeLosPlanes {
  pro: { mensual: string; anual: string };
  equipo: {
    mensual: string;
    anual: string;
    /** Asientos que cubre la cuota fija. */
    incluidos: string;
    /** Lo que sale cada asiento incluido, al mes (cuota fija / incluidos). */
    porAsiento: string;
    extraMensual: string;
    extraAnual: string;
  };
  /** El código ISO de las cuotas («EUR»). */
  moneda: string;
}

/** Las cifras de Pro y Equipo, formateadas: salen de sus Prices (o del respaldo de planes.ts, si faltan). */
export function terminosDeLosPlanes(locale: string, t: TarifasDeLosPlanes): TerminosDeLosPlanes {
  const entero = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const f = (amount: number, currency: string) => formatearPrecio(locale, { amount, currency });
  const em = t.equipo.monthly;
  const ey = t.equipo.yearly;
  return {
    pro: {
      mensual: f(t.pro.monthly.asientoCentimos, t.pro.monthly.currency),
      anual: f(t.pro.yearly.asientoCentimos, t.pro.yearly.currency),
    },
    equipo: {
      mensual: f(em.fijaCentimos, em.currency),
      anual: f(ey.fijaCentimos, ey.currency),
      incluidos: entero.format(em.asientosIncluidos),
      porAsiento: f(em.asientosIncluidos > 0 ? Math.round(em.fijaCentimos / em.asientosIncluidos) : em.asientoCentimos, em.currency),
      extraMensual: f(em.asientoCentimos, em.currency),
      extraAnual: f(ey.asientoCentimos, ey.currency),
    },
    moneda: t.pro.monthly.currency.toUpperCase(),
  };
}
