import { TIER_DIFERIBLE_OPENAI } from "../economics/tier-diferido.js";
import { avisarUnaVez } from "../util/warn-once.js";
import type { Provider, ProviderRequest, ProviderResponse } from "./types.js";

/**
 * OpenAI-compatible provider adapter (chat/completions shape).
 *
 * Works with any endpoint that speaks the OpenAI Chat Completions API — OpenAI,
 * Azure, vLLM, SGLang, TGI, a local gateway, or Vercel AI Gateway with a
 * "provider/model" string. Structured output is requested via `response_format`
 * with a JSON schema when a contract is present, which is the provider-native
 * constrained-decoding path preferred by the layer.
 *
 * Models that predate structured outputs reject `response_format` with a 400. The
 * adapter degrades for those: it repeats the request once with the schema carried
 * in the prompt instead, remembers the model so later requests skip the rejected
 * attempt, and reports `structuredNatively: false` so the savings report states
 * `constraints.backend: "none"` rather than claiming a guarantee the provider
 * never gave.
 *
 * Network calls use global `fetch` (Node >= 18) so there is no SDK dependency.
 */
export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  /** Strip the "provider/" prefix from model ids before sending. */
  stripProviderPrefix?: boolean;
  /** Extra headers (e.g. for a gateway). */
  headers?: Record<string, string>;
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
  /**
   * When true (recommended for measurement), a response whose `usage` block is
   * missing or reports zero prompt/completion tokens for a call that actually
   * ran is treated as a HARD ERROR instead of being silently coerced to
   * 0 tokens. This closes the single most dishonest failure mode: an absent
   * usage payload otherwise becomes `actual cost = 0` → a fabricated 100%
   * saving. Benchmarks that make real cost claims must set this.
   */
  requireUsage?: boolean;
}

/**
 * ¿Cumple este esquema las reglas del modo `strict` de OpenAI?
 *
 * Son dos, y aplican a TODO objeto anidado:
 *   1. `additionalProperties: false`.
 *   2. `required` tiene que listar TODAS las claves de `properties` — no solo
 *      las obligatorias. En modo strict no existe el campo opcional.
 *
 * Un esquema perfectamente válido como
 *   { properties: { answer, refs }, required: ["answer"] }
 * incumple la segunda y el proveedor responde 400. No es un fallo del cliente:
 * es una restricción de OpenAI que JSON Schema no tiene.
 */
export function isStrictCompatible(schema: unknown): boolean {
  if (schema == null || typeof schema !== "object") return true;
  const s = schema as Record<string, unknown>;

  const props = s["properties"];
  if (props && typeof props === "object") {
    if (s["additionalProperties"] !== false) return false;
    const claves = Object.keys(props as Record<string, unknown>);
    const req = Array.isArray(s["required"]) ? (s["required"] as unknown[]).map(String) : [];
    if (claves.some((k) => !req.includes(k))) return false;
    for (const v of Object.values(props as Record<string, unknown>)) {
      if (!isStrictCompatible(v)) return false;
    }
  }

  // Ramas donde también puede esconderse un objeto.
  if (s["items"] !== undefined && !isStrictCompatible(s["items"])) return false;
  for (const rama of ["anyOf", "oneOf", "allOf"]) {
    const xs = s[rama];
    if (Array.isArray(xs) && xs.some((x) => !isStrictCompatible(x))) return false;
  }
  const defs = s["$defs"] ?? s["definitions"];
  if (defs && typeof defs === "object") {
    if (Object.values(defs as Record<string, unknown>).some((d) => !isStrictCompatible(d))) return false;
  }
  return true;
}

/**
 * ¿Este 400 dice que el MODELO no conoce `response_format`?
 *
 * Los modelos anteriores a structured outputs (gpt-3.5-turbo, gpt-4, gpt-4-turbo)
 * rechazan el parámetro entero. Medido contra la API real, el cuerpo es
 * «Invalid parameter: 'response_format' of type 'json_schema' is not supported
 * with this model»; otros endpoints compatibles contestan «Unrecognized request
 * argument supplied: response_format».
 *
 * Se descarta a propósito «Invalid schema for response_format»: ahí el parámetro
 * SÍ existe y lo que está mal es el contrato de quien llama. Degradar en ese caso
 * cambiaría un error de configuración visible por una garantía silenciosamente
 * más débil, que es justo lo que esta capa se niega a hacer.
 */
function esResponseFormatNoSoportado(detalle: string): boolean {
  if (!/response_format/i.test(detalle)) return false;
  if (/invalid schema/i.test(detalle)) return false;
  return /invalid parameter|not supported|unsupported|unrecognized request argument|unknown parameter/i.test(
    detalle,
  );
}

/**
 * Instrucción que sustituye a `response_format` cuando el modelo no lo admite.
 *
 * El esquema tiene que VIAJAR igual: es lo único que guía al modelo cuando el
 * proveedor no lo va a imponer. Va como último mensaje de sistema porque es la
 * posición que menos se pierde entre el material de la petición.
 *
 * Estos tokens los factura el proveedor y NO los ve la cuenta local del prompt
 * (`sentInputLocal`), porque los añade el adaptador. El sesgo va en la dirección
 * segura: `actualInput` sube, el baseline no, así que el ahorro publicado sale
 * MENOR del real. Nunca al revés, que es lo que no se podría tolerar.
 */
function instruccionDeJsonPorPrompt(schema: unknown): string {
  return (
    "Respond with a single JSON object and nothing else: no prose, no explanation, " +
    "no markdown code fences. The object must validate against this JSON Schema:\n" +
    JSON.stringify(schema)
  );
}

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  private readonly opts: OpenAICompatibleOptions;
  private readonly fetchImpl: typeof fetch;
  /** Models of this endpoint already known to reject `response_format`. */
  private readonly sinResponseFormat = new Set<string>();

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.id = `openai-compatible:${opts.baseUrl}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    const model = this.opts.stripProviderPrefix
      ? req.model.replace(/^[^/]+\//, "")
      : req.model;

    // Se intenta la vía nativa salvo que ESTE modelo ya la haya rechazado antes.
    // Ese conjunto es lo que acota el coste del descubrimiento: el viaje de más
    // se paga UNA vez por modelo y por instancia, no en cada petición.
    let nativo = req.schema != null && !this.sinResponseFormat.has(model);
    let response = await this.enviar(model, req, nativo);

    // DEGRADAR, NO REVENTAR. Tres modelos vivos y de uso corriente (gpt-3.5-turbo,
    // gpt-4, gpt-4-turbo) son anteriores a structured outputs y devuelven 400 al
    // ver `response_format`. Ese 400 llegaba crudo al cliente, así que una elección
    // de modelo perfectamente legítima parecía una avería de BV-SALA.
    //
    // Por qué aquí SÍ se reintenta, cuando el truncado por `maxOutputTokens` y el
    // `pattern` no compilable NO: aquellos son respuestas GENERADAS y facturadas,
    // así que el reintento es una segunda llamada pagada para el mismo fallo. Un
    // 400 se rechaza antes de generar un solo token — no hay nada que duplicar—, y
    // además el segundo intento ataca una causa distinta, no repite el mismo
    // envío. El memo de arriba impide que se convierta en un bucle.
    //
    // Por eso tampoco cuenta como `retries` en el libro: el intento rechazado no
    // consumió tokens ni llegó a facturarse, y apuntarlo inflaría un contador que
    // el cliente contrasta con su factura.
    if (!response.ok && response.status === 400 && nativo) {
      const detalle = await safeText(response);
      if (!esResponseFormatNoSoportado(detalle)) {
        throw new Error(`provider ${response.status}: ${detalle}`);
      }
      this.sinResponseFormat.add(model);
      avisarUnaVez(
        `sin-response-format:${model}`,
        `[bvsala] El modelo "${model}" rechaza \`response_format\` con un 400: no tiene ` +
          "structured outputs. Se repite la petición pidiendo el JSON por prompt (una sola vez: " +
          "el modelo queda anotado y las siguientes van directas). El esquema sigue viajando y el " +
          "layer sigue validando, pero la garantía la da el layer, no el proveedor, y el informe " +
          'lo dice: `constraints.backend: "none"`. Para recuperar la garantía nativa, usa un ' +
          "modelo con structured outputs (gpt-4o o posterior).",
      );
      nativo = false;
      response = await this.enviar(model, req, false);
    }

    if (!response.ok) {
      const detail = await safeText(response);
      throw new Error(`provider ${response.status}: ${detail}`);
    }

    return this.leer(response, req, nativo);
  }

  /** Build the request body and post it. `nativo` selects the `response_format` path. */
  private async enviar(
    model: string,
    req: ProviderRequest,
    nativo: boolean,
  ): Promise<Response> {
    // EL CICLO DE HERRAMIENTAS TIENE QUE PODER VOLVER. Chat Completions exige que
    // un mensaje `role:"tool"` lleve `tool_call_id` y siga a un `assistant` con
    // `tool_calls`; sin las dos cosas responde 400 y la petición del cliente
    // revienta —justo en el flujo que el propio SDK documenta (SavingsResult
    // .toolCalls: «treat an empty text together with a populated toolCalls as a
    // tool invocation to execute»)—. El mapeo a `{role, content}` a secas
    // descartaba `toolCallId` y no emitía `tool_calls`, así que el turno de vuelta
    // no atravesaba este adaptador.
    const mensajes = req.messages.map((m): Record<string, unknown> => {
      if (m.role === "tool") {
        return {
          role: "tool",
          content: m.content,
          // El id que el modelo pidió ejecutar. Se acepta también desde `metadata`
          // por compatibilidad con llamantes que lo pasaban ahí.
          tool_call_id: m.toolCallId ?? (m.metadata?.["tool_call_id"] as string | undefined),
          ...(m.name ? { name: m.name } : {}),
        };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          // Con `tool_calls`, `content` puede ir vacío o null; se manda tal cual.
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc, i) => ({
            id: tc.id ?? `call_${i}`,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });
    if (req.schema && !nativo) {
      mensajes.push({ role: "system", content: instruccionDeJsonPorPrompt(req.schema) });
    }

    const body: Record<string, unknown> = {
      model,
      messages: mensajes,
    };
    if (req.maxOutputTokens != null) body["max_tokens"] = req.maxOutputTokens;
    if (req.temperature != null) body["temperature"] = req.temperature;
    if (req.seed != null) body["seed"] = req.seed;
    // OpenAI cachea el prefijo SOLA —no hay puntos de ruptura que marcar— pero
    // enruta por instancia, y una petición que aterriza en otra instancia no
    // encuentra el prefijo aunque sea idéntico. `prompt_cache_key` agrupa las
    // que comparten prefijo para que caigan en la misma.
    //
    // Es una PISTA DE ENRUTADO, nunca una identidad: no aísla nada, así que el
    // pipeline la deriva del prefijo y jamás del tenant ni del usuario. Meter
    // ahí un identificador de cliente no daría privacidad y sí la ilusión de
    // tenerla — el mismo fallo que la caché exacta cerró keyeando por tenant de
    // verdad.
    if (req.promptCacheKey != null) body["prompt_cache_key"] = req.promptCacheKey;
    // EL TIER DIFERIBLE. `flex` cobra los tokens a tarifa de la Batch API —la
    // mitad— a cambio de una latencia mayor y variable, y compone con la caché de
    // prefijo en vez de pisarla (la propia guía de OpenAI dice que los descuentos
    // de caché se suman encima). Por eso va DESPUÉS de `prompt_cache_key` y no en
    // su lugar: las dos palancas viajan juntas.
    //
    // Se manda SOLO cuando el llamante lo declaró. Y hay una razón extra para no
    // mandar `service_tier: "default"` cuando no lo declaró, que parece inocuo:
    // el valor por defecto de OpenAI es `auto`, o sea «lo que diga la
    // configuración del proyecto», y fijar `default` desde aquí le anularía al
    // cliente una elección que hizo en su panel.
    if (req.deferrable === true) body["service_tier"] = TIER_DIFERIBLE_OPENAI;
    // `stablePrefixMessages` se ignora a propósito: aquí no hay nada que marcar.
    // Ignorarlo no pierde el descuento (es automático); marcarlo no existe.
    if (req.schema && nativo) {
      // `strict: true` iba fijo, y eso convertía cualquier contrato con un campo
      // OPCIONAL en un 400 duro contra OpenAI: en modo strict, `required` tiene
      // que listar todas las claves de `properties`. Un esquema tan corriente
      // como {answer, refs?} tumbaba la petición entera — y también el reintento
      // de fail-open, que reenvía el mismo esquema.
      //
      // Deliberadamente NO reescribimos el esquema del cliente. La receta de
      // OpenAI para lo opcional es exigir la clave y permitirle null, pero eso
      // cambia lo que llega: el campo pasa de AUSENTE a presente-y-null, que es
      // precisamente lo que nuestro propio validador rechazaría. Cambiaríamos un
      // fallo ruidoso por uno silencioso, y encima del lado del cliente.
      //
      // Así que degradamos a `strict: false`. El esquema sigue viajando, así que
      // el modelo sigue guiado; lo que se pierde es la garantía del proveedor, no
      // la nuestra: el layer valida igual y `structurallyValid` sigue diciendo la
      // verdad sobre lo que se sirvió.
      const strict = isStrictCompatible(req.schema);
      if (!strict) {
        avisarUnaVez(
          "strict-incompatible",
          "[bvsala] El contrato de respuesta no cumple el modo `strict` de OpenAI " +
            "(en strict, `required` debe listar TODAS las claves de `properties`, y todo objeto " +
            "necesita `additionalProperties: false`). Se envía el esquema con `strict: false`: " +
            "el modelo sigue guiado y el layer sigue validando, pero la garantía la da el layer, " +
            "no el proveedor. Para recuperarla, haz obligatorias todas las claves del contrato.",
        );
      }
      body["response_format"] = {
        type: "json_schema",
        json_schema: { name: "bvsala_contract", schema: req.schema, strict },
      };
    }
    // Transmit tools in the provider-native `tools` field so their JSON schema
    // is metered inside the real prompt_tokens. Without this the tool-selection
    // lever's savings can never be MEASURED (dropped-tool tokens would never
    // have been on the wire in the first place).
    if (req.tools && req.tools.length > 0) {
      body["tools"] = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.id,
          ...(t.description ? { description: t.description } : {}),
          parameters: t.parameters ?? { type: "object", properties: {} },
        },
      }));
    }

    return await this.fetchImpl(
      `${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          ...this.opts.headers,
        },
        body: JSON.stringify(body),
      },
    );
  }

  /** Translate a 2xx endpoint response into the provider-neutral shape. */
  private async leer(
    response: Response,
    req: ProviderRequest,
    nativo: boolean,
  ): Promise<ProviderResponse> {
    const json = (await response.json()) as OpenAIChatResponse;
    const mensaje = json.choices?.[0]?.message as
      | { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }
      | undefined;
    const text = mensaje?.content ?? "";

    // Cuando el modelo invoca una herramienta devuelve `content: null` +
    // `tool_calls`. El `?? ""` de arriba convertía eso en cadena vacía y la
    // petición del modelo se PERDÍA: la capa servía "" como si fuera la respuesta,
    // la cacheaba, y la siguiente repetición acreditaba 100 % de ahorro sobre una
    // acción que nunca se ejecutó. Ahora se propagan.
    const toolCalls = (mensaje?.tool_calls ?? [])
      .map((tc) => ({
        ...(tc.id ? { id: tc.id } : {}),
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "",
      }))
      .filter((tc) => tc.name !== "");
    const usage = json.usage ?? {};
    const inputTokens = usage.prompt_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;

    // Una llamada que devolvió contenido pero no su contabilidad de tokens no se
    // puede tarifar con honestidad: 0 tokens medidos frente a un baseline
    // modelado da un ahorro fabricado cercano al 100%.
    //
    // La guardia comprueba AUSENCIA, no valor cero, y por separado en cada
    // contador. Antes era `inputTokens <= 0 && outputTokens <= 0`, con dos
    // fallos: (1) el `&&` sólo saltaba si faltaban AMBOS, así que un bloque
    // `usage` parcial —prompt_tokens presente, completion_tokens ausente, algo
    // habitual en gateways y en streaming— se colaba como 0 y fabricaba ahorro;
    // (2) `<= 0` confundía "no lo sé" con "de verdad fueron 0", y un cero
    // legítimo (respuesta vacía, parada inmediata) es medible y no debe fallar.
    const inputAbsent = typeof usage.prompt_tokens !== "number";
    const outputAbsent = typeof usage.completion_tokens !== "number";
    if (this.opts.requireUsage && (inputAbsent || outputAbsent)) {
      throw new Error(
        `provider returned incomplete usage (prompt=${usage.prompt_tokens ?? "absent"}, ` +
          `completion=${usage.completion_tokens ?? "absent"}); cannot measure cost. ` +
          `For gateways/streaming, ensure usage reporting is enabled.`,
      );
    }

    const finishReason = json.choices?.[0]?.finish_reason;

    // EL TIER QUE SE SIRVIÓ, NO EL QUE SE PIDIÓ. OpenAI lo dice sin rodeos: «the
    // response body will include the `service_tier` value based on the processing
    // mode actually used to serve the request. This response value may be
    // different from the value set in the parameter.» Un `flex` degradado
    // contesta `default` y se cobra entero, en silencio.
    //
    // Se propaga TAL CUAL, sin normalizar y sin rellenar cuando falta: el
    // vocabulario es del proveedor y puede crecer, y un hueco significa «no se
    // sabe», que no es lo mismo que «estándar». Quien decide qué se acredita es
    // `veredictoDelTier`, y ante un valor que no conoce no acredita nada.
    const servedServiceTier =
      typeof json.service_tier === "string" && json.service_tier !== ""
        ? json.service_tier
        : undefined;

    return {
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(servedServiceTier ? { servedServiceTier } : {}),
      ...(req.deferrable === true ? { requestedServiceTier: TIER_DIFERIBLE_OPENAI } : {}),
      usage: {
        inputTokens,
        outputTokens,
        ...(usage.prompt_tokens_details?.cached_tokens != null
          ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens }
          : {}),
      },
      // Solo es NATIVO si el contrato viajó en `response_format`. Cuando se
      // degradó a pedir el JSON por prompt, quien impone la forma es el layer al
      // validar, y de este campo depende que el informe no publique una garantía
      // del proveedor que el proveedor no dio.
      structuredNatively: req.schema != null && nativo,
      raw: json,
    };
  }
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  /** 'auto' | 'default' | 'flex' | 'scale' | 'priority' | 'fast' — open set on purpose. */
  service_tier?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
