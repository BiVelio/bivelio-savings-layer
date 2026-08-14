import { describe, it, expect } from "vitest";

import {
  elegibilidadDeLaCascada,
  fuerzaDelVerificador,
  hechosDivergentes,
  verificarRespuesta,
} from "../src/constraints/verificador-de-cascada.js";
import type { JsonSchema, ToolDescriptor } from "../src/contracts/types.js";

/**
 * LA VERJA DETERMINISTA DE LA CASCADA.
 *
 * De ella depende que la palanca exista: con un juez que cueste una llamada, la
 * aritmética se hunde (juez barato → objetivo `0,5 − 2r`; juez fuerte →
 * `r + 1 + P > 1`, imposible SIEMPRE). Así que aquí no se llama a nadie, y lo
 * que se comprueba es que las dudas se resuelvan ESCALANDO — rechazar cuesta una
 * escalada, que se ve en el informe; aceptar de más cuesta una respuesta
 * equivocada servida como buena, que no se ve.
 */

const CONTRATO: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } },
};

const CON_VALORES: JsonSchema = {
  type: "object",
  required: ["estado", "total"],
  properties: {
    estado: { type: "string", enum: ["ok", "ko"] },
    total: { type: "number", maximum: 100 },
  },
};

const lectura: ToolDescriptor = { id: "buscar", intents: ["buscar"], risk: "read" };
const escritura: ToolDescriptor = { id: "enviar_factura", intents: ["enviar"], risk: "write" };

describe("qué es capaz de comprobar la verja", () => {
  it("sin contrato no puede comprobar NADA", () => {
    expect(fuerzaDelVerificador(undefined)).toBe("none");
  });

  it("un contrato de claves y tipos comprueba la FORMA y solo la forma", () => {
    expect(fuerzaDelVerificador(CONTRATO)).toBe("structural");
  });

  it("una restricción de VALOR sube la fuerza, esté donde esté en el esquema", () => {
    expect(fuerzaDelVerificador(CON_VALORES)).toBe("value-constrained");
    // Anidada dentro de un array de objetos: también cuenta.
    expect(
      fuerzaDelVerificador({
        type: "object",
        properties: {
          filas: { type: "array", items: { type: "object", properties: { n: { maximum: 5 } } } },
        },
      }),
    ).toBe("value-constrained");
  });

  it("`additionalProperties: false` NO es una restricción de valor", () => {
    // Es forma (qué claves), no contenido. Contarla habría ascendido a casi todo
    // contrato estricto sin que la verja mirase un solo campo.
    expect(fuerzaDelVerificador(CONTRATO)).toBe("structural");
  });
});

describe("elegibilidad: lo que NUNCA se enruta, pase lo que pase con el precio", () => {
  it("⛔ sin contrato de salida no se enruta", () => {
    // Es la configuración en la que el fallo silencioso es SEGURO: el verificador
    // acepta cualquier cosa, P(escalar) sale 0, el informe enseña el ahorro
    // máximo y nadie ha comprobado una sola respuesta.
    const e = elegibilidadDeLaCascada({ schema: undefined, tools: undefined });
    expect(e.elegible).toBe(false);
    expect(e.razon).toMatch(/no output contract/);
  });

  it("⛔ con una herramienta de ESCRITURA no se enruta, ni con contrato", () => {
    // La elección de ACCIÓN de un modelo más flojo no la ve ningún contrato de
    // salida: en un turno de herramientas la respuesta ni siquiera se valida.
    const e = elegibilidadDeLaCascada({ schema: CON_VALORES, tools: [lectura, escritura] });
    expect(e.elegible).toBe(false);
    expect(e.razon).toMatch(/write\/destructive/);
  });

  it("con contrato y solo herramientas de lectura, sí", () => {
    const e = elegibilidadDeLaCascada({ schema: CONTRATO, tools: [lectura] });
    expect(e.elegible).toBe(true);
    // Y lo dice claro: con contrato solo estructural, el contenido equivocado pasa.
    expect(e.razon).toMatch(/wrong content passes/);
  });

  it("la razón distingue las dos fuerzas, porque no valen lo mismo", () => {
    const conValores = elegibilidadDeLaCascada({ schema: CON_VALORES, tools: undefined });
    expect(conValores.razon).toMatch(/somewhere to fall/);
  });
});

describe("el veredicto sobre la respuesta del modelo barato", () => {
  const verificar = (texto: string, extra: Record<string, unknown> = {}) =>
    verificarRespuesta({ texto, schema: CONTRATO, pidioHerramientas: false, ...extra });

  it("acepta lo que cumple el contrato", () => {
    const v = verificar('{"answer":"vale"}');
    expect(v.acepta).toBe(true);
    expect(v.comprobaciones).toEqual(["non-empty", "final-answer", "not-truncated", "output-contract"]);
  });

  it("escala una respuesta vacía", () => {
    expect(verificar("   ").acepta).toBe(false);
    expect(verificar("   ").motivo).toMatch(/empty/);
  });

  it("escala un turno de herramientas: no es una respuesta final", () => {
    const v = verificar("", { pidioHerramientas: true, texto: "algo" });
    expect(v.acepta).toBe(false);
    expect(v.motivo).toMatch(/action, not a final answer/);
  });

  it("escala una respuesta CORTADA por el tope de salida", () => {
    // Un modelo barato suele ser más hablador, así que se choca con el
    // `maxOutputTokens` del llamante más a menudo. Y un JSON cortado a media
    // cadena no vale aunque el resto estuviera bien.
    const v = verificar('{"answer":"empieza bien pero', { finishReason: "length" });
    expect(v.acepta).toBe(false);
    expect(v.motivo).toMatch(/cut off/);
  });

  it("escala lo que no es JSON", () => {
    expect(verificar("claro, aquí tienes la respuesta").acepta).toBe(false);
  });

  it("escala lo que incumple el contrato, y dice qué falla", () => {
    const v = verificar('{"otra":"cosa"}');
    expect(v.acepta).toBe(false);
    expect(v.motivo).toMatch(/missing required property/);
  });

  it("escala también las restricciones de VALOR, no solo la forma", () => {
    // Es lo único que separa `value-constrained` de `structural`, y por tanto lo
    // único barato que le da al contenido equivocado por dónde caerse.
    const v = verificarRespuesta({
      texto: '{"estado":"quizas","total":9}',
      schema: CON_VALORES,
      pidioHerramientas: false,
    });
    expect(v.acepta).toBe(false);
    expect(v.motivo).toMatch(/enum/);

    const fuera = verificarRespuesta({
      texto: '{"estado":"ok","total":1000}',
      schema: CON_VALORES,
      pidioHerramientas: false,
    });
    expect(fuera.acepta).toBe(false);
    expect(fuera.motivo).toMatch(/exceeds maximum/);
  });

  it("⚠️ EL FALSO VÁLIDO: JSON impecable y contenido equivocado, ACEPTADO", () => {
    // Este test no comprueba un acierto: fija por escrito el agujero. Las dos
    // respuestas cumplen el contrato, una dice 42 y la otra 7, y la verja no
    // puede distinguirlas — mide la forma, no el significado. Su firma es
    // idéntica a la del éxito, baja P(escalar) y sube el ahorro reportado.
    const buena = verificarRespuesta({
      texto: '{"estado":"ok","total":42}',
      schema: CON_VALORES,
      pidioHerramientas: false,
    });
    const equivocada = verificarRespuesta({
      texto: '{"estado":"ok","total":7}',
      schema: CON_VALORES,
      pidioHerramientas: false,
    });
    expect(buena.acepta).toBe(true);
    expect(equivocada.acepta).toBe(true);
  });

  it("sin esquema el veredicto es ESCALAR, no aceptar", () => {
    // No debería llegarse aquí (la elegibilidad lo impide), pero si se llegara,
    // aceptar sería el falso válido garantizado.
    const v = verificarRespuesta({ texto: "lo que sea", schema: undefined, pidioHerramientas: false });
    expect(v.acepta).toBe(false);
  });
});

describe("la señal de divergencia: un motivo para MIRAR, nunca un veredicto", () => {
  it("marca dos respuestas que cumplen el contrato y no dicen lo mismo", () => {
    // Es la firma exacta del falso válido: los dos JSON validan y uno de los dos
    // miente sobre una cifra.
    const d = hechosDivergentes('{"total":7,"estado":"ok"}', '{"total":42,"estado":"ok"}');
    expect(d.divergen).toBe(true);
    expect(d.motivo).toMatch(/reason to look, never a verdict/);
  });

  it("no marca dos redacciones distintas del mismo hecho", () => {
    // La prosa se parafrasea sin mentir. Si contara, la señal marcaría el 100% de
    // las muestras y dejaría de significar nada.
    const d = hechosDivergentes(
      '{"resumen":"El informe concluye que el gasto bajo un poco durante el trimestre.","total":42}',
      '{"resumen":"Segun el informe, el gasto descendio ligeramente en el trimestre.","total":42}',
    );
    expect(d.divergen).toBe(false);
  });

  it("no marca el mismo conjunto de hechos en otro orden", () => {
    // Un array de resultados reordenado no es una contradicción.
    expect(hechosDivergentes('{"ids":[3,1,2]}', '{"ids":[1,2,3]}').divergen).toBe(false);
  });

  it("marca un booleano cambiado, que es donde vive una negación perdida", () => {
    expect(hechosDivergentes('{"aprobado":true}', '{"aprobado":false}').divergen).toBe(true);
  });

  it("marca un código corto distinto, aunque el resto coincida", () => {
    expect(hechosDivergentes('{"estado":"ok"}', '{"estado":"ko"}').divergen).toBe(true);
  });

  it("no opina cuando no hay nada comparable", () => {
    // Ni «divergen» ni «coinciden»: no hay hechos duros que mirar, y fingir un
    // veredicto sería exactamente lo que esta señal promete no hacer.
    expect(hechosDivergentes("no soy json", '{"a":1}').divergen).toBe(false);
    const soloProsa = hechosDivergentes(
      '{"t":"un parrafo suficientemente largo como para no ser un codigo ni un estado"}',
      '{"t":"otro parrafo suficientemente largo como para no ser un codigo ni un estado"}',
    );
    expect(soloProsa.divergen).toBe(false);
    expect(soloProsa.motivo).toMatch(/no comparable facts/);
  });
});
