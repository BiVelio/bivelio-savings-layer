import type {
  SavingsRequest,
  SavingsResult,
  SavingsStream,
  SavingsStreamOptions,
} from "../contracts/types.js";
import type { SavingsLayer } from "../pipeline/create.js";
import { StreamAbortedError } from "../pipeline/errors.js";
import { BV_SALA_VERSION } from "../version.js";
import {
  CLAVE_REQUEST_SENT,
  ERROR_TYPE,
  GEN_AI,
  atributosGenAiDelInforme,
  savingsSpanAttributes,
} from "./atributos.js";
import { proveedorOtel, sinPrefijoConocido } from "./proveedor.js";
import type {
  SavingsAttributeOptions,
  SavingsReportForExport,
  SavingsSpanAttributes,
  SavingsSpanOptions,
  SavingsTracingOptions,
  SpanLike,
  TracerLike,
  TracerProviderLike,
} from "./tipos.js";

// Los valores numéricos de los enums de @opentelemetry/api, copiados para no
// importarlo (D1). test/exportador-otel.test.ts los compara con el paquete real.
export const SPAN_KIND_CLIENT = 2;
export const SPAN_STATUS_ERROR = 2;

// El scope de instrumentación con que se pide el tracer a un TracerProvider.
export const NOMBRE_DEL_SCOPE = "@bivelio/savings-layer";

/**
 * Write the savings figures of one report on a span you already have (for
 * example `trace.getActiveSpan()`), as `com.bivelio.*` attributes. It does not
 * end the span, never throws and does nothing on a span that is not recording.
 *
 * It writes no `gen_ai.*` attribute unless `genAi: true`, and then only the
 * usage and `gen_ai.response.model`. Tools that key on `gen_ai.*` (Datadog LLM
 * Observability drops spans without one) need the span from
 * {@link instrumentSavingsLayer} instead.
 */
export function recordSavingsOnSpan(
  span: SpanLike,
  report: SavingsReportForExport,
  options?: SavingsSpanOptions,
): void {
  try {
    if (span.isRecording?.() === false) return;
    const a = savingsSpanAttributes(report, options);
    if (options?.genAi) Object.assign(a, atributosGenAiDelInforme(report));
    span.setAttributes(a);
  } catch {
    // Fail-open: la telemetría nunca rompe al llamante.
  }
}

function esFuncion(x: unknown): x is (...args: never[]) => unknown {
  return typeof x === "function";
}

function resolverTracer(tracer: TracerLike | TracerProviderLike | undefined): TracerLike {
  const t = tracer as Partial<TracerLike & TracerProviderLike> | undefined;
  if (t && esFuncion(t.startActiveSpan)) return t as TracerLike;
  if (t && esFuncion(t.getTracer)) {
    const obtenido = (t as TracerProviderLike).getTracer(NOMBRE_DEL_SCOPE, BV_SALA_VERSION) as
      | Partial<TracerLike>
      | undefined;
    if (obtenido && esFuncion(obtenido.startActiveSpan)) return obtenido as TracerLike;
  }
  throw new TypeError(
    "[bvsala] instrumentSavingsLayer: `tracer` must be an OpenTelemetry Tracer, a TracerProvider " +
      "or the `trace` object of the OpenTelemetry API",
  );
}

// El nombre de un error solo sale si PARECE un nombre de clase: un proveedor
// puede meter cualquier cosa en un error, y nada de contenido sale de aquí.
function tipoDeError(err: unknown): string {
  const nombre = (err as { name?: unknown } | null | undefined)?.name;
  return typeof nombre === "string" && /^[A-Za-z_$][\w$.-]{0,127}$/.test(nombre) ? nombre : "_OTHER";
}

function atributosDePeticion(
  request: SavingsRequest,
  stream: boolean,
  providerName: string | undefined,
): SavingsSpanAttributes {
  const a: SavingsSpanAttributes = { [GEN_AI.operacion]: "chat" };
  const proveedor = providerName ?? proveedorOtel(request.model);
  if (typeof proveedor === "string" && proveedor !== "") a[GEN_AI.proveedor] = proveedor;
  a[GEN_AI.modeloPedido] = sinPrefijoConocido(request.model);
  const numero = (clave: string, v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) a[clave] = v;
  };
  numero(GEN_AI.temperatura, request.temperature);
  numero(GEN_AI.semilla, request.seed);
  numero(GEN_AI.maxTokens, request.response?.maxOutputTokens);
  if (stream) a[GEN_AI.stream] = true;
  const sesion = request.context?.sessionId;
  if (typeof sesion === "string" && sesion !== "") a[GEN_AI.conversacion] = sesion;
  return a;
}

function cerrarConResultado(
  span: SpanLike,
  result: SavingsResult<unknown>,
  opciones: SavingsAttributeOptions,
): void {
  try {
    if (span.isRecording?.() !== false) {
      const report = result.report;
      const a: SavingsSpanAttributes = {
        ...atributosGenAiDelInforme(report),
        ...savingsSpanAttributes(report, opciones),
      };
      if (typeof result.finishReason === "string" && result.finishReason !== "") {
        a[GEN_AI.motivosDeFin] = [result.finishReason];
      }
      const s = report.streaming;
      if (s?.delivery === "live" && typeof s.firstEventMs === "number" && Number.isFinite(s.firstEventMs)) {
        a[GEN_AI.primerTrozo] = s.firstEventMs / 1000;
      }
      span.setAttributes(a);
    }
  } catch {
    // Fail-open.
  } finally {
    try {
      span.end();
    } catch {
      // Fail-open.
    }
  }
}

function cerrarConError(span: SpanLike, err: unknown): void {
  try {
    if (span.isRecording?.() !== false) {
      // SIN mensaje y sin recordException: el mensaje de un error del proveedor
      // puede repetir el prompt o la respuesta.
      const a: SavingsSpanAttributes = { [ERROR_TYPE]: tipoDeError(err) };
      // Un stream abortado con la petición ya enviada: el proveedor puede
      // facturar tokens que no aparecen en ningún informe. Se dice.
      if (err instanceof StreamAbortedError) a[CLAVE_REQUEST_SENT] = err.requestSent;
      span.setAttributes(a);
      span.setStatus?.({ code: SPAN_STATUS_ERROR });
    }
  } catch {
    // Fail-open.
  } finally {
    try {
      span.end();
    } catch {
      // Fail-open.
    }
  }
}

/**
 * Returns a SavingsLayer that opens one OpenTelemetry span per request, with
 * the same results and the same errors: `generate()` resolves to the very
 * result object, `generateStream()` returns the very stream.
 *
 * The span is named `chat {model}`, has kind CLIENT and is active while the
 * request runs, so HTTP spans of your provider call nest under it. It carries
 * the GenAI semantic conventions (as published in OpenTelemetry semantic
 * conventions v1.41.1: operation, provider, request model and parameters,
 * response model, usage) and the `com.bivelio.*` savings attributes of
 * {@link savingsSpanAttributes}. An avoided call is still a span, with zero
 * usage: no token was billed.
 *
 * Nothing is sent anywhere by this function: spans go to the exporters you
 * configured in your OpenTelemetry SDK. No prompt, answer, tool argument or
 * error message is written; a failed request records only `error.type`.
 *
 * Telemetry never changes a request: if the tracer fails, the request runs
 * without a span. An invalid `tracer` throws a TypeError here, at startup.
 */
export function instrumentSavingsLayer(layer: SavingsLayer, options: SavingsTracingOptions): SavingsLayer {
  const tracer = resolverTracer(options?.tracer);
  if (options.currency !== undefined && !/^[A-Z]{3}$/.test(options.currency)) {
    throw new TypeError(
      `[bvsala] instrumentSavingsLayer: currency must be an ISO 4217 code such as "USD" (got "${options.currency}")`,
    );
  }
  const opciones: SavingsAttributeOptions = {
    ...(options.currency !== undefined ? { currency: options.currency } : {}),
    ...(options.langfuse ? { langfuse: options.langfuse } : {}),
    ...(options.datadog ? { datadog: options.datadog } : {}),
  };
  const providerName = options.providerName;

  // Arranca el span y ejecuta `ejecutar` dentro. Garantías:
  //  · la capa se llama UNA vez: si el tracer falla antes de llamar a la
  //    función, se llama sin span; si falla después, se devuelve lo que ya se
  //    obtuvo; si llama a la función dos veces, la segunda no repite la petición;
  //    y si la llama TARDE (fuera de contrato, cuando ya se pidió sin span), ese
  //    span se cierra vacío y la petición tampoco se repite;
  //  · un error SÍNCRONO de la capa sale tal cual, y un fallo del tracer nunca.
  function conSpan<R>(
    request: SavingsRequest,
    stream: boolean,
    ejecutar: () => R,
    instrumentar: (span: SpanLike, r: R) => R,
  ): R {
    let hecho: { valor: R } | undefined;
    let lanzado: { error: unknown } | undefined;
    let sinSpan = false;
    let attributes: SavingsSpanAttributes | undefined;
    try {
      attributes = atributosDePeticion(request, stream, providerName);
    } catch {
      attributes = undefined;
    }
    const nombre = `chat ${sinPrefijoConocidoSeguro(request)}`;
    try {
      tracer.startActiveSpan(
        nombre,
        { kind: SPAN_KIND_CLIENT, ...(attributes ? { attributes } : {}) },
        (span: SpanLike) => {
          if (hecho) return hecho.valor;
          if (lanzado) throw lanzado.error;
          if (sinSpan) {
            try {
              span.end();
            } catch {
              // Fail-open.
            }
            return undefined as R;
          }
          let valor: R;
          try {
            valor = ejecutar();
          } catch (err) {
            lanzado = { error: err };
            cerrarConError(span, err);
            throw err;
          }
          try {
            hecho = { valor: instrumentar(span, valor) };
          } catch {
            // Instrumentar falló (una capa que no devuelve lo que declara): se
            // entrega lo obtenido, sin span, y la petición no se repite.
            hecho = { valor };
            try {
              span.end();
            } catch {
              // Fail-open.
            }
          }
          return hecho.valor;
        },
      );
    } catch {
      // O el tracer falló (se ignora), o relanzó el error de la capa (abajo).
    }
    if (lanzado) throw lanzado.error;
    if (hecho) return hecho.valor;
    sinSpan = true;
    return ejecutar();
  }

  return {
    // Los lotes pasan tal cual, sin span: no son una petición servida sino un
    // envío asíncrono, y su resultado no trae el informe que lee el span.
    batches: layer.batches,
    generate<T = unknown>(request: SavingsRequest): Promise<SavingsResult<T>> {
      return conSpan(
        request,
        false,
        () => layer.generate<T>(request),
        (span, promesa) =>
          promesa.then(
            (result) => {
              cerrarConResultado(span, result, opciones);
              return result;
            },
            (err: unknown) => {
              cerrarConError(span, err);
              throw err;
            },
          ),
      );
    },
    generateStream<T = unknown>(request: SavingsRequest, streamOptions?: SavingsStreamOptions): SavingsStream<T> {
      return conSpan(
        request,
        true,
        () => layer.generateStream<T>(request, streamOptions),
        (span, stream) => {
          // El span termina cuando termina `result`. La rama es propia: el
          // rechazo que ve el llamante es el de su `stream.result`, intacto.
          stream.result.then(
            (result) => cerrarConResultado(span, result, opciones),
            (err: unknown) => cerrarConError(span, err),
          );
          return stream;
        },
      );
    },
    close(): void {
      layer.close();
    },
  };
}

function sinPrefijoConocidoSeguro(request: SavingsRequest): string {
  try {
    return typeof request.model === "string" ? sinPrefijoConocido(request.model) : "";
  } catch {
    return "";
  }
}
