import type { SavingsRequest } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// EL TOPE DE SALIDA DE UNA PETICIÓN, DICHO EN UN SOLO SITIO.
// ═══════════════════════════════════════════════════════════════════════════
//
// Hay dos sitios donde el cliente puede fijarlo:
//
//   · `request.maxOutputTokens` — el de la PETICIÓN. Es el único que tiene una
//     petición de texto libre: `OutputContract` exige `schema`, así que antes no
//     había manera de acotar la salida sin declarar un contrato.
//   · `request.response.maxOutputTokens` — el del CONTRATO, el de siempre.
//
// Con los dos, manda el MENOR. Los dos son del cliente y los dos son techos: una
// respuesta que respete el menor respeta los dos, y cualquier otra regla
// incumpliría uno de ellos. Con uno solo, ese. Con ninguno, `undefined` y el
// comportamiento es byte a byte el de antes (Anthropic manda su 4096 por
// defecto, Chat Completions no manda nada).
//
// Puro y SIN reexportar por ningún barril: el pipeline, los lotes, el brazo sin
// capa y el exportador de OTel lo leen de aquí para que no puedan divergir.

/** El tope de salida EFECTIVO que viaja al proveedor, o `undefined` si el cliente no fijó ninguno. */
export function topeDeSalida(request: SavingsRequest): number | undefined {
  const dePeticion = request.maxOutputTokens;
  const delContrato = request.response?.maxOutputTokens;
  if (dePeticion == null) return delContrato ?? undefined;
  if (delContrato == null) return dePeticion;
  return Math.min(dePeticion, delContrato);
}

/**
 * La salida que se ESTIMA para una llamada que se evita sin contador de
 * referencia (y para el cálculo de si compensa el descubrimiento de
 * herramientas).
 *
 * Antes era `response.maxOutputTokens ?? 256`, y así sigue cuando no hay tope
 * de petición: nada cambia para quien no lo usa. El tope de PETICIÓN solo puede
 * BAJAR esa cifra, nunca subirla. Es un techo que pone el cliente, no una
 * expectativa de lo que se habría generado, así que no puede convertirse en
 * ahorro acreditado: con `maxOutputTokens: 100000` en texto libre, una llamada
 * evitada se seguiría estimando a 256 como mucho, no a 100 000.
 */
export function salidaEstimadaDeReferencia(request: SavingsRequest): number {
  const base = request.response?.maxOutputTokens ?? 256;
  const dePeticion = request.maxOutputTokens;
  return dePeticion == null ? base : Math.min(base, dePeticion);
}

/**
 * Comprueba el tope de petición. Un valor que no sea un entero positivo es un
 * error de quien llama —el proveedor contestaría 400 igual—, y se dice aquí, en
 * claro y antes de gastar nada, en vez de dejar que llegue al cable.
 */
export function comprobarTopeDePeticion(request: SavingsRequest): void {
  const v = request.maxOutputTokens;
  if (v === undefined) return;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new TypeError(
      `[bvsala] request.maxOutputTokens must be a positive integer (got ${String(v)}).`,
    );
  }
}
