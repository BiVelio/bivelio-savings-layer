import { buscarPorModelo, clavesPorLongitud } from "../pricing/catalogo.js";

/**
 * DE DÓNDE SALE EL DELTA DE SALIDA DEL CODEBOOK, que es la cifra que decide si
 * la palanca gana o pierde dinero.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA LECCIÓN, ANTES QUE EL CÓDIGO: UNA TIRADA CONTRA UN SOLO MODELO NO ES UN
 * RESULTADO. La primera medición del codebook se hizo contra `gpt-4o-mini` y
 * salió −8,2 %; la conclusión que se sacó de ella —«esta palanca pierde dinero,
 * hay que retirarla»— sobrevivió exactamente hasta la segunda tirada, contra
 * `gpt-4o`, que salió +8,0 % con el intervalo despejando cero. Mismo escenario,
 * misma capa, mismos 8 pares.
 *
 *     modelo         brazo A (sin capa)   brazo B (codebook)   delta salida   neto
 *     gpt-4o-mini        184 / 72            158 / 88             −16          −8,2 %
 *     gpt-4o             184 / 75            158 / 72              +3          +8,0 %
 *
 * La ENTRADA baja igual en los dos (184 → 158, −26 tokens): eso es determinista,
 * es el esquema compacto y se puede calcular sin llamar a nadie. Lo que cambia
 * de SIGNO es la salida. La lectura es que un modelo pequeño pierde guía
 * semántica con nombres de campo cortos (`"d"` en vez de `"decision"`) y rellena
 * más, y uno grande no. Es una propiedad DEL MODELO, no del esquema.
 *
 * POR ESO NINGUNA AFIRMACIÓN SOBRE EL CODEBOOK VALE SIN EL MODELO PEGADO, y por
 * eso este fichero existe: para que la cifra que decide venga siempre con su
 * procedencia y su fecha, y no de una intuición sobre «esquemas compactos».
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * POR QUÉ ESTO NO SE APRENDE SOLO EN EL CAMINO CALIENTE, que es la pregunta
 * obvia mirando a las otras tres verjas con memoria de la capa
 * (`contratosQueIncumplen`, `VerjaDeCacheDePrefijo`, `VerjaDeCascada`). Las tres
 * aprenden de algo que UNA petición REVELA por sí sola: una validación que
 * falla, un `cache_read_input_tokens` que vuelve, un veredicto que rechaza. El
 * delta del codebook no es observable así: es un CONTRAFACTUAL —cuántos tokens
 * habría escrito el modelo con el contrato largo— y la petición que se envía con
 * el contrato compacto no lo contesta.
 *
 * Aprenderlo en producción exigiría reservar un brazo de control y comparar
 * MEDIAS entre peticiones DISTINTAS. La varianza de longitud entre prompts
 * distintos es fácilmente ±50 %; el efecto que hay que resolver es ±20 % y el
 * margen que decide, ±7 % (ver el delta de equilibrio en `codebook.ts`). Con 8
 * muestras por brazo el error típico de la diferencia de medias ronda el 25 %:
 * más grande que el propio efecto. Harían falta cientos de peticiones por
 * contrato, perdiendo dinero en la mitad de ellas mientras tanto, y en un
 * contrato de tráfico modesto no converge nunca.
 *
 * El instrumento que SÍ tiene potencia es el A/B PAREADO sobre el mismo prompt,
 * que elimina justo esa varianza y resuelve el signo en 8 pares. Ese instrumento
 * existe y no está en el camino caliente: `benchmarks/ab-live.ts`. Así que la
 * medición se hace ahí y ENTRA por aquí, en vez de fabricarse mal en producción.
 */

/** Cuándo se midieron los deltas de este catálogo, contra el proveedor real. */
export const DELTAS_AL_DIA = "2026-08-14";

/**
 * Un delta de salida MEDIDO, con lo que hace falta para poder releerlo.
 *
 * Las tres cifras de contexto no son adorno: sin ellas, `-16` es un número sin
 * unidades sobre el que nadie puede decidir si le aplica. Con ellas se ve que se
 * midió sobre respuestas de ~72-75 tokens y sobre un contrato de triaje, y quien
 * tenga respuestas de 500 sabe que este número no es el suyo.
 */
export interface DeltaMedido {
  /**
   * Tokens de salida que el codebook AHORRA, medidos. Positivo = con el contrato
   * compacto el modelo escribió MENOS. Negativo = escribió MÁS.
   */
  deltaTokens: number;
  /** Tokens de salida del brazo SIN capa: la talla sobre la que se midió. */
  salidaDelBrazoA: number;
  /** Qué contrato se midió. Un delta de un contrato no es el de otro. */
  contrato: string;
  /** Repeticiones pareadas. Sin esto, `deltaTokens` es una anécdota. */
  pares: number;
}

/**
 * LO QUE BIVELIO HA MEDIDO, por modelo. Mismo criterio que
 * `pricing/catalogo.ts`: aquí entra solo lo MEDIDO, y lo que no está no se
 * inventa — se queda sin dato y la palanca no se aplica, que es la respuesta
 * honesta.
 *
 * ⚠️ CADA ENTRADA SE MIDIÓ SOBRE UN SOLO CONTRATO. Aplicarla a otro contrato del
 * mismo modelo es una extrapolación, y consta como tal: la verja de dinero de
 * `codebook.ts` la vuelve a pasar por la aritmética del contrato de verdad —el
 * ahorro de esquema se cuenta con el esquema REAL— y un delta negativo apaga la
 * palanca sin que ningún esquema pueda comprarla de vuelta. Quien tenga tráfico
 * propio debería medirlo y pasarlo en la petición: eso gana siempre a esta tabla.
 */
export const DELTAS_DE_SALIDA_MEDIDOS: Readonly<Record<string, DeltaMedido>> = {
  // ── OpenAI ────────────────────────────────────────────────────────────────
  // El pequeño rellena: 72 → 88 tokens de salida con el contrato compacto.
  "gpt-4o-mini": { deltaTokens: -16, salidaDelBrazoA: 72, contrato: "triage (6 fields, long enums)", pares: 8 },
  // El grande no: 75 → 72. El intervalo del 95 % de la tirada despeja cero.
  "gpt-4o": { deltaTokens: 3, salidaDelBrazoA: 75, contrato: "triage (6 fields, long enums)", pares: 8 },

  // Los modelos que NO se han medido se quedan fuera A PROPÓSITO. Rellenarlos
  // «por familia» es exactamente el error que este fichero documenta: `gpt-4o` y
  // `gpt-4o-mini` son la misma familia, comparten tarifa relativa (salida 4x
  // entrada) y dan resultados de SIGNO OPUESTO.
};

const CLAVES = clavesPorLongitud(DELTAS_DE_SALIDA_MEDIDOS);

/** El delta medido por BiVelio para un modelo, o `undefined` si no se midió. */
export function deltaMedidoDeLista(model: string): DeltaMedido | undefined {
  return buscarPorModelo(DELTAS_DE_SALIDA_MEDIDOS, CLAVES, model);
}

/** De dónde salió el delta con el que se decidió. Va a la traza tal cual. */
export type OrigenDelDelta = "caller" | "remembered" | "catalogue";

export interface EvidenciaDelCodebook {
  deltaTokens: number;
  origen: OrigenDelDelta;
  /** Frase publicable con la procedencia. Nunca vacía. */
  procedencia: string;
}

/**
 * Memoria del delta de salida, POR MODELO Y POR CONTRATO.
 *
 * LA CLAVE LLEVA EL MODELO, y ése es todo el punto de este objeto: el mismo
 * contrato contra `gpt-4o` y contra `gpt-4o-mini` tiene deltas de signo opuesto,
 * así que una memoria indexada solo por contrato —como
 * `contratosQueIncumplen`— guardaría el dato de un modelo y lo aplicaría al
 * otro. Ahí se pierde exactamente el 8 % en el sentido malo.
 *
 * Vive en la instancia y en memoria, por lo mismo que las otras verjas con
 * memoria: lo que guarda es una MEDICIÓN, y una medición hay que acumularla
 * entre peticiones. No se persiste porque no lo necesita — lo único que la
 * llena hoy es la medición que trae el llamante, así que reaprender cuesta
 * cero: la siguiente petición que la traiga la vuelve a dejar puesta.
 */
export class MemoriaDelCodebook {
  private readonly deltas = new Map<string, number>();

  /**
   * LA CLAVE LLEVA EL MODELO DELANTE Y UN SEPARADOR QUE NO PUEDE APARECER EN
   * NINGUNO DE LOS DOS. Los identificadores de modelo llevan `/`, `-`, `.` y
   * `_`, y los de contrato llevan `:` y `/`: concatenarlos con cualquiera de
   * esos haria que `a/b` + `c` y `a` + `b/c` colisionaran, y una colision aqui
   * aplica el delta de un modelo al de al lado — que es exactamente el error
   * de 8 puntos que esta memoria existe para no cometer.
   */
  private static clave(model: string, contrato: string): string {
    return `${model}\u0000${contrato}`;
  }

  /** Apunta lo que el llamante MIDIÓ para este par modelo/contrato. */
  recordar(model: string, contrato: string, deltaTokens: number): void {
    this.deltas.set(MemoriaDelCodebook.clave(model, contrato), deltaTokens);
  }

  /**
   * El delta con el que hay que decidir esta petición, y de dónde sale.
   *
   * EL ORDEN ES EL CONTRATO, de lo más específico a lo menos:
   *
   *  1. Lo que MIDIÓ el llamante, en esta petición. Es su modelo, su contrato y
   *     sus prompts: gana a todo lo demás, y de paso se recuerda.
   *  2. Lo que midió en una petición ANTERIOR del mismo par. Para que no tenga
   *     que repetir la cifra en cada llamada.
   *  3. Lo que midió BiVelio para ese MODELO. Es una extrapolación entre
   *     contratos y se declara como tal en la traza.
   *  4. Nada. Y sin dato no se aplica: ver `planOutputCodebook`.
   */
  resolver(model: string, contrato: string, delLlamante?: number): EvidenciaDelCodebook | null {
    if (delLlamante != null && Number.isFinite(delLlamante)) {
      this.recordar(model, contrato, delLlamante);
      return {
        deltaTokens: delLlamante,
        origen: "caller",
        procedencia: `measured by the caller for this contract on ${model}`,
      };
    }

    const recordado = this.deltas.get(MemoriaDelCodebook.clave(model, contrato));
    if (recordado != null) {
      return {
        deltaTokens: recordado,
        origen: "remembered",
        procedencia: `measured by the caller on an earlier request for this contract on ${model}`,
      };
    }

    const deLista = deltaMedidoDeLista(model);
    if (deLista) {
      return {
        deltaTokens: deLista.deltaTokens,
        origen: "catalogue",
        procedencia:
          `measured by BiVelio on ${model} (${DELTAS_AL_DIA}, ${deLista.pares} paired reps, ` +
          `${deLista.contrato}, ${deLista.salidaDelBrazoA}-token answers) — NOT measured on YOUR contract`,
      };
    }
    return null;
  }
}
