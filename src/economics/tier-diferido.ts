import type { CostModel } from "../tokenizer/accounting.js";
import { primaDeEscritura } from "../pricing/primas.js";
import {
  familiaDeTarifa,
  idDesnudo,
  tarifaDeTier,
  tarifaEstandar,
  type OrigenDeTarifa,
} from "../pricing/tarifas-de-tier.js";

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
// B) TIER DE SERVICIO SÍNCRONO (`service_tier: "flex"` de OpenAI, y el de
//    Gemini a través de su endpoint compatible con OpenAI, que «matches
//    OpenAI's `service_tier` parameter in name and logic»). Mismo protocolo,
//    misma llamada, misma respuesta: más lento y más barato. ESTE es el que se
//    construye, porque no cambia el contrato de la llamada. Lo que vale se
//    calcula con `valorarTierServido`, por modelo y por componente.
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

// ── LO QUE VALE EL TIER SERVIDO: EL MISMO CONTADOR A DOS TARIFAS PUBLICADAS ──
//
// La doctrina es la de la rebaja de TTL del gateway (`construirInforme` en
// gateway/medidor.ts): «una resta entre dos precios públicos sobre el mismo
// conteo». El `usage` que declaró el proveedor en LA llamada cuyo tier se leyó,
// tarifado dos veces —a la tarifa estándar (la fila propia de CATALOGO) y a la
// del tier servido (`pricing/tarifas-de-tier.ts`)—, componente a componente:
// entrada normal, lectura cacheada, escritura de caché y salida. La línea de
// flex de la factura es exactamente ese conteo a esa tarifa, y por eso es la
// única cuenta que cuadra con ella.
//
// TRES REGLAS QUE NO SE NEGOCIAN:
//   · Ningún componente se recorta a 0 por su cuenta: se resta el TOTAL y, si
//     sale ≤ 0, no se acredita nada. Recortar componentes negativos sumaría
//     solo los positivos y acreditaría más que la diferencia real.
//   · El importe se redondea HACIA ABAJO a 1e-10. Nunca al más cercano: el
//     redondeo al más cercano sube la mitad de las veces.
//   · Un componente con tokens y sin precio de tier publicado aporta 0 (se
//     tarifa a la estándar en los dos lados) y la cifra deja de ser `measured`.
//
// `measured` exige las SEIS a la vez:
//   M1 el tier servido se leyó del CUERPO de la respuesta (la cabecera de
//      Gemini tiene nombre oficial pero valores sin documentar: `estimated`);
//   M2 un adaptador de este paquete atestigua que habló con el API oficial;
//   M3 el modelo tiene fila propia en CATALOGO y fila en la tabla de tiers;
//   M4 el cliente no declaró `costModels` para ese modelo;
//   M5 todo componente con tokens tiene precio de tier publicado;
//   M6 el `usage` está completo Y desglosa lo que el tier tarifa aparte: la
//      lectura de caché siempre, y la escritura en los modelos con prima. Un
//      contador ausente no es un cero (ver abajo): la entrada sin desglosar va
//      al suelo y la cifra es `estimated`.
// Con precio del cliente se usa SU tarifa estándar por el ratio tier/estándar
// del catálogo, y es `estimated`: su factura no es la tarifa publicada. Y nunca
// pasa de la diferencia a catálogo, que es lo que promete el contrato público.

/** El `usage` de la llamada cuyo tier se leyó, tal cual lo declaró el proveedor. */
export interface UsoDeLaLlamada {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  complete?: boolean;
}

/** Por qué no se valoró nada. Cada motivo tiene su frase en el informe. */
export type MotivoSinValoracion =
  | "no-served-tier"
  | "standard-rate-tier"
  | "unknown-tier"
  | "no-tier-price"
  | "no-standard-price"
  | "incomplete-usage"
  | "no-difference";

export interface EntradaDeValoracion {
  modelo: string;
  uso: UsoDeLaLlamada;
  /** El tier que el proveedor dice haber servido. Nunca el pedido. */
  tierServido: string | undefined;
  /** Origen oficial ATESTIGUADO por un adaptador propio; `null` si no lo hay. */
  origen: OrigenDeTarifa | null;
  /** De dónde se leyó el tier servido (solo lo sabe un adaptador propio). */
  tierLeidoDe?: "cuerpo" | "cabecera";
  /** El precio que el cliente declaró en `costModels` para este modelo. */
  precioDelCliente?: CostModel;
  ahoraMs?: number;
}

export type ValoracionDelTier =
  | {
      ok: true;
      /** Redondeado hacia abajo a 1e-10: nunca más que la diferencia real. */
      importe: number;
      basis: "measured" | "estimated";
      costeEstandar: number;
      costeAplicado: number;
      /** costeAplicado / costeEstandar. */
      factorEfectivo: number;
      /** Una frase, en inglés, para el informe. */
      motivoBasis: string;
      /** Fecha de consulta de la fila del tier. */
      consultado: string;
    }
  | { ok: false; motivo: MotivoSinValoracion };

const GRANO = 1e10;

/** Hacia abajo a 1e-10, y nunca por encima del valor de entrada. */
export function redondearHaciaAbajo(x: number): number {
  let r = Math.floor(x * GRANO) / GRANO;
  // `x * GRANO` puede redondear hacia arriba justo en un entero; el paso de
  // vuelta garantiza r ≤ x también en coma flotante.
  if (r > x) r = (Math.floor(x * GRANO) - 1) / GRANO;
  return r <= 0 ? 0 : r;
}

const esConteo = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Lo que valió el tier SERVIDO en la llamada cuyo tier se leyó. Pura: no mira el
 * reloj salvo por `ahoraMs`, ni el pipeline, ni la red.
 */
export function valorarTierServido(e: EntradaDeValoracion): ValoracionDelTier {
  const veredicto = veredictoDelTier(e.tierServido);
  if (!veredicto) return { ok: false, motivo: "no-served-tier" };
  if (veredicto.factor == null) return { ok: false, motivo: "unknown-tier" };
  if (!veredicto.conDescuento) return { ok: false, motivo: "standard-rate-tier" };

  const u = e.uso;
  if (
    u.complete === false ||
    !esConteo(u.inputTokens) ||
    !esConteo(u.outputTokens) ||
    (u.cachedInputTokens != null && !esConteo(u.cachedInputTokens)) ||
    (u.cacheWriteInputTokens != null && !esConteo(u.cacheWriteInputTokens))
  ) {
    return { ok: false, motivo: "incomplete-usage" };
  }

  const estandar = tarifaEstandar(e.modelo);
  if (!estandar) return { ok: false, motivo: "no-standard-price" };
  const origenDeTabla = e.origen ?? familiaDeTarifa(e.modelo);
  const tier = origenDeTabla
    ? tarifaDeTier(origenDeTabla, veredicto.servido, e.modelo, e.ahoraMs)
    : undefined;
  if (!tier) return { ok: false, motivo: "no-tier-price" };

  // Los cuatro componentes. `cached` y `writes` se acotan como en el resto del
  // repo: nunca más de lo que el propio contador dice que entró.
  //
  // UN CONTADOR AUSENTE NO ES UN CERO. Si el proveedor no dice cuántos tokens de
  // entrada leyó de su caché (`cached_tokens`) —o, en un modelo con prima, cuántos
  // escribió (`cache_write_tokens`)—, esos tokens están DENTRO de la entrada y no
  // se sabe a qué tarifa se facturaron. Tratarlos como entrada normal
  // sobre-acredita justo donde la caché es automática: en gemini-2.5-flash la
  // lectura cacheada cuesta lo mismo en Flex que en estándar (diferencia 0) y la
  // entrada normal la mitad (diferencia 0,15/1M), así que una llamada con el 90 %
  // de su prompt en la caché implícita se acreditaba diez veces lo que trae la
  // factura, y encima `measured`. Los dos campos son opcionales en el tipo
  // oficial (openai-node, CompletionUsage) y la guía de compatibilidad de Gemini
  // no dice que los rellene. Así que la entrada sin desglosar se tarifa a la
  // MENOR diferencia por token que podría haber tenido —un suelo, sea cual sea
  // el reparto real— y la cifra deja de ser `measured`.
  const entrada = Math.max(0, u.inputTokens);
  const prima = primaDeEscritura(idDesnudo(e.modelo));
  const lecturasConocidas = u.cachedInputTokens != null;
  // Sin prima, escribir la caché ES entrada normal («No additional cache-write
  // charge»): no hay componente aparte que tarifar, ni nada que desglosar.
  const escriturasConocidas = prima <= 1 || u.cacheWriteInputTokens != null;
  const cacheados = lecturasConocidas ? Math.min(Math.max(0, u.cachedInputTokens ?? 0), entrada) : 0;
  const escritos =
    prima > 1 && escriturasConocidas
      ? Math.min(Math.max(0, u.cacheWriteInputTokens ?? 0), entrada - cacheados)
      : 0;
  const restoDeEntrada = entrada - cacheados - escritos;
  const salida = Math.max(0, u.outputTokens);

  type Componente = "input" | "cached input" | "cache write" | "output";
  const estandarDe: Record<Componente, number> = {
    input: estandar.inputPer1k,
    "cached input": estandar.cachedInputPer1k ?? estandar.inputPer1k,
    "cache write": estandar.cacheWritePer1k,
    output: estandar.outputPer1k,
  };
  const tierDe: Record<Componente, number | undefined> = {
    input: tier.inputPer1k,
    "cached input": tier.cachedInputPer1k,
    "cache write": tier.cacheWritePer1k,
    output: tier.outputPer1k,
  };
  // Cada tramo de tokens con los componentes que PODRÍA ser. Uno solo cuando el
  // contador lo desglosa; varios para la entrada que no desglosó.
  const tramos: { tokens: number; posibles: Componente[] }[] = [
    {
      tokens: restoDeEntrada,
      posibles: [
        "input",
        ...(lecturasConocidas ? [] : (["cached input"] as const)),
        ...(escriturasConocidas ? [] : (["cache write"] as const)),
      ],
    },
    { tokens: cacheados, posibles: ["cached input"] },
    { tokens: escritos, posibles: ["cache write"] },
    { tokens: salida, posibles: ["output"] },
  ];
  const sinDesglose = restoDeEntrada > 0 && tramos[0]!.posibles.length > 1;

  // El precio del cliente manda sobre el catálogo en la tarifa estándar, y el
  // tier se deriva de él con el ratio publicado. Un componente sin tarifa de
  // tier conserva ratio 1: aporta 0 igual que sin precio del cliente.
  const cliente = e.precioDelCliente;
  const clienteDe: Record<Componente, number> | undefined = cliente
    ? {
        input: cliente.inputPer1k,
        "cached input": cliente.cachedInputPer1k ?? cliente.inputPer1k,
        "cache write": cliente.inputPer1k * prima,
        output: cliente.outputPer1k,
      }
    : undefined;

  // Lo que vale un token de ese componente en las dos tarifas: la estándar
  // (catálogo o cliente) y la del tier. Sin tarifa de tier publicada, la
  // estándar en los dos lados: aporta 0, nunca un precio supuesto.
  const precio = (c: Componente, conCliente: boolean): { std: number; aplicado: number } => {
    const std = conCliente ? clienteDe![c] : estandarDe[c];
    const t = tierDe[c];
    if (t === undefined) return { std, aplicado: std };
    if (!conCliente) return { std, aplicado: t };
    return { std, aplicado: estandarDe[c] > 0 ? std * (t / estandarDe[c]) : std };
  };

  const sinPrecio = new Set<Componente>();
  const tarifar = (conCliente: boolean): { std: number; aplicado: number } => {
    let std = 0;
    let aplicado = 0;
    for (const tramo of tramos) {
      if (tramo.tokens <= 0) continue;
      // El suelo: de los componentes posibles, el de MENOR diferencia por token.
      let elegido = tramo.posibles[0]!;
      let p = precio(elegido, conCliente);
      for (const c of tramo.posibles.slice(1)) {
        const q = precio(c, conCliente);
        if (q.std - q.aplicado < p.std - p.aplicado) {
          elegido = c;
          p = q;
        }
      }
      if (tierDe[elegido] === undefined && tramo.posibles.length === 1) sinPrecio.add(elegido);
      std += (tramo.tokens / 1000) * p.std;
      aplicado += (tramo.tokens / 1000) * p.aplicado;
    }
    return { std, aplicado };
  };

  // SIEMPRE se tarifa a catálogo: es la cota que promete el contrato público
  // («never more than the difference between the two published rate cards»).
  // Con precio del cliente se tarifa también a SU precio, y el importe es el
  // menor de los dos: una tarifa del cliente por encima del catálogo —o sin
  // precio de lectura cacheada, que deja la lectura a precio de entrada— no
  // puede estimar más de lo que la diferencia publicada permite.
  const aCatalogo = tarifar(false);
  const diferenciaDeCatalogo = aCatalogo.std - aCatalogo.aplicado;
  let costeEstandar = aCatalogo.std;
  let costeAplicado = aCatalogo.aplicado;
  let diferencia = diferenciaDeCatalogo;
  let topado = false;
  if (cliente) {
    const aCliente = tarifar(true);
    costeEstandar = aCliente.std;
    const diferenciaDelCliente = aCliente.std - aCliente.aplicado;
    topado = diferenciaDelCliente > diferenciaDeCatalogo;
    diferencia = Math.min(diferenciaDelCliente, diferenciaDeCatalogo);
    costeAplicado = topado ? aCliente.std - diferencia : aCliente.aplicado;
  }

  if (!(diferencia > 0)) return { ok: false, motivo: "no-difference" };
  const importe = redondearHaciaAbajo(diferencia);
  if (importe <= 0) return { ok: false, motivo: "no-difference" };

  const motivos: string[] = [];
  if (e.origen === null) {
    motivos.push(
      "the endpoint is not the provider's own API as attested by this package's adapter, so the rate " +
        "cards it bills cannot be confirmed",
    );
  } else if (e.tierLeidoDe !== "cuerpo") {
    motivos.push("the served tier was read from a response header whose values the provider does not document");
  }
  if (cliente) {
    motivos.push(
      "priced from your costModels: your standard rate times the published tier-to-standard ratio" +
        (topado ? ", capped at the difference between the two published rate cards" : ""),
    );
  }
  if (sinDesglose) {
    const falta = [
      ...(lecturasConocidas ? [] : ["read from"]),
      ...(escriturasConocidas ? [] : ["written to"]),
    ].join(" or ");
    motivos.push(
      `the provider's usage did not say how many input tokens were ${falta} its prompt cache, so those ` +
        "tokens are priced at the smallest per-token difference they could have had",
    );
  }
  if (sinPrecio.size > 0) {
    motivos.push(
      `the provider publishes no ${[...sinPrecio].join(" or ")} price for this tier, so those tokens add nothing`,
    );
  }
  const medido = motivos.length === 0;
  return {
    ok: true,
    importe,
    basis: medido ? "measured" : "estimated",
    costeEstandar,
    costeAplicado,
    factorEfectivo: costeAplicado / costeEstandar,
    motivoBasis: medido
      ? `the provider's own usage for this call at two published rate cards (${tier.fuente}, checked ` +
        `${tier.consultado}), with the served tier read back from the provider's official API`
      : `estimated: ${motivos.join("; ")}`,
    consultado: tier.consultado,
  };
}

// ── LO QUE EL INFORME TIENE QUE DECIR SOBRE LA LATENCIA ─────────────────────
//
// Un cliente no puede enterarse por su monitorización de que sus peticiones
// tardan más. Pero tampoco se le puede dar un número inventado: OpenAI NO
// publica una latencia comprometida para flex, y decir «diez veces más lento»
// sería exactamente el tipo de cifra que este fichero existe para no escribir.
//
// Así que se publica lo que SÍ está documentado, con su fuente, y se calla el
// resto. Es una frase, no una estimación, y DEPENDE DEL PROVEEDOR: Google sí
// publica un objetivo («Minutes (1–15 min target)», guía de Flex inference,
// act. 2026-09-23) y una forma de fallo distinta (503/429 sin paso a estándar).
// Toda frase lleva la forma del fallo por capacidad, que es lo que el cliente
// tiene que programar.
const LATENCIA_FLEX_OPENAI =
  "slower and variable: OpenAI publishes no latency commitment for the flex tier. What IS " +
  "documented is the failure shape — the default SDK timeout is 10 minutes and a request that " +
  "exceeds it returns 408, and when flex capacity is short the request returns 429 and is not " +
  "charged. Do not put a deferrable request on a user-facing path.";

const LATENCIA_FLEX_GOOGLE =
  "slower and variable: Google targets minutes for the Flex tier (\"Minutes (1–15 min target)\", " +
  "https://ai.google.dev/gemini-api/docs/flex-inference) and treats it as sheddable. When Flex " +
  "capacity is unavailable the request fails with 503 or 429 and is never upgraded to the Standard " +
  "tier on the server side. Do not put a deferrable request on a user-facing path.";

const LATENCIA_FLEX_DESCONOCIDA =
  "slower and variable, and unknown here: this endpoint is not attested as OpenAI's or Google's own " +
  "API, so this layer has no published latency statement for it. On those two providers a flex " +
  "request without capacity fails (429, or 503 on Google) instead of waiting; expect that failure " +
  "shape. Do not put a deferrable request on a user-facing path.";

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
 * A quotation of what is published, never an estimate, chosen by the ORIGIN a
 * built-in adapter attested (`null` when none did). The tiers this layer asks
 * for are a closed set, so an unrecognised one falls back to saying nothing is
 * known — which beats inventing a figure the invoice will contradict.
 */
export function latenciaDelTier(
  pedido: string | undefined,
  origen: OrigenDeTarifa | null = null,
): string {
  if (pedido == null || pedido === "") return LATENCIA_SIN_TIER;
  if (pedido === TIER_DIFERIBLE_OPENAI) {
    if (origen === "openai") return LATENCIA_FLEX_OPENAI;
    if (origen === "google") return LATENCIA_FLEX_GOOGLE;
    return LATENCIA_FLEX_DESCONOCIDA;
  }
  return (
    `unknown: this layer has no published latency statement for the "${pedido}" tier. A cheaper ` +
    "tier without capacity usually fails (429 or 503) rather than waiting; do not put a deferrable " +
    "request on a user-facing path."
  );
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
//
// ── CÓMO SE VALORARÁ, CUANDO SE CONSTRUYA (2026-09-27) ──────────────────────
//
// Con la misma regla que `valorarTierServido`, sin excepciones: el `usage` de
// cada resultado del lote a la tarifa estándar menos el mismo `usage` a la
// tarifa batch publicada, componente a componente. Anthropic informa
// `usage.service_tier: "batch"` en cada resultado y un lote se factura SIEMPRE a
// tarifa batch, así que cumpliría M1–M6 y saldría `measured`. Lo que falta es
// la superficie de arriba, no la cuenta.
//
// Y un dato que ordena la prioridad, leído en la página oficial de precios de
// OpenAI (developers.openai.com/api/docs/pricing, 2026-09-27): en TODOS los
// modelos que OpenAI lista en su tabla Flex, la tabla Batch trae las MISMAS
// cifras de entrada y de salida, y la misma lectura cacheada donde Batch la
// publica (en o3 y o4-mini Batch no publica lectura cacheada y Flex sí, o sea
// que ahí Flex no es peor). En OpenAI, Batch solo añade precio en modelos SIN
// Flex (gpt-4o, gpt-4.1, o1, o3-mini, gpt-5-pro, gpt-5.2-pro, o3-pro, o1-pro;
// gpt-5.5-pro y gpt-5.4-pro sí tienen Flex). Donde Batch
// es la ÚNICA vía es Anthropic, y ahí está el valor de construirlo. Es trabajo
// de tamaño L (partir `generate()` en pre- y post-proveedor y dar durabilidad
// al metering), no un añadido a esta unidad.

// ═══ BEDROCK: NO CUBIERTO, Y POR QUÉ ═════════════════════════════════════════
//
// Bedrock tiene `service_tier` con 'reserved' | 'priority' | 'default' | 'flex',
// y el tier que sirvió se ve en la respuesta y en CloudWatch
// (`ResolvedServiceTier`) — docs.aws.amazon.com/bedrock/latest/userguide/
// service-tiers-inference.html, leída 2026-09-27. Lo que NO hay aquí:
//   · un adaptador SigV4 propio (sin él, nada atestigua que se habló con AWS);
//   · filas de Bedrock en CATALOGO, y el descuento de Flex depende del modelo
//     según la página de precios de Bedrock.
// Si un cliente usa el endpoint compatible con OpenAI de Bedrock, el adaptador
// sigue mandando `flex` (no sabe a quién habla), y el informe dice
// `no published price for the "flex" tier of this model` sin acreditar nada.
// Es el lado seguro: pedir no cuesta, acreditar sin tarifa sí.

// ═══ DEEPSEEK FUERA DE PUNTA: NO SE CONSTRUYE, Y POR QUÉ ══════════════════════
//
// api-docs.deepseek.com/quick_start/pricing (leída 2026-09-27): «Off-peak rates
// are half of the peak rates». Punta: 01:00–04:00 y 06:00–10:00 UTC, de lunes a
// viernes, salvo festivos chinos, que son valle enteros. Cuatro motivos para
// no construirlo:
//   1. CATALOGO no tiene filas de DeepSeek: no hay tarifa estándar contra la que
//      restar.
//   2. La respuesta NO dice qué tarifa se aplicó. Como mucho sería `estimated`,
//      y un reloj local no es el contador del proveedor.
//   3. Aprovecharlo exige RETENER peticiones hasta la ventana de valle, que es
//      exactamente la superficie asíncrona de Batch (arriba): no cabe en
//      `generate()`.
//   4. Dos dudas sin fuente: el calendario de festivos chinos que aplica
//      DeepSeek, y si manda la hora de INICIO o la de FIN de la petición (la
//      página no lo dice).
