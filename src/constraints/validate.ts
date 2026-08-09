import type { JsonSchema } from "../contracts/types.js";

/**
 * Structural validation against the JsonSchema subset the layer uses.
 *
 * Constrained decoding should prevent invalid structures at generation time,
 * but a provider without native support can still return free text. This
 * validator is the deterministic gate that decides whether a response satisfies
 * its output contract — and, when it does not, whether a single repair is
 * warranted. NOTE: structural validity is NOT semantic validity; risky tasks
 * still need a semantic check on top.
 */
export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path = "$",
): ValidationResult {
  const errors: ValidationError[] = [];
  walk(value, schema, path, errors);
  return { valid: errors.length === 0, errors };
}

function walk(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: ValidationError[],
): void {
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push({ path, message: `value not in enum` });
  }

  switch (schema.type) {
    case "object":
      validateObject(value, schema, path, errors);
      break;
    case "array":
      validateArray(value, schema, path, errors);
      break;
    case "string":
      validateString(value, schema, path, errors);
      break;
    case "number":
    case "integer":
      validateNumber(value, schema, path, errors);
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        errors.push({ path, message: "expected boolean" });
      }
      break;
    case "null":
      if (value !== null) errors.push({ path, message: "expected null" });
      break;
    default:
      break;
  }
}

function validateObject(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: ValidationError[],
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push({ path, message: "expected object" });
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const req of schema.required ?? []) {
    if (!(req in obj)) errors.push({ path: `${path}.${req}`, message: "missing required property" });
  }
  if (schema.additionalProperties === false && schema.properties) {
    const allowed = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) {
        errors.push({ path: `${path}.${key}`, message: "additional property not allowed" });
      }
    }
  }
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in obj) walk(obj[key], sub, `${path}.${key}`, errors);
    }
  }
}

function validateArray(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: ValidationError[],
): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "expected array" });
    return;
  }
  if (schema.maxItems != null && value.length > schema.maxItems) {
    errors.push({ path, message: `array exceeds maxItems ${schema.maxItems}` });
  }
  if (schema.minItems != null && value.length < schema.minItems) {
    errors.push({ path, message: `array below minItems ${schema.minItems}` });
  }
  if (schema.items) {
    value.forEach((item, i) => walk(item, schema.items!, `${path}[${i}]`, errors));
  }
}

function validateString(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: ValidationError[],
): void {
  if (typeof value !== "string") {
    errors.push({ path, message: "expected string" });
    return;
  }
  if (schema.maxLength != null && value.length > schema.maxLength) {
    errors.push({ path, message: `string exceeds maxLength ${schema.maxLength}` });
  }
  if (schema.minLength != null && value.length < schema.minLength) {
    errors.push({ path, message: `string below minLength ${schema.minLength}` });
  }
  if (schema.pattern) {
    // Un `pattern` con sintaxis inválida en el contrato del cliente NO puede
    // lanzar aquí: la excepción tumbaba la validación entera y disparaba el
    // fail-open, que reenvía la petición al proveedor — el cliente pagaba DOS
    // veces por un error de SU propio esquema. Un regex que no compila se trata
    // como un fallo de validación (ruidoso, con motivo), no como una excepción.
    let re: RegExp | null = null;
    try {
      re = new RegExp(schema.pattern);
    } catch {
      errors.push({ path, message: `schema pattern is not a valid regular expression: ${schema.pattern}` });
    }
    if (re && !re.test(value)) {
      errors.push({ path, message: `string does not match pattern` });
    }
  }
}

function validateNumber(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: ValidationError[],
): void {
  if (typeof value !== "number" || Number.isNaN(value)) {
    errors.push({ path, message: "expected number" });
    return;
  }
  if (schema.type === "integer" && !Number.isInteger(value)) {
    errors.push({ path, message: "expected integer" });
  }
  if (schema.maximum != null && value > schema.maximum) {
    errors.push({ path, message: `number exceeds maximum ${schema.maximum}` });
  }
  if (schema.minimum != null && value < schema.minimum) {
    errors.push({ path, message: `number below minimum ${schema.minimum}` });
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}
