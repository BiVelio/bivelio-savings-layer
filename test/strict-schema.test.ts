import { describe, it, expect, vi } from "vitest";

import { OpenAICompatibleProvider, isStrictCompatible } from "../src/providers/openai-compatible.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";

/**
 * El modo `strict` de OpenAI impone dos reglas que JSON Schema NO tiene:
 * `additionalProperties: false` en todo objeto, y `required` listando TODAS las
 * claves de `properties`. En strict no existe el campo opcional.
 *
 * Enviábamos `strict: true` fijo, así que un contrato tan corriente como
 * {answer, refs?} devolvía 400 y tumbaba la petición entera — incluido el
 * reintento de fail-open, que reenvía el mismo esquema. Solo se ve contra un
 * proveedor real: ningún mock lo reproduce.
 */

const contratoConOpcional = {
  type: "object" as const,
  additionalProperties: false,
  required: ["answer"], // 'refs' falta: legal en JSON Schema, 400 en strict
  properties: {
    answer: { type: "string" as const },
    refs: { type: "array" as const, items: { type: "string" as const } },
  },
};

const contratoEstricto = {
  type: "object" as const,
  additionalProperties: false,
  required: ["answer", "refs"],
  properties: {
    answer: { type: "string" as const },
    refs: { type: "array" as const, items: { type: "string" as const } },
  },
};

describe("detección de compatibilidad con strict", () => {
  it("un campo opcional NO es compatible", () => {
    expect(isStrictCompatible(contratoConOpcional)).toBe(false);
  });

  it("todas las claves obligatorias SÍ lo es", () => {
    expect(isStrictCompatible(contratoEstricto)).toBe(true);
  });

  it("sin additionalProperties: false tampoco vale", () => {
    expect(isStrictCompatible({ ...contratoEstricto, additionalProperties: undefined })).toBe(false);
    expect(isStrictCompatible({ ...contratoEstricto, additionalProperties: true })).toBe(false);
  });

  it("mira DENTRO de los objetos anidados", () => {
    const anidado = {
      type: "object",
      additionalProperties: false,
      required: ["meta"],
      properties: {
        meta: {
          type: "object",
          additionalProperties: false,
          required: ["a"], // le falta 'b'
          properties: { a: { type: "string" }, b: { type: "string" } },
        },
      },
    };
    expect(isStrictCompatible(anidado)).toBe(false);
  });

  it("mira dentro de items de array y de anyOf", () => {
    const enItems = {
      type: "object", additionalProperties: false, required: ["xs"],
      properties: {
        xs: { type: "array", items: {
          type: "object", additionalProperties: false, required: [],
          properties: { a: { type: "string" } },
        } },
      },
    };
    expect(isStrictCompatible(enItems)).toBe(false);

    const enAnyOf = {
      anyOf: [
        { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } },
        { type: "object", additionalProperties: false, required: [], properties: { b: { type: "string" } } },
      ],
    };
    expect(isStrictCompatible(enAnyOf)).toBe(false);
  });

  it("un esquema sin properties (string, number…) no estorba", () => {
    expect(isStrictCompatible({ type: "string" })).toBe(true);
    expect(isStrictCompatible(undefined)).toBe(true);
  });
});

describe("lo que el proveedor pone de verdad en el cuerpo", () => {
  const capturar = () => {
    const visto: { body?: Record<string, unknown> } = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      visto.body = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"answer\":\"ok\"}" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    return { visto, fetchImpl };
  };

  const rf = (b?: Record<string, unknown>) =>
    (b?.["response_format"] as { json_schema?: { strict?: boolean; schema?: unknown } } | undefined)?.json_schema;

  it("un contrato con opcional se manda con strict:false en vez de reventar", async () => {
    const { visto, fetchImpl } = capturar();
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl });
    await p.generate({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hola" }], schema: contratoConOpcional });

    expect(rf(visto.body)?.strict).toBe(false);
    // El esquema SIGUE viajando: el modelo continúa guiado, solo se pierde la
    // garantía del proveedor — que es la del layer, no la única que hay.
    expect(rf(visto.body)?.schema).toEqual(contratoConOpcional);
  });

  it("un contrato estricto conserva strict:true (sin regresión)", async () => {
    const { visto, fetchImpl } = capturar();
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl });
    await p.generate({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hola" }], schema: contratoEstricto });

    expect(rf(visto.body)?.strict).toBe(true);
  });

  it("el contrato con opcional AVISA en inglés, una vez, y dice cómo recuperar la garantía", async () => {
    reiniciarAvisos();
    const avisos: string[] = [];
    const espiaWarn = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      avisos.push(a.map(String).join(" "));
    });
    try {
      const { fetchImpl } = capturar();
      const p = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl });
      const peticion = { model: "gpt-4o-mini", messages: [{ role: "user" as const, content: "hola" }] };
      await p.generate({ ...peticion, schema: contratoConOpcional });
      await p.generate({ ...peticion, schema: contratoConOpcional });
      // El estricto no tiene nada que avisar.
      await p.generate({ ...peticion, schema: contratoEstricto });

      const sobreStrict = avisos.filter((a) => a.includes("`strict`"));
      expect(sobreStrict, "una vez por proceso").toHaveLength(1);
      expect(sobreStrict[0]).toContain("must list ALL the keys in `properties`");
      expect(sobreStrict[0]).toContain("sent with `strict: false`");
      expect(sobreStrict[0]).toContain("make every key in the contract required");
    } finally {
      espiaWarn.mockRestore();
    }
  });

  it("sin contrato no se manda response_format", async () => {
    const { visto, fetchImpl } = capturar();
    const p = new OpenAICompatibleProvider({ baseUrl: "https://x/v1", fetchImpl });
    await p.generate({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hola" }] });

    expect(visto.body?.["response_format"]).toBeUndefined();
  });
});
