import { atestiguar, atestiguarOrigen, avisarDelProveedor, declararOrigen, sinContrato } from "./atestado-del-cable.js";
import { apiOficialDe, origenDeLaUrl } from "./origen-oficial.js";
import { sseMessages } from "./sse.js";
import { TIER_DIFERIBLE_OPENAI } from "../economics/tier-diferido.js";
import {
  Acumulador,
  BASE_OFICIAL,
  CABECERA_TIER,
  cabecera,
  contenidosDeGemini,
  modeloDelCable,
  nivelRechazado,
  pensamientoPorEsfuerzo,
  textoSeguro,
  traducirParadaDeGemini,
  usoDeGemini,
  type GoogleThinkingConfig,
  type RespuestaGemini,
} from "./google-cable.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderStreamOptions,
} from "./types.js";

// El adaptador NATIVO de Gemini. Las fuentes oficiales, lo medido en el cable y
// la traducción de cada campo viven en google-cable.ts (interno).

export type { GoogleThinkingConfig };

/**
 * Options for {@link GoogleProvider}, the adapter for Gemini's native API
 * (`generateContent` / `streamGenerateContent`, v1beta).
 */
export interface GoogleOptions {
  /** Gemini API key, sent in the `x-goog-api-key` header. */
  apiKey?: string;
  /**
   * Defaults to `https://generativelanguage.googleapis.com/v1beta`, Google's
   * own API. Override for a gateway or a proxy that speaks the same shape;
   * repeats of calls that went anywhere else are never valued by reference.
   */
  baseUrl?: string;
  /** Extra headers (e.g. for a gateway). */
  headers?: Record<string, string>;
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
  /**
   * When true (recommended for measurement), a response without the prompt
   * and output counters in `usageMetadata` is a hard error instead of being
   * counted as 0 tokens, which would otherwise fabricate a saving.
   */
  requireUsage?: boolean;
  /**
   * Default `generationConfig.thinkingConfig` for every request, sent as
   * written (`{ thinkingLevel: "LOW" }`, `{ thinkingBudget: 0 }`,
   * `{ includeThoughts: true }`). A request's `reasoningEffort` replaces its
   * level or budget. Thought summaries (`includeThoughts`) are billed output
   * and never part of `text`.
   */
  thinkingConfig?: GoogleThinkingConfig;
  /** `safetySettings`, sent as written with every request. */
  safetySettings?: unknown[];
}

// ── El adaptador ─────────────────────────────────────────────────────────────

/**
 * Adapter for Gemini's NATIVE API (`models/{model}:generateContent` and
 * `:streamGenerateContent?alt=sse`, v1beta). Recommended for Gemini; use
 * {@link OpenAICompatibleProvider} for every other provider.
 *
 * Unlike Gemini's OpenAI-compatible endpoint, the native API documents what the
 * layer measures: the system prompt travels in `systemInstruction`; tools are
 * `functionDeclarations` and calls come back as `functionCall` parts whose
 * `thoughtSignature` is returned in `ToolCallRequest.extraContent` (the same
 * shape as the compatible endpoint's) and sent back untouched; `usageMetadata`
 * separates prompt, cached prompt (implicit caching), visible output and
 * thinking (`thoughtsTokenCount`, billed as output); and a blocked prompt
 * (`promptFeedback.blockReason`) or a filtered answer (`finishReason` `SAFETY`,
 * `PROHIBITED_CONTENT`, `BLOCKLIST`…) is reported as
 * `finishReason: "content_filter"` with the native reason in
 * `finishReasonDetail`, so it is measured, never cached and never credited.
 *
 * The output contract travels in `responseJsonSchema` with
 * `responseMimeType: "application/json"`; `maxOutputTokens`, `temperature` and
 * `seed` in `generationConfig`; `reasoningEffort` becomes `thinkingLevel`
 * (Gemini 3) or `thinkingBudget` (Gemini 2.5); a deferrable request asks for
 * `serviceTier: "flex"`. Explicit context caching (`cachedContents`) is not
 * used.
 *
 * Network calls use global `fetch` (Node >= 18) so there is no SDK dependency.
 */
export class GoogleProvider implements Provider {
  readonly id: string;
  private readonly opts: GoogleOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly oficial: boolean;
  // Per model: the thinking level this model rejected, and what is sent instead
  // (a lower-bound level, or nothing).
  private readonly nivelAprendido = new Map<string, Map<string, string | null>>();

  constructor(opts: GoogleOptions = {}) {
    this.opts = opts;
    this.base = (opts.baseUrl ?? BASE_OFICIAL).replace(/\/$/, "");
    this.id = `google:${this.base}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.oficial = apiOficialDe(this.base) === "google";
    // El origen, dicho dos veces como lo dice el adaptador compatible: al
    // pipeline (tier y caché explícita, que aquí no aplica) y a la referencia
    // (E0-bis, #363): solo el host oficial de Google factura a precio de lista.
    declararOrigen(this, this.oficial ? "google" : null);
    atestiguarOrigen(this, origenDeLaUrl(this.base));
  }

  async generate(req: ProviderRequest, options?: ProviderStreamOptions): Promise<ProviderResponse> {
    const model = modeloDelCable(req.model);
    const response = await this.enviarConCorrecciones(model, req, false, options?.signal);
    const json = (await response.json()) as RespuestaGemini;
    const acc = new Acumulador();
    acc.sumar(json);
    return this.cerrar(acc, req, response, json);
  }

  /**
   * Streaming variant of generate() over `streamGenerateContent?alt=sse`.
   * Requests with an output contract or a deferrable tier are served by
   * generate() and yielded as one text event.
   */
  async *generateStream(
    req: ProviderRequest,
    options: ProviderStreamOptions = {},
  ): AsyncGenerator<ProviderStreamEvent, void, undefined> {
    // Con contrato o tier diferible no se streamea, como en el adaptador
    // compatible: el pipeline los entrega enteros, y el respaldo de capacidad
    // de flex (429/503 → estándar) solo existe fuera del stream.
    if (req.schema != null || req.deferrable === true) {
      const r = await this.generate(req, options);
      if (r.text !== "") yield { type: "text", delta: r.text };
      yield { type: "done", response: r };
      return;
    }
    const model = modeloDelCable(req.model);
    const response = await this.enviarConCorrecciones(model, req, true, options.signal);
    const acc = new Acumulador();

    // Un servidor que ignora `alt=sse` contesta el array JSON de trozos (la
    // forma por defecto de `streamGenerateContent`) o un objeto: la llamada ya
    // está hecha y facturada, así que se lee en vez de tirarla.
    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      const json = (await response.json()) as RespuestaGemini | RespuestaGemini[];
      for (const trozo of Array.isArray(json) ? json : [json]) acc.sumar(trozo);
      if (!acc.terminado()) throw new Error("provider stream ended before completion (no finishReason)");
      if (acc.texto !== "") yield { type: "text", delta: acc.texto };
      yield { type: "done", response: this.cerrar(acc, req, response, json) };
      return;
    }

    const cuerpo = response.body as (ReadableStream<Uint8Array> & { getReader?: unknown }) | null;
    const fuente: ReadableStream<Uint8Array> | string =
      cuerpo && typeof cuerpo.getReader === "function" ? cuerpo : await response.text();
    for await (const msg of sseMessages(fuente)) {
      let trozo: RespuestaGemini;
      try {
        trozo = JSON.parse(msg.data) as RespuestaGemini;
      } catch {
        continue;
      }
      if (trozo === null || typeof trozo !== "object") continue;
      const delta = acc.sumar(trozo);
      if (delta !== "") yield { type: "text", delta };
    }
    // MEDIA RESPUESTA NO ES UNA RESPUESTA: sin `finishReason` (ni bloqueo del
    // prompt) el proveedor no dijo que hubiera terminado.
    if (!acc.terminado()) throw new Error("provider stream ended before completion (no finishReason)");
    yield { type: "done", response: this.cerrar(acc, req, response, acc.uso ?? null) };
  }

  // Envía, y corrige UNA vez por causa los 400 que se rechazan antes de generar
  // (nada se factura dos veces): hoy, un nivel de pensamiento que el modelo no
  // admite. Cualquier otro rechazo sale como `provider <status>: <detalle>`, el
  // formato que el pipeline lee para el respaldo de capacidad de flex.
  //
  // EL 400 SE COMPARA CON LO QUE VIAJÓ EN ESA PETICIÓN, no con lo que se mandaría
  // ahora. Con peticiones en paralelo sobre el mismo adaptador (lo normal detrás
  // de la capa), otra puede aprender el sustituto mientras esta espera su 400:
  // rehacer el cuerpo aquí daría LOW, no casaría con el MINIMAL rechazado y el
  // 400 subía al cliente sin corregir. Lo midió el banco semanal (run
  // 36771607171, XSTest · gemini-3.8-flash, ítems 5 y 443 en vuelo a la vez) y se
  // reprodujo en vivo el 2026-10-01 con dos llamadas paralelas.
  private async enviarConCorrecciones(
    model: string,
    req: ProviderRequest,
    stream: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    let cuerpo = this.cuerpo(model, req);
    let response = await this.enviar(model, cuerpo, stream, signal);
    for (let vueltas = 0; vueltas < 3 && !response.ok && response.status === 400; vueltas++) {
      const detalle = await textoSeguro(response);
      const nivel = nivelRechazado(detalle);
      const enviado = cuerpo.generationConfig?.thinkingConfig?.thinkingLevel;
      if (nivel === null || enviado === undefined || nivel !== String(enviado).toUpperCase()) {
        throw new Error(`provider ${response.status}: ${detalle}`);
      }
      // Si otra petición ya lo aprendió, no se reescribe ni se vuelve a avisar.
      const memo = this.nivelAprendido.get(model) ?? new Map<string, string | null>();
      if (!memo.has(nivel)) {
        const sustituto = nivel === "MINIMAL" ? "LOW" : null;
        memo.set(nivel, sustituto);
        this.nivelAprendido.set(model, memo);
        avisarDelProveedor(
          this,
          `google-nivel:${this.base}:${model}:${nivel}`,
          `[bvsala] Model "${model}" rejects thinkingLevel ${nivel} with a 400, so ` +
            (sustituto ? `${sustituto} is sent instead` : "no thinking level is sent (the model's default)") +
            " (the rejected request was not billed; the model is noted and the following requests go straight there).",
        );
      }
      cuerpo = this.cuerpo(model, req);
      response = await this.enviar(model, cuerpo, stream, signal);
    }
    if (!response.ok) throw new Error(`provider ${response.status}: ${await textoSeguro(response)}`);
    return response;
  }

  private async enviar(
    model: string,
    cuerpo: ReturnType<GoogleProvider["cuerpo"]>,
    stream: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const metodo = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return await this.fetchImpl(`${this.base}/models/${encodeURIComponent(model)}:${metodo}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.apiKey ? { "x-goog-api-key": this.opts.apiKey } : {}),
        ...this.opts.headers,
      },
      body: JSON.stringify(cuerpo),
      ...(signal ? { signal } : {}),
    });
  }

  // El cuerpo de `generateContent`. Puro dado el estado aprendido; se arma UNA
  // vez por envío y la corrección mira ese mismo objeto.
  private cuerpo(
    model: string,
    req: ProviderRequest,
  ): { generationConfig?: { thinkingConfig?: GoogleThinkingConfig } } & Record<string, unknown> {
    const { systemInstruction, contents } = contenidosDeGemini(req.messages);
    const generationConfig: Record<string, unknown> = {};
    if (req.maxOutputTokens != null) generationConfig["maxOutputTokens"] = req.maxOutputTokens;
    if (req.temperature != null) generationConfig["temperature"] = req.temperature;
    if (req.seed != null) generationConfig["seed"] = req.seed;
    // EL CONTRATO, TAL CUAL: el esquema del llamante en `responseJsonSchema` (JSON
    // Schema, que es lo que son los contratos de la capa), con el MIME que la
    // referencia exige a su lado. `responseSchema` es un subconjunto de OpenAPI
    // y la referencia lo marca obsoleto; no se reescribe el esquema a él.
    if (req.schema != null) {
      generationConfig["responseMimeType"] = "application/json";
      generationConfig["responseJsonSchema"] = req.schema;
    }
    const pensamiento = this.pensamiento(model, req);
    if (pensamiento !== undefined) generationConfig["thinkingConfig"] = pensamiento;

    const tools =
      req.tools && req.tools.length > 0
        ? [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.id,
                // `description` es obligatoria en la referencia; vacía si el
                // llamante no la dio (el adaptador no escribe nada por él).
                description: t.description ?? "",
                // Sin parámetros no viaja nada: el campo es opcional aquí.
                ...(t.parameters != null ? { parametersJsonSchema: t.parameters } : {}),
              })),
            },
          ]
        : undefined;

    return {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(tools ? { tools } : {}),
      ...(this.opts.safetySettings ? { safetySettings: this.opts.safetySettings } : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      // EL TIER DIFERIBLE: Flex, la mitad de precio, «specify the service_tier as
      // flex» (guía de Flex); en REST el campo es `serviceTier` (referencia). Solo
      // si el llamante lo declaró: lo que se acredita es el tier SERVIDO.
      ...(req.deferrable === true ? { serviceTier: TIER_DIFERIBLE_OPENAI } : {}),
    };
  }

  // El `thinkingConfig` que viaja: el de las opciones, con el nivel o el
  // presupuesto que diga `reasoningEffort`, y corregido por lo que este modelo
  // ya rechazó.
  private pensamiento(model: string, req: ProviderRequest): GoogleThinkingConfig | undefined {
    let config: GoogleThinkingConfig | undefined = this.opts.thinkingConfig ? { ...this.opts.thinkingConfig } : undefined;
    if (req.reasoningEffort != null) {
      const t = pensamientoPorEsfuerzo(model, req.reasoningEffort);
      if (t === null) {
        avisarDelProveedor(
          this,
          `google-esfuerzo:${model}:${req.reasoningEffort}`,
          `[bvsala] reasoningEffort "${req.reasoningEffort}" has no equivalent on "${model}" ` +
            "(thinking cannot be turned off on Gemini 2.5 Pro), so no thinking config is sent for it.",
        );
      } else {
        if (t.noSeApaga) {
          avisarDelProveedor(
            this,
            `google-no-se-apaga:${model}`,
            `[bvsala] Thinking cannot be turned off on "${model}" (Google: «Reasoning cannot be turned off ` +
              `for Gemini 2.5 Pro or 3 models»), so reasoningEffort "none" is sent as the lowest level, ` +
              `${String(t.config.thinkingLevel)}. Its thinking tokens are billed as output.`,
          );
        }
        const { thinkingLevel: _l, thinkingBudget: _b, ...resto } = config ?? {};
        config = { ...resto, ...t.config };
      }
    }
    const nivel = config?.thinkingLevel;
    if (config && typeof nivel === "string") {
      const memo = this.nivelAprendido.get(model);
      const clave = nivel.toUpperCase();
      if (memo?.has(clave)) {
        const sustituto = memo.get(clave);
        const { thinkingLevel: _l, ...resto } = config;
        config = sustituto ? { ...resto, thinkingLevel: sustituto } : resto;
      }
    }
    return config && Object.keys(config).length > 0 ? config : undefined;
  }

  // La respuesta neutra, atestiguada.
  private cerrar(
    acc: Acumulador,
    req: ProviderRequest,
    response: Response,
    raw: unknown,
  ): ProviderResponse {
    const usage = usoDeGemini(acc.uso, acc.huboPensamiento);
    if (this.opts.requireUsage === true && usage.complete === false) {
      throw new Error(
        `provider returned incomplete usage (promptTokenCount=${acc.uso?.promptTokenCount ?? "absent"}, ` +
          `candidatesTokenCount=${acc.uso?.candidatesTokenCount ?? "absent"}); cannot measure cost.`,
      );
    }
    const parada = traducirParadaDeGemini(acc.paradaNativa, acc.bloqueo, acc.llamadas.length > 0);

    // EL TIER SERVIDO: el cuerpo (`usageMetadata.serviceTier`) manda; la
    // cabecera, solo en el host oficial y solo si el cuerpo calló.
    let servido = typeof acc.uso?.serviceTier === "string" && acc.uso.serviceTier !== "" ? acc.uso.serviceTier : undefined;
    let tierLeidoDe: "cuerpo" | "cabecera" | undefined = servido ? "cuerpo" : undefined;
    if (!servido && this.oficial) {
      servido = cabecera(response, CABECERA_TIER);
      if (servido) tierLeidoDe = "cabecera";
    }
    return atestiguar(
      {
        text: acc.texto,
        ...(acc.llamadas.length > 0 ? { toolCalls: acc.llamadas } : {}),
        ...(parada.parada !== undefined ? { finishReason: parada.parada } : {}),
        ...(parada.detalle !== undefined ? { finishReasonDetail: parada.detalle } : {}),
        ...(servido ? { servedServiceTier: servido } : {}),
        ...(req.deferrable === true ? { requestedServiceTier: TIER_DIFERIBLE_OPENAI } : {}),
        ...(parada.reproducible ? {} : { replayable: false }),
        ...(acc.idDeRespuesta ? { providerMessageId: acc.idDeRespuesta } : {}),
        usage,
        structuredNatively: req.schema != null,
        raw,
      },
      // LO QUE PUSO EL CABLE, para la regla de la referencia. El esquema viaja
      // TAL CUAL en el parámetro nativo (`responseJsonSchema`, envoltorio fijo:
      // el MIME), sin una palabra en el prompt. Pero NO se atestigua estricto:
      // Google no promete que lo imponga entero («Not all JSON Schema features
      // are supported», guía de salidas estructuradas), así que una repetición
      // con esquema no deja referencia (E5). Y ninguna pieza del adaptador:
      // las herramientas sin parámetros no llevan esquema vacío.
      {
        ...sinContrato(0),
        esquemaEnFormatoNativo: req.schema != null,
        origen: this.oficial ? "google" : null,
        ...(tierLeidoDe ? { tierLeidoDe } : {}),
      },
    );
  }
}

