/**
 * GEMINI POR SU API NATIVA EN EL BANCO — lo que comparten las cuatro baterías.
 * ---------------------------------------------------------------------------
 * Hasta la 0.4.33 el banco hablaba con Gemini por su endpoint compatible con
 * OpenAI (`…/v1beta/openai`), y BFCL y MT-Bench ni eso en el banco semanal. La
 * 0.5 recomienda el adaptador NATIVO (`GoogleProvider`, src/providers/google.ts,
 * #410): `generateContent`, `usageMetadata` con el pensamiento aparte, las
 * negativas en `promptFeedback`/`finishReason`. Un banco que mide otro cable del
 * que se recomienda no certifica lo que se instala.
 *
 * LA REGLA, igual en todas las baterías: la URL base decide el dialecto.
 *   · `…/v1beta` (o cualquier ruta que NO acabe en `/openai`) → API nativa: el
 *     brazo B lleva `GoogleProvider` dentro de la capa y el brazo A llama a
 *     `GoogleProvider` DIRECTO, sin capa — el mismo cuerpo que el adaptador
 *     arma, como el brazo A de Anthropic usa `AnthropicProvider` directo
 *     («anthropic-nativo» en transporte.ts).
 *   · `…/v1beta/openai` → el endpoint compatible de siempre, sin cambios (quien
 *     reproduzca una tirada vieja la reproduce igual).
 *   · Sin URL → la nativa oficial.
 *
 * Y las credenciales: `BVSALA_DEMO_GOOGLE_BASE_URL` / `BVSALA_DEMO_GOOGLE_API_KEY`
 * (las del banco semanal; el secreto GEMINI_API_KEY del workflow), con las
 * `BVSALA_SONDA_*` de antes como respaldo si apuntan al host oficial de Google.
 *
 * Los lectores de la respuesta son del BANCO, no del adaptador: el brazo A se
 * mide con la aritmética del banco y no con la de la capa (doctrina A/B de
 * benchmarks/README.md). Puro: sin red ni entorno salvo lo que se le pasa.
 */

/** La base oficial de la API nativa (la misma que `BASE_OFICIAL` del adaptador). */
export const BASE_NATIVA_DE_GEMINI = "https://generativelanguage.googleapis.com/v1beta";
export const HOST_DE_GEMINI = "generativelanguage.googleapis.com";

export type DialectoDeGoogle = "nativo" | "compatible";

/** ¿Qué dialecto habla esta URL base? `/openai` al final = el endpoint compatible. */
export function dialectoDeGoogle(baseUrl: string | undefined): DialectoDeGoogle {
  if (!baseUrl) return "nativo";
  return /\/openai\/?$/.test(baseUrl.trim()) ? "compatible" : "nativo";
}

/**
 * La base NATIVA a partir de lo que diga el entorno: sin esquema se le pone
 * `https://`; un host pelado recibe `/v1beta`; una base compatible
 * (`…/v1beta/openai`) pierde el `/openai`. La barra final se quita.
 */
export function baseNativaDeGemini(valor?: string): string {
  let b = (valor ?? BASE_NATIVA_DE_GEMINI).trim();
  if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
  b = b.replace(/\/+$/, "").replace(/\/openai$/, "");
  const u = new URL(b);
  if (u.pathname === "" || u.pathname === "/") return `${u.origin}/v1beta`;
  return b;
}

/**
 * El endpoint de Google que declara el entorno (solo se mira si la clave ESTÁ;
 * su valor viaja al adaptador y a nada más). `baseUrl` ausente = no se declaró
 * ninguno: quien llama decide si usa la oficial.
 */
export function googleDelEntorno(env: NodeJS.ProcessEnv): { baseUrl?: string; apiKey?: string } {
  const demoBase = env["BVSALA_DEMO_GOOGLE_BASE_URL"] || undefined;
  const demoClave = env["BVSALA_DEMO_GOOGLE_API_KEY"] || undefined;
  if (demoBase || demoClave) {
    return { ...(demoBase ? { baseUrl: demoBase } : {}), ...(demoClave ? { apiKey: demoClave } : {}) };
  }
  // Respaldo: la sonda (#363), solo si apunta al host oficial de Google.
  const sonda = env["BVSALA_SONDA_BASE_URL"];
  if (!sonda) return {};
  try {
    if (new URL(sonda).hostname !== HOST_DE_GEMINI) return {};
  } catch {
    return {};
  }
  const clave = env["BVSALA_SONDA_API_KEY"] || undefined;
  return { baseUrl: sonda, ...(clave ? { apiKey: clave } : {}) };
}

// ── Lectura de una respuesta de `generateContent` ───────────────────────────

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const entero = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** El `usageMetadata` en el vocabulario del banco. Tokens; nada de precios. */
export interface UsoNativoDeGemini {
  /** Entrada facturable: `promptTokenCount` + `toolUsePromptTokenCount`. */
  entrada: number;
  /** De ella, leída de caché (implícita): `cachedContentTokenCount`. */
  cacheLeida: number;
  /** Salida visible: `candidatesTokenCount`. */
  visible: number;
  /** Pensamiento: `thoughtsTokenCount` (Google lo factura como salida). */
  pensamiento: number;
  /** Salida facturable: visible + pensamiento (+ lo que `totalTokenCount` diga de más). */
  salida: number;
}

/**
 * El uso de una respuesta nativa, o `null` si no trae los contadores que hacen
 * falta para cobrarla (sin `promptTokenCount`, o sin salida conocida): el banco
 * no convierte un contador ausente en un 0 que parezca ahorro.
 *
 * «Output price (including thinking tokens)» (https://ai.google.dev/gemini-api/docs/pricing):
 * el pensamiento es salida. Si `totalTokenCount` trae más de lo que suman las
 * partes, el hueco también se cobra como salida (la misma regla que el lector
 * del endpoint compatible en bfcl/cable.ts).
 */
export function usoNativoDeGemini(respuesta: unknown): UsoNativoDeGemini | null {
  const u = obj(obj(respuesta)?.["usageMetadata"]);
  if (!u || !entero(u["promptTokenCount"])) return null;
  const prompt = u["promptTokenCount"];
  const herramientas = entero(u["toolUsePromptTokenCount"]) ? u["toolUsePromptTokenCount"] : 0;
  const visible = entero(u["candidatesTokenCount"]) ? u["candidatesTokenCount"] : 0;
  const pensamiento = entero(u["thoughtsTokenCount"]) ? u["thoughtsTokenCount"] : 0;
  const total = entero(u["totalTokenCount"]) ? u["totalTokenCount"] : null;
  if (!entero(u["candidatesTokenCount"]) && total === null) return null;
  const hueco = total !== null ? Math.max(0, total - prompt - herramientas - visible - pensamiento) : 0;
  return {
    entrada: prompt + herramientas,
    cacheLeida: entero(u["cachedContentTokenCount"]) ? Math.min(u["cachedContentTokenCount"], prompt) : 0,
    visible,
    pensamiento: pensamiento + hueco,
    salida: visible + pensamiento + hueco,
  };
}

export interface LlamadaNativaDeGemini {
  /** `functionCall.id`, solo si el API lo trajo (Gemini 3 no siempre lo da). */
  id?: string;
  name: string;
  /** Los argumentos como JSON en crudo (así los entrega el adaptador: `JSON.stringify(args)`). */
  arguments: string;
  /** La `thoughtSignature` de la parte, opaca; Gemini 3 exige devolverla. */
  firma?: string;
}

export interface LecturaNativaDeGemini {
  /** El texto visible: las partes `text` que no son pensamiento. */
  texto: string;
  llamadas: LlamadaNativaDeGemini[];
  /** `candidates[0].finishReason` tal cual (`STOP`, `MAX_TOKENS`, `SAFETY`…), o null. */
  parada: string | null;
  /** `promptFeedback.blockReason`: el prompt se bloqueó sin generar nada. */
  bloqueo: string | null;
}

/** Texto, llamadas y parada de una respuesta de `generateContent` (o de UN trozo SSE). */
export function lecturaNativaDeGemini(respuesta: unknown): LecturaNativaDeGemini {
  const r = obj(respuesta);
  const cand = obj((Array.isArray(r?.["candidates"]) ? (r!["candidates"] as unknown[]) : [])[0]);
  const partes = (Array.isArray(obj(cand?.["content"])?.["parts"]) ? (obj(cand!["content"])!["parts"] as unknown[]) : [])
    .map(obj)
    .filter((p): p is Obj => !!p);
  let texto = "";
  const llamadas: LlamadaNativaDeGemini[] = [];
  for (const p of partes) {
    if (typeof p["text"] === "string" && p["thought"] !== true) texto += p["text"];
    const fc = obj(p["functionCall"]);
    if (fc && typeof fc["name"] === "string") {
      llamadas.push({
        ...(typeof fc["id"] === "string" && fc["id"] !== "" ? { id: fc["id"] } : {}),
        name: fc["name"],
        arguments: JSON.stringify(fc["args"] ?? {}),
        ...(typeof p["thoughtSignature"] === "string" && p["thoughtSignature"] !== "" ? { firma: p["thoughtSignature"] } : {}),
      });
    }
  }
  const bloqueo = obj(r?.["promptFeedback"])?.["blockReason"];
  return {
    texto,
    llamadas,
    parada: typeof cand?.["finishReason"] === "string" ? (cand["finishReason"] as string) : null,
    bloqueo: typeof bloqueo === "string" && bloqueo !== "" ? bloqueo : null,
  };
}

/**
 * Las paradas nativas que son una NEGATIVA del proveedor (filtro de seguridad
 * o de política), no un final normal: la lista de la referencia oficial
 * (https://ai.google.dev/api/generate-content#FinishReason, consultada el
 * 2026-09-29) que el adaptador traduce a `content_filter`, OTHER incluida (el
 * endpoint compatible la devolvía como `content_filter` en XSTest, #396).
 * Copiada y no importada: el banco no mide con las reglas del producto.
 */
export const PARADAS_DE_FILTRO_DE_GEMINI: readonly string[] = [
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
];
