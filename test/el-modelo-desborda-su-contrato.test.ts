import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import {
  registerExactTokenizer,
} from "../src/index.js";
import { tokensDeLaMayorRespuesta } from "../src/constraints/techo-de-salida.js";
import { scenarios } from "../benchmarks/scenarios.js";
import {
  avisoDeTruncado,
  cortadaPorElTope,
  veredictoDeCalidad,
  VERJA_TRUNCADO,
} from "../benchmarks/verja-de-calidad.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

/**
 * EL MODELO DESBORDA SU PROPIO CONTRATO, Y LA CAPA NO PODÍA APRENDERLO.
 * ---------------------------------------------------------------------------
 * Tirada del 2026-08-16, «Forwarded support thread (compression)» contra
 * `claude-sonnet-4-5`:
 *
 *     brazo A   5684 entrada / 500 salida
 *     brazo B   3035 entrada / 500 salida    ahorro 32,4%   calidad 0/8
 *
 * NO es el caso del PR #79. Allí el contrato se contradecía a sí mismo —el tope
 * estaba calibrado con o200k_base y la mayor respuesta que el esquema autoriza no
 * cabía con el estimador de Claude— y la verja `sustrato-del-banco` lo habría
 * visto. Aquí esa verja PASA: `demo-resumen-hilo:v1` autoriza 466 tokens con el
 * tokenizador de Claude y declara un tope de 500. El tope no es el problema.
 *
 * Lo que pasa es que el modelo escribe MÁS de lo que su propio esquema autoriza
 * (`answer.maxLength: 1200`) y ningún modo estructurado impone `maxLength`: ni el
 * `strict` de OpenAI ni el `input_schema` de la herramienta forzada de Anthropic.
 *
 * La capa ya tenía el remedio —`constraintMemory` aprende qué contratos incumplen
 * y manda la pista— y NO le llegaba, por la misma puerta que el #79: el fallo de
 * FORMA tapaba el aprendizaje. Una respuesta cortada no produce ningún error de
 * VALOR; produce `not valid JSON`, o `missing required property` cuando el
 * contrato viaja como herramienta forzada y Anthropic entrega `{}` porque no
 * puede devolver un `input` a medio parsear. `esFalloDeValor` descarta los dos, y
 * el contrato no entraba nunca en la memoria.
 *
 * Reproducido contra un servidor local que habla el dialecto de Anthropic: 3
 * repeticiones con la memoria COMPARTIDA, 3 truncados idénticos, calidad 0/3.
 * Con el aprendizaje puesto: 3/3, y la salida del brazo B baja de 500 (el tope) a
 * 366 tokens.
 */

const registro = new TokenizerRegistry();
const tokenizadorListo = registerExactTokenizer(registro);

const CONTRATO_DEL_HILO = scenarios.find(
  (s) => s.request.response?.contractId === "demo-resumen-hilo:v1",
)!.request.response!;

describe("el diagnóstico: no es el caso del #79", () => {
  it("el contrato del hilo SÍ cabe en su tope contra el tokenizador de Claude", async () => {
    await tokenizadorListo;
    const techo = tokensDeLaMayorRespuesta(CONTRATO_DEL_HILO.schema, (t) =>
      registro.count(t, { model: "anthropic/claude-sonnet-4-5" }),
    );
    // Si esto dejara de cumplirse, la causa SÍ sería la del #79 y el arreglo
    // sería otro: mover el tope o recortar el esquema. Fijarlo aquí impide que
    // los dos diagnósticos se confundan la próxima vez.
    expect(techo).not.toBeNull();
    expect(
      techo!,
      "si el esquema no cupiera en el tope, esto sería el #79 y no un desbordamiento del modelo",
    ).toBeLessThanOrEqual(CONTRATO_DEL_HILO.maxOutputTokens!);
  });
});

/**
 * El proveedor que reproduce el fallo: escribe hasta agotar el tope y lo declara
 * como lo declara Anthropic —el `input` de la herramienta forzada llega vacío,
 * porque la API no entrega JSON a medio parsear— salvo que el prompt le traiga la
 * pista de límites, en cuyo caso obedece.
 */
class ModeloQueDesborda implements Provider {
  readonly id = "desborda";
  enviados: ProviderRequest[] = [];
  constructor(private readonly obedeceLaPista = true) {}
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.enviados.push(r);
    const pista = r.messages.some((m) => m.content.includes("JSON limits"));
    if (pista && this.obedeceLaPista) {
      return {
        text: JSON.stringify({ answer: "Resumen breve del hilo.", refs: ["msg-1"] }),
        finishReason: "stop",
        usage: { inputTokens: 3000, outputTokens: 120 },
      };
    }
    // Cortado por el tope. Así es como llega desde la API de Mensajes.
    return {
      text: "{}",
      finishReason: "length",
      usage: { inputTokens: 3000, outputTokens: 500 },
    };
  }
}

const peticionDelHilo = {
  model: "anthropic/claude-sonnet-4-5",
  messages: [{ role: "user" as const, content: "Resume este hilo de soporte para el equipo de nivel 2." }],
  response: CONTRATO_DEL_HILO,
  // Sin caché exacta: si no, la segunda petición idéntica no llega al proveedor y
  // no se puede observar lo que se le manda.
  savings: { exactCache: false as const },
};

const llevaPista = (r: ProviderRequest): boolean =>
  r.messages.some((m) => m.content.includes("JSON limits"));

describe("un truncado enseña a la capa cuando el esquema SÍ cabe en el tope", () => {
  it("la segunda petición del mismo contrato lleva sus límites de valor", async () => {
    const provider = new ModeloQueDesborda();
    const layer = createSavingsLayer({ provider, devUnlicensed: true, tokenizer: registro });

    const primera = await layer.generate(peticionDelHilo);
    expect(primera.report.constraints.structurallyValid).toBe(false);
    expect(llevaPista(provider.enviados[0]!), "la que aprende no puede llevarla todavía").toBe(false);

    const segunda = await layer.generate(peticionDelHilo);
    expect(
      llevaPista(provider.enviados[provider.enviados.length - 1]!),
      "un truncado sobre un contrato que cabe es un incumplimiento de VALOR: el modelo escribió " +
        "más de lo que su propio `maxLength` autoriza, y la pista es lo único que puede corregirlo " +
        "sin subirle el tope a quien lo fijó",
    ).toBe(true);
    // Y el bucle se cierra de verdad: con la pista, la respuesta valida.
    expect(segunda.report.constraints.structurallyValid).toBe(true);
  });

  it("la traza lo dice, para que se distinga de un truncado del que no se aprende nada", async () => {
    const provider = new ModeloQueDesborda();
    const layer = createSavingsLayer({ provider, devUnlicensed: true, tokenizer: registro });
    const r = await layer.generate(peticionDelHilo);

    const paso = r.report.traces.find((t) => t.outcome === "repair-skipped");
    expect(paso?.detail?.["learnedValueLimits"]).toBe(true);
  });

  it("NO aprende cuando el esquema no cabe en el tope: ahí la pista no arregla nada", async () => {
    // Es el caso del #79: el contrato se contradice a sí mismo y ninguna respuesta
    // conforme entra en el tope. Apuntarlo cobraría la pista en cada petición para
    // siempre a cambio de nada — y la pista tiene precio medido: 27 tokens de
    // entrada sobre prompts de 60-72.
    const provider = new ModeloQueDesborda();
    const layer = createSavingsLayer({ provider, devUnlicensed: true, tokenizer: registro });
    const imposible = {
      ...peticionDelHilo,
      response: { ...CONTRATO_DEL_HILO, contractId: "imposible:v1", maxOutputTokens: 20 },
    };

    await layer.generate(imposible);
    await layer.generate(imposible);
    expect(
      llevaPista(provider.enviados[provider.enviados.length - 1]!),
      "con un tope de 20 tokens no cabe ninguna respuesta conforme: la pista sería un peaje inútil",
    ).toBe(false);
  });

  it("tampoco aprende sin `maxOutputTokens`: ahí «cabe» no es demostrable", async () => {
    // El corte lo puso un tope del PROVEEDOR que no conocemos —la API de Anthropic
    // exige `max_tokens` y el adaptador manda 4096— así que no se puede afirmar
    // que el modelo desbordara su esquema.
    const provider = new ModeloQueDesborda();
    const layer = createSavingsLayer({ provider, devUnlicensed: true, tokenizer: registro });
    const { maxOutputTokens: _fuera, ...sinTope } = CONTRATO_DEL_HILO;
    const peticion = {
      ...peticionDelHilo,
      response: { ...sinTope, contractId: "sin-tope:v1" },
    };

    await layer.generate(peticion);
    await layer.generate(peticion);
    expect(llevaPista(provider.enviados[provider.enviados.length - 1]!)).toBe(false);
  });

  it("un modelo que IGNORA la pista no se repara solo, y la capa no finge que sí", async () => {
    // La capa hace lo único que puede sin tocarle el tope al cliente. Si el modelo
    // sigue desbordando, la respuesta sigue sin validar — y eso tiene que verse,
    // no taparse con un reintento pagado que volvería a cortarse.
    const provider = new ModeloQueDesborda(false);
    const layer = createSavingsLayer({ provider, devUnlicensed: true, tokenizer: registro });

    await layer.generate(peticionDelHilo);
    const segunda = await layer.generate(peticionDelHilo);
    expect(segunda.report.constraints.structurallyValid).toBe(false);
    expect(segunda.report.calls.retries, "un reintento con el mismo tope se corta igual").toBe(0);
  });
});

/**
 * LA VERJA DEL BANCO: MEDIA RESPUESTA NO PUNTÚA, LA MIRE QUIEN LA MIRE.
 */
describe("la verja de calidad veta el truncado antes de evaluar nada", () => {
  it("una respuesta cortada suspende SIN llegar a evaluarse", async () => {
    let evaluaciones = 0;
    const v = await veredictoDeCalidad({
      finishReason: "length",
      evaluar: async () => {
        evaluaciones++;
        return { passed: true, gate: "ground-truth" };
      },
    });
    expect(v.passed).toBe(false);
    expect(v.gate).toBe(VERJA_TRUNCADO);
    // El orden es dinero: la verja en vivo puede llamar a un JUEZ, y pagarlo para
    // que dictamine sobre una respuesta que el proveedor ya declaró cortada es
    // gasto sobre una pregunta contestada.
    expect(evaluaciones, "el veto va DELANTE de la evaluación, no detrás").toBe(0);
  });

  it("un escenario SIN contrato de salida ya no aprueba media respuesta", async () => {
    // El agujero exacto: `Big tool catalogue` no lleva contrato —a propósito y con
    // motivo— y su `expect` aprueba con `text.trim().length > 0`. Un texto cortado
    // a media frase tiene longitud > 0, así que ocho truncados aprobaban 8/8 y
    // publicaban su ahorro como PROBADO sobre media respuesta. Es el mismo agujero
    // que el pipeline ya cerró para la escritura en caché.
    const expectDelEscenario = async () => ({
      passed: "una respuesta cortada a media fra".trim().length > 0,
      gate: "ground-truth",
    });
    expect((await expectDelEscenario()).passed, "el expect del escenario no lo ve").toBe(true);
    const v = await veredictoDeCalidad({ finishReason: "length", evaluar: expectDelEscenario });
    expect(v.passed).toBe(false);
  });

  it("no veta lo que no se cortó: una parada normal decide la verja de siempre", async () => {
    for (const fin of ["stop", "tool_calls", "content_filter", undefined, null]) {
      expect(cortadaPorElTope(fin)).toBe(false);
      const v = await veredictoDeCalidad({
        finishReason: fin,
        evaluar: async () => ({ passed: true, gate: "ground-truth" }),
      });
      expect(v.passed, `${String(fin)} no es un truncado`).toBe(true);
    }
    expect(cortadaPorElTope("length")).toBe(true);
  });

  it("el informe NOMBRA los cortes en vez de dejar un «calidad 0/8» ilegible", () => {
    expect(avisoDeTruncado([{ name: "X", truncated: { naive: 0, optimizado: 0 } }])).toBeNull();
    const aviso = avisoDeTruncado([
      { name: "Forwarded support thread (compression)", truncated: { naive: 8, optimizado: 8 } },
      { name: "Sano", truncated: { naive: 0, optimizado: 0 } },
    ]);
    expect(aviso).toContain("Forwarded support thread (compression)");
    expect(aviso).not.toContain("Sano");
    // Y dice que NO es una regresión de la capa: cortarse en los DOS brazos es un
    // contrato que no cabe, no una respuesta que hayamos empeorado.
    expect(aviso).toMatch(/no es una\n?\s*regresión/);
  });
});
