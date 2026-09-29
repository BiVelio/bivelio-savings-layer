/**
 * LA RED DE MENTIRA DE `--seco` — las sondas enteras sin gastar un céntimo.
 *
 * No es un modelo: prueba el CABLEADO de las sondas (qué sale, qué se lee, cómo
 * se apunta) contra proveedores falsos que hacen cumplir las reglas que importan
 * aquí:
 *
 *  · Anthropic: las reglas del bucle de herramientas de
 *    `test/helpers/api-de-mensajes-falsa.ts` (un texto vacío o un `tool_use` sin
 *    su `tool_result` es un 400), una caché de prefijo de juguete (escribe la
 *    primera vez que ve un prefijo marcado, lo lee después), la búsqueda de
 *    herramientas (busca solo si la herramienta no está ya cargada en el
 *    historial) y el diagnóstico de caché (`system_changed` si el `system`
 *    difiere del de la respuesta cuyo id se pasa).
 *  · Gemini (endpoint compatible): 400 a `prompt_cache_key`, firma de
 *    pensamiento en cada llamada y 400 si una llamada vuelve sin ella, el
 *    pensamiento solo en `total_tokens`, y `content_filter: OTHER` para el
 *    marcador de prompt inseguro de seco.
 *  · OpenAI: `reasoning_effort` distinto de `none` con herramientas en gpt-5.6
 *    es un 400 (la regla que motivó #402).
 */
import { createHash } from "node:crypto";

import { reglasDelBucle } from "../../test/helpers/api-de-mensajes-falsa.js";

type Obj = Record<string, unknown>;

export const MARCADOR_INSEGURO_SECO = "(seco) prompt inseguro de XSTest";

function json(status: number, cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const tok = (x: unknown) => Math.max(1, Math.ceil(JSON.stringify(x ?? "").length / 4));

export function redDeMentira(): typeof fetch {
  let n = 0;
  const prefijosEscritos = new Set<string>();
  const systemDe = new Map<string, string>();

  function anthropic(cuerpo: Obj): Response {
    const regla = reglasDelBucle(cuerpo);
    if (regla) return json(400, { type: "error", error: { type: "invalid_request_error", message: regla } });
    if (typeof cuerpo["temperature"] === "number" && cuerpo["temperature"] !== 1 && String(cuerpo["model"]).startsWith("claude-sonnet-5")) {
      return json(400, { type: "error", error: { type: "invalid_request_error", message: "temperature: not supported" } });
    }
    const id = `msg_seco_${++n}`;
    const tools = ((cuerpo["tools"] as Obj[] | undefined) ?? []).filter((t) => typeof t["name"] === "string");
    const mensajes = (cuerpo["messages"] as Obj[]) ?? [];
    const sistema = JSON.stringify(cuerpo["system"] ?? "");
    systemDe.set(id, sistema);

    // Caché de juguete: el prefijo hasta la última marca.
    const texto = JSON.stringify({ tools: cuerpo["tools"], system: cuerpo["system"], messages: cuerpo["messages"] });
    const ultima = texto.lastIndexOf('"cache_control"');
    let leidos = 0;
    let escritos = 0;
    if (ultima > 0) {
      const clave = sha(texto.slice(0, ultima));
      const t = Math.ceil(ultima / 4);
      if (prefijosEscritos.has(clave)) leidos = t;
      else {
        escritos = t;
        prefijosEscritos.add(clave);
      }
    }
    const entrada = Math.max(1, tok(cuerpo) - leidos - escritos);

    let diagnostics: unknown;
    const d = cuerpo["diagnostics"] as { previous_message_id?: string | null } | undefined;
    if (d) {
      const previo = d.previous_message_id;
      diagnostics =
        previo && systemDe.has(previo) && systemDe.get(previo) !== sistema
          ? { cache_miss_reason: { type: "system_changed", cache_missed_input_tokens: 900 } }
          : null;
    }

    // ¿Qué hace el «modelo»?
    const ultimo = mensajes[mensajes.length - 1];
    const contenido = Array.isArray(ultimo?.["content"]) ? (ultimo!["content"] as Obj[]) : [];
    const resultados = mensajes.flatMap((m) => (Array.isArray(m["content"]) ? (m["content"] as Obj[]) : [])).filter((b) => b["type"] === "tool_result").length;
    const esResultado = contenido.some((b) => b["type"] === "tool_result");
    const usuarios = mensajes.filter((m) => m["role"] === "user" && !(Array.isArray(m["content"]) && (m["content"] as Obj[]).some((b) => b["type"] === "tool_result"))).length;
    const busqueda = tools.find((t) => String(t["type"] ?? "").startsWith("tool_search_tool"));
    const bloques: Obj[] = [];
    let parada = "end_turn";
    const pasosQueQuiere = busqueda ? usuarios : 3;
    if (tools.length > 0 && (esResultado ? resultados < pasosQueQuiere : true) && !(busqueda && esResultado)) {
      const reales = tools.filter((t) => !String(t["type"] ?? "").startsWith("tool_search_tool"));
      // Con búsqueda, la herramienta cuyo dominio nombra la última pregunta del usuario.
      const textoDe = (m: Obj): string =>
        typeof m["content"] === "string"
          ? (m["content"] as string)
          : ((m["content"] as Obj[]) ?? []).filter((b) => b["type"] === "text").map((b) => String(b["text"])).join(" ");
      const preguntas = mensajes.filter((m) => m["role"] === "user" && textoDe(m) !== "");
      const ultimaPregunta = textoDe(preguntas[preguntas.length - 1] ?? {}).toLowerCase();
      const porDominio = reales.find((t) => {
        const [verbo, dominio] = String(t["name"]).split("_");
        return (verbo === "consultar" || verbo === "listar") && !!dominio && ultimaPregunta.includes(verbo === "listar" ? `lista las ${dominio}` : dominio.replace(/s$/, ""));
      });
      const objetivo = (busqueda ? porDominio : undefined) ?? reales[(usuarios - 1 + (busqueda ? 0 : resultados)) % reales.length] ?? reales[0]!;
      const nombre = String(objetivo["name"]);
      if (busqueda && objetivo["defer_loading"] === true) {
        const ya = JSON.stringify(cuerpo["messages"]).includes(`"tool_name":"${nombre}"`);
        if (!ya) {
          const sid = `srvtoolu_seco_${n}`;
          bloques.push({ type: "server_tool_use", id: sid, name: busqueda["name"], input: { query: nombre } });
          bloques.push({
            type: "tool_search_tool_result",
            tool_use_id: sid,
            content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: nombre }] },
          });
        }
      }
      bloques.push({ type: "tool_use", id: `toolu_seco_${n}`, name: nombre, input: { id: "4417" } });
      parada = "tool_use";
    } else {
      bloques.push({ type: "text", text: "Respuesta de seco." });
    }
    return json(200, {
      id,
      type: "message",
      role: "assistant",
      model: cuerpo["model"],
      content: bloques,
      stop_reason: parada,
      usage: { input_tokens: entrada, cache_read_input_tokens: leidos, cache_creation_input_tokens: escritos, output_tokens: 20 },
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    });
  }

  function compatible(cuerpo: Obj, gemini: boolean): Response {
    if (gemini && "prompt_cache_key" in cuerpo) {
      return json(400, [{ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "prompt_cache_key": Cannot find field.', status: "INVALID_ARGUMENT" } }]);
    }
    const modelo = String(cuerpo["model"]);
    const tools = (cuerpo["tools"] as unknown[] | undefined) ?? [];
    if (!gemini && modelo.startsWith("gpt-5.6") && tools.length > 0 && cuerpo["reasoning_effort"] !== "none") {
      return json(400, { error: { message: "Function tools with reasoning_effort are not supported for gpt-5.6-sol; use reasoning_effort 'none'.", type: "invalid_request_error" } });
    }
    const mensajes = (cuerpo["messages"] as Obj[]) ?? [];
    if (gemini) {
      for (const m of mensajes) {
        for (const c of (m["tool_calls"] as Obj[] | undefined) ?? []) {
          if (!c["extra_content"]) return json(400, [{ error: { code: 400, message: "Function call is missing a thought_signature in functionCall parts.", status: "INVALID_ARGUMENT" } }]);
        }
      }
    }
    const ultimo = mensajes[mensajes.length - 1];
    const prompt = tok(cuerpo);
    const pensamiento = gemini ? 37 : 0;
    const uso = { prompt_tokens: prompt, completion_tokens: 15, total_tokens: prompt + 15 + pensamiento };
    const id = `chatcmpl-seco-${++n}`;
    if (typeof ultimo?.["content"] === "string" && (ultimo["content"] as string).includes(MARCADOR_INSEGURO_SECO)) {
      return json(200, { id, choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: gemini ? "content_filter: OTHER" : "content_filter" }], usage: uso });
    }
    if (tools.length > 0 && ultimo?.["role"] === "user") {
      const t = tools[0] as { function?: { name?: string } };
      return json(200, {
        id,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_seco_${n}`,
                  type: "function",
                  function: { name: t.function?.name ?? "f", arguments: '{"ciudad":"Madrid"}' },
                  ...(gemini ? { extra_content: { google: { thought_signature: `firma-${n}` } } } : {}),
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: uso,
      });
    }
    return json(200, { id, choices: [{ index: 0, message: { role: "assistant", content: "Respuesta de seco." }, finish_reason: "stop" }], usage: uso });
  }

  return (async (entrada: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const cuerpo = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Obj;
    const host = new URL(url).host;
    if (host === "api.anthropic.com") return anthropic(cuerpo);
    if (host === "generativelanguage.googleapis.com") return compatible(cuerpo, true);
    return compatible(cuerpo, false);
  }) as typeof fetch;
}
