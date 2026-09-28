/**
 * EL PROVEEDOR DE MENTIRA DEL `--mock`: valida el arnés entero sin red.
 * ---------------------------------------------------------------------------
 * Contesta en el dialecto de cada proveedor (Mensajes / Chat Completions) con
 * un `usage` sintético, así que los DOS brazos recorren su camino real: el A
 * su `fetch` directo, el B la capa entera con su adaptador. Si la pregunta está
 * en el mapa de respuestas, llama a las herramientas con el PRIMER valor
 * admitido de `possible_answer` (una tirada --mock sana da ~100 % en los dos
 * brazos: cualquier fallo es del arnés o del comprobador, nunca de un modelo).
 * Tras un resultado de herramienta, contesta con texto. Nunca es una medición.
 */
type Obj = Record<string, unknown>;

export type RespuestaSimulada = { nombre: string; args: Record<string, unknown> }[];

function primerValor(posibles: unknown[]): { hay: boolean; v?: unknown } {
  for (const p of posibles) if (p !== "") return { hay: true, v: p };
  return { hay: false };
}

/**
 * Un valor admitido concreto. En BFCL, un parámetro dict admite diccionarios
 * cuyos valores son A SU VEZ listas de admitidos ({"min": [300000]}); se
 * concretan recursivamente (y las claves que solo admiten "" se omiten).
 */
function concretar(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(concretar);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (Array.isArray(x)) {
        const r = primerValor(x);
        if (r.hay) out[k] = concretar(r.v);
      } else out[k] = concretar(x);
    }
    return out;
  }
  return v;
}

/** Del `ground_truth` de BFCL a llamadas concretas. */
export function respuestaDeReferencia(gt: Record<string, Record<string, unknown[]>>[]): RespuestaSimulada {
  return gt.map((c) => {
    const nombre = Object.keys(c)[0]!;
    const args: Record<string, unknown> = {};
    for (const [p, posibles] of Object.entries(c[nombre]!)) {
      const r = primerValor(posibles);
      if (r.hay) args[p] = concretar(r.v);
    }
    return { nombre: nombre.replace(/\./g, "_"), args };
  });
}

/** La clave del mapa: la pregunta y el catálogo (hay preguntas repetidas entre categorías con otras funciones). */
export function claveSimulada(pregunta: string, herramientas: string[]): string {
  return `${pregunta}|${[...herramientas].sort().join(",")}`;
}

function textoDelUltimoUsuario(mensajes: Obj[]): { texto: string; esResultado: boolean } {
  const ultimo = mensajes[mensajes.length - 1];
  if (!ultimo) return { texto: "", esResultado: false };
  if (ultimo["role"] === "tool") return { texto: "", esResultado: true };
  const c = ultimo["content"];
  if (Array.isArray(c)) {
    if (c.some((b) => (b as Obj)["type"] === "tool_result")) return { texto: "", esResultado: true };
    return { texto: c.map((b) => String((b as Obj)["text"] ?? "")).join(""), esResultado: false };
  }
  return { texto: String(c ?? ""), esResultado: false };
}

export function fetchSimulado(respuestas: Map<string, RespuestaSimulada>): typeof fetch {
  let n = 0;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const cuerpo = JSON.parse(String(init?.body ?? "{}")) as Obj;
    const mensajes = (cuerpo["messages"] as Obj[]) ?? [];
    const { texto, esResultado } = textoDelUltimoUsuario(mensajes);
    const herramientas = (cuerpo["tools"] as Obj[] | undefined) ?? [];
    const nombreDe = (t: Obj) => String(t["name"] ?? (t["function"] as Obj | undefined)?.["name"]);
    let llamadas: RespuestaSimulada = [];
    if (!esResultado) {
      llamadas = respuestas.get(claveSimulada(texto, herramientas.map(nombreDe))) ?? (herramientas[0] ? [{ nombre: nombreDe(herramientas[0]), args: {} }] : []);
      // Una herramienta que la petición no lleva no se puede llamar (como en la API de verdad).
      llamadas = llamadas.filter((l) => herramientas.some((t) => nombreDe(t) === l.nombre));
    }
    const entrada = Math.ceil(String(init?.body ?? "").length / 4);
    n++;
    if (url.endsWith("/messages")) {
      const contenido = llamadas.length
        ? llamadas.map((l, i) => ({ type: "tool_use", id: `toolu_sim_${n}_${i}`, name: l.nombre, input: l.args }))
        : [{ type: "text", text: "Done." }];
      return new Response(
        JSON.stringify({
          id: `msg_sim_${n}`,
          type: "message",
          role: "assistant",
          model: cuerpo["model"],
          content: contenido,
          stop_reason: llamadas.length ? "tool_use" : "end_turn",
          usage: { input_tokens: entrada, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const mensaje = llamadas.length
      ? {
          role: "assistant",
          content: null,
          tool_calls: llamadas.map((l, i) => ({ id: `call_sim_${n}_${i}`, type: "function", function: { name: l.nombre, arguments: JSON.stringify(l.args) } })),
        }
      : { role: "assistant", content: "Done." };
    return new Response(
      JSON.stringify({
        id: `chatcmpl_sim_${n}`,
        object: "chat.completion",
        model: cuerpo["model"],
        choices: [{ index: 0, message: mensaje, finish_reason: llamadas.length ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: entrada, completion_tokens: 20, total_tokens: entrada + 20, prompt_tokens_details: { cached_tokens: 0 } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}
