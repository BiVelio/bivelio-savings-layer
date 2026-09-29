/**
 * LOS DOS BRAZOS DE LA BATERÍA BFCL.
 * ---------------------------------------------------------------------------
 *   A · llamada DIRECTA al proveedor con herramientas nativas (tool_use de
 *       Mensajes de Anthropic / tools de Chat Completions), escrita a mano aquí:
 *       sin la capa y sin sus adaptadores. Es lo que manda un integrador.
 *   B · la MISMA petición por `createSavingsLayer(...).generate()` de la 0.4.30
 *       (ver procedencia.ts), con el adaptador del propio paquete y el catálogo
 *       de herramientas tal como llega de un cliente: nombre, descripción y
 *       esquema, sin `intents` ni `risk`.
 *
 * Mismos parámetros en los dos: `max_tokens` 4096 en Anthropic (el defecto del
 * adaptador de la capa; la API lo exige), ninguno en OpenAI (el adaptador no
 * manda ninguno sin contrato), y el muestreo del banco (`muestreoPareadoPara`:
 * temperatura 0 y semilla 7 donde el modelo lo admite, nada donde no).
 */
import type { ChatMessage, SavingsLayer, SavingsResult, ToolDescriptor } from "../../../src/index.js";
import type { Familia } from "./cable.js";
import { herramientasAnthropic, herramientasOpenAI, type EsquemaJson, type HerramientaNeutral } from "./esquema.js";

export interface LlamadaHerramienta {
  id?: string;
  name: string;
  arguments: string;
  /**
   * El `extra_content` opaco que el proveedor adjunta a la llamada (Gemini 3 por su
   * endpoint compatible con OpenAI: `{ google: { thought_signature } }`). Gemini 3
   * EXIGE devolverlo en el turno siguiente (sin él: HTTP 400 «Function call is
   * missing a thought_signature»), así que un integrador que lo recibe lo reenvía.
   */
  extra?: EsquemaJson;
}

export type Turno =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; llamadas: LlamadaHerramienta[] }
  | { role: "tool"; id: string; name: string; content: string; isError?: boolean };

export interface Muestreo {
  temperature?: number;
  seed?: number;
}

export interface Endpoint {
  familia: Familia;
  /** p. ej. https://api.anthropic.com/v1 */
  baseUrl: string;
  apiKey: string;
}

/** `api.openai.com` / `https://api.openai.com` / `https://api.openai.com/v1` → `https://api.openai.com/v1`. */
export function normalizarBase(valor: string): string {
  const u = new URL(valor.includes("://") ? valor : `https://${valor}`);
  if (u.pathname === "" || u.pathname === "/") u.pathname = "/v1";
  return u.toString().replace(/\/$/, "");
}

export function desnudo(modelo: string): string {
  const i = modelo.lastIndexOf("/");
  return i >= 0 ? modelo.slice(i + 1) : modelo;
}

// ── Brazo A: el cuerpo que manda un integrador ────────────────────────────

function mensajesAnthropic(turnos: Turno[]): EsquemaJson[] {
  const out: EsquemaJson[] = [];
  for (const t of turnos) {
    if (t.role === "user") out.push({ role: "user", content: t.content });
    else if (t.role === "assistant") {
      const bloques: EsquemaJson[] = [];
      if (t.content) bloques.push({ type: "text", text: t.content });
      for (const l of t.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.name, input: JSON.parse(l.arguments || "{}") });
      out.push({ role: "assistant", content: bloques });
    } else {
      const bloque: EsquemaJson = { type: "tool_result", tool_use_id: t.id, content: t.content, ...(t.isError ? { is_error: true } : {}) };
      const ultimo = out[out.length - 1];
      // Todos los resultados de un turno van en UN mensaje de usuario, como exige la API.
      if (ultimo && ultimo["role"] === "user" && Array.isArray(ultimo["content"]) && (ultimo["content"] as EsquemaJson[]).every((b) => b["type"] === "tool_result")) {
        (ultimo["content"] as EsquemaJson[]).push(bloque);
      } else out.push({ role: "user", content: [bloque] });
    }
  }
  return out;
}

function mensajesOpenAI(turnos: Turno[]): EsquemaJson[] {
  return turnos.map((t) => {
    if (t.role === "user") return { role: "user", content: t.content };
    if (t.role === "assistant") {
      return {
        role: "assistant",
        content: t.content || null,
        tool_calls: t.llamadas.map((l) => ({ id: l.id, type: "function", function: { name: l.name, arguments: l.arguments }, ...(l.extra ? { extra_content: l.extra } : {}) })),
      };
    }
    // OpenAI no tiene bandera de error: el texto viaja igual (como hace la capa).
    return { role: "tool", tool_call_id: t.id, content: t.content };
  });
}

export function cuerpoBrazoA(familia: Familia, modelo: string, turnos: Turno[], hs: HerramientaNeutral[], m: Muestreo): EsquemaJson {
  if (familia === "anthropic") {
    return {
      model: desnudo(modelo),
      max_tokens: 4096,
      messages: mensajesAnthropic(turnos),
      ...(m.temperature != null ? { temperature: m.temperature } : {}),
      tools: herramientasAnthropic(hs),
    };
  }
  return {
    model: desnudo(modelo),
    messages: mensajesOpenAI(turnos),
    ...(m.temperature != null ? { temperature: m.temperature } : {}),
    ...(m.seed != null ? { seed: m.seed } : {}),
    tools: herramientasOpenAI(hs),
  };
}

/** Las llamadas de herramienta y el texto de una respuesta cruda del proveedor. */
export function leerRespuesta(familia: Familia, r: EsquemaJson | null): { texto: string; llamadas: LlamadaHerramienta[]; parada?: string } {
  if (!r) return { texto: "", llamadas: [] };
  if (familia === "anthropic") {
    const bloques = (Array.isArray(r["content"]) ? r["content"] : []) as EsquemaJson[];
    return {
      texto: bloques.filter((b) => b["type"] === "text").map((b) => String(b["text"] ?? "")).join(""),
      // Igual que el adaptador de la capa: `arguments` = JSON.stringify(input).
      llamadas: bloques
        .filter((b) => b["type"] === "tool_use")
        .map((b) => ({ id: String(b["id"]), name: String(b["name"]), arguments: JSON.stringify(b["input"] ?? {}) })),
      ...(typeof r["stop_reason"] === "string" ? { parada: r["stop_reason"] as string } : {}),
    };
  }
  const eleccion = ((r["choices"] as EsquemaJson[] | undefined) ?? [])[0];
  const msg = (eleccion?.["message"] ?? {}) as EsquemaJson;
  const tcs = (Array.isArray(msg["tool_calls"]) ? msg["tool_calls"] : []) as EsquemaJson[];
  return {
    texto: typeof msg["content"] === "string" ? (msg["content"] as string) : "",
    llamadas: tcs.map((tc) => {
      const f = (tc["function"] ?? {}) as EsquemaJson;
      const extra = tc["extra_content"];
      return {
        id: String(tc["id"]),
        name: String(f["name"]),
        arguments: String(f["arguments"] ?? ""),
        ...(extra && typeof extra === "object" && !Array.isArray(extra) ? { extra: extra as EsquemaJson } : {}),
      };
    }),
    ...(typeof eleccion?.["finish_reason"] === "string" ? { parada: eleccion["finish_reason"] as string } : {}),
  };
}

/** Brazo A: una llamada directa. Los errores del proveedor se devuelven como texto sin secretos. */
export async function llamarBrazoA(
  ep: Endpoint,
  cable: typeof fetch,
  cuerpo: EsquemaJson,
): Promise<{ ok: boolean; status: number; cuerpo: EsquemaJson | null }> {
  const url = ep.familia === "anthropic" ? `${ep.baseUrl}/messages` : `${ep.baseUrl}/chat/completions`;
  const cabeceras: Record<string, string> =
    ep.familia === "anthropic"
      ? { "content-type": "application/json", "x-api-key": ep.apiKey, "anthropic-version": "2023-06-01" }
      : { "content-type": "application/json", authorization: `Bearer ${ep.apiKey}` };
  const r = await cable(url, { method: "POST", headers: cabeceras, body: JSON.stringify(cuerpo) });
  const texto = await r.text();
  let json: EsquemaJson | null = null;
  try {
    json = JSON.parse(texto) as EsquemaJson;
  } catch {
    json = null;
  }
  return { ok: r.ok, status: r.status, cuerpo: json };
}

// ── Brazo B: la misma conversación por la capa ────────────────────────────

/** El catálogo tal como lo pasa un cliente: sin `intents` ni `risk` (la forma que documenta la sonda del SDK). */
export function herramientasDeLaCapa(hs: HerramientaNeutral[]): ToolDescriptor[] {
  return hs.map((h) => ({ id: h.nombre, description: h.descripcion, parameters: h.parametros })) as unknown as ToolDescriptor[];
}

export function mensajesDeLaCapa(turnos: Turno[]): ChatMessage[] {
  return turnos.map((t): ChatMessage => {
    if (t.role === "user") return { role: "user", content: t.content };
    // Se le pasa a la capa TODO lo que el cliente tiene de cada llamada, `extra_content` incluido
    // (como campo de más): si no llega al cable, es la capa quien lo pierde, no el banco.
    if (t.role === "assistant") {
      return { role: "assistant", content: t.content, toolCalls: t.llamadas.map((l) => ({ ...l, ...(l.extra ? { extra_content: l.extra } : {}) })) } as ChatMessage;
    }
    return { role: "tool", toolCallId: t.id, name: t.name, content: t.content, ...(t.isError ? { isError: true } : {}) };
  });
}

export async function llamarBrazoB(
  capa: SavingsLayer,
  modelo: string,
  turnos: Turno[],
  hs: HerramientaNeutral[],
  m: Muestreo,
): Promise<SavingsResult> {
  return capa.generate({
    model: modelo,
    messages: mensajesDeLaCapa(turnos),
    tools: herramientasDeLaCapa(hs),
    ...(m.temperature != null ? { temperature: m.temperature } : {}),
    ...(m.seed != null ? { seed: m.seed } : {}),
  });
}

// ── Comparación del cable A vs B ─────────────────────────────────────────

function sinCacheControl(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sinCacheControl);
  if (v && typeof v === "object") {
    const o: EsquemaJson = {};
    for (const [k, x] of Object.entries(v as EsquemaJson)) if (k !== "cache_control") o[k] = sinCacheControl(x);
    return o;
  }
  return v;
}

/** Claves en orden: el orden de las claves de un objeto JSON no cambia la petición. */
function clavesOrdenadas(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clavesOrdenadas);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as EsquemaJson).sort().map((k) => [k, clavesOrdenadas((v as EsquemaJson)[k])]));
  return v;
}

/** Un mensaje con `content` de texto plano o de un único bloque de texto se compara igual. */
function normalizarMensaje(m: unknown): unknown {
  const x = clavesOrdenadas(sinCacheControl(m)) as EsquemaJson;
  const c = x["content"];
  if (Array.isArray(c) && c.length === 1 && (c[0] as EsquemaJson)["type"] === "text") {
    return { ...x, content: (c[0] as EsquemaJson)["text"] };
  }
  return x;
}

const corto = (v: unknown): string => {
  const s = JSON.stringify(v) ?? "undefined";
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
};

/**
 * En qué se diferencia el cuerpo que mandó la capa del que manda el brazo A.
 * Se ignoran las marcas `cache_control` (se cuentan aparte) y el envoltorio de
 * un único bloque de texto. Todo lo demás es una diferencia a explicar.
 */
export function diferenciasDelCable(a: EsquemaJson, b: EsquemaJson): { diferencias: string[]; marcasDeCacheEnB: number } {
  const dif: string[] = [];
  const claves = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of claves) {
    if (k === "messages" || k === "tools") continue;
    if (JSON.stringify(sinCacheControl(a[k])) !== JSON.stringify(sinCacheControl(b[k]))) dif.push(`${k}: A=${corto(a[k])} B=${corto(b[k])}`);
  }
  const ta = (a["tools"] as EsquemaJson[] | undefined) ?? [];
  const tb = (b["tools"] as EsquemaJson[] | undefined) ?? [];
  const nombre = (t: EsquemaJson) => String(t["name"] ?? (t["function"] as EsquemaJson | undefined)?.["name"]);
  const na = ta.map(nombre);
  const nb = tb.map(nombre);
  const faltan = na.filter((n) => !nb.includes(n));
  const sobran = nb.filter((n) => !na.includes(n));
  if (faltan.length) dif.push(`tools: B omits ${faltan.length}/${na.length} (${faltan.join(", ")})`);
  if (sobran.length) dif.push(`tools: B adds ${sobran.join(", ")}`);
  for (const t of ta) {
    const par = tb.find((x) => nombre(x) === nombre(t));
    if (par && JSON.stringify(sinCacheControl(par)) !== JSON.stringify(t)) dif.push(`tools[${nombre(t)}]: A=${corto(t)} B=${corto(sinCacheControl(par))}`);
  }
  if (!faltan.length && !sobran.length && na.join() !== nb.join()) dif.push(`tools: order differs (A=${na.join(",")} B=${nb.join(",")})`);
  const ma = ((a["messages"] as unknown[]) ?? []).map(normalizarMensaje);
  const mb = ((b["messages"] as unknown[]) ?? []).map(normalizarMensaje);
  if (ma.length !== mb.length) dif.push(`messages: A has ${ma.length}, B has ${mb.length}`);
  for (let i = 0; i < Math.min(ma.length, mb.length); i++) {
    if (JSON.stringify(ma[i]) !== JSON.stringify(mb[i])) dif.push(`messages[${i}]: A=${corto(ma[i])} B=${corto(mb[i])}`);
  }
  const marcas = (JSON.stringify(b).match(/"cache_control"/g) ?? []).length;
  return { diferencias: dif, marcasDeCacheEnB: marcas };
}

/** ¿Devolvió la capa EXACTAMENTE las llamadas que trajo el proveedor? (nombre y argumentos en crudo) */
export function llamadasIguales(x: LlamadaHerramienta[], y: LlamadaHerramienta[]): boolean {
  return x.length === y.length && x.every((l, i) => l.name === y[i]!.name && l.arguments === y[i]!.arguments && (l.id ?? "") === (y[i]!.id ?? ""));
}
