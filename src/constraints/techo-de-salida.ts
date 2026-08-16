import type { JsonSchema } from "../contracts/types.js";

/**
 * CUÁNTO OCUPA LA MAYOR RESPUESTA QUE UN CONTRATO AUTORIZA.
 *
 * `maxOutputTokens` y las restricciones del esquema hablan de la misma
 * respuesta en dos unidades distintas: el tope cuenta TOKENS y `maxLength`
 * cuenta CARACTERES. Los caracteres no dependen del modelo; los tokens sí, y
 * bastante — el mismo JSON de 791 caracteres mide 162 tokens con o200k_base y
 * 235 con el estimador de esta casa. Un contrato cuyo tope se fijó mirando un
 * tokenizador queda calibrado SOLO para ese tokenizador, y el margen que le
 * quedaba a otro se descubre cortando respuestas por la mitad.
 *
 * Eso es exactamente lo que pasó en la tirada del 2026-08-16: el contrato
 * `demo-answer:v1` del banco autoriza 400 caracteres de `answer` más tres
 * referencias de 120 —791 caracteres de JSON en total— con un tope de 180
 * tokens. Con la familia GPT cabía (162 tokens, un 11% de margen); con
 * `claude-sonnet-4-5` no, y el escenario falló 8 de 8, lo que dejó la tirada
 * entera en NO PROBADA.
 *
 * Este módulo construye la mayor instancia que el esquema admite y la deja
 * contar por el tokenizador del modelo de destino. Sirve para dos cosas, y las
 * dos importan:
 *
 *   · el banco fija el tope de sus contratos EN FUNCIÓN del esquema, así que
 *     "subir el tope hasta que apruebe" deja de ser posible: para subirlo hay
 *     que ensanchar el esquema, que es cambiar lo que el contrato promete;
 *   · la capa puede decirle al cliente CUÁL de los dos cambiar cuando una
 *     respuesta se corta, en vez de dejarle la aritmética a él.
 *
 * DEVUELVE `null` CUANDO EL ESQUEMA NO ACOTA. Una cadena sin `maxLength`, un
 * array sin `maxItems` o un objeto que admite propiedades extra pueden crecer
 * sin límite, y ahí no hay cifra honesta que dar: es preferible callar a
 * publicar un número inventado que alguien use como tope.
 */

/**
 * Prosa de relleno, en inglés corriente y sin comillas ni barras (escaparlas
 * inflaría el JSON con caracteres que ningún modelo escribiría).
 *
 * La cuenta que sale de aquí es la de una respuesta REPRESENTATIVA que use todo
 * su presupuesto, no la del peor caso teórico: el peor caso de un tokenizador
 * BPE es un token por carácter, y un tope dimensionado así sería cuatro veces lo
 * que hace falta. Y tampoco vale rellenar con una letra repetida: el BPE funde
 * las tiradas largas y `aaaa...` sale casi diez veces más barato que texto real,
 * o sea que mediría de menos justo donde duele.
 */
const PROSA =
  "the layer measures both worlds against the same provider so that no baseline " +
  "can be fabricated, keeps one ledger per lever, and refuses to publish a saving " +
  "whose answer got worse along the way, because a number nobody can check is not " +
  "a number at all but a promise, and this product exists to stop making those. ";

function relleno(caracteres: number): string {
  if (caracteres <= 0) return "";
  let texto = PROSA;
  while (texto.length < caracteres) texto += PROSA;
  return texto.slice(0, caracteres);
}

/** El valor más largo de un `enum`, medido ya serializado. */
function mayorDelEnum(valores: readonly unknown[]): unknown {
  let mejor = valores[0];
  let largo = -1;
  for (const v of valores) {
    const n = JSON.stringify(v)?.length ?? 0;
    if (n > largo) {
      largo = n;
      mejor = v;
    }
  }
  return mejor;
}

/** `undefined` = el esquema no acota este nodo. */
function mayorValor(s: JsonSchema): { valor: unknown } | undefined {
  if (s.enum && s.enum.length > 0) return { valor: mayorDelEnum(s.enum) };

  const tipo = s.type ?? (s.properties ? "object" : s.items ? "array" : undefined);
  switch (tipo) {
    case "string":
      return s.maxLength != null ? { valor: relleno(s.maxLength) } : undefined;
    case "boolean":
      // `false` es un carácter más largo que `true`, y aquí se busca el máximo.
      return { valor: false };
    case "null":
      return { valor: null };
    case "integer":
      // Un entero acotado ocupa, como mucho, los dígitos de su cota.
      return s.maximum != null ? { valor: Math.trunc(s.maximum) } : undefined;
    case "number":
      // Sin acotar: `maximum: 1` sigue admitiendo 0.9999999999999 y la longitud
      // del texto no la fija nadie. Un entero sí; un decimal no.
      return undefined;
    case "array": {
      if (s.maxItems == null || !s.items) return undefined;
      const item = mayorValor(s.items);
      if (!item) return undefined;
      return { valor: Array.from({ length: s.maxItems }, () => item.valor) };
    }
    case "object": {
      // Con propiedades libres el objeto crece sin límite: el máximo no existe.
      if (s.additionalProperties !== false || !s.properties) return undefined;
      const salida: Record<string, unknown> = {};
      for (const [clave, sub] of Object.entries(s.properties)) {
        // TODAS las propiedades, no solo las obligatorias: la mayor respuesta
        // que el contrato autoriza las trae todas.
        const v = mayorValor(sub);
        if (!v) return undefined;
        salida[clave] = v.valor;
      }
      return { valor: salida };
    }
    default:
      return undefined;
  }
}

/**
 * La mayor respuesta que el esquema admite, ya serializada como la escribiría el
 * modelo. `null` si el esquema no la acota.
 */
export function mayorRespuestaQueAdmite(schema: JsonSchema): string | null {
  const v = mayorValor(schema);
  if (!v) return null;
  return JSON.stringify(v.valor);
}

/**
 * Lo mismo, en tokens del modelo de destino. `null` si el esquema no acota.
 *
 * El contador se recibe en vez de resolverse aquí porque la unidad es de cada
 * modelo: contar con el tokenizador equivocado es precisamente el fallo que este
 * módulo existe para evitar.
 */
export function tokensDeLaMayorRespuesta(
  schema: JsonSchema,
  contar: (texto: string) => number,
): number | null {
  const texto = mayorRespuestaQueAdmite(schema);
  return texto === null ? null : contar(texto);
}
