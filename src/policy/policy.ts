import type { CanonicalRequest } from "../canonicalization/canonicalize.js";

/**
 * Policy engine: risk and freshness.
 *
 * This is the gate that decides which savings are *safe* for a given request.
 * The most dangerous failure of a savings layer is not a cache miss — it is
 * confidently returning a wrong answer (a stale price, another tenant's data, a
 * reused answer for a side-effecting action). The policy engine exists to make
 * those outcomes structurally impossible, not merely unlikely.
 */
export interface Policy {
  /** May the exact cache be read/written for this request? */
  allowExactCache: boolean;
  /** May the semantic cache even be *considered*? (still verified later) */
  allowSemanticCache: boolean;
  /** May concurrent equivalent requests be coalesced? */
  allowSingleflight: boolean;
  /** May we run natural-language compression on the context? */
  allowCompression: boolean;
  /** Does the request demand current/live data? */
  requiresFreshData: boolean;
  /** Does the request have (or request) side effects? */
  hasSideEffects: boolean;
  /** Is the response personalized to a user/account? */
  isPersonalized: boolean;
  reasons: string[];
}

/** Words that imply the answer depends on "now". */
const FRESHNESS_MARKERS =
  /\b(now|today|current|currently|latest|live|price|prices|stock|availability|weather|score|breaking|ahora|hoy|actual|precio|precios|disponibilidad)\b/i;

/** Words that imply personalization / account scope. */
const PERSONAL_MARKERS =
  /\b(my|mine|our|account|balance|subscription|invoice|order|profile|mi|mis|cuenta|factura|pedido|saldo)\b/i;

export function evaluatePolicy(c: CanonicalRequest): Policy {
  const reasons: string[] = [];
  const text = c.normalizedText;

  const hasWriteTools = (c.original.tools ?? []).some(
    (t) => t.risk === "write" || t.risk === "destructive",
  );
  const requiresFreshData =
    c.freshnessBucket === "live" ||
    c.freshnessBucket === "hour" ||
    FRESHNESS_MARKERS.test(text);
  const isPersonalized =
    c.tenantId !== "anonymous" && PERSONAL_MARKERS.test(text);
  const stochastic = (c.temperature ?? 0) > 0.3 && c.seed == null;

  if (hasWriteTools) reasons.push("write/destructive tools present");
  if (requiresFreshData) reasons.push("freshness-sensitive request");
  if (isPersonalized) reasons.push("personalized/account-scoped request");
  if (stochastic) reasons.push("stochastic sampling (temp>0.3, no seed)");

  // Exact cache is safe as long as the key already isolates tenant/scope/
  // freshness bucket. It is only disabled for deliberately stochastic outputs,
  // where an identical replay is not what the caller wants.
  const allowExactCache = !stochastic;

  // Semantic cache is far more restricted: read-only, non-personalized,
  // non-fresh, deterministic-enough. Even then, a downstream verifier must
  // still confirm the hit.
  const allowSemanticCache =
    !hasWriteTools &&
    !requiresFreshData &&
    !isPersonalized &&
    !stochastic &&
    c.freshnessBucket !== "day";

  return {
    allowExactCache,
    allowSemanticCache,
    allowSingleflight: !hasWriteTools,
    allowCompression: true,
    requiresFreshData,
    hasSideEffects: hasWriteTools,
    isPersonalized,
    reasons,
  };
}
