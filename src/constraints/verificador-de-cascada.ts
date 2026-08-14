// EL VERIFICADOR DE LA CASCADA DE MODELOS. Determinista, local y gratis.
//
// Es la pieza de la que depende que la cascada exista. La aritmética está en
// `economics/cascada-de-modelos.ts`, y su conclusión es tajante: con un juez que
// cueste una llamada, el ahorro se evapora (juez barato → objetivo `0,5 − 2r`)
// o se vuelve imposible para cualquier P (juez fuerte → `r + 1 + P > 1`). Así
// que aquí no se llama a nadie. Se mira lo que ya se tiene.
//
// ⚠️ ESTO MIDE LA FORMA, NO EL SIGNIFICADO. `validate.ts` lo dice en su propio
// docstring y conviene repetirlo donde se toma la decisión: una respuesta del
// modelo barato con JSON impecable y contenido EQUIVOCADO pasa esta verja. Es el
// FALSO VÁLIDO, y no tiene solución en código —su firma es idéntica a la del
// éxito—. Lo que sí se hace:
//
//   · No se enruta NADA que no traiga contrato de salida. Sin contrato el
//     verificador acepta cualquier cosa, o sea que P(escalar) sale 0, el informe
//     enseña el ahorro máximo y NADIE ha comprobado una sola respuesta. Ésa es
//     la configuración en la que el fallo silencioso es seguro, no probable.
//   · Las herramientas de ESCRITURA hacen la petición inelegible entera. Este
//     repo ya se quemó con esa forma exacta de fallo («claro, la reenvío», la
//     factura no se reenvía, y el informe lo publica como éxito económico).
//   · El informe no publica jamás una «tasa de aceptación». Publica la de
//     ESCALADO, que es una cifra de dinero.

import type { JsonSchema, ToolDescriptor } from "../contracts/types.js";
import { validateAgainstSchema } from "./validate.js";

/**
 * Qué es capaz de comprobar la verja para ESTA petición.
 *
 * - `none`              no hay contrato de salida: no hay nada determinista que
 *                       mirar, y por tanto no se enruta.
 * - `structural`        el contrato fija claves y tipos. Se detecta un JSON roto,
 *                       una clave que falta o una de más — nada sobre el
 *                       CONTENIDO de los campos.
 * - `value-constrained` además hay al menos una restricción de VALOR (`enum`,
 *                       `pattern`, `maximum`, `maxLength`, `maxItems`…). Sigue
 *                       sin ser semántica, pero ya es la única forma barata que
 *                       existe de que un contenido equivocado tenga por dónde
 *                       caerse.
 */
export type FuerzaDelVerificador = "none" | "structural" | "value-constrained";

const CLAVES_DE_VALOR = [
  "enum",
  "pattern",
  "maximum",
  "minimum",
  "maxLength",
  "minLength",
  "maxItems",
  "minItems",
] as const;

/**
 * Recorre el esquema buscando restricciones de VALOR.
 *
 * `additionalProperties: false` NO cuenta como restricción de valor: es forma
 * (qué claves), no contenido. Contarla habría subido a `value-constrained` a
 * casi todos los contratos estrictos sin que la verja mirase un solo campo.
 */
export function fuerzaDelVerificador(schema: JsonSchema | undefined): FuerzaDelVerificador {
  if (!schema) return "none";
  return tieneRestriccionDeValor(schema) ? "value-constrained" : "structural";
}

function tieneRestriccionDeValor(schema: JsonSchema, profundidad = 0): boolean {
  // Un esquema patológicamente anidado no puede colgar el camino del cliente.
  if (profundidad > 12) return false;
  const s = schema as unknown as Record<string, unknown>;
  for (const clave of CLAVES_DE_VALOR) {
    if (s[clave] !== undefined) return true;
  }
  if (schema.properties) {
    for (const sub of Object.values(schema.properties)) {
      if (tieneRestriccionDeValor(sub, profundidad + 1)) return true;
    }
  }
  if (schema.items && tieneRestriccionDeValor(schema.items, profundidad + 1)) return true;
  return false;
}

/** Lo que hace falta saber de la petición para decidir si es enrutable. */
export interface ElegibilidadDeLaCascada {
  elegible: boolean;
  fuerza: FuerzaDelVerificador;
  razon: string;
}

/**
 * ¿Puede esta petición ir por la cascada, ANTES de mirar precios?
 *
 * Son las condiciones que no dependen del dinero, y todas son de seguridad:
 * quien las relaje está eligiendo servir respuestas sin verificar.
 */
export function elegibilidadDeLaCascada(opts: {
  schema: JsonSchema | undefined;
  tools: readonly ToolDescriptor[] | undefined;
}): ElegibilidadDeLaCascada {
  const fuerza = fuerzaDelVerificador(opts.schema);

  // LAS DE ESCRITURA HACEN INELEGIBLE LA PETICIÓN ENTERA, no solo la herramienta.
  // Un modelo barato que elige mal la acción no produce una respuesta mala: produce
  // una acción equivocada o ninguna, y eso el contrato de salida no lo ve — la
  // respuesta que acompaña a una tool call ni siquiera se valida (ver la etapa 11
  // del pipeline). O sea que en un turno de herramientas el verificador está
  // ciego, y estar ciego sobre una acción de escritura es exactamente el fallo
  // que este repo ya cometió una vez.
  const escritura = (opts.tools ?? []).filter(
    (t) => t.risk === "write" || t.risk === "destructive",
  );
  if (escritura.length > 0) {
    return {
      elegible: false,
      fuerza,
      razon:
        `the request carries ${escritura.length} write/destructive tool(s); a cheaper model's ` +
        `choice of ACTION cannot be checked by an output contract, so the cascade never applies here`,
    };
  }

  if (fuerza === "none") {
    return {
      elegible: false,
      fuerza,
      razon:
        "no output contract: the deterministic verifier would accept anything, which would report " +
        "a perfect escalation rate over answers nobody checked. Declare `response.schema` to route",
    };
  }

  return {
    elegible: true,
    fuerza,
    razon:
      fuerza === "value-constrained"
        ? "output contract carries value constraints, so wrong content has somewhere to fall"
        : "output contract checks shape only: a well-formed answer with wrong content passes",
  };
}

/** El veredicto sobre UNA respuesta del modelo barato. */
export interface VeredictoDeCascada {
  acepta: boolean;
  /** Motivo publicable. Nunca vacío. */
  motivo: string;
  /** Qué comprobaciones llegaron a correr, en orden. Para la traza. */
  comprobaciones: string[];
}

/**
 * ¿Se sirve lo que contestó el modelo barato, o se escala?
 *
 * Todo lo de aquí es local y sin red. El orden va de lo más barato de comprobar
 * a lo más caro, y de lo más concluyente a lo menos:
 *
 *  1. UNA RESPUESTA VACÍA se escala. No hace falta esquema para saberlo.
 *  2. UN TURNO DE HERRAMIENTAS se escala. No es una respuesta final, así que el
 *     contrato no aplica y el verificador no tiene NADA que mirar; servir la
 *     elección de herramienta de un modelo más flojo sin poder comprobarla es
 *     justo lo que la elegibilidad prohíbe para las de escritura, y para las de
 *     lectura tampoco hay con qué juzgarla.
 *  3. UN CORTE POR TOPE DE SALIDA (`finishReason: "length"`) se escala. Y es la
 *     comprobación con mejor relación coste/beneficio que hay: un modelo barato
 *     suele ser también más hablador, así que se choca con el `maxOutputTokens`
 *     del llamante más a menudo. Ojo con lo que NO se hace: no se sube el tope
 *     —lo fijó quien llama— y la escalada usa el mismo, igual que la reparación.
 *  4. EL CONTRATO. `validateAgainstSchema` con el esquema DEL LLAMANTE, nunca el
 *     compacto del codebook: lo que se juzga es lo que se va a servir.
 *
 * Rechazar solo cuesta una escalada, que es dinero acotado y visible en el
 * informe. Aceptar de más cuesta una respuesta equivocada servida como buena,
 * que no se ve. Los dos errores no valen igual, y por eso todas las dudas de
 * arriba se resuelven escalando.
 */
export function verificarRespuesta(opts: {
  texto: string;
  schema: JsonSchema | undefined;
  finishReason?: string | undefined;
  pidioHerramientas: boolean;
}): VeredictoDeCascada {
  const comprobaciones: string[] = [];

  comprobaciones.push("non-empty");
  if (opts.texto.trim() === "") {
    return { acepta: false, motivo: "the cheap model returned an empty answer", comprobaciones };
  }

  comprobaciones.push("final-answer");
  if (opts.pidioHerramientas) {
    return {
      acepta: false,
      motivo:
        "the cheap model asked to run tools: that is an action, not a final answer, and the output " +
        "contract cannot check it",
      comprobaciones,
    };
  }

  comprobaciones.push("not-truncated");
  if (opts.finishReason === "length") {
    return {
      acepta: false,
      motivo: "the cheap model's answer was cut off by maxOutputTokens",
      comprobaciones,
    };
  }

  comprobaciones.push("output-contract");
  if (!opts.schema) {
    // No debería llegar aquí (la elegibilidad lo impide), pero si llegara, la
    // respuesta honesta es escalar: sin contrato no se ha comprobado nada y
    // aceptar sería exactamente el falso válido garantizado.
    return {
      acepta: false,
      motivo: "no output contract to verify against",
      comprobaciones,
    };
  }

  let valor: unknown;
  try {
    valor = JSON.parse(opts.texto);
  } catch {
    return { acepta: false, motivo: "the cheap model's answer is not valid JSON", comprobaciones };
  }

  const resultado = validateAgainstSchema(valor, opts.schema);
  if (!resultado.valid) {
    const detalle = resultado.errors
      .slice(0, 3)
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    return {
      acepta: false,
      motivo: `the cheap model's answer does not satisfy the output contract (${detalle})`,
      comprobaciones,
    };
  }

  return {
    acepta: true,
    motivo: "the cheap model's answer satisfies the output contract",
    comprobaciones,
  };
}

// ── LA SEÑAL DE DIVERGENCIA ────────────────────────────────────────────────
//
// NO ES UNA SOLUCIÓN AL FALSO VÁLIDO, y no se vende como tal.
//
// Cuando el modo sombra toma una MUESTRA existen, a la vez, la respuesta del
// modelo barato y la del fuerte para la misma petición. Las dos pueden cumplir
// el contrato y contradecirse en una cifra: eso es literalmente la firma del
// falso válido, y es lo único que se puede mirar sin pagar nada más, porque las
// dos respuestas ya están pagadas.
//
// LO QUE ESTA SEÑAL NO DEMUESTRA, y hay que decirlo antes que lo que sí:
//   · Solo cubre el tráfico MUESTREADO. Fuera de la muestra no dice nada.
//   · Divergir no es equivocarse. Dos respuestas correctas pueden diferir (un
//     redondeo, un orden distinto, un sinónimo), y el modelo FUERTE tampoco es
//     la verdad — es solo el que el cliente pidió.
//   · No divergir tampoco absuelve: los dos modelos pueden fallar igual.
// O sea: una divergencia alta es motivo para MIRAR, nunca para decidir. Por eso
// no entra en ninguna verja ni apaga nada.

/** El resultado de comparar dos respuestas que YA cumplen las dos el contrato. */
export interface Divergencia {
  divergen: boolean;
  motivo: string;
}

/**
 * ¿Contradicen los HECHOS de estas dos respuestas?
 *
 * Se comparan solo las hojas que no admiten paráfrasis: números, booleanos y
 * cadenas cortas (códigos, estados, identificadores, valores de `enum`). La
 * prosa larga se ignora a propósito — dos redacciones distintas del mismo
 * párrafo no son una contradicción, y contarlas haría que la señal marcara el
 * 100% y no significara nada.
 *
 * Es el mismo criterio que ya usa `keyTokensMatch` en la caché semántica: se
 * puede tocar el adorno, no se puede tocar una CIFRA.
 */
export function hechosDivergentes(textoBarato: string, textoFuerte: string): Divergencia {
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(textoBarato);
    b = JSON.parse(textoFuerte);
  } catch {
    return { divergen: false, motivo: "not comparable (at least one answer is not JSON)" };
  }

  const ha = hechos(a);
  const hb = hechos(b);
  if (ha.length === 0 && hb.length === 0) {
    return { divergen: false, motivo: "no comparable facts (free prose only)" };
  }
  if (!multiconjuntoIgual(ha, hb)) {
    return {
      divergen: true,
      motivo:
        "both answers satisfy the contract but disagree on at least one hard value; this is the " +
        "signature of a false valid — it is a reason to look, never a verdict",
    };
  }
  return { divergen: false, motivo: "the hard values agree" };
}

/** Tope de longitud para que una cadena cuente como HECHO y no como prosa. */
const MAX_CARACTERES_DE_HECHO = 40;

/**
 * Las hojas comparables de un valor, como multiconjunto ORDENADO.
 *
 * Ordenado y no por ruta: un array de resultados en otro orden no es una
 * contradicción, y compararlo por posición marcaría divergencia en la mitad de
 * las respuestas correctas. El multiconjunto es la misma elección que hace
 * `numericTokens` en la caché semántica, por la misma razón.
 */
function hechos(valor: unknown, profundidad = 0, salida: string[] = []): string[] {
  if (profundidad > 12) return salida;
  if (typeof valor === "number" && Number.isFinite(valor)) {
    salida.push(`n:${valor}`);
  } else if (typeof valor === "boolean") {
    salida.push(`b:${valor}`);
  } else if (typeof valor === "string") {
    const t = valor.trim();
    // Una cadena corta es un código, un estado o un nombre: un hecho. Una larga
    // es prosa, y la prosa se parafrasea sin mentir.
    if (t.length > 0 && t.length <= MAX_CARACTERES_DE_HECHO) salida.push(`s:${t.toLowerCase()}`);
  } else if (Array.isArray(valor)) {
    for (const x of valor) hechos(x, profundidad + 1, salida);
  } else if (valor && typeof valor === "object") {
    for (const clave of Object.keys(valor as Record<string, unknown>).sort()) {
      hechos((valor as Record<string, unknown>)[clave], profundidad + 1, salida);
    }
  }
  return salida.sort();
}

function multiconjuntoIgual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
