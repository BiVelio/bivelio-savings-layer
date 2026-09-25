import { avisarUnaVez } from "../util/warn-once.js";
import { atestiguar, herramientasSinParametros, sinContrato } from "./atestado-del-cable.js";
import { instruccionDeJsonPorPrompt } from "./json-por-prompt.js";
import { isStrictCompatible } from "./openai-compatible.js";
import { sseMessages } from "./sse.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderStreamOptions,
  ProviderUsage,
} from "./types.js";

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
  /**
   * Strip the `provider/` prefix from model ids before sending
   * (`anthropic/claude-sonnet-4-5` → `claude-sonnet-4-5`). Default (undefined):
   * strip when talking to `api.anthropic.com`, which rejects a prefixed id;
   * keep for a gateway or proxy, which usually routes on it. An explicit value
   * always wins.
   */
  stripProviderPrefix?: boolean;
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
  /**
   * When true, requests that the pipeline decided to mark also carry the
   * request-level `cache_control` (Anthropic's automatic caching): the provider
   * places one extra breakpoint on the last cacheable block and moves it
   * forward as the conversation grows, so the history beyond the declared
   * stable prefix is cached incrementally too. It spends one of the four
   * breakpoint slots and never fires when the economic gate declined to mark.
   *
   * Off by default, and deliberately so: the moving breakpoint writes the
   * volatile tail of EVERY marked request at the 1.25x write premium. That
   * pays for itself on conversational or agentic traffic — the next turn reads
   * the whole history at 0.1x — and loses money on one-shot traffic where
   * nothing ever reads it back. It is also rejected by legacy Bedrock
   * deployments. Turn it on when your traffic is multi-turn.
   */
  automaticCache?: boolean;
  /**
   * Whether a request carrying BOTH the caller's tools and an output contract
   * may send `tool_choice: {type: "any"}`, which obliges the model to answer
   * through SOME tool — its pick — instead of writing prose.
   *
   * Defaults to `true`, and the default is the point: without it this exact
   * combination measured 62% MORE expensive than sending no layer at all, every
   * single time, because prose forces a second full call to repair. Turning it
   * off restores the old behaviour for a caller who genuinely needs a plain-text
   * turn to be reachable while a contract is attached.
   */
  forceAnswerThroughTool?: boolean;
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

  /** The id Anthropic's API sees: bare at `api.anthropic.com`, as written elsewhere. */
  private modeloEnElCable(model: string): string {
    const base = this.opts.baseUrl ?? "https://api.anthropic.com/v1";
    let esLaApiPublica = false;
    try {
      esLaApiPublica = /(^|\.)api\.anthropic\.com$/i.test(new URL(base).hostname);
    } catch {
      esLaApiPublica = false;
    }
    const quitar = this.opts.stripProviderPrefix ?? esLaApiPublica;
    return quitar ? model.replace(/^[^/]+\//, "") : model;
  }

  async generate(req: ProviderRequest, options?: ProviderStreamOptions): Promise<ProviderResponse> {
    const cuerpo = this.construirCuerpo(req);
    // Sin `options`, ninguna señal: la petición HTTP es la de siempre.
    const response = await this.enviar(cuerpo.body, options?.signal);

    if (!response.ok) {
      throw new Error(`provider ${response.status}: ${await safeText(response)}`);
    }
    return this.leer(response, req, cuerpo.contratoNativo, cuerpo.turnoAnadido, cuerpo.esquemaPorPrompt);
  }

  /**
   * Streaming variant of generate() over the Messages API. The final usage is
   * read from the closing `message_delta` event (the output counter in
   * `message_start` is provisional); a stream without it reports
   * `usage.complete: false`, and with `requireUsage` it throws instead. A body
   * that ends before the provider signalled completion throws. Requests with an
   * output contract or declared deferrable are served by generate() and yielded
   * as one text event.
   */
  async *generateStream(
    req: ProviderRequest,
    options: ProviderStreamOptions = {},
  ): AsyncGenerator<ProviderStreamEvent, void, undefined> {
    // Con contrato no se streamea: el contrato viaja como la herramienta
    // `bvsala_contract` y su respuesta ES la respuesta final, así que en un
    // stream aparecería como una llamada a herramienta. generate() ya sabe
    // convertirla en texto; el pipeline, además, entrega esas peticiones enteras.
    if (req.schema != null || req.deferrable === true) {
      const r = await this.generate(req);
      if (r.text !== "") yield { type: "text", delta: r.text };
      yield { type: "done", response: r };
      return;
    }

    const construido = this.construirCuerpo(req);
    const body = construido.body;
    body["stream"] = true;
    const response = await this.enviar(body, options.signal);
    if (!response.ok) {
      throw new Error(`provider ${response.status}: ${await safeText(response)}`);
    }
    // Un endpoint compatible que ignora `stream: true` y contesta el mensaje
    // entero en JSON: ya está facturado, así que se lee como en generate() en
    // vez de lanzar «ended before completion» sobre una respuesta completa.
    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      const entera = await this.leer(
        response,
        req,
        construido.contratoNativo,
        construido.turnoAnadido,
        construido.esquemaPorPrompt,
      );
      if (entera.text !== "") yield { type: "text", delta: entera.text };
      yield { type: "done", response: entera };
      return;
    }

    const cuerpo = response.body as (ReadableStream<Uint8Array> & { getReader?: unknown }) | null;
    const fuente: ReadableStream<Uint8Array> | string =
      cuerpo && typeof cuerpo.getReader === "function" ? cuerpo : await response.text();

    let text = "";
    const bloques = new Map<number, { tipo: string; id?: string; name?: string; json: string }>();
    let usoInicio: UsoAnthropic | undefined;
    let usoDelta: UsoAnthropic | undefined;
    let vioDelta = false;
    let vioStop = false;
    let stopReason: string | undefined;
    let razono = false;

    for await (const msg of sseMessages(fuente)) {
      let data: EventoAnthropic;
      try {
        data = JSON.parse(msg.data) as EventoAnthropic;
      } catch {
        continue;
      }
      if (data === null || typeof data !== "object") continue;
      const tipo = msg.event !== "message" ? msg.event : (data.type ?? msg.event);

      if (tipo === "message_start") {
        usoInicio = data.message?.usage ?? usoInicio;
      } else if (tipo === "content_block_start") {
        const b = data.content_block;
        if (esBloqueDeRazonamiento(b?.type)) razono = true;
        if (typeof data.index === "number" && b) {
          bloques.set(data.index, {
            tipo: b.type ?? "",
            ...(typeof b.id === "string" ? { id: b.id } : {}),
            ...(typeof b.name === "string" ? { name: b.name } : {}),
            json: "",
          });
        }
      } else if (tipo === "content_block_delta") {
        const d = data.delta;
        if (d?.type === "text_delta" && typeof d.text === "string" && d.text !== "") {
          text += d.text;
          yield { type: "text", delta: d.text };
        } else if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
          const bloque = typeof data.index === "number" ? bloques.get(data.index) : undefined;
          if (bloque) bloque.json += d.partial_json;
        }
        // thinking, signature, citations…: no son texto de la respuesta.
      } else if (tipo === "message_delta") {
        vioDelta = true;
        stopReason = data.delta?.stop_reason ?? stopReason;
        if (data.usage) usoDelta = fusionarUso(usoDelta, data.usage);
      } else if (tipo === "message_stop") {
        vioStop = true;
        break;
      } else if (tipo === "error") {
        throw new Error(`provider stream error: ${data.error?.type}: ${data.error?.message}`);
      }
      // `ping` y cualquier evento nuevo se ignoran.
    }

    // Sin `message_delta` ni `message_stop` el proveedor no terminó: el cuerpo
    // se cortó. Media respuesta no se entrega como si fuera entera.
    if (!vioStop && !vioDelta) {
      throw new Error("provider stream ended before completion (no message_delta)");
    }

    // `message_start` trae la entrada y un `output_tokens` provisional (un
    // marcador); `message_delta` trae la salida final y pisa los escalares. El
    // desglose de `cache_creation` por TTL se FUSIONA: un delta que no lo traiga
    // no puede borrar el de `message_start`.
    const merged = fusionarUso(usoInicio, usoDelta);
    let usage: ProviderUsage;
    if (!vioDelta) {
      usage = { inputTokens: 0, outputTokens: 0, complete: false };
    } else {
      const lecturaCache = merged.cache_read_input_tokens;
      const escrituraCache = merged.cache_creation_input_tokens;
      // Igual que en leer(): `input_tokens` es SOLO el resto no cacheado.
      usage = {
        inputTokens: (merged.input_tokens ?? 0) + (escrituraCache ?? 0) + (lecturaCache ?? 0),
        outputTokens: usoDelta?.output_tokens ?? 0,
        ...(lecturaCache != null ? { cachedInputTokens: lecturaCache } : {}),
        ...(escrituraCache != null ? { cacheWriteInputTokens: escrituraCache } : {}),
        // Igual que en leer(): sin bloque de razonamiento, 0; con él, no se sabe.
        ...(razono || typeof usoDelta?.output_tokens !== "number" ? {} : { reasoningTokens: 0 }),
        ...(typeof merged.input_tokens !== "number" || typeof usoDelta?.output_tokens !== "number"
          ? { complete: false }
          : {}),
      };
    }
    if (this.opts.requireUsage && usage.complete === false) {
      throw new Error(
        mensajeDeUsoIncompleto(
          vioDelta ? merged.input_tokens : undefined,
          vioDelta ? usoDelta?.output_tokens : undefined,
        ),
      );
    }

    // `input` llega troceado como JSON parcial; se normaliza con parse+stringify
    // para que `arguments` sea exactamente lo que generate() habría devuelto
    // (allí el `input` ya viene parseado y se serializa). Un JSON que no parsea
    // (un corte por `max_tokens`) se entrega crudo: `finishReason` dirá `length`.
    const toolCalls = [...bloques.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => b)
      .filter((b) => b.tipo === "tool_use" && b.name !== HERRAMIENTA_DE_CONTRATO)
      .map((b) => ({
        ...(b.id ? { id: b.id } : {}),
        name: b.name ?? "",
        arguments: normalizarArgumentos(b.json),
      }))
      .filter((tc) => tc.name !== "");

    const servedServiceTier =
      typeof merged.service_tier === "string" && merged.service_tier !== ""
        ? merged.service_tier
        : undefined;

    yield {
      type: "done",
      response: atestiguar(
        {
          text,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(stopReason ? { finishReason: traducirParada(stopReason) } : {}),
          ...(servedServiceTier ? { servedServiceTier } : {}),
          usage,
          structuredNatively: false,
          raw: { usage: merged, stop_reason: stopReason },
        },
        // Sin contrato: los que lo llevan van por generate(). Piezas del
        // adaptador: el «(continue)» y el `input_schema` vacío de cada
        // herramienta que no traía el suyo.
        sinContrato((construido.turnoAnadido ? 1 : 0) + herramientasSinParametros(req.tools)),
      ),
    };
  }

  // El POST a `/messages`, compartido por generate() y generateStream().
  private async enviar(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const base = (this.opts.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    return await this.fetchImpl(`${base}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": this.opts.apiVersion ?? "2023-06-01",
        ...(this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {}),
        ...this.opts.headers,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
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
  //
  // Y si el adaptador antepuso el turno «(continue)», que la petición no traía:
  // son tokens que el contador del proveedor cuenta y que la cuenta local del
  // pipeline no ve (ver `atestado-del-cable.ts`).
  private construirCuerpo(req: ProviderRequest): {
    body: Record<string, unknown>;
    contratoNativo: boolean;
    turnoAnadido: boolean;
    esquemaPorPrompt: boolean;
  } {
    const { system, messages, prefijoEnMensajes, prefijoEnSystem, turnoAnadido } = repartirMensajes(req);

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
    // herramienta cuyo `input_schema` es el contrato. FORZARLA (`tool_choice`) es
    // lo que convierte la guía en garantía, y con `strict: true` el proveedor se
    // compromete además a que `input` valide.
    //
    // Si el llamante trae SUS herramientas no se puede forzar: forzar la nuestra
    // dejaría al modelo sin poder invocar las suyas, y el turno de herramientas
    // es precisamente lo que la capa promete no romper.
    //
    // ═══════════════════════════════════════════════════════════════════════════
    // PERO «NO FORZAR» NO ERA «MANDAR EL ESQUEMA COMO PROSA», Y ESA CONFUSIÓN
    // COSTABA UN 63% MÁS.
    // ═══════════════════════════════════════════════════════════════════════════
    //
    // Antes esta rama pegaba el esquema en `system` como texto
    // (`instruccionDeJsonPorPrompt`). Lo que el modelo devolvía entonces era
    // texto libre —a veces con prosa de cortesía y el JSON dentro de una valla
    // markdown—, no validaba, y el pipeline disparaba su ÚNICA reparación: una
    // SEGUNDA llamada completa.
    //
    // LA HIPÓTESIS QUE SE CAYÓ AL MEDIRLA: no es que el esquema por prompt
    // cueste más de lo que la poda ahorra. Los DOS brazos pasan por este
    // adaptador con `tools` + `schema`, así que los dos pagaban esos 81 tokens
    // de prosa: era simétrico y no explicaba nada. Y la poda del selector SÍ
    // ahorraba, 278 tokens por llamada (90 de esquemas de herramienta contra
    // 368). Lo que no era simétrico es que SOLO nuestro brazo repara.
    //
    // Reproducido con un servidor local que habla este dialecto, escenario
    // "Tool-heavy request", contando con o200k_base:
    //
    //   brazo A (sin capa)   5 herramientas + esquema en prosa      1.057 entrada
    //   brazo B, llamada 1   1 herramienta  + esquema en prosa        779 entrada
    //   brazo B, reparación  contrato como herramienta                751 entrada
    //                                                              ─────────────
    //   brazo B total                                               1.530 entrada
    //
    // La reparación se comía el ahorro de la poda casi TRES VECES. Y lo caro de
    // ella no es el mensaje de corrección (77 tokens): es que toda petición con
    // `tools` paga el prompt de sistema de uso de herramientas de Anthropic
    // ENTERO, y la reparación lo vuelve a pagar sólo para llevar el contrato.
    // Ese peaje el servidor local lo modela en 600 tokens, que es el valor con
    // el que la simulación reproduce las magnitudes de la tirada en vivo (1.057
    // contra los 1.135 medidos); es una CALIBRACIÓN, no una cifra publicada por
    // el proveedor, y lo que sostiene el diagnóstico es la aritmética de las DOS
    // llamadas, que ninguna llamada sola explica.
    //
    // Y la salida —que en Sonnet cuesta 5x por token— se paga dos veces: en vivo
    // 67 tokens el brazo A contra 189 el nuestro. Puesto en dinero, DOS TERCIOS
    // de la regresión son salida y sólo un tercio entrada.
    //
    // LA SALIDA ES LO QUE HAY QUE ATACAR, y por eso la palanca no es quitar
    // tokens de entrada. La primera llamada YA lleva `tools`, o sea que el peaje
    // ya está pagado: añadir el contrato como una herramienta más cuesta 93
    // tokens (esquema + descripción, medido) y ahorra los 81 de la prosa que
    // sustituye — un +12 por llamada. Eso no es el ahorro; el ahorro es que el
    // modelo tiene por fin un camino NATIVO para devolver la forma SIN perder sus
    // herramientas, y cuando lo toma el `input` llega ya parseado: no hay valla
    // markdown que romper, no hay prosa de cortesía que pagar a 5x, y la
    // reparación no ocurre. Los 12 tokens se amortizan si evitan UNA reparación
    // de cada 62 llamadas.
    //
    // Medido contra el mismo servidor local, con el arreglo puesto:
    //
    //   brazo A (sin capa)                                          1.069 entrada
    //   brazo B, si el modelo toma el contrato (1 llamada)            791  → −26%
    //   brazo B, si contesta en prosa igual (2 llamadas)            ~1.540  → peor
    //
    // O SEA: EL ARREGLO QUITA LA CAUSA, NO ACOTA EL PEOR CASO. Cuántas veces el
    // modelo toma el camino nativo sólo lo dice una tirada EN VIVO, y ahí el
    // servidor local no puede opinar: no es un modelo. El aviso de más abajo
    // existe para que, mientras tanto, nadie pague el peor caso en silencio.
    //
    // LO QUE FALTA, MEDIDO Y NO HECHO AQUÍ A PROPÓSITO: de esos 751 tokens de
    // reparación, 674 son peaje de herramientas por llevar un contrato que en
    // ese momento NO se fuerza (el esquema del banco no cumple `strict`), o sea
    // que compra exactamente lo mismo que la prosa por 8x el precio. Arreglarlo
    // pide cambiar la rama SIN herramientas del llamante, que es la que usan
    // todos los demás escenarios de Anthropic, y eso mueve la conducta del
    // modelo en sitios que esta regresión no tocaba. Va aparte y con su tirada.
    //
    // ═══════════════════════════════════════════════════════════════════════════
    // Y «NO FORZAR LA NUESTRA» TAMPOCO ERA «NO FORZAR NADA». ESA SEGUNDA
    // CONFUSIÓN COSTABA OTRO 62%, Y LA TIRADA EN VIVO YA LA DESMINTIÓ.
    // ═══════════════════════════════════════════════════════════════════════════
    //
    // El arreglo de arriba —el contrato como herramienta más— QUITA la causa solo
    // si el modelo escoge ese camino, y arriba se decía que cuántas veces lo hace
    // «sólo lo dice una tirada EN VIVO». Ya se hizo, con el arreglo puesto, y lo
    // que dijo es que no lo escoge: escenario "Tool-heavy request", −59,7% de
    // ahorro (o sea, un 60% MÁS caro que no usar la capa), el MISMO par de costes
    // repetido en 14 de 18 repeticiones. Eso no es ruido del muestreo, es conducta
    // determinista: el modelo contesta en prosa y la reparación se paga siempre.
    //
    // LO QUE FALTABA ERA `tool_choice`, PERO NO EL NUESTRO.
    //
    // `{type: "tool", name: ...}` fuerza UNA herramienta concreta y por eso no
    // sirve aquí: dejaría al llamante sin poder invocar las suyas. `{type: "any"}`
    // es otra cosa — obliga a llamar a ALGUNA herramienta, y la elige el modelo.
    // El llamante conserva las suyas enteras, y la prosa deja de ser alcanzable
    // por contrato de la API en vez de por una descripción persuasiva. El peor
    // caso pasa a ser el mejor caso: una sola llamada, podada, escoja lo que
    // escoja el modelo.
    //
    // Y ES GRATIS EN CACHÉ, que es lo que lo hace obvio. `tool_choice` vive en la
    // capa de invalidación por debajo de `tools` y de `system`: cambiarlo NO tira
    // el prefijo cacheado de herramientas ni el de sistema. O sea que esta línea
    // no cuesta ni un token de entrada — ni la primera vez ni las siguientes.
    //
    // LO QUE SIGUE SIN SER: una garantía. El modelo puede escoger una herramienta
    // DEL LLAMANTE, que es justo lo que queremos que pueda hacer, y entonces no
    // hay respuesta final que validar todavía. Por eso `structuredNatively` sigue
    // false y `constraints.backend` sigue "none": la garantía la da el validador
    // del layer, igual que antes. Lo que cambia es el PRECIO de conseguirla.
    //
    // La rama con el nombre ocupado NO se fuerza. Ahí el contrato viaja como prosa
    // porque no cabe como herramienta, así que obligar a llamar a una herramienta
    // dejaría al modelo sin ninguna forma de entregar la respuesta final: se
    // quedaría dando vueltas por las del llamante. Forzar sin contrato al que
    // acudir no acota el gasto, lo desata.
    //
    // Estos tokens los añade el ADAPTADOR, así que no los ve la cuenta local del
    // prompt: `actualInput` sube y el baseline no, o sea que el ahorro publicado
    // sale MENOR del real. Es el mismo sesgo, y en la misma dirección segura, que
    // ya documenta `instruccionDeJsonPorPrompt`.
    let contratoNativo = false;
    let esquemaPorPrompt = false;
    let forzarCualquiera = false;
    if (req.schema) {
      const traeHerramientas = tools.length > 0;
      // Un llamante que ya tenga una herramienta con ese nombre haría que la
      // petición saliera con dos `tools` homónimas, y eso es un 400 del
      // proveedor: una petición que hoy funciona pasaría a fallar en duro. En ese
      // caso el contrato se queda en prosa, que es peor pero no rompe nada.
      const nombreOcupado = tools.some((t) => t["name"] === HERRAMIENTA_DE_CONTRATO);
      const strict = isStrictCompatible(req.schema);

      if (nombreOcupado) {
        system.push({ type: "text", text: instruccionDeJsonPorPrompt(req.schema) });
        esquemaPorPrompt = true;
        avisarUnaVez(
          "anthropic-contrato-nombre-ocupado",
          `[bvsala] One of your tools is already named \`${HERRAMIENTA_DE_CONTRATO}\`, so the output ` +
            "contract cannot travel as a tool without colliding with it (duplicate tool names are a " +
            "provider error). The schema is sent as prompt text instead, which is measurably more " +
            "expensive on this API. Rename that tool to get the cheaper path.",
        );
      } else {
        if (!strict && !traeHerramientas) {
          avisarUnaVez(
            "anthropic-strict-incompatible",
            "[bvsala] The response contract does not meet `strict` mode (in strict, `required` must " +
              "list ALL the keys in `properties`, and every object needs " +
              "`additionalProperties: false`). The schema is sent without `strict`: the model is still " +
              "guided and the layer still validates, but the guarantee comes from the layer, not the provider.",
          );
        }
        contratoNativo = strict && !traeHerramientas;
        tools.push({
          name: HERRAMIENTA_DE_CONTRATO,
          // La descripción es lo único que decide si el modelo escoge este camino
          // o contesta en prosa, y vive DENTRO del bloque `tools` —que va lo
          // primero del prompt y por tanto cae dentro del tramo cacheable—, así
          // que estos tokens se pagan una vez y se leen a 0,1x.
          description: traeHerramientas
            ? "Return the final answer in the required shape. Use the other tools first if you " +
              "need data; call this one instead of writing the answer as text."
            : "Return the final answer in the required shape.",
          input_schema: req.schema,
          ...(contratoNativo ? { strict: true } : {}),
        });
        if (traeHerramientas) {
          forzarCualquiera = this.opts.forceAnswerThroughTool !== false;
          avisarUnaVez(
            "anthropic-contrato-con-herramientas",
            "[bvsala] This request carries BOTH your tools and an output contract. On Anthropic's " +
              "Messages API a specific shape is only GUARANTEED by forcing that exact tool, and " +
              "forcing ours would leave the model unable to call yours. The contract travels as " +
              "one extra tool" +
              (forzarCualquiera
                ? ' and the request is sent with `tool_choice: {type: "any"}`, so the model must ' +
                  "answer through SOME tool — yours or the contract — and can no longer reply in " +
                  "prose. Your tool turn is untouched. The guarantee is still the layer's, not " +
                  'the provider\'s (`constraints.backend: "none"`), because the model may pick ' +
                  "one of your tools and defer the final answer to the next turn."
                : ", not forced (`forceAnswerThroughTool: false`). The guarantee is the " +
                  'layer\'s, not the provider\'s (`constraints.backend: "none"`), and if the ' +
                  "model answers in prose the layer pays a second full call to repair it — on " +
                  "this API that second call re-pays the whole tool-use overhead.") +
              " Dropping either the tools or the contract from this request is what makes the " +
              "guarantee free.",
          );
        }
      }
    }

    const body: Record<string, unknown> = {
      model: this.modeloEnElCable(req.model),
      max_tokens: req.maxOutputTokens ?? this.opts.defaultMaxOutputTokens ?? 4096,
      messages,
    };
    if (system.length > 0) body["system"] = system;
    if (req.temperature != null) body["temperature"] = req.temperature;
    if (tools.length > 0) body["tools"] = tools;
    if (contratoNativo) {
      body["tool_choice"] = { type: "tool", name: HERRAMIENTA_DE_CONTRATO };
    } else if (forzarCualquiera) {
      // No se toca `disable_parallel_tool_use`. Con `any` el modelo puede emitir
      // varias llamadas a la vez, y una de ellas podría ser el contrato junto a
      // una del llamante — un bloque de contrato desperdiciado. Apagar el
      // paralelismo lo evitaría, pero a costa de serializar las herramientas DEL
      // LLAMANTE, que es una regresión de latencia en su código por un ahorro de
      // salida nuestro. El desperdicio es de unos pocos tokens; la serialización,
      // de un viaje de red por herramienta.
      body["tool_choice"] = { type: "any" };
    }
    // `seed` NO existe en esta API. Se omite en silencio a propósito: mandarlo
    // sería un 400 por un campo que el llamante puso para otro proveedor, y
    // fallar por eso convertiría una petición portable en una avería.

    // EL TIER DIFERIBLE NO EXISTE AQUÍ, Y HAY QUE DECIRLO EN VOZ ALTA.
    //
    // La API de Mensajes SÍ tiene un `service_tier`, y esa es justo la trampa:
    // acepta 'auto' | 'standard_only', y lo que elige es capacidad PRIORITARIA
    // —más rápida y más CARA— frente a la estándar. No hay un flex. Mandar
    // cualquiera de los dos valores porque el llamante declaró la petición
    // diferible no abarataría nada, y `standard_only` podría además anularle a un
    // cliente con tier prioritario contratado una latencia que está pagando.
    //
    // El descuento del 50% por diferir existe en Anthropic, pero SOLO en la
    // Message Batches API, que es asíncrona y no cabe en `generate()`. Así que
    // aquí no se toca el cuerpo: se avisa una vez y la petición sale idéntica.
    // El informe lo dirá igual, porque `usage.service_tier` de la respuesta SÍ se
    // lee y dirá `standard` — que es la prueba, no la suposición, de que no hubo
    // descuento.
    if (req.deferrable === true) {
      avisarUnaVez(
        "anthropic-sin-tier-diferible",
        "[bvsala] This request was declared deferrable, but the Anthropic Messages API has NO " +
          "cheaper synchronous tier: its `service_tier` chooses between priority capacity (more " +
          "expensive) and standard, not a flex. The request goes out unchanged and the report " +
          "credits no discount. The 50% for deferring exists in the Message Batches API, which is " +
          "asynchronous and does not fit a request/response call.",
      );
    }

    const puntosGastados = this.marcarCache(req, system, messages, prefijoEnMensajes, prefijoEnSystem);

    // CACHÉ AUTOMÁTICA (opt-in): el `cache_control` a NIVEL DE PETICIÓN hace
    // que el proveedor coloque UN punto de ruptura más en el último bloque
    // cacheable y lo MUEVA hacia delante conforme crece la conversación — el
    // historial por detrás del prefijo estable declarado también se cachea, con
    // escrituras incrementales (cada turno paga solo el tramo nuevo).
    //
    // Tres condiciones, y las tres son deliberadas:
    //  1. `automaticCache` encendida — es una apuesta sobre la FORMA del
    //     tráfico (ver el JSDoc de la opción), no una mejora universal.
    //  2. El pipeline decidió marcar (`stablePrefixMessages` presente): la
    //     verja económica sigue mandando. Si dijo que marcar pierde dinero,
    //     el punto móvil también lo perdería.
    //  3. Queda presupuesto: el punto automático consume uno de los 4 slots de
    //     la API, y pisar el tope es un 400, no un aviso.
    // Caso borde documentado por el proveedor: si el último bloque ya lleva un
    // `cache_control` explícito con el mismo TTL (prefijo estable == prompt
    // entero), el automático es un no-op — inofensivo, no un error.
    if (
      this.opts.automaticCache === true &&
      req.stablePrefixMessages != null &&
      puntosGastados < Math.min(this.opts.maxCacheBreakpoints ?? TOPE_DE_PUNTOS_DE_RUPTURA, TOPE_DE_PUNTOS_DE_RUPTURA)
    ) {
      body["cache_control"] = { type: "ephemeral" };
    }

    return { body, contratoNativo, turnoAnadido, esquemaPorPrompt };
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
  ): number {
    if (req.promptCacheKey != null) {
      // La API de Anthropic no tiene un campo equivalente: el emparejamiento es
      // por bytes del prefijo, no por clave. Se ignora en vez de fallar — es una
      // pista de enrutado de OTRO proveedor, y una petición portable no debe
      // reventar por llevarla.
    }
    if (req.stablePrefixMessages == null) return 0;

    let presupuesto = Math.min(
      this.opts.maxCacheBreakpoints ?? TOPE_DE_PUNTOS_DE_RUPTURA,
      TOPE_DE_PUNTOS_DE_RUPTURA,
    );
    if (presupuesto <= 0) return 0;
    const presupuestoInicial = presupuesto;

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
      if (bloque) {
        bloque.cache_control = { type: "ephemeral" };
        presupuesto -= 1;
      }
    }
    return presupuestoInicial - presupuesto;
  }

  // Traduce una respuesta 2xx a la forma neutra del layer.
  private async leer(
    response: Response,
    req: ProviderRequest,
    contratoNativo: boolean,
    turnoAnadido: boolean,
    esquemaPorPrompt: boolean,
  ): Promise<ProviderResponse> {
    const json = (await response.json()) as RespuestaAnthropic;
    const bloques = json.content ?? [];
    // RAZONAMIENTO OCULTO. La API de Mensajes no lo desglosa en `usage`: los
    // tokens de `thinking` van dentro de `output_tokens` sin más. Lo que sí
    // hace es devolver SIEMPRE su bloque (`thinking` o `redacted_thinking`)
    // cuando lo hubo, y este adaptador nunca lo pide. Así que sin ese bloque
    // el razonamiento es 0 —y se dice—, y con él no se sabe cuánto fue, y no se
    // dice nada: un número inventado aquí acabaría acreditando salida.
    const razono = bloques.some((b) => esBloqueDeRazonamiento(b.type));

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
      throw new Error(mensajeDeUsoIncompleto(usage.input_tokens, usage.output_tokens));
    }

    // El tier SERVIDO viaja aquí dentro de `usage`, no en la raíz como en OpenAI,
    // y su vocabulario es otro: "standard" | "priority" | "batch". Se lee aunque
    // esta capa no pida nunca un tier a este proveedor, y no es decorativo: es lo
    // que permite al informe DEMOSTRAR que no hubo descuento en vez de suponerlo.
    const servedServiceTier =
      typeof usage.service_tier === "string" && usage.service_tier !== ""
        ? usage.service_tier
        : undefined;

    return atestiguar(
      {
        text: textoFinal,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(json.stop_reason ? { finishReason: traducirParada(json.stop_reason) } : {}),
        ...(servedServiceTier ? { servedServiceTier } : {}),
        usage: {
          inputTokens,
          outputTokens,
          // Sólo el LEÍDO es libro 4. `cache_creation_input_tokens` es la prima de
          // escritura —se paga MÁS caro, 1,25x— y contarlo como ahorro publicaría
          // un sobrecoste como si fuera un descuento.
          ...(lecturaCache != null ? { cachedInputTokens: lecturaCache } : {}),
          ...(escrituraCache != null ? { cacheWriteInputTokens: escrituraCache } : {}),
          // Solo si hay contador de salida del que decirlo.
          ...(razono || salidaAusente ? {} : { reasoningTokens: 0 }),
          // Un contador ausente se rellenó con 0: la petición sale `unmeasured`.
          // Con el usage completo la clave NO aparece.
          ...(entradaAusente || salidaAusente ? { complete: false } : {}),
        },
        structuredNatively: req.schema != null && contratoNativo,
        raw: json,
      },
      // El contrato, cuando lo hay, viaja como HERRAMIENTA escrita por este
      // adaptador (nombre, descripción y `tool_choice`), y el proveedor cobra
      // además su prompt de uso de herramientas: nativo sí, tal cual no. Piezas
      // del adaptador: el «(continue)» y el `input_schema` vacío de cada
      // herramienta que no traía el suyo.
      {
        ...sinContrato((turnoAnadido ? 1 : 0) + herramientasSinParametros(req.tools)),
        // Solo con el nombre de la herramienta de contrato ya ocupado: entonces
        // el esquema va en `system` como prosa (ver construirCuerpo).
        esquemaPorPrompt,
      },
    );
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
  turnoAnadido: boolean;
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
  let turnoAnadido = false;
  if (messages.length > 0 && messages[0]!.role === "assistant") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
    if (prefijoEnMensajes > 0) prefijoEnMensajes += 1;
    turnoAnadido = true;
  }

  return { system, messages, prefijoEnMensajes, prefijoEnSystem, turnoAnadido };
}

/** ¿Es un bloque de razonamiento (visible o redactado) de la API de Mensajes? */
function esBloqueDeRazonamiento(tipo: string | undefined): boolean {
  return tipo === "thinking" || tipo === "redacted_thinking";
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
    /** "standard" | "priority" | "batch" — se trata como conjunto abierto. */
    service_tier?: string;
  };
}

// El `usage` de la API de Mensajes, tal como llega en `message_start`,
// `message_delta` o la respuesta JSON.
interface UsoAnthropic {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  service_tier?: string;
}

// Un evento SSE de la API de Mensajes, con los campos que se leen.
interface EventoAnthropic {
  type?: string;
  index?: number;
  message?: { usage?: UsoAnthropic };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  usage?: UsoAnthropic;
  error?: { type?: string; message?: string };
}

// Fusiona dos `usage`: el segundo pisa los escalares que TRAE (un null no borra
// lo que dijo el primero) y `cache_creation` se fusiona clave a clave, igual que
// el observador SSE del gateway.
function fusionarUso(a: UsoAnthropic | undefined, b: UsoAnthropic | undefined): UsoAnthropic {
  const presentes = Object.fromEntries(
    Object.entries(b ?? {}).filter(([, v]) => v !== null && v !== undefined),
  ) as UsoAnthropic;
  const cache_creation =
    a?.cache_creation || b?.cache_creation
      ? { ...(a?.cache_creation ?? {}), ...(b?.cache_creation ?? {}) }
      : undefined;
  return { ...(a ?? {}), ...presentes, ...(cache_creation ? { cache_creation } : {}) };
}

// `partial_json` concatenado -> la cadena que generate() habría producido.
function normalizarArgumentos(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json === "" ? "{}" : json));
  } catch {
    return json;
  }
}

// El mismo texto en generate() y en generateStream().
function mensajeDeUsoIncompleto(input: number | undefined, output: number | undefined): string {
  return (
    `provider returned incomplete usage (input=${input ?? "absent"}, ` +
    `output=${output ?? "absent"}); cannot measure cost.`
  );
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
