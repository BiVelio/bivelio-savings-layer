/**
 * MEDIA RESPUESTA NO ES UNA RESPUESTA, Y NINGÚN `expect` DE ESCENARIO LO VE.
 * ---------------------------------------------------------------------------
 * Tirada del 2026-08-16, escenario «Forwarded support thread (compression)»
 * contra `claude-sonnet-4-5`:
 *
 *     brazo A   5684 entrada / 500 salida
 *     brazo B   3035 entrada / 500 salida     ahorro 32,4%   calidad 0/8
 *
 * Los DOS brazos salieron con EXACTAMENTE los 500 tokens del tope, o sea
 * cortados. El 32,4% es dinero medido sobre respuestas rotas, y la fila no lo
 * decía: había que deducirlo comparando dos columnas de un CSV y darse cuenta de
 * que el número de salida coincidía con el tope. «calidad 0/8» se lee como «la
 * capa empeoró la respuesta», que es una acusación distinta y falsa.
 *
 * Y hay un agujero peor, que es el que obliga a que esto sea una verja y no un
 * adorno del informe: un escenario SIN contrato de salida —«Big tool catalogue»
 * es uno, a propósito y con motivo— pasa la verja con `r.text.trim().length > 0`.
 * Un texto cortado a media frase tiene longitud > 0. Así que ese escenario puede
 * truncar las ocho repeticiones, aprobar 8/8 y publicar su ahorro como PROBADO
 * sobre media respuesta.
 *
 * Es exactamente el agujero que el pipeline ya cerró un nivel más abajo para la
 * escritura en caché, y por la misma puerta: «una petición SIN esquema sale con
 * `structurallyValid` en true porque no hay nada que validar, así que el truncado
 * no lo veía nadie». Allí se cerró mirando lo único que no admite discusión —lo
 * dice el proveedor con `finish_reason: "length"`— y aquí se cierra igual.
 *
 * El veto va DELANTE de la evaluación, no detrás, y eso también es dinero: la
 * verja en vivo puede llamar a un juez, y pagar un juez para que dictamine sobre
 * una respuesta que sabemos cortada es gasto sobre una pregunta ya contestada.
 * `veredictoDeCalidad` es la única forma de que ese orden no se pueda invertir
 * por descuido: quien quiera evaluar tiene que pasar por aquí.
 */

/** La etiqueta con la que el informe nombra este fallo. No es «regresión». */
export const VERJA_TRUNCADO = "truncated";

/**
 * Lo que el proveedor dice cuando fue ÉL quien cortó, en el vocabulario neutro
 * de la capa (`stop_reason: "max_tokens"` de Anthropic se traduce a esto).
 */
export function cortadaPorElTope(finishReason: string | null | undefined): boolean {
  return finishReason === "length";
}

export interface Veredicto {
  passed: boolean;
  gate: string;
}

/**
 * El veredicto de calidad de UNA repetición, con el veto por truncado delante.
 *
 * `evaluar` es la verja normal del banco (ground-truth del escenario, juez o
 * estructural) y NO SE LLAMA cuando la respuesta salió cortada: el resultado ya
 * se conoce y evaluarla costaría una llamada al juez para confirmar lo que el
 * proveedor ya declaró.
 */
export async function veredictoDeCalidad(opts: {
  finishReason: string | null | undefined;
  evaluar: () => Promise<Veredicto>;
}): Promise<Veredicto> {
  if (cortadaPorElTope(opts.finishReason)) return { passed: false, gate: VERJA_TRUNCADO };
  return opts.evaluar();
}

/**
 * La línea que el informe imprime cuando algún brazo salió cortado.
 *
 * Dice CUÁNTAS y de QUÉ brazo, porque los dos casos significan cosas distintas:
 * cortarse en el brazo naive es un contrato mal dimensionado para la tarea (el
 * cliente lo tendría igual sin nosotros), y cortarse en el nuestro además dice
 * que la capa no consiguió evitarlo.
 */
export function avisoDeTruncado(filas: readonly { name: string; truncated: { naive: number; optimizado: number } }[]): string | null {
  const cortadas = filas.filter((f) => f.truncated.naive > 0 || f.truncated.optimizado > 0);
  if (cortadas.length === 0) return null;
  const detalle = cortadas
    .map((f) => `    · ${f.name}: A ${f.truncated.naive}, B ${f.truncated.optimizado}`)
    .join("\n");
  return (
    "\n⚠ RESPUESTAS CORTADAS POR EL TOPE (`finish_reason: \"length\"`). El ahorro de estas filas es\n" +
    "  dinero medido sobre media respuesta, no sobre una respuesta: NO es un ahorro. Y no es una\n" +
    "  regresión de calidad de la capa — es un contrato que no cabe, o un modelo que escribe por\n" +
    "  encima de lo que su propio esquema autoriza (ningún modo estructurado impone `maxLength`).\n" +
    detalle
  );
}
