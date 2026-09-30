import type { Middleware } from "@anthropic-ai/sdk";
import type {
  ChatMessage,
  ProviderResponse,
  ProviderStreamEvent,
  RequestContext,
  SavingsAdapterOptions,
  SavingsReport,
  SavingsRequest,
  SavingsResult,
  ToolCallRequest,
} from "@bivelio/savings-layer";
import {
  esBloqueDeRazonamiento,
  fusionarUso,
  paradaDeMensajes,
  negativaNoCobrada,
  tierServidoDe,
  usoDeMensajes,
  type UsoAnthropic,
} from "../providers/anthropic-uso.js";
import {
  TEMPERATURA_POR_DEFECTO,
  rechazaMuestreo,
  rechazaToolChoiceForzado,
} from "../providers/anthropic-compat.js";
import { origenDeLaUrl } from "../providers/origen-oficial.js";
import { SseParser, type SseMessage } from "../providers/sse.js";
import { crearCapaDelAdaptador, promesaDeApertura, type CapaDelAdaptador, type LlamadaEnStream } from "./comun/capa.js";
import { Cola } from "./comun/cola.js";
import { construirPeticion, fusionarContexto, herramienta, opcionesDeLlamada } from "./comun/peticion.js";
import { nuevaLlamada, type LlamadaDelMarco } from "./comun/puente.js";

// EL ADAPTADOR DEL SDK OFICIAL DE ANTHROPIC (`@anthropic-ai/sdk` ≥ 0.103): una
// opción `middleware` del cliente.
//
// El middleware del SDK corre POR INTENTO HTTP, dentro de su bucle de
// reintentos, y ve siempre la petición canónica (`POST …/v1/messages`, también
// en Bedrock, Vertex y Foundry, que adaptan DENTRO de `next`). Así que cada
// intento es una petición de la capa, y un intento que el proveedor rechaza
// (429, 529…) no se registra: la capa lanza, y el middleware devuelve AL SDK la
// MISMA respuesta que recibió, para que aplique sus reintentos y sus errores
// tipados como si el adaptador no estuviera.
//
// EL `stop_reason` NO SE TOCA (0.5, PR #434): hacia el framework el adaptador
// habla el protocolo del SDK de Anthropic, y ahí `stop_reason` es contrato de
// Anthropic (el SDK y el código del cliente comparan contra `end_turn`,
// `max_tokens`, `pause_turn`…). Cerrarlo rompería ese contrato sin ganar nada.
// Lo cerrado (`stop | length | tool_calls | content_filter | other`) vive en el
// informe de la capa: `qualityLedger.truncation`. Lo fija
// test/finish-reason-cerrado.test.ts.
//
// Solo intercepta la creación de mensajes. `count_tokens`, `batches`, `models`
// y `files` pasan sin tocar: no hay una generación que medir ni que ahorrarse.
//
// La aritmética del contador es la de `AnthropicProvider` (anthropic-uso.ts),
// la misma función: una factura se cuenta igual entre por donde entre.
//
// Y el ORIGEN también se decide igual: por la URL de la petición que ve el
// middleware (`request.url`, API pública del SDK), que es la base URL del
// cliente más `/v1/messages`. Contra `https://api.anthropic.com`, oficial;
// contra LiteLLM, un gateway o el host de Bedrock, Vertex o Foundry, no, y la
// repetición no se valora por referencia (E0-bis de pipeline/referencia.ts). Un
// `fetch` propio del cliente que mande la petición a otro sitio no se ve.

/** Options for {@link anthropicSavings}. */
export interface AnthropicSavingsOptions extends SavingsAdapterOptions {
  /**
   * Cache identity for a call (tenant, session…). `requestOptions` is what the
   * call passed as its second argument (`client.messages.create(body, options)`).
   * A `bivelio: { context }` entry in those options wins over it, key by key.
   */
  context?: (call: { body: unknown; requestOptions: unknown }) => RequestContext | undefined;
  /** How many reports {@link AnthropicSavings.reportFor} keeps (default 1000, oldest out first). */
  reportCacheSize?: number;
}

/** What {@link anthropicSavings} returns. */
export interface AnthropicSavings {
  /** Pass it last in `new Anthropic({ middleware: [..., savings.middleware] })`. */
  readonly middleware: Middleware;
  /** The savings report of a message this client received, by the message or its id. */
  reportFor(message: { id: string } | string): SavingsReport | undefined;
  /** Stop the layer's background work when shutting down. */
  close(): void;
}

type Registro = Record<string, unknown>;

const ERROR_CUERPO = "[bvsala] could not read the request body; nothing was sent.";

function esRegistro(v: unknown): v is Registro {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Solo `POST …/v1/messages` (con o sin `?beta=true`). */
function esCreacionDeMensaje(request: { url: string; method?: string | undefined }): boolean {
  if ((request.method ?? "GET").toUpperCase() !== "POST") return false;
  try {
    return new URL(request.url).pathname.replace(/\/+$/, "").endsWith("/v1/messages");
  } catch {
    return false;
  }
}

function bloques(contenido: unknown): Registro[] {
  if (typeof contenido === "string") return [{ type: "text", text: contenido }];
  return Array.isArray(contenido) ? contenido.filter(esRegistro) : [];
}

function textoDe(bs: Registro[]): string {
  return bs
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function argumentosDe(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

// El cuerpo de la API de Mensajes como `ChatMessage[]`: el texto de cada turno,
// los `tool_use` en `toolCalls` y cada `tool_result` como un turno `tool`. El
// razonamiento, las imágenes, los documentos y los bloques de herramientas del
// servidor quedan fuera del texto y DENTRO de la huella.
function renderizar(cuerpo: Registro): ChatMessage[] {
  const salida: ChatMessage[] = [];
  const system = cuerpo.system;
  if (typeof system === "string" ? system !== "" : Array.isArray(system)) {
    salida.push({ role: "system", content: typeof system === "string" ? system : textoDe(bloques(system)) });
  }
  for (const m of Array.isArray(cuerpo.messages) ? cuerpo.messages : []) {
    if (!esRegistro(m)) continue;
    const bs = bloques(m.content);
    if (m.role === "assistant") {
      const toolCalls: ToolCallRequest[] = bs
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          ...(typeof b.id === "string" ? { id: b.id } : {}),
          name: String(b.name ?? ""),
          arguments: argumentosDe(b.input),
        }));
      salida.push({ role: "assistant", content: textoDe(bs), ...(toolCalls.length > 0 ? { toolCalls } : {}) });
      continue;
    }
    for (const b of bs) {
      if (b.type !== "tool_result") continue;
      salida.push({
        role: "tool",
        content: typeof b.content === "string" ? b.content : textoDe(bloques(b.content)),
        ...(typeof b.tool_use_id === "string" ? { toolCallId: b.tool_use_id } : {}),
      });
    }
    const texto = textoDe(bs);
    if (texto !== "" || !bs.some((b) => b.type === "tool_result")) salida.push({ role: "user", content: texto });
  }
  return salida;
}

// Un bloque, para la huella: sin el texto del turno (lo cubre la clave del
// núcleo) y sin los ids de `tool_use`/`tool_result`, que cambian en cada
// ejecución. El contenido de un `tool_result` va CRUDO: la clave solo ve su
// texto normalizado.
function proyectarBloque(b: Registro): Registro {
  const salida: Registro = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === "id" || k === "tool_use_id") continue;
    if (k === "text" && b.type === "text") continue;
    salida[k] = v;
  }
  return salida;
}

function proyectar(cuerpo: Registro, beta: string | null): unknown {
  const salida: Registro = {};
  for (const [k, v] of Object.entries(cuerpo)) {
    // `stream` no cambia la respuesta (la misma pregunta en stream o entera es la
    // misma entrada), y `metadata.user_id` es para el control de abuso.
    if (k === "stream" || k === "metadata" || k === "messages" || k === "system") continue;
    salida[k] = v;
  }
  salida.system = typeof cuerpo.system === "string" ? "$text" : bloques(cuerpo.system).map(proyectarBloque);
  salida.messages = (Array.isArray(cuerpo.messages) ? cuerpo.messages : []).filter(esRegistro).map((m) => ({
    role: m.role,
    content: bloques(m.content).map(proyectarBloque),
  }));
  if (beta) salida["anthropic-beta"] = beta;
  return salida;
}

// R7: salida estructurada o herramienta forzada → sin resolvers.
function pideFormaEstricta(cuerpo: Registro): boolean {
  const eleccion = cuerpo.tool_choice;
  if (esRegistro(eleccion) && (eleccion.type === "any" || eleccion.type === "tool")) return true;
  if (esRegistro(cuerpo.output_config) && cuerpo.output_config.format !== undefined) return true;
  return cuerpo.output_format !== undefined;
}

// UN CUERPO QUE EL API VA A RECHAZAR, DICHO ANTES. Este adaptador reenvía la
// petición INTACTA (R1 del puente: ni un byte cambia), así que NO degrada lo que
// `AnthropicProvider` sí degrada —`tool_choice` forzado y `temperature` en los
// modelos que los rechazan (providers/anthropic-compat.ts)—: el 400 del API le
// llega al llamante tal cual, con su error tipado del SDK. Lo que sí hace es
// avisar UNA vez por causa y modelo (silenciable con `silenceWarnings`), porque
// el mensaje del API no dice qué cambiar y un cliente que actualiza de Sonnet 5 a
// Sonnet 5.5 lo va a ver en cada llamada. Tampoco reescribe el historial: las
// palancas que reescriben van apagadas en los adaptadores, así que el check de
// «preserved thinking» (editar algo anterior a un bloque de pensamiento → 400
// desde el 2026-08-31) no lo puede disparar la capa.
function avisosDelCuerpo(cuerpo: Registro): { clave: string; mensaje: string }[] {
  const modelo = typeof cuerpo.model === "string" ? cuerpo.model : "";
  if (modelo === "") return [];
  const avisos: { clave: string; mensaje: string }[] = [];
  const eleccion = cuerpo.tool_choice;
  if (esRegistro(eleccion) && (eleccion.type === "any" || eleccion.type === "tool") && rechazaToolChoiceForzado(modelo)) {
    avisos.push({
      clave: `tool-choice-forzado:${modelo}`,
      mensaje:
        `[bvsala] Model "${modelo}" rejects a forced \`tool_choice\` (\`any\` or \`tool\`) with a 400, with or ` +
        "without thinking. This adapter forwards your request unchanged, so the API will reject it: use " +
        "`tool_choice: {type: \"auto\"}` with `strict: true` tools, or `output_config.format` for a fixed JSON shape. " +
        "See https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#forcing-tool-use",
    });
  }
  const muestreo = (["temperature", "top_p", "top_k"] as const).filter(
    (k) => typeof cuerpo[k] === "number" && !(k === "temperature" && cuerpo[k] === TEMPERATURA_POR_DEFECTO),
  );
  if (muestreo.length > 0 && rechazaMuestreo(modelo)) {
    avisos.push({
      clave: `muestreo:${modelo}`,
      mensaje:
        `[bvsala] Model "${modelo}" rejects a non-default ${muestreo.map((k) => `\`${k}\``).join(", ")} with a 400. ` +
        "This adapter forwards your request unchanged, so the API will reject it: drop the parameter for this " +
        "model. See https://platform.claude.com/docs/en/models/sonnet-5-5/overview",
    });
  }
  return avisos;
}

// ─── Lo que devolvió el modelo ──────────────────────────────────────────────

// Estado de UNA respuesta de la API de Mensajes, JSON o SSE. Lee lo mismo que
// `AnthropicProvider` y decide además si se puede reproducir (R6): solo texto
// sin citas y `tool_use` del cliente, parada `end_turn`. Pensamiento (siempre
// firmado), bloques de herramientas del servidor, citas y cualquier bloque
// nuevo: `replayable:false`.
class RespuestaDeMensajes {
  id: string | undefined;
  texto = "";
  razono = false;
  reproducible = true;
  parada: string | undefined;
  // Para saber si una negativa se cobra (ver negativaNoCobrada).
  detallesDeParada: unknown;
  bloquesVistos = 0;
  usoInicio: UsoAnthropic | undefined;
  usoDelta: UsoAnthropic | undefined;
  vioDelta = false;
  vioStop = false;
  error: string | undefined;
  private readonly herramientas = new Map<number, { id?: string; name: string; json: string }>();
  private readonly toolCallsJson: ToolCallRequest[] = [];

  bloque(b: Registro): void {
    this.bloquesVistos += 1;
    if (esBloqueDeRazonamiento(b.type as string | undefined)) {
      this.razono = true;
      this.reproducible = false;
    } else if (b.type === "text") {
      if (Array.isArray(b.citations) && b.citations.length > 0) this.reproducible = false;
    } else if (b.type !== "tool_use") {
      this.reproducible = false;
    }
  }

  json(msg: Registro): void {
    this.id = typeof msg.id === "string" ? msg.id : undefined;
    for (const b of bloques(msg.content)) {
      this.bloque(b);
      if (b.type === "text" && typeof b.text === "string") this.texto += b.text;
      if (b.type === "tool_use") {
        this.toolCallsJson.push({
          ...(typeof b.id === "string" ? { id: b.id } : {}),
          name: String(b.name ?? ""),
          arguments: argumentosDe(b.input),
        });
      }
    }
    this.parada = typeof msg.stop_reason === "string" ? msg.stop_reason : undefined;
    this.detallesDeParada = msg.stop_details;
    this.usoInicio = esRegistro(msg.usage) ? (msg.usage as UsoAnthropic) : undefined;
    this.usoDelta = this.usoInicio;
    this.vioDelta = true;
    this.vioStop = true;
  }

  /** Un evento SSE. Devuelve el delta de texto, si lo trae. */
  evento(m: SseMessage): string | undefined {
    let data: Registro;
    try {
      data = JSON.parse(m.data) as Registro;
    } catch {
      return undefined;
    }
    if (!esRegistro(data)) return undefined;
    const tipo = m.event !== "message" ? m.event : String(data.type ?? m.event);
    switch (tipo) {
      case "message_start": {
        const msg = esRegistro(data.message) ? data.message : {};
        if (typeof msg.id === "string") this.id = msg.id;
        if (esRegistro(msg.usage)) this.usoInicio = msg.usage as UsoAnthropic;
        return undefined;
      }
      case "content_block_start": {
        const b = esRegistro(data.content_block) ? data.content_block : {};
        this.bloque(b);
        if (b.type === "tool_use" && typeof data.index === "number") {
          this.herramientas.set(data.index, {
            ...(typeof b.id === "string" ? { id: b.id } : {}),
            name: String(b.name ?? ""),
            json: "",
          });
        }
        return undefined;
      }
      case "content_block_delta": {
        const d = esRegistro(data.delta) ? data.delta : {};
        if (d.type === "text_delta" && typeof d.text === "string") {
          this.texto += d.text;
          return d.text === "" ? undefined : d.text;
        }
        if (d.type === "input_json_delta" && typeof d.partial_json === "string" && typeof data.index === "number") {
          const h = this.herramientas.get(data.index);
          if (h) h.json += d.partial_json;
        }
        if (d.type === "citations_delta") this.reproducible = false;
        return undefined;
      }
      case "message_delta": {
        this.vioDelta = true;
        const d = esRegistro(data.delta) ? data.delta : {};
        if (typeof d.stop_reason === "string") this.parada = d.stop_reason;
        if ("stop_details" in d) this.detallesDeParada = d.stop_details;
        if (esRegistro(data.usage)) this.usoDelta = fusionarUso(this.usoDelta, data.usage as UsoAnthropic);
        return undefined;
      }
      case "message_stop":
        this.vioStop = true;
        return undefined;
      case "error": {
        const e = esRegistro(data.error) ? data.error : {};
        this.error = `${String(e.type ?? "error")}: ${String(e.message ?? "")}`;
        return undefined;
      }
      default:
        return undefined;
    }
  }

  get toolCalls(): ToolCallRequest[] {
    if (this.toolCallsJson.length > 0) return this.toolCallsJson;
    return [...this.herramientas.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, h]) => ({ ...(h.id ? { id: h.id } : {}), name: h.name, arguments: normalizarArgumentos(h.json) }))
      .filter((tc) => tc.name !== "");
  }

  respuesta(): ProviderResponse {
    const merged = fusionarUso(this.usoInicio, this.usoDelta);
    // En JSON, `usoDelta` es el `usage` entero; en SSE, el de `message_delta`.
    // Sin `message_delta` no hay contador final: los dos a 0 y `complete:false`,
    // exactamente como `AnthropicProvider`.
    const usage = this.vioDelta
      ? usoDeMensajes(merged, this.usoDelta?.output_tokens, this.razono).usage
      : { inputTokens: 0, outputTokens: 0, complete: false };
    // Una respuesta con compactación del servidor factura cada iteración y el
    // contador de arriba es solo la última: hasta sumarlas, no es la factura.
    const iteraciones = (merged as { iterations?: unknown }).iterations;
    if (Array.isArray(iteraciones) && iteraciones.length > 1) usage.complete = false;
    const toolCalls = this.toolCalls;
    const tier = tierServidoDe(merged);
    return {
      text: this.texto,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...paradaDeMensajes(this.parada, this.detallesDeParada),
      ...(this.vioDelta &&
      negativaNoCobrada({
        stopReason: this.parada,
        stopDetails: this.detallesDeParada,
        bloques: this.bloquesVistos,
        outputTokens: this.usoDelta?.output_tokens,
        iterations: iteraciones,
      })
        ? { unbilledRefusal: true }
        : {}),
      ...(tier ? { servedServiceTier: tier } : {}),
      usage,
      ...(this.reproducible && this.parada === "end_turn" ? {} : { replayable: false }),
    };
  }
}

// `partial_json` concatenado → la cadena que la respuesta JSON habría dado.
function normalizarArgumentos(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json === "" ? "{}" : json));
  } catch {
    return json;
  }
}

// ─── Lo que la capa contestó sin llamar ─────────────────────────────────────

function mensajeDeAtajo(result: SavingsResult, modelo: unknown): Registro {
  const contenido: Registro[] = [];
  if (result.text !== "") contenido.push({ type: "text", text: result.text });
  (result.toolCalls ?? []).forEach((tc, i) => {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.arguments || "{}");
    } catch {
      input = {};
    }
    contenido.push({ type: "tool_use", id: tc.id ?? `toolu_bvsala_${result.requestId}_${i}`, name: tc.name, input });
  });
  return {
    id: `msg_bvsala_${result.requestId}`,
    type: "message",
    role: "assistant",
    model: modelo,
    content: contenido,
    stop_reason: (result.toolCalls?.length ?? 0) > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    // Cero: el proveedor no facturó nada. El informe dice cuánto se evitó.
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function respuestaDeAtajo(result: SavingsResult, modelo: unknown, stream: boolean): Response {
  const msg = mensajeDeAtajo(result, modelo);
  const cabeceras = { "request-id": `bvsala_${result.requestId}` };
  if (!stream) {
    return new Response(JSON.stringify(msg), {
      status: 200,
      headers: { ...cabeceras, "content-type": "application/json" },
    });
  }
  const ev = (e: string, d: unknown): string => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
  let sse = ev("message_start", {
    type: "message_start",
    message: { ...msg, content: [], stop_reason: null, stop_sequence: null },
  });
  (msg.content as Registro[]).forEach((b, index) => {
    if (b.type === "text") {
      sse += ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      sse += ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      sse += ev("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: b.id, name: b.name, input: {} },
      });
      sse += ev("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
      });
    }
    sse += ev("content_block_stop", { type: "content_block_stop", index });
  });
  sse += ev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: msg.stop_reason, stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  sse += ev("message_stop", { type: "message_stop" });
  return new Response(sse, { status: 200, headers: { ...cabeceras, "content-type": "text/event-stream" } });
}

// ─── El middleware ──────────────────────────────────────────────────────────

/** Un intento que el proveedor rechazó: el SDK recibe esa respuesta tal cual. */
class RespuestaNoOk extends Error {
  constructor(readonly respuesta: Response) {
    super(`[bvsala] provider responded ${respuesta.status}`);
  }
}

/**
 * The savings layer as an Anthropic SDK middleware:
 * `new Anthropic({ middleware: [savings.middleware] })`, last in the list.
 *
 * **Stop reasons.** The middleware speaks the official SDK's protocol to your
 * code, so the `Message` you get keeps Anthropic's own `stop_reason`
 * (`end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`,
 * `refusal`, `model_context_window_exceeded`…) and `stop_details`, exactly as
 * Anthropic sent them, in JSON and in stream. That is the SDK's contract and the
 * layer does not rewrite it. An answer the layer served without calling
 * Anthropic (from its cache or a local resolver) comes back as `end_turn`, or
 * `tool_use` when it carries tool calls. What the layer normalises is its own report:
 * {@link AnthropicSavings.reportFor} gives `qualityLedger.truncation.finishReason`
 * in the closed set of 0.5 (`stop`, `length`, `tool_calls`, `content_filter`,
 * `other`) and Anthropic's value, when it adds something, in
 * `truncation.finishReasonDetail`.
 */
export function anthropicSavings(options: AnthropicSavingsOptions): AnthropicSavings {
  const capa = crearCapaDelAdaptador("anthropic-sdk", options);
  const tope = Math.max(1, Math.floor(options.reportCacheSize ?? 1000));
  const informes = new Map<string, SavingsReport>();
  const guardar = (id: string | undefined, informe: SavingsReport): void => {
    if (!id) return;
    informes.delete(id);
    informes.set(id, informe);
    while (informes.size > tope) informes.delete(informes.keys().next().value as string);
  };

  const middleware: Middleware = async (request, next, ctx) => {
    if (!esCreacionDeMensaje(request)) return next(request);
    if (typeof request.body !== "string") throw new Error(ERROR_CUERPO);
    let cuerpo: Registro;
    try {
      const leido: unknown = JSON.parse(request.body);
      if (!esRegistro(leido)) throw new Error(ERROR_CUERPO);
      cuerpo = leido;
    } catch {
      throw new Error(ERROR_CUERPO);
    }

    for (const a of avisosDelCuerpo(cuerpo)) capa.avisar(a.clave, a.mensaje);

    const opcionesDePeticion = ctx.options as Registro | undefined;
    const porLlamada = opcionesDeLlamada(opcionesDePeticion?.bivelio);
    const delLlamante = options.context?.({ body: cuerpo, requestOptions: opcionesDePeticion });
    const tools = (Array.isArray(cuerpo.tools) ? cuerpo.tools : []).filter(esRegistro).map((t) =>
      herramienta(options, {
        nombre: String(t.name ?? ""),
        descripcion: typeof t.description === "string" ? t.description : undefined,
        parametros: t.input_schema,
        // Sin `input_schema` y con un `type` propio (web_search, code_execution…):
        // una herramienta definida por Anthropic.
        delProveedor: t.input_schema === undefined && typeof t.type === "string" && t.type !== "custom",
      }),
    );
    const req: SavingsRequest = await construirPeticion(options, {
      model: `anthropic/${String(cuerpo.model ?? "")}`,
      messages: renderizar(cuerpo),
      tools,
      temperature: typeof cuerpo.temperature === "number" ? cuerpo.temperature : undefined,
      context: fusionarContexto(delLlamante, porLlamada.context),
      savings: porLlamada.savings,
      proyeccion: proyectar(cuerpo, request.headers.get("anthropic-beta")),
      restricciones: { sinResolvers: pideFormaEstricta(cuerpo) },
    });
    const renderizado = { model: req.model, messages: req.messages, ...(req.tools ? { tools: req.tools } : {}) };
    // A quién va esta petición: el host de su URL (ver la cabecera).
    const origen = origenDeLaUrl(request.url);

    // El intento, a través de `next`, con la petición INTACTA (el cuerpo no se
    // reserializa). Un rechazo del proveedor se guarda para devolverlo al SDK.
    const intentar = async (llamada: LlamadaDelMarco): Promise<Response> => {
      let r: Response;
      try {
        r = await next(request);
      } catch (error) {
        llamada.errorDelMarco = { error };
        throw error;
      }
      if (!r.ok) {
        const error = new RespuestaNoOk(r);
        llamada.errorDelMarco = { error };
        throw error;
      }
      llamada.completada = true;
      return r;
    };

    const devolverRechazo = (err: unknown): Response => {
      if (err instanceof RespuestaNoOk) return err.respuesta;
      throw err;
    };

    if (cuerpo.stream !== true) {
      let original: Response | undefined;
      let idOriginal: string | undefined;
      const llamada = nuevaLlamada(
        renderizado,
        async () => {
          original = await intentar(llamada);
          const estado = new RespuestaDeMensajes();
          estado.json((await original.clone().json()) as Registro);
          idOriginal = estado.id;
          return estado.respuesta();
        },
        undefined,
        origen,
      );
      let d;
      try {
        d = await capa.generar(req, llamada);
      } catch (err) {
        return devolverRechazo(err);
      }
      if (d.tipo === "sin-informe") return original as Response;
      const informe = capa.informe(d.result.report);
      if (d.tipo === "atajo") {
        guardar(`msg_bvsala_${d.result.requestId}`, informe);
        return respuestaDeAtajo(d.result, cuerpo.model, false);
      }
      guardar(idOriginal, informe);
      return original as Response;
    }

    // ── En stream ──
    const { abierta, abrir } = promesaDeApertura();
    let observada: Response | undefined;
    let entera: Response | undefined;
    const llamada: LlamadaEnStream = Object.assign(
      nuevaLlamada(
        renderizado,
        // El camino de último recurso del núcleo pide la respuesta ENTERA: se
        // devuelve al SDK en cuanto llega y se lee a la vez que él la lee.
        async () => {
          const r = await intentar(llamada);
          const cola = new Cola<ProviderStreamEvent>();
          entera = observarSse(r, cola, capa, llamada, guardar);
          abrir();
          for await (const ev of cola) if (ev.type === "done") return ev.response;
          throw new Error("[bvsala] the model stream ended before completion; nothing was measured.");
        },
        () => {
          const cola = new Cola<ProviderStreamEvent>();
          void intentar(llamada).then(
            (r) => {
              observada = observarSse(r, cola, capa, llamada, guardar);
              abrir();
            },
            (err: unknown) => cola.fail(err),
          );
          return cola;
        },
        origen,
      ),
      { abierta },
    );
    let d;
    try {
      d = await capa.transmitir(req, llamada, request.signal ?? undefined);
    } catch (err) {
      return devolverRechazo(err);
    }
    if (d.tipo === "abierto") return (observada ?? entera) as Response;
    if (d.tipo === "atajo") {
      const informe = capa.informe(d.result.report);
      guardar(`msg_bvsala_${d.result.requestId}`, informe);
      return respuestaDeAtajo(d.result, cuerpo.model, true);
    }
    // `entero` y `sin-informe` solo ocurren si la respuesta ya se abrió (arriba).
    return (observada ?? entera) as Response;
  };

  return {
    middleware,
    reportFor(message) {
      const id = typeof message === "string" ? message : message?.id;
      return typeof id === "string" ? informes.get(id) : undefined;
    },
    close() {
      capa.close();
    },
  };
}

// ─── El observador del SSE ──────────────────────────────────────────────────
//
// Reenvía los bytes TAL CUAL (el SDK parsea su propio stream) y los parsea a la
// vez para la capa: deltas de texto a la cola y, al `message_stop`, la respuesta
// entera con su contador. Retiene solo el CIERRE del cuerpo hasta que el informe
// está guardado, para que `reportFor(finalMessage)` lo encuentre.
//
// Un JSON donde se pidió stream (un endpoint compatible que lo ignora) se lee
// entero, como hace `AnthropicProvider`, y se devuelve sin tocar.
function observarSse(
  r: Response,
  cola: Cola<ProviderStreamEvent>,
  capa: CapaDelAdaptador,
  llamada: LlamadaEnStream,
  guardar: (id: string | undefined, informe: SavingsReport) => void,
): Response {
  const estado = new RespuestaDeMensajes();
  // El informe se espera EN CUANTO la respuesta está completa, no al cerrar el
  // cuerpo: un lector que deja de leer tras `message_stop` no se queda sin él.
  let informeListo: Promise<void> | undefined;
  const esperarInforme = async (): Promise<void> => {
    try {
      const resultado = await (llamada.resultado as Promise<SavingsResult>);
      guardar(estado.id, capa.informe(resultado.report));
    } catch {
      // Sin informe: el intento falló o se canceló, y la capa no registró nada.
    }
  };
  const terminar = (): void => {
    if (cola.cerrada) return;
    if (estado.error) {
      cola.fail(new Error(`[bvsala] provider stream error: ${estado.error}`));
    } else if (estado.vioDelta || estado.vioStop) {
      cola.push({ type: "done", response: estado.respuesta() });
      cola.end();
      informeListo = esperarInforme();
    } else {
      cola.fail(new Error("[bvsala] the model stream ended before completion; nothing was measured."));
    }
  };

  if ((r.headers.get("content-type") ?? "").includes("application/json")) {
    void r
      .clone()
      .json()
      .then(
        (json: unknown) => {
          estado.json(esRegistro(json) ? json : {});
          if (estado.texto !== "") cola.push({ type: "text", delta: estado.texto });
          terminar();
        },
        (err: unknown) => cola.fail(err),
      );
    return r;
  }

  const cuerpo = r.body;
  if (!cuerpo) {
    cola.fail(new Error("[bvsala] the model stream had no body; nothing was measured."));
    return r;
  }
  const lector = cuerpo.getReader();
  const parser = new SseParser();
  const alimentar = (mensajes: SseMessage[]): void => {
    for (const m of mensajes) {
      const delta = estado.evento(m);
      if (delta !== undefined) cola.push({ type: "text", delta });
      if (estado.vioStop || estado.error) terminar();
    }
  };
  const observado = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let leido: { done: boolean; value?: Uint8Array };
      try {
        leido = await lector.read();
      } catch (err) {
        cola.fail(err);
        controller.error(err);
        return;
      }
      if (leido.done) {
        alimentar(parser.end());
        terminar();
        await informeListo;
        controller.close();
        return;
      }
      const bytes = leido.value as Uint8Array;
      controller.enqueue(bytes);
      alimentar(parser.push(bytes));
    },
    cancel(motivo) {
      cola.fail(new Error("[bvsala] the stream was cancelled by its reader; nothing was measured."));
      return lector.cancel(motivo);
    },
  });
  return new Response(observado, { status: r.status, statusText: r.statusText, headers: r.headers });
}
