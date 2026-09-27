import type { Processor } from "@mastra/core/processors";
import type {
  ProviderResponse,
  RequestContext,
  SavingsAdapterOptions,
  SavingsReport,
  SavingsRequest,
  SavingsResult,
  ToolCallRequest,
  ToolDescriptor,
} from "@bivelio/savings-layer";
import { crearCapaDelAdaptador } from "./comun/capa.js";
import {
  argumentos,
  cabecerasDeIdentidad,
  esModeloSimulado,
  modeloPorDefecto,
  paradaNeutra,
  proyectarPrompt,
  renderizarPrompt,
  sinOpcionesAjenas,
  usoDeAiSdk,
} from "./comun/prompt-ai-sdk.js";
import { construirPeticion, fusionarContexto, herramienta, opcionesDeLlamada } from "./comun/peticion.js";
import { nuevaLlamada, type LlamadaDelMarco } from "./comun/puente.js";

// EL ADAPTADOR DE MASTRA (`@mastra/core` 1.x): un procesador de entrada con los
// ganchos documentados de caché de respuestas del agente:
//
//   · `processInputStep` guarda, por paso, lo que el prompt no lleva: las
//     herramientas activas (nombre, descripción y JSON Schema), `toolChoice`,
//     `providerOptions`, los ajustes del modelo y si hay salida estructurada.
//     Solo DATOS serializables: `state` puede persistirse.
//   · `processLLMRequest` pregunta a la capa. Si puede contestar sin llamar,
//     devuelve `{ response: { chunks } }` y Mastra se salta el modelo (es el
//     cortocircuito que usa el `ResponseCache` del propio Mastra). Si la capa
//     decide llamar, no devuelve nada y Mastra llama al modelo TAL CUAL.
//   · `processLLMResponse` recibe lo que el modelo contestó y se lo da a la capa,
//     que lo mide con el contador del proveedor. Un fallo del modelo (la parte
//     `error`) no se registra.
//
// Entre el segundo y el tercer gancho la llamada queda PENDIENTE, en un mapa del
// módulo (no en `state`, que puede serializarse), con un plazo: si Mastra nunca
// informa de vuelta —los caminos `generateLegacy`/`streamLegacy`, o un agente
// durable que continúa en otro proceso—, la llamada se abandona sin registro.
//
// Las peticiones idénticas en vuelo no se comparten aquí: una llamada pendiente
// depende de que Mastra vuelva a este proceso con su respuesta, y un seguidor
// esperándola quedaría colgado del mismo plazo.

/** Options for {@link savingsProcessor}. */
export interface SavingsProcessorOptions extends SavingsAdapterOptions {
  /** Cache identity for a model call (tenant, session…), from the agent's request context. */
  context?: (args: { requestContext?: unknown }) => RequestContext | undefined;
  /** Also emit each report as a `data-bivelio-savings-report` stream part (default false). */
  emitReportPart?: boolean;
  /**
   * Give up on a model call Mastra never reported back, in ms (default 15 minutes).
   * Nothing is recorded for it.
   */
  providerTimeoutMs?: number;
  /**
   * The model id the report is priced with. Default: `<provider>/<modelId>`, with
   * the provider's first segment; a model id that already contains "/" is kept.
   */
  modelId?: (model: { provider: string; modelId: string }) => string;
}

/**
 * The processor, plus `close()` to stop the layer's background work when shutting down.
 * It implements the step, request, response and API-error hooks, so it is both an
 * input processor and an error processor.
 */
export type SavingsProcessor = Processor<"bivelio-savings"> &
  Required<Pick<Processor<"bivelio-savings">, "processInputStep" | "processLLMRequest" | "processLLMResponse" | "processAPIError">> & {
    close(): void;
  };

type Registro = Record<string, unknown>;

function esRegistro(v: unknown): v is Registro {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Lo que `processInputStep` guarda en `state` para el paso.
const CLAVE_PASO = "bivelio.paso";
// El token de la llamada pendiente del paso.
const CLAVE_PENDIENTE = "bivelio.pendiente";

interface DatosDelPaso {
  paso: number;
  herramientas: { nombre: string; descripcion?: string; parametros?: unknown; delProveedor: boolean }[];
  /** Alguna herramienta sin un esquema legible: no se puede separar de otra con el mismo nombre. */
  esquemaIlegible: boolean;
  toolChoice?: unknown;
  activeTools?: unknown;
  providerOptions?: unknown;
  modelSettings?: unknown;
  salidaEstructurada?: unknown;
}

interface Pendiente {
  resolver: (r: ProviderResponse) => void;
  rechazar: (e: unknown) => void;
  llamada: LlamadaDelMarco;
  resultado: Promise<SavingsResult>;
  plazo: ReturnType<typeof setTimeout>;
  alAbortar?: () => void;
  signal?: AbortSignal;
}

function esquemaDe(t: Registro): { esquema?: unknown; legible: boolean } {
  // Mastra entrega las herramientas ya convertidas al AI SDK: el JSON Schema
  // está en `parameters.jsonSchema` (o `inputSchema.jsonSchema`).
  for (const c of [t.parameters, t.inputSchema]) {
    if (esRegistro(c) && esRegistro(c.jsonSchema)) return { esquema: c.jsonSchema, legible: true };
    if (esRegistro(c) && (c.type === "object" || esRegistro(c.properties))) return { esquema: c, legible: true };
  }
  return { legible: false };
}

function datosDelPaso(args: Registro): DatosDelPaso {
  const herramientas: DatosDelPaso["herramientas"] = [];
  let esquemaIlegible = false;
  const activas = Array.isArray(args.activeTools) ? new Set(args.activeTools.map(String)) : undefined;
  for (const [nombre, t] of Object.entries(esRegistro(args.tools) ? args.tools : {})) {
    if (activas && !activas.has(nombre)) continue;
    if (!esRegistro(t)) continue;
    const { esquema, legible } = esquemaDe(t);
    let serializable = legible;
    try {
      JSON.stringify(esquema);
    } catch {
      serializable = false;
    }
    if (!serializable) esquemaIlegible = true;
    herramientas.push({
      nombre,
      ...(typeof t.description === "string" ? { descripcion: t.description } : {}),
      ...(serializable ? { parametros: esquema } : {}),
      delProveedor: t.type === "provider-defined" || t.type === "provider",
    });
  }
  const salida = esRegistro(args.structuredOutput) ? args.structuredOutput : undefined;
  let salidaEstructurada: unknown;
  if (salida) {
    const { esquema } = esquemaDe({ inputSchema: salida.schema });
    salidaEstructurada = esquema ?? true;
  }
  return {
    paso: typeof args.stepNumber === "number" ? args.stepNumber : -1,
    herramientas,
    esquemaIlegible,
    toolChoice: args.toolChoice,
    activeTools: args.activeTools,
    providerOptions: args.providerOptions,
    modelSettings: args.modelSettings,
    ...(salidaEstructurada !== undefined ? { salidaEstructurada } : {}),
  };
}

// Los ajustes que cambian lo que el modelo contesta (no los reintentos ni la
// cancelación).
function ajustes(modelSettings: unknown): unknown {
  if (!esRegistro(modelSettings)) return undefined;
  const salida: Registro = {};
  for (const [k, v] of Object.entries(modelSettings)) {
    if (k === "maxRetries" || k === "abortSignal" || k === "headers") continue;
    salida[k] = v;
  }
  salida.headers = cabecerasDeIdentidad(modelSettings.headers);
  return salida;
}

// ─── Lo que devolvió el modelo (partes de Mastra: `{ type, payload }`) ──────

function respuestaDeTrozos(trozos: readonly unknown[], simulado: boolean): ProviderResponse | { error: unknown } {
  let texto = "";
  const toolCalls: ToolCallRequest[] = [];
  let reproducible = true;
  let finish: Registro | undefined;
  for (const t of trozos) {
    if (!esRegistro(t)) continue;
    const p = esRegistro(t.payload) ? t.payload : {};
    switch (t.type) {
      case "error":
        return { error: p.error ?? new Error("[bvsala] the model call failed") };
      case "text-delta":
        if (typeof p.text === "string") texto += p.text;
        break;
      case "tool-call":
        if (p.providerExecuted === true) reproducible = false;
        else {
          toolCalls.push({
            ...(typeof p.toolCallId === "string" ? { id: p.toolCallId } : {}),
            name: String(p.toolName ?? ""),
            arguments: argumentos(p.args ?? p.input),
          });
        }
        break;
      case "reasoning-start":
      case "reasoning-delta":
      case "reasoning-end":
        if (esRegistro(p.providerMetadata) && Object.keys(sinOpcionesAjenas(p.providerMetadata) as Registro).length > 0) {
          reproducible = false;
        }
        break;
      case "finish":
        finish = p;
        break;
      case "step-start":
      case "response-metadata":
      case "text-start":
      case "text-end":
      case "tool-call-input-streaming-start":
      case "tool-call-delta":
      case "tool-call-input-streaming-end":
      case "raw":
        break;
      default:
        // file, source, tool-result, aprobaciones, partes propias…
        reproducible = false;
    }
  }
  const stepResult = esRegistro(finish?.stepResult) ? finish.stepResult : {};
  const unificada = typeof stepResult.reason === "string" ? stepResult.reason : undefined;
  const neutra = paradaNeutra(unificada);
  const salida = esRegistro(finish?.output) ? finish.output : {};
  const uso = esRegistro(salida.usage) ? salida.usage : undefined;
  // El contador del proveedor viaja anidado en `usage.raw` (formato V4). Sin
  // él, el uso plano de Mastra no dice si incluye la caché: `complete:false`.
  const usage = usoDeAiSdk(uso?.raw, simulado);
  return {
    text: texto,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(neutra ? { finishReason: neutra } : {}),
    usage: finish ? usage : { inputTokens: 0, outputTokens: 0, complete: false },
    ...(reproducible && unificada === "stop" ? {} : { replayable: false }),
  };
}

// Los trozos de un atajo, con la forma que Mastra recibe de un modelo en vivo
// (la fija un test de contrato contra Mastra de verdad). Uso CERO: el proveedor
// no facturó nada.
function trozosDeAtajo(result: SavingsResult, informe: SavingsReport | undefined, messageId: unknown): Registro[] {
  const id = `bvsala-${result.requestId}`;
  const trozos: Registro[] = [
    {
      type: "step-start",
      payload: {
        request: {},
        warnings: [],
        ...(typeof messageId === "string" ? { messageId } : {}),
        startedAt: Date.now(),
      },
    },
    { type: "response-metadata", payload: { type: "response-metadata", id, modelId: result.report.model, timestamp: new Date() } },
  ];
  if (result.text !== "") {
    trozos.push({ type: "text-start", payload: { id } });
    trozos.push({ type: "text-delta", payload: { id, text: result.text } });
    trozos.push({ type: "text-end", payload: { type: "text-end", id } });
  }
  (result.toolCalls ?? []).forEach((tc, i) => {
    let args: unknown = {};
    try {
      args = JSON.parse(tc.arguments || "{}");
    } catch {
      args = {};
    }
    trozos.push({ type: "tool-call", payload: { toolCallId: tc.id ?? `${id}-${i}`, toolName: tc.name, args } });
  });
  const conHerramientas = (result.toolCalls?.length ?? 0) > 0;
  trozos.push({
    type: "finish",
    payload: {
      type: "finish",
      stepResult: { reason: conHerramientas ? "tool-calls" : "stop" },
      output: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      metadata: informe ? { providerMetadata: { bivelio: { savingsReport: informe } } } : {},
      messages: { all: [], user: [], nonUser: [] },
    },
  });
  return trozos;
}

const PLAZO_POR_DEFECTO_MS = 15 * 60 * 1000;

/**
 * The savings layer as a Mastra input processor:
 * `new Agent({ ..., inputProcessors: [..., savingsProcessor({ licenseKey })] })`,
 * last in the list, so nothing sits between it and the model.
 */
export function savingsProcessor(options: SavingsProcessorOptions): SavingsProcessor {
  const capa = crearCapaDelAdaptador("mastra", options);
  const plazoMs = Math.max(1, options.providerTimeoutMs ?? PLAZO_POR_DEFECTO_MS);
  const pendientes = new Map<string, Pendiente>();
  let contador = 0;

  const abandonar = (token: string, motivo: unknown): void => {
    const p = pendientes.get(token);
    if (!p) return;
    pendientes.delete(token);
    clearTimeout(p.plazo);
    if (p.signal && p.alAbortar) p.signal.removeEventListener("abort", p.alAbortar);
    p.llamada.errorDelMarco = { error: motivo };
    p.rechazar(motivo);
  };

  const procesador = {
    id: "bivelio-savings" as const,
    name: "BiVelio savings",

    processInputStep(args: Registro) {
      const state = args.state as Registro;
      state[CLAVE_PASO] = datosDelPaso(args);
      if (typeof args.messageId === "string") state["bivelio.messageId"] = args.messageId;
      return undefined;
    },

    async processLLMRequest(args: Registro) {
      const state = args.state as Registro;
      const model = (esRegistro(args.model) ? args.model : {}) as { provider?: unknown; modelId?: unknown };
      const paso = typeof args.stepNumber === "number" ? args.stepNumber : -1;
      const guardados = state[CLAVE_PASO] as DatosDelPaso | undefined;
      // Sin lo que guardó `processInputStep` para ESTE paso no se sabe qué
      // herramientas ve el modelo (ni si alguna tiene efectos): solo se mide.
      const datos = guardados && guardados.paso === paso ? guardados : undefined;
      const modeloDeInforme = options.modelId
        ? options.modelId({ provider: String(model.provider ?? ""), modelId: String(model.modelId ?? "") })
        : modeloPorDefecto(model);
      const tools: ToolDescriptor[] = (datos?.herramientas ?? []).map((h) =>
        herramienta(options, {
          nombre: h.nombre,
          descripcion: h.descripcion,
          parametros: h.parametros,
          delProveedor: h.delProveedor,
        }),
      );
      const ajustesDelModelo = esRegistro(datos?.modelSettings) ? datos.modelSettings : {};
      const porLlamada = opcionesDeLlamada(esRegistro(datos?.providerOptions) ? datos.providerOptions.bivelio : undefined);
      const eleccion = datos?.toolChoice;
      const forzada = eleccion === "required" || (esRegistro(eleccion) && (eleccion.type === "tool" || eleccion.type === "required"));
      const req: SavingsRequest = await construirPeticion(options, {
        model: modeloDeInforme,
        messages: renderizarPrompt(args.prompt),
        tools,
        temperature: typeof ajustesDelModelo.temperature === "number" ? ajustesDelModelo.temperature : undefined,
        seed: typeof ajustesDelModelo.seed === "number" ? ajustesDelModelo.seed : undefined,
        context: fusionarContexto(options.context?.({ requestContext: args.requestContext }), porLlamada.context),
        // Nunca se comparte una petición en vuelo (ver la cabecera).
        savings: { ...porLlamada.savings, singleflight: false },
        proyeccion: {
          modelo: modeloDeInforme,
          prompt: proyectarPrompt(args.prompt),
          herramientas: datos?.herramientas ?? null,
          toolChoice: datos?.toolChoice,
          activeTools: datos?.activeTools,
          providerOptions: sinOpcionesAjenas(datos?.providerOptions),
          ajustes: ajustes(datos?.modelSettings),
          salidaEstructurada: datos?.salidaEstructurada,
        },
        restricciones: {
          sinResolvers: datos === undefined || forzada || datos.salidaEstructurada !== undefined,
          sinReutilizar: datos === undefined || datos.esquemaIlegible,
        },
      });

      // El proveedor DIFERIDO: cuando la capa decide llamar, el puente devuelve
      // una promesa que resolverá `processLLMResponse` con lo que contestó el
      // modelo que llamó Mastra.
      let resolver!: (r: ProviderResponse) => void;
      let rechazar!: (e: unknown) => void;
      const diferida = new Promise<ProviderResponse>((res, rej) => {
        resolver = res;
        rechazar = rej;
      });
      let alInvocar!: () => void;
      const invocada = new Promise<"invocada">((r) => {
        alInvocar = () => r("invocada");
      });
      const llamada = nuevaLlamada(
        { model: req.model, messages: req.messages, ...(req.tools ? { tools: req.tools } : {}) },
        () => {
          alInvocar();
          return diferida;
        },
      );
      const resultado = capa.ejecutar(req, llamada);
      resultado.catch(() => {});

      const gano = await Promise.race([invocada, resultado.then(() => "resuelta" as const)]);
      if (gano === "resuelta") {
        const r = await resultado;
        const informe = capa.informe(r.report);
        return { response: { chunks: trozosDeAtajo(r, informe, state["bivelio.messageId"]) } };
      }

      const token = `bvsala-${++contador}-${Date.now().toString(36)}`;
      const plazo = setTimeout(
        () => abandonar(token, new Error("[bvsala] Mastra never reported this model call back; nothing was recorded.")),
        plazoMs,
      );
      (plazo as { unref?: () => void }).unref?.();
      const pendiente: Pendiente = { resolver, rechazar, llamada, resultado, plazo };
      const signal = args.abortSignal instanceof AbortSignal ? args.abortSignal : undefined;
      if (signal) {
        pendiente.signal = signal;
        pendiente.alAbortar = () => abandonar(token, new Error("[bvsala] the model call was aborted; nothing was recorded."));
        if (signal.aborted) pendiente.alAbortar();
        else signal.addEventListener("abort", pendiente.alAbortar, { once: true });
      }
      pendientes.set(token, pendiente);
      state[CLAVE_PENDIENTE] = token;
      return undefined;
    },

    async processLLMResponse(args: Registro) {
      if (args.fromCache === true) return;
      const state = args.state as Registro;
      const token = state[CLAVE_PENDIENTE];
      delete state[CLAVE_PENDIENTE];
      if (typeof token !== "string") return;
      const p = pendientes.get(token);
      if (!p) return;
      pendientes.delete(token);
      clearTimeout(p.plazo);
      if (p.signal && p.alAbortar) p.signal.removeEventListener("abort", p.alAbortar);
      const model = (esRegistro(args.model) ? args.model : {}) as { provider?: unknown };
      const r = respuestaDeTrozos(Array.isArray(args.chunks) ? args.chunks : [], esModeloSimulado(model));
      if ("error" in r) {
        // El modelo falló: la capa no registra nada.
        p.llamada.errorDelMarco = { error: r.error };
        p.rechazar(r.error);
        return;
      }
      p.llamada.completada = true;
      p.resolver(r);
      try {
        const resultado = await p.resultado;
        const informe = capa.informe(resultado.report);
        if (options.emitReportPart === true) {
          const writer = args.writer as { custom?: (d: { type: string; data: unknown }) => Promise<void> } | undefined;
          await writer?.custom?.({ type: "data-bivelio-savings-report", data: informe });
        }
      } catch {
        capa.avisar(
          "sin-informe",
          "[bvsala] the model answered, but the savings layer failed while accounting for it; the answer is " +
            "unchanged, without a savings report and without a usage record.",
        );
      }
    },

    processAPIError(args: Registro) {
      const state = args.state as Registro;
      const token = state[CLAVE_PENDIENTE];
      if (typeof token === "string") {
        delete state[CLAVE_PENDIENTE];
        abandonar(token, args.error ?? new Error("[bvsala] the model call failed"));
      }
      return undefined;
    },

    close(): void {
      for (const token of [...pendientes.keys()]) {
        abandonar(token, new Error("[bvsala] the savings layer was closed; nothing was recorded."));
      }
      capa.close();
    },
  };
  return procesador as unknown as SavingsProcessor;
}
