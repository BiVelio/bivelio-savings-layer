import { describe, it, expect } from "vitest";
import {
  planOutputCodebook,
  testigosDe,
  verificarTestigos,
  type CodebookNode,
} from "../src/constraints/codebook.js";
import {
  MemoriaDelCodebook,
  deltaMedidoDeLista,
  type EvidenciaDelCodebook,
} from "../src/constraints/codebook-evidencia.js";
import { validateAgainstSchema } from "../src/constraints/validate.js";
import { heuristicEstimator } from "../src/tokenizer/estimator.js";
import {
  createSavingsLayer,
  createMockProvider,
  listPrice,
  type JsonSchema,
  type ProviderRequest,
  type SavingsRequest,
} from "../src/index.js";

/**
 * EL CODEBOOK DE SALIDA.
 *
 * Lo que hay que demostrar aquí no es que "funcione": es que NO PUEDE mentir. La
 * palanca reescribe el contrato que ve el proveedor y deshace el cambio antes de
 * devolver, validar y cachear, así que un fallo suyo no se ve como un error —
 * se ve como datos correctos con las claves equivocadas, guardados 24 h.
 *
 * De ahí que cada verja tenga su prueba de que MUERDE (un caso que la dispara),
 * y no solo su prueba de que deja pasar lo bueno.
 *
 * ⚠️ EL SESGO DEL SIMULADOR, que es lo que hay que tener presente para leer este
 * fichero. `MockProvider` fabrica su respuesta A PARTIR DEL ESQUEMA que recibe:
 * con un esquema compacto fabrica una respuesta compacta, SIEMPRE. O sea que
 * cualquier test que mida "ahorro de salida" contra el simulador va a decir que
 * el codebook ahorra, contra cualquier modelo y con cualquier contrato — y eso
 * es un artefacto del fixture, no una propiedad del mundo. Medido en vivo, el
 * mismo contrato da +8,0 % en `gpt-4o` y −8,2 % en `gpt-4o-mini`, porque el
 * modelo pequeño ESCRIBE MÁS cuando le das nombres de campo cortos.
 *
 * Por eso aquí el delta de salida no se mide nunca contra el simulador: ENTRA
 * como dato (`EvidenciaDelCodebook`), y los tests lo ejercitan CON LOS DOS
 * SIGNOS. El proveedor `verboso()` de más abajo existe para poder escribir el
 * caso que el simulador no sabe representar: el de la salida que CRECE.
 */

const contar = (t: string) => heuristicEstimator.count(t);

/** Precios de lista de verdad: la verja decide en dinero, no en tokens pelados. */
const P_4O_MINI = listPrice("gpt-4o-mini")!; // salida = 4,0x entrada
const P_4O = listPrice("gpt-4o")!; //           salida = 4,0x entrada
const P_GPT4 = listPrice("gpt-4")!; //          salida = 2,0x entrada
const P_OPUS = listPrice("claude-opus-4")!; //  salida = 5,0x entrada

/** Un delta de salida MEDIDO, con la procedencia que la verja exige. */
const medido = (deltaTokens: number): EvidenciaDelCodebook => ({
  deltaTokens,
  origen: "caller",
  procedencia: "measured by the caller for this contract",
});

/** El contrato del ejemplo: claves largas y un enum de valores largos. */
const CONTRATO: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "confidence", "evidence"],
  properties: {
    decision: { type: "string", enum: ["human_review", "auto_approve", "auto_reject"] },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    evidence: { type: "array", maxItems: 4, items: { type: "string", maxLength: 16 } },
  },
};

describe("el codebook deriva un contrato equivalente y más barato", () => {
  it("acorta claves y codifica los valores de enum", () => {
    const d = planOutputCodebook(CONTRATO, contar, P_4O_MINI, { evidencia: medido(0) });
    expect(d.applied).toBe(true);
    if (!d.applied) return;

    const props = Object.keys(d.plan.compactSchema.properties ?? {});
    expect(props).toEqual(["d", "c", "e"]);
    expect(d.plan.compactSchema.required).toEqual(["d", "c", "e"]);
    // Los códigos del enum salen de los propios valores. Se ASIGNAN en orden
    // lexicográfico (auto_approve → A, auto_reject → AU, human_review → H) y se
    // PUBLICAN en el orden original del enum.
    expect(d.plan.compactSchema.properties?.["d"]?.enum).toEqual(["H", "A", "AU"]);
    expect(d.plan.renamedKeys).toBe(3);
    expect(d.plan.codedEnumValues).toBe(3);
  });

  it("la expansión devuelve EXACTAMENTE la forma del llamante", () => {
    const d = planOutputCodebook(CONTRATO, contar, P_4O_MINI, { evidencia: medido(0) });
    if (!d.applied) throw new Error("se esperaba que se aplicara");

    const delLlamante = {
      decision: "human_review",
      confidence: 87,
      evidence: ["E17:4", "E22:1"],
    };
    expect(d.plan.compact(delLlamante)).toEqual({ d: "H", c: 87, e: ["E17:4", "E22:1"] });
    expect(d.plan.expand({ d: "H", c: 87, e: ["E17:4", "E22:1"] })).toEqual(delLlamante);
    expect(validateAgainstSchema(d.plan.expand(d.plan.compact(delLlamante)), CONTRATO).valid).toBe(
      true,
    );
  });

  it("expandir es TOTAL: lo que no reconoce lo deja intacto", () => {
    const d = planOutputCodebook(CONTRATO, contar, P_4O_MINI, { evidencia: medido(0) });
    if (!d.applied) throw new Error("se esperaba que se aplicara");
    // Un valor de enum que el modelo devolvió en largo NO se reescribe a ciegas:
    // ya es la respuesta correcta.
    expect(d.plan.expand({ d: "auto_approve" })).toEqual({ decision: "auto_approve" });
    // Y una forma que no es la prometida sale tal cual, para que el fallo lo
    // diagnostique el validador y no una excepción sin contexto.
    expect(d.plan.expand("no soy un objeto")).toBe("no soy un objeto");
    expect(d.plan.expand(null)).toBe(null);
  });

  it("los códigos NO dependen del orden en que estén escritas las propiedades", () => {
    // Mismo contrato, escrito al revés. Si los códigos cambiaran, el prefijo
    // estable que la caché del proveedor necesita se rompería sin que nadie
    // tocara el contrato.
    const alReves: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["evidence", "confidence", "decision"],
      properties: {
        evidence: { type: "array", maxItems: 4, items: { type: "string", maxLength: 16 } },
        confidence: { type: "integer", minimum: 0, maximum: 100 },
        decision: { type: "string", enum: ["auto_reject", "auto_approve", "human_review"] },
      },
    };
    const a = planOutputCodebook(CONTRATO, contar, P_4O_MINI, { evidencia: medido(0) });
    const b = planOutputCodebook(alReves, contar, P_4O_MINI, { evidencia: medido(0) });
    if (!a.applied || !b.applied) throw new Error("se esperaba que se aplicaran las dos");

    const valor = { decision: "auto_reject", confidence: 5, evidence: ["x"] };
    expect(b.plan.compact(valor)).toEqual(a.plan.compact(valor));
    // Y el esquema compacto conserva el orden ORIGINAL de escritura: en modo
    // estructurado ese orden es el orden de generación, y reordenarlo sería
    // cambiar el comportamiento del modelo por debajo.
    expect(Object.keys(b.plan.compactSchema.properties ?? {})).toEqual(["e", "c", "d"]);
  });
});

describe("las verjas del codebook muerden", () => {
  // Las verjas ESTRUCTURALES se prueban con el suelo de ahorro a cero Y con un
  // delta de salida medido NEUTRO, para que lo que se observe sea la verja que
  // el test dice y no la de dinero o la de evidencia tapándola.
  const sinSuelo = { minimumSavingsTokens: 0, evidencia: medido(0) };

  it("⛔ un `pattern` deja el esquema fuera: no hay testigo que lo demuestre", () => {
    const conPattern: JsonSchema = {
      ...CONTRATO,
      properties: {
        ...CONTRATO.properties,
        evidence: { type: "array", maxItems: 4, items: { type: "string", pattern: "^E\\d+$" } },
      },
    };
    const d = planOutputCodebook(conPattern, contar, P_4O_MINI, sinSuelo);
    expect(d.applied).toBe(false);
    if (d.applied) return;
    expect(d.reason).toMatch(/pattern/);
  });

  it("⛔ con `additionalProperties` abierto no se renombra ninguna clave", () => {
    // Una clave que el esquema no declara sería indistinguible de un código
    // nuestro al expandir, y expandir dejaría de ser demostrable.
    const abierto: JsonSchema = { ...CONTRATO };
    delete abierto.additionalProperties;
    const d = planOutputCodebook(abierto, contar, P_4O_MINI, sinSuelo);
    expect(d.applied).toBe(true);
    if (!d.applied) return;
    expect(Object.keys(d.plan.compactSchema.properties ?? {})).toEqual([
      "decision",
      "confidence",
      "evidence",
    ]);
    expect(d.plan.renamedKeys).toBe(0);
    // El enum sí se codifica: eso no depende de qué claves declare el objeto.
    expect(d.plan.codedEnumValues).toBe(3);
  });

  it("⛔ un código que coincide con OTRA clave del mismo objeto anula el renombrado", () => {
    // `de` y `decision`: en orden lexicográfico `de` se lleva el código "d" y
    // `decision` querría "de", que es el nombre literal del primero. Al recibir
    // "de" no habría forma de saber cuál de los dos quiso decir el modelo.
    const ambiguo: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["de", "decision"],
      properties: {
        de: { type: "string", maxLength: 8 },
        decision: { type: "string", enum: ["human_review", "auto_approve"] },
      },
    };
    const d = planOutputCodebook(ambiguo, contar, P_4O_MINI, sinSuelo);
    expect(d.applied).toBe(true);
    if (!d.applied) return;
    expect(Object.keys(d.plan.compactSchema.properties ?? {})).toEqual(["de", "decision"]);
    expect(d.plan.renamedKeys).toBe(0);
  });

  it("⛔ un enum con `minLength` no se codifica: el código no cumpliría el mínimo", () => {
    const conMinimo: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["decision"],
      properties: {
        decision: { type: "string", minLength: 6, enum: ["human_review", "auto_approve"] },
      },
    };
    const d = planOutputCodebook(conMinimo, contar, P_4O_MINI, sinSuelo);
    expect(d.applied).toBe(true);
    if (!d.applied) return;
    expect(d.plan.compactSchema.properties?.["d"]?.enum).toEqual(["human_review", "auto_approve"]);
    expect(d.plan.codedEnumValues).toBe(0);
    // Y el esquema compacto sigue siendo admisible: si el codebook hubiera
    // codificado ese enum, "H" incumpliría su propio `minLength: 6` y el contrato
    // que viaja al proveedor describiría algo imposible.
    expect(validateAgainstSchema({ d: "human_review" }, d.plan.compactSchema).valid).toBe(true);
  });

  it("⛔ verja de dinero: cuenta los DOS lados y se niega por debajo del suelo", () => {
    const d = planOutputCodebook(CONTRATO, contar, P_4O_MINI, {
      minimumSavingsTokens: 10_000,
      evidencia: medido(0),
    });
    expect(d.applied).toBe(false);
    if (d.applied) return;
    // El motivo publica el DINERO —que es la unidad en la que se decide— y las
    // dos mitades que lo componen, más el delta de equilibrio: sin él, quien lea
    // el rechazo no sabe qué tendría que medir para darle la vuelta.
    expect(d.reason).toMatch(
      /^net saving \$-?[\d.]+\/request is below the floor of 10000 input tokens \(\$[\d.]+\): the compact contract saves \d+ input tokens and the measured output delta is \+0 tokens .+; break-even at -?[\d.]+$/,
    );
  });

  it("⛔ SIN MEDICIÓN no se aplica, y el motivo dice qué hay que medir", () => {
    // La verja 4. El contrato es el mismo que sí se aplica con un delta medido
    // dos tests más abajo: lo que falta no es compresión, es EVIDENCIA.
    const d = planOutputCodebook(CONTRATO, contar, P_4O_MINI, { minimumSavingsTokens: 0 });
    expect(d.applied).toBe(false);
    if (d.applied) return;
    expect(d.reason).toMatch(/^no measured output delta for this model/);
    // Y publica las DOS mediciones, no la mala sola: media frase («la salida
    // crece») fue exactamente lo que produjo la conclusión equivocada de retirar
    // una palanca que gana un 8 % en el otro modelo.
    expect(d.reason).toContain("gpt-4o-mini wrote 16 tokens MORE");
    expect(d.reason).toContain("gpt-4o wrote 3 tokens FEWER");
    // Y el umbral concreto de ESTE contrato, no una recomendación genérica.
    expect(d.reason).toMatch(/output delta stays above -?[\d.]+ tokens/);
    expect(d.reason).toContain("benchmarks/ab-live.ts");
  });

  it("⛔ un delta MEDIDO NEGATIVO apaga la palanca, y no hay esquema que la compre", () => {
    // EL CASO REAL DE `gpt-4o-mini`: la salida CRECE. Con la verja vieja —tokens
    // pelados, y dando por hecho que compactar el esquema no aumenta la salida—
    // este contrato se aplicaba y la petición salía un 8,2 % más cara.
    const d = planOutputCodebook(CONTRATO, contar, P_4O_MINI, { evidencia: medido(-16) });
    expect(d.applied).toBe(false);
    if (d.applied) return;
    expect(d.reason).toMatch(/this model writes MORE from a compact contract/);

    // Y NO SE COMPRA CON UN ESQUEMA ENORME. La aritmética sola volvería a aplicar
    // en cuanto el ahorro de entrada superara 8 + 16·4 = 72 tokens, que es justo
    // un contrato grande — con respuestas más largas, donde la pérdida de salida
    // sería MAYOR que los −16 medidos sobre respuestas de 72 tokens.
    const props: Record<string, JsonSchema> = {};
    for (let i = 0; i < 20; i++) {
      props[`un_nombre_de_propiedad_deliberadamente_larguisimo_${i}`] = { type: "string", maxLength: 8 };
    }
    const enorme: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: Object.keys(props),
      properties: props,
    };
    const conEsquemaEnorme = planOutputCodebook(enorme, contar, P_4O_MINI, { evidencia: medido(0) });
    if (!conEsquemaEnorme.applied) throw new Error("el fixture tiene que ahorrar de sobra");
    expect(
      conEsquemaEnorme.plan.schemaTokensOriginal - conEsquemaEnorme.plan.schemaTokensCompact,
    ).toBeGreaterThan(72);
    expect(planOutputCodebook(enorme, contar, P_4O_MINI, { evidencia: medido(-16) }).applied).toBe(
      false,
    );
  });

  it("✅ un delta MEDIDO POSITIVO sí se aplica: el otro signo también existe", () => {
    // EL CASO REAL DE `gpt-4o`, y la razón de que la palanca no se retirara: con
    // el mismo contrato y el mismo prompt escribió 3 tokens MENOS y la petición
    // salió un 8,0 % más barata. Una verja que solo supiera representar el caso
    // de `gpt-4o-mini` dejaría ese dinero encima de la mesa.
    const d = planOutputCodebook(CONTRATO, contar, P_4O, { evidencia: medido(3) });
    expect(d.applied).toBe(true);
    if (!d.applied) return;
    expect(d.plan.measuredOutputDeltaTokens).toBe(3);
    // Y el neto es DINERO, con cada lado a SU tarifa. Escrito a mano para que la
    // cuenta no dependa de la propia función: 18 tokens de entrada ahorrados a
    // 0,0025 $/1k más 3 de salida a 0,01 $/1k. Una suma en tokens pelados (21
    // tokens de entrada) daría 0,0000525 $, un 30 % menos.
    const ahorroEsquema = d.plan.schemaTokensOriginal - d.plan.schemaTokensCompact;
    expect(ahorroEsquema).toBe(18);
    expect(d.plan.netSavingUsd).toBeCloseTo(
      (18 / 1000) * P_4O.inputPer1k + (3 / 1000) * P_4O.outputPer1k,
      12,
    );
    // La procedencia viaja pegada al número. Un «+3» suelto es lo que hace que
    // alguien lo aplique al modelo de al lado, que es donde vale −16.
    expect(d.plan.outputDeltaProvenance).toContain("measured by the caller");
  });

  it("⛔ la verja PONDERA POR PRECIO: el mismo contrato y el mismo delta cambian de veredicto según el modelo", () => {
    // Sin ponderar, el ahorro de esquema y el delta de salida se sumarían como si
    // un token valiera lo mismo en los dos lados. Y la razón NO es la misma en
    // todos los modelos: 2,0x en `gpt-4`, 5,0x en `claude-opus-4`.
    //
    // Este contrato ahorra 18 tokens de entrada y el delta medido es +3 de salida.
    // Con el suelo en 30 tokens de entrada equivalentes:
    //
    //   tokens pelados:                 18 + 3   = 21  < 30  → los DOS se niegan
    //   `gpt-4` (salida 2,0x):          18 + 3·2 = 24  < 30  → se niega
    //   `claude-opus-4` (salida 5,0x):  18 + 3·5 = 33  ≥ 30  → SE APLICA
    //
    // Mismo esquema, mismos tokens, mismo delta: lo único que cambia es la
    // tarifa, y cambia el veredicto. Con la verja vieja los dos daban lo mismo.
    const suelo = { minimumSavingsTokens: 30 };
    const conGpt4 = planOutputCodebook(CONTRATO, contar, P_GPT4, { ...suelo, evidencia: medido(3) });
    const conOpus = planOutputCodebook(CONTRATO, contar, P_OPUS, { ...suelo, evidencia: medido(3) });
    expect(conGpt4.applied).toBe(false);
    expect(conOpus.applied).toBe(true);

    // Y la razón de precio de verdad es la del catálogo, no una constante local:
    // si mañana cambia una tarifa, este test tiene que enterarse.
    expect(P_OPUS.outputPer1k / P_OPUS.inputPer1k).toBeCloseTo(5, 6);
    expect(P_GPT4.outputPer1k / P_GPT4.inputPer1k).toBeCloseTo(2, 6);
  });

  it("⛔ el ahorro de FORMA modelado es el del PEOR testigo, y ya no decide", () => {
    // El módulo dice equivocarse a la BAJA y de ahí depende que la palanca no se
    // aplique donde no paga. Con un enum de valores muy desiguales las dos reglas
    // se separan: quedarse con el mejor testigo casi triplica la cifra.
    //
    // Y HOY ESA CIFRA NO DECIDE NADA: se publica como diagnóstico. Ésa es la
    // reparación de fondo — modelar la salida sobre un testigo sintético mide la
    // FORMA (los mismos datos con menos símbolos) y no el CONTENIDO (cuánto
    // escribe el modelo), que es la mitad que se llevó el dinero.
    const desigual: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["decision"],
      properties: {
        decision: { type: "string", enum: ["ok", "escalate_to_a_human_operator_immediately"] },
      },
    };
    const d = planOutputCodebook(desigual, contar, P_4O_MINI, sinSuelo);
    if (!d.applied) throw new Error("se esperaba que se aplicara");

    const delta = (v: unknown) =>
      contar(JSON.stringify(v)) - contar(JSON.stringify(d.plan.compact(v)));
    const peor = delta({ decision: "ok" });
    const mejor = delta({ decision: "escalate_to_a_human_operator_immediately" });
    expect(mejor).toBeGreaterThan(peor);
    expect(d.plan.modelledShapeSavingTokens).toBe(peor);
  });

  it("⛔ un esquema demasiado profundo o cíclico se descarta POR SU MOTIVO, no por un `pattern` inventado", () => {
    // El corte por profundidad vivía dentro de `contienePattern`, que devolvía
    // `true`: los dos esquemas de aquí abajo —sin un solo regex— se rechazaban
    // diciendo «schema has a pattern», y la rama de `RangeError` era código muerto.
    // Una traza que manda al cliente a buscar en su contrato algo que no está es
    // peor que una traza que calla.
    let profundo: JsonSchema = { type: "string", maxLength: 4 };
    for (let i = 0; i < 18; i++) {
      profundo = {
        type: "object",
        additionalProperties: false,
        required: [`nivel_${i}`],
        properties: { [`nivel_${i}`]: profundo },
      };
    }
    const hondo = planOutputCodebook(profundo, contar, P_4O_MINI, sinSuelo);
    expect(hondo.applied).toBe(false);
    if (hondo.applied) return;
    expect(hondo.reason).toBe("schema too deep or cyclic");
    expect(hondo.reason).not.toMatch(/pattern/);

    // Y un esquema construido por referencia circular: sin el corte no termina.
    const ciclico: JsonSchema = { type: "object", additionalProperties: false, properties: {} };
    (ciclico.properties as Record<string, JsonSchema>)["hijo"] = ciclico;
    (ciclico.properties as Record<string, JsonSchema>)["descripcion_larga"] = { type: "string" };
    const circular = planOutputCodebook(ciclico, contar, P_4O_MINI, sinSuelo);
    expect(circular.applied).toBe(false);
    if (circular.applied) return;
    expect(circular.reason).toBe("schema too deep or cyclic");
  });

  it("⛔ un ahorro trivial no vale el cambio de contrato", () => {
    // Renombrable (la clave se acorta), pero lo que se gana no llega al suelo por
    // defecto: cambiar el `response_format` que ve el proveedor no se hace gratis.
    const minusculo: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    };
    const d = planOutputCodebook(minusculo, contar, P_4O_MINI, { evidencia: medido(0) });
    expect(d.applied).toBe(false);
    if (d.applied) return;
    expect(d.reason).toMatch(/below the floor of 8 input tokens/);
    // Con el suelo a cero sí habría codebook: lo que lo frena es el suelo, no una
    // incapacidad de comprimir.
    expect(planOutputCodebook(minusculo, contar, P_4O_MINI, sinSuelo).applied).toBe(true);
  });

  it("⛔ NO basta con un testigo: el fallo puede estar en el segundo valor del enum", () => {
    // Contrato que se contradice a sí mismo: dice `maxLength: 6` y luego lista un
    // valor de 12 caracteres. El primer valor del enum lo cumple y el segundo no,
    // así que con un solo testigo el codebook pasaría la verja y se aplicaría
    // sobre un contrato que ninguna respuesta puede cumplir. Se necesita una
    // ronda por posición de enum para verlo.
    const seContradice: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["decision"],
      properties: { decision: { type: "string", maxLength: 6, enum: ["ok", "human_review"] } },
    };
    const d = planOutputCodebook(seContradice, contar, P_4O_MINI, sinSuelo);
    expect(d.applied).toBe(false);
    if (d.applied) return;
    expect(d.reason).toMatch(/witness does not satisfy the caller's own schema/);

    // Y con el enum recortado al valor que SÍ cumple, el mismo contrato pasa: lo
    // que frena no es el `maxLength`, es la contradicción.
    const coherente: JsonSchema = {
      ...seContradice,
      properties: { decision: { type: "string", maxLength: 6, enum: ["ok", "review"] } },
    };
    expect(planOutputCodebook(coherente, contar, P_4O_MINI, sinSuelo).applied).toBe(true);
  });

  it("⛔ un contrato sin nada que comprimir no se aplica ni con el suelo a cero", () => {
    const yaCorto: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "boolean" } },
    };
    const d = planOutputCodebook(yaCorto, contar, P_4O_MINI, sinSuelo);
    expect(d.applied).toBe(false);
    if (d.applied) return;
    expect(d.reason).toMatch(/nothing to compact/);
  });
});

describe("las verjas 1 y 2, ejercitadas por su camino de RECHAZO", () => {
  /**
   * POR QUÉ ESTE BLOQUE EXISTE, y por qué no puede escribirse contra
   * `planOutputCodebook`.
   *
   * Las verjas de ADMISIBILIDAD y REVERSIBILIDAD son INALCANZABLES desde la
   * derivación real: los guardias por nodo (`usados`, el de ambigüedad, el de
   * `minLength`) cortan antes todos los caminos que las harían morder. Medido por
   * mutación: con la comprobación incrustada en `planOutputCodebook`, sustituir
   * cualquiera de las dos condiciones por `if (false)` dejaba la suite ENTERA en
   * verde. Es decir, la única red que sostiene la afirmación «esto es lossless»
   * no estaba comprobada, y un cambio futuro en `transformar()` o en `derivar()`
   * que rompiera el round-trip se publicaría en silencio: el cliente recibiría
   * —y cachearía 24 h— datos distintos de los que generó el modelo, sin que nada
   * se pareciera a un error.
   *
   * Así que la comprobación se sacó a `verificarTestigos`, y aquí se le pasa un
   * `node` ROTO A MANO: lo que se ejercita es el camino de RECHAZO, que es el que
   * no recorría nadie. Los testigos son los DE VERDAD (`testigosDe`), no unos
   * escritos a mano, para que estos tests se enteren si la síntesis deja de
   * cubrir algún valor de algún enum.
   */

  /** Contrato de una sola clave renombrable, sin enum: aísla la verja de claves. */
  const UNA_CLAVE: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["decision"],
    properties: { decision: { type: "string", maxLength: 20 } },
  };
  /** El nodo y el esquema compacto que le corresponden, ambos CORRECTOS. */
  const nodoBueno = (): CodebookNode => ({
    keysFwd: new Map([["decision", "d"]]),
    keysBack: new Map([["d", "decision"]]),
  });
  const COMPACTO_BUENO: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["d"],
    properties: { d: { type: "string", maxLength: 20 } },
  };

  /** Contrato con enum, para romper el otro mapa: el de valores. */
  const CON_ENUM: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["decision"],
    properties: { decision: { type: "string", enum: ["human_review", "auto_approve"] } },
  };
  const nodoConEnum = (enumBack: Map<string, string>): CodebookNode => ({
    keysFwd: new Map([["decision", "d"]]),
    keysBack: new Map([["d", "decision"]]),
    props: new Map<string, CodebookNode>([
      [
        "decision",
        {
          enumFwd: new Map([
            ["human_review", "H"],
            ["auto_approve", "A"],
          ]),
          enumBack,
        },
      ],
    ]),
  });
  const COMPACTO_CON_ENUM: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["d"],
    properties: { d: { type: "string", enum: ["H", "A"] } },
  };

  it("✅ control: con el nodo y el esquema compacto correctos, las dos verjas dejan pasar", () => {
    // Sin este control, los rechazos de abajo podrían estar disparándose por un
    // fixture mal escrito en vez de por lo que cada test dice romper.
    expect(verificarTestigos(UNA_CLAVE, COMPACTO_BUENO, nodoBueno(), testigosDe(UNA_CLAVE)).ok).toBe(
      true,
    );
    const back = new Map([
      ["H", "human_review"],
      ["A", "auto_approve"],
    ]);
    expect(
      verificarTestigos(CON_ENUM, COMPACTO_CON_ENUM, nodoConEnum(back), testigosDe(CON_ENUM)).ok,
    ).toBe(true);
  });

  it("⛔ ADMISIBILIDAD: un `required` compacto sin reescribir se rechaza", () => {
    // El esquema compacto renombra la propiedad a `d` pero sigue exigiendo
    // `decision`. Describe algo que ninguna respuesta puede cumplir, y viaja al
    // proveedor como `response_format`: sin esta verja, la petición entera se
    // rechaza en el proveedor y el fallo aparece a mil kilómetros de su causa.
    const compactoRoto: JsonSchema = { ...COMPACTO_BUENO, required: ["decision"] };
    const v = verificarTestigos(UNA_CLAVE, compactoRoto, nodoBueno(), testigosDe(UNA_CLAVE));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("compact witness does not validate against the compact schema");
  });

  it("⛔ ADMISIBILIDAD: un enum compacto sin reescribir se rechaza", () => {
    // El nodo codifica "human_review" → "H" pero el esquema compacto sigue
    // publicando los valores largos: el contrato prohíbe exactamente lo que la
    // capa va a pedir. Es la misma trampa que el guardia de `minLength` evita
    // desde el otro lado.
    const sinReescribirElEnum: JsonSchema = {
      ...COMPACTO_CON_ENUM,
      properties: { d: { type: "string", enum: ["human_review", "auto_approve"] } },
    };
    const back = new Map([
      ["H", "human_review"],
      ["A", "auto_approve"],
    ]);
    const v = verificarTestigos(
      CON_ENUM,
      sinReescribirElEnum,
      nodoConEnum(back),
      testigosDe(CON_ENUM),
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("compact witness does not validate against the compact schema");
  });

  it("⛔ REVERSIBILIDAD: un mapa de claves cuyo inverso NO es el inverso se rechaza", () => {
    // `keysBack` devuelve `decisiones` donde `keysFwd` mandó `decision`. Nada de
    // esto se parece a un error visto desde fuera: la respuesta llega, es un JSON
    // bien formado, y lleva una clave que el llamante nunca declaró. Este es el
    // fallo del que la reversibilidad es la ÚNICA red.
    const inversoRoto: CodebookNode = {
      keysFwd: new Map([["decision", "d"]]),
      keysBack: new Map([["d", "decisiones"]]),
    };
    const v = verificarTestigos(UNA_CLAVE, COMPACTO_BUENO, inversoRoto, testigosDe(UNA_CLAVE));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("round trip is not the identity");
  });

  it("⛔ REVERSIBILIDAD: un valor de enum que falta en el mapa inverso se rechaza, y hace falta el SEGUNDO testigo para verlo", () => {
    // `enumBack` sabe deshacer "H" pero no "A": expandir es total, así que "A" se
    // deja pasar tal cual y el llamante recibe `{"decision":"A"}` — un valor que
    // su propio enum no contiene. El primer testigo pasa; lo caza el segundo.
    const backIncompleto = new Map([["H", "human_review"]]);
    const testigos = testigosDe(CON_ENUM);
    expect(testigos).toEqual([{ decision: "human_review" }, { decision: "auto_approve" }]);

    const v = verificarTestigos(
      CON_ENUM,
      COMPACTO_CON_ENUM,
      nodoConEnum(backIncompleto),
      testigos,
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("round trip is not the identity");

    // Y con SOLO el primer testigo el mismo nodo roto pasaría: la ronda por
    // posición de enum no es un lujo, es lo que hace visible este fallo.
    expect(
      verificarTestigos(CON_ENUM, COMPACTO_CON_ENUM, nodoConEnum(backIncompleto), [testigos[0]]).ok,
    ).toBe(true);
  });

  it("y `planOutputCodebook` publica el veredicto TAL CUAL", () => {
    // Las dos verjas de arriba no se alcanzan desde la derivación real, pero la
    // TERCERA comprobación de `verificarTestigos` —que el testigo cumpla el
    // contrato del propio llamante— sí. Que el motivo salga idéntico por las dos
    // vías es lo que ata la función al sitio donde decide: si alguien quitara la
    // llamada, esto cae.
    const seContradice: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["decision"],
      properties: { decision: { type: "string", maxLength: 6, enum: ["ok", "human_review"] } },
    };
    const v = verificarTestigos(seContradice, seContradice, {}, testigosDe(seContradice));
    expect(v.ok).toBe(false);
    if (v.ok) return;

    const d = planOutputCodebook(seContradice, contar, P_4O_MINI, { minimumSavingsTokens: 0 });
    expect(d.applied).toBe(false);
    if (d.applied) return;
    expect(d.reason).toBe(v.reason);
  });
});

describe("el codebook enchufado al pipeline", () => {
  /** Provider espía: anota el esquema que de verdad recibe. */
  function espia(respuesta?: (req: ProviderRequest) => string) {
    const vistos: (JsonSchema | undefined)[] = [];
    const provider = {
      id: "espia",
      async generate(req: ProviderRequest) {
        vistos.push(req.schema);
        const text = respuesta ? respuesta(req) : JSON.stringify({ d: "H", c: 87, e: ["E17:4"] });
        return {
          text,
          usage: { inputTokens: 100, outputTokens: contar(text) },
          structuredNatively: true,
        };
      },
    };
    return { provider, vistos };
  }

  /**
   * Proveedor VERBOSO: el que el simulador no sabe ser.
   *
   * `MockProvider` fabrica desde el esquema, así que con el contrato compacto
   * devuelve una respuesta compacta y el codebook «ahorra» siempre. El mundo no
   * se comporta así: medido contra `gpt-4o-mini`, con nombres de campo cortos el
   * modelo RELLENA MÁS y la salida pasó de 72 a 88 tokens. Esto reproduce ese
   * comportamiento — mismo contenido útil, más evidencia de relleno cuando ve
   * `"d"` en vez de `"decision"` — para poder escribir el caso que cuesta dinero.
   */
  function verboso() {
    const salidas: number[] = [];
    const provider = {
      id: "verboso",
      async generate(req: ProviderRequest) {
        const compacto = req.schema?.properties?.["d"] != null;
        // Con el contrato compacto rellena el array opcional hasta el tope; con
        // el largo se queda en lo justo. Es la verbosidad medida, no la forma.
        const relleno = compacto ? ["E17:4", "E22:1", "E31:9", "E44:2"] : ["E17:4"];
        const text = compacto
          ? JSON.stringify({ d: "H", c: 87, e: relleno })
          : JSON.stringify({ decision: "human_review", confidence: 87, evidence: relleno });
        salidas.push(contar(text));
        return { text, usage: { inputTokens: 100, outputTokens: contar(text) }, structuredNatively: true };
      },
    };
    return { provider, salidas };
  }

  const peticion = (extra?: Partial<SavingsRequest>): SavingsRequest => ({
    // `gpt-4o`, y el modelo es parte del fixture: es aquel para el que BiVelio
    // TIENE un delta medido positivo. Con `gpt-4o-mini` —mismo contrato, mismo
    // prompt— el catálogo trae −16 y la palanca no se aplica, que es lo que
    // comprueba el test «el MISMO contrato, dos modelos, dos veredictos».
    model: "openai/gpt-4o",
    messages: [{ role: "user", content: "clasifica el expediente 4711 y cita la evidencia" }],
    response: { contractId: "triage:v1", schema: CONTRATO, maxOutputTokens: 200 },
    ...extra,
  });

  it("el proveedor recibe el contrato COMPACTO y el llamante recibe el SUYO", async () => {
    const { provider, vistos } = espia();
    const layer = createSavingsLayer({ provider });
    const res = await layer.generate(peticion({ savings: { outputCodebook: true } }));

    expect(Object.keys(vistos[0]?.properties ?? {})).toEqual(["d", "c", "e"]);
    // Lo que sale por la puerta está en la forma del llamante, en `data` Y en
    // `text` — quien haga JSON.parse(result.text) no puede ver la forma compacta.
    expect(res.data).toEqual({ decision: "human_review", confidence: 87, evidence: ["E17:4"] });
    expect(JSON.parse(res.text)).toEqual(res.data);
    expect(res.report.constraints.structurallyValid).toBe(true);
  });

  it("lo que entra en la CACHÉ es la forma del llamante, no la compacta", async () => {
    const { provider } = espia();
    const layer = createSavingsLayer({ provider });
    const req = peticion({ savings: { outputCodebook: true } });
    await layer.generate(req);
    // Segunda petición IDÉNTICA pero con la palanca apagada: si en la caché
    // hubiera quedado `{"d":...}`, este llamante recibiría claves que su propio
    // contrato no declara.
    const segunda = await layer.generate(peticion({ savings: { outputCodebook: false } }));
    expect(segunda.report.cache.result).toBe("exact");
    const esperado = { decision: "human_review", confidence: 87, evidence: ["E17:4"] };
    expect(segunda.data).toEqual(esperado);
    // `text` TAMBIÉN, y no es redundante: se guardan por separado, así que una
    // entrada con `data` bien y `text` compacto es un estado posible — y el que
    // rompe a quien lee `result.text` en vez de `result.data`.
    expect(JSON.parse(segunda.text)).toEqual(esperado);
    expect(segunda.report.constraints.structurallyValid).toBe(true);
  });

  it("sin pedirlo, el proveedor recibe el contrato ORIGINAL", async () => {
    const { provider, vistos } = espia((req) =>
      JSON.stringify(
        req.schema?.properties?.["d"]
          ? { d: "H", c: 1, e: [] }
          : { decision: "human_review", confidence: 1, evidence: [] },
      ),
    );
    const layer = createSavingsLayer({ provider });
    const res = await layer.generate(peticion());
    expect(Object.keys(vistos[0]?.properties ?? {})).toEqual([
      "decision",
      "confidence",
      "evidence",
    ]);
    expect(res.report.traces.some((t) => t.stage === "output-codebook")).toBe(false);
  });

  it("el MISMO contrato, dos modelos, dos veredictos: el signo es del MODELO", async () => {
    // LA LECCIÓN DE LA JORNADA, ejercitada por el pipeline de verdad. El esquema
    // es idéntico en las dos llamadas —así que ninguna función del esquema podría
    // separarlas—, y sin embargo una aplica y la otra no, porque el delta de
    // salida medido tiene signo opuesto:
    //
    //     gpt-4o        salida 75 → 72   (+3)   +8,0 % neto   → aplica
    //     gpt-4o-mini   salida 72 → 88   (−16)  −8,2 % neto   → no aplica
    const conGrande = espia();
    const capaGrande = createSavingsLayer({ provider: conGrande.provider });
    const rGrande = await capaGrande.generate(peticion({ savings: { outputCodebook: true } }));
    const tGrande = rGrande.report.traces.find((t) => t.stage === "output-codebook");
    expect(tGrande?.outcome).toBe("applied");
    expect(Object.keys(conGrande.vistos[0]?.properties ?? {})).toEqual(["d", "c", "e"]);

    const conPequeno = espia((req) =>
      JSON.stringify(
        req.schema?.properties?.["d"]
          ? { d: "H", c: 87, e: ["E17:4"] }
          : { decision: "human_review", confidence: 87, evidence: ["E17:4"] },
      ),
    );
    const capaPequena = createSavingsLayer({ provider: conPequeno.provider });
    const rPequeno = await capaPequena.generate(
      peticion({ model: "openai/gpt-4o-mini", savings: { outputCodebook: true } }),
    );
    const tPequeno = rPequeno.report.traces.find((t) => t.stage === "output-codebook");
    expect(tPequeno?.outcome).toBe("skipped");
    expect(String(tPequeno?.detail?.["reason"])).toMatch(/writes MORE from a compact contract/);
    // Y el proveedor recibió el contrato ENTERO: apply-or-drop, nunca a medias.
    expect(Object.keys(conPequeno.vistos[0]?.properties ?? {})).toEqual([
      "decision",
      "confidence",
      "evidence",
    ]);
  });

  it("un modelo del que NO hay medición no dispara la palanca, y la traza dice qué medir", async () => {
    // EL CASO POR DEFECTO EN PRODUCCIÓN: el cliente enciende la palanca contra un
    // modelo que BiVelio no ha medido. Aplicarla sería jugarse su factura a cara
    // o cruz — de los dos modelos medidos, uno gana un 8 % y el otro lo pierde—,
    // así que no se aplica y la traza publica el umbral concreto de SU contrato.
    const { provider, vistos } = espia((req) =>
      JSON.stringify(
        req.schema?.properties?.["d"]
          ? { d: "H", c: 87, e: ["E17:4"] }
          : { decision: "human_review", confidence: 87, evidence: ["E17:4"] },
      ),
    );
    const layer = createSavingsLayer({
      provider,
      costModels: { "mistral/large-latest": { inputPer1k: 0.002, outputPer1k: 0.006 } },
    });
    const res = await layer.generate(
      peticion({ model: "mistral/large-latest", savings: { outputCodebook: true } }),
    );
    const t = res.report.traces.find((x) => x.stage === "output-codebook");
    expect(t?.outcome).toBe("skipped");
    expect(String(t?.detail?.["reason"])).toMatch(/^no measured output delta for this model/);
    expect(String(t?.detail?.["reason"])).toContain("benchmarks/ab-live.ts");
    expect(Object.keys(vistos[0]?.properties ?? {})).toEqual([
      "decision",
      "confidence",
      "evidence",
    ]);
  });

  it("la medición del LLAMANTE gana al catálogo, y se recuerda para la siguiente", async () => {
    // El cliente midió su propio tráfico contra `gpt-4o-mini` y le sale POSITIVO
    // —otro prompt, otro contrato, otra respuesta—. Su medición manda sobre la
    // nuestra: la tabla de BiVelio se midió sobre un contrato que no es el suyo.
    const { provider, vistos } = espia();
    const layer = createSavingsLayer({ provider });
    const res = await layer.generate(
      peticion({
        model: "openai/gpt-4o-mini",
        savings: { outputCodebook: true, outputCodebookMeasuredOutputDeltaTokens: 5 },
      }),
    );
    const t = res.report.traces.find((x) => x.stage === "output-codebook");
    expect(t?.outcome).toBe("applied");
    expect(t?.detail?.["measuredOutputDeltaTokens"]).toBe(5);
    expect(String(t?.detail?.["outputDeltaProvenance"])).toContain("measured by the caller");
    expect(Object.keys(vistos[0]?.properties ?? {})).toEqual(["d", "c", "e"]);

    // Y la SEGUNDA petición del mismo par modelo/contrato ya no tiene que
    // repetir la cifra: la memoria la conserva. Sin esto, el cliente que la
    // olvidara una vez vería la palanca apagarse sin haber cambiado nada.
    const segunda = await layer.generate(
      peticion({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "clasifica el expediente 9999" }],
        savings: { outputCodebook: true },
      }),
    );
    const t2 = segunda.report.traces.find((x) => x.stage === "output-codebook");
    expect(t2?.outcome).toBe("applied");
    expect(String(t2?.detail?.["outputDeltaProvenance"])).toContain("on an earlier request");
  });

  it("con un proveedor que RELLENA MÁS al ver el contrato compacto, la palanca no se aplica", async () => {
    // EL CASO QUE EL SIMULADOR NO SABE REPRESENTAR, y por el que este test no usa
    // `MockProvider`: aquí la salida CRECE con el contrato compacto, que es lo que
    // se midió contra `gpt-4o-mini`. La verja lo sabe por el catálogo y no aplica,
    // así que el proveedor nunca llega a ver el esquema corto y nunca llega a
    // rellenar de más.
    const { provider, salidas } = verboso();
    const layer = createSavingsLayer({ provider });
    const res = await layer.generate(
      peticion({ model: "openai/gpt-4o-mini", savings: { outputCodebook: true } }),
    );
    const t = res.report.traces.find((x) => x.stage === "output-codebook");
    expect(t?.outcome).toBe("skipped");
    expect(res.data).toEqual({ decision: "human_review", confidence: 87, evidence: ["E17:4"] });

    // Y la contraprueba, que es lo que hace este test una medición y no una
    // afirmación: FORZANDO la palanca con un delta positivo inventado, el mismo
    // proveedor devuelve una respuesta MÁS LARGA. Ése es exactamente el dinero
    // que la verja acaba de no gastar.
    const forzado = verboso();
    const capaForzada = createSavingsLayer({ provider: forzado.provider });
    await capaForzada.generate(
      peticion({
        model: "openai/gpt-4o-mini",
        savings: { outputCodebook: true, outputCodebookMeasuredOutputDeltaTokens: 5 },
      }),
    );
    expect(forzado.salidas[0]).toBeGreaterThan(salidas[0]!);
  });

  it("no acredita NINGÚN libro, y lo deja dicho en la traza", async () => {
    const { provider } = espia();
    const layer = createSavingsLayer({ provider });
    const res = await layer.generate(peticion({ savings: { outputCodebook: true } }));

    // Los cuatro libros quietos: el codebook no evita llamadas, no elimina
    // información, no es compresión de ENTRADA y no es caché del proveedor.
    expect(res.report.calls.avoidedLlm).toBe(0);
    expect(res.report.tokens.eliminatedInput).toBe(0);
    expect(res.report.tokens.compressedInput).toBe(0);
    expect(res.report.tokens.eliminatedOutput).toBe(0);
    expect(res.report.tokens.providerCachedInput).toBeUndefined();
    // El baseline de salida de una llamada ejecutada sigue siendo su salida
    // medida: no se inventa lo que habría costado la forma larga.
    expect(res.report.tokens.baselineOutput).toBe(res.report.tokens.actualOutput);

    const expandida = res.report.traces.find(
      (t) => t.stage === "output-codebook" && t.outcome === "expanded",
    );
    expect(expandida).toBeDefined();
    expect(expandida?.detail?.["creditedLedger"]).toBe("none");
    // La cuenta local sí se publica, y la forma larga ocupa más que la compacta.
    expect(Number(expandida?.detail?.["localOutputTokensExpanded"])).toBeGreaterThan(
      Number(expandida?.detail?.["localOutputTokensCompact"]),
    );
  });

  it("una respuesta que NO es JSON se deja intacta para que la diagnostique el validador", async () => {
    const { provider } = espia(() => "lo siento, no puedo");
    const layer = createSavingsLayer({ provider });
    const res = await layer.generate(peticion({ savings: { outputCodebook: true } }));
    expect(res.text).toBe("lo siento, no puedo");
    expect(
      res.report.traces.some(
        (t) => t.stage === "output-codebook" && t.outcome.startsWith("not-expanded"),
      ),
    ).toBe(true);
  });

  it("un contrato que no pasa las verjas viaja ENTERO, y la traza dice por qué", async () => {
    const conPattern: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["decision"],
      properties: { decision: { type: "string", pattern: "^[a-z_]+$", maxLength: 20 } },
    };
    const { provider, vistos } = espia(() => JSON.stringify({ decision: "human_review" }));
    const layer = createSavingsLayer({ provider });
    const res = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "clasifica el expediente 4711" }],
      response: { contractId: "triage:v2", schema: conPattern },
      savings: { outputCodebook: true },
    });
    expect(vistos[0]).toEqual(conPattern);
    const traza = res.report.traces.find(
      (t) => t.stage === "output-codebook" && t.outcome === "skipped",
    );
    expect(traza?.detail?.["reason"]).toMatch(/pattern/);
  });

  it("tras una reparación se sirve la respuesta REPARADA, y ya viene en la forma del llamante", async () => {
    // La reparación se pide con el esquema ORIGINAL (enseñarle al modelo la
    // respuesta previa en una forma y pedirle la corrección en otra sería darle
    // dos contratos en el mismo mensaje), así que lo que vuelve NO se expande:
    // pasa a ser lo servido tal cual. Sin eso se serviría y cachearía la
    // respuesta INVÁLIDA que la reparación acaba de sustituir.
    const reparada = { decision: "auto_reject", confidence: 12, evidence: ["E9:2"] };
    const esquemasVistos: (JsonSchema | undefined)[] = [];
    let llamadas = 0;
    const provider = {
      id: "repara",
      async generate(req: ProviderRequest) {
        esquemasVistos.push(req.schema);
        llamadas += 1;
        // La primera respuesta llega compacta y le faltan claves obligatorias.
        const text = llamadas === 1 ? JSON.stringify({ d: "A" }) : JSON.stringify(reparada);
        return { text, usage: { inputTokens: 80, outputTokens: contar(text) } };
      },
    };
    const layer = createSavingsLayer({ provider });
    const res = await layer.generate(peticion({ savings: { outputCodebook: true } }));

    expect(llamadas).toBe(2);
    expect(res.report.calls.retries).toBe(1);
    // Primera llamada con el contrato compacto; la reparación, con el original.
    expect(Object.keys(esquemasVistos[0]?.properties ?? {})).toEqual(["d", "c", "e"]);
    expect(esquemasVistos[1]).toEqual(CONTRATO);
    // Y lo servido es lo reparado, no la respuesta inválida de la primera vuelta.
    expect(res.data).toEqual(reparada);
    expect(JSON.parse(res.text)).toEqual(reparada);
    expect(res.report.constraints.structurallyValid).toBe(true);
  });

  it("el proveedor de demo, que fabrica desde el esquema que recibe, cierra el círculo", async () => {
    // MockProvider construye su respuesta a partir del esquema que le llega: si
    // recibe el compacto, responde compacto. Que el llamante vea su propia forma
    // demuestra el viaje entero de ida y vuelta sin fixture cómplice.
    //
    // ⚠️ Y ES LO ÚNICO QUE DEMUESTRA. Que la respuesta salga más corta contra este
    // proveedor es el artefacto de fabricar-desde-el-esquema, no un ahorro: por
    // eso NINGÚN test de dinero de este fichero mide contra él.
    const layer = createSavingsLayer({ provider: createMockProvider() });
    const res = await layer.generate(peticion({ savings: { outputCodebook: true } }));
    expect(res.data).toEqual({ decision: "human_review", confidence: 0, evidence: ["mock"] });
    expect(validateAgainstSchema(res.data, CONTRATO).valid).toBe(true);
  });
});

describe("de dónde sale el delta de salida, y con qué procedencia", () => {
  /**
   * LA MEMORIA LLEVA EL MODELO EN LA CLAVE. Es la diferencia con
   * `contratosQueIncumplen`, que se indexa solo por contrato, y no es un matiz:
   * el mismo contrato mide +3 en `gpt-4o` y −16 en `gpt-4o-mini`, así que una
   * memoria sin el modelo aplicaría el dato de uno al otro.
   */
  it("el catálogo publica LOS DOS SIGNOS, cada uno con su modelo", () => {
    const grande = deltaMedidoDeLista("openai/gpt-4o");
    const pequeno = deltaMedidoDeLista("gpt-4o-mini");
    expect(grande?.deltaTokens).toBe(3);
    expect(pequeno?.deltaTokens).toBe(-16);
    // Y cada entrada trae con qué se midió: sin el contrato y las repeticiones,
    // «−16» es un número sin unidades sobre el que nadie puede decidir.
    expect(pequeno?.pares).toBe(8);
    expect(pequeno?.contrato).toMatch(/triage/);
    // La búsqueda respeta el corte por separador de `listPrice`: `gpt-4o` no
    // puede tragarse `gpt-4o-mini`, que es donde estaría el error caro.
    expect(deltaMedidoDeLista("gpt-4o-2024-08-06")?.deltaTokens).toBe(3);
    // Un modelo sin medir NO se rellena por familia: se queda sin dato.
    expect(deltaMedidoDeLista("gpt-4.1-mini")).toBeUndefined();
    expect(deltaMedidoDeLista("anthropic/claude-sonnet-4")).toBeUndefined();
  });

  it("la precedencia es llamante > recordado > catálogo > nada", () => {
    const m = new MemoriaDelCodebook();
    // 4. Sin nada, nada. Y sin nada la palanca no se aplica.
    expect(m.resolver("mistral/whatever", "triage:v1")).toBeNull();

    // 3. El catálogo, declarado como extrapolación entre contratos.
    const deLista = m.resolver("openai/gpt-4o-mini", "triage:v1");
    expect(deLista?.deltaTokens).toBe(-16);
    expect(deLista?.origen).toBe("catalogue");
    expect(deLista?.procedencia).toContain("NOT measured on YOUR contract");

    // 1. La medición del llamante gana al catálogo, aunque sea de signo opuesto.
    const delLlamante = m.resolver("openai/gpt-4o-mini", "triage:v1", 7);
    expect(delLlamante?.deltaTokens).toBe(7);
    expect(delLlamante?.origen).toBe("caller");

    // 2. Y queda recordada para ese par modelo/contrato…
    expect(m.resolver("openai/gpt-4o-mini", "triage:v1")?.origen).toBe("remembered");
    expect(m.resolver("openai/gpt-4o-mini", "triage:v1")?.deltaTokens).toBe(7);
    // …y SOLO para ese par: ni el mismo contrato en otro modelo, ni otro
    // contrato en el mismo modelo, heredan la cifra.
    expect(m.resolver("openai/gpt-4o", "triage:v1")?.origen).toBe("catalogue");
    expect(m.resolver("openai/gpt-4o-mini", "extraccion:v1")?.origen).toBe("catalogue");
  });

  it("una medición que no es un número no se recuerda ni decide", () => {
    // `NaN` entrando por la API pública sería un delta que compara falso contra
    // todo: la verja de dinero lo dejaría pasar por debajo del suelo sin decir
    // nada. Se trata como ausencia de medición, que es lo que es.
    const m = new MemoriaDelCodebook();
    expect(m.resolver("mistral/whatever", "triage:v1", Number.NaN)).toBeNull();
    expect(m.resolver("mistral/whatever", "triage:v1")).toBeNull();
  });
});
