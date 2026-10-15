import { sha256DeBytes } from "../util/hash.js";

/**
 * EL CONTRATO DEL TRANSFORMADOR DE AHORRO (D05 del plan Caveman 2026-10-14, p. 4).
 *
 * Es la frontera entre el SDK —que sabe qué segmento exacto puede sustituirse,
 * bajo qué política y en qué ámbito— y cualquier motor que proponga una vista
 * más pequeña (el sidecar de `gateway/sidecar-caveman.ts`, o uno propio mañana). El
 * motor PROPONE; quien llama valida el plan ENTERO y decide. Por eso aquí viven
 * también `validarPlan` y `aplicarPlan`: ningún motor tiene que ser de fiar.
 *
 * Lo que fija este fichero, y lo que NO se negocia con ningún motor:
 *
 *   · Se transforma una COPIA saliente. `aplicarPlan` nunca toca los bytes de
 *     la petición: devuelve segmentos nuevos.
 *   · Sólo se sustituyen los segmentos DECLARADOS, por id, y nunca uno
 *     protegido. No hay JSON Patch ni «el motor reescribe lo que quiera»: una
 *     sustitución para un id que no se mandó, o para uno protegido, tumba el
 *     plan entero (`invalid_plan`), no sólo esa sustitución.
 *   · Cada sustitución trae la sha256 del original que dice sustituir y la de
 *     sus propios bytes; las dos se recalculan aquí. Y tiene que ser MÁS
 *     PEQUEÑA en bytes UTF-8: «sin mejora» es un resultado válido (bypass), no
 *     una sustitución.
 *   · Con omisiones (modo `recoverable`) sólo si hay recuperación comprobada:
 *     sin `recoveryBinding` en la petición, o sin handle en la sustitución, el
 *     plan no vale. En `lossless` no hay handle porque no se omite nada; en
 *     `off` y `record` no se sustituye nada.
 *   · `estimate` es diagnóstico, nunca dato facturable: `basis: "estimated"`
 *     siempre. El recibo con uso real sale por otro contrato (D02).
 *   · Un fallo de Privacy NO es un bypass: si un segmento llega sin la huella de
 *     la política que lo autorizó, `optimize` lanza `ErrorDePrivacidad` y la
 *     petición se detiene. El bypass de ahorro existe para que un motor caído no
 *     pare el tráfico, no para saltarse una autorización.
 *
 * Los nombres de tipo son los del plan, a propósito, para poder cotejarlos con
 * el PDF; los campos añadidos (`historyManifest`, `overheadText`…) son
 * opcionales y van comentados. NADA de esto sale por `src/index.ts`: la API 0.5
 * está congelada y exponer el transformador es decisión del dueño.
 */

export type Mode = "off" | "record" | "lossless" | "recoverable";

/** El ámbito. Lo resuelve el SERVIDOR a partir de la identidad autenticada, nunca del cuerpo. */
export interface Scope {
  tenantId: string;
  projectId: string;
  sessionId: string;
  branchId: string;
  epoch: string;
}

export interface Segment {
  id: string;
  sourceId: string;
  kind: "tool_result";
  /** El `tool_use_id` del bloque: viaja intacto, nunca se reescribe. */
  toolCallId: string;
  utf8: Uint8Array;
  /** sha256 hex de `utf8`. Se recalcula: un segmento con la huella mal es un error de quien llama. */
  sha256: string;
  contentType: string;
  /** Protegido: no se manda al motor y sale idéntico. */
  protected: boolean;
  /** Huella de la política de Privacy bajo la que este contenido está autorizado. Obligatoria. */
  privacyPolicyHash: string;
}

export interface OptimizeRequest {
  schemaVersion: 1;
  requestId: string;
  idempotencyKey: string;
  scope: Scope;
  sequence: number;
  historyManifestHash: string;
  /**
   * (Añadido.) El manifiesto del historial, ítem a ítem. El protocolo de
   * Caveman lo quiere así para detectar evolución (append vs. fork); sin él
   * se manda un único ítem con `historyManifestHash`.
   */
  historyManifest?: { id: string; sha256: string }[];
  endpoint: {
    provider: string;
    route: string;
    model: string;
    streaming: boolean;
    providerState: "none" | "retained";
  };
  mode: Mode;
  policyVersion: string;
  allowedTransforms: string[];
  segments: Segment[];
  /** Instante (reloj de `Date.now()`) a partir del cual ya no se espera al motor. */
  deadlineAtMs: number;
  recoveryBinding?: {
    executorId: string;
    bindingDigest: string;
    /** (Añadido.) El texto que la herramienta de recuperación añade al contexto, para la puerta de beneficio neto. */
    overheadText?: string;
  };
}

export interface Replacement {
  segmentId: string;
  originalSha256: string;
  utf8: Uint8Array;
  replacementSha256: string;
  transformId: string;
  version: string;
  handle?: string;
  leaseExpiresAt?: string;
}

export interface OptimizeResult {
  status: "applied" | "bypassed";
  reason: string;
  replacements: Replacement[];
  skipped: { id: string; reason: string }[];
  estimate: {
    inputBefore?: number;
    inputAfter?: number;
    tokenizer: string;
    basis: "estimated";
    overheadTokens: number;
  };
  runtimeBuild: string;
  policyVersion: string;
  decisionId: string;
}

/** Una página de un original recuperado. `sha256` es la del objeto ENTERO. */
export interface RetrievedPage {
  utf8: Uint8Array;
  sha256: string;
  nextCursor?: string;
}

/**
 * (Añadido al plan.) Lo que `retrieve` necesita saber del llamante AHORA: la
 * huella de la política vigente, para no devolver un original autorizado bajo
 * una política que ya lo prohíbe (plan p. 6), y la señal para cancelar.
 */
export interface RetrieveContext {
  privacyPolicyHash: string;
  signal?: AbortSignal;
}

export interface SavingsTransformer {
  optimize(req: OptimizeRequest, signal: AbortSignal): Promise<OptimizeResult>;
  retrieve(scope: Scope, handle: string, cursor?: string, context?: RetrieveContext): Promise<RetrievedPage>;
  release(scope: Scope): Promise<{ revoked: boolean }>;
}

// ---------------------------------------------------------------------------
// Motivos
// ---------------------------------------------------------------------------

/**
 * El catálogo CERRADO de motivos que puede dar un resultado de este lado. Las
 * métricas (D09) sólo etiquetan con estos: cualquier otro cuenta como `other`,
 * para que un motor no pueda inflar la cardinalidad con motivos inventados.
 */
export const MOTIVOS = [
  "applied",
  // decisiones normales
  "off",
  "record",
  "disabled",
  "no_candidate",
  "not_smaller",
  "protected",
  "payload_budget",
  "unsupported_shape",
  "unsupported_route",
  "recovery_unbound",
  "unknown_capability",
  "version_retired",
  // presión
  "capacity",
  "circuit_open",
  // fallos del motor (cuentan para el cortacircuitos)
  "deadline",
  "runtime_unavailable",
  "invalid_plan",
  "redirect_refused",
  "payload_limit",
  // configuración que impide usar el motor (sin E/S)
  "invalid_endpoint",
  "engine_unverified",
  "version_mismatch",
  "runtime_unauthorized",
  // el runtime rechazó la petición sin ser un fallo suyo (4xx)
  "runtime_rejected",
  "scope_revoked",
  // del llamante
  "cancelled",
] as const;

export type Motivo = (typeof MOTIVOS)[number];

const CONOCIDOS: ReadonlySet<string> = new Set(MOTIVOS);

/** El motivo tal cual si está en el catálogo; `other` si no. Para etiquetas de métricas. */
export function motivoAcotado(motivo: string): Motivo | "other" {
  return CONOCIDOS.has(motivo) ? (motivo as Motivo) : "other";
}

// ---------------------------------------------------------------------------
// Errores que DETIENEN (nunca bypass)
// ---------------------------------------------------------------------------

/**
 * Privacy o autorización: la petición se para. Quien lo atrape NO debe mandar
 * el original «por si acaso»: el original tampoco está autorizado.
 */
export class ErrorDePrivacidad extends Error {
  readonly codigo: "privacy_unbound" | "policy_changed" | "policy_unverified";
  constructor(codigo: ErrorDePrivacidad["codigo"], mensaje: string) {
    super(mensaje);
    this.name = "ErrorDePrivacidad";
    this.codigo = codigo;
  }
}

/** Un retrieve que no puede devolver bytes. El código es estable; nunca lleva contenido ni handle. */
export class ErrorDeRecuperacion extends Error {
  readonly codigo: string;
  constructor(codigo: string) {
    super(`recuperación no disponible: ${codigo}`);
    this.name = "ErrorDeRecuperacion";
    this.codigo = codigo;
  }
}

/** La petición en sí está mal formada (bug de quien llama, no del motor). */
export class PeticionInvalida extends Error {
  readonly codigo = "invalid_request" as const;
  constructor(detalle: string) {
    super(`petición de optimización inválida: ${detalle}`);
    this.name = "PeticionInvalida";
  }
}

// ---------------------------------------------------------------------------
// Comprobaciones de la petición
// ---------------------------------------------------------------------------

const RE_SHA256 = /^[0-9a-f]{64}$/;
const decodificadorEstricto = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 estricto o null. Un segmento que no es UTF-8 válido no se manda a ningún motor. */
export function utf8Estricto(bytes: Uint8Array): string | null {
  try {
    return decodificadorEstricto.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Lo que tiene que cumplir una petición ANTES de tocar ningún motor. Lanza:
 *   · `ErrorDePrivacidad("privacy_unbound")` si un segmento no protegido no
 *     trae la huella de su política — detenerse, no bypass;
 *   · `PeticionInvalida` si los ids se repiten o una sha256 no es la de sus
 *     bytes (el error es de quien construyó la petición).
 */
export function comprobarPeticion(req: OptimizeRequest): void {
  if (req.schemaVersion !== 1) throw new PeticionInvalida("schemaVersion");
  const vistos = new Set<string>();
  for (const s of req.segments) {
    if (typeof s.id !== "string" || s.id.length === 0) throw new PeticionInvalida("segmento sin id");
    if (vistos.has(s.id)) throw new PeticionInvalida("id de segmento repetido");
    vistos.add(s.id);
    if (!(s.utf8 instanceof Uint8Array)) throw new PeticionInvalida("segmento sin bytes");
    if (!RE_SHA256.test(s.sha256) || sha256DeBytes(s.utf8) !== s.sha256) {
      throw new PeticionInvalida("la sha256 de un segmento no es la de sus bytes");
    }
    if (!s.protected && (typeof s.privacyPolicyHash !== "string" || s.privacyPolicyHash.length === 0)) {
      throw new ErrorDePrivacidad(
        "privacy_unbound",
        "un segmento llega sin la huella de la política que lo autorizó: no se optimiza ni se envía",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Validar y aplicar un plan
// ---------------------------------------------------------------------------

export type MotivoDePlanInvalido =
  | "bad_status"
  | "policy_mismatch"
  | "undeclared_segment"
  | "protected_segment"
  | "duplicate_replacement"
  | "original_hash_mismatch"
  | "replacement_hash_mismatch"
  | "transform_not_allowed"
  | "not_smaller"
  | "invalid_utf8"
  | "mode_forbids_replacement"
  | "recovery_unbound"
  | "missing_handle"
  | "unexpected_handle";

export type ValidacionDePlan = { ok: true } | { ok: false; motivo: MotivoDePlanInvalido; segmentId?: string };

/**
 * Valida el plan ENTERO contra la petición que lo originó. Ninguna sustitución
 * se aplica si una sola falla: un motor que se equivoca en un segmento no es de
 * fiar en los demás.
 *
 * Se recalcula todo lo que se puede recalcular (las dos sha256, el tamaño, el
 * UTF-8); lo que no, se compara con lo declarado en la petición.
 */
export function validarPlan(req: OptimizeRequest, res: OptimizeResult): ValidacionDePlan {
  if (res.status !== "applied" && res.status !== "bypassed") return { ok: false, motivo: "bad_status" };
  if (res.status === "bypassed" && res.replacements.length > 0) return { ok: false, motivo: "bad_status" };
  if (res.status === "applied" && res.replacements.length === 0) return { ok: false, motivo: "bad_status" };
  if (res.policyVersion !== req.policyVersion) return { ok: false, motivo: "policy_mismatch" };

  const declarados = new Map(req.segments.map((s) => [s.id, s] as const));
  const permitidos = new Set(req.allowedTransforms);
  const sustituidos = new Set<string>();

  for (const r of res.replacements) {
    const id = r.segmentId;
    const seg = declarados.get(id);
    if (!seg) return { ok: false, motivo: "undeclared_segment", segmentId: id };
    if (seg.protected) return { ok: false, motivo: "protected_segment", segmentId: id };
    if (sustituidos.has(id)) return { ok: false, motivo: "duplicate_replacement", segmentId: id };
    sustituidos.add(id);
    if (req.mode === "off" || req.mode === "record") return { ok: false, motivo: "mode_forbids_replacement", segmentId: id };
    if (r.originalSha256 !== seg.sha256 || sha256DeBytes(seg.utf8) !== seg.sha256) {
      return { ok: false, motivo: "original_hash_mismatch", segmentId: id };
    }
    if (!(r.utf8 instanceof Uint8Array) || sha256DeBytes(r.utf8) !== r.replacementSha256) {
      return { ok: false, motivo: "replacement_hash_mismatch", segmentId: id };
    }
    if (!permitidos.has(r.transformId)) return { ok: false, motivo: "transform_not_allowed", segmentId: id };
    if (r.utf8.length >= seg.utf8.length) return { ok: false, motivo: "not_smaller", segmentId: id };
    if (utf8Estricto(r.utf8) === null) return { ok: false, motivo: "invalid_utf8", segmentId: id };
    if (req.mode === "recoverable") {
      if (!req.recoveryBinding) return { ok: false, motivo: "recovery_unbound", segmentId: id };
      if (typeof r.handle !== "string" || r.handle.length === 0) return { ok: false, motivo: "missing_handle", segmentId: id };
    } else if (r.handle !== undefined) {
      // `lossless` no omite nada: un handle aquí significa que el motor sí omitió.
      return { ok: false, motivo: "unexpected_handle", segmentId: id };
    }
  }
  return { ok: true };
}

/**
 * Aplica un plan ya validado a una COPIA de los segmentos y comprueba, después,
 * que los protegidos salen byte a byte iguales. Devuelve segmentos nuevos
 * (bytes nuevos también): la petición original no se toca.
 *
 * Lanza si el plan no valida: quien llama a `aplicarPlan` sin haber decidido
 * qué hacer con un plan inválido tiene un bug, y lo correcto es no enviar nada
 * transformado. (El adaptador de sidecar ya convierte un plan inválido en un
 * bypass antes de llegar aquí.)
 */
export function aplicarPlan(req: OptimizeRequest, res: OptimizeResult): Segment[] {
  const v = validarPlan(req, res);
  if (!v.ok) throw new Error(`plan inválido (${v.motivo}): no se aplica ninguna sustitución`);
  const porId = new Map(res.replacements.map((r) => [r.segmentId, r] as const));
  const salida = req.segments.map((s): Segment => {
    const r = porId.get(s.id);
    if (!r) return { ...s, utf8: s.utf8.slice() };
    return { ...s, utf8: r.utf8.slice(), sha256: r.replacementSha256 };
  });
  for (let i = 0; i < req.segments.length; i++) {
    const antes = req.segments[i]!;
    const despues = salida[i]!;
    if (antes.protected && (despues.sha256 !== antes.sha256 || sha256DeBytes(despues.utf8) !== antes.sha256)) {
      throw new Error("un segmento protegido no salió idéntico: no se envía nada transformado");
    }
    if (despues.id !== antes.id || despues.toolCallId !== antes.toolCallId) {
      throw new Error("la aplicación cambió un id: no se envía nada transformado");
    }
  }
  return salida;
}

/** Un resultado de bypass sin sustituciones. `skipped` lista cada segmento con su motivo. */
export function resultadoDeBypass(
  req: Pick<OptimizeRequest, "segments" | "policyVersion">,
  motivo: string,
  extra: { runtimeBuild?: string; decisionId?: string; skipped?: { id: string; reason: string }[] } = {},
): OptimizeResult {
  return {
    status: "bypassed",
    reason: motivo,
    replacements: [],
    skipped: extra.skipped ?? req.segments.map((s) => ({ id: s.id, reason: s.protected ? "protected" : motivo })),
    estimate: { tokenizer: "none", basis: "estimated", overheadTokens: 0 },
    runtimeBuild: extra.runtimeBuild ?? "none",
    policyVersion: req.policyVersion,
    decisionId: extra.decisionId ?? "none",
  };
}

/**
 * Reensambla un original entero página a página y verifica su sha256 contra la
 * que se apuntó al emitir el handle (no contra la que dice la página: esa la
 * da el motor). Una discrepancia es `integrity_failure`, sin bytes.
 */
export async function recuperarEntero(
  t: SavingsTransformer,
  scope: Scope,
  handle: string,
  context: RetrieveContext,
  sha256Esperada: string,
  maxPaginas = 4096,
): Promise<Uint8Array> {
  const trozos: Uint8Array[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPaginas; i++) {
    const p = await t.retrieve(scope, handle, cursor, context);
    if (p.sha256 !== sha256Esperada) throw new ErrorDeRecuperacion("integrity_failure");
    trozos.push(p.utf8);
    if (p.nextCursor === undefined) {
      const total = trozos.reduce((n, b) => n + b.length, 0);
      const todo = new Uint8Array(total);
      let o = 0;
      for (const b of trozos) {
        todo.set(b, o);
        o += b.length;
      }
      if (sha256DeBytes(todo) !== sha256Esperada) throw new ErrorDeRecuperacion("integrity_failure");
      return todo;
    }
    cursor = p.nextCursor;
  }
  throw new ErrorDeRecuperacion("too_many_pages");
}
