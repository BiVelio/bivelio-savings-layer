import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { motivoDeLaNegativa } from "../src/providers/anthropic-uso.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import { ToolSelector } from "../src/router/tool-selector.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { Provider } from "../src/providers/types.js";
import type { SavingsRequest, SavingsResult, ToolDescriptor } from "../src/contracts/types.js";

/**
 * DOS DETALLES QUE ENCONTRARON LAS SONDAS EN VIVO (PR #415,
 * docs/benchmarks/2026-09-29/sondas.md):
 *
 *   A. El aviso del selector recomendaba `toolSearch: "auto"` con 120
 *      herramientas en claude-haiku-4-5, donde la verja de `"auto"` se queda con
 *      el selector (~0,0024 $ de prefijo por petición contra ~0,0036 $ de peor
 *      caso por búsqueda): recomendaba una palanca que no habría hecho nada.
 *      Ahora pregunta a la misma verja.
 *   B. Una negativa de Gemini (`content_filter: OTHER`) o de Anthropic
 *      (`stop_details.category`) llegaba al llamante como `content_filter` a
 *      secas, con `refusal` vacío: el motivo se perdía. Ahora viaja en
 *      `SavingsResult.finishReasonDetail`, sin tocar el cobro.
 *
 * Ninguna petición sale de la máquina.
 */

type Cuerpo = Record<string, unknown>;
const JSON_OK = { status: 200, headers: { "content-type": "application/json" } };

function fetchQueResponde(json: unknown, cuerpos: Cuerpo[] = []): typeof fetch {
  return (async (_url: unknown, init: { body: string }) => {
    cuerpos.push(JSON.parse(init.body) as Cuerpo);
    return new Response(JSON.stringify(json), JSON_OK);
  }) as unknown as typeof fetch;
}

function capa(provider: Provider): SavingsPipeline {
  // La poda por relevancia es opt-in desde 0.4.33; el aviso de la poda es lo que se prueba aquí.
  return new SavingsPipeline({ provider, tokenizer: new TokenizerRegistry(), toolSelector: new ToolSelector({ maxTools: 8 }), devUnlicensed: true } as never);
}

// ── A · El aviso del selector ────────────────────────────────────────────────

const RESPUESTA_ANTHROPIC = {
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 900, output_tokens: 2 },
};

/** Un catálogo TIPADO (el selector poda con señal), de unos 200 tokens por herramienta. */
function catalogoTipado(n: number): ToolDescriptor[] {
  const relleno = "It reads the records of this service and returns every field the caller asked for. ".repeat(9);
  return Array.from({ length: n }, (_, i) => ({
    id: `servicio_${i}_consultar`,
    intents: [`servicio ${i}`, `consulta ${i}`],
    risk: "read" as const,
    description: `Service ${i}. ${relleno}`,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  })) as unknown as ToolDescriptor[];
}

function peticion(model: string, tools: ToolDescriptor[], savings: SavingsRequest["savings"] = {}): SavingsRequest {
  return {
    model,
    messages: [{ role: "user", content: "¿Qué pedidos del servicio 17 siguen abiertos?" }],
    tools,
    savings: { exactCache: false, ...savings },
  } as SavingsRequest;
}

const HAIKU = "anthropic/claude-haiku-4-5";

describe("A · el aviso del selector solo recomienda `toolSearch: \"auto\"` donde la verja de `auto` lo elegiría", () => {
  let aviso: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reiniciarAvisos();
    aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => aviso.mockRestore());
  const avisoDePoda = (): string | undefined =>
    aviso.mock.calls.map((c) => String(c[0])).find((m) => m.includes("tool selector sent"));

  for (const savings of [{}, { toolSearch: "auto" as const }]) {
    it(`120 herramientas en claude-haiku-4-5 (${JSON.stringify(savings)}): la verja se queda con el selector y el aviso NO recomienda "auto"`, async () => {
      const r = await capa(new AnthropicProvider({ fetchImpl: fetchQueResponde(RESPUESTA_ANTHROPIC) })).generate(
        peticion(HAIKU, catalogoTipado(120), savings),
      );
      expect(r.report.calls.actualTools).toBeLessThan(120);
      const m = avisoDePoda();
      expect(m).toBeDefined();
      // Lo de antes: «`savings: { toolSearch: "auto" }` sends every tool deferred…».
      expect(m).not.toContain('`savings: { toolSearch: "auto" }` sends');
      expect(m).toContain('`toolSearch: "auto"` would keep the selector');
      // Lo que sí serviría, con su coste, y las cifras son las de la verja.
      expect(m).toContain('`toolSearch: "always"`');
      if ("toolSearch" in savings) {
        const d = r.report.traces.find((t) => t.stage === "tool-search")!;
        expect(d.outcome).toBe("selector");
        const ahorro = d.detail?.["prefixSavingPerRequest"] as number;
        const coste = d.detail?.["worstCaseSearchCost"] as number;
        expect(ahorro).toBeLessThan(coste);
        expect(m).toContain(ahorro.toFixed(6));
        expect(m).toContain(coste.toFixed(6));
        expect(m).toContain((coste - ahorro).toFixed(6));
      }
    });
  }

  it("control: con 400 herramientas la verja de `auto` sí pasa, y entonces el aviso la recomienda", async () => {
    // El aviso solo sale si el selector corrió: sin `toolSearch`.
    const r = await capa(new AnthropicProvider({ fetchImpl: fetchQueResponde(RESPUESTA_ANTHROPIC) })).generate(
      peticion(HAIKU, catalogoTipado(400)),
    );
    expect(r.report.calls.actualTools).toBeLessThan(400);
    const m = avisoDePoda();
    expect(m).toContain('`savings: { toolSearch: "auto" }` sends every tool deferred');
    expect(m).not.toContain('"always"');
    // Y es verdad: con "auto" encendido, esa misma petición va por la nativa.
    const nativa = await capa(new AnthropicProvider({ fetchImpl: fetchQueResponde(RESPUESTA_ANTHROPIC) })).generate(
      peticion(HAIKU, catalogoTipado(400), { toolSearch: "auto" }),
    );
    expect(nativa.report.traces.find((t) => t.stage === "tool-search")!.outcome).toBe("native");
  });

  it("detrás de un proxy (host no oficial) no recomienda \"auto\", que ahí no aplica: dice que existe \"always\"", async () => {
    await capa(
      new AnthropicProvider({ baseUrl: "https://proxy.interno.example/v1", fetchImpl: fetchQueResponde(RESPUESTA_ANTHROPIC) } as never),
    ).generate(peticion(HAIKU, catalogoTipado(400)));
    const m = avisoDePoda();
    expect(m).toBeDefined();
    expect(m).not.toContain('`savings: { toolSearch: "auto" }` sends');
    expect(m).toContain("not talking to the provider's own API host");
    expect(m).toContain('`toolSearch: "always"`');
  });

  it("OpenAI (sin búsqueda nativa en Chat Completions): avisa de la poda y no recomienda nada", async () => {
    const openai = new OpenAICompatibleProvider({
      baseUrl: "https://api.openai.com/v1",
      fetchImpl: fetchQueResponde({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 900, completion_tokens: 2 },
      }),
    });
    await capa(openai).generate(peticion("openai/gpt-4o-mini", catalogoTipado(400)));
    const m = avisoDePoda();
    expect(m).toBeDefined();
    expect(m).not.toContain("toolSearch");
  });
});

// ── B · El motivo de la negativa llega al llamante ──────────────────────────

const PETICION_SIMPLE = (model: string): SavingsRequest =>
  ({
    model,
    messages: [{ role: "user", content: "How do I kill a Python process?" }],
    savings: { exactCache: false },
  }) as SavingsRequest;

async function pedir(p: SavingsPipeline, req: SavingsRequest, modo: "json" | "stream"): Promise<SavingsResult> {
  if (modo === "json") return await p.generate(req);
  const s = p.generateStream(req);
  for await (const _ of s) {
    // se consume entero
  }
  return await s.result;
}

describe("B · `SavingsResult.finishReasonDetail`", () => {
  it("la regla de Anthropic: solo con `stop_reason: \"refusal\"` y una categoría de texto", () => {
    expect(motivoDeLaNegativa("refusal", { type: "refusal", category: "cyber", explanation: "x" })).toBe("cyber");
    expect(motivoDeLaNegativa("refusal", { type: "refusal", category: null })).toBeUndefined();
    expect(motivoDeLaNegativa("refusal", { type: "refusal", category: "" })).toBeUndefined();
    expect(motivoDeLaNegativa("refusal", null)).toBeUndefined();
    expect(motivoDeLaNegativa("end_turn", { category: "cyber" })).toBeUndefined();
  });

  const NEGATIVA_GEMINI_JSON = {
    choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "content_filter: OTHER" }],
    usage: { prompt_tokens: 40, completion_tokens: 0, total_tokens: 40 },
  };
  const NEGATIVA_GEMINI_SSE =
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "content_filter: PROHIBITED_CONTENT" }],
      usage: { prompt_tokens: 40, completion_tokens: 0, total_tokens: 40 },
    })}\n\n` + "data: [DONE]\n\n";

  for (const modo of ["json", "stream"] as const) {
    it(`Gemini compatible · ${modo}: el llamante recibe \`content_filter\` Y el motivo`, async () => {
      const fetchImpl = (async (_url: unknown, init: { body: string }) => {
        const stream = (JSON.parse(init.body) as Cuerpo)["stream"] === true;
        return stream
          ? new Response(NEGATIVA_GEMINI_SSE, { status: 200, headers: { "content-type": "text/event-stream" } })
          : new Response(JSON.stringify(NEGATIVA_GEMINI_JSON), JSON_OK);
      }) as unknown as typeof fetch;
      const gemini = new OpenAICompatibleProvider({ baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", fetchImpl });
      const r = await pedir(capa(gemini), PETICION_SIMPLE("google/gemini-3.8-flash"), modo);
      expect(r.finishReason).toBe("content_filter");
      expect(r.finishReasonDetail).toBe(modo === "json" ? "OTHER" : "PROHIBITED_CONTENT");
      expect(r.refusal).toBeUndefined();
    });
  }

  const STOP_DETAILS = { type: "refusal", category: "cyber", explanation: "This request was declined." };
  const NEGATIVA_ANTHROPIC_JSON = {
    id: "msg_negativa",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: "refusal",
    stop_details: STOP_DETAILS,
    usage: { input_tokens: 412, output_tokens: 0 },
  };
  const ev = (tipo: string, datos: unknown): string => `event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`;
  const NEGATIVA_ANTHROPIC_SSE =
    ev("message_start", {
      type: "message_start",
      message: { id: "msg_n", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 412, output_tokens: 1 } },
    }) +
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null, stop_details: STOP_DETAILS }, usage: { output_tokens: 0 } }) +
    ev("message_stop", { type: "message_stop" });

  for (const modo of ["json", "stream"] as const) {
    it(`Anthropic · ${modo}: la categoría de \`stop_details\` llega como motivo, y el cobro no cambia`, async () => {
      const fetchImpl = (async (_url: unknown, init: { body: string }) => {
        const stream = (JSON.parse(init.body) as Cuerpo)["stream"] === true;
        return stream
          ? new Response(NEGATIVA_ANTHROPIC_SSE, { status: 200, headers: { "content-type": "text/event-stream" } })
          : new Response(JSON.stringify(NEGATIVA_ANTHROPIC_JSON), JSON_OK);
      }) as unknown as typeof fetch;
      const r = await pedir(capa(new AnthropicProvider({ fetchImpl })), PETICION_SIMPLE("anthropic/claude-opus-5-5"), modo);
      expect(r.finishReason).toBe("content_filter");
      expect(r.finishReasonDetail).toBe("cyber");
      // `cyber` antes de cualquier salida es de las que Anthropic no cobra: sigue a 0.
      expect(r.report.cost.actual).toBe(0);
      expect(r.report.cost.netSavings).toBe(0);
    });
  }

  it("una respuesta normal no lleva motivo", async () => {
    const r = await capa(new AnthropicProvider({ fetchImpl: fetchQueResponde(RESPUESTA_ANTHROPIC) })).generate(
      PETICION_SIMPLE("anthropic/claude-opus-5-5"),
    );
    expect(r.finishReason).toBe("stop");
    expect(r.finishReasonDetail).toBeUndefined();
  });
});
