import type { JsonSchema } from "../contracts/types.js";

/**
 * Constrained-decoding backends.
 *
 * The point of these libraries is NOT to compress input — it is to make an
 * invalid structure impossible to emit, which eliminates the "your JSON is
 * broken, try again" repair round-trip and lets generation stop exactly when
 * the object is complete. BV-SALA treats them as interchangeable backends
 * selected by preference order:
 *
 *   provider-native  ->  xgrammar  ->  llguidance  ->  outlines
 *
 * They must never all run at once. This module resolves which backend applies
 * for a given (provider, schema) and exposes a stable descriptor; the actual
 * runtime binding lives in the provider adapters.
 */
export type ConstraintBackendId =
  | "provider-native"
  | "xgrammar"
  | "llguidance"
  | "outlines"
  | "none";

export interface ConstraintBackend {
  readonly id: ConstraintBackendId;
  /** Can this backend enforce the given schema for the given model? */
  supports(model: string, schema: JsonSchema): boolean;
}

export interface ConstraintPlan {
  backend: ConstraintBackendId;
  reason: string;
}

/**
 * Resolve a constraint backend from an ordered preference list. Each candidate
 * declares whether it supports the (model, schema) pair; the first supporting
 * backend wins. A conformance suite (see benchmarks/) must confirm that a
 * backend which *claims* support actually enforces every constraint — declared
 * support and empirical coverage are not the same thing.
 */
export function resolveConstraintBackend(
  model: string,
  schema: JsonSchema,
  backends: ConstraintBackend[],
): ConstraintPlan {
  for (const backend of backends) {
    if (backend.supports(model, schema)) {
      return { backend: backend.id, reason: `first supporting backend: ${backend.id}` };
    }
  }
  return {
    backend: "none",
    reason: "no constrained-decoding backend available; will validate + repair",
  };
}

/** A permissive backend used when the provider validates structured output natively. */
export function providerNativeBackend(
  isSupported: (model: string, schema: JsonSchema) => boolean = () => true,
): ConstraintBackend {
  return { id: "provider-native", supports: isSupported };
}
