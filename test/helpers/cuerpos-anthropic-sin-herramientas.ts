import { AnthropicProvider, type AnthropicOptions } from "../../src/providers/anthropic.js";
import { lotesDelProveedor } from "../../src/providers/lotes-del-proveedor.js";
import type { ChatMessage, JsonSchema, ToolDescriptor } from "../../src/contracts/types.js";
import type { ProviderRequest } from "../../src/providers/types.js";

// LAS CONVERSACIONES SIN BUCLE DE HERRAMIENTAS, Y LOS CUERPOS QUE SALEN DE ELLAS.
//
// El arreglo del bucle de herramientas (`tool_use`/`tool_result` en el cable de
// Anthropic) no puede mover un byte de ninguna petición que no tenga ese bucle.
// Este módulo define la batería de peticiones y la forma de sacar sus cuerpos
// (JSON, SSE y línea de lote), y `test/fixtures/anthropic-cuerpos-sin-herramientas.json`
// guarda los cuerpos que produjo el adaptador ANTERIOR al arreglo (el de
// `origin/main` tras #354), generados con este mismo módulo. El test compara
// contra ese fichero: si un cambio los mueve, falla.
//
// Para regenerarlo con la versión que se quiera fijar (un checkout de
// `src/providers/anthropic.ts` de ese commit), desde la raíz:
//
//   npx tsx -e 'import("./test/helpers/cuerpos-anthropic-sin-herramientas.ts").then((m) => m.escribirFixture())'

const POLITICA = "Eres el asistente de soporte de una tienda. Contesta en castellano.";

const contrato: JsonSchema = {
  type: "object",
  properties: { answer: { type: "string" }, refs: { type: "array", items: { type: "string" } } },
  required: ["answer", "refs"],
  additionalProperties: false,
};
const contratoNoEstricto: JsonSchema = {
  type: "object",
  properties: { answer: { type: "string" }, refs: { type: "array", items: { type: "string" } } },
  required: ["answer"],
};

const herramientas: ToolDescriptor[] = [
  {
    id: "buscar_pedido",
    intents: ["buscar pedido"],
    risk: "read",
    description: "Busca un pedido por su id",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  { id: "sin_parametros", intents: ["hora"], risk: "read" },
];

const u = (content: string): ChatMessage => ({ role: "user", content });
const a = (content: string): ChatMessage => ({ role: "assistant", content });
const s = (content: string): ChatMessage => ({ role: "system", content });

const conversacion: ChatMessage[] = [
  s(POLITICA),
  u("¿Dónde está mi pedido 40218?"),
  a("Lo miro: salió ayer del almacén."),
  u("¿Y cuándo llega?"),
  a("Mañana antes de las 14:00."),
  u("Gracias. ¿Puedo cambiar la dirección?"),
];

export interface CasoSinHerramientas {
  nombre: string;
  opciones?: AnthropicOptions;
  req: ProviderRequest;
}

/** Peticiones SIN bucle de herramientas: el cuerpo tiene que ser el de antes, byte a byte. */
export const CASOS: CasoSinHerramientas[] = [
  { nombre: "un turno", req: { model: "claude-sonnet-4-6", messages: [u("hola")] } },
  { nombre: "conversación sin marcar", req: { model: "claude-sonnet-4-6", messages: conversacion } },
  {
    nombre: "conversación con prefijo estable",
    req: { model: "claude-sonnet-4-6", messages: conversacion, stablePrefixMessages: 5 },
  },
  {
    nombre: "solo la cabecera en el prefijo",
    req: { model: "claude-sonnet-4-6", messages: conversacion, stablePrefixMessages: 1 },
  },
  {
    nombre: "colocador: cola a 5 min",
    req: {
      model: "claude-sonnet-4-6",
      messages: conversacion,
      stablePrefixMessages: 5,
      cachePlacement: { tail: true, ttl: "5m" },
    },
  },
  {
    nombre: "colocador: cola a 1 h",
    req: {
      model: "claude-sonnet-4-6",
      messages: conversacion,
      stablePrefixMessages: 3,
      cachePlacement: { tail: true, ttl: "1h" },
    },
  },
  {
    nombre: "colocador: sin cola, 1 h",
    req: {
      model: "claude-sonnet-4-6",
      messages: conversacion,
      stablePrefixMessages: 5,
      cachePlacement: { tail: false, ttl: "1h" },
    },
  },
  {
    nombre: "caché automática",
    opciones: { automaticCache: true },
    req: { model: "claude-sonnet-4-6", messages: conversacion, stablePrefixMessages: 5 },
  },
  {
    nombre: "un solo punto de ruptura",
    opciones: { maxCacheBreakpoints: 1 },
    req: { model: "claude-sonnet-4-6", messages: conversacion, stablePrefixMessages: 5 },
  },
  {
    nombre: "empieza por el asistente («(continue)»)",
    req: {
      model: "claude-sonnet-4-6",
      messages: [s(POLITICA), a("Hola, ¿en qué te ayudo?"), u("Mi pedido"), a("¿Qué número?"), u("40218")],
      stablePrefixMessages: 4,
    },
  },
  {
    nombre: "system a mitad de conversación",
    req: {
      model: "claude-sonnet-4-6",
      messages: [s(POLITICA), u("¿Dónde está mi pedido?"), a("¿Qué número?"), s("Evidencia: pedido 40218 en reparto."), u("40218")],
      stablePrefixMessages: 3,
    },
  },
  {
    nombre: "contrato estricto sin herramientas",
    req: { model: "claude-sonnet-4-6", messages: conversacion, schema: contrato, maxOutputTokens: 300 },
  },
  {
    nombre: "contrato no estricto",
    req: { model: "claude-sonnet-4-6", messages: [u("resume")], schema: contratoNoEstricto, temperature: 0 },
  },
  {
    nombre: "herramientas y contrato, sin historial de herramientas",
    req: { model: "claude-sonnet-4-6", messages: conversacion, tools: herramientas, schema: contrato },
  },
  {
    nombre: "herramientas sin historial de herramientas, con prefijo",
    req: { model: "claude-sonnet-4-6", messages: conversacion, tools: herramientas, stablePrefixMessages: 5 },
  },
  {
    nombre: "búsqueda nativa sin historial de herramientas",
    req: {
      model: "claude-sonnet-4-6",
      messages: conversacion,
      tools: herramientas,
      toolSearch: { variant: "bm25", alwaysLoaded: ["sin_parametros"] },
    },
  },
  {
    nombre: "diferible, con tope y temperatura",
    req: { model: "anthropic/claude-sonnet-4-6", messages: conversacion, deferrable: true, maxOutputTokens: 64, temperature: 0.2 },
  },
  {
    nombre: "id con prefijo contra un proxy",
    opciones: { baseUrl: "https://proxy.test/v1" },
    req: { model: "anthropic/claude-sonnet-4-6", messages: [u("hola")] },
  },
];

/**
 * Peticiones de un llamante ANTIGUO: resultados con `role: "tool"` y turnos del
 * asistente sin ids. No pueden viajar como `tool_use`/`tool_result`, así que
 * salen como texto, igual que antes — el mismo cuerpo, byte a byte, siempre que
 * ningún texto esté vacío (un texto vacío era un 400 y ya no se manda).
 */
export const CASOS_ANTIGUOS: CasoSinHerramientas[] = [
  {
    nombre: "resultado de herramienta como texto, sin ids",
    req: {
      model: "claude-sonnet-4-6",
      messages: [s(POLITICA), u("busca el pedido 40218"), a("llamando"), { role: "tool", content: '{"estado":"entregado"}' }],
      tools: herramientas,
      stablePrefixMessages: 3,
    },
  },
  {
    nombre: "llamadas sin id y resultados sin toolCallId",
    req: {
      model: "claude-sonnet-4-6",
      messages: [
        u("busca el pedido 40218"),
        { role: "assistant", content: "Lo busco.", toolCalls: [{ name: "buscar_pedido", arguments: '{"id":"40218"}' }] },
        { role: "tool", name: "buscar_pedido", content: '{"estado":"entregado"}' },
      ],
      tools: herramientas,
    },
  },
];

/** Los tres cuerpos de una petición: `generate()`, `generateStream()` y la línea de lote. */
export async function cuerposDe(caso: CasoSinHerramientas): Promise<{ json: string; sse: string; lote: string }> {
  const enviados: string[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    enviados.push(init.body);
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const proveedor = new AnthropicProvider({ ...caso.opciones, fetchImpl });
  await proveedor.generate(caso.req);
  for await (const _ of proveedor.generateStream(caso.req)) void _;
  const lote = lotesDelProveedor(proveedor)!.cuerpo(caso.req);
  return { json: enviados[0]!, sse: enviados[1]!, lote: JSON.stringify(lote) };
}

/** Los cuerpos de toda la batería, por nombre. */
export async function todosLosCuerpos(): Promise<Record<string, { json: string; sse: string; lote: string }>> {
  const salida: Record<string, { json: string; sse: string; lote: string }> = {};
  for (const caso of [...CASOS, ...CASOS_ANTIGUOS]) salida[caso.nombre] = await cuerposDe(caso);
  return salida;
}

export const RUTA_DEL_FIXTURE = new URL("../fixtures/anthropic-cuerpos-sin-herramientas.json", import.meta.url);

/** Escribe el fixture con el adaptador que haya ahora en `src/`. Solo para regenerarlo a mano. */
export async function escribirFixture(): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(new URL("../fixtures/", import.meta.url), { recursive: true });
  await writeFile(RUTA_DEL_FIXTURE, JSON.stringify(await todosLosCuerpos(), null, 2) + "\n");
}
