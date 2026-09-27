import type { ChatMessage, ProviderResponse, ProviderUsage, SavingsResult, ToolCallRequest } from "@bivelio/savings-layer";

// EL FORMATO DE LA ESPECIFICACIÓN DE MODELOS DEL AI SDK (V2, V3 y V4), que
// comparten el adaptador del AI SDK y el de Mastra (Mastra habla V2 en el
// prompt y V4 en el uso).
//
// Todo aquí es LECTURA: renderizar el prompt para la capa, proyectar lo que la
// capa no modela para la huella, leer el contador del proveedor y decidir si una
// respuesta se puede reproducir. Nada de esto modifica lo que el framework manda
// al modelo.

type Registro = Record<string, unknown>;

function esRegistro(v: unknown): v is Registro {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function partesDe(contenido: unknown): Registro[] {
  if (typeof contenido === "string") return [{ type: "text", text: contenido }];
  return Array.isArray(contenido) ? contenido.filter(esRegistro) : [];
}

function textoDePartes(partes: Registro[]): string {
  return partes
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

/** Los argumentos de una llamada a herramienta, como cadena JSON. */
export function argumentos(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

/** El resultado de una herramienta, como texto para la capa (el crudo va en la huella). */
export function salidaComoTexto(salida: unknown): string {
  if (!esRegistro(salida)) return argumentos(salida);
  switch (salida.type) {
    case "text":
    case "error-text":
      return typeof salida.value === "string" ? salida.value : argumentos(salida.value);
    case "json":
    case "error-json":
      return argumentos(salida.value);
    case "execution-denied":
      return `execution denied${typeof salida.reason === "string" ? `: ${salida.reason}` : ""}`;
    case "content":
      return textoDePartes(partes(salida.value));
    default:
      return argumentos(salida);
  }
  function partes(v: unknown): Registro[] {
    return Array.isArray(v) ? v.filter(esRegistro) : [];
  }
}

/**
 * El prompt del AI SDK como `ChatMessage[]`: el texto de cada turno, las
 * llamadas a herramienta del cliente en `toolCalls` y cada resultado como un
 * turno `tool`. Razonamiento, ficheros y el resto de partes se quedan fuera del
 * texto y DENTRO de la huella.
 */
export function renderizarPrompt(prompt: unknown): ChatMessage[] {
  const salida: ChatMessage[] = [];
  for (const m of Array.isArray(prompt) ? prompt : []) {
    if (!esRegistro(m)) continue;
    const partes = partesDe(m.content);
    switch (m.role) {
      case "system":
        salida.push({ role: "system", content: typeof m.content === "string" ? m.content : textoDePartes(partes) });
        break;
      case "user":
        salida.push({ role: "user", content: textoDePartes(partes) });
        break;
      case "assistant": {
        const toolCalls: ToolCallRequest[] = partes
          .filter((p) => p.type === "tool-call" && p.providerExecuted !== true)
          .map((p) => ({
            ...(typeof p.toolCallId === "string" ? { id: p.toolCallId } : {}),
            name: String(p.toolName ?? ""),
            arguments: argumentos(p.input ?? p.args),
          }));
        salida.push({
          role: "assistant",
          content: textoDePartes(partes),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
        break;
      }
      case "tool":
        for (const p of partes) {
          if (p.type !== "tool-result") continue;
          salida.push({
            role: "tool",
            content: salidaComoTexto(p.output ?? p.result),
            ...(typeof p.toolCallId === "string" ? { toolCallId: p.toolCallId } : {}),
            ...(typeof p.toolName === "string" ? { name: p.toolName } : {}),
          });
        }
        break;
    }
  }
  return salida;
}

// Las claves de `providerOptions` que no son del proveedor: las del adaptador y
// las de Mastra (que sella `createdAt` en cada parte y cambiaría la huella en
// cada ejecución).
const OPCIONES_AJENAS = new Set(["bivelio", "mastra"]);

export function sinOpcionesAjenas(opciones: unknown): unknown {
  if (!esRegistro(opciones)) return opciones;
  const salida: Registro = {};
  for (const [k, v] of Object.entries(opciones)) if (!OPCIONES_AJENAS.has(k)) salida[k] = v;
  return salida;
}

// Una parte, para la huella: sin el texto (ya lo cubre la clave del núcleo), sin
// ids de llamadas a herramienta y sin las opciones ajenas. Todo lo demás, crudo.
function proyectarParte(p: Registro): Registro {
  const salida: Registro = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "toolCallId" || k === "id") continue;
    if (k === "text" && p.type === "text") continue;
    if (k === "providerOptions" || k === "providerMetadata") {
      salida[k] = sinOpcionesAjenas(v);
      continue;
    }
    salida[k] = v;
  }
  return salida;
}

/** El prompt, proyectado para la huella (D5). */
export function proyectarPrompt(prompt: unknown): unknown {
  return (Array.isArray(prompt) ? prompt : []).map((m) => {
    if (!esRegistro(m)) return m;
    return {
      role: m.role,
      // El system se hashea entero en la clave del núcleo; aquí basta su forma.
      content: typeof m.content === "string" ? "$text" : partesDe(m.content).map(proyectarParte),
      providerOptions: sinOpcionesAjenas(m.providerOptions),
    };
  });
}

// Solo las dos cabeceras que cambian lo que el modelo contesta. El resto
// (trazas, ids de petición, credenciales) no entra nunca en la huella.
const CABECERAS_DE_IDENTIDAD = new Set(["anthropic-beta", "openai-beta"]);

export function cabecerasDeIdentidad(cabeceras: unknown): Registro | undefined {
  if (!esRegistro(cabeceras)) return undefined;
  const salida: Registro = {};
  for (const [k, v] of Object.entries(cabeceras)) {
    if (CABECERAS_DE_IDENTIDAD.has(k.toLowerCase()) && v !== undefined) salida[k.toLowerCase()] = v;
  }
  return Object.keys(salida).length > 0 ? salida : undefined;
}

/**
 * Los parámetros de una llamada del AI SDK, proyectados para la huella: todo lo
 * que la clave del núcleo no cubre, y nada de lo que cambia en cada ejecución.
 */
export function proyectarParametros(params: Registro): unknown {
  const salida: Registro = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === "prompt" || k === "abortSignal" || k === "headers" || k === "providerOptions") continue;
    salida[k] = v;
  }
  salida.prompt = proyectarPrompt(params.prompt);
  salida.headers = cabecerasDeIdentidad(params.headers);
  salida.providerOptions = sinOpcionesAjenas(params.providerOptions);
  return salida;
}

/** R7: formato JSON o herramienta forzada → sin resolvers. */
export function pideFormaEstricta(params: Registro): boolean {
  const formato = params.responseFormat;
  if (esRegistro(formato) && formato.type === "json") return true;
  const eleccion = params.toolChoice;
  if (esRegistro(eleccion) && (eleccion.type === "required" || eleccion.type === "tool")) return true;
  return eleccion === "required";
}

// ─── Lo que devolvió el modelo ──────────────────────────────────────────────

function numero(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * El contador del proveedor, tal como lo entrega el AI SDK (V3/V4, anidado).
 *
 * `inputTokens.total` ya incluye lo leído y lo escrito en la caché de prefijo
 * (la especificación lo define así), así que es el prompt entero, como espera la
 * capa. Uso ausente o incompleto → `complete:false`. El formato plano de V2
 * también sale `complete:false`: su `inputTokens` no significa lo mismo en todos
 * los proveedores, y un contador que no se sabe leer no es la factura.
 *
 * `simulado`: un modelo de prueba. Su contador no es de ningún proveedor.
 */
export function usoDeAiSdk(uso: unknown, simulado: boolean): ProviderUsage {
  const u = esRegistro(uso) ? uso : {};
  const entrada = esRegistro(u.inputTokens) ? u.inputTokens : undefined;
  const salida = esRegistro(u.outputTokens) ? u.outputTokens : undefined;
  if (!entrada || !salida) {
    const i = numero(u.inputTokens);
    const o = numero(u.outputTokens);
    return { inputTokens: i ?? 0, outputTokens: o ?? 0, complete: false };
  }
  const total = numero(entrada.total);
  const leida = numero(entrada.cacheRead);
  const escrita = numero(entrada.cacheWrite);
  const salidaTotal = numero(salida.total);
  const razonamiento = numero(salida.reasoning);
  const completo = total !== undefined && salidaTotal !== undefined && !simulado;
  return {
    inputTokens: total ?? 0,
    outputTokens: salidaTotal ?? 0,
    ...(leida !== undefined ? { cachedInputTokens: leida } : {}),
    ...(escrita !== undefined ? { cacheWriteInputTokens: escrita } : {}),
    ...(razonamiento !== undefined ? { reasoningTokens: razonamiento } : {}),
    ...(completo ? {} : { complete: false }),
  };
}

/** `finishReason` de V2 (cadena) o de V3/V4 (`{ unified, raw }`), unificado. */
export function paradaUnificada(motivo: unknown): string | undefined {
  if (typeof motivo === "string") return motivo;
  if (esRegistro(motivo) && typeof motivo.unified === "string") return motivo.unified;
  return undefined;
}

/** Del vocabulario del AI SDK al neutro de la capa. */
export function paradaNeutra(unificada: string | undefined): string | undefined {
  switch (unificada) {
    case undefined:
      return undefined;
    case "tool-calls":
      return "tool_calls";
    case "content-filter":
      return "content_filter";
    default:
      return unificada;
  }
}

function tieneMetadatos(v: unknown): boolean {
  return esRegistro(v) && Object.keys(sinOpcionesAjenas(v) as Registro).length > 0;
}

/**
 * Acumula una respuesta del AI SDK, parte a parte (stream) o entera (generate),
 * y decide si se puede reproducir (R6): solo texto y llamadas a herramienta del
 * cliente, parada `stop`, y ningún razonamiento con metadatos del proveedor
 * (firma, cifrado), fichero, fuente, herramienta del proveedor, aprobación ni
 * parte propia. Todo lo demás: `replayable:false`.
 */
export class RespuestaAiSdk {
  texto = "";
  readonly toolCalls: ToolCallRequest[] = [];
  reproducible = true;
  finish: Registro | undefined;
  error: { error: unknown } | undefined;

  /** Una parte de stream o un elemento de `content`. Devuelve el delta de texto, si lo hay. */
  anadir(p: Registro): string | undefined {
    switch (p.type) {
      case "text-delta": {
        const d = typeof p.delta === "string" ? p.delta : typeof p.textDelta === "string" ? p.textDelta : "";
        this.texto += d;
        return d === "" ? undefined : d;
      }
      case "text": {
        const t = typeof p.text === "string" ? p.text : "";
        this.texto += t;
        return t === "" ? undefined : t;
      }
      case "tool-call":
        if (p.providerExecuted === true) {
          this.reproducible = false;
        } else {
          this.toolCalls.push({
            ...(typeof p.toolCallId === "string" ? { id: p.toolCallId } : {}),
            name: String(p.toolName ?? ""),
            arguments: argumentos(p.input ?? p.args),
          });
        }
        return undefined;
      case "reasoning":
      case "reasoning-start":
      case "reasoning-delta":
      case "reasoning-end":
        if (tieneMetadatos(p.providerMetadata)) this.reproducible = false;
        return undefined;
      case "text-start":
      case "text-end":
      case "tool-input-start":
      case "tool-input-delta":
      case "tool-input-end":
      case "stream-start":
      case "response-metadata":
      case "raw":
        return undefined;
      case "finish":
        this.finish = p;
        return undefined;
      case "error":
        this.error = { error: p.error };
        return undefined;
      default:
        // file, source, tool-result, tool-approval-request, reasoning-file,
        // custom… y cualquier parte que aparezca mañana.
        this.reproducible = false;
        return undefined;
    }
  }

  /** La respuesta para la capa, con el contador de `uso` y el motivo de parada. */
  respuesta(uso: unknown, motivo: unknown, simulado: boolean): ProviderResponse {
    const unificada = paradaUnificada(motivo);
    const neutra = paradaNeutra(unificada);
    const reproducible = this.reproducible && unificada === "stop";
    return {
      text: this.texto,
      ...(this.toolCalls.length > 0 ? { toolCalls: this.toolCalls } : {}),
      ...(neutra ? { finishReason: neutra } : {}),
      usage: usoDeAiSdk(uso, simulado),
      ...(reproducible ? {} : { replayable: false }),
    };
  }
}

/** Una respuesta entera (`doGenerate`) del AI SDK, para la capa. */
export function respuestaDeGenerate(r: Registro, simulado: boolean): ProviderResponse {
  const acc = new RespuestaAiSdk();
  for (const p of Array.isArray(r.content) ? r.content : []) if (esRegistro(p)) acc.anadir(p);
  return acc.respuesta(r.usage, r.finishReason, simulado);
}

// ─── Lo que la capa contestó sin llamar ─────────────────────────────────────
//
// Uso CERO: el proveedor no facturó nada. El informe dice cuánto se evitó.

export const USO_CERO = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

export function contenidoDeAtajo(result: SavingsResult): Registro[] {
  const contenido: Registro[] = [];
  if (result.text !== "") contenido.push({ type: "text", text: result.text });
  (result.toolCalls ?? []).forEach((tc, i) => {
    contenido.push({
      type: "tool-call",
      toolCallId: tc.id ?? `bvsala-${result.requestId}-${i}`,
      toolName: tc.name,
      input: tc.arguments,
    });
  });
  return contenido;
}

export function motivoDeAtajo(result: SavingsResult): { unified: string; raw: undefined } {
  return { unified: (result.toolCalls?.length ?? 0) > 0 ? "tool-calls" : "stop", raw: undefined };
}

/**
 * Las partes de stream que corresponden a un contenido entero, en el orden en
 * que las emitiría un proveedor: sirve para el atajo y para el camino de último
 * recurso del núcleo, que llama al modelo entero y no en stream.
 */
export function partesDeContenido(
  contenido: readonly unknown[],
  cierre: { usage: unknown; finishReason: unknown; providerMetadata?: unknown },
  cabecera: { warnings?: unknown; response?: Registro | undefined },
): Registro[] {
  const partes: Registro[] = [{ type: "stream-start", warnings: Array.isArray(cabecera.warnings) ? cabecera.warnings : [] }];
  if (cabecera.response) partes.push({ type: "response-metadata", ...cabecera.response });
  contenido.forEach((c, i) => {
    if (!esRegistro(c)) return;
    const id = `bvsala-${i}`;
    if (c.type === "text") {
      const meta = c.providerMetadata !== undefined ? { providerMetadata: c.providerMetadata } : {};
      partes.push({ type: "text-start", id, ...meta });
      if (typeof c.text === "string" && c.text !== "") partes.push({ type: "text-delta", id, delta: c.text });
      partes.push({ type: "text-end", id, ...meta });
    } else if (c.type === "reasoning") {
      const meta = c.providerMetadata !== undefined ? { providerMetadata: c.providerMetadata } : {};
      partes.push({ type: "reasoning-start", id, ...meta });
      if (typeof c.text === "string" && c.text !== "") partes.push({ type: "reasoning-delta", id, delta: c.text });
      partes.push({ type: "reasoning-end", id, ...meta });
    } else {
      // tool-call, tool-result, file, source… tienen la misma forma en `content`
      // que como parte de stream.
      partes.push(c);
    }
  });
  partes.push({
    type: "finish",
    usage: cierre.usage,
    finishReason: cierre.finishReason,
    ...(cierre.providerMetadata !== undefined ? { providerMetadata: cierre.providerMetadata } : {}),
  });
  return partes;
}

export function streamDe<T>(partes: readonly T[]): ReadableStream<T> {
  let i = 0;
  return new ReadableStream<T>({
    pull(controller) {
      if (i < partes.length) controller.enqueue(partes[i++] as T);
      else controller.close();
    },
  });
}

/** `openai.responses` → `openai/gpt-4o`; un id que ya trae `/` se respeta. */
export function modeloPorDefecto(model: { provider?: unknown; modelId?: unknown }): string {
  const id = String(model.modelId ?? "");
  if (id.includes("/")) return id;
  const proveedor = String(model.provider ?? "").split(".")[0] ?? "";
  return proveedor !== "" ? `${proveedor}/${id}` : id;
}

/** D8: un modelo de prueba del AI SDK (`MockLanguageModel…`, proveedor `mock-…`). */
export function esModeloSimulado(model: { provider?: unknown }): boolean {
  return typeof model.provider === "string" && model.provider.toLowerCase().startsWith("mock");
}

/** Mezcla el informe en `providerMetadata.bivelio.savingsReport`. */
export function conInforme(metadatos: unknown, informe: unknown): Registro {
  return { ...(esRegistro(metadatos) ? metadatos : {}), bivelio: { savingsReport: informe } };
}
