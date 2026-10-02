import { describe, it, expect } from "vitest";

import { canonicalize, buildExactKey, buildInflightKey, sha256 } from "../src/canonicalization/index.js";
import { huellaDePeticion } from "../src/pipeline/referencia.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemoryExactCache } from "../src/cache/exact.js";
import { InMemorySemanticCache } from "../src/cache/semantic.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { ChatMessage, SavingsRequest, SavingsResult, ToolDescriptor } from "../src/contracts/types.js";
import { apiDeMensajes } from "./helpers/api-de-mensajes-falsa.js";

/**
 * LA CLAVE DE LA CACHÉ EXACTA VE LO QUE VE EL MODELO EN UN BUCLE DE HERRAMIENTAS.
 *
 * `canonicalize` metía en la clave el ROL y el TEXTO de cada turno, y nada más.
 * Los campos del bucle de herramientas —`toolCalls` (id, nombre, argumentos) del
 * asistente, y `toolCallId`, `isError` y `name` del resultado— viajan al
 * proveedor (Anthropic: `tool_use`/`tool_result` con `is_error`; OpenAI:
 * `tool_calls`, `tool_call_id`, `name`), pero no entraban en la clave exacta, ni
 * en la de singleflight, ni en el filtro duro de la caché semántica. Dos
 * conversaciones iguales salvo en ellos —un resultado marcado como error frente
 * al mismo texto como dato; la misma llamada con otros argumentos; los mismos
 * resultados emparejados con la otra llamada— compartían clave, y la segunda
 * recibía la respuesta de la primera como un acierto.
 *
 * Lo que fija este fichero:
 *   1. Las peticiones SIN esos campos dan la MISMA clave, la misma clave de
 *      singleflight y la misma huella que antes (valores generados con el
 *      código anterior): las cachés vivas de los clientes siguen valiendo.
 *   2. Un campo cambia la clave si y solo si cambia el cable de algún adaptador:
 *      lo ausente, lo vacío y lo falso que salen igual, canonizan igual. Con UNA
 *      excepción deliberada: el VALOR de los ids de llamada. Entra qué resultado
 *      contesta a qué llamada, no la cadena: cada ejecución de un agente trae
 *      ids nuevos del proveedor para la misma conversación (la decisión D5 de los
 *      adaptadores de marcos), y un acierto así nunca se valora `reference`.
 *   3. De punta a punta, en JSON y en stream, con Anthropic y con OpenAI: ni
 *      acierto cruzado, ni coalescencia cruzada, ni `reference`.
 *   4. Una entrada escrita con la clave vieja no la alcanza la petición con
 *      herramientas, y a la que sí la alcanza no le vale como referencia.
 *   5. La caché semántica, con `"include-agentic"`, tampoco cruza.
 */

// ── 1 · Lo que no lleva herramientas no se mueve ─────────────────────────────

const SIN_HERRAMIENTAS: Record<string, SavingsRequest> = {
  pregunta: {
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "What is the capital of France?" }],
  },
  conversacion: {
    model: "anthropic/claude-sonnet-4-6",
    messages: [
      { role: "system", content: "Eres breve." },
      { role: "user", content: "¿Cuánto es 12,5 × 3?" },
      { role: "assistant", content: "37,5." },
      { role: "user", content: "¿Y el doble?" },
    ],
    temperature: 0,
    context: { tenantId: "t-1", sessionId: "u-7", locale: "es-ES" },
  },
  conCatalogoYContrato: {
    model: "openai/gpt-4o",
    messages: [{ role: "user", content: "Resume el pedido 4411." }],
    tools: [
      {
        id: "get_order",
        intents: ["order"],
        risk: "read",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    ],
    structuredData: { filas: [{ id: 4411, total: 99.5 }] },
    response: {
      contractId: "resumen:v1",
      schema: { type: "object", properties: { resumen: { type: "string" } }, required: ["resumen"] },
    },
    seed: 7,
  },
  // `name` en un turno que no es `tool` y `metadata` opaca: ningún adaptador los
  // manda, así que no entran.
  nombreYMetadatosQueNoViajan: {
    model: "openai/gpt-4o-mini",
    messages: [
      { role: "user", content: "hola", name: "ana", metadata: { traza: "abc" } },
      { role: "assistant", content: "¡Hola!", metadata: { origen: "cache" } },
      { role: "user", content: "adiós" },
    ],
  },
  // Un resultado de herramienta SIN ids: el adaptador de Anthropic lo manda como
  // texto de usuario. No lleva ninguno de los campos, así que su clave se queda.
  herramientaComoTexto: {
    model: "anthropic/claude-sonnet-4-6",
    messages: [
      { role: "user", content: "¿Qué tiempo hace en Madrid?" },
      { role: "assistant", content: "Lo miro." },
      { role: "tool", content: "21 °C, despejado" },
    ],
  },
  // Lo mismo con los campos presentes pero vacíos o falsos: en el cable salen
  // igual que ausentes (ver el bloque 2), y la clave es la de arriba.
  camposVaciosQueNoViajan: {
    model: "anthropic/claude-sonnet-4-6",
    messages: [
      { role: "user", content: "¿Qué tiempo hace en Madrid?" },
      { role: "assistant", content: "Lo miro.", toolCalls: [] },
      { role: "tool", content: "21 °C, despejado", isError: false, name: "", toolCallId: undefined },
    ],
  },
};

/**
 * Generados con el código ANTERIOR (origin/main en 49626c5, la 0.4.28), con el
 * propio `buildExactKey`/`buildInflightKey`/`huellaDePeticion` de entonces. Si un
 * valor de aquí cambia, se ha invalidado la caché exacta viva de los clientes
 * (o los registros de referencia): no se «actualiza», se arregla el código.
 */
const FIJADAS: Record<string, { exacta: string; exactaServida: string; enVuelo: string; enVueloConOpciones: string; huella: string }> = {
  pregunta: {
    exacta: "bvsala:exact:n2:ad33bdc4b08b7dacf15de861e8ac1ed30484b9f763123abdca8c87007823e640",
    exactaServida: "bvsala:exact:n2:bd3802739ac598f7df3ac4814af605d80505ecbe6a93c4fe7d0aa1bb3f75c285",
    enVuelo: "bvsala:inflight:n2:e37d76396ab197980db063e1397f0f0e87ee70b22540af44efee37f26bd7c291",
    enVueloConOpciones: "bvsala:inflight:n2:dcd250bed024c3772bd2ff34bbb2ca20fcff50e1c4904baa2dd90fb5348346d6",
    huella: "60fa7ee859dc285896ef630783d781da4335b8b5b6adcc2fbca46c4f457d820b",
  },
  conversacion: {
    exacta: "bvsala:exact:n2:23efd1e1cdb0d704b380d7811ac06c11141a85c6168820a485e7abd57494fde8",
    exactaServida: "bvsala:exact:n2:d4198bd1e56e9409927e28cf11617d89dc4681dce8eabaaf613f9c2163289dfa",
    enVuelo: "bvsala:inflight:n2:69688a598a34c25fe04206bde83028f0e32fd409dfa6e38fc46e41a37391fe4a",
    enVueloConOpciones: "bvsala:inflight:n2:ffdfae1c4405e34b7965c9e0c7ccf17d1da7b9e4fada194a8dbc61daba8a70aa",
    huella: "ad558f65583181f5d5492e7cfc5332a4a2afcd14710ef5baa0e7dd4b29e297d6",
  },
  conCatalogoYContrato: {
    exacta: "bvsala:exact:n2:4f1bc1e74d64b6dfbe7f083d5d1432bcb25d8d86920e831dde5907ce45437b59",
    exactaServida: "bvsala:exact:n2:c0895608cf0f8054c2fa2dfb7951579e3bfa49f59c025c0a98b807508623a3fb",
    enVuelo: "bvsala:inflight:n2:c4e4f1b5ea521801829ebb8dc134ac25558af7fe2e79691299df1b5ab4c6ce87",
    enVueloConOpciones: "bvsala:inflight:n2:17f736543d36b0981539973d579b1e8ec8f0577f79db4590c65e5c458097c5b0",
    huella: "a9642f3e61b14b99902e800d86ba0b80de72eecd88ba69cf8e235d3a701f52fd",
  },
  nombreYMetadatosQueNoViajan: {
    exacta: "bvsala:exact:n2:7855d260ff4d3fa76f2583df4fa459878fef2876440f0d5cab11dbda3d1dc2f1",
    exactaServida: "bvsala:exact:n2:4e17eea637105525d1ab4febe56cefb5ff953faa7f1d033ecf5b049661e0a5f2",
    enVuelo: "bvsala:inflight:n2:f57f20eb1b7a56bce845fccdd0e2ed2846a97f3c58a0d61e96bd8f128ca66a5c",
    enVueloConOpciones: "bvsala:inflight:n2:e63e7beeec027c9358ec7ed93d9ef192f6db826facdfe42a0a8845528adf0936",
    huella: "c986bf45f543e1f6c8fb8ff788af3e82cb78416d1d2629d0d51792815916e326",
  },
  herramientaComoTexto: {
    exacta: "bvsala:exact:n2:d411c313d6a101edb9571208f88bfa1a807cfc139cdc349356458849d69aed81",
    exactaServida: "bvsala:exact:n2:3694508360d7d453e4feea7fbb248b2927a07b823b735d65f24b3502d317afb6",
    enVuelo: "bvsala:inflight:n2:231cce2ecea2a6b45766ce7cfdc46cad8eb6ab05b36854d6a9ccdb1986eae068",
    enVueloConOpciones: "bvsala:inflight:n2:c61dde5092ab30c72f1e49b5f53f113c4625abc5ea840acbf4b31b4ef1dc4e6d",
    huella: "53209b353832051c2ea76779290e3581a6718cac19e9890a94689340931b5458",
  },
  camposVaciosQueNoViajan: {
    exacta: "bvsala:exact:n2:d411c313d6a101edb9571208f88bfa1a807cfc139cdc349356458849d69aed81",
    exactaServida: "bvsala:exact:n2:3694508360d7d453e4feea7fbb248b2927a07b823b735d65f24b3502d317afb6",
    enVuelo: "bvsala:inflight:n2:231cce2ecea2a6b45766ce7cfdc46cad8eb6ab05b36854d6a9ccdb1986eae068",
    enVueloConOpciones: "bvsala:inflight:n2:c61dde5092ab30c72f1e49b5f53f113c4625abc5ea840acbf4b31b4ef1dc4e6d",
    // La huella es byte a byte y SÍ distingue `isError: false` de ausente: más
    // estricta que el cable, que es el lado seguro (nunca se reclama de más).
    huella: "82d14d832d24ccb0534aba3de6da86fb608a0a2bb30a1c848a5ae75ce0e65d1b",
  },
};

describe("1 · sin campos de herramienta, las claves y la huella son las de antes", () => {
  for (const [nombre, peticion] of Object.entries(SIN_HERRAMIENTAS)) {
    it(`${nombre}: clave exacta, de singleflight y huella idénticas a las fijadas`, () => {
      const c = canonicalize(peticion);
      expect({
        exacta: buildExactKey(c),
        exactaServida: buildExactKey(c, { servedModel: "openai/gpt-4o-mini-2024-07-18" }),
        enVuelo: buildInflightKey(c),
        enVueloConOpciones: buildInflightKey(c, { deferrable: true, toolDiscovery: true, maxOutputTokens: 64 }),
        huella: huellaDePeticion(peticion),
      }).toEqual(FIJADAS[nombre]);
    });
  }
});

// ── 2 · Un campo cambia la clave si y solo si cambia el cable ────────────────

const TIEMPO: ToolDescriptor = {
  id: "get_weather",
  intents: ["temperatura", "tiempo"],
  risk: "read",
  description: "Temperatura en una ciudad",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
const PREVISION: ToolDescriptor = {
  id: "get_forecast",
  intents: ["prevision"],
  risk: "read",
  description: "Previsión para una ciudad",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
const HERRAMIENTAS = [TIEMPO, PREVISION];

const PREGUNTA = "¿Qué temperatura hace en Madrid y en París?";

/** Un bucle bien formado para los dos adaptadores: dos llamadas en paralelo y sus dos resultados. */
function conversacion(): ChatMessage[] {
  return [
    { role: "user", content: PREGUNTA },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "toolu_01", name: "get_weather", arguments: '{"city":"Madrid"}' },
        { id: "toolu_02", name: "get_weather", arguments: '{"city":"Paris"}' },
      ],
    },
    { role: "tool", content: "21 °C", toolCallId: "toolu_01", name: "get_weather" },
    { role: "tool", content: "18 °C", toolCallId: "toolu_02", name: "get_weather" },
  ];
}

type Mensajes = ChatMessage[];
const llamadas = (ms: Mensajes) => ms[1]!.toolCalls!;

/** Variantes que el modelo VE distintas: la clave tiene que separarlas. */
const DISTINTAS: { nombre: string; base?: () => Mensajes; cambio: (ms: Mensajes) => void }[] = [
  { nombre: "isError en un resultado", cambio: (ms) => void (ms[2] = { ...ms[2]!, isError: true }) },
  { nombre: "los argumentos de una llamada", cambio: (ms) => void (llamadas(ms)[0]!.arguments = '{"city":"Sevilla"}') },
  {
    nombre: "el emparejamiento (toolCallId de los resultados, intercambiados)",
    cambio: (ms) => {
      ms[2] = { ...ms[2]!, toolCallId: "toolu_02" };
      ms[3] = { ...ms[3]!, toolCallId: "toolu_01" };
    },
  },
  {
    nombre: "un resultado que contesta a una llamada que no está",
    cambio: (ms) => void (ms[3] = { ...ms[3]!, toolCallId: "toolu_99" }),
  },
  {
    nombre: "dos llamadas con el mismo id (Anthropic ya no puede mandarlas nativas)",
    cambio: (ms) => {
      llamadas(ms)[1]!.id = "toolu_01";
      ms[3] = { ...ms[3]!, toolCallId: "toolu_01" };
    },
  },
  {
    nombre: "una llamada sin id",
    cambio: (ms) => void delete llamadas(ms)[0]!.id,
  },
  { nombre: "el nombre de una llamada", cambio: (ms) => void (llamadas(ms)[1]!.name = "get_forecast") },
  { nombre: "el name de un resultado (OpenAI lo manda)", cambio: (ms) => void (ms[3] = { ...ms[3]!, name: "get_forecast" }) },
  {
    // El adaptador OpenAI-compatible acepta el id por `metadata.tool_call_id`
    // (compatibilidad con quien lo pasaba así antes de que existiera el campo):
    // es la ortografía vieja de `toolCallId`, y viaja igual.
    nombre: "el emparejamiento escrito a la antigua (metadata.tool_call_id)",
    base: () =>
      conversacion().map((m) =>
        m.role === "tool" ? { role: "tool", content: m.content, metadata: { tool_call_id: m.toolCallId } } : m,
      ),
    cambio: (ms) => {
      ms[2] = { ...ms[2]!, metadata: { tool_call_id: "toolu_02" } };
      ms[3] = { ...ms[3]!, metadata: { tool_call_id: "toolu_01" } };
    },
  },
];

/** Variantes que salen IGUAL por los dos cables: la clave no puede separarlas. */
const IGUALES: { nombre: string; base?: () => Mensajes; cambio: (ms: Mensajes) => void }[] = [
  { nombre: "isError: false (≡ ausente)", cambio: (ms) => void (ms[2] = { ...ms[2]!, isError: false }) },
  { nombre: "toolCallId: undefined en un turno de usuario", cambio: (ms) => void (ms[0] = { ...ms[0]!, toolCallId: undefined }) },
  { nombre: "metadata opaca en cualquier turno", cambio: (ms) => void (ms[0] = { ...ms[0]!, metadata: { traza: "x-1" } }) },
  { nombre: "metadata opaca en un resultado", cambio: (ms) => void (ms[2] = { ...ms[2]!, metadata: { traza: "x-2" } }) },
  { nombre: "name en un turno de usuario", cambio: (ms) => void (ms[0] = { ...ms[0]!, name: "ana" }) },
  {
    nombre: 'name: "" en un resultado (≡ ausente)',
    base: () => conversacion().map((m) => (m.role === "tool" ? { role: "tool", content: m.content, toolCallId: m.toolCallId! } : m)),
    cambio: (ms) => void (ms[2] = { ...ms[2]!, name: "" }),
  },
  {
    nombre: "toolCalls: [] en un turno del asistente (≡ ausente)",
    base: () => [
      { role: "user", content: PREGUNTA },
      { role: "assistant", content: "Lo miro." },
      { role: "user", content: "Gracias." },
    ],
    cambio: (ms) => void (ms[1] = { ...ms[1]!, toolCalls: [] }),
  },
];

/**
 * Otra ejecución del MISMO bucle: el proveedor devuelve ids nuevos. El cable
 * cambia (los ids viajan), la clave no: el emparejamiento es el mismo.
 */
const RENOMBRADAS: { nombre: string; base?: () => Mensajes; cambio: (ms: Mensajes) => void }[] = [
  {
    nombre: "un id renombrado en la llamada y en su resultado",
    cambio: (ms) => {
      llamadas(ms)[0]!.id = "toolu_09";
      ms[2] = { ...ms[2]!, toolCallId: "toolu_09" };
    },
  },
  {
    nombre: "todos los ids renombrados (y con la forma de otro proveedor)",
    cambio: (ms) => {
      llamadas(ms)[0]!.id = "call_Xy7";
      llamadas(ms)[1]!.id = "call_Ab3";
      ms[2] = { ...ms[2]!, toolCallId: "call_Xy7" };
      ms[3] = { ...ms[3]!, toolCallId: "call_Ab3" };
    },
  },
];

function clonar(ms: Mensajes): Mensajes {
  return ms.map((m) => ({ ...m, ...(m.toolCalls ? { toolCalls: m.toolCalls.map((c) => ({ ...c })) } : {}) }));
}

function variante(v: { base?: () => Mensajes; cambio: (ms: Mensajes) => void }): { a: Mensajes; b: Mensajes } {
  const a = (v.base ?? conversacion)();
  const b = clonar(a);
  v.cambio(b);
  return { a, b };
}

const peticionDe = (messages: Mensajes, extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: "anthropic/claude-sonnet-4-6",
  messages,
  tools: HERRAMIENTAS,
  ...extra,
});

/** El cuerpo que cada adaptador mandaría, capturado sin red. */
async function cables(messages: Mensajes): Promise<{ anthropic: string; openai: string }> {
  const capturar = (): { fetchImpl: typeof fetch; cuerpos: string[] } => {
    const cuerpos: string[] = [];
    const fetchImpl = (async (_u: unknown, init: { body: string }) => {
      cuerpos.push(init.body);
      throw new Error("sin red");
    }) as unknown as typeof fetch;
    return { fetchImpl, cuerpos };
  };
  const a = capturar();
  const o = capturar();
  const req: ProviderRequest = { model: "claude-sonnet-4-6", messages, tools: HERRAMIENTAS };
  await new AnthropicProvider({ fetchImpl: a.fetchImpl }).generate(req).catch(() => undefined);
  await new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl: o.fetchImpl })
    .generate({ ...req, model: "gpt-4o-mini" })
    .catch(() => undefined);
  expect(a.cuerpos).toHaveLength(1);
  expect(o.cuerpos).toHaveLength(1);
  return { anthropic: a.cuerpos[0]!, openai: o.cuerpos[0]! };
}

function claves(messages: Mensajes) {
  const c = canonicalize(peticionDe(messages));
  return { exacta: buildExactKey(c), enVuelo: buildInflightKey(c) };
}

describe("2 · la clave separa lo que el cable separa, y solo eso", () => {
  for (const v of DISTINTAS) {
    it(`${v.nombre}: otro cable → otra clave exacta, otra de singleflight y otra huella`, async () => {
      const { a, b } = variante(v);
      const [ca, cb] = [await cables(a), await cables(b)];
      // La premisa: al menos un adaptador manda otra cosa.
      expect(ca.anthropic !== cb.anthropic || ca.openai !== cb.openai).toBe(true);
      expect(claves(b).exacta).not.toBe(claves(a).exacta);
      expect(claves(b).enVuelo).not.toBe(claves(a).enVuelo);
      expect(huellaDePeticion(peticionDe(b))).not.toBe(huellaDePeticion(peticionDe(a)));
    });
  }

  for (const v of IGUALES) {
    it(`${v.nombre}: el mismo cable en los dos adaptadores → la misma clave`, async () => {
      const { a, b } = variante(v);
      const [ca, cb] = [await cables(a), await cables(b)];
      expect(cb.anthropic).toBe(ca.anthropic);
      expect(cb.openai).toBe(ca.openai);
      expect(claves(b)).toEqual(claves(a));
    });
  }

  for (const v of RENOMBRADAS) {
    it(`${v.nombre}: otro cable, la MISMA clave, pero otra huella (nunca reference)`, async () => {
      const { a, b } = variante(v);
      const [ca, cb] = [await cables(a), await cables(b)];
      expect(cb.anthropic).not.toBe(ca.anthropic);
      expect(cb.openai).not.toBe(ca.openai);
      expect(claves(b)).toEqual(claves(a));
      expect(huellaDePeticion(peticionDe(b))).not.toBe(huellaDePeticion(peticionDe(a)));
    });
  }

  it("el isError viaja nativo en Anthropic (la premisa del fallo: el modelo lo ve)", async () => {
    const { a, b } = variante(DISTINTAS[0]!);
    const [ca, cb] = [await cables(a), await cables(b)];
    expect(ca.anthropic).not.toContain('"is_error"');
    expect(cb.anthropic).toContain('"is_error":true');
  });
});

// ── 3 · De punta a punta: ni acierto cruzado, ni coalescencia, ni referencia ──

type Modo = "json" | "stream";
type Adaptador = "anthropic" | "openai";

const MODELO: Record<Adaptador, string> = {
  anthropic: "anthropic/claude-sonnet-4-6",
  openai: "openai/gpt-4o-mini",
};

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Un proveedor de verdad (el adaptador del paquete) contra un servidor falso que numera sus respuestas. */
function proveedor(adaptador: Adaptador, retardoMs = 0): { provider: Provider; cuerpos: () => number } {
  if (adaptador === "anthropic") {
    const api = apiDeMensajes((_c, n) => ({ content: [{ type: "text", text: `respuesta ${n}` }], stop_reason: "end_turn" }));
    const fetchImpl = (async (u: unknown, init: { body: string }) => {
      if (retardoMs) await esperar(retardoMs);
      return api.fetchImpl(u as string, init as RequestInit);
    }) as unknown as typeof fetch;
    return { provider: new AnthropicProvider({ fetchImpl }), cuerpos: () => api.cuerpos.length };
  }
  let n = 0;
  const fetchImpl = (async (_u: unknown, init: { body: string }) => {
    const cuerpo = JSON.parse(init.body) as Record<string, unknown>;
    const texto = `respuesta ${n++}`;
    if (retardoMs) await esperar(retardoMs);
    const uso = { prompt_tokens: 120, completion_tokens: 3 };
    if (cuerpo["stream"] === true) {
      const trozo = (delta: Record<string, unknown>, fin: string | null = null) =>
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;
      const sse =
        trozo({ role: "assistant", content: "" }) +
        trozo({ content: texto }) +
        trozo({}, "stop") +
        `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [], usage: uso })}\n\n` +
        "data: [DONE]\n\n";
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: texto }, finish_reason: "stop" }], usage: uso }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return {
    provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl }),
    cuerpos: () => n,
  };
}

function capa(provider: Provider, exactCache = new InMemoryExactCache()) {
  let n = 0;
  return createSavingsLayer({
    provider,
    devUnlicensed: true,
    exactTokenizer: false,
    silenceWarnings: true,
    generateId: () => `req-${n++}`,
    exactCache,
  });
}

function pedir(layer: ReturnType<typeof capa>, modo: Modo, req: SavingsRequest): Promise<SavingsResult> {
  return modo === "json" ? layer.generate(req) : layer.generateStream(req).result;
}

const DEL_FALLO = DISTINTAS.slice(0, 3); // isError, argumentos, toolCallId

describe.each<Adaptador>(["anthropic", "openai"])("3 · por la capa, con el adaptador %s", (adaptador) => {
  // `router: false`: el catálogo viaja entero y la capa no toca la petición, así
  // que la llamada que corre deja registro de referencia (E1-E7). Sin registro,
  // «no hay reference» no probaría nada.
  const req = (messages: Mensajes): SavingsRequest =>
    peticionDe(messages, { model: MODELO[adaptador], temperature: 0, savings: { router: false } });

  describe.each<Modo>(["json", "stream"])("en %s", (modo) => {
    for (const v of DEL_FALLO) {
      it(`${v.nombre}: la segunda conversación NO recibe la respuesta de la primera`, async () => {
        const { provider, cuerpos } = proveedor(adaptador);
        const layer = capa(provider);
        const { a, b } = variante(v);

        const primera = await pedir(layer, modo, req(a));
        expect(primera.text).toBe("respuesta 0");

        const segunda = await pedir(layer, modo, req(b));
        expect(cuerpos()).toBe(2);
        expect(segunda.report.cache.result).toBe("miss");
        expect(segunda.text).toBe("respuesta 1");
        expect(segunda.report.cache.reference).toBeUndefined();
        expect(segunda.report.cost.basis).not.toBe("reference");

        // La caché sigue sirviendo la repetición DE VERDAD: misma conversación,
        // mismos campos, sin llamar.
        const repetida = await pedir(layer, modo, req(a));
        expect(repetida.report.cache.result).toBe("exact");
        expect(repetida.text).toBe("respuesta 0");
        expect(cuerpos()).toBe(2);
        // Y la referencia está viva en este montaje: la repetición idéntica sí la lleva.
        expect(repetida.report.cost.basis).toBe("reference");
      });
    }

    it("otra ejecución del mismo bucle (ids nuevos): acierta, y en estimated, nunca reference", async () => {
      const { provider, cuerpos } = proveedor(adaptador);
      const layer = capa(provider);
      const { a, b } = variante(RENOMBRADAS[1]!);
      const primera = await pedir(layer, modo, req(a));
      const otra = await pedir(layer, modo, req(b));
      expect(cuerpos()).toBe(1);
      expect(otra.report.cache.result).toBe("exact");
      expect(otra.text).toBe(primera.text);
      expect(otra.report.cache.reference).toBeUndefined();
      expect(otra.report.cache.referenceRejected).toBe("different-request");
      expect(otra.report.cost.basis).not.toBe("reference");
    });
  });

  describe("singleflight", () => {
    it("control: dos peticiones idénticas concurrentes SÍ se coalescen", async () => {
      const { provider, cuerpos } = proveedor(adaptador, 30);
      const layer = capa(provider);
      const [x, y] = await Promise.all([layer.generate(req(conversacion())), layer.generate(req(conversacion()))]);
      expect(cuerpos()).toBe(1);
      expect(y.text).toBe(x.text);
    });

    for (const v of DEL_FALLO) {
      it(`${v.nombre}: dos concurrentes no se coalescen (JSON + JSON y JSON + stream)`, async () => {
        const { a, b } = variante(v);

        const p1 = proveedor(adaptador, 30);
        const l1 = capa(p1.provider);
        const [x1, y1] = await Promise.all([l1.generate(req(a)), l1.generate(req(b))]);
        expect(p1.cuerpos()).toBe(2);
        expect(y1.text).not.toBe(x1.text);
        expect(y1.report.cost.basis).not.toBe("reference");

        // Un stream nunca lidera, pero sí se suma a un líder en vuelo.
        const p2 = proveedor(adaptador, 30);
        const l2 = capa(p2.provider);
        const [x2, y2] = await Promise.all([l2.generate(req(a)), l2.generateStream(req(b)).result]);
        expect(p2.cuerpos()).toBe(2);
        expect(y2.text).not.toBe(x2.text);
        expect(y2.report.cost.basis).not.toBe("reference");
      });
    }
  });
});

// ── 4 · Las entradas escritas con la clave vieja ─────────────────────────────

describe("4 · una entrada escrita antes del cambio, bajo la clave que ignoraba los campos", () => {
  // Con el código anterior la clave de una conversación con herramientas era la
  // de la MISMA conversación sin los campos: la vieja no los veía. Esa clave no
  // ha cambiado (bloque 1), así que es la que queda viva en una caché
  // persistente hasta su TTL.
  const conCampos = conversacion();
  const sinCampos: Mensajes = conCampos.map((m) => ({ role: m.role, content: m.content }));
  const req = (messages: Mensajes): SavingsRequest =>
    peticionDe(messages, { model: MODELO.anthropic, temperature: 0 });
  const claveVieja = buildExactKey(canonicalize(req(sinCampos)));

  /** La entrada tal como la escribía la 0.4.28 tras servir la conversación CON campos. */
  async function sembrar(cache: InMemoryExactCache, huella: string) {
    const texto = "respuesta vieja";
    await cache.set(claveVieja, {
      text: texto,
      data: texto,
      storedAtMs: Date.now(),
      meta: {
        reference: {
          v: 2,
          requestId: "req-viejo",
          at: Date.now(),
          model: MODELO.anthropic,
          inputTokens: 900,
          outputTokens: 12,
          layerInsertions: 0,
          reasoningTokens: 0,
          requestFingerprint: huella,
          textSha256: sha256(texto),
          cacheKey: claveVieja,
        },
      },
    });
  }

  it("la petición con herramientas ya no la alcanza: su clave es otra", async () => {
    expect(buildExactKey(canonicalize(req(conCampos)))).not.toBe(claveVieja);
    const cache = new InMemoryExactCache();
    await sembrar(cache, huellaDePeticion(req(conCampos)));
    const { provider, cuerpos } = proveedor("anthropic");
    const r = await capa(provider, cache).generate(req(conCampos));
    expect(r.report.cache.result).toBe("miss");
    expect(cuerpos()).toBe(1);
  });

  it("a la que sí la alcanza (la misma sin campos) no le vale como referencia: L4, different-request", async () => {
    const cache = new InMemoryExactCache();
    await sembrar(cache, huellaDePeticion(req(conCampos)));
    const { provider } = proveedor("anthropic");
    const r = await capa(provider, cache).generate(req(sinCampos));
    expect(r.report.cache.result).toBe("exact");
    expect(r.report.cache.reference).toBeUndefined();
    expect(r.report.cache.referenceRejected).toBe("different-request");
    expect(r.report.cost.basis).not.toBe("reference");
  });

  it("control: con la huella de ESA petición el mismo registro sí valdría (lo que rechaza es L4)", async () => {
    const cache = new InMemoryExactCache();
    await sembrar(cache, huellaDePeticion(req(sinCampos)));
    const { provider } = proveedor("anthropic");
    const r = await capa(provider, cache).generate(req(sinCampos));
    expect(r.report.cache.result).toBe("exact");
    expect(r.report.cache.referenceRejected).toBeUndefined();
    expect(r.report.cache.reference).toBeDefined();
  });
});

// ── 5 · La caché semántica, con "include-agentic", tampoco cruza ─────────────

class ProveedorNumerado implements Provider {
  readonly id = "numerado";
  llamadas = 0;
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    return { text: `respuesta ${this.llamadas++}`, usage: { inputTokens: 100, outputTokens: 5 }, finishReason: "stop" };
  }
}

// El embebedor de juguete de `cache-semantica-agentica`: lo que se prueba es la
// identidad, no la calidad del embebedor.
const embed = async (t: string): Promise<number[]> =>
  [0, 1, 2, 3].map((i) => [...t].filter((c) => c.charCodeAt(0) % 4 === i).length);

describe('5 · caché semántica con "include-agentic"', () => {
  const req = (messages: Mensajes): SavingsRequest =>
    peticionDe(messages, {
      model: "openai/gpt-4o-mini",
      savings: { semanticCache: "include-agentic", exactCache: false, singleflight: false },
      context: { tenantId: "acme" },
    });

  for (const v of DEL_FALLO) {
    it(`${v.nombre}: miss, y la misma conversación sí acierta`, async () => {
      const proveedorN = new ProveedorNumerado();
      const layer = createSavingsLayer({
        provider: proveedorN,
        costModels: { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } },
        silenceWarnings: true,
        semanticCacheStore: new InMemorySemanticCache({ embed, similarityThreshold: 0.3, acceptThreshold: 0.3 }),
      });
      const { a, b } = variante(v);
      await layer.generate(req(a));
      const cruzada = await layer.generate(req(b));
      expect(cruzada.report.cache.result).toBe("miss");
      expect(proveedorN.llamadas).toBe(2);

      const misma = await layer.generate(req(a));
      expect(misma.report.cache.result).toBe("semantic");
      expect(misma.text).toBe("respuesta 0");
    });
  }
});
