import { AsyncLocalStorage } from "node:async_hooks";
import { stableStringify } from "@bivelio/savings-layer";
import type {
  ChatMessage,
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ToolDescriptor,
} from "@bivelio/savings-layer";

// EL PROVEEDOR PUENTE.
//
// El adaptador crea la capa con `createSavingsLayer({ …, provider: puente })`.
// Cuando el núcleo decide que hay que llamar al modelo, lo que se ejecuta es la
// LLAMADA ORIGINAL DEL FRAMEWORK que está en curso, con sus parámetros intactos:
// el puente la encuentra en un `AsyncLocalStorage`, porque una misma capa sirve
// llamadas concurrentes y cada una tiene que ejecutar la suya.
//
// Con singleflight también funciona: el líder llama en su propio contexto y el
// seguidor nunca llega aquí.
//
// Dos invariantes, los dos comprobados ANTES de gastar:
//   R1 · Fidelidad. Lo que llega al puente tiene que ser exactamente lo que
//        renderizó el adaptador (modelo, mensajes y herramientas). El adaptador
//        fuerza apagadas todas las palancas que reescriben, así que esto no
//        debería fallar nunca; si falla, la capa cambió algo que el adaptador no
//        va a reenviar, y el informe mediría una petición que no se hizo. Se
//        lanza sin llamar.
//   R2 · Una sola llamada. El puente admite UNA llamada al framework por
//        petición de la capa. La segunda lanza sin llamar: una segunda llamada
//        sería gasto del cliente que el adaptador no le ha pedido nadie.

export const ERROR_REESCRITA =
  "[bvsala] internal: the layer changed a request this adapter must forward unchanged; nothing was sent.";
export const ERROR_SEGUNDA =
  "[bvsala] internal: the layer asked for a second model call within one framework call; nothing more was sent.";
export const ERROR_SIN_LLAMADA =
  "[bvsala] internal: the layer called the model outside a framework call; nothing was sent.";

/** Lo que el adaptador renderizó para la capa. */
export interface Renderizado {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDescriptor[];
}

/**
 * Una llamada del framework en curso. La crea el adaptador; el puente la
 * ejecuta como mucho una vez.
 */
export interface LlamadaDelMarco {
  readonly renderizado: Renderizado;
  /** Ejecuta la llamada original del framework, sin tocarla, y la traduce. */
  generar(signal?: AbortSignal): Promise<ProviderResponse>;
  /** La variante en stream, cuando la llamada del framework es un stream. */
  transmitir?(signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
  /** El puente ya entregó la llamada al framework. */
  invocada: boolean;
  /** La llamada del framework terminó bien (su resultado está en el adaptador). */
  completada: boolean;
  /** Lo que lanzó el framework, para devolvérselo al llamante tal cual. */
  errorDelMarco?: { error: unknown };
}

export function nuevaLlamada(
  renderizado: Renderizado,
  generar: LlamadaDelMarco["generar"],
  transmitir?: LlamadaDelMarco["transmitir"],
): LlamadaDelMarco {
  return {
    renderizado,
    generar,
    ...(transmitir ? { transmitir } : {}),
    invocada: false,
    completada: false,
  };
}

/**
 * Envuelve la llamada al framework para que la llamada sepa si terminó bien o
 * qué lanzó. Es lo que permite, después, distinguir un error del framework (que
 * se le devuelve al llamante tal cual) de uno de la capa.
 */
export async function registrarDesenlace<T>(llamada: LlamadaDelMarco, llamar: () => PromiseLike<T>): Promise<T> {
  try {
    const r = await llamar();
    llamada.completada = true;
    return r;
  } catch (error) {
    llamada.errorDelMarco = { error };
    throw error;
  }
}

function iguales(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return stableStringify(a) === stableStringify(b);
  } catch {
    return false;
  }
}

function listasIguales<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => iguales(v, y[i]));
}

// Solo lo que el framework va a mandar. `stablePrefixMessages`,
// `promptCacheKey` y `constraintBackend` son PISTAS para un proveedor propio, no
// contenido; `temperature` y `seed` salen de los parámetros del framework y el
// núcleo no los reescribe.
function fiel(req: ProviderRequest, r: Renderizado): boolean {
  return req.model === r.model && listasIguales(req.messages, r.messages) && listasIguales(req.tools, r.tools);
}

export function crearPuente(marco: string, als: AsyncLocalStorage<LlamadaDelMarco>): Provider {
  const tomar = (req: ProviderRequest): LlamadaDelMarco => {
    const llamada = als.getStore();
    if (!llamada) throw new Error(ERROR_SIN_LLAMADA);
    if (llamada.invocada) throw new Error(ERROR_SEGUNDA);
    if (!fiel(req, llamada.renderizado)) throw new Error(ERROR_REESCRITA);
    llamada.invocada = true;
    return llamada;
  };
  return {
    id: `bivelio-adapter:${marco}`,
    async generate(req, options) {
      return tomar(req).generar(options?.signal);
    },
    async *generateStream(req, options) {
      const llamada = tomar(req);
      if (llamada.transmitir) {
        yield* llamada.transmitir(options?.signal);
        return;
      }
      // Una llamada que no es un stream en el framework: se entrega entera.
      const r = await llamada.generar(options?.signal);
      if (r.text !== "") yield { type: "text", delta: r.text };
      yield { type: "done", response: r };
    },
  };
}

export function crearAlmacen(): AsyncLocalStorage<LlamadaDelMarco> {
  return new AsyncLocalStorage<LlamadaDelMarco>();
}
