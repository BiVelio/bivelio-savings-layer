/**
 * EL DIALECTO GEMINI EN EL GATEWAY.
 *
 * La CLI de Gemini (y cualquier cliente del protocolo generativelanguage)
 * habla `POST /v1beta/models/{model}:generateContent` y
 * `:streamGenerateContent`, con `usageMetadata` en la respuesta. Este módulo
 * lee ese contador SIN tocar el cuerpo: la respuesta se reenvía byte a byte y
 * el observador solo mira los objetos JSON que pasan por encima.
 *
 * Dos formas de stream conviven en la API de Gemini:
 *   · `:streamGenerateContent?alt=sse`  → SSE (`data: {…}` por línea).
 *   · `:streamGenerateContent` a secas  → JSON por trozos: un array cuyos
 *     elementos llegan separados por saltos de línea, sin cerrar del todo.
 * El observador acepta las dos; `usageMetadata` viaja en el ÚLTIMO trozo.
 */
import type { UsoSse } from "./medidor.js";

/** Qué dialecto Gemini es la ruta, si lo es. */
export function dialectoGemini(pathname: string): "generate" | "stream" | null {
  if (pathname.endsWith(":generateContent")) return "generate";
  if (pathname.endsWith(":streamGenerateContent")) return "stream";
  return null;
}

/** El modelo de una ruta `/v1beta/models/<model>:<op>`; nunca un trozo de query. */
export function modeloDeRutaGemini(pathname: string): string | null {
  const m = /\/models\/([^/:?]+)(?::|$)/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

export interface UsoMetadataGemini {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
}

/**
 * `usageMetadata` de Gemini → el `UsoSse` que el medidor sabe tarifar.
 * La entrada cacheada (caché implícita de Gemini) va a `cache_read_input_tokens`
 * y se resta de la ordinaria; los pensamientos se facturan como salida, igual
 * que hace el SDK nativo (`src/providers/google.ts`).
 */
export function usoDeGemini(u: UsoMetadataGemini | null | undefined): UsoSse | null {
  if (!u || typeof u.promptTokenCount !== "number" || typeof u.candidatesTokenCount !== "number") return null;
  const cacheLeida = typeof u.cachedContentTokenCount === "number" ? u.cachedContentTokenCount : 0;
  return {
    input_tokens: Math.max(0, u.promptTokenCount - cacheLeida),
    output_tokens: u.candidatesTokenCount + (typeof u.thoughtsTokenCount === "number" ? u.thoughtsTokenCount : 0),
    cache_read_input_tokens: cacheLeida,
  };
}

/**
 * Observa un stream de Gemini (SSE con `alt=sse` o JSON por líneas) sin tocarlo.
 * Guarda el último `usageMetadata`, si alguna candidata cerró por `SAFETY` y el
 * primer texto servido (para la heurística de negativas escritas del medidor).
 */
export class ObservadorGemini {
  private pendiente = "";
  private usoFinal: UsoSse | null = null;
  private negativaVista = false;
  private textoVisto = "";

  observar(chunk: Buffer | string): void {
    this.pendiente += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.pendiente.indexOf("\n")) !== -1) {
      const linea = this.pendiente.slice(0, idx);
      this.pendiente = this.pendiente.slice(idx + 1);
      this.observarLinea(linea);
    }
  }

  private observarLinea(linea: string): void {
    let t = linea.trim();
    if (t.startsWith("data:")) t = t.slice("data:".length).trim();
    if (t === "" || t === "[DONE]") return;
    // Elementos de un array JSON por líneas: `[{…},\n{…}\n]` — el `[` inicial y
    // los `,`/`]` que separan y cierran el array pueden viajar pegados a un
    // objeto, en cualquier orden.
    if (t.startsWith("[")) t = t.slice(1).trimStart();
    if (t === "") return;
    if (t.endsWith(",")) t = t.slice(0, -1).trimEnd();
    if (t.endsWith("]")) t = t.slice(0, -1).trimEnd();
    if (t.endsWith(",")) t = t.slice(0, -1).trimEnd();
    if (t === "") return;
    try {
      const j = JSON.parse(t) as { usageMetadata?: UsoMetadataGemini; candidates?: unknown[] };
      const uso = usoDeGemini(j.usageMetadata);
      if (uso) this.usoFinal = uso;
      if (!Array.isArray(j.candidates)) return;
      for (const c of j.candidates) {
        if (c === null || typeof c !== "object") continue;
        const cand = c as { finishReason?: unknown; content?: { parts?: unknown[] } };
        if (cand.finishReason === "SAFETY") this.negativaVista = true;
        if (this.textoVisto !== "" || !cand.content || !Array.isArray(cand.content.parts)) continue;
        for (const p of cand.content.parts) {
          if (p !== null && typeof p === "object" && typeof (p as { text?: unknown }).text === "string") {
            this.textoVisto = (p as { text: string }).text;
            break;
          }
        }
      }
    } catch {
      /* un fragmento a medias no es un error: el stream sigue */
    }
  }

  /** El último `usageMetadata` visto; el final llega en el último trozo. */
  usageFinal(): UsoSse | null {
    if (this.pendiente.trim() !== "") {
      const p = this.pendiente;
      this.pendiente = "";
      this.observarLinea(p);
    }
    return this.usoFinal;
  }

  negativa(): boolean {
    return this.negativaVista;
  }

  textoInicial(): string {
    return this.textoVisto;
  }
}
