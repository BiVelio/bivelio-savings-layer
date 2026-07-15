import type { JsonSchema, OutputContract } from "../contracts/types.js";

/**
 * Schema registry.
 *
 * Output contracts are referenced by id (e.g. "research-answer:v3") so they do
 * not have to be re-transmitted in every prompt once the server knows them.
 * The registry also enforces "minimal contract" hygiene — arrays should be
 * bounded, strings length-capped, `additionalProperties` closed — which is how
 * we keep OUTPUT tokens down, not just input tokens.
 */
export class SchemaRegistry {
  private readonly contracts = new Map<string, OutputContract>();

  register(contract: OutputContract): this {
    this.contracts.set(contract.contractId, contract);
    return this;
  }

  resolve(contractId: string): OutputContract | undefined {
    return this.contracts.get(contractId);
  }

  has(contractId: string): boolean {
    return this.contracts.has(contractId);
  }

  /**
   * Lint a schema for output-token hygiene. These are warnings, not errors: an
   * unbounded array or uncapped string is legal JSON Schema but tends to blow up
   * generation cost, so the layer surfaces them.
   */
  static lint(schema: JsonSchema, path = "$"): string[] {
    const warnings: string[] = [];
    lintNode(schema, path, warnings);
    return warnings;
  }
}

function lintNode(schema: JsonSchema, path: string, warnings: string[]): void {
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) {
      warnings.push(`${path}: object should set additionalProperties:false`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      lintNode(sub, `${path}.${key}`, warnings);
    }
  }
  if (schema.type === "array") {
    if (schema.maxItems == null) {
      warnings.push(`${path}: array should set maxItems to bound output`);
    }
    if (schema.items) lintNode(schema.items, `${path}[]`, warnings);
  }
  if (schema.type === "string" && schema.maxLength == null && !schema.enum) {
    warnings.push(`${path}: string should set maxLength or use an enum`);
  }
}
