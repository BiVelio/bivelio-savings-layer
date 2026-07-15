import type { SerializationFormat } from "../contracts/types.js";

/**
 * A serializer encodes a structured payload into prompt text, and reports the
 * instruction overhead a model needs to *understand* that encoding. The format
 * selector compares `tokens(encode) + tokens(instruction)` across serializers.
 */
export interface Serializer {
  readonly format: SerializationFormat;
  /** Whether this serializer can represent the given value at all. */
  supports(value: unknown): boolean;
  encode(value: unknown): string;
  /**
   * The instruction text a model needs to interpret this format. For JSON this
   * is empty; for TOON/CSV it is the per-request cost that must be amortized
   * before the format is worthwhile.
   */
  instruction(value: unknown): string;
}
