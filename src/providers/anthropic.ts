import { avisarUnaVez } from "../util/warn-once.js";
import { instruccionDeJsonPorPrompt } from "./json-por-prompt.js";
import { isStrictCompatible } from "./openai-compatible.js";
import type { Provider, ProviderRequest, ProviderResponse } from "./types.js";

/**
 * Anthropic Messages API adapter.
 *
 * Speaks `POST /v1/messages`: the system prompt travels in its own top-level
 * `system` field (not as a message), tools are `{name, description,
 * input_schema}` with no `function` wrapper, and prefix caching is requested
 * with EXPLICIT `cache_control` breakpoints — Anthropic does not cache on its
 * own. A cached read is billed at 0.1x the input rate, which is the largest
 * single lever on the input side of a customer's bill.
 *
 * Network calls use global `fetch` (Node >= 18) so there is no SDK dependency.
 */

/** Render order of the request, which is also the order the cache prefix grows in. */
// tools -> system -> messages. Un cambio en `tools` invalida TODO lo que va
// detrás, así que el conjunto de herramientas es la parte más frágil del
// prefijo, no la más barata. El pipeline lo sabe y por eso no reclama prefijo
// estable cuando el selector poda herramientas por petición.

export interface AnthropicOptions {
  apiKey?: string;
  /** Defaults to the public API. Override for a gateway or a proxy. */
  baseUrl?: string;
  /** Wire version pinned in the `anthropic-version` header. */
  apiVersion?: string;
  /** Extra headers (e.g. for a gateway). */
  headers?: Record<string, string>;
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
  /**
   * `max_tokens` is REQUIRED by this API — unlike the OpenAI shape, where it is
   * optional. A request without one is a 400, so the adapter has to supply a
   * value. It is deliberately generous: a low default would truncate answers
   * and the truncation would look like a model failure rather than an adapter
   * default.
   */
  defaultMaxOutputTokens?: number;
  /**
   * When true (recommended for measurement), a response whose `usage` block is
   * missing its counters is treated as a HARD ERROR instead of being coerced to
   * 0 tokens. An absent usage payload otherwise becomes `actual cost = 0` → a
   * fabricated 100% saving.
   */
  requireUsage?: boolean;
  /**
   * How many `cache_control` breakpoints the adapter may spend.
   *
   * The API caps them at 4 per request. The adapter never needs more than 2
   * (end of system, end of the stable message prefix) and the cap is exposed so
   * a gateway with a stricter limit can lower it. Raising it above 4 is
   * pointless: the extra breakpoints are rejected by the API, not ignored.
   */
  maxCacheBreakpoints?: number;
}

const TOPE_DE_PUNTOS_DE_RUPTURA = 4;

/** Nombre de la herramienta sintética que impone el contrato de salida. */
const HERRAMIENTA_DE_CONTRATO = "bvsala_contract";

interface BloqueDeTexto {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

interface MensajeAnthropic {
  role: "user" | "assistant";
  content: BloqueDeTexto[];
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  private readonly opts: AnthropicOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicOptions = {}) {
    this.opts = opts;
    this.id = `anthropic:${opts.baseUrl ?? "https://api.anthropic.com/v1"}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    const cuerpo = this.construirCuerpo(req);
    const base = (this.opts.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");

    const response = await this.fetchImpl(`${base}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": this.opts.apiVersion ?? "2023-06-01",
        ...(this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {}),
        ...this.opts.headers,
      },
      body: JSON.stringify(cuerpo.body),
    });

    if (!response.ok) {
      throw new Error(`provider ${response.status}: ${await safeText(response)}`);
    }
    return this.leer(response, req, cuerpo.contratoNativo);
  }

  // Traduce una `ProviderRequest` al dialecto de la API de Mensajes.
  //
  // Los comentarios de los metodos privados van en `//` a proposito: el JSDoc de
  // un `private` SI se emite a `dist/index.d.ts`, y ahi se publica en npm. Lo
  // que sigue es razonamiento interno, no contrato.
  //
  // Devuelve tambien si el contrato de salida viajo por la via NATIVA, porque de
  // eso depende que el informe pueda decir `constraints.backend:
  // "provider-native"` sin mentir.
  private construirCuerpo(req: ProviderRequest): {
    body: Record<string, unknown>;
    contratoNativo: boolean;
  } {
    const { system, messages, prefijoEnMensajes, prefijoEnSystem } = repartirMensajes(req);

    if (messages.length === 0) {
      // Sin un solo turno de usuario no hay petición: la API exige al menos un
      // mensaje y el primero tiene que ser `user`. Fallar aquí, en claro, es
      // mucho mejor que un 400 con el cuerpo crudo del proveedor.
      throw new Error(
        "anthropic: the request has no user/assistant message. The Messages API needs at " +
          "least one, and system prompts travel in the `system` field — they do not count.",
      );
    }

    const tools: Record<string, unknown>[] = (req.tools ?? []).map((t) => ({
      name: t.id,
      ...(t.description ? { description: t.description } : {}),
      input_schema: t.parameters ?? { type: "object", properties: {} },
    }));

    // --- Contrato de salida ---------------------------------------------------
    // El idiolecto de Anthropic para "devuélveme esta forma" es una llamada a
    // herramienta FORZADA cuyo `input_schema` es el contrato. Con `strict: true`
    // el proveedor garantiza que `input` valida; sin él solo guía.
    //
    // Pero si el llamante trae SUS herramientas, forzar la nuestra le quita al
    // modelo la posibilidad de invocarlas, y el turno de herramientas es
    // precisamente lo que la capa promete no romper. En ese caso el esquema
    // viaja por prompt y se declara `structuredNatively: false`: el layer sigue
    // validando, pero la garantía es suya, no del proveedor.
    let contratoNativo = false;
    if (req.schema) {
      if (tools.length > 0) {
        system.push({ type: "text", text: instruccionDeJsonPorPrompt(req.schema) });
        avisarUnaVez(
          "anthropic-contrato-con-herramientas",
          "[bvsala] La petición lleva herramientas del llamante Y un contrato de salida. En la API " +
            "de Anthropic la forma se impone forzando una llamada a herramienta, y forzarla dejaría " +
            "al modelo sin poder invocar las tuyas. Se envía el esquema por prompt: el layer valida " +
            'igual, pero la garantía la da el layer, no el proveedor (`constraints.backend: "none"`).',
        );
      } else {
        const strict = isStrictCompatible(req.schema);
        if (!strict) {
          avisarUnaVez(
            "anthropic-strict-incompatible",
            "[bvsala] El contrato de respuesta no cumple el modo `strict` (en strict, `required` debe " +
              "listar TODAS las claves de `properties`, y todo objeto necesita " +
              "`additionalProperties: false`). Se envía el esquema sin `strict`: el modelo sigue " +
              "guiado y el layer sigue validando, pero la garantía la da el layer, no el proveedor.",
          );
        }
        tools.push({
          name: HERRAMIENTA_DE_CONTRATO,
          description: "Return the final answer in the required shape.",
          input_schema: req.schema,
          ...(strict ? { strict: true } : {}),
        });
        contratoNativo = strict;
      }
    }

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? this.opts.defaultMaxOutputTokens ?? 4096,
      messages,
    };
    if (system.length > 0) body["system"] = system;
    if (req.temperature != null) body["temperature"] = req.temperature;
    if (tools.length > 0) body["tools"] = tools;
    if (contratoNativo) {
      body["tool_choice"] = { type: "tool", name: HERRAMIENTA_DE_CONTRATO };
    }
    // `seed` NO existe en esta API. Se omite en silencio a propósito: mandarlo
    // sería un 400 por un campo que el llamante puso para otro proveedor, y
    // fallar por eso convertiría una petición portable en una avería.

    this.marcarCache(req, system, messages, prefijoEnMensajes, prefijoEnSystem);

    return { body, contratoNativo };
  }

  // Coloca los puntos de ruptura de cache.
  //
  // Anthropic NO cachea sola: sin un `cache_control` explicito el descuento del
  // 90% no existe, por muy estable que sea el prompt. Y como el emparejamiento
  // es por PREFIJO, el punto de ruptura marca hasta donde se puede reutilizar:
  // todo lo que va detras se paga entero.
  //
  // Se gastan como mucho DOS de los cuatro que permite la API:
  //
  //   1. al final de `system`, que por el orden de renderizado
  //      (tools -> system -> messages) cachea TAMBIEN las herramientas;
  //   2. al final del prefijo estable de mensajes, cuando el pipeline afirma
  //      que hay uno.
  //
  // Los otros dos se dejan libres a proposito: el tope es duro y quien envuelva
  // este adaptador (un gateway, una capa de agentes) necesita sitio para los
  // suyos. Marcar de mas no es gratis — cada escritura lleva prima del 25% —,
  // asi que el techo no se agota por si acaso.
  private marcarCache(
    req: ProviderRequest,
    system: BloqueDeTexto[],
    messages: MensajeAnthropic[],
    prefijoEnMensajes: number,
    prefijoEnSystem: number,
  ): void {
    if (req.promptCacheKey != null) {
      // La API de Anthropic no tiene un campo equivalente: el emparejamiento es
      // por bytes del prefijo, no por clave. Se ignora en vez de fallar — es una
      // pista de enrutado de OTRO proveedor, y una petición portable no debe
      // reventar por llevarla.
    }
    if (req.stablePrefixMessages == null) return;

    let presupuesto = Math.min(
      this.opts.maxCacheBreakpoints ?? TOPE_DE_PUNTOS_DE_RUPTURA,
      TOPE_DE_PUNTOS_DE_RUPTURA,
    );
    if (presupuesto <= 0) return;

    // EL PUNTO VA AL FINAL DEL `system` QUE ESTA DENTRO DEL PREFIJO, no al final
    // del array. Son cosas distintas en cuanto queda un bloque de sistema fuera
    // del prefijo declarado: el esquema por prompt que se anade mas abajo, o una
    // cabecera cuyo ultimo bloque el llamante NO declaro estable. Ese bloque
    // cambia entre peticiones, y un punto de ruptura por detras de el mete texto
    // variable dentro del tramo cacheado. El emparejamiento es por bytes, asi
    // que no se falla a medias: no acierta NUNCA, y cada peticion paga la prima
    // de escritura (1,25x) del tramo entero.
    const ultimoSystem = prefijoEnSystem > 0 ? system[prefijoEnSystem - 1] : undefined;
    if (ultimoSystem) {
      ultimoSystem.cache_control = { type: "ephemeral" };
      presupuesto -= 1;
    }

    // El segundo punto sólo se gasta si de verdad hay historial dentro del
    // prefijo. Marcar el final de `system` dos veces no cachea más y quema un
    // punto del presupuesto del llamante.
    if (presupuesto > 0 && prefijoEnMensajes > 0) {
      const mensaje = messages[Math.min(prefijoEnMensajes, messages.length) - 1];
      const bloque = mensaje?.content[mensaje.content.length - 1];
      if (bloque) bloque.cache_control = { type: "ephemeral" };
    }
  }

  /** Traduce una respuesta 2xx a la forma neutra del layer. */
  private async leer(
    response: Response,
    req: ProviderRequest,
    contratoNativo: boolean,
  ): Promise<ProviderResponse> {
    const json = (await response.json()) as RespuestaAnthropic;
    const bloques = json.content ?? [];

    const text = bloques
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");

    // Las llamadas a herramienta llegan como bloques `tool_use` con el `input`
    // YA PARSEADO (a diferencia de OpenAI, que manda una cadena JSON). El
    // contrato del layer transporta `arguments` como cadena, así que se
    // reserializa aquí — y NO se toca el contenido: reordenar claves cambiaría
    // lo que el llamante ejecuta.
    const toolCalls = bloques
      .filter((b) => b.type === "tool_use" && b.name !== HERRAMIENTA_DE_CONTRATO)
      .map((b) => ({
        ...(b.id ? { id: b.id } : {}),
        name: b.name ?? "",
        arguments: JSON.stringify(b.input ?? {}),
      }))
      .filter((tc) => tc.name !== "");

    // La respuesta del contrato NO es una llamada a herramienta que el llamante
    // deba ejecutar: es la respuesta final servida por la única vía que este
    // proveedor tiene para imponer una forma. Se devuelve como `text`, que es
    // donde el pipeline la valida.
    const contrato = bloques.find(
      (b) => b.type === "tool_use" && b.name === HERRAMIENTA_DE_CONTRATO,
    );
    const textoFinal = contrato ? JSON.stringify(contrato.input ?? {}) : text;

    const usage = json.usage ?? {};
    const lecturaCache = usage.cache_read_input_tokens;
    const escrituraCache = usage.cache_creation_input_tokens;

    // EL ERROR QUE ESTO EVITA, Y VALE DINERO DEL CLIENTE.
    //
    // `usage.input_tokens` de Anthropic NO es el prompt entero: es SÓLO el resto
    // no cacheado. El total es
    //
    //     input_tokens + cache_creation_input_tokens + cache_read_input_tokens
    //
    // Mapear `inputTokens = usage.input_tokens` a secas haría que, en cuanto la
    // caché empiece a acertar, `ledger.actualInput` se desplome mientras el
    // baseline se reconstruye sobre él: un prompt de 100k servido al 96% desde
    // caché reportaría ~4k de entrada. El ahorro publicado NO vendría de la capa
    // sino de un contador leído a medias, y sería justo la palanca que esta fase
    // existe para medir con honestidad. Se suman los tres.
    const inputTokens =
      (usage.input_tokens ?? 0) + (escrituraCache ?? 0) + (lecturaCache ?? 0);
    const outputTokens = usage.output_tokens ?? 0;

    // La guardia comprueba AUSENCIA, no valor cero, y por separado en cada
    // contador: un cero legítimo (respuesta vacía, parada inmediata) es medible
    // y no debe fallar, mientras que un contador ausente no se puede tarifar.
    // Los dos de caché pueden faltar sin más: significan "no hubo".
    const entradaAusente = typeof usage.input_tokens !== "number";
    const salidaAusente = typeof usage.output_tokens !== "number";
    if (this.opts.requireUsage && (entradaAusente || salidaAusente)) {
      throw new Error(
        `provider returned incomplete usage (input=${usage.input_tokens ?? "absent"}, ` +
          `output=${usage.output_tokens ?? "absent"}); cannot measure cost.`,
      );
    }

    return {
      text: textoFinal,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(json.stop_reason ? { finishReason: traducirParada(json.stop_reason) } : {}),
      usage: {
        inputTokens,
        outputTokens,
        // Sólo el LEÍDO es libro 4. `cache_creation_input_tokens` es la prima de
        // escritura —se paga MÁS caro, 1,25x— y contarlo como ahorro publicaría
        // un sobrecoste como si fuera un descuento.
        ...(lecturaCache != null ? { cachedInputTokens: lecturaCache } : {}),
        ...(escrituraCache != null ? { cacheWriteInputTokens: escrituraCache } : {}),
      },
      structuredNatively: req.schema != null && contratoNativo,
      raw: json,
    };
  }
}

/**
 * Separa los mensajes del layer en las dos mitades que pide la API: el `system`
 * va en su propio campo y NO es un mensaje.
 *
 * Devuelve además cuántos de los mensajes ya traducidos caen dentro del prefijo
 * estable que declaró el pipeline. Ese recuento NO se puede reutilizar tal cual:
 * `stablePrefixMessages` cuenta sobre el array del layer, donde los `system`
 * están mezclados, y al sacarlos los índices se desplazan. Usar el número
 * directamente pondría el punto de ruptura por detrás del prefijo real y
 * cachearía texto variable — que es la forma cara de equivocarse.
 *
 * SOLO SE IZA LA TIRADA INICIAL DE `system`, Y ESO ES LO QUE PERMITE QUE LA CACHÉ
 * ACIERTE ALGUNA VEZ.
 *
 * Izar TODOS los `system` parecía inocuo y costaba el ahorro entero. El orden de
 * renderizado es tools -> system -> messages, así que el campo `system` es el
 * PRINCIPIO del prompt. Los tres bloques que inyecta la capa —evidencia de
 * retrieval, aviso de límites JSON y payload serializado— viajan con
 * `role: "system"` y cambian en CADA petición: izarlos los ponía por delante del
 * historial, de modo que el tramo que va hasta el punto de ruptura del historial
 * ya no coincidía byte a byte con el de la petición anterior. Reproducido con el
 * pipeline entero: el `cache_control` de `system` aterrizaba sobre
 * `{"nonce":12345}`.
 *
 * El coste no era «dejar de ahorrar»: era pagar la PRIMA de escritura (1,25x)
 * sobre el tramo entero en cada petición y leer cero, hasta que la verja se
 * apagase sola tras las 8 de exploración — y publicar entonces «tasa de aciertos
 * 0,0%» como si fuera un hecho sobre el tráfico del cliente y no sobre un fallo
 * nuestro.
 *
 * Un `system` que aparece DESPUÉS del primer turno se emite en su sitio, como
 * turno de `user`. Se pierde el rango de sistema —`messages` solo admite
 * user/assistant de forma portable en esta API, y es el mismo trato que ya
 * recibía el rol `tool`— pero se conserva la POSICIÓN, que es lo que decide si
 * queda algún prefijo reutilizable.
 */
function repartirMensajes(req: ProviderRequest): {
  system: BloqueDeTexto[];
  messages: MensajeAnthropic[];
  prefijoEnMensajes: number;
  prefijoEnSystem: number;
} {
  const system: BloqueDeTexto[] = [];
  const messages: MensajeAnthropic[] = [];
  const limite = req.stablePrefixMessages ?? 0;
  let prefijoEnMensajes = 0;
  let prefijoEnSystem = 0;
  let cabecera = true;

  req.messages.forEach((m, i) => {
    if (m.role === "system" && cabecera) {
      system.push({ type: "text", text: m.content });
      // Solo cuenta como prefijo el `system` que el pipeline declaro dentro. Un
      // llamante puede declarar menos cabecera de la que manda, y marcar de mas
      // es justo el error caro.
      if (i < limite) prefijoEnSystem = system.length;
      return;
    }
    cabecera = false;
    // `tool` no existe como rol aquí: el resultado de una herramienta se
    // devuelve dentro de un turno de usuario. Se traduce a `user` en vez de
    // descartarlo — perderlo dejaría al modelo respondiendo sin el resultado que
    // él mismo pidió.
    messages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text: m.content }],
    });
    if (i < limite) prefijoEnMensajes = messages.length;
  });

  // El primer mensaje tiene que ser `user`. Si el llamante empieza por
  // `assistant` se antepone un turno mínimo en vez de fallar: la alternativa es
  // un 400 por una conversación que en cualquier otro proveedor es válida.
  if (messages.length > 0 && messages[0]!.role === "assistant") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
    if (prefijoEnMensajes > 0) prefijoEnMensajes += 1;
  }

  return { system, messages, prefijoEnMensajes, prefijoEnSystem };
}

/** `stop_reason` de Anthropic -> el vocabulario neutro de `finishReason`. */
function traducirParada(parada: string): string {
  switch (parada) {
    case "end_turn":
      return "stop";
    // `max_tokens` significa lo mismo que el `length` de OpenAI: la respuesta se
    // CORTÓ, no terminó. El pipeline distingue una respuesta mala de una cortada
    // por este campo —reintentar con el mismo tope vuelve a cortarla—, así que
    // el nombre tiene que ser el mismo en los dos adaptadores.
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return parada;
  }
}

interface RespuestaAnthropic {
  content?: {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
