import type { ProviderUsage } from "../providers/types.js";
import { extraDeCompactacion } from "../providers/iteraciones-de-compactacion.js";
import { salidaOculta } from "../providers/salida-oculta.js";
import { PRECIOS_AL_DIA, claveDeCatalogo, diaUtc, precioDeLista, precioDeListaPropio } from "../pricing/catalogo.js";
import { primaDeEscritura, primaDeEscritura1h } from "../pricing/primas.js";
import { stableStringify } from "../canonicalization/canonicalize.js";
import { sha256 } from "../util/hash.js";
import { randomId } from "../util/id.js";

// ═══════════════════════════════════════════════════════════════════════════
// EL USO POR INTENTO (plan Caveman 2026-10-14, D02).
// ═══════════════════════════════════════════════════════════════════════════
//
// Una llamada LÓGICA (lo que pidió el cliente) puede costar varios INTENTOS:
// la primaria, un reintento tras un 5xx, la reparación de un JSON inválido, un
// sondeo de descubrimiento. Hoy el ledger los suma en un solo par de contadores
// y la petición entera sale `unmeasured` en cuanto uno llega sin su usage. Este
// módulo es la pieza que faltaba debajo: el uso de CADA intento, normalizado
// igual venga del dialecto que venga, tarifado en enteros con la versión del
// catálogo que lo tarifó, y apuntado en un libro donde repetir un evento no
// suma dos veces.
//
// Las reglas, que los tests fijan una a una:
//   · OpenAI cuenta la caché DENTRO de `prompt_tokens`; Anthropic la deja FUERA
//     de `input_tokens`. `inputUncached` se deriva por dialecto y el mismo uso
//     lógico da los mismos números por los dos lados.
//   · El razonamiento oculto ya va DENTRO de la salida facturada en todos los
//     dialectos que se leen aquí: se publica como desglose y no se suma.
//   · Un uso ausente, a medias o cortado NUNCA sale tarifado a 0: sale
//     `unpriced` o `uncertain`, con un suelo cuando lo hay.
//   · Un modelo sin precio en el catálogo es `unpriced`, nunca coste 0 ni el
//     precio ilustrativo de `DEFAULT_COST_MODEL`.
//   · Una estimación de tokens no es un contador: nunca sale `priced`.
//
// PURO Y SIN ESTADO salvo el libro (en memoria). No toca el cable de uso
// (`USAGE_ALLOWED_FIELDS`) ni ninguna tabla: eso va servidor primero. Interno:
// src/index.ts no lo reexporta (la API de la 0.5 está congelada).

/** De dónde sale el contador. No confundir con `CostBasis`, que dice cómo se valoró el dinero. */
export type UsageBasis =
  /** El objeto `usage` del propio proveedor. */
  | "provider_reported"
  /** Contado por el cliente sobre lo que vio pasar (p. ej. tokenizando un stream sin su usage). */
  | "client_observed"
  /** Estimación local antes o en vez de la llamada. */
  | "estimated";

/** Si llegaron los dos contadores (`complete`), uno (`partial`) o ninguno (`absent`). */
export type UsageCompleteness = "complete" | "partial" | "absent";

/** Uno de los dos contadores sin los que un intento no se puede tarifar. */
export type ContadorDeUso = "input" | "output";

/**
 * El uso de UN intento, en una sola forma para todos los proveedores. Todos los
 * contadores son enteros ≥ 0 y DISJUNTOS: la entrada facturada es
 * `inputUncached + cacheRead + cacheWrite5m + cacheWrite1h`, sin solapes.
 */
export interface AttemptUsage {
  /** Entrada a tarifa normal: ni leída de caché ni escrita en ella. */
  inputUncached: number;
  /** Entrada leída de la caché de prefijo (tarifa cacheada). */
  cacheRead: number;
  /** Entrada escrita en caché con TTL de 5 min (o sin desglose de TTL): prima normal. */
  cacheWrite5m: number;
  /** Entrada escrita en caché con TTL de 1 h (solo Anthropic): prima de 2×. */
  cacheWrite1h: number;
  /** Salida FACTURADA, razonamiento oculto incluido. */
  output: number;
  /**
   * La parte de `output` que fue razonamiento oculto, si el proveedor lo dijo.
   * Ausente ≠ 0 (la misma doctrina que `ProviderUsage.reasoningTokens`).
   */
  reasoning?: number;
  /**
   * Siempre `true` tras normalizar: `reasoning` es un DESGLOSE de `output`, no
   * un sumando. Viaja en el tipo para que nadie lo sume encima al tarifar.
   */
  reasoningIncludedInOutput: true;
  basis: UsageBasis;
  completeness: UsageCompleteness;
  /**
   * Los contadores que no llegaron. Viniendo de un `ProviderUsage` con
   * `complete: false` (ceros puestos por el adaptador) son los que valen 0 y
   * por tanto PUEDEN faltar. Ausente cuando `completeness` es `complete`.
   */
  missing?: ContadorDeUso[];
}

// ── Las formas crudas de cada dialecto ───────────────────────────────────────

/**
 * `usage` de la API de Mensajes de Anthropic. Es también la forma `UsoSse` del
 * gateway (gateway/medidor.ts), a la que el gateway ya mapea Chat y Responses:
 * `input_tokens` EXCLUYE la caché leída y la escrita.
 */
export interface UsoAnthropicCrudo {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  iterations?: unknown;
}

/** `usage` de Chat Completions: `prompt_tokens` INCLUYE la caché leída y la escrita. */
export interface UsoChatCrudo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

/** `usage` de la Responses API: `input_tokens` INCLUYE la caché leída y la escrita. */
export interface UsoResponsesCrudo {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
}

/**
 * El uso de un intento tal como llegó, con su dialecto. `final: false` dice que
 * quien lo pasa sabe que NO es la cuenta final del proveedor: un stream de
 * Anthropic cortado tras `message_start` (su `output_tokens` es provisional),
 * o uno de OpenAI que nunca llegó al chunk de usage.
 */
export type UsoCrudo =
  | { dialecto: "anthropic"; uso: UsoAnthropicCrudo | null | undefined; final?: boolean }
  | { dialecto: "openai-chat"; uso: UsoChatCrudo | null | undefined; final?: boolean }
  | { dialecto: "openai-responses"; uso: UsoResponsesCrudo | null | undefined; final?: boolean }
  /** El `ProviderUsage` del SDK: sus adaptadores ya dejan `inputTokens` como la entrada TOTAL. */
  | { dialecto: "provider-usage"; uso: ProviderUsage | null | undefined };

function entero(n: unknown): n is number {
  // SEGURO, no solo entero: por encima de 2^53 un contador ya perdió unidades
  // al parsearse, y el importe que saldría de él no sería exacto.
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/** Un contador opcional de caché: ausente o ilegible es «no hubo» (0). */
function opcional(n: unknown): number {
  return entero(n) ? n : 0;
}

/**
 * La entrada TOTAL de un dialecto que cuenta la caché dentro (OpenAI) repartida
 * en disjuntos. Si `cached + writes > total` (OpenAI reconoció contadores mal en
 * el arranque de la 5.6) se recorta como el gateway: quedarse corto, jamás
 * inventar entrada.
 */
function repartirTotal(total: number, leidos: number, escritos: number) {
  const cacheRead = Math.min(leidos, total);
  const cacheWrite5m = Math.min(escritos, total - cacheRead);
  return { inputUncached: total - cacheRead - cacheWrite5m, cacheRead, cacheWrite5m, cacheWrite1h: 0 };
}

function cerrar(
  base: Omit<AttemptUsage, "basis" | "completeness" | "missing" | "reasoningIncludedInOutput">,
  faltan: ContadorDeUso[],
  basis: UsageBasis,
): AttemptUsage {
  const completeness: UsageCompleteness = faltan.length === 2 ? "absent" : faltan.length > 0 ? "partial" : "complete";
  return {
    ...base,
    reasoningIncludedInOutput: true,
    basis,
    completeness,
    ...(completeness === "complete" ? {} : { missing: faltan }),
  };
}

const CERO = { inputUncached: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 } as const;

/**
 * El uso de un intento en la forma común. No lanza: lo que no se puede leer se
 * declara (`partial`, `absent`), nunca se rellena con un 0 que parezca medido.
 */
export function normalizarUso(crudo: UsoCrudo, opciones: { basis?: UsageBasis } = {}): AttemptUsage {
  const basis = opciones.basis ?? "provider_reported";
  switch (crudo.dialecto) {
    case "anthropic":
      return deAnthropic(crudo.uso, crudo.final !== false, basis);
    case "openai-chat":
      return deChat(crudo.uso, crudo.final !== false, basis);
    case "openai-responses":
      return deResponses(crudo.uso, crudo.final !== false, basis);
    case "provider-usage":
      return deProviderUsage(crudo.uso, basis);
  }
}

function deAnthropic(u: UsoAnthropicCrudo | null | undefined, final: boolean, basis: UsageBasis): AttemptUsage {
  if (!u) return cerrar(CERO, ["input", "output"], basis);
  // La entrada de `message_start` ya es la final; la salida, no: sin el
  // `message_delta` es un provisional (suele ser 1) y se trata como no llegada.
  const faltan: ContadorDeUso[] = [];
  if (!entero(u.input_tokens)) faltan.push("input");
  if (!final || !entero(u.output_tokens)) faltan.push("output");
  // La compactación del servidor se factura FUERA del primer nivel: se suma
  // (src/providers/iteraciones-de-compactacion.ts, la misma regla que el gateway).
  const extra = extraDeCompactacion(u.iterations);
  // El total de escritura manda y el desglose solo reparte; sin total, se
  // reconstruye del desglose. La parte de 1 h nunca pasa del total.
  const d = u.cache_creation ?? undefined;
  const escritaPrimerNivel = entero(u.cache_creation_input_tokens)
    ? u.cache_creation_input_tokens
    : opcional(d?.ephemeral_5m_input_tokens) + opcional(d?.ephemeral_1h_input_tokens);
  const escrita = escritaPrimerNivel + (extra?.cacheWrite ?? 0);
  const unaHora = Math.min(
    Math.min(opcional(d?.ephemeral_1h_input_tokens), escritaPrimerNivel) + (extra?.cacheWrite1h ?? 0),
    escrita,
  );
  return cerrar(
    {
      inputUncached: opcional(u.input_tokens) + (extra?.input ?? 0),
      cacheRead: opcional(u.cache_read_input_tokens) + (extra?.cacheRead ?? 0),
      cacheWrite5m: escrita - unaHora,
      cacheWrite1h: unaHora,
      output: (final ? opcional(u.output_tokens) : 0) + (extra?.output ?? 0),
      // La API de Mensajes no desglosa el razonamiento: el `thinking` va dentro
      // de `output_tokens` y aquí no se sabe cuánto fue. Ausente, no 0.
    },
    faltan,
    basis,
  );
}

function deChat(u: UsoChatCrudo | null | undefined, final: boolean, basis: UsageBasis): AttemptUsage {
  // En Chat el usage solo viaja en el último chunk: sin final no hay ninguno.
  if (!u || !final) return cerrar(CERO, ["input", "output"], basis);
  const faltan: ContadorDeUso[] = [];
  if (!entero(u.prompt_tokens)) faltan.push("input");
  if (!entero(u.completion_tokens)) faltan.push("output");
  // La salida FACTURADA: `completion_tokens` más lo que `total_tokens` trae de
  // más (el pensamiento del endpoint compatible de Gemini). En OpenAI el hueco
  // es 0 y el razonamiento ya está dentro: no se suma nada dos veces.
  const oculta = salidaOculta(u);
  const declarado = u.completion_tokens_details?.reasoning_tokens;
  const reasoning = oculta > 0 ? Math.max(oculta, opcional(declarado)) : entero(declarado) ? declarado : undefined;
  return cerrar(
    {
      ...repartirTotal(
        opcional(u.prompt_tokens),
        opcional(u.prompt_tokens_details?.cached_tokens),
        opcional(u.prompt_tokens_details?.cache_write_tokens),
      ),
      output: opcional(u.completion_tokens) + oculta,
      ...(reasoning !== undefined ? { reasoning } : {}),
    },
    faltan,
    basis,
  );
}

function deResponses(u: UsoResponsesCrudo | null | undefined, final: boolean, basis: UsageBasis): AttemptUsage {
  if (!u || !final) return cerrar(CERO, ["input", "output"], basis);
  const faltan: ContadorDeUso[] = [];
  if (!entero(u.input_tokens)) faltan.push("input");
  if (!entero(u.output_tokens)) faltan.push("output");
  const declarado = u.output_tokens_details?.reasoning_tokens;
  return cerrar(
    {
      ...repartirTotal(
        opcional(u.input_tokens),
        opcional(u.input_tokens_details?.cached_tokens),
        opcional(u.input_tokens_details?.cache_write_tokens),
      ),
      output: opcional(u.output_tokens),
      ...(entero(declarado) ? { reasoning: declarado } : {}),
    },
    faltan,
    basis,
  );
}

function deProviderUsage(u: ProviderUsage | null | undefined, basis: UsageBasis): AttemptUsage {
  if (!u) return cerrar(CERO, ["input", "output"], basis);
  // Los adaptadores del SDK ya dejan `inputTokens` como la entrada TOTAL (el de
  // Anthropic suma lectura y escritura, anthropic-uso.ts), así que se reparte
  // igual que un total de OpenAI.
  const leidos = opcional(u.cachedInputTokens);
  const escritos = opcional(u.cacheWriteInputTokens);
  const total = opcional(u.inputTokens);
  const cacheRead = Math.min(leidos, total);
  const escrita = Math.min(escritos, total - cacheRead);
  const unaHora = Math.min(opcional(u.cacheWrite1hInputTokens), escrita);
  const base = {
    inputUncached: total - cacheRead - escrita,
    cacheRead,
    cacheWrite5m: escrita - unaHora,
    cacheWrite1h: unaHora,
    output: opcional(u.outputTokens),
    ...(entero(u.reasoningTokens) ? { reasoning: u.reasoningTokens } : {}),
  };
  // `complete: false` = el adaptador rellenó con 0 lo que faltaba, sin decir
  // qué. Un contador distinto de 0 llegó seguro; uno a 0 pudo no llegar. Con
  // todo a 0 no queda nada que el proveedor dijera: ausente. Un contador que no
  // es un entero ≥ 0 tampoco es un contador.
  const faltan: ContadorDeUso[] = [];
  if (u.complete === false) {
    if (total === 0) faltan.push("input");
    if (base.output === 0) faltan.push("output");
  }
  if (!entero(u.inputTokens) && !faltan.includes("input")) faltan.push("input");
  if (!entero(u.outputTokens) && !faltan.includes("output")) faltan.push("output");
  // Incompleto con los dos contadores distintos de 0: no se sabe cuál faltó,
  // pero falta algo. A medias, sin lista que inventar.
  if (u.complete === false && faltan.length === 0) {
    return { ...cerrar(base, [], basis), completeness: "partial", missing: [] };
  }
  return cerrar(base, faltan, basis);
}

// ── La tarifa, en enteros ────────────────────────────────────────────────────

/** Por qué un intento no tiene precio. */
export type MotivoSinPrecio =
  /** No llegó ningún contador. */
  | "usage-absent"
  /** Algún contador no es un entero seguro ≥ 0 (p. ej. una iteración de compactación fraccionaria). */
  | "usage-invalid"
  /** El catálogo no tiene precio para ese modelo ese día. */
  | "no-catalog-price";

/** Por qué un intento tiene un precio que no se puede dar por bueno. */
export type MotivoIncierto =
  /** Falta un contador: lo tarifado es un suelo, no el coste. */
  | "usage-partial"
  /** Los contadores son una estimación local, no del proveedor. */
  | "usage-estimated"
  /** Los contadores los contó el cliente, no el proveedor. */
  | "usage-client-observed"
  /** El precio es el de un pariente del catálogo (`-latest`, `-preview`), no su fila propia. */
  | "inherited-price"
  /** Ni un token de entrada: ningún intento real cuesta eso; huele a contador relleno. */
  | "implausible-zero-input"
  /**
   * Más entrada que el umbral de contexto largo más bajo publicado (200K): por
   * encima, varios proveedores cobran la petición ENTERA a otra tarifa que el
   * catálogo no modela. Lo tarifado a tarifa corta es un suelo.
   */
  | "long-context-tier"
  /** El precio del catálogo no cabe en la unidad entera de esta tarifa. */
  | "price-not-representable";

export type AttemptPrice =
  | {
      state: "priced";
      /** El importe en micro-USD, ENTERO (redondeo al más cercano, mitades hacia arriba). */
      amountMicroUsd: number;
      /** El importe exacto en atto-USD (1e-18), como entero decimal: sumar intentos sin arrastrar redondeos. */
      exactAttoUsd: string;
      currency: "USD";
      /** La versión del catálogo que tarifó (`PRECIOS_AL_DIA`). */
      priceVersion: string;
      /** El día UTC cuyo tramo de precio se aplicó. */
      priceDay: string;
      catalogKey: string;
    }
  | { state: "unpriced"; reason: MotivoSinPrecio; detail: string }
  | {
      state: "uncertain";
      reason: MotivoIncierto;
      detail: string;
      /**
       * Un suelo del coste en micro-USD, ENTERO (por defecto): solo cuando lo
       * que se pudo tarifar es seguro y lo que falta solo puede sumar.
       */
      lowerBoundMicroUsd?: number;
      priceVersion?: string;
    };

// Unidades. El catálogo da USD por 1K tokens en coma flotante; aquí se pasa a
// pico-USD por token (×1e9), que es entero para cualquier precio de lista con
// hasta nueve decimales por 1K. Las primas (1, 1,25, 2) van en centésimas. El
// producto `tokens × pico × centésimas` es un entero en 1e-14 USD; ×1e4, atto.
const ATTO_POR_MICRO = 1_000_000_000_000n;

/**
 * El umbral de contexto largo MÁS BAJO publicado (src/pricing/tarifas-de-tier.ts):
 * «prompts <= 200k tokens» en los Pro de Gemini, 200K en el 1M de Anthropic;
 * 272K en gpt-5.4/5.5/gpt-6, y sin umbral publicado en gpt-5.6. El catálogo solo
 * guarda la tarifa corta y el tramo largo es siempre MAYOR (P4), así que por
 * encima de esto la cifra es un suelo. Se aplica a todos los modelos: en uno de
 * precio plano el coste sale `uncertain` con el suelo exacto, que es el lado que
 * no miente.
 */
const UMBRAL_CONTEXTO_LARGO = 200_000;

const CONTADORES = ["inputUncached", "cacheRead", "cacheWrite5m", "cacheWrite1h", "output"] as const;

function aEnteroExacto(x: number, escala: number): bigint | undefined {
  const v = x * escala;
  const r = Math.round(v);
  if (!Number.isFinite(v) || r < 0 || Math.abs(v - r) > 1e-6) return undefined;
  return BigInt(r);
}

/** Redondeo al más cercano con las mitades hacia arriba (importes ≥ 0). */
function microRedondeado(atto: bigint): number {
  return Number((atto + ATTO_POR_MICRO / 2n) / ATTO_POR_MICRO);
}

function microPorDefecto(atto: bigint): number {
  return Number(atto / ATTO_POR_MICRO);
}

/**
 * El precio de un intento con el catálogo versionado. El orden de las
 * comprobaciones es el contrato: nada ausente se tarifa, nada sin precio se
 * tarifa, y solo un contador completo del proveedor con la fila propia del
 * modelo sale `priced`.
 *
 * @param at el instante de la petición (epoch ms o `Date`): decide el tramo de precio.
 */
export function tarifarIntento(model: string, uso: AttemptUsage, at?: number | Date): AttemptPrice {
  if (uso.completeness === "absent") {
    return { state: "unpriced", reason: "usage-absent", detail: "the provider reported no usage for this attempt" };
  }
  // `AttemptUsage` es un tipo público del módulo: quien lo construye a mano (o
  // una compactación con contadores fraccionarios) no puede tumbar la tarifa
  // con un RangeError de BigInt, ni colar un negativo que reste coste.
  const invalido = CONTADORES.find((k) => !entero(uso[k]));
  if (invalido !== undefined || (uso.reasoning !== undefined && !entero(uso.reasoning))) {
    return {
      state: "unpriced",
      reason: "usage-invalid",
      detail: `counter ${invalido ?? "reasoning"} is not a safe non-negative integer`,
    };
  }
  const instante = at ?? Date.now();
  const dia = diaUtc(instante);
  const lista = precioDeLista(model, instante);
  const clave = claveDeCatalogo(model);
  if (!lista || clave === undefined) {
    return { state: "unpriced", reason: "no-catalog-price", detail: `no list price for ${model} on ${dia}` };
  }
  const propio = precioDeListaPropio(model, instante);

  const pIn = aEnteroExacto(lista.inputPer1k, 1e9);
  const pCache = aEnteroExacto(lista.cachedInputPer1k ?? lista.inputPer1k, 1e9);
  const pOut = aEnteroExacto(lista.outputPer1k, 1e9);
  const prima5m = aEnteroExacto(primaDeEscritura(model), 100);
  const prima1h = aEnteroExacto(primaDeEscritura1h(model), 100);
  if (pIn === undefined || pCache === undefined || pOut === undefined || prima5m === undefined || prima1h === undefined) {
    return {
      state: "uncertain",
      reason: "price-not-representable",
      detail: `the catalog price of ${clave} has more precision than this ledger keeps`,
      priceVersion: PRECIOS_AL_DIA,
    };
  }
  const t = (n: number) => BigInt(n);
  const centiPico =
    t(uso.inputUncached) * pIn * 100n +
    t(uso.cacheRead) * pCache * 100n +
    t(uso.cacheWrite5m) * pIn * prima5m +
    t(uso.cacheWrite1h) * pIn * prima1h +
    // `reasoning` NO aparece: ya está dentro de `output`.
    t(uso.output) * pOut * 100n;
  const atto = centiPico * 10_000n;

  if (uso.basis === "estimated") {
    return { state: "uncertain", reason: "usage-estimated", detail: "a token estimate is not a provider counter", priceVersion: PRECIOS_AL_DIA };
  }
  if (uso.basis === "client_observed") {
    return {
      state: "uncertain",
      reason: "usage-client-observed",
      detail: "counted by the client, not reported by the provider (hidden reasoning is not visible)",
      priceVersion: PRECIOS_AL_DIA,
    };
  }
  if (!propio) {
    // El pariente puede ser más caro o más barato: ni siquiera es un suelo.
    return {
      state: "uncertain",
      reason: "inherited-price",
      detail: `${model} has no catalog row of its own; ${clave}'s price is an approximation`,
      priceVersion: PRECIOS_AL_DIA,
    };
  }
  if (uso.completeness === "partial") {
    return {
      state: "uncertain",
      reason: "usage-partial",
      detail: `missing counter(s): ${(uso.missing ?? []).join(", ") || "unknown"}; priced counters are a floor`,
      lowerBoundMicroUsd: microPorDefecto(atto),
      priceVersion: PRECIOS_AL_DIA,
    };
  }
  if (uso.inputUncached + uso.cacheRead + uso.cacheWrite5m + uso.cacheWrite1h === 0) {
    return {
      state: "uncertain",
      reason: "implausible-zero-input",
      detail: "a billed attempt always carries its prompt; zero input tokens looks like a zero-filled counter",
      lowerBoundMicroUsd: microPorDefecto(atto),
      priceVersion: PRECIOS_AL_DIA,
    };
  }
  const entrada = uso.inputUncached + uso.cacheRead + uso.cacheWrite5m + uso.cacheWrite1h;
  if (entrada > UMBRAL_CONTEXTO_LARGO) {
    return {
      state: "uncertain",
      reason: "long-context-tier",
      detail: `${entrada} input tokens exceed ${UMBRAL_CONTEXTO_LARGO}; the long-context rate is not in the catalog, the short rate is a floor`,
      lowerBoundMicroUsd: microPorDefecto(atto),
      priceVersion: PRECIOS_AL_DIA,
    };
  }
  const importe = microRedondeado(atto);
  if (!Number.isSafeInteger(importe)) {
    return {
      state: "uncertain",
      reason: "price-not-representable",
      detail: "the amount does not fit a safe integer of micro-USD",
      priceVersion: PRECIOS_AL_DIA,
    };
  }
  return {
    state: "priced",
    amountMicroUsd: importe,
    exactAttoUsd: atto.toString(),
    currency: "USD",
    priceVersion: PRECIOS_AL_DIA,
    priceDay: dia,
    catalogKey: clave,
  };
}

// ── Identificadores ──────────────────────────────────────────────────────────

/** El papel del intento dentro de su llamada lógica. */
export type AttemptKind = "primary" | "retry" | "repair" | "discovery" | "fallback";

// La misma forma que `USAGE_ID_PATTERN` del protocolo (packages/protocol), con
// margen para el sufijo del intento: estos ids pueden acabar en el cable el día
// que el servidor los acepte, y no conviene que nazcan sin caber.
const PATRON_DE_ID = /^[A-Za-z0-9._:/-]{1,96}$/;

/** Un id nuevo para una llamada lógica. */
export function nuevoIdDeLlamada(): string {
  return `lc_${randomId()}`;
}

function comprobarIntento(logicalCallId: string, intento: number): void {
  if (!PATRON_DE_ID.test(logicalCallId)) throw new TypeError(`invalid logicalCallId: ${JSON.stringify(logicalCallId)}`);
  if (!Number.isInteger(intento) || intento < 0) throw new TypeError(`invalid attempt ordinal: ${intento}`);
}

/** El id de un intento: la llamada lógica y su ordinal (0 = la primaria). */
export function idDeIntento(logicalCallId: string, intento: number): string {
  comprobarIntento(logicalCallId, intento);
  return `${logicalCallId}:a${intento}`;
}

/**
 * El id DETERMINISTA del evento de uso de un intento: el mismo intento da
 * siempre el mismo id, así que reemitirlo (un reintento del envío, un drenado
 * repetido) se reconoce como el mismo evento y no suma dos veces.
 */
export function idDeEvento(logicalCallId: string, intento: number): string {
  comprobarIntento(logicalCallId, intento);
  return `ev_${sha256(`bvsala/uso-por-intento/v1\u0000${logicalCallId}\u0000${intento}`).slice(0, 32)}`;
}

// ── El recibo y el libro ─────────────────────────────────────────────────────

/** El recibo de UN intento: lo que se apunta, y lo único que se suma. */
export interface ReciboDeIntento {
  eventId: string;
  logicalCallId: string;
  attemptId: string;
  /** Ordinal dentro de la llamada lógica (0 = la primaria). */
  attempt: number;
  kind: AttemptKind;
  model: string;
  /** Epoch ms de la petición: el día que decide el tramo de precio. */
  at: number;
  usage: AttemptUsage;
  price: AttemptPrice;
}

/**
 * `at` decide el tramo de precio. Con un instante no representable `diaUtc`
 * cae a HOY, así que el mismo recibo tarifaría distinto según el día en que se
 * construya, y su huella (donde `NaN` se serializa como `null`) no lo diría.
 */
function comprobarInstante(at: unknown): asserts at is number {
  if (typeof at !== "number" || !Number.isFinite(at) || Math.abs(at) > 8.64e15) {
    throw new TypeError(`invalid attempt instant: ${String(at)}`);
  }
}

/** Construye el recibo de un intento con sus ids y su precio. */
export function reciboDeIntento(d: {
  logicalCallId: string;
  attempt: number;
  kind: AttemptKind;
  model: string;
  at: number;
  usage: AttemptUsage;
}): ReciboDeIntento {
  comprobarInstante(d.at);
  return {
    eventId: idDeEvento(d.logicalCallId, d.attempt),
    logicalCallId: d.logicalCallId,
    attemptId: idDeIntento(d.logicalCallId, d.attempt),
    attempt: d.attempt,
    kind: d.kind,
    model: d.model,
    at: d.at,
    usage: structuredClone(d.usage),
    price: tarifarIntento(d.model, d.usage, d.at),
  };
}

/**
 * El mismo `eventId` con OTRO cuerpo. No hay resultado razonable que elegir:
 * quedarse con el primero esconde el segundo, quedarse con el segundo reescribe
 * lo ya apuntado. Se lanza y lo decide quien llama.
 */
export class ConflictoDeRecibo extends Error {
  readonly eventId: string;
  constructor(eventId: string, motivo: string) {
    super(`receipt conflict on ${eventId}: ${motivo}`);
    this.name = "ConflictoDeRecibo";
    this.eventId = eventId;
  }
}

/** El total de una llamada lógica: TODOS sus intentos, y cuántos no se pudieron tarifar. */
export interface TotalDeLlamada {
  logicalCallId: string;
  attempts: number;
  byKind: Partial<Record<AttemptKind, number>>;
  priced: number;
  unpriced: number;
  uncertain: number;
  /**
   * `priced`: todos los intentos tienen precio y `amountMicroUsd` es el coste.
   * `partial`: alguno no; `amountMicroUsd` no existe y queda el suelo.
   * `unpriced`: ninguno tiene precio ni suelo.
   */
  state: "priced" | "partial" | "unpriced";
  /** El coste de la llamada, solo con `state: "priced"`: la suma exacta redondeada UNA vez. */
  amountMicroUsd?: number;
  /** Suelo del coste: lo tarifado más los suelos de los inciertos (por defecto). */
  lowerBoundMicroUsd: number;
  /** Las versiones del catálogo que tarifaron (más de una si la llamada cruzó un cambio). */
  priceVersions: string[];
  /** Contadores sumados de todos los intentos, completos o no. */
  tokens: Pick<AttemptUsage, "inputUncached" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h" | "output">;
  /** Intentos cuyo uso no llegó entero (`partial` o `absent`). */
  incompleteAttempts: number;
}

/**
 * Libro en memoria de recibos de intento, idempotente por `eventId`:
 *   · mismo id y mismo cuerpo → no-op (`"repetido"`), el total no se mueve;
 *   · mismo id y otro cuerpo → `ConflictoDeRecibo`, nunca un resultado al azar;
 *   · un `eventId` que no es el derivado de su intento → `ConflictoDeRecibo`
 *     (dos ids para el mismo intento serían una puerta a contarlo dos veces);
 *   · un `price` que no es el que `tarifarIntento` da para su uso, modelo e
 *     instante → `ConflictoDeRecibo` (nada entra en el total sin salir de su uso).
 *
 * Devuelve copias: lo apuntado no se puede tocar desde fuera.
 */
export class LibroDeRecibos {
  private readonly porEvento = new Map<string, { huella: string; recibo: ReciboDeIntento }>();
  private readonly porLlamada = new Map<string, string[]>();

  registrar(recibo: ReciboDeIntento): "registrado" | "repetido" {
    const esperado = idDeEvento(recibo.logicalCallId, recibo.attempt);
    if (recibo.eventId !== esperado) {
      throw new ConflictoDeRecibo(recibo.eventId, `expected ${esperado} for ${recibo.logicalCallId} attempt ${recibo.attempt}`);
    }
    if (recibo.attemptId !== idDeIntento(recibo.logicalCallId, recibo.attempt)) {
      throw new ConflictoDeRecibo(recibo.eventId, `attemptId ${recibo.attemptId} does not match attempt ${recibo.attempt}`);
    }
    comprobarInstante(recibo.at);
    // El precio es lo ÚNICO que se suma, y un recibo puede venir de fuera de
    // `reciboDeIntento` (deserializado, hecho a mano): un «priced 0» sobre un
    // uso ausente entraría en el total como medido. Se recalcula y se compara.
    const esperadoPrecio = tarifarIntento(recibo.model, recibo.usage, recibo.at);
    if (stableStringify(esperadoPrecio) !== stableStringify(recibo.price)) {
      throw new ConflictoDeRecibo(recibo.eventId, "price does not follow from its usage, model and instant");
    }
    const huella = sha256(stableStringify(recibo));
    const previo = this.porEvento.get(recibo.eventId);
    if (previo) {
      if (previo.huella === huella) return "repetido";
      throw new ConflictoDeRecibo(recibo.eventId, "same event id, different body");
    }
    this.porEvento.set(recibo.eventId, { huella, recibo: structuredClone(recibo) });
    const lista = this.porLlamada.get(recibo.logicalCallId) ?? [];
    lista.push(recibo.eventId);
    this.porLlamada.set(recibo.logicalCallId, lista);
    return "registrado";
  }

  /** Los recibos de una llamada lógica, por ordinal. */
  recibos(logicalCallId: string): ReciboDeIntento[] {
    return (this.porLlamada.get(logicalCallId) ?? [])
      .map((id) => structuredClone(this.porEvento.get(id)!.recibo))
      .sort((a, b) => a.attempt - b.attempt);
  }

  /** El total de una llamada lógica, o `undefined` si no tiene ningún recibo. */
  total(logicalCallId: string): TotalDeLlamada | undefined {
    const recibos = this.recibos(logicalCallId);
    if (recibos.length === 0) return undefined;
    const byKind: Partial<Record<AttemptKind, number>> = {};
    const tokens = { inputUncached: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };
    const versiones = new Set<string>();
    let priced = 0;
    let unpriced = 0;
    let uncertain = 0;
    let incompleteAttempts = 0;
    let exacto = 0n;
    let suelos = 0;
    for (const r of recibos) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      for (const k of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[k] += r.usage[k];
      if (r.usage.completeness !== "complete") incompleteAttempts += 1;
      const p = r.price;
      if (p.state === "priced") {
        priced += 1;
        exacto += BigInt(p.exactAttoUsd);
        versiones.add(p.priceVersion);
      } else if (p.state === "uncertain") {
        uncertain += 1;
        suelos += p.lowerBoundMicroUsd ?? 0;
        if (p.priceVersion) versiones.add(p.priceVersion);
      } else {
        unpriced += 1;
      }
    }
    const state: TotalDeLlamada["state"] =
      priced === recibos.length ? "priced" : priced === 0 && suelos === 0 ? "unpriced" : "partial";
    return {
      logicalCallId,
      attempts: recibos.length,
      byKind,
      priced,
      unpriced,
      uncertain,
      state,
      ...(state === "priced" ? { amountMicroUsd: microRedondeado(exacto) } : {}),
      lowerBoundMicroUsd: microPorDefecto(exacto) + suelos,
      priceVersions: [...versiones].sort(),
      tokens,
      incompleteAttempts,
    };
  }
}
