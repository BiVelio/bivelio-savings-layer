import type { JsonSchema } from "../contracts/types.js";
import { validateAgainstSchema } from "./validate.js";

/**
 * Codebook de salida.
 *
 * POR QUÉ EXISTE. La salida es la parte cara de la factura y la palanca obvia
 * —bajar `maxOutputTokens`— está medida como NETO NEGATIVO: un techo no es una
 * instrucción, así que solo ahorra TRUNCANDO, y un truncado es una llamada
 * entera pagada que no sirve (por eso el pipeline se niega a reintentarlo, ver
 * la etapa 11). El único ahorro de salida que no compra calidad es que lo que
 * el modelo genere OCUPE MENOS TOKENS SIN PERDER UN BIT:
 *
 *     genera hoy      {"decision":"human_review","confidence":0.87}
 *     con codebook    {"d":"H","confidence":0.87}
 *     devuelve la capa   idéntico a lo primero
 *
 * Es la misma idea que el torneo de serializadores aplicada al otro eje: mismo
 * contenido, menos símbolos. La diferencia es que aquí la reversión tiene que
 * ser DEMOSTRABLE, porque el valor que se expande es el que se le devuelve al
 * llamante y el que se guarda en caché.
 *
 * LAS TRES VERJAS, todas apply-or-drop (nunca a medias):
 *
 *  1. REVERSIBILIDAD. Se sintetizan testigos a partir del esquema ORIGINAL que
 *     tocan cada clave renombrada y cada valor de enum codificado, y se exige
 *     `expand(compact(t)) === t` sobre todos. Si alguno falla, no hay codebook.
 *  2. ADMISIBILIDAD. El testigo compactado tiene que validar contra el esquema
 *     COMPACTO, que es el que viaja al proveedor. Sin esto, un `required` mal
 *     reescrito viaja como contrato y el proveedor rechaza la petición entera.
 *  3. DINERO. Se cuenta con el tokenizador de destino y por los DOS lados: el
 *     esquema compacto viaja en la ENTRADA (`response_format`), así que si lo
 *     que engorda ahí supera lo que adelgaza en la salida, no se aplica.
 *
 * LO QUE NO SE PUEDE PROBAR AQUÍ, y por eso esta palanca es opt-in: que el
 * modelo razone IGUAL de bien rellenando `{"d":"H"}` que `{"decision":
 * "human_review"}`. La reversión es lossless en DATOS; la calidad de lo que el
 * modelo decide poner ahí solo la puede demostrar un A/B, exactamente igual que
 * pasó con el techo de salida.
 */

/** Profundidad máxima del esquema. Un esquema cíclico (construido por
 *  referencia) colgaría el recorrido; pasado el tope se descarta el codebook. */
const PROFUNDIDAD_MAXIMA = 16;

/** Enums más largos que esto no se codifican: los códigos dejan de ser cortos
 *  y el número de testigos que hay que verificar crece con ellos. */
const ENUM_MAXIMO = 64;

/** Ahorro NETO mínimo (tokens) para aplicar. Ver `planOutputCodebook`. */
const AHORRO_MINIMO_POR_DEFECTO = 8;

/**
 * Lo que hay que deshacer al expandir una respuesta. Un subárbol sin renombres
 * ni códigos no produce nodo: expandir es entonces la identidad y se evita
 * recorrer datos que nadie tocó.
 */
interface CodebookNode {
  /** clave compacta → clave original. */
  keysBack?: Map<string, string>;
  /** clave original → clave compacta. */
  keysFwd?: Map<string, string>;
  /** clave ORIGINAL → nodo del hijo. */
  props?: Map<string, CodebookNode>;
  /** nodo de los elementos, para arrays. */
  items?: CodebookNode;
  /** código → valor original. */
  enumBack?: Map<string, string>;
  /** valor original → código. */
  enumFwd?: Map<string, string>;
}

export interface CodebookPlan {
  /** El esquema que viaja al proveedor en lugar del original. */
  compactSchema: JsonSchema;
  /** Respuesta compacta → forma del llamante. Total: nunca lanza. */
  expand(value: unknown): unknown;
  /** Forma del llamante → respuesta compacta. Existe para la verja y los tests. */
  compact(value: unknown): unknown;
  renamedKeys: number;
  codedEnumValues: number;
  /** Tokens del esquema original y del compacto, con el tokenizador de destino. */
  schemaTokensOriginal: number;
  schemaTokensCompact: number;
  /**
   * Ahorro de salida MODELADO sobre el testigo sintético, no medido sobre una
   * respuesta real. Sirve para decidir si se aplica; no se acredita en ningún
   * libro (ver la nota de contabilidad en el pipeline).
   */
  modelledOutputSavingTokens: number;
}

export type CodebookDecision =
  | { applied: true; plan: CodebookPlan; reason: string }
  | { applied: false; reason: string };

/**
 * Deriva un codebook para el esquema del llamante y decide si merece la pena.
 *
 * `countTokens` tiene que ser el tokenizador REAL del modelo de destino (el
 * mismo `tokensFor` que usa el torneo de formatos): la verja de dinero compara
 * tokens, y con un contador distinto al que factura el proveedor la comparación
 * no significa nada.
 *
 * El mínimo por defecto (8 tokens netos) no es un umbral de precisión, es un
 * umbral de PRUDENCIA: cambiar el `response_format` que ve el proveedor tiene
 * un riesgo de calidad que ninguna verja de aquí puede medir, así que no se
 * corre por ganancias triviales. Y se compara sin ponderar por precio aunque un
 * token de salida cueste ~3-4x uno de entrada: eso hace la regla más estricta de
 * lo necesario, que es el lado correcto en el que equivocarse.
 */
export function planOutputCodebook(
  schema: JsonSchema,
  countTokens: (text: string) => number,
  opts: { minimumSavingsTokens?: number } = {},
): CodebookDecision {
  const minimo = opts.minimumSavingsTokens ?? AHORRO_MINIMO_POR_DEFECTO;

  // Un `pattern` en cualquier parte deja el esquema fuera. No es que el codebook
  // rompa un regex —no toca esa restricción— sino que no se puede SINTETIZAR un
  // testigo que lo cumpla, y sin testigo válido no hay nada que demostrar. Sin
  // prueba, no hay palanca.
  if (contienePattern(schema, 0)) {
    return { applied: false, reason: "schema has a pattern; no witness can be synthesised to prove the round trip" };
  }

  let derivado: Derivado;
  try {
    derivado = derivar(schema, 0);
  } catch (err) {
    return { applied: false, reason: err instanceof RangeError ? "schema too deep or cyclic" : "schema could not be compacted" };
  }
  if (derivado.renamed === 0 && derivado.coded === 0) {
    return { applied: false, reason: "nothing to compact (no renameable keys, no codeable enums)" };
  }

  const nodo = derivado.node;
  if (!nodo) return { applied: false, reason: "nothing to compact" };

  const compactar = (v: unknown): unknown => transformar(v, nodo, true);
  const expandir = (v: unknown): unknown => transformar(v, nodo, false);

  // --- Verjas 1 y 2: reversibilidad y admisibilidad -------------------------
  const witnesses = testigosDe(schema);
  for (const t of witnesses) {
    // El testigo tiene que cumplir el contrato del PROPIO llamante. Si no,
    // compararlo contra el esquema compacto no demuestra nada, y el fallo puede
    // estar en el esquema y no en el codebook.
    if (!validateAgainstSchema(t, schema).valid) {
      return { applied: false, reason: "synthesised witness does not satisfy the caller's own schema; nothing can be proven" };
    }
    const c = compactar(t);
    if (!validateAgainstSchema(c, derivado.compact).valid) {
      return { applied: false, reason: "compact witness does not validate against the compact schema" };
    }
    if (!igualEnProfundidad(expandir(c), t)) {
      return { applied: false, reason: "round trip is not the identity" };
    }
  }

  // --- Verja 3: dinero ------------------------------------------------------
  const schemaTokensOriginal = countTokens(JSON.stringify(schema));
  const schemaTokensCompact = countTokens(JSON.stringify(derivado.compact));
  // El coste de ENTRADA del cambio: lo que engorda (o adelgaza) el bloque
  // `response_format`. Positivo = el esquema compacto cuesta más.
  const costeEntrada = schemaTokensCompact - schemaTokensOriginal;
  // El ahorro de SALIDA, modelado sobre el peor testigo. Con un array el testigo
  // lleva un solo elemento, así que esto queda por DEBAJO de lo que ahorraría una
  // respuesta real con la lista llena: la estimación se equivoca a la baja.
  let ahorroSalida = Number.POSITIVE_INFINITY;
  for (const t of witnesses) {
    const delta = countTokens(JSON.stringify(t)) - countTokens(JSON.stringify(compactar(t)));
    if (delta < ahorroSalida) ahorroSalida = delta;
  }
  if (!Number.isFinite(ahorroSalida)) ahorroSalida = 0;

  const neto = ahorroSalida - costeEntrada;
  if (neto < minimo) {
    return {
      applied: false,
      reason: `net saving ${neto} tokens is below the ${minimo}-token floor (output ${ahorroSalida}, schema ${costeEntrada > 0 ? "+" : ""}${costeEntrada})`,
    };
  }

  return {
    applied: true,
    reason: `output ${ahorroSalida} tokens, schema ${costeEntrada > 0 ? "+" : ""}${costeEntrada}, net ${neto}`,
    plan: {
      compactSchema: derivado.compact,
      expand: expandir,
      compact: compactar,
      renamedKeys: derivado.renamed,
      codedEnumValues: derivado.coded,
      schemaTokensOriginal,
      schemaTokensCompact,
      modelledOutputSavingTokens: ahorroSalida,
    },
  };
}

// --- derivación ------------------------------------------------------------

interface Derivado {
  compact: JsonSchema;
  node?: CodebookNode;
  renamed: number;
  coded: number;
}

function esObjeto(schema: JsonSchema): boolean {
  return schema.type === "object" || (schema.type == null && schema.properties != null);
}

function esArray(schema: JsonSchema): boolean {
  return schema.type === "array" || (schema.type == null && schema.items != null);
}

function enumDeCadenas(schema: JsonSchema): string[] | null {
  const e = schema.enum;
  if (!e || e.length === 0 || e.length > ENUM_MAXIMO) return null;
  if (!e.every((v) => typeof v === "string")) return null;
  return e as string[];
}

function derivar(schema: JsonSchema, prof: number): Derivado {
  if (prof > PROFUNDIDAD_MAXIMA) throw new RangeError("schema too deep");

  const valores = enumDeCadenas(schema);
  if (valores) {
    // `minLength` sobre un enum codificado es la trampa: los códigos son más
    // CORTOS que los valores, así que un mínimo de longitud que el original
    // cumplía deja de cumplirse y el esquema compacto describe algo imposible.
    // Ese enum se queda como está en vez de tumbar el codebook entero.
    if (schema.minLength != null) return { compact: schema, renamed: 0, coded: 0 };
    const fwd = asignarCodigos(valores, true);
    if (!fwd) return { compact: schema, renamed: 0, coded: 0 };
    // Un mapa que resulta ser la identidad entera (valores ya de un carácter) no
    // codifica nada: dejarlo pasar contaría como palanca aplicada algo que no
    // cambia un solo token.
    const cambiados = [...fwd].filter(([orig, code]) => orig !== code).length;
    if (cambiados === 0) return { compact: schema, renamed: 0, coded: 0 };
    const back = new Map<string, string>();
    for (const [orig, code] of fwd) back.set(code, orig);
    return {
      compact: { ...schema, enum: valores.map((v) => fwd.get(v)!) },
      node: { enumFwd: fwd, enumBack: back },
      renamed: 0,
      coded: cambiados,
    };
  }

  if (esObjeto(schema)) return derivarObjeto(schema, prof);
  if (esArray(schema)) return derivarArray(schema, prof);
  return { compact: schema, renamed: 0, coded: 0 };
}

function derivarObjeto(schema: JsonSchema, prof: number): Derivado {
  const entradas = Object.entries(schema.properties ?? {});
  if (entradas.length === 0) return { compact: schema, renamed: 0, coded: 0 };

  let renamed = 0;
  let coded = 0;
  const hijos = new Map<string, CodebookNode>();
  const compactadas = new Map<string, JsonSchema>();
  for (const [clave, sub] of entradas) {
    const d = derivar(sub, prof + 1);
    compactadas.set(clave, d.compact);
    if (d.node) hijos.set(clave, d.node);
    renamed += d.renamed;
    coded += d.coded;
  }

  // Renombrar SOLO con el objeto cerrado. Con `additionalProperties` abierto el
  // modelo puede devolver claves que el esquema no declara, y entonces expandir
  // es adivinar: una clave desconocida podría ser un código nuestro o una clave
  // literal del modelo, y no hay forma de distinguirlas. Sin esa certeza la
  // reversión deja de ser demostrable, así que ese nodo conserva sus claves.
  // (El lint del registro de esquemas ya empuja a cerrar los objetos; aquí eso
  // además compra compresión de salida.)
  let fwd: Map<string, string> | null = null;
  if (schema.additionalProperties === false) {
    fwd = asignarCodigos(entradas.map(([k]) => k), false);
  }

  const propsCompactas: Record<string, JsonSchema> = {};
  for (const [clave] of entradas) {
    propsCompactas[fwd?.get(clave) ?? clave] = compactadas.get(clave)!;
  }

  const compact: JsonSchema = { ...schema, properties: propsCompactas };
  if (schema.required) compact.required = schema.required.map((r) => fwd?.get(r) ?? r);

  const nodo: CodebookNode = {};
  if (fwd) {
    const back = new Map<string, string>();
    for (const [orig, code] of fwd) back.set(code, orig);
    // Un mapa que resulta ser la identidad entera (todas las claves ya eran de
    // un carácter) no es un renombre: no se cuenta ni se guarda.
    let algunoCambia = false;
    for (const [orig, code] of fwd) if (orig !== code) algunoCambia = true;
    if (algunoCambia) {
      nodo.keysFwd = fwd;
      nodo.keysBack = back;
      for (const [orig, code] of fwd) if (orig !== code) renamed += 1;
    }
  }
  if (hijos.size > 0) nodo.props = hijos;

  const vacio = !nodo.keysFwd && !nodo.props;
  return { compact, ...(vacio ? {} : { node: nodo }), renamed, coded };
}

function derivarArray(schema: JsonSchema, prof: number): Derivado {
  if (!schema.items) return { compact: schema, renamed: 0, coded: 0 };
  const d = derivar(schema.items, prof + 1);
  return {
    compact: { ...schema, items: d.compact },
    ...(d.node ? { node: { items: d.node } } : {}),
    renamed: d.renamed,
    coded: d.coded,
  };
}

/**
 * Asigna un código corto a cada nombre. Devuelve `null` cuando el resultado no
 * sería reversible.
 *
 * DETERMINISMO. Se recorre en orden LEXICOGRÁFICO, no en el orden en que estén
 * escritas las propiedades: dos esquemas con el mismo contenido escrito en
 * distinto orden tienen que producir los mismos códigos, o el prefijo estable
 * que la caché del proveedor necesita se rompe en cada despliegue.
 *
 * AMBIGÜEDAD. Si un código coincide con el nombre ORIGINAL de OTRO miembro, el
 * mapa deja de ser interpretable: al recibir ese texto no se sabe si el modelo
 * quiso decir el código o el nombre literal. Ahí se devuelve `null` y ese nodo
 * se queda sin comprimir, que es lo único honesto que se puede hacer.
 */
function asignarCodigos(nombres: string[], mayusculas: boolean): Map<string, string> | null {
  const ordenados = [...nombres].sort();
  const usados = new Set<string>();
  const mapa = new Map<string, string>();
  ordenados.forEach((nombre, i) => {
    const base = mayusculas ? nombre.toUpperCase() : nombre;
    let codigo = nombre;
    for (let n = 1; n < nombre.length; n++) {
      const c = base.slice(0, n);
      if (!usados.has(c)) {
        codigo = c;
        break;
      }
    }
    if (codigo === nombre) {
      const posicional = i.toString(36);
      if (posicional.length < nombre.length && !usados.has(posicional)) codigo = posicional;
    }
    usados.add(codigo);
    mapa.set(nombre, codigo);
  });

  const originales = new Set(nombres);
  for (const [orig, code] of mapa) {
    if (code !== orig && originales.has(code)) return null;
  }
  return mapa;
}

// --- transformación de valores ---------------------------------------------

/**
 * Aplica el mapa a un valor. `haciaCompacto` elige la dirección.
 *
 * TOTAL A PROPÓSITO: lo que llega por aquí en producción es lo que devolvió el
 * modelo, que puede no tener la forma prometida. Cualquier cosa que no encaje se
 * devuelve tal cual — nunca se lanza — para que el fallo lo diagnostique el
 * validador de la etapa 11 con su mensaje, y no una excepción sin contexto que
 * acabaría en el fail-open abriendo una segunda llamada pagada.
 */
function transformar(value: unknown, node: CodebookNode, haciaCompacto: boolean): unknown {
  const enumMapa = haciaCompacto ? node.enumFwd : node.enumBack;
  if (enumMapa && typeof value === "string") {
    // Un valor que no está en el mapa se deja pasar: si el modelo devolvió el
    // nombre largo en vez del código, esa respuesta sigue siendo la correcta y
    // reescribirla a ciegas sí la rompería.
    return enumMapa.get(value) ?? value;
  }

  if (node.items && Array.isArray(value)) {
    return value.map((v) => transformar(v, node.items!, haciaCompacto));
  }

  const claves = haciaCompacto ? node.keysFwd : node.keysBack;
  if ((claves || node.props) && esObjetoLlano(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const destino = claves?.get(k) ?? k;
      // Los hijos se indexan por la clave ORIGINAL, sea cual sea la dirección.
      const original = haciaCompacto ? k : destino;
      const hijo = node.props?.get(original);
      out[destino] = hijo ? transformar(v, hijo, haciaCompacto) : v;
    }
    return out;
  }

  return value;
}

function esObjetoLlano(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- testigos --------------------------------------------------------------

/**
 * Instancias sintéticas del esquema ORIGINAL con las que se prueba la reversión.
 *
 * Una sola no basta: con un solo testigo cada enum se ejercitaría con un único
 * valor y un código mal asignado a los demás pasaría la verja sin que nadie lo
 * tocara. Se genera una ronda por posición de enum, de modo que TODO valor de
 * TODO enum aparece en algún testigo.
 */
function testigosDe(schema: JsonSchema): unknown[] {
  const rondas = Math.min(ENUM_MAXIMO, Math.max(1, mayorEnum(schema, 0)));
  const out: unknown[] = [];
  for (let i = 0; i < rondas; i++) out.push(testigo(schema, i, 0));
  return out;
}

function mayorEnum(schema: JsonSchema, prof: number): number {
  if (prof > PROFUNDIDAD_MAXIMA) return 0;
  let mayor = schema.enum?.length ?? 0;
  for (const sub of Object.values(schema.properties ?? {})) {
    mayor = Math.max(mayor, mayorEnum(sub, prof + 1));
  }
  if (schema.items) mayor = Math.max(mayor, mayorEnum(schema.items, prof + 1));
  return mayor;
}

function testigo(schema: JsonSchema, indiceEnum: number, prof: number): unknown {
  if (prof > PROFUNDIDAD_MAXIMA) return null;
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[Math.min(indiceEnum, schema.enum.length - 1)];
  }
  if (esObjeto(schema)) {
    const obj: Record<string, unknown> = {};
    // TODAS las propiedades declaradas, no solo las `required`: una clave
    // opcional también se renombra, así que también hay que demostrarla.
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      obj[k] = testigo(sub, indiceEnum, prof + 1);
    }
    return obj;
  }
  if (esArray(schema)) {
    if (schema.maxItems === 0) return [];
    const n = Math.max(1, schema.minItems ?? 1);
    const total = schema.maxItems != null ? Math.min(n, schema.maxItems) : n;
    const item = schema.items;
    return Array.from({ length: total }, () => (item ? testigo(item, indiceEnum, prof + 1) : null));
  }
  switch (schema.type) {
    case "string": {
      if (schema.maxLength === 0) return "";
      const minimo = Math.max(1, schema.minLength ?? 1);
      const largo = schema.maxLength != null ? Math.min(minimo, schema.maxLength) : minimo;
      return "x".repeat(largo);
    }
    case "number":
    case "integer": {
      let v = schema.minimum ?? 1;
      if (schema.maximum != null && v > schema.maximum) v = schema.maximum;
      return schema.type === "integer" ? Math.round(v) : v;
    }
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      // Un nodo sin tipo ni palabras clave no restringe nada, así que cualquier
      // valor sirve de testigo.
      return null;
  }
}

function contienePattern(schema: JsonSchema, prof: number): boolean {
  if (prof > PROFUNDIDAD_MAXIMA) return true;
  if (schema.pattern != null) return true;
  for (const sub of Object.values(schema.properties ?? {})) {
    if (contienePattern(sub, prof + 1)) return true;
  }
  if (schema.items && contienePattern(schema.items, prof + 1)) return true;
  return false;
}

/** Igualdad estructural sobre el modelo de datos de JSON. */
function igualEnProfundidad(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!igualEnProfundidad(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!igualEnProfundidad((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}
