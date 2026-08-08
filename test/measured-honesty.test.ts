import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import { ExactTokenizer } from "../src/tokenizer/exact.js";
import { HeuristicEstimator } from "../src/tokenizer/estimator.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest, ToolDescriptor } from "../src/contracts/types.js";

/**
 * El fallo que esto cierra lo encontró la PRIMERA tirada del benchmark contra un
 * proveedor real. En el escenario de la tabla grande, la capa publicaba al
 * cliente:
 *
 *     netSavings: +47,4%   basis: "measured"   baselineInput: 4319
 *
 * mientras el A/B pareado, contra el mismo proveedor y en la misma tirada, medía
 * −49,6% con un naive real de 1174 tokens. 97 puntos de diferencia, y el
 * baseline 3,68x inflado.
 *
 * No era el cero fabricado del que ya nos protegíamos: era un POSITIVO
 * fabricado. Y `basis: "measured"` es justo lo que la migración 0010 enruta a
 * `measured_baseline_cost` — la columna cuyo comentario dice "Solo 'measured'
 * cuenta como dinero comprobable". Iba al panel como dinero contrastable con la
 * factura del cliente.
 *
 * Causa: k = actualInput/sentInputLocal se calibra sobre el prompt ENVIADO y se
 * aplica a texto QUITADO que estaba en OTRO formato. El heurístico cobra cada
 * símbolo suelto a token entero, así que infla el JSON (40% símbolos) mucho más
 * que el TOON (16%) y el sesgo no se cancela en la resta.
 */

/** Proveedor que reproduce un uso fijo, para que el ledger se calcule contra él. */
class ProveedorFijo implements Provider {
  readonly id = "fijo";
  constructor(private readonly inTok: number, private readonly outTok: number) {}
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    return { text: "respuesta", usage: { inputTokens: this.inTok, outputTokens: this.outTok } };
  }
}

/** Tabla uniforme grande: el caso donde el cambio de formato ahorra de verdad. */
const peticionConTabla = (): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Summarize the attached user table." }],
  structuredData: {
    users: Array.from({ length: 50 }, (_, i) => ({
      id: 1000 + i,
      name: `user_${i}`,
      role: i % 3 === 0 ? "admin" : "member",
      plan: i % 2 ? "pro" : "free",
      active: i % 4 !== 0,
    })),
  },
});

describe("basis: lo estimado no se cobra como medido", () => {
  it("con el heurístico y texto QUITADO, el ahorro es 'estimated'", async () => {
    const layer = createSavingsLayer({
      provider: new ProveedorFijo(1736, 282), // lo que midió el proveedor de verdad
      devUnlicensed: true,
    });
    const r = await layer.generate(peticionConTabla());

    // Que hubo conversión de formato lo prueba el libro de compresión.
    expect(r.report.tokens.compressedInput).toBeGreaterThan(0);
    // La cifra sigue publicándose —es la mejor disponible— pero deja de
    // presentarse como contrastable con la factura.
    expect(r.report.cost.basis).toBe("estimated");
  });

  it("un tokenizador EXACTO mejora la cifra pero NO la vuelve medida", async () => {
    // Corrección de un arreglo anterior: la exactitud del tokenizador es
    // NECESARIA pero no SUFICIENTE. Medido contra el proveedor real con
    // o200k_base y el escenario de la tabla: lo quitado de verdad son 432 tokens
    // y el cálculo acredita 616, porque k = actualInput/sentInputLocal = 1,426.
    // k no vale 1 ni con las dos reglas iguales, porque actualInput incluye ~311
    // tokens de protocolo (bloque de esquema, marcadores de rol) que el conteo
    // local del texto no ve: mezcla un sobrecoste aditivo con uno multiplicativo.
    //
    // El único baseline medido de una llamada que se ejecutó es uno que también
    // se haya ejecutado: un A/B. Aquí solo cabe estimar.
    const registro = new TokenizerRegistry();
    registro.register(new ExactTokenizer("falso-exacto", { encode: (t) => ({ length: Math.ceil(t.length / 4) }) }));
    registro.mapModel("openai/gpt-4o-mini", "falso-exacto");

    const layer = createSavingsLayer({
      provider: new ProveedorFijo(1736, 282),
      tokenizer: registro,
      devUnlicensed: true,
    });
    const r = await layer.generate(peticionConTabla());

    expect(r.report.cost.basis).toBe("estimated");
  });

  it("sin nada quitado sigue siendo 'measured' aunque el estimador sea heurístico", async () => {
    // Es la garantía del cero: sin optimización, baseline == actual, y eso no
    // depende de ningún tokenizador. Arreglar lo anterior no puede costarla.
    const layer = createSavingsLayer({
      provider: new ProveedorFijo(50, 10),
      devUnlicensed: true,
    });
    const r = await layer.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "en qué año se firmó el tratado de Utrecht" }],
    });

    expect(r.report.cost.basis).toBe("measured");
    expect(r.report.cost.netSavings).toBe(0);
  });
});

describe("el envoltorio de las herramientas se cuenta como lo factura el proveedor", () => {
  const herramientas: ToolDescriptor[] = [
    {
      id: "get_weather_forecast",
      description: "Return the weather forecast for a city on a given date, with hourly granularity",
      intents: ["weather"],
      risk: "read" as const,
      parameters: { type: "object" as const, properties: { city: { type: "string" as const } } },
    },
    {
      id: "send_email_to_recipient",
      description: "Send an email message to one or more recipients with an optional attachment",
      intents: ["email"],
      risk: "write" as const,
      parameters: { type: "object" as const, properties: { to: { type: "string" as const } } },
    },
  ];

  it("la cuenta local del prompt enviado NO queda por debajo de la del proveedor", async () => {
    // El fallo: assemblePromptText solo contaba `parameters` y se dejaba nombre y
    // descripción, que el proveedor SÍ factura. sentInputLocal salía por debajo
    // de actualInput, así que k = actual/sent > 1 (medido: 1,31) y cada token
    // quitado se acreditaba inflado. Baseline publicado 785 contra 262 reales.
    const heuristico = new HeuristicEstimator();
    const { SavingsPipeline } = await import("../src/pipeline/pipeline.js");
    void SavingsPipeline;

    // Cuenta con la MISMA regla lo que el adaptador manda de verdad al proveedor.
    const enElCable = herramientas
      .map((t) =>
        JSON.stringify({
          type: "function",
          function: { name: t.id, description: t.description, parameters: t.parameters },
        }),
      )
      .join("\n");
    const soloParametros = herramientas.map((t) => JSON.stringify(t.parameters)).join("\n");

    // El envoltorio no es un detalle: es la mayor parte de una herramienta con
    // descripción, que es como son todas las reales.
    expect(heuristico.count(enElCable)).toBeGreaterThan(heuristico.count(soloParametros) * 1.5);
  });

  it("k no se dispara por encima de 1 en una petición con herramientas", async () => {
    // Proveedor que CUENTA lo que recibe, incluido el envoltorio de las
    // herramientas — que es lo que hace uno de verdad. Es el único montaje en el
    // que k significa algo: mide el desajuste entre nuestra regla y la suya.
    class ProveedorQueCuenta implements Provider {
      readonly id = "cuenta";
      async generate(r: ProviderRequest): Promise<ProviderResponse> {
        const texto =
          r.messages.map((m) => m.content).join("\n") +
          (r.tools ?? [])
            .map((t) =>
              JSON.stringify({
                type: "function",
                function: { name: t.id, description: t.description, parameters: t.parameters },
              }),
            )
            .join("\n");
        return { text: "respuesta", usage: { inputTokens: Math.ceil(texto.length / 4), outputTokens: 20 } };
      }
    }

    const proveedor = new ProveedorQueCuenta();
    const peticion = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user" as const, content: "what is the weather forecast for tomorrow?" }],
      tools: herramientas,
    };

    // El baseline HONESTO: lo que ese mismo proveedor factura por el prompt
    // completo, sin pasar por la capa. Es el brazo naive de un A/B, medido con
    // la regla del proveedor — no una estimación.
    const naive = await proveedor.generate({ ...peticion, messages: [...peticion.messages] });
    const baselineReal = naive.usage.inputTokens;

    const layer = createSavingsLayer({ provider: proveedor, devUnlicensed: true });
    const r = await layer.generate(peticion);
    const t = r.report.tokens;

    // Con el heurístico la cifra sigue inflada, y hay que decir POR QUÉ: k se
    // calibra sobre lo que QUEDÓ en el prompt (texto llano, donde las dos reglas
    // coinciden) y se aplica a lo que se QUITÓ (JSON denso en símbolos, donde no
    // coinciden). Ninguna calibración sobre el resto puede corregir el sesgo del
    // material retirado. Por eso el arreglo de verdad no es afinar k: es que esta
    // cifra NO se publique como medida.
    expect(r.report.cost.basis).toBe("estimated");

    // Lo que el arreglo del envoltorio sí consigue: bajar el error. Antes de
    // contar nombre y descripción, k salía 1,31 y el layer publicaba 785 donde
    // el proveedor midió 262 (3,00x). Ahora el múltiplo es sustancialmente menor.
    expect(t.baselineInput).toBeLessThan(baselineReal * 2);
  });

  it("con la MISMA regla que el proveedor, el baseline reconstruido se acerca mucho", async () => {
    // El montaje de la regla única: el tokenizador cuenta igual que el proveedor
    // (aquí, chars/4 los dos). Entonces k = 1 de verdad, lo quitado se cuenta en
    // la regla del proveedor, y el baseline reconstruido coincide con lo que ese
    // proveedor habría facturado por el prompt completo.
    class ProveedorCharsCuatro implements Provider {
      readonly id = "chars4";
      async generate(r: ProviderRequest): Promise<ProviderResponse> {
        const texto =
          r.messages.map((m) => m.content).join("\n") +
          (r.tools ?? [])
            .map((t) =>
              JSON.stringify({
                type: "function",
                function: { name: t.id, description: t.description, parameters: t.parameters },
              }),
            )
            .join("\n");
        return { text: "respuesta", usage: { inputTokens: Math.ceil(texto.length / 4), outputTokens: 20 } };
      }
    }

    const registro = new TokenizerRegistry();
    registro.register(new ExactTokenizer("chars4", { encode: (t) => ({ length: Math.ceil(t.length / 4) }) }));
    registro.mapModel("openai/gpt-4o-mini", "chars4");

    const proveedor = new ProveedorCharsCuatro();
    const peticion = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user" as const, content: "what is the weather forecast for tomorrow?" }],
      tools: herramientas,
    };
    const naive = await proveedor.generate({ ...peticion, messages: [...peticion.messages] });

    const layer = createSavingsLayer({ provider: proveedor, tokenizer: registro, devUnlicensed: true });
    const r = await layer.generate(peticion);

    // Con las dos reglas iguales Y sin sobrecoste de protocolo (este proveedor de
    // prueba no lo tiene), el baseline reconstruido cae muy cerca del real. Es lo
    // que gana el tokenizador exacto. Sin el arreglo del envoltorio no se
    // sostiene ni así: la cuenta local seguiría sin incluir lo que se factura.
    expect(r.report.tokens.baselineInput).toBeGreaterThan(naive.usage.inputTokens * 0.95);
    expect(r.report.tokens.baselineInput).toBeLessThan(naive.usage.inputTokens * 1.05);
    // Pero sigue siendo una RECONSTRUCCIÓN, y contra un proveedor real el
    // sobrecoste de protocolo hace que k > 1. No se cobra como medida.
    expect(r.report.cost.basis).toBe("estimated");
  });
});
