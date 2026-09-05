import type { UsageRollup, ModelDia } from "./data";

/**
 * Puros y deterministas para el explorador de uso del panel. NO tocan BD, red ni
 * `Date.now()` implícito (el corte por periodo recibe `ahoraMs` para poder
 * testear un "hoy" fijo). El componente cliente `UsageExplorer` los usa para el
 * corte de periodo + toggle de métrica + vista por modelo, todo en el navegador.
 *
 * Doctrina de honestidad: aquí no se inventa nada. Un día sin fila no aparece
 * (son "días de utilización", justo lo que pidió el dueño); un modelo sin
 * tráfico no existe hasta que la migración 0022 esté en prod y entre tráfico
 * nuevo — el componente muestra un estado "acumulando", nunca un 0 fabricado.
 */

/** Las tres métricas que el usuario puede pintar. */
export type Metrica = "neto" | "peticiones" | "tokensEntrada";
/** Las tres vistas: barras por día, línea acumulada, barras por modelo. */
export type Vista = "dia" | "acumulado" | "modelo";
/** Los periodos configurables, en días. */
export const PERIODOS = [7, 30, 90, 120] as const;
export type Periodo = (typeof PERIODOS)[number];

/** Un punto de una serie temporal ya reducido a un solo valor. */
export interface PuntoDia {
  day: string;
  valor: number;
}
/** Un punto de la serie acumulada de ahorro neto. */
export interface PuntoAcumulado {
  day: string;
  acumulado: number;
}
/** Un modelo agregado dentro del periodo. */
export interface BarraModelo {
  model: string;
  valor: number;
}

/**
 * Filtra las filas a las de los últimos `dias` días respecto a `ahoraMs`.
 * Compara fechas "YYYY-MM-DD" lexicográficamente (ordenan como el calendario),
 * así que no construye objetos Date por fila. El umbral es inclusivo: una fila
 * de exactamente hace `dias` días entra.
 */
export function cortarPorPeriodo<T extends { day: string }>(
  rows: readonly T[],
  dias: number,
  ahoraMs: number = Date.now(),
): T[] {
  const umbral = new Date(ahoraMs - dias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return rows.filter((r) => r.day >= umbral);
}

/** El valor de una fila diaria según la métrica elegida. */
export function valorDia(r: UsageRollup, m: Metrica): number {
  switch (m) {
    case "neto":
      return r.baselineCost - r.actualCost;
    case "peticiones":
      return r.requests;
    case "tokensEntrada":
      // Opcional (0015): un proyecto por detrás de esa migración no lo trae.
      // Aquí 0 es honesto —el número real de tokens enviados ese día—, no un
      // "no disponible": la tarjeta de tokens del panel ya avisa de la ausencia.
      return r.actualInputTokens ?? 0;
  }
}

/** Serie por día: un valor por fila (los días sin fila no se rellenan). */
export function serieDiaria(rows: readonly UsageRollup[], m: Metrica): PuntoDia[] {
  return rows.map((r) => ({ day: r.day, valor: valorDia(r, m) }));
}

/**
 * Serie acumulada de la métrica elegida, sumando día a día. Con `m="neto"`
 * hereda la vista de `SavingsTrendChart` (el ahorro $ que sube); generaliza a
 * peticiones y tokens acumulados. Asume `rows` ya ordenadas por día ascendente
 * (así las devuelve `getUsageRollups`); no reordena para no ocultar un orden roto.
 */
export function serieAcumulada(rows: readonly UsageRollup[], m: Metrica): PuntoAcumulado[] {
  let acc = 0;
  return rows.map((r) => {
    acc += valorDia(r, m);
    return { day: r.day, acumulado: acc };
  });
}

/** El valor de una fila por-modelo según la métrica elegida. */
export function valorModelo(r: ModelDia, m: Metrica): number {
  switch (m) {
    case "neto":
      return r.baselineCost - r.actualCost;
    case "peticiones":
      return r.requests;
    case "tokensEntrada":
      return r.actualInputTokens;
  }
}

/**
 * Agrega las filas por-modelo (varias por (día, modelo)) en un total por modelo
 * dentro del periodo, ordenado de mayor a menor por el valor de la métrica.
 * Empate por nombre de modelo para que el orden sea determinista (testeable).
 */
export function agregarPorModelo(rows: readonly ModelDia[], m: Metrica): BarraModelo[] {
  const acc = new Map<string, number>();
  for (const r of rows) {
    acc.set(r.model, (acc.get(r.model) ?? 0) + valorModelo(r, m));
  }
  return [...acc.entries()]
    .map(([model, valor]) => ({ model, valor }))
    .sort((a, b) => b.valor - a.valor || a.model.localeCompare(b.model));
}

/**
 * Conserva las `n` primeras barras y suma el resto en una sola, etiquetada
 * `etiquetaResto`, para no pintar una lista interminable de modelos de cola.
 * Con `n` o menos barras las devuelve tal cual (sin fila "resto").
 */
export function topConResto(barras: readonly BarraModelo[], n: number, etiquetaResto: string): BarraModelo[] {
  if (barras.length <= n) return [...barras];
  const cabeza = barras.slice(0, n);
  const resto = barras.slice(n).reduce((s, b) => s + b.valor, 0);
  return [...cabeza, { model: etiquetaResto, valor: resto }];
}
