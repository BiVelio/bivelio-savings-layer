// EL DESCUENTO POR DIFERIR TRABAJO: pagar menos por el mismo token a cambio de
// esperar más.
//
// Los comentarios de este fichero van en `//` a propósito y NO en JSDoc: los
// tipos que se exportan aquí no viajan a `dist/index.d.ts` (nadie los reexporta
// desde `src/index.ts`), pero el día que alguien los reexporte un bloque JSDoc
// se publicaría entero en npm. Lo que sigue es razonamiento interno.
//
// ── LAS DOS PALANCAS SON DISTINTAS, Y LA DIFERENCIA NO ES DE GRADO ──────────
//
// A) BATCH API (OpenAI Batch, Anthropic Message Batches). Descuento grande y
//    ASÍNCRONO: se envía un lote, se espera, se recoge. NO CABE en `generate()`,
//    que es petición/respuesta. Ver el bloque «EL ASÍNCRONO» al final: está
//    diseñado y NO construido, y ahí se explica por qué eso no es pereza.
//
// B) TIER DE SERVICIO SÍNCRONO (`service_tier: "flex"` de OpenAI). Mismo
//    protocolo, misma llamada, misma respuesta: más lento y más barato. ESTE es
//    el que se construye, porque no cambia el contrato de la llamada.
//
// ── LO QUE ESTÁ CONFIRMADO, Y CONTRA QUÉ ────────────────────────────────────
//
// Toda cifra de este fichero está contrastada contra DOS fuentes, y al menos una
// es del propio proveedor. Lo que no se pudo confirmar no está aquí y no se
// acredita — ver `LATENCIA_*`, que dice lo que se sabe y calla lo que no.
//
//   OpenAI · `service_tier: "flex"`
//     · Existe y se acepta en Chat Completions y en Responses. Los valores del
//       parámetro son 'auto' | 'default' | 'flex' | 'scale' | 'priority' | 'fast'.
//       [openai-node, src/resources/chat/completions/completions.ts]
//     · Precio: los tokens «are priced at Batch API rates, with additional
//       discounts from prompt caching» [guía Flex processing de OpenAI], y la
//       Batch API da «50% cost discount compared to synchronous APIs» [guía Batch
//       de OpenAI]. Las dos son de OpenAI: 0,50 sobre entrada y salida.
//     · Se pisa con la caché de prefijo: NO. La propia guía de flex dice que los
//       descuentos de caché se SUMAN encima. Es la respuesta a la pregunta que
//       más importaba: las dos palancas componen.
//     · Capacidad: cuando no la hay, 429 «Resource Unavailable» y «You will not
//       be charged when this occurs». Timeout por defecto del SDK: 10 minutos;
//       agotado, 408.
//     · Modelos: «Flex processing is in beta with limited model availability».
//       POR ESO ESTA CAPA NO PREDICE QUÉ MODELO LO TIENE — lee el tier servido.
//
//   Anthropic · API de Mensajes SÍNCRONA
//     · NO HAY TIER BARATO. El parámetro `service_tier` acepta 'auto' |
//       'standard_only', y lo que elige es capacidad PRIORITARIA (más rápida y
//       más cara) frente a la estándar. No existe un flex.
//       [platform.claude.com/docs/en/api/messages]
//     · El descuento por diferir existe SOLO en la Message Batches API: «All
//       usage is charged at 50% of the standard API prices», y su FAQ lo desglosa
//       — «applies to input tokens, output tokens, and any special tokens».
//       Asíncrona: la mayoría de lotes en menos de 1 hora, caducan a las 24.
//     · Batch + caché de prefijo: «The pricing discounts from prompt caching and
//       Message Batches can stack». Aciertos «best-effort», del 30% al 98%.
//
// ── LA CONDICIÓN DE HONESTIDAD, Y ES LA RAZÓN DE SER DEL MÓDULO ─────────────
//
// UN TIER DEGRADADO SE COBRA A PRECIO ESTÁNDAR EN SILENCIO. OpenAI lo dice con
// todas las letras: «When the `service_tier` parameter is set, the response body
// will include the `service_tier` value based on the processing mode actually
// used to serve the request. This response value may be different from the value
// set in the parameter.»
//
// O sea que PEDIR no es OBTENER. Acreditar el descuento por haberlo pedido
// publicaría un ahorro que la factura del cliente no trae. Por eso la única
// entrada de este módulo es el tier SERVIDO, nunca el pedido, y por eso el mapa
// de abajo se consulta con lo que contestó el proveedor.
//
// Y por eso también el valor por defecto de un tier desconocido es CERO
// DESCUENTO: si mañana aparece un `service_tier` nuevo, esta capa no le inventa
// una tarifa — se calla y no acredita. Un descuento inventado es ahorro
// inventado, y es el fallo que este producto no se puede permitir.

/**
 * Fraction of the standard list price billed by each processing tier a provider
 * reports having SERVED. 1 = no discount.
 *
 * Keyed by the tier string the provider returns, not by the one we asked for.
 */
const FACTOR_POR_TIER_SERVIDO: Readonly<Record<string, number>> = {
  // OpenAI, `service_tier` de la respuesta.
  flex: 0.5,
  default: 1,
  auto: 1,
  priority: 1,
  fast: 1,
  // `scale` existe en el tipo del SDK y su tarifa NO está publicada. Se declara
  // a 1 en vez de omitirlo para que quede escrito que se miró: sin tarifa
  // conocida no se acredita, y eso es una decisión, no un olvido.
  scale: 1,

  // Anthropic, `usage.service_tier` de la respuesta.
  standard: 1,
  batch: 0.5,
};

// EL TIER MÁS BARATO QUE UNA PETICIÓN DIFERIBLE PODÍA OBTENER, para el carril
// medido por referencia. Un acierto de caché de una petición declarada diferible
// se valora como si la repetición hubiera ido por ese tier: si la capa no la
// hubiera servido, la ingenua habría pedido `flex` y podía haber pagado la mitad.
// Tomar el MÍNIMO es lo que mantiene la referencia como suelo. Se deriva de la
// tabla en vez de escribirse a mano para que un tier nuevo más barato la mueva
// solo. Interno: no se reexporta.
export const FACTOR_DIFERIDO_MINIMO = Math.min(
  ...Object.values(FACTOR_POR_TIER_SERVIDO).filter((f) => f < 1),
);

/** Tier the layer asks for when the caller declares a request deferrable. */
export const TIER_DIFERIBLE_OPENAI = "flex";

/**
 * What the provider said it served, and what that is worth.
 *
 * `factor` is the fraction of the standard price that tier bills, so the saving
 * against the standard rate card is `1 - factor`.
 */
export interface VeredictoDelTier {
  /** Tier string exactly as the provider reported it. */
  servido: string;
  /** Fraction of standard list price, or `null` when this tier is unknown. */
  factor: number | null;
  /** Whether this tier bills BELOW the standard rate card. */
  conDescuento: boolean;
}

/**
 * Reads the tier the provider reports having SERVED and prices it.
 *
 * `undefined` in means the provider said nothing, which is NOT the same as
 * "standard": it means we cannot know, so nothing can be credited.
 */
export function veredictoDelTier(servido: string | undefined): VeredictoDelTier | null {
  if (servido == null || servido === "") return null;
  const factor = FACTOR_POR_TIER_SERVIDO[servido];
  if (factor == null) {
    // Un tier que no está en la tabla. No se acredita nada y se dice cuál era,
    // que es lo único honesto: el cliente puede mirarlo en su factura y
    // nosotros no le hemos prometido una cifra que no sabemos.
    return { servido, factor: null, conDescuento: false };
  }
  return { servido, factor, conDescuento: factor < 1 };
}

/**
 * What the served tier was worth on THIS request, in the caller's currency unit.
 *
 * A COUNTERFACTUAL priced from the standard rate card: the request was not also
 * run at standard price, so this is `costeEstandar * (1 - factor)`. It is
 * deliberately NOT part of `cost.netSavings` — see the report's docstring.
 *
 * Returns `null` when nothing can be claimed: no tier reported, an unknown tier,
 * or a tier that bills at the standard rate.
 */
export function ahorroDelTier(
  veredicto: VeredictoDelTier | null,
  costeEstandar: number,
): number | null {
  if (!veredicto || veredicto.factor == null || !veredicto.conDescuento) return null;
  if (!Number.isFinite(costeEstandar) || costeEstandar <= 0) return null;
  return costeEstandar * (1 - veredicto.factor);
}

// ── LO QUE EL INFORME TIENE QUE DECIR SOBRE LA LATENCIA ─────────────────────
//
// Un cliente no puede enterarse por su monitorización de que sus peticiones
// tardan más. Pero tampoco se le puede dar un número inventado: OpenAI NO
// publica una latencia comprometida para flex, y decir «diez veces más lento»
// sería exactamente el tipo de cifra que este fichero existe para no escribir.
//
// Así que se publica lo que SÍ está documentado, con su fuente, y se calla el
// resto. Es una frase, no una estimación.
const LATENCIA_FLEX =
  "slower and variable: OpenAI publishes no latency commitment for the flex tier. What IS " +
  "documented is the failure shape — the default SDK timeout is 10 minutes and a request that " +
  "exceeds it returns 408, and when flex capacity is short the request returns 429 and is not " +
  "charged. Do not put a deferrable request on a user-facing path.";

const LATENCIA_SIN_TIER =
  "unchanged: this provider has no cheaper synchronous processing tier, so nothing was asked " +
  "for and the request was scheduled exactly as it would have been.";

/**
 * Why nothing was asked for, when the provider has no cheaper synchronous tier.
 *
 * It names the batch API on purpose: a caller who marked a request deferrable
 * and got nothing deserves to know the discount exists and where, rather than
 * concluding the lever is broken.
 */
export const SIN_TIER_DIFERIBLE =
  "this provider has no cheaper synchronous processing tier, so the request was sent unchanged " +
  "and nothing is credited; on this provider the deferred discount lives only in the " +
  "asynchronous batch API, which is not a request/response call";

/**
 * What the provider documents about the latency of the tier that was asked for.
 *
 * A quotation of what is published, never an estimate. The tiers this layer asks
 * for are a closed set, so an unrecognised one falls back to saying nothing is
 * known — which beats inventing a figure the invoice will contradict.
 */
export function latenciaDelTier(pedido: string | undefined): string {
  if (pedido == null || pedido === "") return LATENCIA_SIN_TIER;
  if (pedido === TIER_DIFERIBLE_OPENAI) return LATENCIA_FLEX;
  return `unknown: this layer has no published latency statement for the "${pedido}" tier.`;
}

// ═══ EL ASÍNCRONO: DISEÑADO Y NO CONSTRUIDO, Y POR QUÉ ══════════════════════
//
// La Batch API da el MISMO 50% que flex en OpenAI, y en Anthropic es el ÚNICO
// sitio donde ese 50% existe. La tentación de meterlo por la puerta de atrás de
// `generate()` es real y hay que nombrarla para descartarla: bloquear la llamada
// del cliente hasta 24 horas fingiendo que la latencia no cambió sería
// exactamente la clase de mentira que esta capa se niega a contar. `generate()`
// es petición/respuesta y tiene que seguir siéndolo.
//
// Necesita superficie propia. El boceto, con los tres sitios donde rompe lo que
// hoy existe:
//
//   submitDeferred(requests[]) -> { batchId, submittedAt, expiresAt }
//   pollDeferred(batchId)      -> { status, results?[] }
//
//   1. EL INFORME. `SavingsReport` describe UNA petición que YA se sirvió:
//      `latencyMs.provider`, `cost.actual`, `qualityStatus`. En un lote no hay
//      nada de eso en el momento de enviar. Un lote necesita DOS informes —uno
//      de envío, con lo que se pidió y lo que se espera, y uno por resultado al
//      recogerlo— y sólo el segundo puede tarifar. Reutilizar `SavingsReport`
//      para el primero publicaría `cost.actual: 0` sobre trabajo pendiente, que
//      es un ahorro del 100% fabricado: el mismo fallo que `requireUsage` cierra.
//
//   2. LA CACHÉ. Los atajos de la capa (exacta, semántica, singleflight) sirven
//      una respuesta INMEDIATA. En un lote, un acierto de caché significa que esa
//      entrada del lote no hay ni que enviarla, así que el filtrado tiene que
//      pasar ANTES de construir el lote y el resultado tiene que devolverse en la
//      misma forma que los que sí viajaron. El singleflight, en cambio, no aplica:
//      coalescer dos peticiones idénticas dentro de un lote no ahorra una espera,
//      ahorra una línea de factura, y eso ya lo hace la caché exacta.
//
//   3. EL METERING. Hoy emite uso al terminar la petición. Con un lote, el envío
//      y el cobro están separados por hasta 24 horas y por un reinicio de proceso.
//      El uso NO se puede emitir al enviar (aún no se sabe ni si se ejecutará: un
//      lote caduca a las 24h y sus peticiones no se facturan), así que el emisor
//      necesita durabilidad — o el cobro se pierde, o se cobra trabajo que
//      expiró. Ése es el trabajo de verdad, y es lo que hace que esto sea otra
//      fase y no un rato.
//
// Y un límite que decide el diseño: en Anthropic un lote son 100.000 peticiones
// o 256 MB; en OpenAI 50.000 peticiones o 200 MB, con 2.000 lotes por hora. O sea
// que el troceado es responsabilidad de la capa, no del cliente.
