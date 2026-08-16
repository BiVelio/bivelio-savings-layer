import { describe, it, expect } from "vitest";

import {
  mayorRespuestaQueAdmite,
  tokensDeLaMayorRespuesta,
} from "../src/constraints/techo-de-salida.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import { registrarTokenizadorExacto } from "../src/tokenizer/exact.js";
import { validateAgainstSchema } from "../src/constraints/validate.js";
import type { JsonSchema } from "../src/contracts/types.js";

/**
 * LA CUENTA QUE NADIE HABÍA HECHO, Y QUE DEJÓ UNA TIRADA ENTERA EN NO PROBADA.
 *
 * `maxLength` acota CARACTERES y `maxOutputTokens` acota TOKENS. Los caracteres
 * son los mismos para todo modelo; los tokens no. Un contrato cuyo tope se fijó
 * mirando un tokenizador queda calibrado sólo para ése, y el margen que le
 * quedaba contra otro no se descubre hasta que alguien mide otra familia y ve
 * las respuestas cortadas por la mitad.
 */

const esquemaDelBanco: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: {
    answer: { type: "string", maxLength: 400 },
    refs: { type: "array", maxItems: 3, items: { type: "string", maxLength: 120 } },
  },
};

const registro = new TokenizerRegistry();
const listo = registrarTokenizadorExacto(registro);
const contarCon = (modelo: string) => (t: string) => registro.count(t, { model: modelo });

describe("la mayor respuesta que un esquema autoriza", () => {
  it("usa TODO el presupuesto, incluidas las propiedades opcionales", () => {
    const texto = mayorRespuestaQueAdmite(esquemaDelBanco)!;
    const valor = JSON.parse(texto) as { answer: string; refs: string[] };
    // `refs` es opcional, pero la mayor respuesta que el contrato autoriza la
    // trae: el tope tiene que caber en el peor caso permitido, no en el típico.
    expect(valor.answer).toHaveLength(400);
    expect(valor.refs).toHaveLength(3);
    expect(valor.refs.every((r) => r.length === 120)).toBe(true);
  });

  it("y ese máximo CUMPLE el esquema: si no, no sería el máximo sino un invento", () => {
    const texto = mayorRespuestaQueAdmite(esquemaDelBanco)!;
    expect(validateAgainstSchema(JSON.parse(texto), esquemaDelBanco).valid).toBe(true);
  });

  it("de un `enum` toma el valor más largo", () => {
    const texto = mayorRespuestaQueAdmite({
      type: "object",
      additionalProperties: false,
      properties: { d: { type: "string", enum: ["ok", "request_more_evidence", "no"] } },
    })!;
    expect(JSON.parse(texto)).toEqual({ d: "request_more_evidence" });
  });

  it("CALLA cuando el esquema no acota: no hay techo honesto que dar", () => {
    // Callar es la respuesta correcta, no un fallo. Un número inventado aquí
    // acabaría de tope en el contrato de alguien.
    const sinMaxLength: JsonSchema = {
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" } },
    };
    const arrayAbierto: JsonSchema = {
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "array", items: { type: "string", maxLength: 3 } } },
    };
    const objetoAbierto: JsonSchema = {
      type: "object",
      properties: { a: { type: "string", maxLength: 3 } },
    };
    const decimal: JsonSchema = {
      type: "object",
      additionalProperties: false,
      // `maximum: 1` sigue admitiendo 0,999999999999: la longitud del texto no la
      // acota nadie. Un entero sí.
      properties: { a: { type: "number", maximum: 1 } },
    };
    for (const s of [sinMaxLength, arrayAbierto, objetoAbierto, decimal]) {
      expect(mayorRespuestaQueAdmite(s)).toBeNull();
    }
    expect(
      mayorRespuestaQueAdmite({
        type: "object",
        additionalProperties: false,
        properties: { a: { type: "integer", maximum: 999 } },
      }),
    ).toBe('{"a":999}');
  });
});

describe("el mismo esquema mide distinto en cada tokenizador", () => {
  it("EL FALLO DE LA TIRADA: el tope de 180 estaba entre las dos cuentas", async () => {
    await listo;
    // o200k_base es exacto para la familia GPT; para Claude el registro cae en el
    // estimador de la casa, que es justo el número con el que la propia capa
    // razonaría sobre ese modelo.
    const conGpt = tokensDeLaMayorRespuesta(esquemaDelBanco, contarCon("openai/gpt-4o-mini"))!;
    const conClaude = tokensDeLaMayorRespuesta(esquemaDelBanco, contarCon("anthropic/claude-sonnet-4-5"))!;

    expect(conGpt).toBeLessThan(180);
    expect(conClaude).toBeGreaterThan(180);
    // Y la diferencia no es de un pelo: es de más de un 40%, o sea mucho más que
    // cualquier margen que alguien creyera estar dejando.
    expect(conClaude / conGpt).toBeGreaterThan(1.4);
  });
});
