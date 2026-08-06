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
const USAGE_ALLOWED_FIELDS = new Set<string>([
  "orgId", "seatId", "ci", "cacheResult",
  ...USAGE_ID_FIELDS,
  ...USAGE_NUMBER_FIELDS,
]);

export interface UsageRecord {
  orgId: string;
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
export function parseUsageRecord(input: unknown, authorizedOrgId: string): UsageRecord {
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
  if (input["seatId"] !== undefined) {
    const s = input["seatId"];
    if (typeof s !== "string" || !USAGE_ID_PATTERN.test(s)) {
      throw new UsageValidationError(`field "seatId" must match ${USAGE_ID_PATTERN} (identity, not free text)`);
    }
    rec["seatId"] = s;
  }
  if (input["ci"] !== undefined) {
    if (typeof input["ci"] !== "boolean") throw new UsageValidationError(`field "ci" must be a boolean`);
    rec["ci"] = input["ci"];
  }
  return rec as unknown as UsageRecord;
}

/** Parse a batch (object or array). Caps batch size so one request can't be huge. */
export function parseUsageRecords(input: unknown, authorizedOrgId: string): UsageRecord[] {
  const arr = Array.isArray(input) ? input : [input];
  if (arr.length > 1000) throw new UsageValidationError("batch too large (max 1000 records)");
  return arr.map((r) => parseUsageRecord(r, authorizedOrgId));
}
