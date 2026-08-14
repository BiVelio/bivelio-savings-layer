/**
 * La instrucción que sustituye al modo estructurado NATIVO cuando el proveedor
 * no lo puede dar para esta petición.
 *
 * Vive aparte de los dos adaptadores porque los dos la necesitan y tiene que ser
 * LA MISMA: es el texto que decide si el modelo entiende el contrato, y dos
 * redacciones distintas darían tasas de validación distintas según el proveedor
 * — una diferencia que luego se atribuiría al modelo. No se exporta desde
 * `providers/index.ts`: es un detalle interno, no superficie pública.
 *
 * El esquema tiene que VIAJAR igual: es lo único que guía al modelo cuando el
 * proveedor no lo va a imponer.
 *
 * Estos tokens los factura el proveedor y NO los ve la cuenta local del prompt
 * (`sentInputLocal`), porque los añade el adaptador. El sesgo va en la dirección
 * segura: `actualInput` sube, el baseline no, así que el ahorro publicado sale
 * MENOR del real. Nunca al revés, que es lo que no se podría tolerar.
 */
export function instruccionDeJsonPorPrompt(schema: unknown): string {
  return (
    "Respond with a single JSON object and nothing else: no prose, no explanation, " +
    "no markdown code fences. The object must validate against this JSON Schema:\n" +
    JSON.stringify(schema)
  );
}
