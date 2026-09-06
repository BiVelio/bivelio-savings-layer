import type { PuntoDia } from "./explorer-datos";

/**
 * ESTADÍSTICA DEL EXPLORADOR — la parte cuantitativa, separada de la pintura.
 *
 * El explorador enseñaba barras y un total. Para quien compra esto (equipos que
 * miran el gasto en tokens como miran cualquier otra partida) eso es un dibujo,
 * no un dato: sin eje no se lee una magnitud, sin mediana ni p95 no se sabe si
 * un pico es la norma o una anomalía, y sin tendencia no se sabe si la cosa va
 * a mejor. Todo eso se calcula aquí, en funciones puras y probadas, para que la
 * vista solo tenga que colocar números que ya están bien.
 *
 * Dos decisiones de honestidad que se pagan en código:
 *
 * 1. HUECOS. Antes solo se pintaban los días CON fila, repartidos a lo ancho:
 *    seis días sueltos de un mes se leían como seis días seguidos. Aquí el eje
 *    es el calendario completo entre el primer y el último día con dato, y un
 *    día sin fila entra como cero MARCADO (`conDatos: false`) — un cero real,
 *    porque no hubo tráfico, pero distinguible a la vista de un día medido.
 * 2. EL EJE INCLUYE SIEMPRE EL CERO. Una escala que arranca en el mínimo
 *    observado multiplica visualmente cualquier diferencia; es el truco de
 *    gráfico más viejo que hay y aquí no se usa.
 */

/** Un día del eje X, tenga fila o no. */
export interface Ranura {
  day: string;
  valor: number;
  /** `false` = ese día no traía fila. Cero de verdad, pero cero sin medir. */
  conDatos: boolean;
}

export interface Tendencia {
  /** "ventana" = N días contra los N anteriores; "mitades" = mitad contra mitad. */
  modo: "ventana" | "mitades";
  /** Días a cada lado de la comparación. */
  ventana: number;
  actual: number;
  previo: number;
  /** Variación relativa. `null` si el tramo previo es 0: no hay base que comparar. */
  delta: number | null;
}

export interface Resumen {
  total: number;
  media: number;
  mediana: number;
  p95: number;
  /** Desviación típica poblacional — dispersión del día a día. */
  desviacion: number;
  max: Ranura | null;
  min: Ranura | null;
  diasConUso: number;
  diasTotales: number;
  tendencia: Tendencia | null;
}

export interface Escala {
  min: number;
  max: number;
  paso: number;
  ticks: number[];
}

/** Tope de ranuras: 120 días es el periodo máximo; el margen cubre datos sucios. */
const MAX_RANURAS = 400;
const DIA_MS = 86_400_000;
const aUtc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const deUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * El calendario completo entre el primer y el último día con dato.
 *
 * No se extiende hasta "hoy" ni hasta el borde del periodo elegido a propósito:
 * inventar ranuras antes de que la cuenta existiera diría «no consumiste nada»
 * donde la verdad es «todavía no eras cliente». Lo que sí se rellena son los
 * huecos INTERIORES, que son ceros reales y son justo los que había que ver.
 */
export function rellenarCalendario(puntos: readonly PuntoDia[]): Ranura[] {
  if (puntos.length === 0) return [];
  const porDia = new Map<string, number>();
  for (const p of puntos) porDia.set(p.day, (porDia.get(p.day) ?? 0) + p.valor);

  const dias = [...porDia.keys()].sort();
  const desde = dias[0]!;
  const hasta = dias[dias.length - 1]!;
  const inicio = aUtc(desde);
  const fin = aUtc(hasta);
  if (!Number.isFinite(inicio) || !Number.isFinite(fin) || fin < inicio) {
    return dias.map((day) => ({ day, valor: porDia.get(day)!, conDatos: true }));
  }
  const total = Math.min(MAX_RANURAS, Math.round((fin - inicio) / DIA_MS) + 1);

  const out: Ranura[] = [];
  for (let i = 0; i < total; i++) {
    const day = deUtc(inicio + i * DIA_MS);
    const v = porDia.get(day);
    out.push({ day, valor: v ?? 0, conDatos: v !== undefined });
  }
  return out;
}

/** Cuantil por interpolación lineal sobre un array YA ordenado ascendente. */
export function cuantil(orden: readonly number[], q: number): number {
  if (orden.length === 0) return 0;
  if (orden.length === 1) return orden[0]!;
  const pos = (orden.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return orden[lo]!;
  return orden[lo]! + (orden[hi]! - orden[lo]!) * (pos - lo);
}

const suma = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

/**
 * El resumen estadístico de la serie.
 *
 * Mediana, p95 y desviación se calculan sobre TODAS las ranuras, ceros
 * incluidos: un día sin tráfico es parte de la distribución del consumo, y
 * quitarlo maquillaría la media a la alza justo donde interesa no maquillarla.
 */
export function resumirSerie(ranuras: readonly Ranura[], ventana = 7): Resumen {
  const n = ranuras.length;
  const vacio: Resumen = {
    total: 0, media: 0, mediana: 0, p95: 0, desviacion: 0,
    max: null, min: null, diasConUso: 0, diasTotales: 0, tendencia: null,
  };
  if (n === 0) return vacio;

  const valores = ranuras.map((r) => r.valor);
  const total = suma(valores);
  const media = total / n;
  const orden = [...valores].sort((a, b) => a - b);
  const varianza = suma(valores.map((v) => (v - media) ** 2)) / n;

  // `reduce` con comparación estricta: ante empate se queda el PRIMERO, para
  // que el mismo dato dé siempre el mismo día en pantalla.
  const max = ranuras.reduce((m, r) => (r.valor > m.valor ? r : m), ranuras[0]!);
  const min = ranuras.reduce((m, r) => (r.valor < m.valor ? r : m), ranuras[0]!);

  return {
    total,
    media,
    mediana: cuantil(orden, 0.5),
    p95: cuantil(orden, 0.95),
    desviacion: Math.sqrt(varianza),
    max,
    min,
    diasConUso: ranuras.filter((r) => r.conDatos).length,
    diasTotales: n,
    tendencia: calcularTendencia(valores, ventana),
  };
}

/**
 * Tendencia: N días contra los N anteriores cuando la serie da para dos ventanas
 * enteras; si no, mitad contra mitad. Los dos lados miden SIEMPRE los mismos
 * días — comparar 4 días contra 3 y llamarlo tendencia es hacer trampa.
 */
function calcularTendencia(valores: readonly number[], ventana: number): Tendencia | null {
  const n = valores.length;
  const cierra = (modo: Tendencia["modo"], v: number, actual: number, previo: number): Tendencia => ({
    modo,
    ventana: v,
    actual,
    previo,
    delta: previo !== 0 ? (actual - previo) / Math.abs(previo) : null,
  });

  if (ventana >= 1 && n >= ventana * 2) {
    return cierra("ventana", ventana, suma(valores.slice(n - ventana)), suma(valores.slice(n - ventana * 2, n - ventana)));
  }
  if (n >= 4) {
    const mitad = Math.floor(n / 2); // con n impar se descarta el día central
    return cierra("mitades", mitad, suma(valores.slice(n - mitad)), suma(valores.slice(0, mitad)));
  }
  return null;
}

/** Media móvil hacia atrás. `null` mientras no haya ventana entera detrás. */
export function mediaMovil(ranuras: readonly Ranura[], ventana: number): (number | null)[] {
  if (ventana < 1) return ranuras.map(() => null);
  let acc = 0;
  return ranuras.map((r, i) => {
    acc += r.valor;
    if (i >= ventana) acc -= ranuras[i - ventana]!.valor;
    return i >= ventana - 1 ? acc / ventana : null;
  });
}

/** Recorta la basura binaria dejando 12 cifras significativas, de sobra para un eje. */
const limpio = (x: number) => (x === 0 ? 0 : Number(x.toPrecision(12)));

/** El 1·2·5 de toda la vida: el paso "redondo" más cercano por arriba. */
function pasoBonito(bruto: number): number {
  if (!(bruto > 0) || !Number.isFinite(bruto)) return 1;
  const exp = Math.floor(Math.log10(bruto));
  const base = 10 ** exp;
  const n = bruto / base;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return m * base;
}

/**
 * Escala del eje Y con marcas redondas. Incluye SIEMPRE el cero: sin él, dos
 * días casi iguales se dibujan como el doble uno del otro.
 */
export function escalaBonita(min: number, max: number, objetivo = 4): Escala {
  const lo = Math.min(0, Number.isFinite(min) ? min : 0);
  const hi = Math.max(0, Number.isFinite(max) ? max : 0);
  if (lo === 0 && hi === 0) return { min: 0, max: 1, paso: 1, ticks: [0, 1] };

  const paso = pasoBonito((hi - lo) / Math.max(1, objetivo));
  const min2 = Math.floor(lo / paso) * paso;
  const max2 = Math.ceil(hi / paso) * paso;
  // Multiplicar en vez de ir sumando evita ACUMULAR el error; `limpio` remata lo
  // que la multiplicación sola no arregla (3 × 0,1 = 0,30000000000000004, que
  // acabaría impreso tal cual en el eje).
  const tramos = Math.max(1, Math.round((max2 - min2) / paso));
  const ticks: number[] = [];
  for (let i = 0; i <= tramos; i++) ticks.push(limpio(min2 + i * paso));
  return { min: limpio(min2), max: limpio(max2), paso, ticks };
}

/** Índices de las marcas del eje X: primera, última y un reparto regular. */
export function marcasEjeX(n: number, maximo: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const cuantas = Math.max(2, Math.min(maximo, n));
  const out = new Set<number>();
  for (let i = 0; i < cuantas; i++) out.add(Math.round((i * (n - 1)) / (cuantas - 1)));
  return [...out].sort((a, b) => a - b);
}
