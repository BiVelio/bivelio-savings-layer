import { describe, it, expect } from "vitest";
import {
  planOutputCodebook,
  testigosDe,
  verificarTestigos,
  type CodebookNode,
} from "../src/constraints/codebook.js";
import { validateAgainstSchema } from "../src/constraints/validate.js";
import { heuristicEstimator } from "../src/tokenizer/estimator.js";
import {
  createSavingsLayer,
  createMockProvider,
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
 */

const contar = (t: string) => heuristicEstimator.count(t);

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
    const d = planOutputCodebook(CONTRATO, contar);
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
    const d = planOutputCodebook(CONTRATO, contar);
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
    const d = planOutputCodebook(CONTRATO, contar);
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
    const a = planOutputCodebook(CONTRATO, contar);
    const b = planOutputCodebook(alReves, contar);
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
  // Las verjas ESTRUCTURALES se prueban con el suelo de ahorro a cero, para que
  // lo que se observe sea la verja y no la de dinero tapándola.
  const sinSuelo = { minimumSavingsTokens: 0 };

  it("⛔ un `pattern` deja el esquema fuera: no hay testigo que lo demuestre", () => {
    const conPattern: JsonSchema = {
      ...CONTRATO,
      properties: {
        ...CONTRATO.properties,
        evidence: { type: "array", maxItems: 4, items: { type: "string", pattern: "^E\\d+$" } },
      },
    };
    const d = planOutputCodebook(conPattern, contar, sinSuelo);
    expect(d.applied).toBe(false);
    if (d.applied) return;
    expect(d.reason).toMatch(/pattern/);
  });

  it("⛔ con `additionalProperties` abierto no se renombra ninguna clave", () => {
    // Una clave que el esquema no declara sería indistinguible de un código
    // nuestro al expandir, y expandir dejaría de ser demostrable.
    const abierto: JsonSchema = { ...CONTRATO };
    delete abierto.additionalProperties;
    const d = planOutputCodebook(abierto, contar, sinSuelo);
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
    const d = planOutputCodebook(ambiguo, contar, sinSuelo);
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
    const d = planOutputCodebook(conMinimo, contar, sinSuelo);
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
    const d = planOutputCodebook(CONTRATO, contar, { minimumSavingsTokens: 10_000 });
    expect(d.applied).toBe(false);
    if (d.applied) return;
    // El motivo publica las dos mitades: lo que se ahorra en la SALIDA y lo que
    // cuesta (o devuelve) el contrato compacto en la ENTRADA.
    expect(d.reason).toMatch(/^net saving -?\d+ tokens is below the 10000-token floor \(output \d+, schema [-+]?\d+\)$/);
  });

  it("⛔ el ahorro modelado es el del PEOR testigo, no el del mejor", () => {
    // El módulo dice equivocarse a la BAJA y de ahí depende que la palanca no se
    // aplique donde no paga. Con un enum de valores muy desiguales las dos reglas
    // se separan: quedarse con el mejor testigo casi triplica la cifra sobre la
    // que decide la verja de dinero, y nada más en la suite nota la diferencia.
    const desigual: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["decision"],
      properties: {
        decision: { type: "string", enum: ["ok", "escalate_to_a_human_operator_immediately"] },
      },
    };
    const d = planOutputCodebook(desigual, contar, sinSuelo);
    if (!d.applied) throw new Error("se esperaba que se aplicara");

    const delta = (v: unknown) =>
      contar(JSON.stringify(v)) - contar(JSON.stringify(d.plan.compact(v)));
    const peor = delta({ decision: "ok" });
    const mejor = delta({ decision: "escalate_to_a_human_operator_immediately" });
    expect(mejor).toBeGreaterThan(peor);
    expect(d.plan.modelledOutputSavingTokens).toBe(peor);
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
    const hondo = planOutputCodebook(profundo, contar, sinSuelo);
    expect(hondo.applied).toBe(false);
    if (hondo.applied) return;
    expect(hondo.reason).toBe("schema too deep or cyclic");
    expect(hondo.reason).not.toMatch(/pattern/);

    // Y un esquema construido por referencia circular: sin el corte no termina.
    const ciclico: JsonSchema = { type: "object", additionalProperties: false, properties: {} };
    (ciclico.properties as Record<string, JsonSchema>)["hijo"] = ciclico;
    (ciclico.properties as Record<string, JsonSchema>)["descripcion_larga"] = { type: "string" };
    const circular = planOutputCodebook(ciclico, contar, sinSuelo);
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
    const d = planOutputCodebook(minusculo, contar);
    expect(d.applied).toBe(false);
    if (d.applied) return;
    expect(d.reason).toMatch(/below the 8-token floor/);
    // Con el suelo a cero sí habría codebook: lo que lo frena es el suelo, no una
    // incapacidad de comprimir.
    expect(planOutputCodebook(minusculo, contar, sinSuelo).applied).toBe(true);
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
    const d = planOutputCodebook(seContradice, contar, sinSuelo);
    expect(d.applied).toBe(false);
    if (d.applied) return;
    expect(d.reason).toMatch(/witness does not satisfy the caller's own schema/);

    // Y con el enum recortado al valor que SÍ cumple, el mismo contrato pasa: lo
    // que frena no es el `maxLength`, es la contradicción.
    const coherente: JsonSchema = {
      ...seContradice,
      properties: { decision: { type: "string", maxLength: 6, enum: ["ok", "review"] } },
    };
    expect(planOutputCodebook(coherente, contar, sinSuelo).applied).toBe(true);
  });

  it("⛔ un contrato sin nada que comprimir no se aplica ni con el suelo a cero", () => {
    const yaCorto: JsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "boolean" } },
    };
    const d = planOutputCodebook(yaCorto, contar, sinSuelo);
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

    const d = planOutputCodebook(seContradice, contar, { minimumSavingsTokens: 0 });
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

  const peticion = (extra?: Partial<SavingsRequest>): SavingsRequest => ({
    model: "openai/gpt-4o-mini",
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
    const layer = createSavingsLayer({ provider: createMockProvider() });
    const res = await layer.generate(peticion({ savings: { outputCodebook: true } }));
    expect(res.data).toEqual({ decision: "human_review", confidence: 0, evidence: ["mock"] });
    expect(validateAgainstSchema(res.data, CONTRATO).valid).toBe(true);
  });
});
