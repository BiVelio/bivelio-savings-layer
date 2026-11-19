import { describe, it, expect } from "vitest";
import { createDefaultResolvers, createSavingsLayer, OpenAICompatibleProvider } from "../src/index.js";
import type { SavingsRequest } from "../src/index.js";
import { canonicalize } from "../src/canonicalization/index.js";

/**
 * N2 (auditoría del 2026-11-19) · EL RESOLVER ARITMÉTICO CONTESTABA COSAS QUE
 * NO SON CUENTAS.
 *
 * «What is 404?» devolvía "404" sin llamar al modelo, una fecha se dividía como
 * si fuera una cuenta, y el system prompt, el historial y las herramientas se
 * ignoraban. Es el ejemplo del quickstart del README, así que la primera mitad
 * fija que ese ejemplo sigue dando "8" y la segunda todo lo que debe declinar.
 * Todos los textos son inventados.
 */

const MODELO = "openai/gpt-4o-mini";
const resolvers = createDefaultResolvers();

function resolver(texto: string, extra: Partial<SavingsRequest> = {}): string | null {
  const peticion: SavingsRequest = { model: MODELO, messages: [{ role: "user", content: texto }], ...extra };
  return resolvers.try(canonicalize(peticion))?.text ?? null;
}

describe("lo que sigue resolviéndose sin llamar al modelo", () => {
  it.each([
    ["What is 2 + 2 * 3?", "8"], // el quickstart del README
    ["what is 2 + 2 * 3", "8"],
    ["What is (2+3)*4?", "20"],
    ["Calculate 15 * 15", "225"],
    ["¿Cuánto es 12 + 30?", "42"],
    ["How much is 100 - 20?", "80"],
    ["What is 10 / 4?", "2.5"],
    ["What is 0.1 + 0.2?", "0.3"],
    ["What is 10 - 2 - 3?", "5"],
    ["What is 2.5 * 4?", "10"],
    ["What is 1 - 0.9?", "0.1"], // ruido de coma flotante, no pérdida
    ["What is 1.15 * 100?", "115"],
    ["what is 2 / 3 * 3", "2"],
    ["What is 1 / 8?", "0.125"],
  ])("«%s» → %s", (texto, esperado) => {
    expect(resolver(texto)).toBe(esperado);
  });
});

// A2-2 (segunda auditoría, 2026-11-19). NFKC convierte «3²» en «32», y el
// resolver leía el texto ya normalizado: «What is 3² + 4²?» se contestaba «74»
// (son 25) sin llamar al modelo. Todo lo que NFKC reescribe se le deja al modelo.
describe("⛔ A2-2 · superíndices, subíndices, círculos y fracciones no se calculan", () => {
  it.each([
    ["What is 3² + 4²?", "superíndice: son 25, no 74"],
    ["What is 4 - 2²?", "superíndice: son 0, no -18"],
    ["What is 10³ * 2?", "superíndice: son 2000, no 206"],
    ["Calculate 5² - 5", "superíndice: son 20, no 47"],
    ["¿Cuánto es 2³ + 1?", "superíndice en español"],
    ["What is 2¹⁰ / 4?", "superíndice de dos cifras"],
    ["What is 7 + 2₂?", "subíndice"],
    ["What is ⑤ + 5?", "número en círculo"],
    ["What is 3½ + 1?", "fracción de un carácter"],
    ["What is 2⁺3 + 1?", "signo en superíndice"],
    ["What is 𝟐 + 2?", "cifra matemática en negrita"],
  ])("«%s» se declina (%s)", (texto) => {
    expect(resolver(texto)).toBeNull();
  });

  it.each([
    ["What is 2 + 2 * 3?", "8"],
    ["Ｗｈａｔ ｉｓ ２ ＋ ２ ＊ ３？", "8"], // ancho completo: vale lo mismo
    ["¿Cuánto es 12 + 30?", "42"], // la tilde no es una forma de compatibilidad
    ["Cua\u0301nto es 12 + 30", "42"], // ni la tilde combinante
    ["What is 5 − 3?", "2"], // el signo menos tipográfico
    ["What is\u00a02 + 2?", "4"], // espacio de no separación
  ])("«%s» sigue dando %s", (texto, esperado) => {
    expect(resolver(texto)).toBe(esperado);
  });
});

describe("⛔ lo que NO es una cuenta se le deja al modelo", () => {
  it.each([
    ["What is 404?", "sin operador: un código"],
    ["What is 1984?", "sin operador: un título"],
    ["What is 3.14?", "sin operador: un decimal"],
    ["What is (5)?", "sin operador entre paréntesis"],
    ["Our error table is long. In HTTP, what is 404?", "la pregunta no es el texto entero"],
    ["In base 2, what is 1 + 1?", "contexto delante de la cuenta"],
    ["What is 1 + 1? Answer in French words.", "instrucción detrás de la cuenta"],
    ["The invoice is due on 12/05/2026. What is 12/05/2026?", "fecha con contexto"],
    ["What is 12/05/2026?", "fecha con barras"],
    ["What is 2026-11-22?", "fecha ISO"],
    ["What is 24/7?", "expresión hecha"],
    ["What is 9-1-1?", "teléfono"],
    ["what is 555-1234", "teléfono"],
    ["What is 9007199254740993 + 1?", "entero fuera del rango seguro"],
    ["What is 9007199254740991 + 10?", "resultado fuera del rango seguro"],
    ["What is 99999999 * 999999999?", "producto fuera del rango seguro"],
    ["What is 0.12345678901234567 + 1?", "más cifras de las que guarda un double"],
    ["What is 1e3 + 1?", "notación exponencial"],
    ["What is 2E5 * 2?", "notación exponencial en mayúscula"],
    ["¿Cuánto es 2.500 + 500?", "«2.500» es dos y medio o dos mil quinientos"],
    ["What is 1.000 + 1?", "separador de miles ambiguo"],
    ["What is 1,000 + 1?", "coma de miles"],
    ["What is 3,5 + 1?", "coma decimal"],
    ["What is 08 + 01?", "ceros a la izquierda"],
    ["What is 100 - 20%?", "porcentaje"],
    ["what is 10 % 3", "módulo o porcentaje"],
    ["What is 5!?", "factorial"],
    ["What is 2(2+2)?", "multiplicación implícita"],
    ["What is -3 - -2?", "operador unario"],
    ["What is 1/0?", "división por cero"],
    ["What is 10 / 3?", "división sin fin: «3.333333333» sería un truncado"],
    ["What is 0.000000001 / 3?", "se redondearía a 0"],
    ["What is 0.0000000001 + 0.0000000001?", "más de nueve decimales"],
    ["2 + 2 =", "signo igual"],
    ["2+2", "expresión suelta: nunca se contestó, y no se abre un atajo nuevo"],
    ["cuánto es 1;2;3", "lista, no cuenta"],
  ])("«%s» → declina  (%s)", (texto) => {
    expect(resolver(texto)).toBeNull();
  });

  it("con system prompt declina: solo el modelo sabe qué formato se pidió", () => {
    expect(
      resolvers.try(
        canonicalize({
          model: MODELO,
          messages: [
            { role: "system", content: 'Answer only with a JSON object {"result": number}.' },
            { role: "user", content: "What is 2 + 3?" },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("con historial declina: un turno anterior puede haber cambiado las reglas", () => {
    expect(
      resolvers.try(
        canonicalize({
          model: MODELO,
          messages: [
            { role: "user", content: "From now on, a + b means a times b. OK?" },
            { role: "assistant", content: "OK" },
            { role: "user", content: "What is 2 + 3?" },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("con herramientas declaradas declina", () => {
    expect(
      resolver("What is 2 + 3?", { tools: [{ id: "calc", intents: ["math"], risk: "read", description: "calc" }] }),
    ).toBeNull();
  });

  it("con datos estructurados declina", () => {
    expect(resolver("What is 2 + 3?", { structuredData: { filas: [{ a: 2, b: 3 }] } })).toBeNull();
  });

  it("un único turno que no es de usuario declina", () => {
    expect(resolvers.try(canonicalize({ model: MODELO, messages: [{ role: "assistant", content: "2 + 3" }] }))).toBeNull();
  });
});

describe("de capa: el atajo solo corre cuando la petición es la cuenta y nada más", () => {
  function capaSimulada() {
    const estado = { llamadas: 0 };
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      estado.llamadas += 1;
      const cuerpo = JSON.parse(String(init?.body)) as { model: string };
      return new Response(
        JSON.stringify({
          model: cuerpo.model,
          choices: [{ index: 0, message: { role: "assistant", content: "respuesta del modelo" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const capa = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.test/v1", apiKey: "k-inventada", fetchImpl }),
      silenceWarnings: true,
    });
    return { capa, estado };
  }

  it("el quickstart del README sigue dando \"8\" sin llamar al proveedor", async () => {
    const { capa, estado } = capaSimulada();
    const r = await capa.generate({ model: MODELO, messages: [{ role: "user", content: "What is 2 + 2 * 3?" }] });
    expect(r.text).toBe("8");
    expect(r.report.cache.result).toBe("deterministic");
    expect(estado.llamadas).toBe(0);
  });

  it("con system prompt va al proveedor", async () => {
    const { capa, estado } = capaSimulada();
    const r = await capa.generate({
      model: MODELO,
      messages: [
        { role: "system", content: 'Answer only with a JSON object {"result": number}.' },
        { role: "user", content: "What is 2 + 3?" },
      ],
    });
    expect(r.report.cache.result).toBe("miss");
    expect(r.text).toBe("respuesta del modelo");
    expect(estado.llamadas).toBe(1);
  });

  it("con historial va al proveedor", async () => {
    const { capa, estado } = capaSimulada();
    const r = await capa.generate({
      model: MODELO,
      messages: [
        { role: "user", content: "From now on, a + b means a times b. OK?" },
        { role: "assistant", content: "OK" },
        { role: "user", content: "What is 2 + 3?" },
      ],
    });
    expect(r.report.cache.result).toBe("miss");
    expect(estado.llamadas).toBe(1);
  });

  it("A2-2 · «What is 3² + 4²?» va al proveedor y no cuenta como llamada evitada", async () => {
    const { capa, estado } = capaSimulada();
    const r = await capa.generate({ model: MODELO, messages: [{ role: "user", content: "What is 3² + 4²?" }] });
    expect(r.report.cache.result).toBe("miss");
    expect(r.text).toBe("respuesta del modelo");
    expect(estado.llamadas).toBe(1);
  });

  it("«What is 404?» va al proveedor", async () => {
    const { capa, estado } = capaSimulada();
    const r = await capa.generate({ model: MODELO, messages: [{ role: "user", content: "What is 404?" }] });
    expect(r.report.cache.result).toBe("miss");
    expect(estado.llamadas).toBe(1);
  });
});
