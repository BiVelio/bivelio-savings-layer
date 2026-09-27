// UNA API DE MENSAJES FALSA QUE HACE CUMPLIR LAS REGLAS DEL BUCLE DE HERRAMIENTAS.
//
// No es el modelo: prueba el TRANSPORTE. Contesta 400 —con el mensaje que da la
// API real cuando se conoce— a todo cuerpo que rompa una regla del bucle, y si no,
// devuelve la respuesta que le dicte el guion del test (en JSON o en SSE, según
// pida el cuerpo). Guarda cada cuerpo, cada rechazo y cada `tool_use` que emitió,
// para poder comprobar que el modelo vuelve a ver sus propias llamadas.
//
// LAS REGLAS, Y DE DÓNDE SALE CADA UNA (leídas el 2026-09-27):
//
//  DOCUMENTADAS
//   · https://platform.claude.com/docs/en/api/messages/create
//       - «Consecutive `user` or `assistant` turns in your request will be
//         combined into a single turn»: las reglas se miran sobre los turnos YA
//         combinados, como los ve la API.
//       - `TextBlockParam.text`: `minLength: 1` (un texto vacío es un 400).
//       - `ToolUseBlockParam`: `id` con `^[a-zA-Z0-9_-]+$`, `name` de 1 a 200,
//         `input` un objeto; `ToolResultBlockParam.tool_use_id` con el mismo
//         patrón, `content` opcional, `is_error` opcional y booleano.
//   · https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
//       - «Tool result blocks must immediately follow their corresponding tool
//         use blocks in the message history» y el error que da si no: «tool_use
//         ids were found without tool_result blocks immediately after».
//       - «the tool_result blocks must come FIRST in the content array. Any text
//         must come AFTER all tool results».
//   · https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use
//       - «return one `tool_result` for each `tool_use` block, all together in
//         the next user message».
//
//  CONSERVADORAS (no las vi escritas; si la API real es más permisiva, la falsa
//  solo es más estricta, que es el lado seguro para probar un adaptador):
//   · un `tool_result` que no responde a un `tool_use` del turno anterior es un
//     400 (el mensaje es el que devuelve la API, recordado, no leído hoy);
//   · una petición con `tool_use`/`tool_result` tiene que definir `tools`
//     (ídem), y cada `tool_use` nombra una herramienta de `tools`;
//   · los ids de `tool_use` son únicos en la petición;
//   · un turno sin contenido es un 400; como mucho 4 `cache_control`.

type Bloque = Record<string, unknown>;
type Cuerpo = Record<string, unknown>;
interface Turno {
  role: string;
  content: Bloque[];
}

const PATRON_DE_ID = /^[a-zA-Z0-9_-]+$/;

/** Los turnos como los ve la API: los consecutivos del mismo rol, combinados. */
export function turnosCombinados(cuerpo: Cuerpo): Turno[] {
  const turnos: Turno[] = [];
  for (const m of (cuerpo["messages"] as { role: string; content: unknown }[]) ?? []) {
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Bloque[]);
    const previo = turnos[turnos.length - 1];
    if (previo && previo.role === m.role) previo.content.push(...content);
    else turnos.push({ role: m.role, content: [...content] });
  }
  return turnos;
}

/** El primer incumplimiento de las reglas del bucle, o `undefined`. */
export function reglasDelBucle(cuerpo: Cuerpo): string | undefined {
  const crudos = (cuerpo["messages"] as { role: string; content: unknown }[]) ?? [];
  if (crudos.length === 0) return "messages: at least one message is required";
  for (const [i, m] of crudos.entries()) {
    if (m.role !== "user" && m.role !== "assistant") return `messages.${i}.role: Input should be 'user' or 'assistant'`;
    if (!Array.isArray(m.content) && typeof m.content !== "string") return `messages.${i}.content: invalid`;
    if (Array.isArray(m.content) && m.content.length === 0) return `messages.${i}: content cannot be empty`;
  }
  const turnos = turnosCombinados(cuerpo);
  if (turnos[0]!.role !== "user") return "messages: first message must use the \"user\" role";

  const herramientas = new Set(((cuerpo["tools"] as Bloque[] | undefined) ?? []).map((t) => t["name"] as string));
  const idsDeLlamada: string[] = [];
  let hayBucle = false;

  for (const [t, { role, content }] of turnos.entries()) {
    for (const b of content) {
      if (b["type"] === "text" && (typeof b["text"] !== "string" || b["text"] === "")) {
        return "messages: text content blocks must be non-empty";
      }
      if (b["type"] === "tool_use") {
        hayBucle = true;
        if (role !== "assistant") return "tool_use blocks can only appear in assistant turns";
        if (typeof b["id"] !== "string" || !PATRON_DE_ID.test(b["id"])) return `tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'`;
        const nombre = b["name"];
        if (typeof nombre !== "string" || nombre.length === 0 || nombre.length > 200) return "tool_use.name: invalid";
        const input = b["input"];
        if (typeof input !== "object" || input === null || Array.isArray(input)) return "tool_use.input: Input should be a valid dictionary";
        if (!herramientas.has(nombre)) return `tool_use.name: '${nombre}' is not one of the tools of this request`;
        idsDeLlamada.push(b["id"]);
      }
      if (b["type"] === "tool_result") {
        hayBucle = true;
        if (role !== "user") return "tool_result blocks can only appear in user turns";
        const id = b["tool_use_id"];
        if (typeof id !== "string" || !PATRON_DE_ID.test(id)) return `tool_result.tool_use_id: String should match pattern '^[a-zA-Z0-9_-]+$'`;
        if ("content" in b && typeof b["content"] !== "string" && !Array.isArray(b["content"])) return "tool_result.content: invalid";
        if ("is_error" in b && typeof b["is_error"] !== "boolean") return "tool_result.is_error: Input should be a valid boolean";
      }
    }

    // El turno de usuario con resultados: primero los resultados, y cada uno
    // responde a un `tool_use` del turno de justo antes.
    const resultados = content.filter((b) => b["type"] === "tool_result");
    if (role === "user" && resultados.length > 0) {
      const primeroQueNoEs = content.findIndex((b) => b["type"] !== "tool_result");
      if (primeroQueNoEs !== -1 && primeroQueNoEs < resultados.length) {
        return "tool_result blocks must come FIRST in the content array; any text must come AFTER all tool results";
      }
      const pedidas = new Set(
        (turnos[t - 1]?.content ?? []).filter((b) => b["type"] === "tool_use").map((b) => b["id"] as string),
      );
      for (const r of resultados) {
        if (!pedidas.has(r["tool_use_id"] as string)) {
          return (
            `unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${String(r["tool_use_id"])}. Each ` +
            "`tool_result` block must have a corresponding `tool_use` block in the previous message."
          );
        }
      }
    }

    // El turno del asistente con llamadas: cada una, contestada en el siguiente.
    const llamadas = content.filter((b) => b["type"] === "tool_use");
    if (role === "assistant" && llamadas.length > 0) {
      const siguiente = turnos[t + 1];
      const contestadas = new Set(
        (siguiente?.role === "user" ? siguiente.content : [])
          .filter((b) => b["type"] === "tool_result")
          .map((b) => b["tool_use_id"] as string),
      );
      const sin = llamadas.map((b) => b["id"] as string).filter((id) => !contestadas.has(id));
      if (sin.length > 0) {
        return (
          `\`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${sin.join(", ")}. ` +
          "Each `tool_use` block must have a corresponding `tool_result` block in the next message."
        );
      }
    }
  }

  if (new Set(idsDeLlamada).size !== idsDeLlamada.length) return "tool_use ids must be unique";
  if (hayBucle && herramientas.size === 0) return "Requests which include `tool_use` or `tool_result` blocks must define tools.";

  const marcas = JSON.stringify(cuerpo).match(/"cache_control"/g)?.length ?? 0;
  if (marcas > 4) return `A maximum of 4 blocks with cache_control may be provided. Found ${marcas}.`;
  return undefined;
}

/** Lo que contesta el «modelo»: los bloques de su turno y por qué paró. */
export interface Turnada {
  content: Bloque[];
  stop_reason: string;
}

export interface ApiFalsa {
  fetchImpl: typeof fetch;
  cuerpos: Cuerpo[];
  rechazos: string[];
  /** Cada `tool_use` que emitió el «modelo», en orden. */
  emitidas: Bloque[];
}

/** El SSE de la API de Mensajes para un turno (el `input` de las llamadas, troceado). */
export function sseDe(turnada: Turnada): string {
  const ev = (tipo: string, data: Record<string, unknown>): string =>
    `event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...data })}\n\n`;
  let s = ev("message_start", {
    message: { id: "msg_falso", type: "message", role: "assistant", content: [], usage: { input_tokens: 50, output_tokens: 1 } },
  });
  turnada.content.forEach((b, index) => {
    if (b["type"] === "text") {
      s += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      s += ev("content_block_delta", { index, delta: { type: "text_delta", text: b["text"] } });
    } else if (b["type"] === "tool_use" || b["type"] === "server_tool_use") {
      const { input, ...inicio } = b;
      const json = JSON.stringify(input);
      const mitad = Math.floor(json.length / 2);
      s += ev("content_block_start", { index, content_block: { ...inicio, input: {} } });
      s += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(0, mitad) } });
      s += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(mitad) } });
    } else {
      s += ev("content_block_start", { index, content_block: b });
    }
    s += ev("content_block_stop", { index });
  });
  s += ev("message_delta", { delta: { stop_reason: turnada.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
  s += ev("message_stop", {});
  return s;
}

/** La API falsa: valida cada cuerpo y, si pasa, contesta lo que diga `guion`. */
export function apiDeMensajes(guion: (cuerpo: Cuerpo, n: number) => Turnada): ApiFalsa {
  const cuerpos: Cuerpo[] = [];
  const rechazos: string[] = [];
  const emitidas: Bloque[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const cuerpo = JSON.parse(init.body) as Cuerpo;
    cuerpos.push(cuerpo);
    const fallo = reglasDelBucle(cuerpo);
    if (fallo) {
      rechazos.push(fallo);
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: fallo } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const turnada = guion(cuerpo, cuerpos.length - 1);
    for (const b of turnada.content) if (b["type"] === "tool_use") emitidas.push(b);
    if (cuerpo["stream"] === true) {
      return new Response(sseDe(turnada), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(
      JSON.stringify({
        id: "msg_falso",
        type: "message",
        role: "assistant",
        content: turnada.content,
        stop_reason: turnada.stop_reason,
        usage: { input_tokens: Math.ceil(init.body.length / 4), output_tokens: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, cuerpos, rechazos, emitidas };
}

/** Quita los `cache_control`: el punto de ruptura se mueve con el prefijo y no es contenido. */
export function sinMarcas<T>(x: T): T {
  return JSON.parse(JSON.stringify(x), (k, v: unknown) => (k === "cache_control" ? undefined : v)) as T;
}
