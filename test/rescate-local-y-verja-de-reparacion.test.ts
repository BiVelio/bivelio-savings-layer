import { describe, it, expect, beforeEach } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * DOS FORMAS DE NO PAGAR UNA SEGUNDA LLAMADA.
 *
 * El modo de fallo dominante contra Anthropic no era que el modelo inventara una
 * forma: era que contestaba en prosa de cortesía con el JSON CORRECTO dentro de
 * una valla markdown. `JSON.parse` de eso lanza, la validación anotaba "not valid
 * JSON" y el pipeline disparaba su reparación — una segunda llamada entera para
 * sacar un objeto que ya venía en la respuesta.
 *
 * Aquí se comprueban las dos defensas:
 *
 *   1. el RESCATE LOCAL, que saca el objeto de la valla por cero tokens y cero
 *      llamadas, y que por eso no puede empeorar nada (solo corre cuando el
 *      parseo estricto YA falló);
 *   2. la VERJA DE DINERO, que es opt-in y niega la reparación cuando pagarla
 *      dejaría la petición por encima de lo que habría costado sin la capa.
 */

const ESQUEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" as const } },
};

const peticion = (): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Devuelve la respuesta en el formato pedido." }],
  response: { contractId: "c1", version: "v1", schema: ESQUEMA },
  savings: { exactCache: false },
});

const PRECIOS = { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } };

/** Contesta UNA vez con el texto dado; cuenta las llamadas para probar que no hubo dos. */
class ProveedorDeUnaRespuesta implements Provider {
  readonly id = "una";
  llamadas = 0;
  constructor(private readonly texto: string) {}
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas += 1;
    // Si algo dispara una reparación, la segunda respuesta es válida: así el
    // test distingue "no hizo falta reparar" de "reparó y salió bien".
    if (this.llamadas > 1) {
      return { text: '{"answer":"reparado"}', usage: { inputTokens: 520, outputTokens: 40 } };
    }
    return { text: this.texto, usage: { inputTokens: 500, outputTokens: 200 } };
  }
}

beforeEach(() => reiniciarAvisos());

describe("rescate local del JSON envuelto en prosa", () => {
  it("una valla markdown NO cuesta una segunda llamada", async () => {
    const proveedor = new ProveedorDeUnaRespuesta(
      'Claro, aquí tienes:\n\n```json\n{"answer":"ok"}\n```\n\n¿Algo más?',
    );
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });

    const res = await capa.generate(peticion());

    // LO QUE IMPORTA: una sola llamada.
    expect(proveedor.llamadas).toBe(1);
    expect(res.report.calls.retries ?? 0).toBe(0);
    expect(res.report.constraints?.structurallyValid).toBe(true);
    // Y se sirve la forma limpia, no la prosa: el llamante pidió un contrato, así
    // que devolverle la valla le obligaría a repetir este mismo rescate.
    expect(res.text).toBe('{"answer":"ok"}');
    expect(JSON.parse(res.text)).toEqual({ answer: "ok" });
  });

  it("la valla sin etiqueta de lenguaje también se rescata", async () => {
    const proveedor = new ProveedorDeUnaRespuesta('```\n{"answer":"ok"}\n```');
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });

    const res = await capa.generate(peticion());

    expect(proveedor.llamadas).toBe(1);
    expect(res.text).toBe('{"answer":"ok"}');
  });

  it("prosa SIN valla: se rescata el primer objeto equilibrado", async () => {
    const proveedor = new ProveedorDeUnaRespuesta('Here is the answer: {"answer":"ok"} — done.');
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });

    const res = await capa.generate(peticion());

    expect(proveedor.llamadas).toBe(1);
    expect(res.text).toBe('{"answer":"ok"}');
  });

  it("una llave DENTRO de una cadena no cierra el objeto antes de tiempo", async () => {
    // El contador ingenuo se come esto: el `}` del valor cerraría el objeto y el
    // recorte no parsearía, así que se pagaría la reparación igual.
    const proveedor = new ProveedorDeUnaRespuesta(
      'Respuesta:\n```json\n{"answer":"usa {llaves} y \\"comillas\\" así"}\n```',
    );
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });

    const res = await capa.generate(peticion());

    expect(proveedor.llamadas).toBe(1);
    expect(JSON.parse(res.text)).toEqual({ answer: 'usa {llaves} y "comillas" así' });
  });

  it("lo rescatado que NO cumple el contrato sigue disparando la reparación", async () => {
    // El rescate no es una excusa para servir cualquier cosa: saca el objeto, y
    // si el objeto incumple el esquema el camino es el de siempre.
    const proveedor = new ProveedorDeUnaRespuesta('```json\n{"otra":"cosa"}\n```');
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });

    const res = await capa.generate(peticion());

    expect(proveedor.llamadas).toBe(2);
    expect(res.report.calls.retries).toBe(1);
  });

  it("basura que no contiene JSON no se inventa: se repara como antes", async () => {
    const proveedor = new ProveedorDeUnaRespuesta("No puedo responder a eso.");
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });

    const res = await capa.generate(peticion());

    expect(proveedor.llamadas).toBe(2);
    expect(res.report.calls.retries).toBe(1);
  });

  it("un objeto cortado a medias no se cierra por nuestra cuenta", async () => {
    // Cerrar el objeto nosotros sería inventar contenido y servirlo como si lo
    // hubiera dicho el modelo.
    const proveedor = new ProveedorDeUnaRespuesta('```json\n{"answer":"a medio escri');
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });

    await capa.generate(peticion());

    expect(proveedor.llamadas).toBe(2);
  });
});

describe("verja de dinero antes de reparar", () => {
  /** Inválido siempre: fuerza la decisión de reparar o no. */
  class ProveedorSiempreInvalido implements Provider {
    readonly id = "invalido";
    llamadas = 0;
    async generate(_r: ProviderRequest): Promise<ProviderResponse> {
      this.llamadas += 1;
      return { text: "no soy json", usage: { inputTokens: 500, outputTokens: 200 } };
    }
  }

  it("APAGADA POR DEFECTO: la reparación se paga igual que siempre", async () => {
    // La conducta por defecto no cambia, y eso es deliberado: el baseline excluye
    // la reparación por construcción, así que el umbral es inalcanzable en cuanto
    // los demás libros salen planos — encenderla dejaría de reparar casi siempre.
    const proveedor = new ProveedorSiempreInvalido();
    const capa = createSavingsLayer({ provider: proveedor, costModels: PRECIOS });

    const res = await capa.generate(peticion());

    expect(proveedor.llamadas).toBe(2);
    expect(res.report.calls.retries).toBe(1);
  });

  it("ENCENDIDA: no se paga una reparación que deja la petición por encima del baseline", async () => {
    const proveedor = new ProveedorSiempreInvalido();
    const capa = createSavingsLayer({
      provider: proveedor,
      costModels: PRECIOS,
      skipRepairAboveBaseline: true,
    });

    const res = await capa.generate(peticion());

    // Una sola llamada: la segunda se negó.
    expect(proveedor.llamadas).toBe(1);
    expect(res.report.calls.actualLlm).toBe(1);
    expect(res.report.calls.retries ?? 0).toBe(0);
    // Y NO SE MIENTE SOBRE LO QUE SE SIRVE: la respuesta no cumple el contrato y
    // el informe lo dice. Servirla en silencio sería lo único imperdonable aquí.
    expect(res.report.constraints?.structurallyValid).toBe(false);
  });

  it("ENCENDIDA, la petición no acaba costando más que el camino naive", async () => {
    const proveedor = new ProveedorSiempreInvalido();
    const capa = createSavingsLayer({
      provider: proveedor,
      costModels: PRECIOS,
      skipRepairAboveBaseline: true,
    });

    const res = await capa.generate(peticion());

    // Que es la promesa entera de la verja, dicha en dinero.
    expect(res.report.cost.actual).toBeLessThanOrEqual(res.report.cost.baselineEstimate);
    expect(res.report.cost.netSavingsRatio).toBeGreaterThanOrEqual(0);
  });

  it("ENCENDIDA, un rescate local sigue evitando la reparación sin tocar la verja", async () => {
    // Las dos capas no compiten: la primera quita la causa, la segunda solo
    // aparece cuando la primera no pudo hacer nada.
    const proveedor = new ProveedorDeUnaRespuesta('```json\n{"answer":"ok"}\n```');
    const capa = createSavingsLayer({
      provider: proveedor,
      costModels: PRECIOS,
      skipRepairAboveBaseline: true,
    });

    const res = await capa.generate(peticion());

    expect(proveedor.llamadas).toBe(1);
    expect(res.report.constraints?.structurallyValid).toBe(true);
    expect(res.text).toBe('{"answer":"ok"}');
  });
});
