import { sha256, stableStringify } from "../canonicalization/canonicalize.js";
import type { SavingsRequest } from "../contracts/types.js";
import { FACTOR_DIFERIDO_MINIMO, veredictoDelTier } from "../economics/tier-diferido.js";
import type { SalidaNoRepetible } from "../pricing/razonamiento.js";
import {
  REFERENCE_MAX_AGE_MS,
  REFERENCE_MESSAGE_ALLOWANCE,
  REFERENCE_OUTPUT_SHARE,
  type CostModel,
  type ReferenceCredit,
  type ReferenceRejection,
} from "../tokenizer/accounting.js";

// ═══════════════════════════════════════════════════════════════════════════
// MEDIDO POR REFERENCIA (basis "reference"), regla v2.
// ═══════════════════════════════════════════════════════════════════════════
//
// Solo se comisiona dinero que el contador del proveedor ya midió. Puede ser el
// de la propia petición (`measured`) o, cuando se sirve una repetición sin
// llamar al proveedor, el de la petición idéntica BYTE A BYTE que sí se ejecutó,
// sin que la capa le quitara ni le añadiera nada, y que el cliente ya pagó. Esa
// repetición se valora al precio más bajo que el proveedor podía cobrar por
// repetirla, así que lo facturable queda siempre por debajo de lo que habría
// costado.
//
// Dos mitades, y las dos están aquí como funciones puras:
//
//   · ESCRITURA (E0-E7, `registroDeReferencia`): cuándo la llamada que corrió
//     deja un registro de su contador. Solo si fue INTACTA: su contador tiene
//     que ser el de la petición del cliente, no el de una petición que la capa
//     reescribió.
//   · LECTURA (L0-L7, `leerRegistroDeReferencia` + `evaluarReferencia`): cuándo
//     un acierto exacto o un seguidor de singleflight se valora con ese
//     contador. La primera condición que falla da el motivo, se publica en
//     `report.cache.referenceRejected`, y la evitada sigue `estimated` como
//     siempre. Nunca se lanza nada y nunca se reclama de más.
//
// El pipeline solo cablea: aquí no hay estado ni E/S, y por eso se prueba suelto
// (`test/referencia-es-suelo.test.ts` recorre cada fila del catálogo y, además,
// los ids que HEREDARÍAN una fila ajena, que aquí no valen).
//
// QUÉ CAMBIÓ EN LA v2 (y por qué no cobra de más):
//
//   · E5 AMPLIADA. En la v1 una petición con contrato de salida solo dejaba
//     registro con el backend `provider-native` configurado, y la configuración
//     por defecto no configura ninguno: todo el tráfico con esquema quedaba
//     fuera aunque el esquema viajara nativo. Ahora cuenta lo que PASÓ, no lo
//     que se planeó: deja registro cuando el adaptador de este paquete
//     atestigua que el esquema viajó TAL CUAL en el parámetro nativo de formato
//     de respuesta, en modo estricto (`strict: true`) y sin una palabra de la
//     capa en el prompt (`providers/atestado-del-cable.ts`), Y la respuesta no
//     lo desmiente (`structuredNatively === true`: el proveedor no rechazó el
//     parámetro). Lo que se afirma es lo que salió por el cable, no que el
//     proveedor lo impusiera: un endpoint compatible que acepte e ignore
//     `response_format` no cambia el contador, que sigue siendo el de la
//     petición del cliente. El esquema es del cliente —va en su petición y en la
//     huella—; lo único de la capa es el envoltorio (`name: "bvsala_contract"`),
//     y ese se descuenta como una pieza insertada más: los mismos 8 tokens que
//     un mensaje.
//   · LO QUE AÑADE EL ADAPTADOR, también descontado. El turno «(continue)» que
//     el adaptador de Anthropic antepone cuando la conversación empieza por el
//     asistente, y los parámetros vacíos que los dos adaptadores ponen a una
//     herramienta que no traía, no los ve la cuenta local, pero el contador sí
//     los cobra: una pieza cada uno.
//   · GUARDA DE SALIDA. La salida solo se acredita si la llamada que corrió no
//     llevó razonamiento oculto —su proveedor declaró EXACTAMENTE 0 tokens de
//     razonamiento, o, donde no los desglosa, su respuesta no trae bloque de
//     razonamiento (`reasoningTokens: 0` del adaptador)— y si el modelo es una
//     fila del catálogo que no razona y honra `temperature: 0`
//     (`pricing/razonamiento.ts`). Un contador que no lo dice no es un 0.
//   · FORMATO v2 del registro. Un lector v1 declara `malformed` un registro v2
//     y viceversa: nunca se valora un registro con una regla que no lo escribió.
//
// Módulo INTERNO: no se reexporta. Lo público es `ReferenceCredit`,
// `ReferenceRejection` y las tres constantes, en `tokenizer/accounting.ts`.

/** Formato v2 del registro que deja una llamada intacta. */
export interface RegistroDeReferencia {
  v: 2;
  /** El `report.requestId` de la llamada que corrió. */
  requestId: string;
  /** Epoch ms en que se leyó su contador. */
  at: number;
  /** El modelo pedido, que bajo E6 es también el que contestó. */
  model: string;
  /** Entrada facturada por la llamada PRIMARIA (sin reparación, sondeo ni intento barato). */
  inputTokens: number;
  /** Salida facturada: la menor entre la primaria y su reparación. */
  outputTokens: number;
  /** Factor del tier servido, SOLO si tenía descuento (en (0,1)). */
  tierFactor?: number;
  /**
   * Piezas que la capa metió en la llamada que corrió, cada una cubierta con
   * REFERENCE_MESSAGE_ALLOWANCE tokens: el mensaje de datos estructurados (bajo
   * E2 es el único mensaje del pipeline que sobrevive), los mensajes que añadió
   * el ADAPTADOR (el «(continue)» de Anthropic) y el envoltorio del esquema
   * nativo.
   */
  layerInsertions: number;
  /**
   * Tokens de razonamiento oculto que el proveedor declaró en la primaria (más
   * los de la reparación, si la hubo). AUSENTE si alguno de los dos no lo dijo:
   * entonces no se sabe, y sin un 0 declarado la salida no se acredita.
   */
  reasoningTokens?: number;
  /** `huellaDePeticion` de la petición del cliente. */
  requestFingerprint: string;
  /** SHA-256 del texto servido: el testigo que ata el contador a la respuesta. */
  textSha256: string;
  /** La clave exacta bajo la que se guardó. SOLO en la copia de la caché exacta. */
  cacheKey?: string;
}

/** Por qué una llamada que corrió NO deja registro. ASCII inglés: va a la traza. */
export type MotivoSinReferencia =
  // E0: el contador no es de un proveedor, lo fabricó el proveedor de demo.
  | "simulated-provider"
  | "no-usage"
  | "layer-changed-request"
  | "codebook"
  | "tool-discovery"
  | "schema-in-prompt"
  | "cheaper-model-served"
  | "not-cacheable"
  // E5, segunda mitad: el esquema no viajó por una vía que el adaptador
  // atestigüe como el esquema del cliente TAL CUAL (la herramienta de contrato
  // de Anthropic; un proveedor de terceros).
  | "schema-not-verbatim"
  // E5, tercera mitad: viajó tal cual en el parámetro nativo, pero con
  // `strict: false` (un campo opcional lo impide en OpenAI). Ahí la forma la
  // garantiza la capa al validar, no el proveedor, y la regla publicada solo
  // admite el modo estricto.
  | "schema-not-strict"
  // Defensivo, fuera de E0-E7: la huella no se pudo calcular (algo no
  // serializable en la petición). Sin huella no hay identidad que atestiguar.
  | "fingerprint-failed";

/** Desfase de reloj tolerado entre el proceso que escribió y el que lee. */
const DESFASE_DE_RELOJ_MS = 5 * 60 * 1000;

/** Ruido de unión admitido entre la cuenta local enviada y la ingenua (el `"\n"`
 *  de más cuando los datos van en su propio mensaje). */
const RUIDO_DE_UNION_TOKENS = 2;

/**
 * La identidad BYTE A BYTE de una petición: lo que el proveedor habría recibido
 * del cliente sin la capa. Mensajes, datos estructurados, herramientas y esquema,
 * CRUDOS —no la forma normalizada de la clave exacta, que iguala mayúsculas,
 * diacríticos y puntuación—. Dos peticiones con la misma huella envían los
 * mismos bytes, y el contador del proveedor para esos bytes es determinista.
 *
 * El modelo no entra: lo comprueba L2 aparte. `temperature` y `seed` ya van en la
 * clave exacta; `maxOutputTokens` no, y lo cubre el `min` con el tope del lector.
 */
export function huellaDePeticion(r: SavingsRequest): string {
  return sha256(
    stableStringify({
      messages: r.messages,
      structuredData: r.structuredData ?? null,
      tools: r.tools ?? [],
      schema: r.response?.schema ?? null,
    }),
  );
}

/**
 * ¿Pidió el cliente muestreo determinista? Solo con `temperature === 0`. `seed`
 * NO cuenta: es «best effort» en OpenAI, Anthropic lo ignora, y en los modelos
 * de razonamiento la salida lleva tokens de razonamiento variables. Sin
 * `temperature` el proveedor muestrea (a 1, normalmente) aunque la capa cachee.
 *
 * Pedirlo no basta para acreditar salida: la guarda de razonamiento
 * (`evaluarReferencia`) exige además que el modelo no razone y que la llamada
 * que corrió declarara 0 tokens de razonamiento.
 */
export function muestreoDeterminista(r: SavingsRequest): boolean {
  return r.temperature === 0;
}

// `precioDeListaPropio` (la fila PROPIA del modelo, nunca la de un pariente)
// vive en el catálogo desde la Parte G: el gateway valora su gemela coalescida
// con la MISMA regla y no puede importar de src/pipeline/ (verja de no-solape).
// Se reexporta aquí para que el pipeline y sus tests no cambien de import.
export { precioDeListaPropio } from "../pricing/catalogo.js";

/** Los hechos de la llamada que corrió, tal como los deja el pipeline en la etapa 12. */
export interface HechosDeLaPoblada {
  /** ¿Contestó el proveedor de demo interno? Su usage lo fabrica un estimador,
   *  no lo midió ningún proveedor ni está en ninguna factura. */
  contadorSimulado: boolean;
  /** Usage de la llamada primaria que sirvió (post-escalada). */
  usoPrimario: UsoDeLaPoblada | undefined;
  /** Usage de la reparación, si la hubo. */
  usoReparacion?: UsoDeLaPoblada | undefined;
  /** Tier que el proveedor dijo haber servido a la primaria. */
  tierServido?: string | undefined;
  eliminatedInput: number;
  compressedInput: number;
  elididoLocal: number;
  /** Cuenta local del prompt enviado, ANTES de sumar el sondeo. */
  sentLocalSinSondeo: number;
  /** Cuenta local del prompt ingenuo. */
  baselineInput: number;
  codebookAplicado: boolean;
  tokensDelSondeo: number;
  sondeoAplicado: boolean;
  hayEsquema: boolean;
  /** `structuredNatively === true` en la respuesta de la primaria: el
   *  proveedor no rechazó la vía nativa. `undefined` o `false` no afirman nada. */
  esquemaNativo: boolean;
  /** El adaptador propio atestigua que el esquema viajó TAL CUAL en el
   *  parámetro nativo de formato de respuesta (ver `atestado-del-cable.ts`). */
  esquemaEnFormatoNativo: boolean;
  /** …y con `strict: true`. */
  esquemaEstricto: boolean;
  /** El adaptador escribió el esquema en el prompt (la instrucción de JSON). */
  esquemaPorPrompt: boolean;
  /** Piezas que el ADAPTADOR añadió al cable (0 sin atestado). */
  piezasDelAdaptador: number;
  modeloPedido: string;
  modeloServido: string;
  cacheable: boolean;
  /** Mensajes que salieron menos los que mandó el cliente. */
  mensajesDeLaCapa: number;
  requestId: string;
  at: number;
  textoServido: string;
  /** Perezosa: solo se paga el SHA-256 de la petición cuando todo lo demás pasó. */
  huella: () => string;
}

/** Lo que el registro lee del usage de una llamada. */
export interface UsoDeLaPoblada {
  inputTokens: number;
  outputTokens: number;
  complete?: boolean;
  reasoningTokens?: number;
}

const esEnteroNoNegativo = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0;

/** Razonamiento declarado entre primaria y reparación; `undefined` si alguna calla. */
function razonamientoDeclarado(p: UsoDeLaPoblada, rep: UsoDeLaPoblada | undefined): number | undefined {
  if (!esEnteroNoNegativo(p.reasoningTokens)) return undefined;
  if (!rep) return p.reasoningTokens;
  if (!esEnteroNoNegativo(rep.reasoningTokens)) return undefined;
  return p.reasoningTokens + rep.reasoningTokens;
}

/**
 * ESCRITURA: E0-E7, en orden; la primera que falla da el motivo.
 *
 * El registro solo nace de una llamada poblada INTACTA. Así su contador ES el de
 * la petición del cliente: ni libro 2 ni libro 3, sin elisión, sin contenido
 * añadido (salvo el mensaje de datos, ±2 de ruido de unión), sin codebook, sin
 * sondeo, sin esquema por prompt y con el modelo servido igual al pedido. Y
 * antes de todo eso (E0), el contador tiene que venir de un proveedor de verdad.
 */
export function registroDeReferencia(h: HechosDeLaPoblada): RegistroDeReferencia | MotivoSinReferencia {
  // E0 · Contador REAL. El proveedor de demo (el mock) inventa su usage con el
  // estimador heurístico: no hay factura detrás. Sin esta guarda, una suite de
  // tests o un staging con el mock y la medición encendida emitiría cada
  // repetición como `reference` con base positiva, o sea comisión sobre dinero
  // que nadie pagó, justo lo que la regla existe para impedir. Antes de este
  // carril ese montaje no ganaba nada (medidas con ahorro 0, aciertos
  // `estimated`), y así sigue.
  if (h.contadorSimulado) return "simulated-provider";
  // E1 · Usage. Enteros, que es lo que L0 exige al leer: escribir algo que el
  // lector va a declarar mal formado no sirve de nada. Y COMPLETO: con
  // `complete === false` el proveedor no dio uno de los dos contadores (un
  // stream sin su evento final de usage, un endpoint que omite la salida) y el
  // adaptador lo rellenó con 0. Esa llamada se publica `unmeasured` (la guarda
  // de `callsWithoutUsage` en estimateCost), así que su repetición no puede
  // cobrarse contra ella: un 0 rellenado parece un contador y no lo es.
  const p = h.usoPrimario;
  if (
    !p ||
    p.complete === false ||
    !esEnteroNoNegativo(p.inputTokens) ||
    p.inputTokens <= 0 ||
    !esEnteroNoNegativo(p.outputTokens)
  ) {
    return "no-usage";
  }
  const rep = h.usoReparacion;
  if (rep && (rep.complete === false || !esEnteroNoNegativo(rep.outputTokens))) return "no-usage";

  // E2 · Intacta. Excluye el selector de herramientas y la elisión (libro 2), la
  // serialización con ahorro y la compresión (libro 3), y todo contenido que la
  // capa añade: la pista de límites y la evidencia mueven la cuenta enviada.
  if (
    h.eliminatedInput !== 0 ||
    h.compressedInput !== 0 ||
    h.elididoLocal !== 0 ||
    Math.abs(h.sentLocalSinSondeo - h.baselineInput) > RUIDO_DE_UNION_TOKENS
  ) {
    return "layer-changed-request";
  }
  // E3 · El codebook cambia el contrato que ve el proveedor.
  if (h.codebookAplicado) return "codebook";
  // E4 · El sondeo es otra llamada y recorta la vista de herramientas.
  if (h.tokensDelSondeo !== 0 || h.sondeoAplicado) return "tool-discovery";
  // E5 · El esquema, NATIVO, TAL CUAL Y ESTRICTO. Se mira lo que pasó, no lo
  // que se planeó: el backend `none` de la configuración por defecto no impide
  // que el adaptador de Chat Completions mande el esquema en `response_format`,
  // y un `provider-native` configurado no impide que un modelo lo rechace y el
  // adaptador lo pida por prompt. Tres preguntas, en orden:
  //   · ¿viajó por la vía nativa? Si la respuesta no lo dice
  //     (`structuredNatively` distinto de true) o el adaptador atestigua que lo
  //     escribió en el prompt, esa instrucción la cuenta el proveedor y no la
  //     cuenta E2: fuera. La segunda condición no es redundante: la
  //     instrucción lleva el esquema ENTERO (cientos de tokens, no una pieza de
  //     8) y no puede colarse aunque alguien relaje la primera.
  //   · ¿viajó TAL CUAL, en el parámetro nativo? La herramienta de contrato de
  //     Anthropic también es nativa, pero su nombre, su descripción y el prompt
  //     de uso de herramientas que el proveedor cobra con ella los puso nuestro
  //     adaptador. Y un proveedor de terceros no puede atestiguarlo. Fuera.
  //   · ¿en modo estricto? Con `strict: false` la forma la garantiza la capa,
  //     no el proveedor. La regla publicada solo admite el modo estricto.
  if (h.hayEsquema && (!h.esquemaNativo || h.esquemaPorPrompt)) return "schema-in-prompt";
  if (h.hayEsquema && !h.esquemaEnFormatoNativo) return "schema-not-verbatim";
  if (h.hayEsquema && !h.esquemaEstricto) return "schema-not-strict";
  // E6 · Ni cascada que sirve el barato ni rebaja de modelo.
  if (h.modeloServido !== h.modeloPedido) return "cheaper-model-served";
  // E7 · Lo que no se cachea no se repite.
  if (!h.cacheable) return "not-cacheable";

  const veredicto = veredictoDelTier(h.tierServido);
  const tierFactor =
    veredicto?.conDescuento && veredicto.factor != null && veredicto.factor > 0 && veredicto.factor < 1
      ? veredicto.factor
      : undefined;

  const razonamiento = razonamientoDeclarado(p, rep);

  return {
    v: 2,
    requestId: h.requestId,
    at: h.at,
    model: h.modeloPedido,
    // SOLO la primaria: la reparación, el sondeo y el intento barato de la
    // cascada son coste NUESTRO y se quedan en el `actual` de la poblada.
    inputTokens: p.inputTokens,
    // Con reparación, la menor de las dos: la repetición sirve el texto
    // reparado, y ninguna de las dos cifras puede exceder lo que el proveedor
    // habría escrito por la más corta.
    outputTokens: rep ? Math.min(p.outputTokens, rep.outputTokens) : p.outputTokens,
    ...(tierFactor !== undefined ? { tierFactor } : {}),
    // Todo lo que la capa metió y el contador cobró: el mensaje de datos, lo
    // que añadió el adaptador y, con esquema (que bajo E5 es nativo y tal
    // cual), su envoltorio.
    layerInsertions:
      Math.max(0, h.mensajesDeLaCapa) +
      Math.max(0, h.piezasDelAdaptador) +
      (h.hayEsquema ? 1 : 0),
    ...(razonamiento !== undefined ? { reasoningTokens: razonamiento } : {}),
    requestFingerprint: h.huella(),
    textSha256: sha256(h.textoServido),
  };
}

const esCadenaNoVacia = (s: unknown): s is string => typeof s === "string" && s.length > 0;

/**
 * LECTURA, L0: presente y bien formado. Una entrada escrita por un SDK anterior
 * no lleva `meta` → `absent`, que es el lado seguro; una escrita con OTRA regla
 * (`v` distinto de 2) → `malformed`: su contador no pasó las guardas de ésta.
 * Devuelve una COPIA con solo los campos conocidos.
 */
export function leerRegistroDeReferencia(
  meta: Record<string, unknown> | undefined,
): RegistroDeReferencia | "absent" | "malformed" {
  if (meta == null || typeof meta !== "object") return "absent";
  const raw = (meta as Record<string, unknown>)["reference"];
  if (raw === undefined || raw === null) return "absent";
  if (typeof raw !== "object" || Array.isArray(raw)) return "malformed";
  const r = raw as Record<string, unknown>;
  const tier = r["tierFactor"];
  const razonamiento = r["reasoningTokens"];
  const bienFormado =
    r["v"] === 2 &&
    typeof r["inputTokens"] === "number" &&
    Number.isInteger(r["inputTokens"]) &&
    (r["inputTokens"] as number) > 0 &&
    esEnteroNoNegativo(r["outputTokens"]) &&
    typeof r["at"] === "number" &&
    Number.isFinite(r["at"]) &&
    (tier === undefined || (typeof tier === "number" && tier > 0 && tier < 1)) &&
    esEnteroNoNegativo(r["layerInsertions"]) &&
    (razonamiento === undefined || esEnteroNoNegativo(razonamiento)) &&
    esCadenaNoVacia(r["requestId"]) &&
    esCadenaNoVacia(r["model"]) &&
    esCadenaNoVacia(r["requestFingerprint"]) &&
    esCadenaNoVacia(r["textSha256"]);
  if (!bienFormado) return "malformed";
  return {
    v: 2,
    requestId: r["requestId"] as string,
    at: r["at"] as number,
    model: r["model"] as string,
    inputTokens: r["inputTokens"] as number,
    outputTokens: r["outputTokens"] as number,
    ...(tier !== undefined ? { tierFactor: tier as number } : {}),
    layerInsertions: r["layerInsertions"] as number,
    ...(razonamiento !== undefined ? { reasoningTokens: razonamiento as number } : {}),
    requestFingerprint: r["requestFingerprint"] as string,
    textSha256: r["textSha256"] as string,
    ...(typeof r["cacheKey"] === "string" ? { cacheKey: r["cacheKey"] } : {}),
  };
}

/** Lo que el lector sabe de SU petición y de lo que va a servir. */
export interface ContextoDeLectura {
  ahoraMs: number;
  modeloPedido: string;
  /** El modelo al que la cascada de ESTA petición enruta. */
  modeloServido: string;
  /** `huellaDePeticion` de esta petición. */
  huella: string;
  /** SHA-256 del texto que se va a servir. */
  textoServidoSha256: string;
  /** La clave exacta leída (acierto exacto); `undefined` en un seguidor. */
  claveLeida?: string | undefined;
  /** El veto de calidad sobre lo que se va a servir. */
  calidadOk: boolean;
  /** SOLO el precio conocido (costModels o catálogo): nunca el ilustrativo. */
  precio: CostModel | undefined;
  /** ¿Pidió ESTA petición `temperature: 0`? */
  determinista: boolean;
  /**
   * Por qué la salida del modelo pedido no se puede repetir
   * (`pricing/razonamiento.ts`), o `undefined` si se puede. Obligatorio a
   * propósito: olvidarlo no puede equivaler a «se puede».
   */
  salidaDelModelo: SalidaNoRepetible | undefined;
  topeDeSalida?: number | undefined;
  diferible: boolean;
}

/**
 * Por qué una referencia válida no acredita salida. ASCII inglés: va a la traza.
 *   · `sampled`                — esta petición no pidió `temperature: 0`;
 *   · `reasoning-model`        — el modelo razona, diga lo que diga el contador;
 *   · `temperature-ignored`    — el modelo no honra `temperature: 0`;
 *   · `unclassified-model`     — el modelo no es fila del catálogo;
 *   · `reasoning-reported`     — la llamada que corrió declaró razonamiento;
 *   · `reasoning-not-reported` — la llamada que corrió no dijo cuánto razonó.
 */
export type MotivoSinSalida = "sampled" | SalidaNoRepetible | "reasoning-reported" | "reasoning-not-reported";

export type EvaluacionDeReferencia =
  | { ok: true; credit: ReferenceCredit; outputNotCredited?: MotivoSinSalida }
  | { ok: false; reason: ReferenceRejection };

/**
 * LA GUARDA DE SALIDA, regla v2. Tres condiciones y las tres hacen falta:
 * muestreo determinista pedido por ESTA petición, un modelo clasificado que no
 * razona y honra `temperature: 0`, y una llamada que corrió sin razonamiento
 * oculto: `reasoningTokens` EXACTAMENTE 0 (el contador del proveedor o, donde
 * no lo desglosa, la ausencia de bloque de razonamiento que declara el
 * adaptador). Devuelve el primer motivo que falla, o `undefined` si la salida
 * se puede acreditar.
 *
 * Por qué no basta `temperature: 0`: los tokens de razonamiento no se ven y su
 * número cambia de una llamada idéntica a otra; y los modelos que razonan casi
 * nunca respetan ese parámetro (una pasarela que lo quita en silencio convierte
 * la petición en muestreada). El 95 % de un contador así no mide nada.
 */
export function motivoSinSalida(
  reg: Pick<RegistroDeReferencia, "reasoningTokens">,
  ctx: Pick<ContextoDeLectura, "determinista" | "salidaDelModelo">,
): MotivoSinSalida | undefined {
  if (!ctx.determinista) return "sampled";
  if (ctx.salidaDelModelo !== undefined) return ctx.salidaDelModelo;
  if (reg.reasoningTokens === undefined) return "reasoning-not-reported";
  if (reg.reasoningTokens !== 0) return "reasoning-reported";
  return undefined;
}

/**
 * LECTURA, L1-L7, en orden; la primera que falla da el motivo. Si todo pasa,
 * el crédito con la valoración de la regla v2:
 *
 *   creditedInputTokens  = inputTokens − 8 · layerInsertions
 *   creditedOutputTokens = salida acreditable ? ⌊0,95 · min(outputTokens, tope del lector)⌋ : 0
 *   tierFactor           = min(1, tier de la poblada, diferible ? tier diferido mínimo : 1)
 *
 * «Salida acreditable» es la guarda de `motivoSinSalida`: `temperature: 0`, un
 * modelo clasificado que no razona y honra ese parámetro, y 0 tokens de
 * razonamiento declarados.
 *
 * El precio es el del proceso que LEE, con el catálogo o los `costModels`
 * vigentes: la factura contra la que se contrasta es la de hoy.
 */
export function evaluarReferencia(
  reg: RegistroDeReferencia,
  ctx: ContextoDeLectura,
): EvaluacionDeReferencia {
  // L1 · Testigo: el contador está atado al texto que se sirve y, en un
  // acierto exacto, a la clave de la que se leyó. Un `meta.reference` forjado o
  // copiado de otra entrada no pasa de aquí.
  if (ctx.textoServidoSha256 !== reg.textSha256) return { ok: false, reason: "witness" };
  if (ctx.claveLeida !== undefined && reg.cacheKey !== ctx.claveLeida) {
    return { ok: false, reason: "witness" };
  }
  // L2 · Modelo: el del registro, el pedido y el servido, los tres iguales.
  if (reg.model !== ctx.modeloPedido || ctx.modeloServido !== ctx.modeloPedido) {
    return { ok: false, reason: "model-mismatch" };
  }
  // L3 · Edad: un período de facturación, con 5 min de desfase entre procesos.
  const edad = ctx.ahoraMs - reg.at;
  if (!(edad >= -DESFASE_DE_RELOJ_MS && edad <= REFERENCE_MAX_AGE_MS)) {
    return { ok: false, reason: "expired" };
  }
  // L4 · Identidad byte a byte. La clave exacta normaliza; esto no.
  if (ctx.huella !== reg.requestFingerprint) return { ok: false, reason: "different-request" };
  // L5 · Calidad de lo que se sirve.
  if (!ctx.calidadOk) return { ok: false, reason: "quality" };
  // L6 · Precio cacheado DOCUMENTADO. Sin él no hay suelo que valga.
  const precio = ctx.precio;
  const c = precio?.cachedInputPer1k;
  if (
    !precio ||
    typeof c !== "number" ||
    !Number.isFinite(c) ||
    !(c > 0) ||
    !Number.isFinite(precio.inputPer1k) ||
    c > precio.inputPer1k ||
    typeof precio.outputPer1k !== "number" ||
    !Number.isFinite(precio.outputPer1k) ||
    precio.outputPer1k < 0
  ) {
    return { ok: false, reason: "no-cached-price" };
  }
  // L7 · Crédito.
  const creditedInputTokens = reg.inputTokens - REFERENCE_MESSAGE_ALLOWANCE * reg.layerInsertions;
  if (!(creditedInputTokens > 0)) return { ok: false, reason: "no-credit" };

  const tope =
    typeof ctx.topeDeSalida === "number" && Number.isFinite(ctx.topeDeSalida)
      ? Math.max(0, ctx.topeDeSalida)
      : Number.POSITIVE_INFINITY;
  const sinSalida = motivoSinSalida(reg, ctx);
  const creditedOutputTokens =
    sinSalida === undefined ? Math.floor(REFERENCE_OUTPUT_SHARE * Math.min(reg.outputTokens, tope)) : 0;
  const tierFactor = Math.min(1, reg.tierFactor ?? 1, ctx.diferible ? FACTOR_DIFERIDO_MINIMO : 1);

  return {
    ok: true,
    ...(sinSalida !== undefined ? { outputNotCredited: sinSalida } : {}),
    credit: {
      requestId: reg.requestId,
      at: reg.at,
      inputTokens: reg.inputTokens,
      outputTokens: reg.outputTokens,
      creditedInputTokens,
      creditedOutputTokens,
      cachedInputPer1k: c,
      outputPer1k: precio.outputPer1k,
      tierFactor,
    },
  };
}
