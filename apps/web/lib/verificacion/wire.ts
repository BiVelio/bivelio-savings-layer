/**
 * «TU PROPIO BANCO» — EL VALIDADOR DEL CABLE de la verificación A/B opcional
 * del SDK (`POST /api/metering/verification`), en puro.
 *
 * DOCTRINA: instrumento, JAMÁS base. Estos pares viajan por su canal propio a
 * sus tablas propias (0030) y nunca tocan `ingest_usage_batch`, `usage_daily`,
 * `measured_*`, extractos ni comisión. `test/banco-propio-nunca-factura.test.ts`
 * lo vigila en las dos direcciones.
 *
 * Es también la fuente de las constantes que comparten la ruta, el panel y el
 * CSV (estratos, exclusiones, resultados).
 *
 * LISTA BLANCA, como el ingest de uso: una clave desconocida tumba el lote
 * (400). Es el cortafuegos que impide que se cuele contenido del cliente (un
 * prompt, una respuesta) en un campo nuevo. Solo cuentas, ids y tarifas.
 */

export const ESTRATOS = ["avoided_call", "cheaper_model", "tokens_removed", "tokens_compressed", "unchanged"] as const;
export type Estrato = (typeof ESTRATOS)[number];

export const EXCLUSIONES = [
  "fail_open",
  "truncated",
  "incomplete",
  "contract_failed",
  "unmeasured",
  "no_price",
  "over_cap",
  "opted_out",
  "retrieval",
] as const;
export type Exclusion = (typeof EXCLUSIONES)[number];

export const CATEGORIAS = [...ESTRATOS, ...EXCLUSIONES] as const;
export type Categoria = (typeof CATEGORIAS)[number];

export const RESULTADOS = ["paired", "check_failed", "check_unmeasured", "abandoned", "dropped"] as const;
export type Resultado = (typeof RESULTADOS)[number];

export const CONTRATOS = ["met", "missed", "none"] as const;
export type ContratoDeLaCopia = (typeof CONTRATOS)[number];

/** Los valores de `CacheOutcome` del SDK. */
export const RESULTADOS_DE_CACHE = ["miss", "exact", "semantic", "singleflight", "deterministic"] as const;

export const MAX_MUESTRAS_POR_LOTE = 500;
export const MAX_CONTEOS_POR_LOTE = 200;
/** Tolerancia de la comprobación de consistencia del coste de la copia (D15). */
export const TOLERANCIA_DE_COSTE = 2e-10;
/** Tope de dinero por lado y de tarifa por 1K: por encima, un número que no es un coste. */
export const MAX_USD = 1000;
export const MAX_PETICIONES_POR_CONTEO = 10_000_000;
/** Un `at` más de 48 h en el futuro es un reloj roto, no una petición. */
export const FUTURO_MAXIMO_MS = 48 * 3600 * 1000;
/** Conteos aceptados: días UTC en [hoy − 30, hoy + 1]. */
export const DIAS_DE_CONTEO_ATRAS = 30;

/** El mismo patrón de identidad que el ingest de uso (`USAGE_ID_PATTERN`). */
export const PATRON_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
const PATRON_LOTE = /^[A-Za-z0-9-]{8,64}$/;
const PATRON_FIN = /^[a-z_]{1,32}$/;
const DIA = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const CLAVES_DEL_SOBRE = ["batchId", "counts", "samples"];
const CLAVES_DEL_CONTEO = ["category", "day", "requests"];
const CLAVES_OBLIGATORIAS = [
  "basis",
  "requestId",
  "at",
  "stratum",
  "outcome",
  "requestedModel",
  "servedModel",
  "cacheResult",
  "optimizedCost",
  "optimizedInputTokens",
  "optimizedCachedInputTokens",
  "optimizedOutputTokens",
  "inputPer1k",
  "outputPer1k",
] as const;
const CLAVES_DE_LA_COPIA = ["naiveCost", "naiveInputTokens", "naiveCachedInputTokens", "naiveOutputTokens", "naiveContract"] as const;
const CLAVES_OPCIONALES = ["naiveFinishReason", "cachedInputPer1k"] as const;
const CLAVES_DE_LA_MUESTRA = new Set<string>([...CLAVES_OBLIGATORIAS, ...CLAVES_DE_LA_COPIA, ...CLAVES_OPCIONALES]);

/**
 * La lista blanca ENTERA del cable, por nivel, tal como la aplica este
 * validador. Es lo que enumera la página pública de privacidad
 * (`app/[locale]/privacy`, vía `lib/legal/lo-que-sale.ts`); su test compara
 * los dos conjuntos, así que una clave nueva aquí sin su línea en la página
 * pone la suite en rojo.
 */
export const CAMPOS_DEL_CABLE_DE_VERIFICACION: {
  readonly sobre: readonly string[];
  readonly conteo: readonly string[];
  readonly muestra: readonly string[];
} = Object.freeze({
  sobre: Object.freeze([...CLAVES_DEL_SOBRE]),
  conteo: Object.freeze([...CLAVES_DEL_CONTEO]),
  muestra: Object.freeze([...CLAVES_DE_LA_MUESTRA]),
});

/** Una muestra validada, tal como la recibe `ingest_verification_batch`. */
export interface MuestraDeVerificacion {
  basis: "verification";
  requestId: string;
  at: number;
  stratum: Estrato;
  outcome: Resultado;
  requestedModel: string;
  servedModel: string;
  cacheResult: string;
  optimizedCost: number;
  optimizedInputTokens: number;
  optimizedCachedInputTokens: number;
  optimizedOutputTokens: number;
  naiveCost?: number;
  naiveInputTokens?: number;
  naiveCachedInputTokens?: number;
  naiveOutputTokens?: number;
  naiveFinishReason?: string;
  naiveContract?: ContratoDeLaCopia;
  inputPer1k: number;
  cachedInputPer1k?: number;
  outputPer1k: number;
}

export interface ConteoDeVerificacion {
  day: string;
  category: Categoria;
  requests: number;
}

export interface LoteDeVerificacion {
  batchId: string;
  samples: MuestraDeVerificacion[];
  counts: ConteoDeVerificacion[];
  /** Muestras y conteos descartados sin romper el lote (incoherentes, repetidos o fuera de ventana). */
  dropped: number;
}

export class VerificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationValidationError";
  }
}

/**
 * El precio de una copia, PORTADO TAL CUAL de `src/verification/precio.ts` del
 * SDK (la misma aritmética que `SavingsLedger.estimateCost` aplica a `actual`).
 * La comprobación de consistencia lo recalcula: cada fila del CSV se puede
 * rehacer con sus propios tokens y tarifas.
 */
export function precioDelUso(
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
  p: { inputPer1k: number; outputPer1k: number; cachedInputPer1k?: number },
): number {
  const entrada = usage.inputTokens;
  const cached = Math.min(usage.cachedInputTokens ?? 0, entrada);
  const cachedRate = p.cachedInputPer1k ?? p.inputPer1k;
  const coste =
    (Math.max(0, entrada - cached) / 1000) * p.inputPer1k +
    (cached / 1000) * cachedRate +
    (usage.outputTokens / 1000) * p.outputPer1k;
  return Math.round(coste * 1e10) / 1e10;
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function dinero(v: unknown, campo: string, donde: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_USD) {
    throw new VerificationValidationError(`field "${campo}" must be a finite number from 0 to ${MAX_USD} in ${donde}`);
  }
  return v;
}

function tokens(v: unknown, campo: string, donde: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new VerificationValidationError(`field "${campo}" must be a non-negative integer in ${donde}`);
  }
  return v;
}

function identidad(v: unknown, campo: string, donde: string): string {
  if (typeof v !== "string" || !PATRON_ID.test(v)) {
    throw new VerificationValidationError(`field "${campo}" must match ${PATRON_ID} in ${donde}`);
  }
  return v;
}

function deLista<T extends string>(v: unknown, lista: readonly T[], campo: string, donde: string): T {
  if (typeof v !== "string" || !(lista as readonly string[]).includes(v)) {
    throw new VerificationValidationError(`field "${campo}" must be one of ${lista.join("|")} in ${donde}`);
  }
  return v as T;
}

/** El día UTC de `ms`, `YYYY-MM-DD`. */
export function diaUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function esDia(s: string): boolean {
  if (!DIA.test(s)) return false;
  return new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

type Validada = { muestra: MuestraDeVerificacion } | { descartada: true };

function validarMuestra(input: unknown, i: number, ahora: number): Validada {
  const donde = `sample ${i}`;
  if (!esObjeto(input)) throw new VerificationValidationError(`${donde} must be an object`);
  for (const k of Object.keys(input)) {
    if (!CLAVES_DE_LA_MUESTRA.has(k)) throw new VerificationValidationError(`unknown field "${k}" in ${donde}`);
  }
  for (const k of CLAVES_OBLIGATORIAS) {
    if (input[k] === undefined) throw new VerificationValidationError(`missing field "${k}" in ${donde}`);
  }
  if (input["basis"] !== "verification") {
    throw new VerificationValidationError(`field "basis" must be "verification" in ${donde}`);
  }
  const at = input["at"];
  if (typeof at !== "number" || !Number.isInteger(at) || at < 1e12 || at > ahora + FUTURO_MAXIMO_MS) {
    throw new VerificationValidationError(`field "at" must be an integer epoch in ms, not in the future, in ${donde}`);
  }
  const outcome = deLista(input["outcome"], RESULTADOS, "outcome", donde);
  const m: MuestraDeVerificacion = {
    basis: "verification",
    requestId: identidad(input["requestId"], "requestId", donde),
    at,
    stratum: deLista(input["stratum"], ESTRATOS, "stratum", donde),
    outcome,
    requestedModel: identidad(input["requestedModel"], "requestedModel", donde),
    servedModel: identidad(input["servedModel"], "servedModel", donde),
    cacheResult: deLista(input["cacheResult"], RESULTADOS_DE_CACHE, "cacheResult", donde),
    optimizedCost: dinero(input["optimizedCost"], "optimizedCost", donde),
    optimizedInputTokens: tokens(input["optimizedInputTokens"], "optimizedInputTokens", donde),
    optimizedCachedInputTokens: tokens(input["optimizedCachedInputTokens"], "optimizedCachedInputTokens", donde),
    optimizedOutputTokens: tokens(input["optimizedOutputTokens"], "optimizedOutputTokens", donde),
    inputPer1k: dinero(input["inputPer1k"], "inputPer1k", donde),
    outputPer1k: dinero(input["outputPer1k"], "outputPer1k", donde),
  };
  if (m.optimizedCachedInputTokens > m.optimizedInputTokens) {
    throw new VerificationValidationError(`optimizedCachedInputTokens cannot exceed optimizedInputTokens in ${donde}`);
  }
  if (input["cachedInputPer1k"] !== undefined) {
    m.cachedInputPer1k = dinero(input["cachedInputPer1k"], "cachedInputPer1k", donde);
  }

  // Las claves de la copia: TODAS si y solo si el resultado es `paired`.
  const hayCopia = [...CLAVES_DE_LA_COPIA, "naiveFinishReason"].some((k) => input[k] !== undefined);
  if (outcome !== "paired") {
    if (hayCopia) throw new VerificationValidationError(`naive fields are only allowed when outcome is "paired" (${donde})`);
    return { muestra: m };
  }
  for (const k of CLAVES_DE_LA_COPIA) {
    if (input[k] === undefined) throw new VerificationValidationError(`missing field "${k}" in ${donde} (outcome "paired")`);
  }
  m.naiveCost = dinero(input["naiveCost"], "naiveCost", donde);
  m.naiveInputTokens = tokens(input["naiveInputTokens"], "naiveInputTokens", donde);
  m.naiveCachedInputTokens = tokens(input["naiveCachedInputTokens"], "naiveCachedInputTokens", donde);
  m.naiveOutputTokens = tokens(input["naiveOutputTokens"], "naiveOutputTokens", donde);
  if (m.naiveCachedInputTokens > m.naiveInputTokens) {
    throw new VerificationValidationError(`naiveCachedInputTokens cannot exceed naiveInputTokens in ${donde}`);
  }
  m.naiveContract = deLista(input["naiveContract"], CONTRATOS, "naiveContract", donde);
  if (input["naiveFinishReason"] !== undefined) {
    const f = input["naiveFinishReason"];
    if (typeof f !== "string" || !PATRON_FIN.test(f)) {
      throw new VerificationValidationError(`field "naiveFinishReason" must match ${PATRON_FIN} in ${donde}`);
    }
    m.naiveFinishReason = f;
  }
  // CONSISTENCIA (D15): el coste de la copia tiene que salir de sus tokens a sus
  // tarifas. Nada de esto se factura, así que no hay techo de precios; lo que se
  // garantiza es que cada fila del CSV se pueda recalcular. Una incoherente se
  // descarta sola, sin tumbar el lote.
  const recalculado = precioDelUso(
    { inputTokens: m.naiveInputTokens, outputTokens: m.naiveOutputTokens, cachedInputTokens: m.naiveCachedInputTokens },
    m,
  );
  if (Math.abs(m.naiveCost - recalculado) > TOLERANCIA_DE_COSTE) return { descartada: true };
  return { muestra: m };
}

function validarConteo(input: unknown, i: number, hoyMs: number): ConteoDeVerificacion | null {
  const donde = `count ${i}`;
  if (!esObjeto(input)) throw new VerificationValidationError(`${donde} must be an object`);
  for (const k of Object.keys(input)) {
    if (!CLAVES_DEL_CONTEO.includes(k)) throw new VerificationValidationError(`unknown field "${k}" in ${donde}`);
  }
  for (const k of CLAVES_DEL_CONTEO) {
    if (input[k] === undefined) throw new VerificationValidationError(`missing field "${k}" in ${donde}`);
  }
  const category = deLista(input["category"], CATEGORIAS, "category", donde);
  const requests = input["requests"];
  if (typeof requests !== "number" || !Number.isInteger(requests) || requests < 1 || requests > MAX_PETICIONES_POR_CONTEO) {
    throw new VerificationValidationError(`field "requests" must be an integer from 1 to ${MAX_PETICIONES_POR_CONTEO} in ${donde}`);
  }
  const day = input["day"];
  // Un día raro o fuera de ventana no rompe el lote: se descarta ese conteo.
  if (typeof day !== "string" || !esDia(day)) return null;
  const desde = diaUtc(hoyMs - DIAS_DE_CONTEO_ATRAS * 86_400_000);
  const hasta = diaUtc(hoyMs + 86_400_000);
  if (day < desde || day > hasta) return null;
  return { day, category, requests };
}

/**
 * Valida un sobre del SDK. Lanza `VerificationValidationError` (→ 400) ante un
 * error ESTRUCTURAL; descarta sin romper el lote lo que es un dato suelto malo
 * (coste incoherente, día fuera de ventana, `requestId` repetido).
 */
export function parseVerificationBatch(body: unknown, ahora: number): LoteDeVerificacion {
  if (!esObjeto(body)) throw new VerificationValidationError("body must be an object with batchId, samples and counts");
  const claves = Object.keys(body).sort();
  if (claves.join(",") !== CLAVES_DEL_SOBRE.join(",")) {
    const extra = claves.find((k) => !CLAVES_DEL_SOBRE.includes(k));
    throw new VerificationValidationError(
      extra ? `unknown field "${extra}" in body` : "body must have exactly batchId, samples and counts",
    );
  }
  const batchId = body["batchId"];
  if (typeof batchId !== "string" || !PATRON_LOTE.test(batchId)) {
    throw new VerificationValidationError(`field "batchId" must match ${PATRON_LOTE}`);
  }
  const samples = body["samples"];
  const counts = body["counts"];
  if (!Array.isArray(samples) || !Array.isArray(counts)) {
    throw new VerificationValidationError("samples and counts must be arrays");
  }
  if (samples.length > MAX_MUESTRAS_POR_LOTE) {
    throw new VerificationValidationError(`batch too large (max ${MAX_MUESTRAS_POR_LOTE} samples)`);
  }
  if (counts.length > MAX_CONTEOS_POR_LOTE) {
    throw new VerificationValidationError(`batch too large (max ${MAX_CONTEOS_POR_LOTE} counts)`);
  }

  let dropped = 0;
  const vistos = new Set<string>();
  const muestras: MuestraDeVerificacion[] = [];
  samples.forEach((s, i) => {
    const v = validarMuestra(s, i, ahora);
    if ("descartada" in v) {
      dropped++;
      return;
    }
    if (vistos.has(v.muestra.requestId)) {
      dropped++;
      return;
    }
    vistos.add(v.muestra.requestId);
    muestras.push(v.muestra);
  });
  const conteos: ConteoDeVerificacion[] = [];
  counts.forEach((c, i) => {
    const v = validarConteo(c, i, ahora);
    if (v) conteos.push(v);
    else dropped++;
  });
  return { batchId, samples: muestras, counts: conteos, dropped };
}

/**
 * El interruptor de incidencias `BVSALA_INGEST_VERIFICATION_OFF`. Falla hacia
 * ENCENDIDO: `1`/`true`/`yes`/`on` lo encienden, y un valor que no se reconoce
 * también (con aviso) — quien lo pone durante un incidente quiere cortar.
 */
export function leerInterruptorVerificacion(valor: string | undefined): { activo: boolean; reconocido: boolean } {
  const v = (valor ?? "").trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no" || v === "off") return { activo: false, reconocido: true };
  if (v === "1" || v === "true" || v === "yes" || v === "on") return { activo: true, reconocido: true };
  return { activo: true, reconocido: false };
}
