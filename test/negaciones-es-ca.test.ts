import { describe, expect, it } from "vitest";

import { keyTokensMatch } from "../src/cache/semantic.js";

/**
 * LA VERJA DE NEGACIÓN, EN LOS TRES IDIOMAS CON TRÁFICO.
 *
 * `keyTokensMatch` es lo único que separa a la caché semántica de su pecado
 * capital: servir con confianza la respuesta de una pregunta PARECIDA pero
 * DISTINTA. Un embedding es ciego a la negación —el coseno se queda por encima
 * de 0,95 entre «seguro» y «NO seguro»—, así que si esta verja no corta, nadie
 * corta.
 *
 * La lista era solo inglesa. En castellano y catalán funcionaba con «no» por
 * casualidad (la palabra coincide con la inglesa) y fallaba con todas las demás,
 * agravado porque `sin` y `sense` estaban entre las palabras VACÍAS: ni contaban
 * como negación ni entraban en el solapamiento.
 *
 * Estos casos son de regresión: cada uno pasaba la verja antes del arreglo.
 */
describe("paridad de negación en es/ca", () => {
  const debeCortar: [string, string, string][] = [
    ["sin/con (es)", "resume el informe sin los datos personales", "resume el informe con los datos personales"],
    ["nunca (es)", "es seguro tomar aspirina", "nunca es seguro tomar aspirina"],
    ["jamas (es)", "el sistema acepta pagos", "el sistema jamas acepta pagos"],
    ["tampoco (es)", "el plan cubre esta prueba", "el plan tampoco cubre esta prueba"],
    ["ningun (es)", "hay riesgo de interaccion", "no hay ningun riesgo de interaccion"],
    ["nadie (es)", "alguien reviso el contrato", "nadie reviso el contrato"],
    ["sense/amb (ca)", "factura sense IVA per al client", "factura amb IVA per al client"],
    ["mai (ca)", "aquest medicament es segur", "aquest medicament mai es segur"],
    ["tampoc (ca)", "el pla cobreix aquesta prova", "el pla tampoc cobreix aquesta prova"],
    ["no (es) — ya funcionaba", "el contrato incluye clausula de rescision", "el contrato no incluye clausula de rescision"],
    ["not (en) — ya funcionaba", "is aspirin safe", "is aspirin not safe"],
  ];

  it.each(debeCortar)("corta %s", (_nombre, a, b) => {
    expect(keyTokensMatch(a, b)).toBe(false);
  });

  // La verja solo debe cortar cuando el SIGNIFICADO cambia. Una paráfrasis con
  // las MISMAS negaciones tiene que seguir acertando, o el arreglo se habría
  // llevado por delante el ahorro en los dos idiomas que más tráfico traen.
  const debePasar: [string, string, string][] = [
    ["cortesía (es)", "resume este informe", "por favor resume este informe"],
    ["orden (es)", "cual es la capital de francia", "capital de francia cual es"],
    ["negación en AMBAS (es)", "factura sin iva del cliente", "la factura sin iva del cliente"],
    ["negación en AMBAS (ca)", "factura sense iva del client", "la factura sense iva del client"],
    ["cortesía (ca)", "resumeix aquest informe", "sisplau resumeix aquest informe"],
  ];

  it.each(debePasar)("deja pasar %s", (_nombre, a, b) => {
    expect(keyTokensMatch(a, b)).toBe(true);
  });
});
