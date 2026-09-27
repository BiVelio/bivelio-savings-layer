import { avisarUnaVez } from "../util/warn-once.js";
import { atestiguar, declararBusquedaNativa, herramientasSinParametros, sinContrato } from "./atestado-del-cable.js";
import { HERRAMIENTA_DE_BUSQUEDA } from "../router/busqueda-nativa.js";
import { instruccionDeJsonPorPrompt } from "./json-por-prompt.js";
import { endpointLimpio, registrarLotes, rutaRelativa } from "./lotes-del-proveedor.js";
import { isStrictCompatible } from "./openai-compatible.js";
import { sseMessages } from "./sse.js";
import { MemoriaDeBusquedas, paresDeBusqueda, type BloqueCrudo } from "./busquedas-entre-turnos.js";
import {
  esBloqueDeRazonamiento,
  fusionarUso,
  tierServidoDe,
  traducirParada,
  usoDeMensajes,
  type UsoAnthropic,
} from "./anthropic-uso.js";
import type { ChatMessage } from "../contracts/types.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderStreamOptions,
  ProviderToolSearchUsage,
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
   * The API caps them at 4 per request. The fixed placement never needs more
   * than 2 (end of system, end of the stable message prefix); the layer's
   * placer (`cacheBreakpoints: "auto"`) may add a third on the last block. The
   * cap is exposed so a gateway with a stricter limit can lower it; when it is
   * short, the system block goes first and the last block second. Raising it
   * above 4 is pointless: the extra breakpoints are rejected by the API, not
   * ignored.
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
   *
   * Ignored on requests whose breakpoints were placed by the layer's placer
   * (`cacheBreakpoints: "auto"`): the placer already decides whether the tail is
   * marked, from the reuse it measured on your traffic.
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
  cache_control?: MarcaDeCache;
}

// Sin `ttl` es el defecto de la API (5 min). La colocación fija nunca lo manda,
// así que su cuerpo sigue byte a byte como antes de que existiera la hora.
type MarcaDeCache = { type: "ephemeral" } | { type: "ephemeral"; ttl: "1h" };

// Un par de búsqueda de un turno anterior, devuelto tal cual lo mandó la API
// (ver busquedas-entre-turnos.ts). Puede recibir el `cache_control` del prefijo
// estable si es el último bloque de su turno: la API lo admite en los dos.
type BloqueReenviado = BloqueCrudo & { cache_control?: MarcaDeCache };

interface MensajeAnthropic {
  role: "user" | "assistant";
  content: (BloqueDeTexto | BloqueReenviado)[];
}

// Lo que el adaptador devolvió en el historial de ESTA petición: cuántos pares
// de búsqueda de turnos anteriores y qué herramientas cargaban.
interface ReenvioDeBusquedas {
  resultados: number;
  herramientas: string[];
  anteponer: (m: ChatMessage) => BloqueCrudo[] | undefined;
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  private readonly opts: AnthropicOptions;
  private readonly fetchImpl: typeof fetch;
  // Los pares de búsqueda de cada respuesta con `toolSearch`, por los ids de sus
  // llamadas, para devolverlos en el turno siguiente. En proceso y acotada.
  private readonly busquedas = new MemoriaDeBusquedas();

  constructor(opts: AnthropicOptions = {}) {
    this.opts = opts;
    this.id = `anthropic:${opts.baseUrl ?? "https://api.anthropic.com/v1"}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // Este adaptador sabe mandar la búsqueda de herramientas del servidor. Contra
    // el host oficial la puede encender `auto`; contra otro host (un proxy, un
    // gateway) solo `always`, porque el intermediario podría no reenviar los
    // bloques de la búsqueda (es lo mismo que hace Claude Code con un base URL
    // ajeno).
    declararBusquedaNativa(this, esHostOficial(opts.baseUrl) ? "oficial" : "compatible");
    // LA MESSAGE BATCHES API, para `layer.batches`. Mismo cuerpo que generate()
    // (sin `stream`, que un lote rechaza) y misma lectura; la HTTP va contra la
    // MISMA base y con las MISMAS cabeceras. Ver lotes-del-proveedor.ts.
    const base = this.opts.baseUrl ?? "https://api.anthropic.com/v1";
    registrarLotes(this, {
      protocolo: "anthropic",
      origen: origenAnthropic(base),
      endpoint: endpointLimpio(base),
      cuerpo: (req) => this.construirCuerpo(req).body,
      // El contrato viaja como la herramienta `bvsala_contract` y su `input` se
      // sirve como texto, igual que en generate(); los tres indicadores del
      // atestado solo importan a la referencia, que un lote no usa.
      leer: (json, req) => this.leerMensaje(json as RespuestaAnthropic, req, false, false, false, false),
      solicitar: (ruta, o) => {
        const url = `${base.replace(/\/$/, "")}${rutaRelativa(ruta)}`;
        return this.fetchImpl(url, {
          method: o.method,
          headers: {
            ...(o.json !== undefined ? { "content-type": "application/json" } : {}),
            "anthropic-version": this.opts.apiVersion ?? "2023-06-01",
            ...(this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {}),
            ...this.opts.headers,
          },
          ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : {}),
          ...(o.signal ? { signal: o.signal } : {}),
        });
      },
    });
  }

  /** The id Anthropic's API sees: bare at `api.anthropic.com`, as written elsewhere. */
  private modeloEnElCable(model: string): string {
    const quitar = this.opts.stripProviderPrefix ?? esHostOficial(this.opts.baseUrl);
    return quitar ? model.replace(/^[^/]+\//, "") : model;
  }

  async generate(req: ProviderRequest, options?: ProviderStreamOptions): Promise<ProviderResponse> {
    const cuerpo = this.construirCuerpo(req);
    // Sin `options`, ninguna señal: la petición HTTP es la de siempre.
    const response = await this.enviar(cuerpo.body, options?.signal);

    if (!response.ok) {
      throw new Error(`provider ${response.status}: ${await safeText(response)}`);
    }
    return this.leer(
      response,
      req,
      cuerpo.contratoNativo,
      cuerpo.turnoAnadido,
      cuerpo.esquemaPorPrompt,
      cuerpo.reenviadas,
    );
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
        construido.reenviadas,
      );
      if (entera.text !== "") yield { type: "text", delta: entera.text };
      yield { type: "done", response: entera };
      return;
    }

    const cuerpo = response.body as (ReadableStream<Uint8Array> & { getReader?: unknown }) | null;
    const fuente: ReadableStream<Uint8Array> | string =
      cuerpo && typeof cuerpo.getReader === "function" ? cuerpo : await response.text();

    let text = "";
    const bloques = new Map<
      number,
      { tipo: string; id?: string; name?: string; json: string; content?: unknown; crudo?: BloqueCrudo }
    >();
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
            // El resultado de la búsqueda llega ENTERO en su `content_block_start`
            // (no tiene deltas): es donde están las referencias.
            ...(b.content !== undefined ? { content: b.content } : {}),
            // Los bloques de la búsqueda, crudos, para devolverlos en el turno
            // siguiente (el `input` del `server_tool_use` llega luego en deltas).
            ...(req.toolSearch && (b.type === "server_tool_use" || b.type === "tool_search_tool_result")
              ? { crudo: b as unknown as BloqueCrudo }
              : {}),
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
    // Sin `message_delta` no hay contador final: los dos a 0 y `complete:false`.
    // Con él, la MISMA aritmética que la respuesta JSON (`anthropic-uso.ts`).
    const calculado = vioDelta ? usoDeMensajes(merged, usoDelta?.output_tokens, razono) : undefined;
    const usage: ProviderUsage = calculado?.usage ?? { inputTokens: 0, outputTokens: 0, complete: false };
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

    const servedServiceTier = tierServidoDe(merged);
    const busqueda = req.toolSearch
      ? usoDeLaBusqueda(
          [...bloques.entries()]
            .sort((x, y) => x[0] - y[0])
            .map(([, b]) => ({ type: b.tipo, name: b.name, content: b.content })),
          construido.reenviadas,
        )
      : undefined;
    // Lo mismo que generate() recuerda de una respuesta JSON, reconstruido del
    // stream: el `server_tool_use` con su `input` ya parseado (un JSON que no
    // parsea deja el par incompleto, y un par incompleto no se recuerda) y el
    // resultado tal cual llegó en su `content_block_start`.
    if (req.toolSearch) {
      const crudos: BloqueCrudo[] = [];
      for (const [, b] of [...bloques.entries()].sort((x, y) => x[0] - y[0])) {
        if (b.tipo === "tool_use") {
          crudos.push({ type: "tool_use", id: b.id, name: b.name });
        } else if (b.tipo === "tool_search_tool_result" && b.crudo) {
          crudos.push(b.crudo);
        } else if (b.tipo === "server_tool_use" && b.crudo) {
          const input = b.json === "" ? (b.crudo["input"] ?? {}) : parsearONada(b.json);
          if (input !== undefined) crudos.push({ ...b.crudo, input });
        }
      }
      this.recordarBusquedas(crudos);
    }

    yield {
      type: "done",
      response: atestiguar(
        {
          text,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(stopReason ? { finishReason: traducirParada(stopReason) } : {}),
          ...(servedServiceTier ? { servedServiceTier } : {}),
          ...(busqueda ? { toolSearch: busqueda } : {}),
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
  //
  // Y, con la búsqueda nativa, cuántos pares de búsqueda de turnos anteriores
  // devolvió en el historial (`reenviadas`), para la traza.
  private construirCuerpo(req: ProviderRequest): {
    body: Record<string, unknown>;
    contratoNativo: boolean;
    turnoAnadido: boolean;
    esquemaPorPrompt: boolean;
    reenviadas: ReenvioDeBusquedas | undefined;
  } {
    // Sin `toolSearch`, `reenvio` es undefined y `repartirMensajes` hace lo de
    // siempre, byte a byte (test/busqueda-entre-turnos.test.ts lo fija).
    const reenvio = this.reenvioDeBusquedas(req);
    const { system, messages, prefijoEnMensajes, prefijoEnSystem, turnoAnadido } = repartirMensajes(
      req,
      reenvio?.anteponer,
    );

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

    // --- Búsqueda de herramientas nativa ---------------------------------------
    // La decide el pipeline (`router/busqueda-nativa.ts`); aquí solo se escribe.
    // Toda herramienta del llamante viaja ENTERA —la API las necesita para buscar
    // y expandir las referencias— y con `defer_loading: true`, salvo las
    // `alwaysLoaded`. La de búsqueda va la PRIMERA y sin diferir, que es lo que
    // cumple «At least one tool […] must stay non-deferred».
    //
    // El orden es el del llamante y la herramienta de búsqueda no cambia entre
    // peticiones, así que la parte del prefijo que el proveedor sí renderiza
    // (búsqueda + no diferidas) es la misma byte a byte pregunte lo que se
    // pregunte, y aunque el catálogo diferido crezca.
    //
    // Ninguna diferida lleva `cache_control` («A tool with `defer_loading: true`
    // can't also carry `cache_control`: the API returns a 400»). Este adaptador
    // nunca marca herramientas —sus puntos de ruptura van en `system` y en los
    // mensajes—, y el contrato, que se añade más abajo, nunca se difiere.
    if (req.toolSearch && tools.length > 0) {
      const fijas = new Set(req.toolSearch.alwaysLoaded);
      for (const t of tools) {
        if (!fijas.has(t["name"] as string)) t["defer_loading"] = true;
      }
      tools.unshift({ ...HERRAMIENTA_DE_BUSQUEDA[req.toolSearch.variant] });
    }

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
          "asynchronous and does not fit a request/response call: send such requests with " +
          "layer.batches.submit() instead.",
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
      req.cachePlacement == null &&
      req.stablePrefixMessages != null &&
      puntosGastados < Math.min(this.opts.maxCacheBreakpoints ?? TOPE_DE_PUNTOS_DE_RUPTURA, TOPE_DE_PUNTOS_DE_RUPTURA)
    ) {
      body["cache_control"] = { type: "ephemeral" };
    }

    return { body, contratoNativo, turnoAnadido, esquemaPorPrompt, reenviadas: reenvio };
  }

  // LOS PARES DE BÚSQUEDA DE TURNOS ANTERIORES, DE VUELTA EN SU TURNO.
  //
  // Solo con `toolSearch` en la petición: sin ella la herramienta de búsqueda no
  // viaja y un `server_tool_use` suyo en el historial no tendría a qué referirse.
  // Para cada turno del asistente que el llamante devuelve con sus `toolCalls`,
  // se buscan en la memoria los pares de la respuesta que generó esas llamadas y
  // se anteponen a su texto. Un par se devuelve ENTERO o no se devuelve:
  //
  //  · si lo corrió la misma variante de búsqueda que viaja ahora (con otra, su
  //    `server_tool_use` nombraría una herramienta que no está en `tools`);
  //  · si TODAS las herramientas que referencia viajan en esta petición. Es la
  //    regla del proveedor (una referencia a una herramienta ausente es un 400)
  //    y es, además, la verja de riesgo de escrituras: si la etapa 6 retiró una
  //    herramienta de escritura porque esta petición no es una acción, el par que
  //    la cargó no puede volver a cargarla por detrás. Retirarla ya cambia
  //    `tools`, así que la caché entera se invalida igual: quitar el par no
  //    rompe ningún prefijo que no estuviera roto;
  //  · una sola vez por petición, aunque el llamante repita un turno.
  //
  // Tocar el contenido de un par (filtrar una referencia) sería mandar algo que
  // la API no devolvió; la documentación pide devolverlo «unchanged».
  //
  // NO SE ACREDITA NADA. Los bloques devueltos son tokens que pone el adaptador
  // y que la cuenta local no ve; con la búsqueda nativa la petición nunca deja
  // registro por referencia (E4-bis), así que no hay regla E2 que atestiguar, y
  // la calibración `k` ya sale por debajo de la real con el catálogo diferido
  // contado entero en local (ver `planearBusquedaNativa` en el pipeline).
  private reenvioDeBusquedas(req: ProviderRequest): ReenvioDeBusquedas | undefined {
    if (!req.toolSearch || !req.tools || req.tools.length === 0) return undefined;
    const disponibles = new Set(req.tools.map((t) => t.id));
    const busqueda: string = HERRAMIENTA_DE_BUSQUEDA[req.toolSearch.variant].name;
    const vistos = new Set<string>();
    const memoria = this.busquedas;
    const reenvio: ReenvioDeBusquedas = {
      resultados: 0,
      herramientas: [],
      anteponer(m) {
        const ids = (m.toolCalls ?? [])
          .map((c) => c.id)
          .filter((id): id is string => typeof id === "string" && id !== "");
        if (ids.length === 0) return undefined;
        const pares = memoria.para(ids);
        if (!pares) return undefined;
        const bloques: BloqueCrudo[] = [];
        for (const p of pares) {
          if (p.busqueda !== busqueda || vistos.has(p.id)) continue;
          if (!p.herramientas.every((h) => disponibles.has(h))) continue;
          vistos.add(p.id);
          bloques.push(p.uso, p.resultado);
          reenvio.resultados += 1;
          for (const h of p.herramientas) if (!reenvio.herramientas.includes(h)) reenvio.herramientas.push(h);
        }
        return bloques.length > 0 ? bloques : undefined;
      },
    };
    return reenvio;
  }

  // Recuerda los pares de búsqueda de una respuesta bajo los ids de sus
  // llamadas a herramienta (las del llamante; el contrato no viaja con la
  // búsqueda nativa). Sin llamadas no hay clave segura (ver
  // busquedas-entre-turnos.ts) y no se recuerda nada.
  private recordarBusquedas(bloques: readonly BloqueCrudo[]): void {
    const ids = bloques
      .filter((b) => b["type"] === "tool_use" && b["name"] !== HERRAMIENTA_DE_CONTRATO)
      .map((b) => b["id"])
      .filter((id): id is string => typeof id === "string" && id !== "");
    if (ids.length === 0) return;
    this.busquedas.recordar(ids, paresDeBusqueda(bloques));
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
  // Y un TERCERO solo si el colocador (`cacheBreakpoints: "auto"`) lo pidió:
  // el último bloque, cuando midió que el tráfico continúa sus prompts.
  //
  // El cuarto se deja libre a proposito: el tope es duro y quien envuelva este
  // adaptador (un gateway, una capa de agentes) necesita sitio para los suyos.
  // Marcar de mas no es gratis — cada escritura lleva prima del 25% —, asi que
  // el techo no se agota por si acaso.
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

    // EL TTL ES UNO POR PETICIÓN. La API exige que los de 1 h vayan DELANTE de
    // los de 5 min; con uno solo para todos los puntos no hay orden que romper,
    // y el colocador ya decidió la hora mirando el último punto, que es el que
    // decide lo que lee el turno siguiente. Un objeto nuevo por bloque: el
    // mismo compartido saldría igual en JSON, pero un llamante que mutase uno
    // los cambiaría todos.
    const marca = (): MarcaDeCache =>
      req.cachePlacement?.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };

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
      ultimoSystem.cache_control = marca();
      presupuesto -= 1;
    }

    // LA COLA (solo con el colocador): el último bloque del último mensaje, para
    // que la continuación de este prompt exacto —el turno siguiente de una
    // conversación o de un bucle de agente— lo lea entero a 0,1× en vez de
    // volver a escribirlo. Va ANTES que el historial en el orden de gasto: con
    // la cola puesta, la búsqueda hacia atrás de 20 posiciones ya encuentra la
    // entrada del turno anterior, y el punto del historial pasa a ser un extra.
    // Es el colocador quien decide si compensa: lo ha medido en el tráfico.
    const ultimoMensaje = messages[messages.length - 1];
    const bloqueDeCola = ultimoMensaje?.content[ultimoMensaje.content.length - 1];
    if (req.cachePlacement?.tail === true && presupuesto > 0 && bloqueDeCola) {
      bloqueDeCola.cache_control = marca();
      presupuesto -= 1;
    }

    // El segundo punto sólo se gasta si de verdad hay historial dentro del
    // prefijo. Marcar el final de `system` dos veces no cachea más y quema un
    // punto del presupuesto del llamante.
    if (presupuesto > 0 && prefijoEnMensajes > 0) {
      const mensaje = messages[Math.min(prefijoEnMensajes, messages.length) - 1];
      const bloque = mensaje?.content[mensaje.content.length - 1];
      if (bloque && bloque.cache_control == null) {
        bloque.cache_control = marca();
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
    reenviadas?: ReenvioDeBusquedas,
  ): Promise<ProviderResponse> {
    const json = (await response.json()) as RespuestaAnthropic;
    return this.leerMensaje(
      json,
      req,
      contratoNativo,
      turnoAnadido,
      esquemaPorPrompt,
      this.opts.requireUsage === true,
      reenviadas,
    );
  }

  // El mensaje ya parseado —el de generate() o el de un resultado de lote— en la
  // forma neutra. `exigirUso` es `requireUsage` en generate(); en un lote va
  // apagado (una línea sin contador no puede tumbar las demás: sale marcada).
  private leerMensaje(
    json: RespuestaAnthropic,
    req: ProviderRequest,
    contratoNativo: boolean,
    turnoAnadido: boolean,
    esquemaPorPrompt: boolean,
    exigirUso: boolean,
    reenviadas?: ReenvioDeBusquedas,
  ): ProviderResponse {
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

    // `input_tokens` es SOLO el resto no cacheado: el total suma los tres
    // contadores. La aritmética vive en `anthropic-uso.ts`, compartida con el
    // adaptador del SDK oficial, para que la misma factura se cuente igual
    // entre por donde entre.
    const uso = json.usage;
    const { usage, entradaAusente, salidaAusente } = usoDeMensajes(uso, uso?.output_tokens, razono);
    if (exigirUso && (entradaAusente || salidaAusente)) {
      throw new Error(mensajeDeUsoIncompleto(uso?.input_tokens, uso?.output_tokens));
    }

    // El tier SERVIDO viaja aquí dentro de `usage`, no en la raíz como en OpenAI,
    // y su vocabulario es otro: "standard" | "priority" | "batch". Se lee aunque
    // esta capa no pida nunca un tier a este proveedor, y no es decorativo: es lo
    // que permite al informe DEMOSTRAR que no hubo descuento en vez de suponerlo.
    const servedServiceTier = tierServidoDe(uso);
    const busqueda = req.toolSearch ? usoDeLaBusqueda(bloques, reenviadas) : undefined;
    // Los pares de esta respuesta, para devolverlos en el turno siguiente. Tal
    // cual llegaron: la API los pide «unchanged».
    if (req.toolSearch) this.recordarBusquedas(bloques as BloqueCrudo[]);

    return atestiguar(
      {
        text: textoFinal,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(json.stop_reason ? { finishReason: traducirParada(json.stop_reason) } : {}),
        ...(servedServiceTier ? { servedServiceTier } : {}),
        usage,
        structuredNatively: req.schema != null && contratoNativo,
        ...(busqueda ? { toolSearch: busqueda } : {}),
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
//
// `anteponer` solo llega con la búsqueda nativa: los pares de búsqueda que el
// adaptador recordó de la respuesta que produjo ese turno del asistente. Van
// DELANTE del texto: la búsqueda ocurre antes de la llamada que la usa, y el
// texto del turno llega de vuelta en una sola pieza (`content`) aunque la API lo
// devolviera partido a los dos lados de la búsqueda. Un texto vacío no se manda
// (un bloque de texto vacío no es contenido válido). Sin `anteponer`, lo de
// siempre.
function repartirMensajes(
  req: ProviderRequest,
  anteponer?: (m: ChatMessage) => BloqueCrudo[] | undefined,
): {
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
    const previos = anteponer && m.role === "assistant" ? anteponer(m) : undefined;
    messages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: previos
        ? [...previos, ...(m.content !== "" ? [{ type: "text" as const, text: m.content }] : [])]
        : [{ type: "text", text: m.content }],
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

interface RespuestaAnthropic {
  content?: {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    /** En `tool_search_tool_result`: las referencias, o el error de la búsqueda. */
    content?: unknown;
  }[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    /** "standard" | "priority" | "batch" — se trata como conjunto abierto. */
    service_tier?: string;
    /** Con compactación: una entrada por iteración de muestreo (ver iteraciones-de-compactacion.ts). */
    iterations?: unknown;
  };
}

// Un evento SSE de la API de Mensajes, con los campos que se leen.
interface EventoAnthropic {
  type?: string;
  index?: number;
  message?: { usage?: UsoAnthropic };
  content_block?: { type?: string; id?: string; name?: string; content?: unknown };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  usage?: UsoAnthropic;
  error?: { type?: string; message?: string };
}

// ¿Habla este adaptador con la API del propio Anthropic? Sin `baseUrl`, sí.
function esHostOficial(baseUrl: string | undefined): boolean {
  try {
    return /(^|\.)api\.anthropic\.com$/i.test(new URL(baseUrl ?? "https://api.anthropic.com/v1").hostname);
  } catch {
    return false;
  }
}

// Lo que hizo la búsqueda de herramientas en UNA respuesta, leído de sus
// bloques (documentación oficial, «Response format»): cada `server_tool_use`
// de una herramienta `tool_search_tool_*` es una búsqueda, y su
// `tool_search_tool_result` trae o bien `tool_search_tool_search_result` con
// `tool_references`, o bien `tool_search_tool_result_error`. Solo se CUENTA: la
// capa no acredita nada por ello; sirve para que el cliente vea cuántas veces
// busca su tráfico, que es el dato que decide si la palanca le compensa.
//
// `reenviadas`: los pares de turnos anteriores que ESTA petición devolvió en el
// historial (ver `reenvioDeBusquedas`). Tampoco se acredita: se informa.
function usoDeLaBusqueda(
  bloques: readonly { type?: string | undefined; name?: string | undefined; content?: unknown }[],
  reenviadas?: { resultados: number; herramientas: string[] },
): ProviderToolSearchUsage {
  let searches = 0;
  let errors = 0;
  const loaded: string[] = [];
  for (const b of bloques) {
    if (b.type === "server_tool_use" && typeof b.name === "string" && b.name.startsWith("tool_search_tool")) {
      searches += 1;
    } else if (b.type === "tool_search_tool_result") {
      const c = b.content as { type?: unknown; tool_references?: unknown } | null | undefined;
      if (c && c.type === "tool_search_tool_result_error") {
        errors += 1;
      } else if (c && Array.isArray(c.tool_references)) {
        for (const r of c.tool_references as { tool_name?: unknown }[]) {
          if (typeof r?.tool_name === "string" && !loaded.includes(r.tool_name)) loaded.push(r.tool_name);
        }
      }
    }
  }
  return {
    searches,
    loaded,
    errors,
    ...(reenviadas && reenviadas.resultados > 0
      ? { resent: { results: reenviadas.resultados, tools: [...reenviadas.herramientas] } }
      : {}),
  };
}

// Un JSON completo, o `undefined` si no parsea.
function parsearONada(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
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

// EL API OFICIAL DE ANTHROPIC, por el host y solo por el host: https y
// `api.anthropic.com` exacto. Un proxy, un gateway, Bedrock o Vertex dan `null`
// —otra lista de precios, u otra factura—, y con `null` lo que valga un lote es
// como mucho `estimated`. NO se exporta: el barril de proveedores reexporta este
// fichero entero hacia los tipos publicados.
function origenAnthropic(base: string): "anthropic" | null {
  try {
    const u = new URL(base);
    return u.protocol === "https:" && u.hostname.toLowerCase() === "api.anthropic.com" ? "anthropic" : null;
  } catch {
    return null;
  }
}
