import { describe, it, expect, vi } from "vitest";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import type { ProviderRequest } from "../src/providers/types.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";

/**
 * El adaptador de Anthropic, y sobre todo la caché de prefijo.
 *
 * Por qué esta fase existe: `grep -rn "cache_control" src/` daba CERO, o sea que
 * el descuento mayor de la entrada —una lectura cacheada cuesta el 10% del
 * precio normal— era FÍSICAMENTE INEXPRESABLE. Y en el banco
 * `providerCachedInputTokens` salía 0 en los siete escenarios y en LOS DOS
 * BRAZOS, así que ni siquiera se veía si nuestra compresión se lo estaba
 * quitando al cliente.
 */

/** Un `fetch` de mentira que captura el cuerpo enviado y devuelve lo que se le diga. */
function espia(respuesta: unknown, estado = 200) {
  const enviados: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    enviados.push(JSON.parse(String(init.body)));
    return {
      ok: estado >= 200 && estado < 300,
      status: estado,
      json: async () => respuesta,
      text: async () => JSON.stringify(respuesta),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { enviados, fetchImpl };
}

const USO_BASE = { input_tokens: 100, output_tokens: 20 };

function respuestaDeTexto(text: string, usage: Record<string, number> = USO_BASE) {
  return { content: [{ type: "text", text }], stop_reason: "end_turn", usage };
}

const PETICION: ProviderRequest = {
  model: "claude-sonnet-4-5",
  messages: [
    { role: "system", content: "Eres el asistente de soporte." },
    { role: "user", content: "¿Dónde está mi pedido?" },
  ],
};

describe("dialecto de la API de Mensajes", () => {
  it("el `system` viaja en su propio campo, NUNCA como mensaje", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("ok"));
    await new AnthropicProvider({ fetchImpl }).generate(PETICION);

    const body = enviados[0]!;
    // Mandarlo como mensaje con role "system" es un 400 en esta API: no existe
    // ese rol. Es LA diferencia estructural con el dialecto de OpenAI.
    expect(body["system"]).toEqual([
      { type: "text", text: "Eres el asistente de soporte." },
    ]);
    expect(body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "¿Dónde está mi pedido?" }] },
    ]);
    expect(JSON.stringify(body["messages"])).not.toContain("system");
  });

  it("`max_tokens` viaja SIEMPRE: aquí es obligatorio", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("ok"));
    // Sin `maxOutputTokens` en la petición: en el dialecto de OpenAI se omite y
    // no pasa nada; aquí omitirlo es un 400 duro.
    await new AnthropicProvider({ fetchImpl }).generate(PETICION);
    expect(enviados[0]!["max_tokens"]).toBeTypeOf("number");
  });

  it("las herramientas van sin envoltorio `function`", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("ok"));
    await new AnthropicProvider({ fetchImpl }).generate({
      ...PETICION,
      tools: [
        {
          id: "buscar_pedido",
          intents: ["pedido"],
          risk: "read",
          description: "Busca un pedido",
          parameters: { type: "object", properties: { id: { type: "string" } } },
        },
      ],
    });
    expect(enviados[0]!["tools"]).toEqual([
      {
        name: "buscar_pedido",
        description: "Busca un pedido",
        input_schema: { type: "object", properties: { id: { type: "string" } } },
      },
    ]);
  });

  it("un `seed` de otro proveedor se ignora en vez de reventar la petición", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("ok"));
    await new AnthropicProvider({ fetchImpl }).generate({ ...PETICION, seed: 7 });
    expect(enviados[0]!["seed"]).toBeUndefined();
  });
});

describe("puntos de ruptura de la caché de prefijo", () => {
  it("SIN prefijo declarado no se marca nada: Anthropic no cachea sola", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("ok"));
    await new AnthropicProvider({ fetchImpl }).generate(PETICION);
    // No es una omisión inocua: sin `cache_control` el descuento del 90% no
    // existe por muy estable que sea el prompt. Pero tampoco se marca por
    // defecto, porque escribir la caché lleva prima.
    expect(JSON.stringify(enviados[0])).not.toContain("cache_control");
  });

  it("CON prefijo declarado se marca el final de `system`", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("ok"));
    await new AnthropicProvider({ fetchImpl }).generate({
      ...PETICION,
      stablePrefixMessages: 1,
    });
    const system = enviados[0]!["system"] as { cache_control?: unknown }[];
    expect(system[system.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("marcar `system` cachea TAMBIÉN las herramientas, por el orden de renderizado", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("ok"));
    await new AnthropicProvider({ fetchImpl }).generate({
      ...PETICION,
      tools: [{ id: "t", intents: [], risk: "read" }],
      stablePrefixMessages: 1,
    });
    // tools -> system -> messages. Un solo punto al final de `system` cubre las
    // dos primeras secciones; gastar otro en `tools` sería tirar presupuesto.
    const body = enviados[0]!;
    expect(JSON.stringify(body["tools"])).not.toContain("cache_control");
    expect(JSON.stringify(body["system"])).toContain("cache_control");
  });

  it("el segundo punto cae en el HISTORIAL, no detrás de la pregunta", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("ok"));
    await new AnthropicProvider({ fetchImpl }).generate({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "system", content: "politica" },
        { role: "user", content: "turno 1" },
        { role: "assistant", content: "respuesta 1" },
        { role: "user", content: "pregunta de HOY" },
      ],
      // Prefijo = system + los dos turnos viejos. La pregunta de hoy queda fuera.
      stablePrefixMessages: 3,
    });
    const messages = enviados[0]!["messages"] as {
      content: { text: string; cache_control?: unknown }[];
    }[];
    // El punto va en "respuesta 1" (último del prefijo), NUNCA en la pregunta
    // de hoy: marcarla pagaría prima de escritura por un texto que no se
    // repetirá jamás.
    expect(messages[1]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(messages[2]!.content[0]!.cache_control).toBeUndefined();
  });

  it("el índice se corrige al sacar los `system` de la lista de mensajes", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("ok"));
    await new AnthropicProvider({ fetchImpl }).generate({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "system", content: "a" },
        { role: "system", content: "b" },
        { role: "system", content: "c" },
        { role: "user", content: "turno viejo" },
        { role: "user", content: "pregunta de HOY" },
      ],
      // 4 mensajes del layer, pero sólo UNO sobrevive como mensaje de la API:
      // los tres `system` se fueron al campo `system`. Usar el 4 directamente
      // pondría el punto detrás de la pregunta de hoy.
      stablePrefixMessages: 4,
    });
    const messages = enviados[0]!["messages"] as {
      content: { text: string; cache_control?: unknown }[];
    }[];
    expect(messages.map((m) => m.content[0]!.text)).toEqual([
      "turno viejo",
      "pregunta de HOY",
    ]);
    expect(messages[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(messages[1]!.content[0]!.cache_control).toBeUndefined();
  });

  it("nunca se gastan más de los 4 puntos que permite la API", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("ok"));
    await new AnthropicProvider({ fetchImpl }).generate({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "system", content: "a" },
        { role: "user", content: "1" },
        { role: "assistant", content: "2" },
        { role: "user", content: "3" },
        { role: "assistant", content: "4" },
        { role: "user", content: "hoy" },
      ],
      stablePrefixMessages: 5,
    });
    const puntos = (JSON.stringify(enviados[0]).match(/cache_control/g) ?? []).length;
    expect(puntos).toBeLessThanOrEqual(4);
    // Y de hecho se usan dos, dejando la mitad del presupuesto a quien envuelva
    // este adaptador. El tope de la API es duro: los de más no se ignoran, se
    // rechazan.
    expect(puntos).toBe(2);
  });

  it("un presupuesto de 0 desactiva el marcado por completo", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("ok"));
    await new AnthropicProvider({ fetchImpl, maxCacheBreakpoints: 0 }).generate({
      ...PETICION,
      stablePrefixMessages: 1,
    });
    expect(JSON.stringify(enviados[0])).not.toContain("cache_control");
  });
});

describe("contabilidad del uso: el libro 4 y la prima que NO es ahorro", () => {
  it("`cache_read_input_tokens` alimenta el libro 4", async () => {
    const { fetchImpl } = espia(
      respuestaDeTexto("ok", {
        input_tokens: 40,
        output_tokens: 10,
        cache_read_input_tokens: 900,
      }),
    );
    const r = await new AnthropicProvider({ fetchImpl }).generate(PETICION);
    // Hoy `cachedInputTokens` sólo se rellenaba desde
    // `prompt_tokens_details.cached_tokens` (OpenAI), así que con Anthropic la
    // cifra salía 0 aunque el descuento existiera de verdad.
    expect(r.usage.cachedInputTokens).toBe(900);
  });

  it("`cache_creation_input_tokens` es una PRIMA y jamás entra en el libro 4", async () => {
    const { fetchImpl } = espia(
      respuestaDeTexto("ok", {
        input_tokens: 40,
        output_tokens: 10,
        cache_creation_input_tokens: 900,
      }),
    );
    const r = await new AnthropicProvider({ fetchImpl }).generate(PETICION);
    // Escribir la caché se paga MÁS caro (1,25x). Contarlo como ahorro
    // publicaría un sobrecoste como si fuera un descuento — exactamente la
    // mentira que los cuatro libros existen para no cometer.
    expect(r.usage.cachedInputTokens).toBeUndefined();
    expect(r.usage.cacheWriteInputTokens).toBe(900);
  });

  it("`inputTokens` es el prompt ENTERO, no el resto no cacheado", async () => {
    const { fetchImpl } = espia(
      respuestaDeTexto("ok", {
        input_tokens: 40, // <- SÓLO el resto: la API de Anthropic no cuenta como la de OpenAI
        output_tokens: 10,
        cache_creation_input_tokens: 60,
        cache_read_input_tokens: 900,
      }),
    );
    const r = await new AnthropicProvider({ fetchImpl }).generate(PETICION);

    // EL FALLO QUE ESTO CIERRA, Y VALE DINERO DEL CLIENTE.
    //
    // En esta API `usage.input_tokens` NO es el prompt: es sólo la parte que no
    // salió de la caché. El total es la suma de los tres. Mapear el campo a
    // secas haría que `ledger.actualInput` se desplomase justo cuando la caché
    // empieza a acertar —1000 tokens reportados como 40—, y como el baseline se
    // reconstruye SOBRE actualInput, el ahorro publicado vendría de un contador
    // leído a medias en vez de de la capa.
    expect(r.usage.inputTokens).toBe(1000);
    expect(r.usage.inputTokens).not.toBe(40);
  });

  it("sin bloques de caché el total sigue siendo el que reporta el proveedor", async () => {
    const { fetchImpl } = espia(respuestaDeTexto("ok", { input_tokens: 123, output_tokens: 7 }));
    const r = await new AnthropicProvider({ fetchImpl }).generate(PETICION);
    expect(r.usage).toEqual({ inputTokens: 123, outputTokens: 7, reasoningTokens: 0 });
  });

  it("con `requireUsage`, un contador AUSENTE es error duro", async () => {
    const { fetchImpl } = espia({ content: [{ type: "text", text: "ok" }], usage: {} });
    await expect(
      new AnthropicProvider({ fetchImpl, requireUsage: true }).generate(PETICION),
    ).rejects.toThrow(/incomplete usage/);
  });

  it("con `requireUsage`, un CERO legítimo no es error: es medible", async () => {
    const { fetchImpl } = espia(respuestaDeTexto("", { input_tokens: 5, output_tokens: 0 }));
    const r = await new AnthropicProvider({ fetchImpl, requireUsage: true }).generate(PETICION);
    expect(r.usage.outputTokens).toBe(0);
  });
});

describe("contrato de salida y herramientas", () => {
  const ESQUEMA = {
    type: "object" as const,
    properties: { answer: { type: "string" as const } },
    required: ["answer"],
    additionalProperties: false,
  };

  it("el contrato se impone forzando una llamada a herramienta", async () => {
    const { enviados, fetchImpl } = espia({
      content: [{ type: "tool_use", id: "t1", name: "bvsala_contract", input: { answer: "hola" } }],
      stop_reason: "tool_use",
      usage: USO_BASE,
    });
    const r = await new AnthropicProvider({ fetchImpl }).generate({
      ...PETICION,
      schema: ESQUEMA,
    });
    expect(enviados[0]!["tool_choice"]).toEqual({ type: "tool", name: "bvsala_contract" });
    // La respuesta del contrato NO es una acción que el llamante deba ejecutar:
    // es la respuesta final, servida por la única vía que este proveedor tiene
    // para imponer una forma. Sale como texto, que es donde se valida.
    expect(r.text).toBe('{"answer":"hola"}');
    expect(r.toolCalls).toBeUndefined();
    expect(r.structuredNatively).toBe(true);
  });

  it("un esquema que no cumple `strict` NO se publica como garantía del proveedor, y avisa en inglés", async () => {
    reiniciarAvisos();
    const avisos: string[] = [];
    const espiaWarn = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      avisos.push(a.map(String).join(" "));
    });
    try {
      const { enviados, fetchImpl } = espia(respuestaDeTexto("{}"));
      const r = await new AnthropicProvider({ fetchImpl }).generate({
        ...PETICION,
        // `required` no lista todas las claves: en modo strict eso no vale.
        schema: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: ["a"],
          additionalProperties: false,
        },
      });
      const tools = enviados[0]!["tools"] as Record<string, unknown>[];
      expect(tools[0]!["strict"]).toBeUndefined();
      // El esquema sigue viajando —el modelo sigue guiado— pero quien impone la
      // forma es el layer al validar, y el informe lo dirá.
      expect(tools[0]!["input_schema"]).toBeDefined();
      expect(r.structuredNatively).toBe(false);
      // El aviso es lo que lee el cliente: dice la regla que incumple y quién
      // garantiza la forma mientras tanto.
      const sobreStrict = avisos.filter((a) => a.includes("`strict`"));
      expect(sobreStrict).toHaveLength(1);
      expect(sobreStrict[0]).toContain("must list ALL the keys in `properties`");
      expect(sobreStrict[0]).toContain("sent without `strict`");
    } finally {
      espiaWarn.mockRestore();
    }
  });

  it("con herramientas del llamante se fuerza `any`, NO la nuestra: conserva sus acciones y le quita la prosa", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("{}"));
    const r = await new AnthropicProvider({ fetchImpl }).generate({
      ...PETICION,
      schema: ESQUEMA,
      tools: [{ id: "buscar", intents: [], risk: "read" }],
    });
    // Forzar LA NUESTRA (`{type:"tool", name}`) dejaría al modelo sin poder
    // invocar las suyas, y el turno de herramientas es justo lo que la capa
    // promete no romper. `any` no: obliga a llamar a ALGUNA, y la elige él.
    expect(enviados[0]!["tool_choice"]).toEqual({ type: "any" });
    // Las suyas siguen ahí, y el contrato viaja como una más.
    const tools = enviados[0]!["tools"] as Record<string, unknown>[];
    expect(tools.map((t) => t["name"])).toEqual(["buscar", "bvsala_contract"]);
    // Y SIGUE SIN SER UNA GARANTÍA: el modelo puede escoger `buscar`, que es
    // precisamente lo que queremos que pueda hacer. Quien impone la forma es el
    // validador del layer, así que el informe no puede decir "provider-native".
    expect(r.structuredNatively).toBe(false);
  });

  it("la escotilla devuelve la conducta anterior: sin `tool_choice`", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("{}"));
    await new AnthropicProvider({ fetchImpl, forceAnswerThroughTool: false }).generate({
      ...PETICION,
      schema: ESQUEMA,
      tools: [{ id: "buscar", intents: [], risk: "read" }],
    });
    expect(enviados[0]!["tool_choice"]).toBeUndefined();
  });

  it("con el nombre del contrato ocupado NO se fuerza nada: no habría a qué acudir", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("{}"));
    await new AnthropicProvider({ fetchImpl }).generate({
      ...PETICION,
      schema: ESQUEMA,
      tools: [{ id: "bvsala_contract", intents: [], risk: "read" }],
    });
    // Ahí el contrato viaja como prosa (no cabe como herramienta sin colisionar),
    // así que obligar a llamar a una herramienta dejaría al modelo sin ninguna
    // forma de entregar la respuesta final: daría vueltas por las del llamante.
    expect(enviados[0]!["tool_choice"]).toBeUndefined();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // LA REGRESIÓN DEL 63%: «no forzar» no era «mandar el esquema como prosa».
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Medido en vivo contra claude-sonnet-4-5, escenario "Tool-heavy request",
  // 8 pares: brazo A 1135 entrada / 67 salida, brazo B 1449 / 189 → −63,0%.
  // El esquema en prosa no lo impone nadie, el modelo contestaba en texto
  // libre, no validaba, y el pipeline pagaba su reparación: una SEGUNDA
  // llamada entera que en esta API vuelve a pagar el prompt de sistema de uso
  // de herramientas. Reproducido con un servidor local que habla este
  // dialecto: 779 + 751 = 1530 de entrada contra los 1057 del brazo naive.
  it("con herramientas del llamante el contrato viaja como HERRAMIENTA, no como prosa", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("{}"));
    await new AnthropicProvider({ fetchImpl }).generate({
      ...PETICION,
      schema: ESQUEMA,
      tools: [{ id: "buscar", intents: [], risk: "read" }],
    });
    const body = enviados[0]!;
    const tools = body["tools"] as Record<string, unknown>[];

    // Las del llamante siguen enteras y las primeras: `tools` se renderiza al
    // principio del prompt, así que añadir al final no mueve sus bytes y la
    // caché de prefijo del llamante sigue acertando.
    expect(tools.map((t) => t["name"])).toEqual(["buscar", "bvsala_contract"]);
    expect(tools[1]!["input_schema"]).toEqual(ESQUEMA);

    // Y NO por prosa: ese bloque iba a `system`, por detrás del punto de
    // ruptura de caché, así que se pagaba entero en CADA petición.
    expect(JSON.stringify(body["system"] ?? [])).not.toContain("JSON Schema");
  });

  it("añadir el contrato como herramienta NO lo convierte en garantía del proveedor", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("{}"));
    const r = await new AnthropicProvider({ fetchImpl }).generate({
      ...PETICION,
      // Estrictamente compatible: sin herramientas del llamante SÍ se forzaría.
      schema: ESQUEMA,
      tools: [{ id: "buscar", intents: [], risk: "read" }],
    });
    // Sin `tool_choice` el modelo puede ignorarla, así que la forma NO está
    // garantizada. Publicarla como `provider-native` sería vender por garantía
    // lo que sigue siendo una sugerencia — y el pipeline decide si repara
    // mirando justo este campo.
    expect((enviados[0]!["tools"] as Record<string, unknown>[])[1]!["strict"]).toBeUndefined();
    expect(r.structuredNatively).toBe(false);
  });

  it("si el modelo toma el contrato, la respuesta sale ya parseada y sin prosa alrededor", async () => {
    const { fetchImpl } = espia({
      content: [
        { type: "tool_use", id: "t1", name: "bvsala_contract", input: { answer: "24 grados" } },
      ],
      stop_reason: "tool_use",
      usage: USO_BASE,
    });
    const r = await new AnthropicProvider({ fetchImpl }).generate({
      ...PETICION,
      schema: ESQUEMA,
      tools: [{ id: "buscar", intents: [], risk: "read" }],
    });
    // Ese es TODO el ahorro: `input` llega como objeto, así que siempre parsea
    // —ni valla markdown ni «claro, aquí tienes»— y la reparación de 751 tokens
    // de entrada más su salida (que en Sonnet cuesta 5x por token) no ocurre.
    expect(r.text).toBe('{"answer":"24 grados"}');
    // Y no se le devuelve al llamante como acción a ejecutar: no es suya.
    expect(r.toolCalls).toBeUndefined();
  });

  it("una herramienta del llamante que ya se llame `bvsala_contract` no se duplica", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("{}"));
    await new AnthropicProvider({ fetchImpl }).generate({
      ...PETICION,
      schema: ESQUEMA,
      tools: [{ id: "bvsala_contract", intents: [], risk: "read" }],
    });
    const tools = enviados[0]!["tools"] as Record<string, unknown>[];
    // Dos `tools` con el mismo nombre son un 400: una petición que hoy funciona
    // pasaría a fallar en duro por una optimización nuestra. Se cede el nombre
    // al llamante y el contrato vuelve a la prosa, que es más cara pero no rompe.
    expect(tools).toHaveLength(1);
    expect(tools[0]!["input_schema"]).toEqual({ type: "object", properties: {} });
    expect(JSON.stringify(enviados[0]!["system"])).toContain("JSON Schema");
  });

  it("las llamadas a herramienta del modelo se propagan con sus argumentos", async () => {
    const { fetchImpl } = espia({
      content: [{ type: "tool_use", id: "tu_1", name: "buscar", input: { id: "40218" } }],
      stop_reason: "tool_use",
      usage: USO_BASE,
    });
    const r = await new AnthropicProvider({ fetchImpl }).generate({
      ...PETICION,
      tools: [{ id: "buscar", intents: [], risk: "read" }],
    });
    // Aquí `input` llega YA PARSEADO (a diferencia de OpenAI, que manda cadena),
    // y el contrato del layer transporta `arguments` como cadena.
    expect(r.toolCalls).toEqual([{ id: "tu_1", name: "buscar", arguments: '{"id":"40218"}' }]);
    expect(r.finishReason).toBe("tool_calls");
  });

  it("`max_tokens` se traduce a `length`: una respuesta CORTADA, no mala", async () => {
    const { fetchImpl } = espia({
      content: [{ type: "text", text: "a medi" }],
      stop_reason: "max_tokens",
      usage: USO_BASE,
    });
    const r = await new AnthropicProvider({ fetchImpl }).generate(PETICION);
    // El pipeline distingue una respuesta mala de una cortada por este campo:
    // reintentar una cortada con el MISMO tope vuelve a cortarla y se paga dos
    // veces el mismo fallo. El nombre tiene que ser el mismo en los dos
    // adaptadores o el pipeline no lo reconoce.
    expect(r.finishReason).toBe("length");
  });
});

describe("mapeo de conversaciones", () => {
  it("un rol `tool` se traduce a turno de usuario en vez de perderse", async () => {
    const { enviados, fetchImpl } = espia(respuestaDeTexto("ok"));
    await new AnthropicProvider({ fetchImpl }).generate({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "busca el pedido" },
        { role: "assistant", content: "llamando" },
        { role: "tool", content: '{"estado":"entregado"}' },
      ],
    });
    const messages = enviados[0]!["messages"] as { role: string }[];
    // Perderlo dejaría al modelo respondiendo sin el resultado que él mismo pidió.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("una petición sin ningún turno de usuario falla en claro, no con un 400 crudo", async () => {
    const { fetchImpl } = espia(respuestaDeTexto("ok"));
    await expect(
      new AnthropicProvider({ fetchImpl }).generate({
        model: "claude-sonnet-4-5",
        messages: [{ role: "system", content: "solo politica" }],
      }),
    ).rejects.toThrow(/no user\/assistant message/);
  });
});
