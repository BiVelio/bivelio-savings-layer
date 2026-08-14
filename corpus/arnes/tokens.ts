/**
 * LOS TOKENS DE UNA SELECCIÓN — la mitad de la comparación que importa.
 *
 * Una verja que solo mida calidad la aprueba `mandarloTodo`, que es el peor
 * selector posible: conserva el 100 % de todo y no ahorra nada. Sin la columna
 * de tokens, «el knapsack conserva los campos críticos» es una frase que un
 * `map` cumple. Con ella, la única pregunta que decide F6 se puede formular:
 * ¿cuánto ahorra, y a costa de qué?
 *
 * ─── SE CUENTA EL TEXTO DE LAS UNIDADES, NO EL PROMPT ───────────────────────
 *
 * La consulta, las instrucciones y el andamiaje del prompt viajan siempre: no
 * son objetos del knapsack y meterlos en el denominador diluiría el ahorro
 * medido hasta hacerlo incomparable entre casos. Lo que se mide aquí es la
 * fracción del CONTEXTO RECUPERADO que dejó de enviarse, que es exactamente lo
 * que decide la palanca.
 *
 * ─── ES UNA ESTIMACIÓN, Y VA MARCADA COMO TAL ───────────────────────────────
 *
 * Por defecto cuenta `HeuristicEstimator` (`src/tokenizer/estimator.ts`), que
 * declara `exact: false`: aproxima ~4 caracteres por token y cobra cada símbolo
 * suelto como un token entero. Vale para comparar dos selecciones del MISMO
 * texto —que es todo lo que hace falta aquí, porque las dos se cuentan con la
 * misma regla— y no vale para publicar una cifra de ahorro contra una factura.
 * El informe arrastra `exacto: false` hasta la última línea a propósito: en
 * este producto una cifra estimada que se presenta como medida es la clase
 * exacta de mentira que no se cuenta. Quien tenga `gpt-tokenizer` puede pasar
 * un `ExactTokenizer` y la marca sube sola.
 */

import { HeuristicEstimator, type TokenEstimator } from "../../src/tokenizer/estimator.js";
import type { CasoDelArnes } from "./cargar.js";

/**
 * El contador por defecto. Determinista y sin dependencias, para que la cifra
 * del informe no cambie según lo que tenga instalado quien lo corre.
 */
export const CONTADOR_POR_DEFECTO: TokenEstimator = new HeuristicEstimator("corpus-heuristico");

export interface CuentaDeTokens {
  /** Todo el contexto recuperado del caso. Es el denominador del ahorro. */
  totales: number;
  /** Lo que el selector deja pasar. */
  enviados: number;
  /** `totales - enviados`. Nunca negativo: una selección no puede inventar texto. */
  ahorrados: number;
  /** `ahorrados / totales`. 0 = no ahorró nada. */
  fraccionAhorrada: number;
  /** ¿La cuenta comparte regla con la que factura un proveedor? Con el heurístico, no. */
  exacto: boolean;
}

/** Cuántos tokens ocupa el contexto recuperado de un caso, entero. */
export function tokensDelCaso(caso: CasoDelArnes, contador: TokenEstimator): number {
  let n = 0;
  for (const u of caso.unidades) n += contador.count(u.texto);
  return n;
}

/** Lo que una selección cuesta y lo que ahorra, en tokens. */
export function contarTokens(
  caso: CasoDelArnes,
  seleccion: ReadonlySet<string>,
  contador: TokenEstimator = CONTADOR_POR_DEFECTO,
): CuentaDeTokens {
  let totales = 0;
  let enviados = 0;
  for (const u of caso.unidades) {
    const n = contador.count(u.texto);
    totales += n;
    if (seleccion.has(u.id)) enviados += n;
  }
  const ahorrados = totales - enviados;
  return {
    totales,
    enviados,
    ahorrados,
    fraccionAhorrada: totales === 0 ? 0 : ahorrados / totales,
    exacto: contador.exact,
  };
}
