/**
 * Usage ingest content backstop (server-side). A faithful port of
 * `@bivelio/protocol` `parseUsageRecords`: the control plane accepts ONLY
 * counts/metadata — this allow-list REJECTS any field outside the set at runtime,
 * so a prompt/completion can never be smuggled into the metering path. Reimplemented
 * here (not imported) to keep the web app free of a workspace dependency, mirroring
 * how the license routes reimplement the signing primitive.
 *
 * `orgId` is NEVER taken from the body — the route derives it from the authenticated
 * service account. Identity fields are charset-constrained so a free-text string
 * cannot become a value channel for content.
 */
import { REGLA_REFERENCIA } from "../billing/tarifa";
import {
  recortarNativo,
  recortarSuelo,
  TECHO_PRECIO_LECTURA_PER_1K,
  TECHO_PRECIO_SALIDA_PER_1K,
} from "./techo-precio-lectura";

export class UsageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageValidationError";
  }
}

const USAGE_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
// Umbral de unidad de `at`. No es una "época del producto" arbitraria: es la
// frontera que separa SEGUNDOS de MILISEGUNDOS. Un epoch en segundos vale hoy
// ~1,79e9, que interpretado como ms cae en enero de 1970 y hace desaparecer el
// lote del panel y del mes facturable; cualquier ms real está por encima de
// 1e12 (2001). Tres órdenes de magnitud de margen, cero falsos positivos.
const AT_MIN_MS = 1e12;
const AT_MAX_SKEW_MS = 48 * 60 * 60 * 1000;

const USAGE_ID_FIELDS = ["requestId", "model"] as const;
const USAGE_CACHE_RESULTS = new Set(["miss", "exact", "semantic", "singleflight", "deterministic"]);
const USAGE_NUMBER_FIELDS = [
  "at", "avoidedLlm", "actualLlm",
  "baselineInputTokens", "actualInputTokens", "eliminatedInputTokens", "compressedInputTokens",
  "baselineOutputTokens", "actualOutputTokens", "providerCachedInputTokens",
  "baselineCost", "actualCost", "netSavings",
] as const;
// orgId is server-derived (never trusted from the body). seatId is the machine
// identity; ci flags CI/ephemeral seats (excluded from billable seats).
/** Valores admitidos en `basis` (espejo de CostBasis del SDK). "shadow" es el
 *  carril hipotético de S2 (migración 0021): la RPC lo acumula SOLO en las
 *  columnas shadow_* — jamás en la base de la comisión ni en measured.
 *  "reference" es el carril MEDIDO POR REFERENCIA (migración 0029): una llamada
 *  evitada valorada con el contador del proveedor de la petición idéntica que sí
 *  corrió. La RPC lo acumula en reference_* (jamás en measured_*) y la web decide
 *  si entra en la base (COMISIONAR_REFERENCIA, lib/billing/tarifa.ts). */
const USAGE_BASIS = new Set(["measured", "reference", "estimated", "unmeasured", "shadow"]);

/**
 * Dinero OPCIONAL del carril de la elisión del proveedor (migración 0025):
 * `eliminatedInputFloorCost` = los tokens que el proveedor borró valorados al
 * precio de LECTURA de caché (suelo). OPCIONAL a propósito, y JAMÁS en
 * USAGE_NUMBER_FIELDS: esos son obligatorios y convertirían en 400 el lote de
 * todo gateway ≤ 0.4.16, que no lo emite. Va a su columna propia; nunca a
 * measured_* ni a la comisión (COMISIONAR_ELISION_SUELO en lib/billing/tarifa.ts).
 */
const USAGE_OPTIONAL_MONEY_FIELDS = ["eliminatedInputFloorCost"] as const;

/**
 * Los dos campos OPCIONALES del carril medido por referencia (0029): qué
 * petición sirvió de referencia (`referenceRequestId`, su report.requestId) y
 * cuándo se leyó su contador (`referenceAt`, epoch ms). Van a la fila de
 * reference_hits (el CSV del cliente). RECORTE, NO RECHAZO: un valor malo se
 * descarta y se cuenta; jamás un 400 por esto (el emisor descarta el lote
 * entero sin reintento y npm es inmutable).
 */
const USAGE_OPTIONAL_REFERENCE_FIELDS = ["referenceRequestId", "referenceAt"] as const;

/**
 * El AHORRO NATIVO (migración 0032): lo que la caché de prefijo DEL PROVEEDOR le
 * quitó a la factura de la petición, en dos cifras no negativas —el descuento de
 * lectura y la prima de escritura, USD— calculadas por el cliente con el
 * contador del proveedor a precio de lista (report.nativeSavings).
 *
 * NUNCA COMISIONABLE, por construcción y no por interruptor: van a sus columnas
 * propias (native_*), jamás a baseline/actual ni a measured_*, y
 * lib/billing/extracto.ts no las lee para la base. No cambian `basis` ni ningún
 * otro campo del registro (usage-nativo.test.ts lo afirma). OPCIONALES: un
 * cliente anterior no las manda y sigue en 202. RECORTE, NO RECHAZO en el
 * dominio (techo de entrada por token); tipo y signo sí se rechazan.
 */
const USAGE_OPTIONAL_NATIVE_FIELDS = ["nativeCacheReadSavings", "nativeCacheWritePremium"] as const;

const USAGE_ALLOWED_FIELDS = new Set<string>([
  "orgId", "seatId", "ci", "cacheResult", "basis", "sessionId", "agentId",
  ...USAGE_ID_FIELDS,
  ...USAGE_NUMBER_FIELDS,
  ...USAGE_OPTIONAL_MONEY_FIELDS,
  ...USAGE_OPTIONAL_REFERENCE_FIELDS,
  ...USAGE_OPTIONAL_NATIVE_FIELDS,
]);

/**
 * La lista blanca del registro de uso, tal cual la aplica `parseUsageRecord`,
 * y las etiquetas de `basis` que admite. Las lee la web pública: la página de
 * privacidad enumera los campos (su test compara los dos conjuntos: un campo
 * nuevo aquí sin su línea en la página pone la suite en rojo) y la de precios
 * dice qué etiquetas nunca llevan comisión.
 */
export const CAMPOS_DEL_REGISTRO_DE_USO: readonly string[] = Object.freeze([...USAGE_ALLOWED_FIELDS]);
export const ETIQUETAS_DE_BASIS: readonly string[] = Object.freeze([...USAGE_BASIS]);

/** Resultados de acierto que pueden valorarse por referencia: el exacto y el seguidor coalescido. */
const REFERENCE_CACHE_RESULTS = new Set(["exact", "singleflight"]);

/**
 * Tolerancia del techo: la granularidad del redondeo del SDK (roundUsd, 1e-10
 * USD). Sin ella, un baseline exactamente en el techo podía caer una
 * diezmilmillonésima por encima al redondear.
 */
const TOLERANCIA_REDONDEO_USD = 1e-10;

/**
 * La EDAD máxima del contador de referencia: la de la regla PUBLICADA en el
 * extracto («at most {dias} days old», REGLA_REFERENCIA.edadMaximaDias), en ms.
 * Derivada de la regla, no copiada: si la regla cambia, la verja cambia con ella.
 */
export const EDAD_MAXIMA_REFERENCIA_MS = REGLA_REFERENCIA.edadMaximaDias * 24 * 60 * 60 * 1000;
/**
 * Desfase de reloj tolerado entre el proceso que pobló la referencia y el que
 * la sirvió (5 min, el mismo margen que el SDK en su lectura). Se admite en
 * los DOS lados: un `referenceAt` algo posterior al `at` del acierto y un
 * acierto leído justo en el límite de edad cuyo `at` se selló milisegundos
 * después.
 */
export const DESFASE_RELOJ_REFERENCIA_MS = 5 * 60 * 1000;

export interface UsageRecord {
  orgId: string;
  /** Opcional (0025): tokens borrados por el proveedor valorados a precio SUELO de lectura. Recortado al techo; jamás en measured. */
  eliminatedInputFloorCost?: number;
  /** Opcional (0032): descuento de la caché del proveedor en lectura, USD. Carril propio; jamás comisionable. */
  nativeCacheReadSavings?: number;
  /** Opcional (0032): prima de escritura de la caché del proveedor, USD. Carril propio; jamás comisionable. */
  nativeCacheWritePremium?: number;
  /** Opcional (0029), solo con basis "reference": el report.requestId de la petición que sirvió de referencia. */
  referenceRequestId?: string;
  /** Opcional (0029), solo con basis "reference": epoch ms en que se leyó el contador de esa petición. */
  referenceAt?: number;
  seatId?: string;
  ci?: boolean;
  requestId: string;
  model: string;
  cacheResult: string;
  at: number;
  [k: string]: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate one untrusted usage record; orgId is server-supplied, never from the body. */
type Recorte = { recibido: number; tokens: number; guardado: number };

/** Lo que la verja del carril por referencia rebajó en un lote: se avisa UNA vez por lote. */
export interface DescartesDeReferencia {
  /** Registros con basis "reference" incoherente, degradados a "estimated". */
  degradados: number;
  /** Valores de referenceRequestId / referenceAt descartados por forma o rango. */
  camposDescartados: number;
}

/**
 * ¿Es coherente un registro que dice basis "reference"? Una referencia es, por
 * definición, una llamada EVITADA (acierto exacto o seguidor) sin coste propio,
 * con baseline positivo y por debajo del techo: toda su entrada, como mucho, al
 * mayor precio de LECTURA del catálogo y su salida al mayor precio de salida. El
 * servidor no conoce precios; esta cota es lo que sí puede comprobar. Lo que no
 * casa se DEGRADA a estimated — nunca se rechaza.
 *
 * Y lleva PUNTERO: el extracto promete que cada repetición «is in that
 * request's report» y el CSV la ata a la petición que corrió. Sin
 * `referenceRequestId` y `referenceAt` válidos (ya filtrados por forma arriba)
 * esa fila no se podría contrastar, así que no se factura como referencia. Y
 * la edad que el extracto publica (REGLA_REFERENCIA.edadMaximaDias) se
 * comprueba aquí también, con `at − referenceAt`: el SDK lo hace al leer, pero
 * la regla publicada no puede depender solo de quien emite.
 *
 * Una llamada evitada tampoco tiene tokens quitados, comprimidos ni cacheados
 * por el proveedor, ni suelo de elisión: si los trae, no es lo que dice ser.
 */
function referenciaCoherente(rec: Record<string, unknown>): boolean {
  const n = (k: string) => rec[k] as number;
  if (!REFERENCE_CACHE_RESULTS.has(rec["cacheResult"] as string)) return false;
  if (n("avoidedLlm") !== 1 || n("actualLlm") !== 0) return false;
  if (n("actualInputTokens") !== 0 || n("actualOutputTokens") !== 0 || n("actualCost") !== 0) return false;
  if (n("eliminatedInputTokens") !== 0 || n("compressedInputTokens") !== 0 || n("providerCachedInputTokens") !== 0) {
    return false;
  }
  if (rec["eliminatedInputFloorCost"] !== undefined && rec["eliminatedInputFloorCost"] !== 0) return false;
  if (n("netSavings") !== 1) return false;
  if (!(n("baselineInputTokens") > 0) || !(n("baselineCost") > 0)) return false;
  if (typeof rec["referenceRequestId"] !== "string" || typeof rec["referenceAt"] !== "number") return false;
  const edad = n("at") - n("referenceAt");
  if (edad < -DESFASE_RELOJ_REFERENCIA_MS || edad > EDAD_MAXIMA_REFERENCIA_MS + DESFASE_RELOJ_REFERENCIA_MS) return false;
  const techo =
    (n("baselineInputTokens") / 1_000) * TECHO_PRECIO_LECTURA_PER_1K +
    (n("baselineOutputTokens") / 1_000) * TECHO_PRECIO_SALIDA_PER_1K;
  return n("baselineCost") <= techo + TOLERANCIA_REDONDEO_USD;
}

export function parseUsageRecord(
  input: unknown,
  authorizedOrgId: string,
  recortes: Recorte[] = [],
  referencia: DescartesDeReferencia = { degradados: 0, camposDescartados: 0 },
): UsageRecord {
  if (!isPlainObject(input)) throw new UsageValidationError("usage record must be an object");
  for (const key of Object.keys(input)) {
    if (!USAGE_ALLOWED_FIELDS.has(key)) {
      throw new UsageValidationError(
        `disallowed field "${key}" — the control plane accepts only counts/metadata, never content`,
      );
    }
  }
  const rec: Record<string, unknown> = { orgId: authorizedOrgId };
  for (const f of USAGE_ID_FIELDS) {
    const v = input[f];
    if (typeof v !== "string" || !USAGE_ID_PATTERN.test(v)) {
      throw new UsageValidationError(`field "${f}" must match ${USAGE_ID_PATTERN} (identity, not free text)`);
    }
    rec[f] = v;
  }
  if (typeof input["cacheResult"] !== "string" || !USAGE_CACHE_RESULTS.has(input["cacheResult"] as string)) {
    throw new UsageValidationError(`field "cacheResult" must be one of ${[...USAGE_CACHE_RESULTS].join("|")}`);
  }
  rec["cacheResult"] = input["cacheResult"];
  for (const f of USAGE_NUMBER_FIELDS) {
    const num = input[f];
    if (typeof num !== "number" || !Number.isFinite(num)) {
      throw new UsageValidationError(`field "${f}" must be a finite number`);
    }
    // Dominio, no solo tipo. "Finito" aceptaba cualquier disparate: contadores
    // negativos que restan de los agregados (el titular del panel podía pasar
    // del 100% de ahorro) y un `at` en segundos en vez de milisegundos, que
    // fecha todo el lote en 1970 y lo hace desaparecer a la vez del panel y del
    // mes facturable — sin error, sin fila roja, sin nada.
    if (f === "at") {
      if (num < AT_MIN_MS || num > Date.now() + AT_MAX_SKEW_MS) {
        throw new UsageValidationError(
          `field "at" is out of range (${num}); expected epoch MILLISECONDS between ` +
            `${AT_MIN_MS} and now+${AT_MAX_SKEW_MS}ms. A value near ${Math.floor(Date.now() / 1000)} ` +
            `suggests seconds instead of milliseconds.`,
        );
      }
    } else if (f === "netSavings") {
      // Es una proporción y SÍ puede ser negativa: una petición puede salir más
      // cara que la ingenua. Se acota para que un signo o una unidad mal puestos
      // no arrastren el agregado.
      if (num > 1 || num < -100) {
        throw new UsageValidationError(`field "netSavings" must be a ratio in [-100, 1], got ${num}`);
      }
    } else if (num < 0) {
      // El resto son recuentos y dólares: nunca negativos.
      throw new UsageValidationError(`field "${f}" must be >= 0, got ${num}`);
    }
    rec[f] = num;
  }
  if (input["eliminatedInputFloorCost"] !== undefined) {
    const v = input["eliminatedInputFloorCost"];
    // Tipo y signo SÍ se rechazan: un payload malformado es un bug del emisor.
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new UsageValidationError(`field "eliminatedInputFloorCost" must be a finite number >= 0`);
    }
    // Dominio: RECORTE, no rechazo. «Dinero sin conteo» (suelo > 0 con
    // eliminatedInputTokens = 0) baja a 0 y un suelo por encima de
    // tokens × TECHO_PRECIO_LECTURA_PER_1K baja al techo. Un throw aquí tumba
    // el LOTE ENTERO del cliente (parseUsageRecords → 400 → el emisor descarta
    // sin reintento): un gateway con un precio mal puesto dejaría de reportar
    // TODO su uso. Se guarda lo defendible y se avisa.
    const tokens = rec["eliminatedInputTokens"] as number;
    const recortado = recortarSuelo(v, tokens);
    if (recortado !== v) recortes.push({ recibido: v, tokens, guardado: recortado });
    rec["eliminatedInputFloorCost"] = recortado;
  }
  // 0032 · el AHORRO NATIVO. Tipo y signo se rechazan (bug del emisor); el
  // dominio se RECORTA: la lectura, a leídos × techo de entrada; la prima, a
  // entrada × techo. Sin conteo, 0. Nada de esto toca otro campo del registro.
  for (const [campo, tokens] of [
    ["nativeCacheReadSavings", rec["providerCachedInputTokens"] as number],
    ["nativeCacheWritePremium", rec["actualInputTokens"] as number],
  ] as const) {
    if (input[campo] === undefined) continue;
    const v = input[campo];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new UsageValidationError(`field "${campo}" must be a finite number >= 0`);
    }
    rec[campo] = recortarNativo(v, tokens);
  }
  if (input["seatId"] !== undefined) {
    const s = input["seatId"];
    if (typeof s !== "string" || !USAGE_ID_PATTERN.test(s)) {
      throw new UsageValidationError(`field "seatId" must match ${USAGE_ID_PATTERN} (identity, not free text)`);
    }
    rec["seatId"] = s;
  }
  // Atribución de sesión/subagente (las cabeceras x-claude-code-* del gateway):
  // identidades OPACAS de sesión/agente — jamás de una persona — con el mismo
  // cierre de canal que seatId: charset estricto, nunca texto libre.
  for (const f of ["sessionId", "agentId"] as const) {
    if (input[f] !== undefined) {
      const v = input[f];
      if (typeof v !== "string" || !USAGE_ID_PATTERN.test(v)) {
        throw new UsageValidationError(`field "${f}" must match ${USAGE_ID_PATTERN} (identity, not free text)`);
      }
      rec[f] = v;
    }
  }
  if (input["basis"] !== undefined) {
    const b = input["basis"];
    if (typeof b !== "string" || !USAGE_BASIS.has(b)) {
      throw new UsageValidationError(`field "basis" must be one of ${[...USAGE_BASIS].join("|")}`);
    }
    rec["basis"] = b;
  }
  if (input["ci"] !== undefined) {
    if (typeof input["ci"] !== "boolean") throw new UsageValidationError(`field "ci" must be a boolean`);
    rec["ci"] = input["ci"];
  }
  // 0029 · el carril MEDIDO POR REFERENCIA. Todo aquí es RECORTE, no rechazo:
  // los dos campos se guardan si tienen la forma exacta (identidad con el mismo
  // charset que requestId; epoch en MILISEGUNDOS dentro del rango de `at`) y se
  // descartan en silencio si no. Un basis "reference" incoherente —también el
  // que se queda SIN puntero porque sus campos se descartaron, o cuyo contador
  // es más viejo que la regla publicada— baja a "estimated": sigue contando en
  // los totales, pero no en reference_* ni en reference_hits.
  if (input["referenceRequestId"] !== undefined) {
    const v = input["referenceRequestId"];
    if (typeof v === "string" && USAGE_ID_PATTERN.test(v)) rec["referenceRequestId"] = v;
    else referencia.camposDescartados++;
  }
  if (input["referenceAt"] !== undefined) {
    const v = input["referenceAt"];
    if (typeof v === "number" && Number.isInteger(v) && v >= AT_MIN_MS && v <= Date.now() + AT_MAX_SKEW_MS) {
      rec["referenceAt"] = v;
    } else {
      referencia.camposDescartados++;
    }
  }
  if (rec["basis"] === "reference" && !referenciaCoherente(rec)) {
    rec["basis"] = "estimated";
    referencia.degradados++;
  }
  // Los dos campos solo viajan con una referencia: la RPC solo escribe
  // reference_hits con basis "reference", y un campo suelto no significa nada.
  if (rec["basis"] !== "reference") {
    delete rec["referenceRequestId"];
    delete rec["referenceAt"];
  }
  return rec as unknown as UsageRecord;
}

/**
 * EL INTERRUPTOR DE SERVIDOR del carril por referencia: reescribe todo registro
 * "reference" a "estimated" (y le quita los dos campos) ANTES de la RPC. Lo usa
 * la ruta del ingest bajo BVSALA_INGEST_REFERENCE_AS_ESTIMATED=1 — cortar la
 * acumulación sin npm y sin migración. Devuelve cuántos cambió.
 */
export function degradarReferencias(records: UsageRecord[]): number {
  let n = 0;
  for (const r of records) {
    const rec = r as Record<string, unknown>;
    if (rec["basis"] !== "reference") continue;
    rec["basis"] = "estimated";
    delete rec["referenceRequestId"];
    delete rec["referenceAt"];
    n++;
  }
  return n;
}

/**
 * Cómo se lee BVSALA_INGEST_REFERENCE_AS_ESTIMATED. Es un interruptor de
 * EMERGENCIA y tiene que fallar hacia el lado seguro (cobrar de menos), no hacia
 * «sigue acumulando»: quien lo pone en Vercel durante un incidente puede
 * escribir `1`, `true`, `yes` u `on` y lo tiene que encender igual. Vacío,
 * `0`, `false`, `no` u `off` lo dejan apagado. Cualquier otro valor lo
 * ENCIENDE y queda marcado como no reconocido para que la ruta lo avise.
 */
export function leerInterruptorReferenciaComoEstimado(valor: string | undefined): {
  activo: boolean;
  reconocido: boolean;
} {
  const v = (valor ?? "").trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no" || v === "off") return { activo: false, reconocido: true };
  if (v === "1" || v === "true" || v === "yes" || v === "on") return { activo: true, reconocido: true };
  return { activo: true, reconocido: false };
}

/** Parse a batch (object or array). Caps batch size so one request can't be huge. */
export function parseUsageRecords(input: unknown, authorizedOrgId: string): UsageRecord[] {
  const arr = Array.isArray(input) ? input : [input];
  if (arr.length > 1000) throw new UsageValidationError("batch too large (max 1000 records)");
  // Un aviso POR LOTE, no por registro: un gateway con el precio mal puesto
  // generaría hasta 1.000 líneas por lote y ahogaría la alerta útil.
  const recortes: Recorte[] = [];
  const referencia: DescartesDeReferencia = { degradados: 0, camposDescartados: 0 };
  const out = arr.map((r) => parseUsageRecord(r, authorizedOrgId, recortes, referencia));
  if (recortes.length > 0) {
    console.warn("[metering/usage] eliminatedInputFloorCost recortado", {
      registros: arr.length,
      recortados: recortes.length,
      maxRecibido: Math.max(...recortes.map((x) => x.recibido)),
    });
  }
  if (referencia.degradados > 0 || referencia.camposDescartados > 0) {
    console.warn("[metering/usage] basis reference degradado a estimated", {
      registros: arr.length,
      degradados: referencia.degradados,
      camposDescartados: referencia.camposDescartados,
    });
  }
  return out;
}
