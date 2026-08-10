import { describe, it, expect } from "vitest";

import { validateAgainstSchema } from "../src/constraints/validate.js";

/**
 * `JsonSchema.type` es OPCIONAL en el contrato público. El validador despachaba
 * con un `switch (schema.type)` cuyo `default: break` no comprobaba NADA, así que
 * un contrato legal sin `type` en la raíz aprobaba cualquier respuesta — y el
 * informe lo publicaba como `structurallyValid: true`.
 *
 * Los 24 esquemas del resto de la suite empiezan todos por `type: "object"`, que
 * es justo el único caso que el validador sabía mirar: por eso el suite en verde
 * no detectó nada. Estos tests cubren la rama que faltaba.
 */
describe("validateAgainstSchema — esquemas sin `type` en la raíz", () => {
  const contrato = {
    properties: { answer: { type: "string" as const, maxLength: 400 } },
    required: ["answer"],
    additionalProperties: false,
  };

  it("rechaza el caso exacto que aprobaba: falta la obligatoria y sobra una prohibida", () => {
    const res = validateAgainstSchema({ wrong_key: "x".repeat(2000) }, contrato);
    expect(res.valid).toBe(false);
    const mensajes = res.errors.map((e) => `${e.path} ${e.message}`).join(" | ");
    expect(mensajes).toContain("missing required property");
    expect(mensajes).toContain("additional property not allowed");
  });

  it("aplica maxLength a las propiedades anidadas aunque la raíz no declare type", () => {
    const res = validateAgainstSchema({ answer: "x".repeat(401) }, contrato);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.message.includes("maxLength"))).toBe(true);
  });

  it("acepta la respuesta que sí cumple", () => {
    expect(validateAgainstSchema({ answer: "hola" }, contrato).valid).toBe(true);
  });

  it("un esquema sin `type` y sin palabras clave no impone nada", () => {
    expect(validateAgainstSchema({ lo: "que sea" }, {}).valid).toBe(true);
    expect(validateAgainstSchema(42, {}).valid).toBe(true);
  });

  it("las palabras clave de string aplican a un valor string sin `type` declarado", () => {
    expect(validateAgainstSchema("abcdef", { maxLength: 3 }).valid).toBe(false);
    expect(validateAgainstSchema("ab", { maxLength: 3 }).valid).toBe(true);
  });

  it("las de array también, incluidas las de sus elementos", () => {
    const esquema = { items: { type: "string" as const }, maxItems: 2 };
    expect(validateAgainstSchema(["a", "b", "c"], esquema).valid).toBe(false);
    expect(validateAgainstSchema(["a", 7], esquema).valid).toBe(false);
    expect(validateAgainstSchema(["a", "b"], esquema).valid).toBe(true);
  });

  it("un `type` declarado sigue mandando sobre el tipo del valor", () => {
    // No es inferencia permisiva: si el contrato dice object y llega un string,
    // sigue siendo un incumplimiento.
    expect(validateAgainstSchema("no soy un objeto", { type: "object" }).valid).toBe(false);
  });

  it("el enum sigue aplicando con o sin type", () => {
    expect(validateAgainstSchema("c", { enum: ["a", "b"] }).valid).toBe(false);
    expect(validateAgainstSchema("a", { enum: ["a", "b"] }).valid).toBe(true);
  });
});
