import type { MotivoDeParada } from "./motivo-de-parada.js";
import type { ChatMessage, ToolCallRequest } from "../contracts/types.js";
import type { ProviderUsage } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// EL ADAPTADOR NATIVO DE GEMINI: `generateContent` / `streamGenerateContent`.
// ═══════════════════════════════════════════════════════════════════════════
//
// Hasta la 0.4.32 la capa solo hablaba con Gemini por su endpoint compatible con
// OpenAI (`/v1beta/openai/`), y ese endpoint esconde justo lo que la capa
// necesita para medir: el motivo de una negativa (llega como
// `"content_filter: OTHER"`, sin forma documentada), el pensamiento (solo está
// en `total_tokens`), la firma de pensamiento de las herramientas (en un
// `extra_content` sin documentar) y `promptFeedback` (no existe). Cuatro fallos
// de los bancos de gama alta contra la 0.4.31 (PRs #396, #397, #398 y #400,
// corregidos en #402) salieron de ahí. Este adaptador habla el API NATIVO, donde
// todo eso son campos documentados.
//
// FUENTES OFICIALES, todas consultadas el 2026-09-29:
//   · Referencia de `generateContent` (Content, Part, FunctionCall,
//     FunctionResponse, GenerationConfig, ThinkingConfig, UsageMetadata,
//     FinishReason, BlockReason, ServiceTier):
//     https://ai.google.dev/api/generate-content («Last updated 2026-09-23 UTC»).
//   · Pensamiento y firmas: https://ai.google.dev/gemini-api/docs/thinking
//     («Last updated 2026-09-25 UTC»): «In the generateContent API, there are no
//     dedicated thought blocks. Because of this, signatures are metadata that
//     can be attached to any part, such as living inside functionCall parts or
//     the final part of a response», y «response pricing is the sum of output
//     tokens and thinking tokens».
//   · Herramientas: https://ai.google.dev/gemini-api/docs/function-calling
//     («Last updated 2026-09-23 UTC») y la guía de migración, que conserva el
//     ejemplo REST de `generateContent` con `functionResponse` en un turno
//     `user`: https://ai.google.dev/gemini-api/docs/migrate-to-interactions
//     («Last updated 2026-09-23 UTC»).
//   · Salidas estructuradas: https://ai.google.dev/gemini-api/docs/structured-output
//     («Last updated 2026-09-23 UTC»).
//   · Caché implícita: https://ai.google.dev/gemini-api/docs/caching
//     («Last updated 2026-09-02 UTC»): «Implicit caching is enabled by default
//     for all Gemini 2.5 and newer models … We automatically pass on cost
//     savings if your request hits caches».
//   · Esfuerzo ↔ nivel/presupuesto de pensamiento: la tabla de
//     https://ai.google.dev/gemini-api/docs/openai («Last updated 2026-09-02 UTC»).
//   · Flex: https://ai.google.dev/gemini-api/docs/flex-inference
//     («Last updated 2026-09-23 UTC»).
//
// Y LO MEDIDO EN EL CABLE (sonda del 2026-09-29 contra gemini-3.8-flash):
//   · el texto trae `thoughtSignature` en su última parte, y en stream llega en
//     una parte final con `text: ""`;
//   · en llamadas paralelas SOLO la primera `functionCall` lleva la firma; cada
//     llamada trae `id` (`"call_50130"`);
//   · devolver la llamada sin su firma es un 400 «Function call is missing a
//     thought_signature in functionCall parts»;
//   · el stream repite `usageMetadata` ACUMULADO en cada trozo, y el último
//     lleva `finishReason`;
//   · `usageMetadata.serviceTier` viene en el cuerpo (`"standard"`), y la
//     cabecera `x-gemini-service-tier` también;
//   · `thinkingLevel: "MINIMAL"` en gemini-3.8-flash es un 400 «Thinking level
//     MINIMAL is not supported for this model».
//
// ESTE MÓDULO ES INTERNO: la traducción entre la forma neutra y el cable de
// Gemini. No se reexporta por ningún barril (sus nombres son de la casa, no del
// producto); la superficie pública es `GoogleProvider` (google.ts).

/** Gemini's `ThinkingConfig`, as its API reference defines it. */
export interface GoogleThinkingConfig {
  thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | (string & {});
  thinkingBudget?: number;
  includeThoughts?: boolean;
}


export const BASE_OFICIAL = "https://generativelanguage.googleapis.com/v1beta";

// La cabecera con la que Google dice qué tier sirvió. En el API nativo el
// cuerpo lo dice también (`usageMetadata.serviceTier`, documentado en la
// referencia), y el cuerpo manda: la cabecera solo se lee si el cuerpo calló y
// solo en el host oficial, y lo leído de ahí queda atestiguado como tal.
export const CABECERA_TIER = "x-gemini-service-tier";

// LAS PARADAS QUE SON UNA NEGATIVA. Del enum `FinishReason` de la referencia,
// las que dicen que el contenido fue MARCADO, BLOQUEADO o FILTRADO: SAFETY,
// RECITATION, LANGUAGE («flagged for using an unsupported language»), BLOCKLIST,
// PROHIBITED_CONTENT, SPII, las de imagen y ESCALATION («filtered by an
// escalation rule»). Y OTHER, que la referencia llama «Unknown reason» pero que
// el endpoint compatible devolvía como `content_filter: OTHER` en 38 de 450
// llamadas de XSTest (PR #396): tratarla como negativa solo puede bajar lo
// acreditado (no se cachea ni se repite), nunca subirlo.
const PARADAS_DE_FILTRO = new Set([
  "SAFETY",
  "RECITATION",
  "LANGUAGE",
  "OTHER",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "IMAGE_OTHER",
  "ESCALATION",
]);

// Las paradas que no son una respuesta ni una negativa sino un fallo de la
// generación: se entregan con su nombre nativo y NO se cachean (`replayable:
// false`), porque repetirlas desde caché serviría el fallo a cada petición
// idéntica.
const PARADAS_DE_FALLO = new Set([
  "MALFORMED_FUNCTION_CALL",
  "UNEXPECTED_TOOL_CALL",
  "TOO_MANY_TOOL_CALLS",
  "MISSING_THOUGHT_SIGNATURE",
  "MALFORMED_RESPONSE",
  "NO_IMAGE",
]);

/**
 * Traduce la parada nativa al vocabulario neutro. `bloqueo` es
 * `promptFeedback.blockReason`: con él no hay candidatos y la petición entera
 * fue rechazada, que para la capa es una negativa del proveedor.
 */
export function traducirParadaDeGemini(
  nativa: string | undefined,
  bloqueo: string | undefined,
  hayLlamadas: boolean,
): { parada?: MotivoDeParada; detalle?: string; reproducible: boolean } {
  if (bloqueo !== undefined && bloqueo !== "" && bloqueo !== "BLOCK_REASON_UNSPECIFIED") {
    return { parada: "content_filter", detalle: bloqueo, reproducible: true };
  }
  if (nativa === undefined || nativa === "" || nativa === "FINISH_REASON_UNSPECIFIED") {
    return { reproducible: true };
  }
  if (nativa === "STOP") return { parada: hayLlamadas ? "tool_calls" : "stop", reproducible: true };
  if (nativa === "MAX_TOKENS") return { parada: "length", reproducible: true };
  if (PARADAS_DE_FILTRO.has(nativa)) return { parada: "content_filter", detalle: nativa, reproducible: true };
  // Lo demás (un fallo de la generación o una parada que aún no conocemos) sale
  // `other` con el nombre nativo como detalle: desde la 0.5 `finishReason` es
  // un conjunto cerrado (motivo-de-parada.ts).
  return { parada: "other", detalle: nativa, reproducible: !PARADAS_DE_FALLO.has(nativa) };
}

// ── El esfuerzo de razonamiento, en el idioma de cada familia ────────────────
//
// La tabla oficial (https://ai.google.dev/gemini-api/docs/openai, «Last updated
// 2026-09-02 UTC»): Gemini 3 usa `thinkingLevel`, Gemini 2.5 `thinkingBudget`.
//
//   reasoning_effort   3.1 Pro   3.x Flash / Flash-Lite   2.5 (presupuesto)
//   minimal            low       minimal                   1.024
//   low                low       low                       1.024
//   medium             medium    medium                    8.192
//   high               high      high                      24.576
//
// «If you want to disable thinking, you can set reasoning_effort to "none" for
// 2.5 models. Reasoning cannot be turned off for Gemini 2.5 Pro or 3 models.»
// Así que `none` en 2.5 (salvo Pro) es presupuesto 0, y en los demás es el
// nivel más bajo que el modelo admite, con aviso: nadie pidió pensar más, pero
// el proveedor no deja pensar nada. `xhigh` no existe en Gemini: es `high`.

function esFamilia25(model: string): boolean {
  return /(^|\/)gemini-2\.5/.test(model);
}

function esPro(model: string): boolean {
  return /-pro\b/.test(model);
}

/** El `thinkingConfig` que corresponde a un `reasoningEffort`, o `null` si no hay traducción. */
export function pensamientoPorEsfuerzo(
  model: string,
  esfuerzo: string,
): { config: GoogleThinkingConfig; noSeApaga: boolean } | null {
  const e = esfuerzo.toLowerCase();
  if (esFamilia25(model)) {
    const presupuestos: Record<string, number> = {
      minimal: 1024,
      low: 1024,
      medium: 8192,
      high: 24576,
      xhigh: 24576,
    };
    if (e === "none") {
      return esPro(model) ? null : { config: { thinkingBudget: 0 }, noSeApaga: false };
    }
    const p = presupuestos[e];
    return p === undefined ? null : { config: { thinkingBudget: p }, noSeApaga: false };
  }
  const bajo = esPro(model) || model === "gemini-3.8-flash" || model === "gemini-3.8-flash-latest" ? "LOW" : "MINIMAL";
  switch (e) {
    case "none":
      return { config: { thinkingLevel: bajo }, noSeApaga: true };
    case "minimal":
      return { config: { thinkingLevel: bajo }, noSeApaga: false };
    case "low":
      return { config: { thinkingLevel: "LOW" }, noSeApaga: false };
    case "medium":
      return { config: { thinkingLevel: "MEDIUM" }, noSeApaga: false };
    case "high":
    case "xhigh":
      return { config: { thinkingLevel: "HIGH" }, noSeApaga: false };
    default:
      // Un valor que la tabla no conoce viaja como nivel, en mayúsculas: si el
      // modelo no lo admite, su 400 es la respuesta.
      return { config: { thinkingLevel: esfuerzo.toUpperCase() }, noSeApaga: false };
  }
}

// ¿Este 400 dice que el MODELO no admite el nivel de pensamiento que se mandó?
// Medido: «Thinking level MINIMAL is not supported for this model. Please retry
// with other thinking level.» Devuelve el nivel rechazado, o `null`.
export function nivelRechazado(detalle: string): string | null {
  const m = /thinking level (\w+) is not supported/i.exec(detalle);
  return m ? m[1]!.toUpperCase() : null;
}

// ── Los tipos del cable ──────────────────────────────────────────────────────

interface ParteGemini {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

interface ContenidoGemini {
  role?: string;
  parts?: ParteGemini[];
}

export interface UsoGemini {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  toolUsePromptTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  serviceTier?: string;
}

export interface RespuestaGemini {
  candidates?: { content?: ContenidoGemini; finishReason?: string; finishMessage?: string; index?: number }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: UsoGemini;
  modelVersion?: string;
  responseId?: string;
  error?: unknown;
}

// ── La firma de pensamiento, en la MISMA forma que el adaptador compatible ──
//
// El endpoint compatible la devuelve en `extra_content.google.thought_signature`
// y el adaptador compatible la guarda tal cual en `ToolCallRequest.extraContent`.
// Aquí se guarda en esa misma forma a propósito: un historial que empezó por un
// adaptador puede seguir por el otro sin que el cliente toque nada.
function extraDeFirma(firma: string | undefined): Record<string, unknown> | undefined {
  return typeof firma === "string" && firma !== "" ? { google: { thought_signature: firma } } : undefined;
}

function firmaDeExtra(extra: Record<string, unknown> | undefined): string | undefined {
  const g = extra?.["google"];
  if (g === null || typeof g !== "object") return undefined;
  const f = (g as Record<string, unknown>)["thought_signature"];
  return typeof f === "string" && f !== "" ? f : undefined;
}

// Los argumentos de una llamada viajan como OBJETO (`args: Struct`) y la capa
// los entrega como el JSON crudo que serializó el modelo. De vuelta se parsean;
// si no son un objeto JSON (un cliente que los reescribió a mano), viaja `{}` y
// no se inventa nada.
function argsDeVuelta(argumentos: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(argumentos === "" ? "{}" : argumentos);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// `FunctionResponse.response` es un OBJETO («Required. The function response in
// JSON object format … if the function call failed to execute, the response can
// have an "error" key»). El contenido de un mensaje `tool` es texto: si es un
// objeto JSON viaja tal cual; si no, bajo `result` (el ejemplo oficial) o, con
// `isError`, bajo `error`.
function respuestaDeHerramienta(m: ChatMessage): Record<string, unknown> {
  if (m.isError === true) return { error: m.content };
  try {
    const v: unknown = JSON.parse(m.content);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* texto plano */
  }
  return { result: m.content };
}

/**
 * Los mensajes neutros en `systemInstruction` + `contents`.
 *
 * · Los `system` de CABECERA van a `systemInstruction`, una parte cada uno. Un
 *   `system` tardío va como texto de usuario (Gemini solo tiene `user` y
 *   `model`), como hace el adaptador de Anthropic.
 * · Un turno `assistant` con `toolCalls` es un turno `model` con su texto (si lo
 *   hay) y una parte `functionCall` por llamada, cada una con su firma.
 * · Los `tool` que lo siguen son UN turno `user` con una parte
 *   `functionResponse` por resultado. El nombre sale del mensaje o, si falta,
 *   de la llamada con ese id (o de la misma posición).
 * · Turnos seguidos del mismo rol se funden en uno.
 */
export function contenidosDeGemini(mensajes: readonly ChatMessage[]): {
  systemInstruction?: ContenidoGemini;
  contents: ContenidoGemini[];
} {
  const sistema: ParteGemini[] = [];
  const contents: ContenidoGemini[] = [];
  let cabecera = true;
  let ultimasLlamadas: ToolCallRequest[] = [];
  let resultadosTrasLlamadas = 0;

  const empujar = (role: "user" | "model", parts: ParteGemini[]): void => {
    if (parts.length === 0) return;
    const ultimo = contents[contents.length - 1];
    if (ultimo && ultimo.role === role) ultimo.parts!.push(...parts);
    else contents.push({ role, parts });
  };

  for (const m of mensajes) {
    if (m.role === "system" && cabecera) {
      if (m.content !== "") sistema.push({ text: m.content });
      continue;
    }
    cabecera = false;
    if (m.role === "tool") {
      const porId = m.toolCallId ? ultimasLlamadas.find((c) => c.id === m.toolCallId) : undefined;
      const llamada = porId ?? ultimasLlamadas[resultadosTrasLlamadas];
      const nombre = m.name ?? llamada?.name;
      resultadosTrasLlamadas += 1;
      if (!nombre) {
        // Sin nombre no hay `functionResponse` válida: viaja como texto.
        empujar("user", m.content !== "" ? [{ text: m.content }] : []);
        continue;
      }
      empujar("user", [
        {
          functionResponse: {
            // El id solo viaja si es el de una llamada de este historial: un id
            // que Gemini no emitió no empareja nada.
            ...(porId?.id ? { id: porId.id } : {}),
            name: nombre,
            response: respuestaDeHerramienta(m),
          },
        },
      ]);
      continue;
    }
    if (m.role === "assistant") {
      const partes: ParteGemini[] = m.content !== "" ? [{ text: m.content }] : [];
      const llamadas = m.toolCalls ?? [];
      for (const c of llamadas) {
        const firma = firmaDeExtra(c.extraContent);
        partes.push({
          functionCall: { ...(c.id ? { id: c.id } : {}), name: c.name, args: argsDeVuelta(c.arguments) },
          ...(firma !== undefined ? { thoughtSignature: firma } : {}),
        });
      }
      ultimasLlamadas = llamadas;
      resultadosTrasLlamadas = 0;
      empujar("model", partes);
      continue;
    }
    // `user` y `system` tardío.
    empujar("user", m.content !== "" ? [{ text: m.content }] : []);
  }
  return { ...(sistema.length > 0 ? { systemInstruction: { parts: sistema } } : {}), contents };
}

// ── El uso facturado ─────────────────────────────────────────────────────────

function entero(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/**
 * `usageMetadata` en la forma neutra.
 *
 * · ENTRADA: `promptTokenCount` (que ya incluye lo leído de caché: «When
 *   cachedContent is set, this is still the total effective prompt size») más
 *   `toolUsePromptTokenCount` si lo hubiera (el prompt de las herramientas del
 *   propio Google, que se factura como entrada; este adaptador no las manda).
 * · CACHÉ: `cachedContentTokenCount`, la parte del prompt leída de la caché
 *   implícita, dentro de la entrada como en OpenAI.
 * · SALIDA: `candidatesTokenCount + thoughtsTokenCount`, porque el pensamiento
 *   se factura como salida («response pricing is the sum of output tokens and
 *   thinking tokens»). Y si `totalTokenCount` trae aún más («prompt + thoughts +
 *   response candidates»), ese hueco también es salida facturada: se suma.
 * · RAZONAMIENTO: el pensamiento más el hueco. Solo se afirma 0 cuando el total
 *   lo confirma y la respuesta no trae partes de pensamiento.
 * · INCOMPLETO: sin `promptTokenCount`, o sin salida que se pueda saber (sin
 *   `candidatesTokenCount` y sin total que diga que no hubo candidatos).
 */
export function usoDeGemini(u: UsoGemini | undefined, huboPartesDePensamiento: boolean): ProviderUsage {
  const prompt = u?.promptTokenCount;
  const candidatos = u?.candidatesTokenCount;
  const pensamiento = u?.thoughtsTokenCount;
  const herramientas = u?.toolUsePromptTokenCount;
  const total = u?.totalTokenCount;

  const entrada = (entero(prompt) ? prompt : 0) + (entero(herramientas) ? herramientas : 0);
  const salidaVisible = entero(candidatos) ? candidatos : 0;
  const pensado = entero(pensamiento) ? pensamiento : 0;
  const hueco =
    entero(total) && entero(prompt)
      ? Math.max(0, total - prompt - salidaVisible - pensado - (entero(herramientas) ? herramientas : 0))
      : 0;

  let razonamiento: number | undefined;
  if (entero(pensamiento) || entero(total)) razonamiento = pensado + hueco;
  if (razonamiento === 0 && huboPartesDePensamiento) razonamiento = undefined;

  const salidaConocida = entero(candidatos) || (entero(total) && entero(prompt));
  const completo = entero(prompt) && salidaConocida;
  return {
    inputTokens: entrada,
    outputTokens: salidaVisible + pensado + hueco,
    ...(entero(u?.cachedContentTokenCount) ? { cachedInputTokens: u!.cachedContentTokenCount } : {}),
    ...(razonamiento !== undefined ? { reasoningTokens: razonamiento } : {}),
    ...(completo ? {} : { complete: false }),
  };
}

// ── El acumulador: una respuesta entera o los trozos de un stream ────────────
//
// El JSON de generate(), los trozos SSE y el array JSON que devuelve
// `streamGenerateContent` sin `alt=sse` son la MISMA forma (un
// `GenerateContentResponse` por trozo), así que se leen con el mismo código y
// generate() y generateStream() no pueden derivar.
export class Acumulador {
  texto = "";
  llamadas: ToolCallRequest[] = [];
  paradaNativa: string | undefined;
  bloqueo: string | undefined;
  uso: UsoGemini | undefined;
  huboPensamiento = false;
  idDeRespuesta: string | undefined;
  ultimo: RespuestaGemini | undefined;

  /** Añade un trozo y devuelve el texto nuevo que trajo. */
  sumar(r: RespuestaGemini): string {
    this.ultimo = r;
    if (r.error != null) {
      const e = r.error as { message?: unknown; code?: unknown };
      const mensaje = typeof e.message === "string" ? e.message : JSON.stringify(r.error);
      throw new Error(`provider stream error: ${mensaje}`);
    }
    // El uso llega ACUMULADO en cada trozo: vale el último.
    if (r.usageMetadata != null && typeof r.usageMetadata === "object") this.uso = r.usageMetadata;
    if (typeof r.responseId === "string" && r.responseId !== "") this.idDeRespuesta ??= r.responseId;
    const b = r.promptFeedback?.blockReason;
    if (typeof b === "string" && b !== "") this.bloqueo = b;
    let nuevo = "";
    const c = r.candidates?.[0];
    for (const p of c?.content?.parts ?? []) {
      if (p.thought === true) {
        // Un resumen de pensamiento (`includeThoughts`): se factura, no es la respuesta.
        this.huboPensamiento = true;
        continue;
      }
      if (p.functionCall && typeof p.functionCall.name === "string" && p.functionCall.name !== "") {
        const extra = extraDeFirma(p.thoughtSignature);
        this.llamadas.push({
          ...(typeof p.functionCall.id === "string" && p.functionCall.id !== "" ? { id: p.functionCall.id } : {}),
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {}),
          ...(extra !== undefined ? { extraContent: extra } : {}),
        });
        continue;
      }
      if (typeof p.text === "string" && p.text !== "") nuevo += p.text;
    }
    this.texto += nuevo;
    if (typeof c?.finishReason === "string" && c.finishReason !== "") this.paradaNativa = c.finishReason;
    return nuevo;
  }

  /** ¿Dijo el proveedor que había terminado? */
  terminado(): boolean {
    return this.paradaNativa !== undefined || this.bloqueo !== undefined;
  }
}

/** El id que va en la URL: sin `google/` (ni otro prefijo de proveedor) ni `models/`. */
export function modeloDelCable(model: string): string {
  const sinModels = model.replace(/^models\//, "");
  return sinModels.includes("/") ? sinModels.replace(/^[^/]+\//, "").replace(/^models\//, "") : sinModels;
}

export function cabecera(response: Response, nombre: string): string | undefined {
  try {
    const v = (response.headers as Headers | undefined)?.get?.(nombre);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function textoSeguro(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
