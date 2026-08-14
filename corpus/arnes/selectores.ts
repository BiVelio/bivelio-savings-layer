/**
 * EL CONTRATO DEL SELECTOR, y el selector trivial que hay hoy.
 *
 * El knapsack de evidencia (F6) no está escrito. Este fichero fija el enchufe
 * al que se conectará cuando lo esté, para que la verja exista ANTES que el
 * algoritmo: un criterio de aceptación escrito después del código es un
 * criterio ajustado al código.
 *
 * ─── LA ENTRADA ESTÁ LIMPIA, Y ESO ES LA MITAD DEL ARNÉS ────────────────────
 *
 * Un selector recibe `EntradaDelSelector` y NADA más. No ve `papel`, ni
 * `necesarias`, ni `citas`, ni la respuesta. Es exactamente lo que verá en
 * producción —una consulta, unos trozos recuperados y un presupuesto— y es lo
 * que impide que un selector apruebe leyendo la chuleta.
 *
 * No es una precaución teórica: `corpus/auditoria/lineas-base.ts` le pasa el
 * `CasoVista` entero a cada línea base, así que su `oraculo` puede mirar los
 * papeles. Ahí está bien, porque el oráculo existe precisamente para acreditar
 * que toda selección correcta existe. Aquí no: aquí se puntúa a un candidato, y
 * un candidato que puede leer la solución no se puede puntuar.
 *
 * ─── POR DEFECTO SE MANDA TODO ──────────────────────────────────────────────
 *
 * `mandarloTodo` conserva por construcción todo lo que hay que conservar, así
 * que la verja pasa hoy — y ahorra exactamente CERO tokens, así que el informe
 * lo dice en la única columna que importa. Las dos mitades son necesarias: sin
 * la primera no hay verja que enchufar a F6; sin la segunda, «aprobar» sería
 * gratis y la calidad no se podría comparar contra el ahorro.
 */

import type { CasoDelArnes } from "./cargar.js";

/** Un trozo recuperado, tal y como lo ve el selector: sin papel y sin marcas. */
export interface UnidadParaSeleccionar {
  readonly id: string;
  readonly texto: string;
  /** Posición en la que llega del recuperador. 0-indexada. */
  readonly orden: number;
}

/** Todo lo que un selector puede saber de un caso. */
export interface EntradaDelSelector {
  readonly casoId: string;
  readonly idioma: "es" | "ca";
  readonly dominio: string;
  readonly consulta: string;
  readonly unidades: readonly UnidadParaSeleccionar[];
  /** Cuántas unidades caben como mucho. Siempre menos de las que hay. */
  readonly presupuestoMax: number;
}

/** Lo que F6 tendrá que ser: de la entrada a los ids que se mandan al modelo. */
export type Selector = (entrada: EntradaDelSelector) => readonly string[];

/**
 * Un selector con acceso al caso entero. Solo para oráculos y para MUTANTES:
 * lo que se puntúa como candidato pasa siempre por `conEntradaLimpia`.
 */
export type SelectorConChuleta = (caso: CasoDelArnes) => readonly string[];

/** Quita del caso todo lo que un selector no puede ver. */
export function entradaDelCaso(caso: CasoDelArnes): EntradaDelSelector {
  return {
    casoId: caso.id,
    idioma: caso.idioma,
    dominio: caso.dominio,
    consulta: caso.consulta,
    unidades: caso.unidades.map((u) => ({ id: u.id, texto: u.texto, orden: u.orden })),
    presupuestoMax: caso.presupuestoMax,
  };
}

/** Envuelve un selector honesto para que el arnés pueda correrlo sobre casos. */
export function conEntradaLimpia(selector: Selector): SelectorConChuleta {
  return (caso) => selector(entradaDelCaso(caso));
}

/**
 * La implementación por defecto: mandarlo todo.
 *
 * Conserva el 100 % de los campos críticos y de las citas, se sale del
 * presupuesto en los 150 casos y ahorra 0 tokens. Es el punto de partida contra
 * el que F6 tiene que ganar tokens SIN perder ninguna de las dos primeras
 * cifras.
 */
export const mandarloTodo: Selector = (entrada) => entrada.unidades.map((u) => u.id);

/**
 * Las `k` primeras, con `k` el presupuesto. No es un candidato serio: está aquí
 * porque es lo que escribe todo el mundo la primera vez, cabe en el
 * presupuesto, y sirve para comprobar que el arnés SÍ suspende a un selector
 * que tira lo que no debe. La auditoría ya midió cuánto saca (30,7 %).
 */
export const lasPrimerasK: Selector = (entrada) =>
  [...entrada.unidades]
    .sort((a, b) => a.orden - b.orden)
    .slice(0, entrada.presupuestoMax)
    .map((u) => u.id);
