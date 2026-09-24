import { sha256, stableStringify } from "../canonicalization/canonicalize.js";
import type { SavingsRequest } from "../contracts/types.js";
import { FACTOR_DIFERIDO_MINIMO, veredictoDelTier } from "../economics/tier-diferido.js";
import { CATALOGO, claveDeCatalogo } from "../pricing/catalogo.js";
import {
  REFERENCE_MAX_AGE_MS,
  REFERENCE_MESSAGE_ALLOWANCE,
  REFERENCE_OUTPUT_SHARE,
  type CostModel,
  type ReferenceCredit,
  type ReferenceRejection,
} from "../tokenizer/accounting.js";

// ═══════════════════════════════════════════════════════════════════════════
// MEDIDO POR REFERENCIA (basis "reference"), regla v1.
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
// Módulo INTERNO: no se reexporta. Lo público es `ReferenceCredit`,
// `ReferenceRejection` y las tres constantes, en `tokenizer/accounting.ts`.

/** Formato v1 del registro que deja una llamada intacta. */
export interface RegistroDeReferencia {
  v: 1;
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
  /** Mensajes que insertó la capa (bajo E2, 0 o 1: el de los datos estructurados). */
  layerMessages: number;
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
 * ¿Regenera el proveedor el mismo texto? Solo con `temperature === 0`. `seed` NO
 * cuenta: es «best effort» en OpenAI, Anthropic lo ignora, y en los modelos de
 * razonamiento la salida lleva tokens de razonamiento variables. Sin
 * `temperature` el proveedor muestrea (a 1, normalmente) aunque la capa cachee.
 */
export function muestreoDeterminista(r: SavingsRequest): boolean {
  return r.temperature === 0;
}

/** Lo único que puede seguir a la clave para que el id sea el MISMO modelo:
 *  una fecha de instantánea, `2024-07-18` (OpenAI) o `20250929` (Anthropic). */
const FECHA_DE_INSTANTANEA = /^\d{4}-?\d{2}-?\d{2}$/;

/**
 * El precio de lista de un modelo SOLO si es SU fila del catálogo: el id es la
 * clave (con o sin prefijo de proveedor) o una instantánea con fecha de ella.
 *
 * `precioDeLista` deja que un id con sufijo de LETRA herede la fila de su
 * pariente (`-latest`, `-preview`), porque para TARIFAR un informe una cifra
 * aproximada vale más que el precio ilustrativo. Para la referencia no: el
 * sufijo también puede ser otro modelo más barato. `gemini-2.5-flash-lite`
 * heredaba la fila de `gemini-2.5-flash`, y una repetición suya se valoraba al
 * triple de su entrada cacheada real y a unas seis veces su salida: un crédito
 * 2,4 veces mayor que la llamada que reemplazaba, dentro de la base de
 * comisión. Una referencia es un suelo o no es nada, así que cualquier id que no
 * sea exactamente la fila da `undefined` y L6 lo rechaza (`no-cached-price`).
 * El alias legítimo que se pierde (`-latest`) solo cuesta que su repetición
 * siga `estimated`; el cliente lo recupera declarando `costModels`.
 */
export function precioDeListaPropio(model: string): CostModel | undefined {
  const clave = claveDeCatalogo(model);
  if (clave === undefined) return undefined;
  const barra = model.lastIndexOf("/");
  const desnudo = barra >= 0 ? model.slice(barra + 1) : model;
  if (clave !== model && clave !== desnudo) {
    // `buscarPorModelo` ya garantiza que tras la clave viene un separador.
    if (!FECHA_DE_INSTANTANEA.test(desnudo.slice(clave.length + 1))) return undefined;
  }
  return CATALOGO[clave];
}

/** Los hechos de la llamada que corrió, tal como los deja el pipeline en la etapa 12. */
export interface HechosDeLaPoblada {
  /** ¿Contestó el proveedor de demo interno? Su usage lo fabrica un estimador,
   *  no lo midió ningún proveedor ni está en ninguna factura. */
  contadorSimulado: boolean;
  /** Usage de la llamada primaria que sirvió (post-escalada). */
  usoPrimario: { inputTokens: number; outputTokens: number; complete?: boolean } | undefined;
  /** Usage de la reparación, si la hubo. */
  usoReparacion?: { inputTokens: number; outputTokens: number; complete?: boolean } | undefined;
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
  /** Backend de restricciones tras la degradación por `structuredNatively === false`. */
  backend: string;
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

const esEnteroNoNegativo = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0;

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
  // E5 · Con el esquema en el prompt, la entrada facturada no es la de la
  // petición nativa del cliente.
  if (h.hayEsquema && h.backend !== "provider-native") return "schema-in-prompt";
  // E6 · Ni cascada que sirve el barato ni rebaja de modelo.
  if (h.modeloServido !== h.modeloPedido) return "cheaper-model-served";
  // E7 · Lo que no se cachea no se repite.
  if (!h.cacheable) return "not-cacheable";

  const veredicto = veredictoDelTier(h.tierServido);
  const tierFactor =
    veredicto?.conDescuento && veredicto.factor != null && veredicto.factor > 0 && veredicto.factor < 1
      ? veredicto.factor
      : undefined;

  return {
    v: 1,
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
    layerMessages: Math.max(0, h.mensajesDeLaCapa),
    requestFingerprint: h.huella(),
    textSha256: sha256(h.textoServido),
  };
}

const esCadenaNoVacia = (s: unknown): s is string => typeof s === "string" && s.length > 0;

/**
 * LECTURA, L0: presente y bien formado. Una entrada escrita por un SDK anterior
 * no lleva `meta` → `absent`, que es el lado seguro. Devuelve una COPIA con solo
 * los campos conocidos.
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
  const bienFormado =
    r["v"] === 1 &&
    typeof r["inputTokens"] === "number" &&
    Number.isInteger(r["inputTokens"]) &&
    (r["inputTokens"] as number) > 0 &&
    esEnteroNoNegativo(r["outputTokens"]) &&
    typeof r["at"] === "number" &&
    Number.isFinite(r["at"]) &&
    (tier === undefined || (typeof tier === "number" && tier > 0 && tier < 1)) &&
    esEnteroNoNegativo(r["layerMessages"]) &&
    esCadenaNoVacia(r["requestId"]) &&
    esCadenaNoVacia(r["model"]) &&
    esCadenaNoVacia(r["requestFingerprint"]) &&
    esCadenaNoVacia(r["textSha256"]);
  if (!bienFormado) return "malformed";
  return {
    v: 1,
    requestId: r["requestId"] as string,
    at: r["at"] as number,
    model: r["model"] as string,
    inputTokens: r["inputTokens"] as number,
    outputTokens: r["outputTokens"] as number,
    ...(tier !== undefined ? { tierFactor: tier as number } : {}),
    layerMessages: r["layerMessages"] as number,
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
  determinista: boolean;
  topeDeSalida?: number | undefined;
  diferible: boolean;
}

export type EvaluacionDeReferencia =
  | { ok: true; credit: ReferenceCredit }
  | { ok: false; reason: ReferenceRejection };

/**
 * LECTURA, L1-L7, en orden; la primera que falla da el motivo. Si todo pasa,
 * el crédito con la valoración de la regla v1:
 *
 *   creditedInputTokens  = inputTokens − 8 · layerMessages
 *   creditedOutputTokens = determinista ? ⌊0,95 · min(outputTokens, tope del lector)⌋ : 0
 *   tierFactor           = min(1, tier de la poblada, diferible ? tier diferido mínimo : 1)
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
  const creditedInputTokens = reg.inputTokens - REFERENCE_MESSAGE_ALLOWANCE * reg.layerMessages;
  if (!(creditedInputTokens > 0)) return { ok: false, reason: "no-credit" };

  const tope =
    typeof ctx.topeDeSalida === "number" && Number.isFinite(ctx.topeDeSalida)
      ? Math.max(0, ctx.topeDeSalida)
      : Number.POSITIVE_INFINITY;
  const creditedOutputTokens = ctx.determinista
    ? Math.floor(REFERENCE_OUTPUT_SHARE * Math.min(reg.outputTokens, tope))
    : 0;
  const tierFactor = Math.min(1, reg.tierFactor ?? 1, ctx.diferible ? FACTOR_DIFERIDO_MINIMO : 1);

  return {
    ok: true,
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
