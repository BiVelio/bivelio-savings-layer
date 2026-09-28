import { createMiddleware } from "langchain";
import type { AgentMiddleware } from "langchain";
import { AIMessage } from "@langchain/core/messages";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import type {
  ChatMessage,
  ProviderResponse,
  ProviderUsage,
  RequestContext,
  SavingsAdapterOptions,
  SavingsReport,
  SavingsResult,
  ToolCallRequest,
  ToolDescriptor,
} from "@bivelio/savings-layer";
import { origenDeLaUrl, type OrigenAtestiguado } from "../providers/origen-oficial.js";
import { crearCapaDelAdaptador } from "./comun/capa.js";
import { construirPeticion, herramienta } from "./comun/peticion.js";
import { nuevaLlamada, registrarDesenlace } from "./comun/puente.js";

// EL ADAPTADOR DE LANGCHAIN.JS (`langchain` 1.x): un middleware de agente con
// `wrapModelCall`, la forma documentada de envolver la llamada al modelo de un
// `createAgent`. Llamar al `handler` cero veces es el cortocircuito documentado.
//
// El handler se llama SIN TOCAR la petición. Es una llamada entera: si el modelo
// está en modo stream, sus tokens siguen saliendo por los callbacks del modelo
// como siempre; el adaptador mide la respuesta cuando termina.

/** Options for {@link savingsAgentMiddleware}. */
export interface SavingsAgentMiddlewareOptions extends SavingsAdapterOptions {
  /** Cache identity for a model call (tenant, session…), read from the agent's model request. */
  context?: (request: unknown) => RequestContext | undefined;
  /**
   * The model id the report is priced with. Default: `<model type>/<model name>`
   * (for instance `openai/gpt-4o-mini`); a name that already contains "/" is kept.
   */
  modelId?: (model: unknown) => string;
  /** Put the report in `response_metadata.bivelio.savingsReport` of the AI message (default true). */
  reportInMetadata?: boolean;
}

/** The agent middleware, plus `close()` to stop the layer's background work when shutting down. */
export type SavingsAgentMiddleware = AgentMiddleware & { close(): void };

type Registro = Record<string, unknown>;

function esRegistro(v: unknown): v is Registro {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tipoDe(m: unknown): string {
  const x = m as { getType?: () => string; _getType?: () => string; type?: unknown };
  try {
    if (typeof x.getType === "function") return x.getType();
    if (typeof x._getType === "function") return x._getType();
  } catch {
    /* un mensaje raro: se lee por su campo */
  }
  return typeof x.type === "string" ? x.type : "";
}

function textoDe(contenido: unknown): string {
  if (typeof contenido === "string") return contenido;
  if (!Array.isArray(contenido)) return "";
  return contenido
    .filter((b): b is Registro => esRegistro(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function argumentosDe(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

function llamadasDe(m: Registro): ToolCallRequest[] {
  const tc = Array.isArray(m.tool_calls) ? m.tool_calls : [];
  return tc.filter(esRegistro).map((c) => ({
    ...(typeof c.id === "string" ? { id: c.id } : {}),
    name: String(c.name ?? ""),
    arguments: argumentosDe(c.args),
  }));
}

// Los mensajes del agente como `ChatMessage[]`.
function renderizar(sistema: unknown, mensajes: readonly unknown[]): ChatMessage[] {
  const salida: ChatMessage[] = [];
  const textoSistema = textoDe((sistema as Registro | undefined)?.content);
  if (textoSistema !== "") salida.push({ role: "system", content: textoSistema });
  for (const m of mensajes) {
    if (!esRegistro(m)) continue;
    const tipo = tipoDe(m);
    if (tipo === "system") salida.push({ role: "system", content: textoDe(m.content) });
    else if (tipo === "human") salida.push({ role: "user", content: textoDe(m.content) });
    else if (tipo === "ai") {
      const toolCalls = llamadasDe(m);
      salida.push({ role: "assistant", content: textoDe(m.content), ...(toolCalls.length > 0 ? { toolCalls } : {}) });
    } else if (tipo === "tool") {
      salida.push({
        role: "tool",
        content: typeof m.content === "string" ? m.content : argumentosDe(m.content),
        ...(typeof m.tool_call_id === "string" ? { toolCallId: m.tool_call_id } : {}),
        ...(typeof m.name === "string" ? { name: m.name } : {}),
      });
    }
  }
  return salida;
}

// Un mensaje, para la huella: el texto del turno fuera (lo cubre la clave del
// núcleo), los bloques que no son texto dentro, los argumentos crudos de las
// llamadas dentro y sus ids fuera. `response_metadata`, `usage_metadata` e `id`
// cambian en cada ejecución (y ahí va el informe): fuera.
function proyectarMensaje(m: unknown): unknown {
  if (!esRegistro(m)) return m;
  const contenido = m.content;
  const tipo = tipoDe(m);
  const extra: Registro = {};
  for (const [k, v] of Object.entries(esRegistro(m.additional_kwargs) ? m.additional_kwargs : {})) {
    if (k === "tool_calls" || k === "function_call" || k.startsWith("__")) continue;
    extra[k] = v;
  }
  return {
    type: tipo,
    name: m.name,
    content:
      tipo === "tool"
        ? contenido
        : typeof contenido === "string"
          ? "$text"
          : Array.isArray(contenido)
            ? contenido.map((b) => (esRegistro(b) && b.type === "text" ? { ...b, text: undefined, id: undefined } : b))
            : contenido,
    tool_calls: llamadasDe(m).map((c) => ({ name: c.name, arguments: c.arguments })),
    status: m.status,
    additional_kwargs: extra,
  };
}

// Las herramientas del agente. Las de cliente (StructuredTool) traen nombre y
// esquema; las de servidor son objetos planos que el proveedor ejecuta: `write`.
function herramientas(
  opciones: SavingsAgentMiddlewareOptions,
  tools: readonly unknown[],
): { tools: ToolDescriptor[]; definiciones: unknown[] } {
  const descriptores: ToolDescriptor[] = [];
  const definiciones: unknown[] = [];
  for (const t of tools) {
    if (!esRegistro(t)) continue;
    if (typeof t.name === "string" && "schema" in t) {
      let parametros: unknown;
      let serializable = true;
      try {
        parametros = toJsonSchema(t.schema as Parameters<typeof toJsonSchema>[0]);
      } catch {
        serializable = false;
      }
      const d = herramienta(opciones, {
        nombre: t.name,
        descripcion: typeof t.description === "string" ? t.description : undefined,
        parametros,
      });
      // Sin un esquema que se pueda leer, no hay forma de distinguir dos
      // herramientas con el mismo nombre: se trata como si tuviera efectos.
      descriptores.push(serializable ? d : { ...d, risk: "write" });
      definiciones.push({ name: t.name, description: t.description, parametros, returnDirect: t.returnDirect });
      continue;
    }
    const funcion = esRegistro(t.function) ? t.function : undefined;
    if (t.type === "function" && funcion && typeof funcion.name === "string") {
      descriptores.push(
        herramienta(opciones, {
          nombre: funcion.name,
          descripcion: typeof funcion.description === "string" ? funcion.description : undefined,
          parametros: funcion.parameters,
        }),
      );
      definiciones.push(t);
      continue;
    }
    descriptores.push(
      herramienta(opciones, { nombre: String(t.name ?? t.type ?? "server-tool"), delProveedor: true }),
    );
    definiciones.push(t);
  }
  return { tools: descriptores, definiciones };
}

function tipoDeModelo(model: unknown): string {
  try {
    const t = (model as { _llmType?: () => string })._llmType?.();
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

function nombreDeModelo(model: unknown): string {
  if (typeof model === "string") return model.replace(":", "/");
  const m = model as { model?: unknown; modelName?: unknown; _defaultConfig?: unknown };
  // EL MODELO EN CADENA. `createAgent({ model: "openai:gpt-4o-mini" })` —la forma
  // que enseñan el README, `bvsala init` y la documentación de LangChain v1— no
  // llega como ChatOpenAI sino como `ConfigurableModel`: su `_llmType()` es
  // "chat_model" y no tiene `model` ni `modelName`; el nombre y el proveedor
  // viven en `_defaultConfig` (langchain 1.5.14). Sin esto el informe salía como
  // "chat_model/" y se tarifaba al precio ILUSTRATIVO, no al de lista.
  const conf = m._defaultConfig as { model?: unknown; modelProvider?: unknown } | undefined;
  if (conf && typeof conf === "object" && typeof conf.model === "string" && conf.model !== "") {
    if (conf.model.includes("/")) return conf.model;
    return typeof conf.modelProvider === "string" && conf.modelProvider !== "" ? `${conf.modelProvider}/${conf.model}` : conf.model;
  }
  const nombre = typeof m.model === "string" ? m.model : typeof m.modelName === "string" ? m.modelName : "";
  if (nombre.includes("/")) return nombre;
  const tipo = tipoDeModelo(model);
  return tipo !== "" ? `${tipo}/${nombre}` : nombre;
}

// A QUIÉN HABLA EL MODELO (E0-bis de la referencia), solo por su configuración
// PÚBLICA:
//   · `ChatOpenAI` y las clases que heredan de él: `identifyingParams()`, método
//     público que devuelve sus `ClientOptions` con `baseURL` ya resuelto (la
//     opción `configuration.baseURL` o `OPENAI_BASE_URL`);
//   · `ChatAnthropic` (`_llmType()` "anthropic"): su campo público `apiUrl`, que
//     el constructor resuelve de `anthropicApiUrl`, `clientOptions.baseURL` o
//     `ANTHROPIC_BASE_URL` (@langchain/anthropic 1.5).
// Sin una URL ahí, DESCONOCIDO, y la regla no cambia: el modelo en cadena de
// `createAgent` (`"openai:gpt-4o-mini"`, un `ConfigurableModel` que la guarda en
// campos internos), un `ChatAnthropic` sin URL (puede tener un `createClient`
// propio, Vertex por ejemplo) o cualquier otro modelo. No se leen campos
// internos (`clientConfig`, `client`, `_defaultConfig`), y de lo que devuelve
// `identifyingParams()` —que incluye la clave— solo se mira `baseURL`.
function origenDelModelo(model: unknown): OrigenAtestiguado | undefined {
  if (!esRegistro(model)) return undefined;
  try {
    if (typeof model.identifyingParams === "function") {
      const p: unknown = (model.identifyingParams as () => unknown).call(model);
      const base = esRegistro(p) ? p.baseURL : undefined;
      if (typeof base === "string" && base !== "") return origenDeLaUrl(base);
    }
  } catch {
    // Un modelo cuyos parámetros no se pueden leer: se sigue con lo demás.
  }
  const url = model.apiUrl;
  if (tipoDeModelo(model) === "anthropic" && typeof url === "string" && url !== "") return origenDeLaUrl(url);
  return undefined;
}

function parametrosDelModelo(model: unknown): unknown {
  try {
    const p = (model as { invocationParams?: (o?: unknown) => unknown }).invocationParams?.({});
    return p ?? null;
  } catch {
    return null;
  }
}

// R7: salida estructurada o herramienta forzada → sin resolvers. Con salida
// estructurada, además, sin reutilizar: el agente interpreta la respuesta del
// modelo según la estrategia elegida, y el adaptador solo sabe reproducir texto y
// llamadas a herramienta.
function pideFormaEstricta(request: Registro): boolean {
  const eleccion = request.toolChoice;
  if (eleccion === "required" || esRegistro(eleccion)) return true;
  return request.responseFormat !== undefined;
}

// ─── Lo que devolvió el modelo ──────────────────────────────────────────────

function numero(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * `usage_metadata` de LangChain. `input_tokens` es el prompt entero (incluidas
 * lecturas y escrituras de la caché de prefijo) según la convención de
 * LangChain; si los detalles suman más que el total, el proveedor no la sigue y
 * el contador no se sabe leer: `complete:false`.
 */
function usoDe(msg: Registro, fiable: boolean): ProviderUsage {
  const u = esRegistro(msg.usage_metadata) ? msg.usage_metadata : undefined;
  const entrada = numero(u?.input_tokens);
  const salida = numero(u?.output_tokens);
  const detEntrada = esRegistro(u?.input_token_details) ? u.input_token_details : {};
  const detSalida = esRegistro(u?.output_token_details) ? u.output_token_details : {};
  const leida = numero(detEntrada.cache_read);
  const escrita = numero(detEntrada.cache_creation);
  const razonamiento = numero(detSalida.reasoning);
  const cuadra = entrada !== undefined && (leida ?? 0) + (escrita ?? 0) <= entrada;
  const completo = fiable && entrada !== undefined && salida !== undefined && cuadra;
  return {
    inputTokens: entrada ?? 0,
    outputTokens: salida ?? 0,
    ...(leida !== undefined ? { cachedInputTokens: leida } : {}),
    ...(escrita !== undefined ? { cacheWriteInputTokens: escrita } : {}),
    ...(razonamiento !== undefined ? { reasoningTokens: razonamiento } : {}),
    ...(completo ? {} : { complete: false }),
  };
}

function paradaDe(msg: Registro): string | undefined {
  const rm = esRegistro(msg.response_metadata) ? msg.response_metadata : {};
  const motivo = rm.finish_reason ?? rm.stop_reason ?? rm.finishReason;
  switch (motivo) {
    case "end_turn":
    case "stop":
    case "STOP":
      return "stop";
    case "max_tokens":
    case "length":
    case "MAX_TOKENS":
      return "length";
    case "tool_use":
    case "tool_calls":
      return "tool_calls";
    default:
      return typeof motivo === "string" ? motivo : undefined;
  }
}

// R6: solo texto (sin citas ni anotaciones) y llamadas a herramienta, parada
// `stop` DICHA por el proveedor, y nada de razonamiento que el proveedor espere
// de vuelta. Sin motivo de parada no se sabe si la respuesta se cortó: no se
// reutiliza.
function reproducible(msg: Registro, parada: string | undefined): boolean {
  if (parada !== "stop") return false;
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!esRegistro(b) || b.type !== "text") return false;
      if (Array.isArray(b.citations) && b.citations.length > 0) return false;
      if (Array.isArray(b.annotations) && b.annotations.length > 0) return false;
    }
  }
  const extra = esRegistro(msg.additional_kwargs) ? msg.additional_kwargs : {};
  return !("reasoning" in extra || "reasoning_content" in extra || "audio" in extra);
}

function respuestaDe(msg: Registro, fiable: boolean): ProviderResponse {
  const parada = paradaDe(msg);
  const toolCalls = llamadasDe(msg);
  return {
    text: textoDe(msg.content),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(parada ? { finishReason: parada } : {}),
    usage: usoDe(msg, fiable),
    ...(reproducible(msg, parada) ? {} : { replayable: false }),
  };
}

function mensajeDeAtajo(result: SavingsResult, informe: SavingsReport | undefined): AIMessage {
  return new AIMessage({
    content: result.text,
    tool_calls: (result.toolCalls ?? []).map((tc, i) => {
      let args: Record<string, unknown> = {};
      try {
        const leido: unknown = JSON.parse(tc.arguments || "{}");
        if (esRegistro(leido)) args = leido;
      } catch {
        args = {};
      }
      return { id: tc.id ?? `bvsala-${result.requestId}-${i}`, name: tc.name, args, type: "tool_call" as const };
    }),
    // Cero: el proveedor no facturó nada. El informe dice cuánto se evitó.
    usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    response_metadata: informe ? { bivelio: { savingsReport: informe } } : {},
  });
}

const AVISO_CACHE_DEL_MODELO =
  "[bvsala] this LangChain model has its own `cache` set, so a usage counter can be a cached copy rather " +
  "than a provider bill; its calls are reported as unmeasured.";

/**
 * The savings layer as a LangChain agent middleware:
 * `createAgent({ model, tools, middleware: [..., savingsAgentMiddleware({ licenseKey })] })`,
 * last in the list, so nothing sits between it and the model.
 */
export function savingsAgentMiddleware(options: SavingsAgentMiddlewareOptions): SavingsAgentMiddleware {
  const capa = crearCapaDelAdaptador("langchain", options);
  const conMetadatos = options.reportInMetadata !== false;

  const middleware = createMiddleware({
    name: "BivelioSavings",
    wrapModelCall: async (request, handler) => {
      const r = request as unknown as Registro;
      const model = r.model;
      const tipo = tipoDeModelo(model);
      const conCache = esRegistro(model) && model.cache !== undefined && model.cache !== null && model.cache !== false;
      if (conCache) capa.avisar("cache-del-modelo", AVISO_CACHE_DEL_MODELO);
      // D8: un modelo de prueba (`fake…`) o con caché propia no da la factura.
      const fiable = !tipo.toLowerCase().includes("fake") && !conCache;
      const modelo = options.modelId ? options.modelId(model) : nombreDeModelo(model);
      const mensajes = Array.isArray(r.messages) ? r.messages : [];
      const { tools, definiciones } = herramientas(options, Array.isArray(r.tools) ? r.tools : []);
      const estricta = pideFormaEstricta(r);
      const temperatura = numero((model as Registro | undefined)?.temperature);
      const req = await construirPeticion(options, {
        model: modelo,
        messages: renderizar(r.systemMessage, mensajes),
        tools,
        temperature: temperatura,
        context: options.context?.(request),
        proyeccion: {
          modelo,
          parametros: parametrosDelModelo(model),
          sistema: proyectarMensaje(r.systemMessage),
          mensajes: mensajes.map(proyectarMensaje),
          herramientas: definiciones,
          toolChoice: r.toolChoice,
          responseFormat: r.responseFormat,
          modelSettings: r.modelSettings,
        },
        restricciones: { sinResolvers: estricta, sinReutilizar: r.responseFormat !== undefined },
      });
      let original: AIMessage | undefined;
      const llamada = nuevaLlamada(
        { model: req.model, messages: req.messages, ...(req.tools ? { tools: req.tools } : {}) },
        async () => {
          original = await registrarDesenlace(llamada, async () => handler(request));
          return respuestaDe(original as unknown as Registro, fiable);
        },
        undefined,
        origenDelModelo(model),
      );
      const d = await capa.generar(req, llamada);
      if (d.tipo === "sin-informe") return original as AIMessage;
      const informe = capa.informe(d.result.report);
      if (d.tipo === "atajo") return mensajeDeAtajo(d.result, conMetadatos ? informe : undefined);
      const msg = original as AIMessage;
      if (conMetadatos) {
        msg.response_metadata = { ...(msg.response_metadata ?? {}), bivelio: { savingsReport: informe } };
      }
      return msg;
    },
  });
  return Object.assign(middleware, { close: () => capa.close() }) as SavingsAgentMiddleware;
}

/** The savings report of an AI message produced through {@link savingsAgentMiddleware}. */
export function getSavingsReportFromMessage(message: unknown): SavingsReport | undefined {
  const rm = (message as { response_metadata?: unknown } | null | undefined)?.response_metadata;
  const bivelio = esRegistro(rm) ? rm.bivelio : undefined;
  const informe = esRegistro(bivelio) ? bivelio.savingsReport : undefined;
  if (!esRegistro(informe) || typeof informe.requestId !== "string") return undefined;
  return informe as unknown as SavingsReport;
}
