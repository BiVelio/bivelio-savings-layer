/**
 * El compresor que usa el banco. Local, determinista y sin red.
 *
 * POR QUÉ HACE FALTA UNO. La palanca `compression` del SDK exige un `compressor`
 * inyectado (`createSavingsLayer({ compressor })`) y el repo solo trae
 * `noopCompressor`, que por definición no quita nada. Sin uno, el escenario de
 * compresión no comprime y el banco publicaría un 0% que el lector leería como
 * "la compresión no ahorra" cuando lo que pasa es que no se ejecutó.
 *
 * POR QUÉ ESTE Y NO UN MODELO RESUMIENDO. Un compresor que llama a otro LLM
 * mete en la medición el coste y la latencia de ESE modelo, y sobre todo mete
 * una pérdida de información que ninguna verja de aquí sabe medir — el fallo que
 * `QualityStatus` documenta: la similitud se queda alta mientras desaparece una
 * cifra o una negación. Este quita ÚNICAMENTE líneas que ya están, palabra por
 * palabra, más arriba en el mismo texto. Una repetición literal no aporta
 * información: quitarla no puede perder un bit, y por eso el ahorro que mida el
 * banco es defendible sin juez ni umbral de similitud.
 *
 * ES LA FORMA DE TRÁFICO, no un truco: un hilo de soporte reenviado arrastra en
 * cada mensaje la misma ficha del pedido, el mismo pie de firma y el mismo aviso
 * legal. Es lo que un cliente pega de verdad en el contexto, y es donde vive la
 * redundancia que un compresor puede quitar sin discutir con nadie.
 *
 * LO QUE NO HACE, a propósito:
 *  · No toca líneas cortas. Un "ok", un "sí" o un "40218" repetidos pueden
 *    significar cosas distintas en sitios distintos; el mínimo de longitud deja
 *    fuera todo lo que pueda ser conversación y no plantilla.
 *  · No reescribe NADA. No quita palabras vacías, no acorta frases, no resume.
 *    Cada línea que sobrevive sale byte a byte como entró.
 *  · No mira los `system`: eso lo decide el pipeline, que nunca los comprime.
 */
import type {
  CompressionRequest,
  CompressionResult,
  Compressor,
} from "../src/index.js";

/**
 * Longitud mínima (caracteres, ya recortada) para que una línea repetida sea
 * candidata a desaparecer.
 *
 * Por debajo de esto una repetición es probablemente conversación ("de acuerdo",
 * "gracias", un número suelto) y no plantilla, y ahí la segunda aparición sí
 * puede significar algo distinto de la primera.
 */
export const MINIMO_DE_LINEA_REPETIDA = 24;

/**
 * Quita las líneas que ya aparecieron IDÉNTICAS antes en el mismo texto.
 *
 * `originalTokens`/`compressedTokens` van en caracteres a propósito: el
 * compresor no conoce el tokenizador del modelo de destino y fingir que sí sería
 * un número inventado en un informe que se lee como medido. Quien decide con
 * esto —el pipeline— vuelve a contar los dos textos con el tokenizador de verdad
 * antes de aplicar nada, así que estos dos campos son informativos y no entran
 * en ninguna cuenta de dinero.
 */
export const compresorDeRepeticionesLiterales: Compressor = {
  async compress(req: CompressionRequest): Promise<CompressionResult> {
    const lineas = req.text.split("\n");
    const vistas = new Set<string>();
    const salida: string[] = [];
    let quitadas = 0;

    for (const linea of lineas) {
      const clave = linea.trim();
      if (clave.length >= MINIMO_DE_LINEA_REPETIDA && vistas.has(clave)) {
        quitadas += 1;
        continue;
      }
      if (clave.length >= MINIMO_DE_LINEA_REPETIDA) vistas.add(clave);
      salida.push(linea);
    }

    const comprimido = salida.join("\n");
    // Sin repeticiones no se ha comprimido nada, y decirlo importa: el pipeline
    // trata `skipped` como "deja el mensaje tal cual", que es exactamente lo que
    // tiene que pasar. Devolver `skipped: false` con el texto intacto haría que
    // el informe contara una compresión que no ocurrió.
    if (quitadas === 0) {
      return {
        compressed: req.text,
        originalTokens: req.text.length,
        compressedTokens: req.text.length,
        protectedSpans: (req.protectedSpans ?? []).length,
        fidelityPassed: true,
        skipped: true,
        reason: "no verbatim repeated lines to drop",
      };
    }

    return {
      compressed: comprimido,
      originalTokens: req.text.length,
      compressedTokens: comprimido.length,
      protectedSpans: (req.protectedSpans ?? []).length,
      // La fidelidad no es una promesa: cada línea que sale es una línea que
      // entró, y cada línea que se va tiene un gemelo literal más arriba. No hay
      // reescritura de la que dudar.
      fidelityPassed: true,
      skipped: false,
      reason: `dropped ${quitadas} verbatim repeated lines`,
    };
  },
};
