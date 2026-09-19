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

/**
 * Las métricas que el usuario puede pintar. Las tres primeras son las de
 * siempre; las seis siguientes abren los CUATRO LIBROS y los dos costes que hay
 * detrás del neto. Se pintan de UNA en una, nunca apiladas: los libros no se
 * suman entre sí (docs/ARCHITECTURE.md §1) y un gráfico apilado los sumaría con
 * la vista aunque el pie de página dijera lo contrario.
 */
export type Metrica =
  | "neto"
  | "peticiones"
  | "tokensEntrada"
  | "costeBase"
  | "costeReal"
  | "llamadasEvitadas"
  | "tokensEliminados"
  | "tokensComprimidos"
  | "tokensCacheProveedor";

/** Cómo se formatea cada métrica: dinero, recuento exacto o tokens compactos. */
export type TipoMetrica = "dinero" | "entero" | "tokens";

/**
 * Catálogo de métricas, en el orden de los controles. `porModelo` dice si la
 * tabla `usage_daily_by_model` la trae: los libros solo existen en el rollup
 * diario, así que en la vista por modelo se declaran no disponibles en vez de
 * pintarse a cero.
 */
export const METRICAS: ReadonlyArray<{
  v: Metrica;
  tipo: TipoMetrica;
  porModelo: boolean;
  /** Columna(s) de `bvsala.usage_daily` de las que sale: la procedencia que se escribe al pie. */
  columna: string;
  libro?: string;
}> = [
  { v: "neto", tipo: "dinero", porModelo: true, columna: "baseline_cost − actual_cost" },
  { v: "costeBase", tipo: "dinero", porModelo: true, columna: "baseline_cost" },
  { v: "costeReal", tipo: "dinero", porModelo: true, columna: "actual_cost" },
  { v: "peticiones", tipo: "entero", porModelo: true, columna: "requests" },
  { v: "tokensEntrada", tipo: "tokens", porModelo: true, columna: "actual_input_tokens" },
  { v: "llamadasEvitadas", tipo: "entero", porModelo: false, columna: "avoided_llm", libro: "avoided_calls" },
  { v: "tokensEliminados", tipo: "tokens", porModelo: false, columna: "eliminated_input_tokens", libro: "eliminated_tokens" },
  { v: "tokensComprimidos", tipo: "tokens", porModelo: false, columna: "compressed_input_tokens", libro: "compressed_tokens" },
  { v: "tokensCacheProveedor", tipo: "tokens", porModelo: false, columna: "provider_cached_input_tokens", libro: "provider_cached_tokens" },
];

export function columnaDeMetrica(m: Metrica): string {
  return METRICAS.find((x) => x.v === m)?.columna ?? m;
}

export function tipoDeMetrica(m: Metrica): TipoMetrica {
  return METRICAS.find((x) => x.v === m)?.tipo ?? "entero";
}

export function metricaDisponiblePorModelo(m: Metrica): boolean {
  return METRICAS.find((x) => x.v === m)?.porModelo ?? false;
}

/** El libro mayor detrás de una métrica, si lo hay (para la procedencia y el color). */
export function libroDeMetrica(m: Metrica): string | undefined {
  return METRICAS.find((x) => x.v === m)?.libro;
}
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
    case "costeBase":
      return r.baselineCost;
    case "costeReal":
      return r.actualCost;
    case "llamadasEvitadas":
      return r.avoidedLlm;
    case "tokensEliminados":
      return r.eliminatedInputTokens;
    case "tokensComprimidos":
      return r.compressedInputTokens;
    case "tokensCacheProveedor":
      return r.providerCachedInputTokens;
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

/**
 * El valor de una fila por-modelo según la métrica elegida. Los libros no
 * viajan por modelo: devuelven 0 y el componente, que consulta
 * `metricaDisponiblePorModelo` antes, no llega a pintarlos.
 */
export function valorModelo(r: ModelDia, m: Metrica): number {
  switch (m) {
    case "neto":
      return r.baselineCost - r.actualCost;
    case "costeBase":
      return r.baselineCost;
    case "costeReal":
      return r.actualCost;
    case "peticiones":
      return r.requests;
    case "tokensEntrada":
      return r.actualInputTokens;
    case "llamadasEvitadas":
    case "tokensEliminados":
    case "tokensComprimidos":
    case "tokensCacheProveedor":
      return 0;
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
