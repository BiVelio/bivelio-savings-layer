import type { LanguageModelMiddleware } from "ai";
import type {
  ProviderStreamEvent,
  RequestContext,
  SavingsAdapterOptions,
  SavingsReport,
  SavingsRequest,
  SavingsResult,
} from "@bivelio/savings-layer";
import { crearCapaDelAdaptador, promesaDeApertura, type CapaDelAdaptador, type LlamadaEnStream } from "./comun/capa.js";
import { Cola } from "./comun/cola.js";
import {
  conInforme,
  contenidoDeAtajo,
  esModeloSimulado,
  modeloPorDefecto,
  motivoDeAtajo,
  partesDeContenido,
  pideFormaEstricta,
  proyectarParametros,
  renderizarPrompt,
  RespuestaAiSdk,
  respuestaDeGenerate,
  streamDe,
  USO_CERO,
} from "./comun/prompt-ai-sdk.js";
import { construirPeticion, fusionarContexto, herramienta, opcionesDeLlamada } from "./comun/peticion.js";
import { nuevaLlamada, registrarDesenlace } from "./comun/puente.js";

// EL ADAPTADOR DEL VERCEL AI SDK (`ai` 6 y 7): un `LanguageModelMiddleware`.
//
// Un único objeto con `specificationVersion: "v3"` funciona con los dos: el AI
// SDK 6 lo exige así y el 7 acepta cualquier versión en el middleware. El
// formato de prompt, contenido y partes de stream es el mismo en V3 y V4 para
// todo lo que este adaptador lee.
//
// Lo que hace, en una frase: antes de llamar al modelo, pregunta a la capa si
// puede contestar sin llamar; si no, llama al modelo EXACTAMENTE como lo iba a
// llamar el framework y mide la respuesta con el contador del proveedor. Nunca
// reescribe los parámetros.

/** Options for {@link savingsMiddleware}. */
export interface SavingsMiddlewareOptions extends SavingsAdapterOptions {
  /**
   * Cache identity for a call (tenant, session…). `providerOptions.bivelio.context`
   * on the call wins over it, key by key.
   */
  context?: (call: { provider: string; modelId: string; params: unknown }) => RequestContext | undefined;
  /**
   * The model id the report is priced with. Default: `<provider>/<modelId>`, with
   * the provider's first segment (`openai.responses` gives `openai/...`); a model
   * id that already contains "/" is kept as it is.
   */
  modelId?: (model: { provider: string; modelId: string }) => string;
  /** Put the report in `providerMetadata.bivelio.savingsReport` (default true). */
  reportInMetadata?: boolean;
}

/** The middleware, plus `close()` to stop the layer's background work when shutting down. */
export type SavingsMiddleware = LanguageModelMiddleware & { close(): void };

type Registro = Record<string, unknown>;
type Modelo = { provider: string; modelId: string };
type ResultadoDeGenerate = Registro & { content?: unknown[]; providerMetadata?: unknown };
type ResultadoDeStream = Registro & { stream: ReadableStream<Registro> };

const AVISO_INFORME_DEL_STREAM =
  "[bvsala] a streamed call finished but its savings report could not be produced; the model answer " +
  "was delivered unchanged.";

/**
 * Wrap a model with the savings layer:
 * `wrapLanguageModel({ model, middleware: savingsMiddleware({ licenseKey }) })`.
 * Put it last in the middleware list, so nothing sits between it and the model.
 */
export function savingsMiddleware(options: SavingsMiddlewareOptions): SavingsMiddleware {
  const capa = crearCapaDelAdaptador("ai-sdk", options);
  const conMetadatos = options.reportInMetadata !== false;

  async function preparar(params: Registro, model: Modelo): Promise<{ req: SavingsRequest; simulado: boolean }> {
    const porLlamada = opcionesDeLlamada((params.providerOptions as Registro | undefined)?.bivelio);
    let delLlamante: RequestContext | undefined;
    if (options.context) delLlamante = options.context({ provider: model.provider, modelId: model.modelId, params });
    const modelo = options.modelId ? options.modelId({ provider: model.provider, modelId: model.modelId }) : modeloPorDefecto(model);
    const tools = (Array.isArray(params.tools) ? params.tools : []).map((t: Registro) =>
      herramienta(options, {
        nombre: String(t.name ?? t.id ?? ""),
        descripcion: typeof t.description === "string" ? t.description : undefined,
        parametros: t.inputSchema ?? t.parameters,
        delProveedor: t.type === "provider" || t.type === "provider-defined",
      }),
    );
    const req = await construirPeticion(options, {
      model: modelo,
      messages: renderizarPrompt(params.prompt),
      tools,
      temperature: typeof params.temperature === "number" ? params.temperature : undefined,
      seed: typeof params.seed === "number" ? params.seed : undefined,
      context: fusionarContexto(delLlamante, porLlamada.context),
      savings: porLlamada.savings,
      proyeccion: { modelo, parametros: proyectarParametros(params) },
      restricciones: { sinResolvers: pideFormaEstricta(params) },
    });
    return { req, simulado: esModeloSimulado(model) };
  }

  function renderizado(req: SavingsRequest) {
    return { model: req.model, messages: req.messages, ...(req.tools ? { tools: req.tools } : {}) };
  }

  const middleware = {
    specificationVersion: "v3",

    async wrapGenerate(o: { doGenerate: () => PromiseLike<ResultadoDeGenerate>; params: Registro; model: Modelo }) {
      const { req, simulado } = await preparar(o.params, o.model);
      let original: ResultadoDeGenerate | undefined;
      const llamada = nuevaLlamada(renderizado(req), async () => {
        original = await registrarDesenlace(llamada, () => o.doGenerate());
        return respuestaDeGenerate(original, simulado);
      });
      const d = await capa.generar(req, llamada);
      if (d.tipo === "sin-informe") return original as ResultadoDeGenerate;
      const informe = capa.informe(d.result.report);
      if (d.tipo === "vivo") {
        const r = original as ResultadoDeGenerate;
        return conMetadatos ? { ...r, providerMetadata: conInforme(r.providerMetadata, informe) } : r;
      }
      return generateDeAtajo(d.result, conMetadatos ? informe : undefined, o.model);
    },

    async wrapStream(o: {
      doStream: () => PromiseLike<ResultadoDeStream>;
      doGenerate: () => PromiseLike<ResultadoDeGenerate>;
      params: Registro;
      model: Modelo;
    }) {
      const { req, simulado } = await preparar(o.params, o.model);
      const { abierta, abrir } = promesaDeApertura();
      let entero: ResultadoDeGenerate | undefined;
      let abierto: ResultadoDeStream | undefined;
      const llamada: LlamadaEnStream = Object.assign(
        nuevaLlamada(
          renderizado(req),
          // El camino de último recurso del núcleo llama al proveedor ENTERO.
          async () => {
            entero = await registrarDesenlace(llamada, () => o.doGenerate());
            return respuestaDeGenerate(entero, simulado);
          },
          () => {
            const cola = new Cola<ProviderStreamEvent>();
            void registrarDesenlace(llamada, () => o.doStream()).then(
              (r) => {
                abierto = { ...r, stream: observar(r.stream, cola, capa, llamada, simulado, conMetadatos) };
                abrir();
              },
              (err: unknown) => cola.fail(err),
            );
            return cola;
          },
        ),
        { abierta },
      );
      // `completada` la pone `registrarDesenlace` al ABRIR el stream; que el
      // stream termine bien lo decide el observador.
      const signal = o.params.abortSignal instanceof AbortSignal ? o.params.abortSignal : undefined;
      const d = await capa.transmitir(req, llamada, signal);
      if (d.tipo === "abierto") return abierto as ResultadoDeStream;
      if (d.tipo === "sin-informe") return streamDeGenerate(entero as ResultadoDeGenerate, undefined);
      const informe = capa.informe(d.result.report);
      if (d.tipo === "entero") return streamDeGenerate(entero as ResultadoDeGenerate, conMetadatos ? informe : undefined);
      return streamDeAtajo(d.result, conMetadatos ? informe : undefined, o.model);
    },

    close(): void {
      capa.close();
    },
  };
  return middleware as unknown as SavingsMiddleware;
}

// ─── El observador del stream en vivo ───────────────────────────────────────
//
// Reenvía TODAS las partes, en su orden y sin tocarlas (razonamiento,
// `tool-input-*`, `raw`, errores…), y alimenta la cola del puente con el texto y
// las llamadas a herramienta. Solo retiene la parte `finish`: PRIMERO entrega a
// la capa la respuesta completa y DESPUÉS espera su informe para reemitir
// `finish` con él. En ese orden no hay interbloqueo: la capa no espera nada del
// lector para cerrar.
//
// Es un ReadableStream propio y no un `pipeThrough`, para enterarse de que el
// lector cancela: entonces la cancelación sube al modelo y la capa descarta la
// llamada (no hay contador final que medir).
function observar(
  origen: ReadableStream<Registro>,
  cola: Cola<ProviderStreamEvent>,
  capa: CapaDelAdaptador,
  llamada: LlamadaEnStream,
  simulado: boolean,
  conMetadatos: boolean,
): ReadableStream<Registro> {
  const lector = origen.getReader();
  const acc = new RespuestaAiSdk();
  return new ReadableStream<Registro>({
    async pull(controller) {
      let leido: { done: boolean; value?: Registro };
      try {
        leido = await lector.read();
      } catch (err) {
        cola.fail(err);
        controller.error(err);
        return;
      }
      if (leido.done) {
        cola.fail(new Error("[bvsala] the model stream ended without a finish part; nothing was measured."));
        controller.close();
        return;
      }
      const parte = leido.value as Registro;
      const delta = acc.anadir(parte);
      if (parte.type === "error") {
        // El proveedor falló a mitad: la capa no registra nada. El lector recibe
        // la parte tal cual, y lo que venga después también.
        cola.fail(parte.error ?? new Error("[bvsala] the model stream reported an error"));
        controller.enqueue(parte);
        return;
      }
      if (delta !== undefined) cola.push({ type: "text", delta });
      if (parte.type !== "finish" || cola.cerrada) {
        controller.enqueue(parte);
        return;
      }
      cola.push({ type: "done", response: acc.respuesta(parte.usage, parte.finishReason, simulado) });
      cola.end();
      let final = parte;
      try {
        const r = await (llamada.resultado as Promise<SavingsResult>);
        const informe = capa.informe(r.report);
        if (conMetadatos) final = { ...parte, providerMetadata: conInforme(parte.providerMetadata, informe) };
      } catch {
        capa.avisar("informe-del-stream", AVISO_INFORME_DEL_STREAM);
      }
      controller.enqueue(final);
    },
    cancel(motivo) {
      cola.fail(new Error("[bvsala] the stream was cancelled by its reader; nothing was measured."));
      return lector.cancel(motivo);
    },
  });
}

// ─── Lo que no pasó por el stream del modelo ────────────────────────────────

function generateDeAtajo(result: SavingsResult, informe: SavingsReport | undefined, model: Modelo): ResultadoDeGenerate {
  return {
    content: contenidoDeAtajo(result),
    finishReason: motivoDeAtajo(result),
    usage: USO_CERO,
    ...(informe ? { providerMetadata: conInforme(undefined, informe) } : {}),
    response: { id: `bvsala-${result.requestId}`, modelId: model.modelId, timestamp: new Date() },
    warnings: [],
  };
}

function streamDeAtajo(result: SavingsResult, informe: SavingsReport | undefined, model: Modelo): ResultadoDeStream {
  const partes = partesDeContenido(
    contenidoDeAtajo(result),
    {
      usage: USO_CERO,
      finishReason: motivoDeAtajo(result),
      ...(informe ? { providerMetadata: conInforme(undefined, informe) } : {}),
    },
    { warnings: [], response: { id: `bvsala-${result.requestId}`, modelId: model.modelId, timestamp: new Date() } },
  );
  return { stream: streamDe(partes) };
}

// El camino de último recurso del núcleo llamó al modelo ENTERO: se entrega su
// resultado completo, parte a parte, con el informe si lo hay.
function streamDeGenerate(r: ResultadoDeGenerate, informe: SavingsReport | undefined): ResultadoDeStream {
  const respuesta = r.response as Registro | undefined;
  const partes = partesDeContenido(
    Array.isArray(r.content) ? r.content : [],
    {
      usage: r.usage,
      finishReason: r.finishReason,
      ...(informe
        ? { providerMetadata: conInforme(r.providerMetadata, informe) }
        : r.providerMetadata !== undefined
          ? { providerMetadata: r.providerMetadata }
          : {}),
    },
    {
      warnings: r.warnings,
      response: respuesta
        ? Object.fromEntries(Object.entries(respuesta).filter(([k]) => k !== "headers" && k !== "body"))
        : undefined,
    },
  );
  return {
    stream: streamDe(partes),
    ...(r.request !== undefined ? { request: r.request } : {}),
    ...(respuesta?.headers !== undefined ? { response: { headers: respuesta.headers } } : {}),
  };
}

/**
 * The savings report of a call, read from a `generateText` result or step, or
 * from `{ providerMetadata: await result.providerMetadata }` for a stream.
 * `undefined` when the call carried none (for instance `reportInMetadata: false`).
 */
export function getSavingsReport(source: { providerMetadata?: unknown } | null | undefined): SavingsReport | undefined {
  const bivelio = (source?.providerMetadata as Registro | undefined)?.bivelio as Registro | undefined;
  const informe = bivelio?.savingsReport as Registro | undefined;
  if (!informe || typeof informe !== "object" || typeof informe.requestId !== "string") return undefined;
  return informe as unknown as SavingsReport;
}
