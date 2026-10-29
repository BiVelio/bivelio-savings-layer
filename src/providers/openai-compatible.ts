import { TIER_DIFERIBLE_OPENAI } from "../economics/tier-diferido.js";
import { explicitaAplicable } from "../economics/escrituras-de-cache.js";
import { avisarDelProveedor } from "./atestado-del-cable.js";
import { comprobarSenalDeProvider } from "./abort.js";
import {
  atestiguar,
  atestiguarOrigen,
  declararOrigen,
  herramientasSinParametros,
  sinContrato,
} from "./atestado-del-cable.js";
import { endpointLimpio, registrarLotes, rutaRelativa } from "./lotes-del-proveedor.js";
import { apiOficialDe, origenDeLaUrl } from "./origen-oficial.js";
import { cerrarParada } from "./motivo-de-parada.js";
import { salidaOculta } from "./salida-oculta.js";
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
 * OpenAI-only request fields are sent only to OpenAI's own API
 * (`prompt_cache_key`, see {@link OpenAICompatibleOptions.sendPromptCacheKey}).
 * An optional field an endpoint still rejects by name with a 400/422
 * (`prompt_cache_key`, `service_tier`, `seed`) is dropped and the request
 * repeated once, and the model is remembered, as with `response_format`.
 *
 * Output is counted as the provider bills it: where `total_tokens` exceeds
 * `prompt_tokens + completion_tokens` (Gemini's OpenAI-compatible endpoint
 * leaves its thinking tokens out of `completion_tokens`), the difference is
 * added to the output and reported as reasoning. Against OpenAI's own API,
 * whose `completion_tokens` already include reasoning, nothing is added. A
 * content-filter stop with a reason (Gemini's `"content_filter: OTHER"`) is
 * reported as `finishReason: "content_filter"`, the reason in
 * `finishReasonDetail`.
 *
 * Network calls use global `fetch` (Node >= 18) so there is no SDK dependency.
 */
export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  /**
   * Strip the `provider/` prefix from model ids before sending (`openai/gpt-4o-mini`
   * → `gpt-4o-mini`).
   *
   * Default (undefined): strip when `baseUrl` is OpenAI's own API, an Azure
   * OpenAI endpoint or Google's own Gemini API
   * (https://generativelanguage.googleapis.com, whose OpenAI-compatible
   * endpoint answers 404 «models/google/gemini-… is not found» to a prefixed
   * id), keep otherwise. OpenAI rejects a prefixed id with a 404
   * ("model does not exist"), so the qualified ids the layer uses everywhere
   * else — pricing, cache keys, the report — would break the very first call
   * that reaches the provider. A gateway or a self-hosted server with a
   * namespaced model name usually WANTS the prefix, so it is kept there. Set `true`/`false` to decide explicitly; an explicit value
   * always wins.
   */
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
  /**
   * Which Chat Completions field carries the output cap (`maxOutputTokens`).
   *
   * Default (undefined): `max_completion_tokens` when `baseUrl` is OpenAI's own
   * API (https://api.openai.com), `max_tokens` everywhere else. OpenAI
   * deprecated `max_tokens` when it introduced `max_completion_tokens`
   * (2024-09-12) and its reasoning models (o-series, gpt-5.x) reject it with a
   * 400; `max_completion_tokens` is accepted by every current OpenAI chat
   * model. OpenAI-compatible servers (proxies, self-hosted inference servers,
   * routers, Azure with an older api-version, a local gateway) understand
   * `max_tokens`, and some silently IGNORE a field they do not know, which
   * would drop the cap without an error.
   *
   * With the default, a 400/422 that names the field sent as unsupported is
   * retried once with the other one (it is rejected before any token is
   * generated, so nothing is billed twice) and the model is remembered. An
   * explicit value always wins and is never switched.
   */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /**
   * Whether to send `prompt_cache_key`, the routing hint OpenAI uses to land
   * requests that share a prefix on the same cache instance.
   *
   * Default (undefined): only when `baseUrl` is OpenAI's own API
   * (https://api.openai.com). The field is OpenAI's, and strict endpoints
   * reject what they do not know: Gemini's OpenAI-compatible endpoint answers
   * 400 «Unknown name "prompt_cache_key"», so from 0.4.1 to 0.4.31 every
   * request with a cached prefix failed there. Set `true` for a proxy or router
   * in front of OpenAI that forwards it (if the endpoint rejects it anyway,
   * the request is repeated once without it and the model is remembered), or
   * `false` to never send it.
   */
  sendPromptCacheKey?: boolean;
}

/** El campo de Chat Completions que lleva el tope de salida. */
type CampoDeTope = "max_tokens" | "max_completion_tokens";

/**
 * ¿Este 400/422 dice que el proveedor NO ADMITE el campo de tope que se mandó?
 *
 * Medido en vivo con gpt-5.4-mini (0.4.30, banco GSM8K): «Unsupported
 * parameter: 'max_tokens' is not supported with this model. Use
 * 'max_completion_tokens' instead.» Para `max_tokens` se exige además que el
 * mensaje nombre `max_completion_tokens`: así «max_tokens is too large» (el
 * valor, no el campo) no se confunde con un rechazo del campo. Para
 * `max_completion_tokens`, un servidor que no lo conoce dice «Unrecognized
 * request argument», «unknown parameter» o, con pydantic, «Extra inputs are
 * not permitted»; un valor fuera de rango («integer below minimum value») no
 * es eso y no se toca.
 */
function campoDeTopeRechazado(detalle: string, enviado: CampoDeTope): boolean {
  if (enviado === "max_tokens") {
    return (
      /\bmax_tokens\b/i.test(detalle) &&
      /max_completion_tokens/i.test(detalle) &&
      /unsupported|not supported|unrecognized|unknown parameter|use 'max_completion_tokens'/i.test(detalle)
    );
  }
  return (
    /max_completion_tokens/i.test(detalle) &&
    /unsupported|not supported|unrecognized|unknown (parameter|field|argument)|extra (inputs|fields) (are )?not permitted|not permitted/i.test(
      detalle,
    )
  );
}

/**
 * Los campos OPCIONALES del cuerpo que un endpoint compatible puede no conocer.
 * Ninguno cambia lo que se pregunta: `prompt_cache_key` es una pista de
 * enrutado, `service_tier` pide una cola (y lo que se acredita es siempre el
 * tier SERVIDO), `seed` pide reproducibilidad a quien la ofrezca y
 * `reasoning_effort` cuánto piensa un modelo que razona. Un servidor que no
 * conoce este último tampoco sabría qué hacer con él; en el API de OpenAI, en
 * cambio, NUNCA se quita (ver `corregirCampoOpcional`).
 */
type CampoOpcional = "prompt_cache_key" | "service_tier" | "seed" | "reasoning_effort";
const CAMPOS_OPCIONALES: readonly CampoOpcional[] = ["prompt_cache_key", "service_tier", "seed", "reasoning_effort"];

/**
 * ¿Este 400/422 dice que el endpoint NO CONOCE uno de los campos opcionales que
 * se mandaron? Devuelve cuál, o `null`.
 *
 * Medido en vivo contra Gemini (endpoint compatible, 2026-09-29): «Invalid JSON
 * payload received. Unknown name "prompt_cache_key": Cannot find field.». Los
 * demás dialectos, los mismos que reconoce `campoDeTopeRechazado`: «Unrecognized
 * request argument», «unknown parameter», «Extra inputs are not permitted»
 * (pydantic), «… is not supported». Se exige que el mensaje NOMBRE el campo y
 * que ese campo haya viajado: un valor fuera de rango («seed must be an
 * integer») no es un rechazo del campo y no se toca.
 */
function campoOpcionalRechazado(detalle: string, enviados: ReadonlySet<CampoOpcional>): CampoOpcional | null {
  if (
    !/unknown name|cannot find field|unknown (parameter|field|argument)|unrecognized|extra (inputs|fields) (are )?not permitted|not permitted|not supported|unsupported/i.test(
      detalle,
    )
  ) {
    return null;
  }
  for (const campo of CAMPOS_OPCIONALES) {
    if (enviados.has(campo) && new RegExp(`\\b${campo}\\b`).test(detalle)) return campo;
  }
  return null;
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

/** Hosts that only understand a bare model id (`gpt-4o-mini`, never `openai/gpt-4o-mini`). */
const HOSTS_QUE_QUIEREN_EL_ID_DESNUDO = /(^|\.)api\.openai\.com$|\.openai\.azure\.com$/i;

/**
 * Decides the id that travels on the wire. Explicit option wins; otherwise the
 * endpoint decides: OpenAI/Azure and Google's own Gemini API get the bare id,
 * everything else keeps what the caller wrote. Exported for the pipeline-level test that pins the README
 * snippet; not part of the public API (the public switch is the adapter option
 * `stripProviderPrefix`).
 */
export function quitarPrefijoDeProveedor(
  model: string,
  explicito: boolean | undefined,
  baseUrl: string,
): string {
  const quitar = explicito ?? hostQuiereIdDesnudo(baseUrl);
  return quitar ? model.replace(/^[^/]+\//, "") : model;
}

// EL ORIGEN OFICIAL, POR EL HOST Y SOLO POR EL HOST. Es la condición M2 del
// ahorro de tier (`economics/tier-diferido.ts`), la que enciende el modo
// explícito de caché y la E0-bis de la referencia (`pipeline/referencia.ts`): la
// tarifa publicada solo es la factura cuando se habla con el API del propio
// proveedor. Cualquier otro host —un proxy, Vercel AI Gateway, un endpoint
// regional o FedRAMP (+10 % según la página de precios de OpenAI), Azure (sin
// documentar aquí)— da `null`, y con `null` el ahorro es como mucho
// `estimated`. La lista y la comparación (https, host exacto, puerto por
// defecto) viven en `origen-oficial.ts`, compartidas con el adaptador de
// Anthropic y con los adaptadores de marcos.
//
// El API propio del proveedor que es este endpoint, o `null`. NO se exporta: el
// barril de proveedores reexporta este fichero entero hacia `dist/index.d.ts`.
function origenOficial(baseUrl: string): "openai" | "google" | null {
  const api = apiOficialDe(baseUrl);
  return api === "openai" || api === "google" ? api : null;
}

// La cabecera con la que Google dice qué tier sirvió: el anuncio oficial de Flex
// y Priority (blog.google, 2-abr-2026) la lee así —
// `response.sdk_http_response.headers.get("x-gemini-service-tier")`— «to check
// which tier actually served your request». La guía de Flex y la de
// compatibilidad con OpenAI no la mencionan y NINGUNA fuente publica sus
// valores, así que: solo se lee en el host oficial de Google, solo si el cuerpo
// no trae `service_tier`, y lo leído de aquí nunca sale `measured` (queda
// `tierLeidoDe: "cabecera"` en el atestado y la valoración lo baja).
const CABECERA_TIER_GEMINI = "x-gemini-service-tier";

function cabecera(response: Response, nombre: string): string | undefined {
  try {
    const v = (response.headers as Headers | undefined)?.get?.(nombre);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Dónde va el punto de ruptura EXPLÍCITO, o `null` si el modo explícito no
 * aplica (sin la marca, o modelo sin prima de escritura, o fuera del API de
 * OpenAI). Pura: `enviar` la usa para el cuerpo y `leer` para el atestado, y
 * las dos tienen que contar lo mismo.
 *
 * El punto va en el ÚLTIMO mensaje del prefijo estable y solo si ese mensaje es
 * de un rol donde la guía de OpenAI lo admite (developer/system, user, respuesta
 * de herramienta) y trae texto. Si no, cero puntos: en modo explícito eso es ni
 * escribir ni leer, que es el lado que no cobra prima.
 */
function planDeCacheExplicita(
  model: string,
  req: ProviderRequest,
  origen: "openai" | "google" | null,
): { puntos: 0 | 1; indice: number } | null {
  if (req.explicitCacheWrites !== true || !explicitaAplicable(model, origen)) return null;
  const n = req.stablePrefixMessages;
  if (n == null || !Number.isInteger(n) || n <= 0 || n > req.messages.length) {
    return { puntos: 0, indice: -1 };
  }
  const m = req.messages[n - 1]!;
  const rolAdmitido = m.role === "system" || m.role === "user" || m.role === "tool";
  return rolAdmitido && typeof m.content === "string" && m.content !== ""
    ? { puntos: 1, indice: n - 1 }
    : { puntos: 0, indice: -1 };
}

function hostQuiereIdDesnudo(baseUrl: string): boolean {
  // El API oficial de Gemini, por el MISMO origen atestiguado que el tier y la
  // referencia (`apiOficialDe`: https, host exacto, puerto por defecto). Su
  // endpoint compatible busca `models/<id>` y con el prefijo contesta 404
  // «models/google/gemini-3.8-flash is not found» (banco MT-Bench de gama alta
  // contra la 0.4.31, PR #400). Un proxy o un router delante de Gemini
  // (Vercel AI Gateway, OpenRouter, LiteLLM) no es este origen y conserva el
  // prefijo, porque enruta con él.
  if (apiOficialDe(baseUrl) === "google") return true;
  try {
    return HOSTS_QUE_QUIEREN_EL_ID_DESNUDO.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  private readonly opts: OpenAICompatibleOptions;
  private readonly fetchImpl: typeof fetch;
  /** Models of this endpoint already known to reject `response_format`. */
  private readonly sinResponseFormat = new Set<string>();
  // Whether this ENDPOINT already rejected `stream_options` once. It is a
  // property of the server, not of the model, so a single flag is enough; once
  // set, streamed requests go out without it and report incomplete usage.
  private streamOptionsRejected = false;
  // El campo de tope APRENDIDO por modelo tras un 400 que rechazó el otro. Es
  // propiedad del modelo (gpt-4o-mini admite los dos, gpt-5.x solo el nuevo),
  // no del endpoint, así que va por modelo como `sinResponseFormat`.
  private readonly campoDeTopeAprendido = new Map<string, CampoDeTope>();
  // Los campos opcionales que ESTE modelo de este endpoint ya rechazó por nombre
  // (`campoOpcionalRechazado`). Por modelo, como `sinResponseFormat`: detrás de
  // un router, un modelo puede aceptar `seed` y otro no.
  private readonly camposRechazados = new Map<string, Set<CampoOpcional>>();
  // El API oficial con el que habla, por el host de `baseUrl`. Se declara al
  // pipeline (que decide el modo explícito ANTES de llamar) y se atestigua en
  // cada respuesta.
  private readonly origen: "openai" | "google" | null;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.id = `openai-compatible:${opts.baseUrl}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.origen = origenOficial(opts.baseUrl);
    declararOrigen(this, this.origen);
    // Y a la referencia (E0-bis), el mismo host dicho en dos palabras: fuera del
    // API oficial, una repetición no se valora contra el contador de esta
    // llamada. Aquí cuenta también Anthropic (su capa de compatibilidad con el
    // SDK de OpenAI vive en api.anthropic.com y factura a su precio de lista),
    // que `origen` no nombra porque ni su tier ni su caché explícita se piden así.
    atestiguarOrigen(this, origenDeLaUrl(opts.baseUrl));
    // LA BATCH API (Files + Batches), para `layer.batches`. La línea `body` de
    // cada petición es el MISMO cuerpo que generate() (sin `stream`, sin tier) y
    // la lectura es la misma. Ver lotes-del-proveedor.ts. Un host compatible que
    // no implemente /files y /batches fallará en la subida, en claro.
    const nativoPara = (req: ProviderRequest, model: string): boolean =>
      req.schema != null && !this.sinResponseFormat.has(model);
    const desnudo = (model: string): string =>
      quitarPrefijoDeProveedor(model, this.opts.stripProviderPrefix, this.opts.baseUrl);
    registrarLotes(this, {
      protocolo: "openai",
      origen: this.origen,
      endpoint: endpointLimpio(opts.baseUrl),
      cuerpo: (req) => {
        const model = desnudo(req.model);
        return this.construirCuerpo(model, req, nativoPara(req, model));
      },
      leer: (json, req) => {
        const model = desnudo(req.model);
        return this.leerJson(json as OpenAIChatResponse, undefined, req, nativoPara(req, model), model, false);
      },
      solicitar: (ruta, o) =>
        this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}${rutaRelativa(ruta)}`, {
          method: o.method,
          headers: {
            // Con `FormData` NO se pone content-type: lo pone fetch, con su frontera.
            ...(o.json !== undefined ? { "content-type": "application/json" } : {}),
            ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
            ...this.opts.headers,
          },
          ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : o.form ? { body: o.form } : {}),
          ...(o.signal ? { signal: o.signal } : {}),
        }),
    });
  }

  async generate(req: ProviderRequest, options?: ProviderStreamOptions): Promise<ProviderResponse> {
    const model = quitarPrefijoDeProveedor(req.model, this.opts.stripProviderPrefix, this.opts.baseUrl);
    // La señal solo existe si el llamante la pasa (cancelación/deadline de la
    // petición o copia de verificación). Sin ella, la HTTP es la de siempre.
    const senal = options?.signal;

    // Se intenta la vía nativa salvo que ESTE modelo ya la haya rechazado antes.
    // Ese conjunto es lo que acota el coste del descubrimiento: el viaje de más
    // se paga UNA vez por modelo y por instancia, no en cada petición.
    let nativo = req.schema != null && !this.sinResponseFormat.has(model);
    let response = await this.enviar(model, req, nativo, undefined, senal);

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
    //
    // El mismo razonamiento vale para el CAMPO DEL TOPE (`max_tokens` frente a
    // `max_completion_tokens`, ver `campoDeTope`): también se rechaza antes de
    // generar. Como las dos causas pueden darse en la misma petición (gpt-4 con
    // contrato detrás de un servidor que solo conoce uno de los campos), se
    // admiten hasta dos correcciones, cada una una sola vez.
    //
    // Y para un CAMPO OPCIONAL que el endpoint no conoce (`corregirCampoOpcional`:
    // `prompt_cache_key`, `service_tier`, `seed`), que también se rechaza antes
    // de generar. Cada corrección se hace una sola vez por modelo (los memos lo
    // garantizan), así que el tope de vueltas es el número de causas posibles.
    for (let correcciones = 0; correcciones < 2 + CAMPOS_OPCIONALES.length && !response.ok; correcciones++) {
      if (response.status !== 400 && response.status !== 422) break;
      const detalle = await safeText(response);
      if (this.corregirCampoOpcional(model, req, response.status, detalle, nativo)) {
        // Solo se quitó el campo: lo demás de la petición no cambia.
      } else if (response.status === 400 && nativo && esResponseFormatNoSoportado(detalle)) {
        this.sinResponseFormat.add(model);
        avisarDelProveedor(
          this,
          `sin-response-format:${model}`,
          `[bvsala] Model "${model}" rejects \`response_format\` with a 400: it has no ` +
            "structured outputs. The request is repeated asking for the JSON via prompt (once only: " +
            "the model is noted and the following requests go straight there). The schema still travels " +
            "and the layer still validates, but the guarantee comes from the layer, not the provider, " +
            'and the report says so: `constraints.backend: "none"`. To recover the native guarantee, ' +
            "use a model with structured outputs (gpt-4o or later).",
        );
        nativo = false;
      } else if (!this.corregirCampoDeTope(model, req, response.status, detalle)) {
        throw new Error(`provider ${response.status}: ${detalle}`);
      }
      response = await this.enviar(model, req, nativo, undefined, senal);
    }

    if (!response.ok) {
      const detail = await safeText(response);
      throw new Error(`provider ${response.status}: ${detail}`);
    }

    return this.leer(response, req, nativo, model);
  }

  /**
   * Streaming variant of generate() over Chat Completions. It always asks for
   * the final usage chunk (`stream_options.include_usage`); an endpoint that
   * rejects that option is retried once without it and remembered, and its
   * streamed answers then report `usage.complete: false`. With `requireUsage`,
   * that rejection throws instead. Requests with an output contract or a
   * deferrable tier are not streamed: they are served by generate() and yielded
   * as one text event.
   */
  async *generateStream(
    req: ProviderRequest,
    options: ProviderStreamOptions = {},
  ): AsyncGenerator<ProviderStreamEvent, void, undefined> {
    // Con contrato o tier diferible no se streamea: el pipeline ya las entrega
    // enteras, y así el camino de `response_format` (con su degradación a JSON
    // por prompt) sigue viviendo en un solo sitio.
    if (req.schema != null || req.deferrable === true) {
      const r = await this.generate(req, options);
      if (r.text !== "") yield { type: "text", delta: r.text };
      yield { type: "done", response: r };
      return;
    }

    const model = quitarPrefijoDeProveedor(req.model, this.opts.stripProviderPrefix, this.opts.baseUrl);
    const signal = options.signal;
    const conUso = !this.streamOptionsRejected;
    let pidiendoUso = conUso;
    const enviarStream = (includeUsage: boolean): Promise<Response> =>
      this.enviar(model, req, false, { includeUsage, ...(signal ? { signal } : {}) });
    let response = await enviarStream(pidiendoUso);

    // Un endpoint que no conoce `stream_options` contesta 400 (OpenAI-compatibles
    // viejos) o 422 (validadores estrictos tipo pydantic). Se rechaza ANTES de
    // generar nada, así que repetir sin la opción no duplica ningún gasto: es el
    // mismo razonamiento que la degradación de `response_format` de generate().
    // Y el mismo vale para el campo del tope (`corregirCampoDeTope`), que se
    // mira PRIMERO: un 422 de pydantic por `max_completion_tokens` no es un
    // rechazo de `stream_options`, y quitárselas dejaría el stream sin usage.
    for (let correcciones = 0; correcciones < 2 + CAMPOS_OPCIONALES.length && !response.ok; correcciones++) {
      if (response.status !== 400 && response.status !== 422) break;
      const detalle = await safeText(response);
      if (
        this.corregirCampoOpcional(model, req, response.status, detalle, false, pidiendoUso) ||
        this.corregirCampoDeTope(model, req, response.status, detalle)
      ) {
        response = await enviarStream(pidiendoUso);
        continue;
      }
      if (!pidiendoUso || (response.status !== 422 && !/stream_options|include_usage/i.test(detalle))) {
        throw new Error(`provider ${response.status}: ${detalle}`);
      }
      if (this.opts.requireUsage) {
        throw new Error(
          `provider ${response.status}: this endpoint rejects stream_options, so a streamed answer ` +
            `would carry no usage and requireUsage is set. ${detalle}`,
        );
      }
      pidiendoUso = false;
      response = await enviarStream(false);
    }
    // Solo se anota (y se avisa) si SIN la opción pasó: un 422 por otra cosa
    // (un validador que rechaza los mensajes) vuelve a fallar sin ella, y
    // anotarlo antes quitaba el usage a todos los streams del proceso por un
    // error que no era de `stream_options`.
    if (conUso && !pidiendoUso && response.ok) {
      this.streamOptionsRejected = true;
      avisarDelProveedor(
        this,
        `sin-stream-options:${this.opts.baseUrl}`,
        "[bvsala] This endpoint rejects `stream_options`, so streamed answers from it carry no usage: " +
          "they are reported as `unmeasured` and never billed. Use `generate()` for a measured figure, " +
          "or an endpoint that reports usage when streaming.",
      );
    }

    if (!response.ok) {
      throw new Error(`provider ${response.status}: ${await safeText(response)}`);
    }

    // Un endpoint que ignora `stream: true` y contesta la completion entera en
    // JSON: la llamada ya está hecha (y facturada), así que se lee como en
    // generate() en vez de tirarla — el parser SSE no vería ningún `data:` y
    // lanzaría «ended before completion» sobre una respuesta completa.
    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      const entera = await this.leer(response, req, false, model);
      if (entera.text !== "") yield { type: "text", delta: entera.text };
      yield { type: "done", response: entera };
      return;
    }

    const cuerpo = response.body as (ReadableStream<Uint8Array> & { getReader?: unknown }) | null;
    const fuente: ReadableStream<Uint8Array> | string =
      cuerpo && typeof cuerpo.getReader === "function" ? cuerpo : await response.text();

    let text = "";
    // Las llamadas a herramienta llegan troceadas y se reensamblan por `index`.
    // El `id` y el `name` que cuentan son el PRIMERO no vacío: hay servidores que
    // los repiten en cada fragmento, y concatenarlos daría `get_weatherget_weather`.
    // Los argumentos sí se concatenan: son el JSON partido.
    const herramientas = new Map<
      number,
      { id?: string; name?: string; args: string; extra?: Record<string, unknown> }
    >();
    let finishReason: string | undefined;
    let uso: UsoDeChat | undefined;
    let servedServiceTier: string | undefined;
    let huboTextoDeRazonamiento = false;
    // La negativa también llega troceada (`delta.refusal`, referencia de los
    // eventos de stream de Chat Completions): se concatena y NO se emite como
    // texto de la respuesta.
    let negativa = "";

    for await (const msg of sseMessages(fuente)) {
      if (msg.data === "[DONE]") break;
      let json: TrozoDeChat;
      try {
        json = JSON.parse(msg.data) as TrozoDeChat;
      } catch {
        continue;
      }
      if (json === null || typeof json !== "object") continue;
      if (json.error != null) {
        const e = json.error as { message?: unknown };
        const mensaje = typeof e.message === "string" ? e.message : JSON.stringify(json.error);
        throw new Error(`provider stream error: ${mensaje}`);
      }
      const c = json.choices?.[0];
      const delta = c?.delta;
      if (esTextoNoVacio(delta?.reasoning_content) || esTextoNoVacio(delta?.reasoning)) {
        huboTextoDeRazonamiento = true;
      }
      if (typeof delta?.content === "string" && delta.content !== "") {
        text += delta.content;
        yield { type: "text", delta: delta.content };
      }
      if (typeof delta?.refusal === "string") negativa += delta.refusal;
      for (const tc of delta?.tool_calls ?? []) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const acc = herramientas.get(idx) ?? { args: "" };
        if (!acc.id && typeof tc.id === "string" && tc.id !== "") acc.id = tc.id;
        const nombre = tc.function?.name;
        if (!acc.name && typeof nombre === "string" && nombre !== "") acc.name = nombre;
        if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
        // La firma de Gemini: la primera que llegue, entera (no se trocea).
        const extra = extraContentDe(tc.extra_content);
        if (acc.extra === undefined && extra !== undefined) acc.extra = extra;
        herramientas.set(idx, acc);
      }
      if (c?.finish_reason != null) finishReason = c.finish_reason;
      if (json.usage != null && typeof json.usage === "object") uso = json.usage;
      if (typeof json.service_tier === "string" && json.service_tier !== "") {
        servedServiceTier = json.service_tier;
      }
    }

    // MEDIA RESPUESTA NO ES UNA RESPUESTA. Sin `finish_reason` el proveedor no
    // dijo que hubiera terminado: el cuerpo se cortó. Se lanza, para que nada de
    // esto se cachee ni se reporte como si fuera la respuesta entera.
    if (finishReason === undefined) {
      throw new Error("provider stream ended before completion (no finish_reason)");
    }
    // `content_filter: OTHER` (Gemini) → `content_filter`, el motivo aparte; lo
    // que no es uno de los cinco, `other` con su literal (motivo-de-parada.ts).
    const paradaDelStream = cerrarParada(finishReason);

    const inputAbsent = typeof uso?.prompt_tokens !== "number";
    const outputAbsent = typeof uso?.completion_tokens !== "number";
    if (this.opts.requireUsage && (inputAbsent || outputAbsent)) {
      throw new Error(mensajeDeUsoIncompleto(uso?.prompt_tokens, uso?.completion_tokens));
    }
    const facturada = salidaFacturada(uso, this.origen, huboTextoDeRazonamiento);
    const razonamiento = facturada.razonamiento;
    const escritosEnStream = escrituraDeCache(uso);
    const usage: ProviderUsage = {
      inputTokens: uso?.prompt_tokens ?? 0,
      outputTokens: facturada.salida,
      ...(uso?.prompt_tokens_details?.cached_tokens != null
        ? { cachedInputTokens: uso.prompt_tokens_details.cached_tokens }
        : {}),
      // Igual que en generate(): la escritura de caché de GPT-5.6+ (1,25×).
      ...(escritosEnStream !== undefined ? { cacheWriteInputTokens: escritosEnStream } : {}),
      ...(razonamiento !== undefined ? { reasoningTokens: razonamiento } : {}),
      ...(inputAbsent || outputAbsent ? { complete: false } : {}),
    };

    const toolCalls = [...herramientas.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, h]) => ({
        ...(h.id ? { id: h.id } : {}),
        name: h.name ?? "",
        arguments: h.args,
        ...(h.extra !== undefined ? { extraContent: h.extra } : {}),
      }))
      .filter((tc) => tc.name !== "");

    // El tier del cuerpo manda; la cabecera de Google, solo en su host y solo
    // si el cuerpo calló (ver CABECERA_TIER_GEMINI).
    let tierLeidoDe: "cuerpo" | "cabecera" | undefined = servedServiceTier ? "cuerpo" : undefined;
    if (!servedServiceTier && this.origen === "google") {
      servedServiceTier = cabecera(response, CABECERA_TIER_GEMINI);
      if (servedServiceTier) tierLeidoDe = "cabecera";
    }
    const planStream = planDeCacheExplicita(model, req, this.origen);

    yield {
      type: "done",
      // Sin contrato (los que lo llevan van por generate()) y sin nada añadido.
      response: atestiguar(
        {
          text,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...paradaDelStream,
          ...(negativa !== "" ? { refusal: negativa } : {}),
          ...(servedServiceTier ? { servedServiceTier } : {}),
          usage,
          structuredNatively: false,
          raw: uso ?? null,
        },
        // Los parámetros vacíos de una herramienta que no traía son del adaptador.
        {
          ...sinContrato(herramientasSinParametros(req.tools)),
          origen: this.origen,
          ...(tierLeidoDe ? { tierLeidoDe } : {}),
          ...(planStream ? { cacheExplicita: { puntos: planStream.puntos } } : {}),
        },
      ),
    };
  }

  // QUÉ CAMPO LLEVA EL TOPE. La opción explícita manda siempre; si no, lo que
  // este modelo ya enseñó con un 400; si no, el host:
  //
  //   · el API oficial de OpenAI → `max_completion_tokens`. `max_tokens` está
  //     deprecado desde el 2024-09-12 (el día de o1; SDK oficial openai-node
  //     4.60.0: «This value is now deprecated in favor of
  //     `max_completion_tokens`, and is not compatible with o-series models») y
  //     los modelos de razonamiento —o-series, gpt-5.x— lo rechazan con 400. El
  //     nuevo lo admiten todos sus modelos de chat actuales, gpt-4o-mini incluido.
  //   · cualquier otro endpoint → `max_tokens`, el que entiende TODO servidor
  //     compatible (LiteLLM, vLLM, Ollama, OpenRouter, TGI, el endpoint de
  //     Gemini, Azure con api-version antigua). El nuevo no: hay servidores que
  //     ignoran en silencio un campo que no conocen, y ahí el tope se perdería
  //     sin error, que es peor que un 400. Un proxy delante de un modelo de
  //     razonamiento de OpenAI (LiteLLM, OpenRouter) traduce él, y si no lo
  //     hace, su 400 lo corrige `corregirCampoDeTope`.
  private campoDeTope(model: string): CampoDeTope {
    return (
      this.opts.maxTokensParam ??
      this.campoDeTopeAprendido.get(model) ??
      (this.origen === "openai" ? "max_completion_tokens" : "max_tokens")
    );
  }

  // ¿Se puede corregir este rechazo cambiando de campo? Solo sin opción
  // explícita (quien la fijó decidió), solo si la petición llevaba tope, solo
  // si el rechazo nombra el campo que se mandó y solo UNA vez por modelo: un
  // modelo que ya aprendió su campo y lo vuelve a ver rechazado no oscila.
  private corregirCampoDeTope(model: string, req: ProviderRequest, status: number, detalle: string): boolean {
    if (this.opts.maxTokensParam !== undefined || req.maxOutputTokens == null) return false;
    if (this.campoDeTopeAprendido.has(model)) return false;
    const enviado = this.campoDeTope(model);
    if (!campoDeTopeRechazado(detalle, enviado)) return false;
    const otro: CampoDeTope = enviado === "max_tokens" ? "max_completion_tokens" : "max_tokens";
    this.campoDeTopeAprendido.set(model, otro);
    avisarDelProveedor(
      this,
      `campo-de-tope:${this.opts.baseUrl}:${model}`,
      `[bvsala] This endpoint rejects \`${enviado}\` for model "${model}" with a ${status}, so the output cap ` +
        `is sent as \`${otro}\` instead (the rejected request was not billed; the model is noted and ` +
        "the following requests go straight there). To choose the field yourself, set " +
        "`maxTokensParam` on OpenAICompatibleProvider.",
    );
    return true;
  }

  // ¿Se puede corregir este rechazo quitando un campo opcional? Solo si el
  // rechazo nombra un campo que viajó en ESTE cuerpo (el mismo `construirCuerpo`
  // que lo mandó dice cuáles), y cada campo una sola vez por modelo: quitado, ya
  // no viaja y no puede volver a nombrarse.
  private corregirCampoOpcional(
    model: string,
    req: ProviderRequest,
    status: number,
    detalle: string,
    nativo: boolean,
    includeUsage?: boolean,
  ): boolean {
    const cuerpo = this.construirCuerpo(
      model,
      req,
      nativo,
      includeUsage === undefined ? undefined : { includeUsage },
    );
    const enviados = new Set(CAMPOS_OPCIONALES.filter((c) => c in cuerpo));
    const campo = campoOpcionalRechazado(detalle, enviados);
    if (campo === null) return false;
    // `reasoning_effort` en el API de OpenAI es una decisión del llamante sobre
    // un modelo que lo conoce: su 400 («Function tools with reasoning_effort are
    // not supported for gpt-5.6-sol … set reasoning_effort to 'none'», o un
    // valor que ese modelo no admite) es la respuesta, y quitarlo en silencio
    // cambiaría cuánto piensa el modelo sin que nadie lo pidiera.
    if (campo === "reasoning_effort" && this.origen === "openai") return false;
    const rechazados = this.camposRechazados.get(model) ?? new Set<CampoOpcional>();
    rechazados.add(campo);
    this.camposRechazados.set(model, rechazados);
    avisarDelProveedor(
      this,
      `campo-opcional:${this.opts.baseUrl}:${model}:${campo}`,
      `[bvsala] This endpoint rejects \`${campo}\` for model "${model}" with a ${status}, so it is no longer ` +
        "sent (the rejected request was not billed; the model is noted and the following requests go " +
        "without it)." +
        (campo === "service_tier"
          ? " The request is served on the endpoint's default tier, and no tier discount is credited."
          : campo === "prompt_cache_key"
            ? " The prefix cache keeps working without the routing hint; only its hit rate may drop."
            : campo === "reasoning_effort"
              ? " The model reasons at the endpoint's default effort."
              : ""),
    );
    return true;
  }

  // ¿Viaja este campo opcional para este modelo? No, si ya lo rechazó.
  private campoAdmitido(model: string, campo: CampoOpcional): boolean {
    return this.camposRechazados.get(model)?.has(campo) !== true;
  }

  // Arma el cuerpo y lo envía. `nativo` elige la vía `response_format`; `stream`
  // pide la respuesta en SSE (y, con `includeUsage`, el chunk final de usage).
  // Sin `stream`, el cuerpo es byte a byte el de siempre.
  private async enviar(
    model: string,
    req: ProviderRequest,
    nativo: boolean,
    stream?: { includeUsage: boolean; signal?: AbortSignal },
    senal?: AbortSignal,
  ): Promise<Response> {
    comprobarSenalDeProvider(stream?.signal ?? senal);
    const body = this.construirCuerpo(model, req, nativo, stream);
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
        // `senal` solo cuenta sin `stream` (generate con opciones); el cuerpo
        // no cambia en ningún caso.
        ...(stream?.signal ? { signal: stream.signal } : !stream && senal ? { signal: senal } : {}),
      },
    );
  }

  // El cuerpo de Chat Completions: el que viaja en generate() y, sin `stream`,
  // la línea `body` de un lote (lotes-del-proveedor.ts). Separado de `enviar`
  // para que las dos vías no puedan derivar.
  private construirCuerpo(
    model: string,
    req: ProviderRequest,
    nativo: boolean,
    stream?: { includeUsage: boolean },
  ): Record<string, unknown> {
    // EL CICLO DE HERRAMIENTAS TIENE QUE PODER VOLVER. Chat Completions exige que
    // un mensaje `role:"tool"` lleve `tool_call_id` Y siga a un `assistant` con
    // `tool_calls`; sin las dos cosas contesta 400 y la petición del cliente
    // revienta — justo en el flujo que el propio SDK documenta en
    // `SavingsResult.toolCalls` («treat an empty text together with a populated
    // toolCalls as a tool invocation to execute»). El mapeo a `{role, content}` a
    // secas descartaba las dos, así que el turno de VUELTA no atravesaba este
    // adaptador: se podía pedir la herramienta, pero no contestar con su
    // resultado.
    const mensajes = req.messages.map((m): Record<string, unknown> => {
      if (m.role === "tool") {
        return {
          role: "tool",
          content: m.content,
          // Se acepta también desde `metadata` por compatibilidad con llamantes
          // que ya lo pasaban ahí antes de que el campo existiera.
          tool_call_id: m.toolCallId ?? (m.metadata?.["tool_call_id"] as string | undefined),
          ...(m.name ? { name: m.name } : {}),
        };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          // Con `tool_calls`, el proveedor admite `content` vacío o nulo.
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc, i) => ({
            id: tc.id ?? `call_${i}`,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
            // LA FIRMA DE PENSAMIENTO DE GEMINI 3 VUELVE TAL CUAL. Ver
            // `extraContentDe`. Al API de OpenAI no: él nunca la da, y un
            // historial que la traiga de otro proveedor no le sirve de nada.
            ...(tc.extraContent !== undefined && this.origen !== "openai"
              ? { extra_content: tc.extraContent }
              : {}),
          })),
        };
      }
      return { role: m.role, content: m.content };
    });
    // EL MODO EXPLÍCITO DE CACHÉ (peticiones `standalone`, GPT-5.6+ en el API de
    // OpenAI). El punto va DENTRO del mensaje frontera, como parte de texto, y
    // antes de añadir la instrucción de JSON por prompt, que va al final y
    // nunca es prefijo. Sin la marca no se toca nada: el cuerpo es el de hoy.
    const plan = planDeCacheExplicita(model, req, this.origen);
    if (plan?.puntos === 1) {
      const frontera = mensajes[plan.indice]!;
      frontera["content"] = [
        { type: "text", text: frontera["content"], prompt_cache_breakpoint: { mode: "explicit" } },
      ];
    }
    if (req.schema && !nativo) {
      mensajes.push({ role: "system", content: instruccionDeJsonPorPrompt(req.schema) });
    }

    const body: Record<string, unknown> = {
      model,
      messages: mensajes,
    };
    // EL TOPE, CON EL NOMBRE QUE ENTIENDE ESTE ENDPOINT. Ver `campoDeTope`.
    if (req.maxOutputTokens != null) body[this.campoDeTope(model)] = req.maxOutputTokens;
    if (req.temperature != null) body["temperature"] = req.temperature;
    if (req.seed != null && this.campoAdmitido(model, "seed")) body["seed"] = req.seed;
    // EL ESFUERZO DE RAZONAMIENTO, solo si el llamante lo declaró y tal cual lo
    // escribió: la capa no elige un esfuerzo por nadie. gpt-5.6-* con
    // herramientas NO FUNCIONA sin él en Chat Completions: OpenAI contesta 400
    // «Function tools with reasoning_effort are not supported for gpt-5.6-sol in
    // /v1/chat/completions. To use function tools, use /v1/responses or set
    // reasoning_effort to 'none'» (banco BFCL de gama alta contra la 0.4.31, PR
    // #398, 840 de 840 llamadas; lo mismo en terra y luna), y hasta aquí la capa
    // no tenía forma de mandarlo. Gemini lo admite por su endpoint compatible
    // («reasoning_effort (OpenAI)» ↔ `thinking_level`/`thinking_budget`,
    // https://ai.google.dev/gemini-api/docs/openai, «Last updated 2026-09-02
    // UTC», consultada el 2026-09-29).
    if (req.reasoningEffort != null && this.campoAdmitido(model, "reasoning_effort")) {
      body["reasoning_effort"] = req.reasoningEffort;
    }
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
    //
    // SOLO AL API DE OPENAI (salvo `sendPromptCacheKey`). El campo es de OpenAI y
    // un endpoint estricto rechaza lo que no conoce: el compatible de Gemini
    // contesta 400 «Invalid JSON payload received. Unknown name
    // "prompt_cache_key": Cannot find field.» (banco GSM8K de gama alta, PR #397:
    // el 100 % de las peticiones con prefijo marcado fallaban a través de la
    // capa, desde la 0.4.1 hasta la 0.4.31). Gemini cachea el prefijo solo, sin
    // pista, y LiteLLM, vLLM u Ollama no tienen instancias que enrutar: fuera
    // del API de OpenAI la pista no compraba nada y podía costar la petición.
    if (
      req.promptCacheKey != null &&
      (this.opts.sendPromptCacheKey ?? this.origen === "openai") &&
      this.campoAdmitido(model, "prompt_cache_key")
    ) {
      body["prompt_cache_key"] = req.promptCacheKey;
    }
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
    //
    // Gemini lo admite por su endpoint compatible («The Gemini API matches
    // OpenAI's service_tier parameter in name and logic»,
    // https://ai.google.dev/gemini-api/docs/openai, «Last updated 2026-09-02
    // UTC»); un servidor que no, lo rechaza por nombre y se quita
    // (`corregirCampoOpcional`): la petición sale en la cola estándar y, como
    // lo que se acredita es el tier SERVIDO, no se acredita descuento.
    if (req.deferrable === true && this.campoAdmitido(model, "service_tier")) {
      body["service_tier"] = TIER_DIFERIBLE_OPENAI;
    }
    // `stablePrefixMessages` se ignora salvo en modo explícito: sin él la caché
    // de OpenAI es automática y no hay nada que marcar. Con él, `mode:
    // "explicit"` apaga el punto implícito (el que cae al final de la pregunta y
    // la escribe a 1,25x), y el único punto es el de arriba o ninguno. Sin `ttl`:
    // su único valor admitido, `30m`, es también el defecto.
    if (plan) body["prompt_cache_options"] = { mode: "explicit" };
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
        avisarDelProveedor(
          this,
          "strict-incompatible",
          "[bvsala] The response contract does not meet OpenAI's `strict` mode " +
            "(in strict, `required` must list ALL the keys in `properties`, and every object " +
            "needs `additionalProperties: false`). The schema is sent with `strict: false`: " +
            "the model is still guided and the layer still validates, but the guarantee comes from " +
            "the layer, not the provider. To recover it, make every key in the contract required.",
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

    if (stream) {
      body["stream"] = true;
      if (stream.includeUsage) body["stream_options"] = { include_usage: true };
    }
    return body;
  }

  /** Translate a 2xx endpoint response into the provider-neutral shape. */
  private async leer(
    response: Response,
    req: ProviderRequest,
    nativo: boolean,
    model: string,
  ): Promise<ProviderResponse> {
    const json = (await response.json()) as OpenAIChatResponse;
    return this.leerJson(json, response, req, nativo, model, this.opts.requireUsage === true);
  }

  // El cuerpo ya parseado —el de generate() o la línea de un lote— en la forma
  // neutra. `response` solo sirve para la cabecera de tier de Gemini; en un lote
  // no hay cabeceras por línea. `exigirUso` es `requireUsage` en generate(); en
  // un lote va apagado (una línea sin contador sale marcada, no tumba las demás).
  private leerJson(
    json: OpenAIChatResponse,
    response: Response | undefined,
    req: ProviderRequest,
    nativo: boolean,
    model: string,
    exigirUso: boolean,
  ): ProviderResponse {
    const mensaje = json.choices?.[0]?.message as
      | {
          content?: string | null;
          refusal?: unknown;
          tool_calls?: { id?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown }[];
          reasoning_content?: unknown;
          reasoning?: unknown;
        }
      | undefined;
    const text = mensaje?.content ?? "";
    // LA NEGATIVA DE SALIDAS ESTRUCTURADAS. Con `response_format: json_schema`
    // OpenAI no mete la negativa en `content` (no cumpliría el esquema): llega en
    // `message.refusal`, sin `content` y con `finish_reason: "stop"`, y sus
    // tokens cuentan como salida en `usage` (el ejemplo oficial trae
    // `completion_tokens: 11`). Documentación oficial, consultada el
    // 2026-09-28: https://developers.openai.com/api/docs/guides/structured-outputs
    // («Refusals with Structured Outputs») y la referencia de Chat Completions
    // (`message.refusal: string or null`). Solo cuenta una cadena NO vacía: el
    // `refusal: null` de toda respuesta normal no es una negativa, y un `content`
    // vacío sin `refusal` tampoco. El `finish_reason` se deja como lo dijo el
    // proveedor; quien decide que no se repara ni se repite es el pipeline.
    const negativa = typeof mensaje?.refusal === "string" && mensaje.refusal !== "" ? mensaje.refusal : undefined;

    // Cuando el modelo invoca una herramienta devuelve `content: null` +
    // `tool_calls`. El `?? ""` de arriba convertía eso en cadena vacía y la
    // petición del modelo se PERDÍA: la capa servía "" como si fuera la respuesta,
    // la cacheaba, y la siguiente repetición acreditaba 100 % de ahorro sobre una
    // acción que nunca se ejecutó. Ahora se propagan.
    const toolCalls = (mensaje?.tool_calls ?? [])
      .map((tc) => {
        const extra = extraContentDe(tc.extra_content);
        return {
          ...(tc.id ? { id: tc.id } : {}),
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
          ...(extra !== undefined ? { extraContent: extra } : {}),
        };
      })
      .filter((tc) => tc.name !== "");
    const usage = json.usage ?? {};
    const inputTokens = usage.prompt_tokens ?? 0;
    // LA SALIDA QUE SE FACTURA, no solo la que `completion_tokens` cuenta: ver
    // `salidaFacturada` (el pensamiento de Gemini solo está en `total_tokens`).
    const facturada = salidaFacturada(
      usage,
      this.origen,
      esTextoNoVacio(mensaje?.reasoning_content) || esTextoNoVacio(mensaje?.reasoning),
    );
    const outputTokens = facturada.salida;

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
    if (exigirUso && (inputAbsent || outputAbsent)) {
      throw new Error(mensajeDeUsoIncompleto(usage.prompt_tokens, usage.completion_tokens));
    }

    // `content_filter: OTHER` (Gemini) → `content_filter`, el motivo aparte:
    // ver parada-de-filtro.ts.
    const parada = cerrarParada(json.choices?.[0]?.finish_reason);

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
    let servedServiceTier =
      typeof json.service_tier === "string" && json.service_tier !== ""
        ? json.service_tier
        : undefined;
    // El cuerpo manda. La cabecera de Google solo en su host oficial y solo si
    // el cuerpo calló; y lo que se lea de ahí se atestigua como tal, para que la
    // valoración no lo llame `measured` (sus valores no están documentados).
    let tierLeidoDe: "cuerpo" | "cabecera" | undefined = servedServiceTier ? "cuerpo" : undefined;
    if (!servedServiceTier && this.origen === "google" && response) {
      servedServiceTier = cabecera(response, CABECERA_TIER_GEMINI);
      if (servedServiceTier) tierLeidoDe = "cabecera";
    }
    const escritos = escrituraDeCache(usage);
    const plan = planDeCacheExplicita(model, req, this.origen);

    const razonamiento = facturada.razonamiento;

    return atestiguar(
      {
        text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...parada,
        ...(negativa !== undefined ? { refusal: negativa } : {}),
        ...(servedServiceTier ? { servedServiceTier } : {}),
        // Solo si el tier VIAJÓ: un endpoint que rechazó `service_tier` no lo recibió.
        ...(req.deferrable === true && this.campoAdmitido(model, "service_tier")
          ? { requestedServiceTier: TIER_DIFERIBLE_OPENAI }
          : {}),
        usage: {
          inputTokens,
          outputTokens,
          ...(usage.prompt_tokens_details?.cached_tokens != null
            ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens }
            : {}),
          // LA ESCRITURA DE CACHÉ, que desde GPT-5.6 se factura a 1,25× la
          // entrada (https://developers.openai.com/api/docs/guides/prompt-caching,
          // consultada el 2026-09-27). Va dentro de `prompt_tokens`, como la
          // lectura; aquí solo se separa para que el pipeline cargue el 0,25×
          // de más. No es un descuento: es lo que cuesta el prefijo la primera
          // vez (ver `cacheWriteInputTokens` en ProviderUsage). «The unadjusted
          // number of prompt tokens written to cache» (openai-node,
          // CompletionUsage); el gateway ya lo leía.
          ...(escritos !== undefined ? { cacheWriteInputTokens: escritos } : {}),
          ...(razonamiento !== undefined ? { reasoningTokens: razonamiento } : {}),
          // Un contador ausente se rellenó con 0: la petición sale `unmeasured`.
          // Con el usage completo la clave NO aparece.
          ...(inputAbsent || outputAbsent ? { complete: false } : {}),
        },
        // Solo es NATIVO si el contrato viajó en `response_format`. Cuando se
        // degradó a pedir el JSON por prompt, quien impone la forma es el layer al
        // validar, y de este campo depende que el informe no publique una garantía
        // del proveedor que el proveedor no dio.
        structuredNatively: req.schema != null && nativo,
        raw: json,
      },
      // Lo que salió por el cable, para la regla de la referencia: con la vía
      // nativa, el esquema del llamante TAL CUAL dentro de `response_format`
      // (envoltorio fijo: tipo, nombre, strict) y los mensajes sin tocar, y si
      // viajó en modo estricto —el MISMO `isStrictCompatible` que decidió el
      // `strict` del cuerpo—; con la degradada, la instrucción de JSON en el
      // prompt, que la referencia rechaza siempre. Y los parámetros vacíos de
      // las herramientas que no los traían, dos piezas cada una.
      {
        esquemaEnFormatoNativo: req.schema != null && nativo,
        esquemaEstricto: req.schema != null && nativo && isStrictCompatible(req.schema),
        esquemaPorPrompt: req.schema != null && !nativo,
        piezasDelAdaptador: herramientasSinParametros(req.tools),
        origen: this.origen,
        ...(tierLeidoDe ? { tierLeidoDe } : {}),
        ...(plan ? { cacheExplicita: { puntos: plan.puntos } } : {}),
      },
    );
  }
}

interface UsoDeChat {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Gemini (endpoint compatible): el único contador que incluye el pensamiento. */
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

// Los tokens de razonamiento OCULTO que el proveedor declara dentro de la
// salida, o `undefined` si no lo dice. Un 0 solo se afirma cuando el contador lo
// dice Y la respuesta no trae texto de razonamiento (`reasoning_content` de
// DeepSeek o vLLM, `reasoning` de OpenRouter): un 0 al lado de un razonamiento
// es un contador que se contradice, y entonces no se afirma nada.
//
// No es decorativo: la referencia solo acredita salida cuando la llamada que
// corrió declaró exactamente 0 (ver `pipeline/referencia.ts`).
function razonamientoDeclarado(
  uso: UsoDeChat | null | undefined,
  huboTextoDeRazonamiento: boolean,
): number | undefined {
  const n = uso?.completion_tokens_details?.reasoning_tokens;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return undefined;
  if (n === 0 && huboTextoDeRazonamiento) return undefined;
  return n;
}

// LA SALIDA FACTURADA Y SU RAZONAMIENTO OCULTO. `completion_tokens` más lo que
// `total_tokens` trae de más (`salidaOculta`, con las fuentes oficiales de
// Google en salida-oculta.ts), y ese hueco se declara como razonamiento: es el
// pensamiento de Gemini, que su endpoint compatible factura como salida y solo
// cuenta en `total_tokens`.
//
// CONTRA EL API DE OPENAI NO SE SUMA NADA: allí `completion_tokens` ya incluye
// `reasoning_tokens` y `total_tokens = prompt + completion`. Si algún día no
// cuadrara, el hueco no sería razonamiento que falte sino otra cosa, y contarlo
// como salida lo cobraría dos veces.
//
// Con hueco, el razonamiento declarado es el mayor de los dos: el hueco o el
// `reasoning_tokens` del proveedor, si lo diera (un servidor que lo desglosa
// pero lo deja fuera de `completion_tokens` los da iguales). Sin hueco, la
// regla de siempre (`razonamientoDeclarado`).
function salidaFacturada(
  uso: UsoDeChat | null | undefined,
  origen: "openai" | "google" | null,
  huboTextoDeRazonamiento: boolean,
): { salida: number; razonamiento: number | undefined } {
  const completion = uso?.completion_tokens ?? 0;
  const declarado = razonamientoDeclarado(uso, huboTextoDeRazonamiento);
  const oculta = origen === "openai" ? 0 : salidaOculta(uso);
  if (oculta === 0) return { salida: completion, razonamiento: declarado };
  return { salida: completion + oculta, razonamiento: Math.max(oculta, declarado ?? 0) };
}

// Los tokens ESCRITOS en la caché de prefijo, o `undefined` si el contador no lo
// dice. Solo un entero no negativo cuenta: cualquier otra cosa es no saberlo.
function escrituraDeCache(uso: UsoDeChat | null | undefined): number | undefined {
  const n = uso?.prompt_tokens_details?.cache_write_tokens;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
}

// EL `extra_content` DE UNA LLAMADA A HERRAMIENTA, OPACO. Gemini 3 por su
// endpoint compatible con OpenAI devuelve cada llamada con
// `extra_content.google.thought_signature`, y el turno siguiente que devuelve
// esa llamada SIN ella recibe 400 «Function call is missing a thought_signature
// in functionCall parts» (banco BFCL de gama alta contra la 0.4.31, PR #398:
// 50 de 50 continuaciones multiturno). La guía de Google lo dice en general
// —«Thought signatures … are required to maintain reasoning continuity across
// multi-turn interactions» (https://ai.google.dev/gemini-api/docs/thinking,
// «Last updated 2026-09-25 UTC»), y «The SDKs automatically handle thought
// signatures for you» (https://ai.google.dev/gemini-api/docs/function-calling,
// «Last updated 2026-09-23 UTC»)—, pero la de compatibilidad con OpenAI
// (https://ai.google.dev/gemini-api/docs/openai, «Last updated 2026-09-02 UTC»)
// no documenta el campo; la forma es la medida en el cable. Todas consultadas
// el 2026-09-29.
//
// Se guarda y se devuelve SIN MIRAR DENTRO: solo un objeto no nulo cuenta, y
// cualquier otra cosa es no tenerlo. No entra en la clave exacta, ni en la de
// singleflight, ni en la huella del prefijo (esas listan sus campos uno a uno):
// es un token del proveedor distinto en cada generación, como el `id` de la
// llamada, que por eso también entra canonizado a su ordinal. Sí entra en
// `huellaDePeticion` (la regla de la referencia, pipeline/referencia.ts), que
// serializa los mensajes enteros: esa huella promete «los mismos bytes», y la
// firma son bytes que viajan.
function extraContentDe(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function esTextoNoVacio(v: unknown): boolean {
  return typeof v === "string" && v !== "";
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  /** 'auto' | 'default' | 'flex' | 'scale' | 'priority' | 'fast' — open set on purpose. */
  service_tier?: string;
  usage?: UsoDeChat;
}

// Un `chat.completion.chunk` del stream. El chunk de usage (con
// `stream_options.include_usage`) llega al final con `choices: []`.
interface TrozoDeChat {
  choices?: {
    delta?: {
      content?: string | null;
      refusal?: string | null;
      reasoning_content?: unknown;
      reasoning?: unknown;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
        extra_content?: unknown;
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: UsoDeChat | null;
  service_tier?: string;
  error?: unknown;
}

// El mismo texto en generate() y en generateStream(): quien lo capture para
// ramificar no tiene que conocer dos.
function mensajeDeUsoIncompleto(prompt: number | undefined, completion: number | undefined): string {
  return (
    `provider returned incomplete usage (prompt=${prompt ?? "absent"}, ` +
    `completion=${completion ?? "absent"}); cannot measure cost. ` +
    `For gateways/streaming, ensure usage reporting is enabled.`
  );
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
