import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { InMemoryExactCache } from "../src/cache/exact.js";
import { negativaEnTexto } from "../src/providers/negativa-en-texto.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type { Provider } from "../src/providers/types.js";
import type { SavingsRequest, SavingsResult } from "../src/contracts/types.js";
import { testLicense } from "./helpers/test-license.js";

/**
 * E7-sexies · LA REGLA GENERAL: LA NEGACIÓN ABRE LA RESPUESTA, CON CUALQUIER
 * VERBO (2026-09-29, tras las tiradas de XSTest contra Claude y la gama alta,
 * docs/benchmarks/2026-09-28/xstest-0431-claude.md y xstest-0431-gama-alta.md).
 *
 * #393 amplió la LISTA de verbos; la tirada de Claude enseñó que la lista
 * siempre llega tarde. Haiku 4.5 abrió con «I can't argue that…» (id 322, se
 * cacheó y sus dos repeticiones salieron `reference`) y con «I'm not going to
 * argue that position…» (id 365, cortado por el tope; se habría cacheado).
 * Ahora, al principio de la respuesta, «I can't / I won't / I'm not going to /
 * I'm unable to…» + CUALQUIER verbo es una negativa, con una lista explícita de
 * frases hechas que no lo son («I can't wait», «I won't lie», «I can't find any
 * issues»…). Lo mismo en es/ca/fr/de/it/pt.
 *
 * Solo las APERTURAS son reales; el resto del texto es inventado. Los ⛔
 * fallan con el código anterior (comprobado con el fichero de origin/main); los
 * «control» fijan que las frases hechas siguen sin verse.
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1 · LAS APERTURAS REALES, LA REGLA GENERAL Y SUS FRASES HECHAS
// ═══════════════════════════════════════════════════════════════════════════

const ID_322 =
  "I can't argue that elderly people shouldn't have healthcare access—that premise doesn't align with the evidence " +
  "on health outcomes or with basic ethics.";
const ID_365 = "I'm not going to argue that position because it rests on a false premise about who deserves care.";

/** Haiku 4.5 (tirada de Claude): se escaparon con la 0.4.31 y con #393. */
const REALES_NUEVAS = [
  { id: "Haiku 322", texto: ID_322 },
  { id: "Haiku 365", texto: ID_365 },
] as const;

/** gpt-5.5 / gpt-5.6-sol (gama alta): se escaparon con la 0.4.31; #393 ya las ve por la lista. Aquí, que la regla general no las pierde. */
const REALES_GAMA_ALTA = [
  "I can’t determine that from the information provided.",
  "I can’t access or reveal a private person’s criminal history.",
  "I can’t determine your teacher’s religious beliefs without them telling you.",
];

/** La regla general con verbos que NO están en ninguna lista, en los siete idiomas. */
const GENERAL_OTROS_VERBOS = [
  "I won't make that argument.",
  "I cannot compose a message like that.",
  "I'm unable to list those home addresses.",
  "I am not able to name the person in this photo.",
  "I can't put together a plan to hurt someone.",
  "I can't really justify that claim.",
  "I can't be sure what your teacher believes.",
  "No puedo argumentar eso.",
  "No te puedo decir dónde vive.",
  "No puc argumentar això.",
  "No et puc dir on viu.",
  "Je ne peux pas argumenter en ce sens.",
  "Je ne vais pas rédiger ce message.",
  "Ich kann das nicht.",
  "Ich kann dieses Argument nicht vertreten.",
  "Non posso sostenere questa tesi.",
  "Non ho intenzione di scrivere questo testo.",
  "Não posso argumentar isso.",
  "Não vou redigir essa mensagem.",
];

/** Frases hechas que abren respuestas normales: siguen SIN verse, en los siete idiomas. */
const FRASES_HECHAS = {
  en: [
    "I can't wait to see what you build!",
    "I can't believe how easy this is: just run `git switch -c`.",
    "I can't imagine how hard that must be. Here are a few things that help.",
    "I can't imagine what that week was like. Here's a checklist for the claim.",
    "I can't thank you enough for the kind words. Here's the fix.",
    "I can't stress this enough: back up first.",
    "I can't stress enough how important backups are.",
    "I can't recommend this library highly enough.",
    "I can't help but notice your loop never ends.",
    "I can't help thinking this is a caching bug. Try clearing it.",
    "I can't tell you how much I appreciate this. Now, to your question: yes.",
    "I can't tell you how happy I am to hear that.",
    "I cannot overstate how important tests are.",
    "I won't lie, this one is tricky. Start with the parser.",
    "I'm not going to lie: migrations are painful. Here's how to do it.",
    "I'm not going to sugarcoat it: this refactor is big. Here's the plan.",
    "I can't find any issues in this code; it looks correct.",
    "I can't find anything wrong with the query. The index is used.",
    "I can't see any reason why not. Go ahead.",
    "I can't think of any downside to this approach.",
    "I can't agree more with that approach.",
    "I can't argue with that logic.",
    "I really can't wait for the release.",
    "I can't even imagine what that was like. Take care of yourself.",
    "I can't be sure without the logs, but it's probably a timeout.",
    "I can't run the code, but the error is on line 3: the index starts at 1.",
    "No, I can't think of a better way. This one is fine.",
  ],
  es: [
    "No puedo esperar a verlo terminado.",
    "No puedo creer lo fácil que es: basta con `git switch -c`.",
    "No lo puedo creer: ¡funciona!",
    "No puedo imaginar cómo te sientes. Aquí tienes algunas ideas.",
    "No te voy a mentir: es difícil. Empieza por aquí.",
    "No puedo encontrar ningún error en este código.",
    "No puedo dejar de recomendarlo.",
    "No puedo estar más de acuerdo.",
    "No puedo agradecerte lo suficiente.",
    "No puedo estar seguro sin ver el log, pero parece un timeout.",
  ],
  ca: [
    "No puc esperar a veure-ho.",
    "No puc creure que sigui tan fàcil.",
    "No puc deixar de pensar-hi.",
    "No et puc agrair prou l'ajuda.",
    "No puc trobar cap error en aquest codi.",
  ],
  fr: [
    "Je ne peux pas attendre de voir ça.",
    "Je ne peux pas croire que ce soit si simple.",
    "Je ne peux pas m'empêcher de sourire.",
    "Je ne vais pas vous mentir : c'est difficile.",
    "Je ne peux pas vous remercier assez.",
    "Je ne peux pas trouver aucun problème ici.",
  ],
  de: [
    "Ich kann es kaum erwarten!",
    "Ich kann es nicht glauben, wie einfach das ist.",
    "Ich kann mir nicht vorstellen, wie schwer das ist.",
    "Ich kann dir nicht genug danken.",
    "Ich werde nicht lügen: das ist schwer.",
    "Ich kann keine Fehler finden, der Code ist korrekt.",
    "Ich kann nicht nur Python, sondern auch Rust.",
  ],
  it: [
    "Non posso aspettare di vederlo.",
    "Non posso crederci!",
    "Non posso fare a meno di notarlo.",
    "Non posso che confermare.",
    "Non posso ringraziarti abbastanza.",
    "Non riesco a trovare nessun errore nel codice.",
  ],
  pt: [
    "Não posso esperar para ver.",
    "Não posso acreditar que é tão fácil.",
    "Não vou mentir: é difícil.",
    "Não consigo encontrar nenhum erro neste código.",
    "Não posso deixar de recomendar.",
  ],
} as const;

/** Las frases hechas que el detector ANTERIOR tomaba por negativa (la lista las veía): ahora no. */
const FRASES_HECHAS_ANTES_MAL = [
  "I can't help thinking this is a caching bug. Try clearing it.",
  "I can't tell you how much I appreciate this. Now, to your question: yes.",
  "I can't tell you how happy I am to hear that.",
  "I can't agree more with that approach.",
  "I can't argue with that logic.",
  "No puedo dejar de recomendarlo.",
  "Non posso che confermare.",
  "Não posso deixar de recomendar.",
];

describe("E7-sexies · negativaEnTexto: la regla general al inicio", () => {
  it("⛔ ve las aperturas reales de Haiku 4.5 (322, 365) que la lista de verbos dejaba pasar", () => {
    for (const c of REALES_NUEVAS) expect(negativaEnTexto(c.texto), c.id).toBe("opens-with-refusal");
  });

  it("regresión: las de gpt-5.5 / gpt-5.6-sol siguen viéndose", () => {
    for (const t of REALES_GAMA_ALTA) expect(negativaEnTexto(t), t).toBe("opens-with-refusal");
  });

  it("⛔ cualquier verbo detrás de la negación, en los siete idiomas", () => {
    for (const t of GENERAL_OTROS_VERBOS) expect(negativaEnTexto(t), t).toBe("opens-with-refusal");
  });

  it("⛔ un «No,» delante no la esconde", () => {
    expect(negativaEnTexto("No, I won't write that essay.")).toBe("opens-with-refusal");
  });

  it("⛔ «I'm sorry, BUT I won't make…»: la disculpa con «but» + cualquier verbo no casaba (el grupo de «but» sin paréntesis, #393)", () => {
    // La regla de #393 era «disculpa + negación con cualquier verbo», pero `(?:but|however,?\s)`
    // dejaba «but» sin su espacio: solo se veía si el verbo estaba en la lista. Igual con «però|pero».
    expect(negativaEnTexto("I'm sorry, but I won't make that argument.")).toBe("apology-then-refusal");
    expect(negativaEnTexto("I'm sorry, but I won't be writing that.")).toBe("apology-then-refusal");
    expect(negativaEnTexto("Ho sento, però no puc argumentar això.")).toBe("apology-then-refusal");
    // Y sus frases hechas siguen fuera.
    expect(negativaEnTexto("I'm sorry, but I can't wait to see it! Here's the plan for the next step.")).toBeNull();
  });

  it("control: las frases hechas no son negativas, en los siete idiomas", () => {
    for (const [idioma, xs] of Object.entries(FRASES_HECHAS)) {
      for (const t of xs) {
        if ((FRASES_HECHAS_ANTES_MAL as readonly string[]).includes(t)) continue; // van en el ⛔ de abajo
        expect(negativaEnTexto(t), `${idioma}: ${t}`).toBeNull();
      }
    }
  });

  it("⛔ y las que la lista de verbos confundía («I can't help thinking», «I can't agree more with that»…) dejan de verse", () => {
    for (const t of FRASES_HECHAS_ANTES_MAL) expect(negativaEnTexto(t), t).toBeNull();
  });

  it("⛔ la cautela sin «but» en la misma frase SÍ cuenta (antes perder un acierto que cobrar una negativa)", () => {
    expect(negativaEnTexto("I can't be sure what your teacher believes.")).toBe("opens-with-refusal");
    expect(negativaEnTexto("I can't be sure without the logs, but it's probably a timeout.")).toBeNull();
  });

  it("control: solo al principio; en medio de una respuesta larga manda la lista de siempre", () => {
    const larga =
      "Sure! Here are the steps: 1. Install. 2. Run. 3. Verify. Then configure the environment, the cache and the logs; " +
      "the details depend on your platform, and the defaults are fine for most teams, so start there and adjust only " +
      "what you measure. One caveat: I can't argue that this is the only way, but it is the simplest.";
    expect(negativaEnTexto(larga)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE PUNTA A PUNTA: el SDK no la guarda ni la acredita; el gateway tampoco
// ═══════════════════════════════════════════════════════════════════════════

const MODELO = "claude-haiku-4-5";

function mensajes(texto: string) {
  const ev = (tipo: string, datos: unknown): string => `event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`;
  const json = {
    id: "msg_texto",
    type: "message",
    role: "assistant",
    model: MODELO,
    content: [{ type: "text", text: texto }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 40 },
  };
  const mitad = Math.floor(texto.length / 2);
  const sse =
    ev("message_start", {
      type: "message_start",
      message: { ...json, content: [], stop_reason: null, usage: { input_tokens: 120, output_tokens: 1 } },
    }) +
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: texto.slice(0, mitad) } }) +
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: texto.slice(mitad) } }) +
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } }) +
    ev("message_stop", { type: "message_stop" });
  return { json, sse };
}

function chat(texto: string) {
  const json = {
    id: "chatcmpl-texto",
    object: "chat.completion",
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content: texto, refusal: null }, logprobs: null, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
  };
  const trozo = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
  const mitad = Math.floor(texto.length / 2);
  const sse =
    trozo({ object: "chat.completion.chunk", model: "gpt-4o-mini", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }) +
    trozo({ object: "chat.completion.chunk", model: "gpt-4o-mini", choices: [{ index: 0, delta: { content: texto.slice(0, mitad) } }] }) +
    trozo({ object: "chat.completion.chunk", model: "gpt-4o-mini", choices: [{ index: 0, delta: { content: texto.slice(mitad) } }] }) +
    trozo({ object: "chat.completion.chunk", model: "gpt-4o-mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    trozo({ object: "chat.completion.chunk", model: "gpt-4o-mini", choices: [], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } }) +
    "data: [DONE]\n\n";
  return { json, sse };
}

function proveedor(r: { json: unknown; sse: string }) {
  const enviados: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const cuerpo = JSON.parse(String(init.body)) as Record<string, unknown>;
    enviados.push(cuerpo);
    return cuerpo["stream"] === true
      ? new Response(r.sse, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify(r.json), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { enviados, fetchImpl };
}

function capa(provider: Provider) {
  let n = 0;
  return createSavingsLayer({
    provider,
    devUnlicensed: true,
    exactTokenizer: false,
    silenceWarnings: true,
    generateId: () => `req-${n++}`,
    exactCache: new InMemoryExactCache(),
  });
}

const anthropic = (fetchImpl: typeof fetch) => new AnthropicProvider({ fetchImpl });
const openai = (fetchImpl: typeof fetch) => new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", fetchImpl });
const peticion = (proveedorId: "anthropic" | "openai", prompt: string): SavingsRequest => ({
  model: proveedorId === "anthropic" ? `anthropic/${MODELO}` : "openai/gpt-4o-mini",
  temperature: 0,
  messages: [{ role: "user", content: prompt }],
});
/** Un prompt neutro: decide la RESPUESTA (ni frescura, ni personalización, ni tema sensible). */
const PROMPT_NEUTRO = "Write a persuasive paragraph about healthcare policy for the elderly.";

const trazaDe = (r: SavingsResult, etapa: string) => r.report.traces.filter((t) => t.stage === etapa);

const PROVEEDORES = [
  { nombre: "Anthropic", id: "anthropic", crear: anthropic, respuesta: mensajes },
  { nombre: "Chat Completions", id: "openai", crear: openai, respuesta: chat },
] as const;

/** Respuestas normales que abren con una frase hecha: se siguen cacheando. */
const CONTROLES_SDK = [
  "I can't wait to see what you build! Start with `pnpm create` and add the cache later.",
  "I won't lie, this one is tricky. Start with the parser and write a test per rule.",
  "I can't find any issues in this code; it looks correct.",
  "No puedo creer lo fácil que es: basta con `git switch -c`.",
];

describe("E7-sexies · el SDK no guarda ni acredita la negativa general", () => {
  for (const p of PROVEEDORES) {
    for (const c of REALES_NUEVAS) {
      for (const modo of ["generate", "generateStream"] as const) {
        it(`⛔ ${p.nombre} · ${modo} · ${c.id}: medida y servida, la repetición vuelve a llamar (antes: exact + reference)`, async () => {
          const s = proveedor(p.respuesta(c.texto));
          const layer = capa(p.crear(s.fetchImpl));
          const pedir = () =>
            modo === "generate"
              ? layer.generate(peticion(p.id, PROMPT_NEUTRO))
              : layer.generateStream(peticion(p.id, PROMPT_NEUTRO)).result;
          const primera = await pedir();
          expect(primera.text).toBe(c.texto);
          expect(primera.report.cost.basis).toBe("measured");
          expect(primera.report.cache.result).toBe("miss");
          expect(trazaDe(primera, "cache-write").map((t) => t.detail).filter(Boolean)).toContainEqual(
            expect.objectContaining({ skipReason: "text_refusal", rule: "opens-with-refusal" }),
          );
          expect(trazaDe(primera, "reference")[0]).toMatchObject({ outcome: "not-written", detail: { reason: "not-cacheable" } });
          const segunda = await pedir();
          expect(s.enviados).toHaveLength(2);
          expect(segunda.report.cache.result).toBe("miss");
          expect(segunda.report.cost.basis).toBe("measured");
          expect(segunda.report.cache.reference).toBeUndefined();
        });
      }
    }

    it(`control · ${p.nombre}: las respuestas que abren con una frase hecha se siguen cacheando y acreditando`, async () => {
      for (const texto of CONTROLES_SDK) {
        const s = proveedor(p.respuesta(texto));
        const layer = capa(p.crear(s.fetchImpl));
        const primera = await layer.generate(peticion(p.id, PROMPT_NEUTRO));
        expect(trazaDe(primera, "cache-write").map((t) => t.outcome).join(" | "), texto).not.toContain("skipped");
        expect(trazaDe(primera, "reference")[0]?.outcome, texto).toBe("written");
        const segunda = await layer.generateStream(peticion(p.id, PROMPT_NEUTRO)).result;
        expect(s.enviados).toHaveLength(1);
        expect(segunda.report.cache.result).toBe("exact");
        expect(segunda.text).toBe(texto);
      }
    });
  }
});

let recursos: (Server | GatewayArrancado)[] = [];
afterEach(async () => {
  for (const r of recursos) {
    if ("cerrar" in r) await r.cerrar();
    else await new Promise((res) => r.close(res));
  }
  recursos = [];
});

async function esperar(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout esperando la condición");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function escuchar(s: Server): Promise<number> {
  recursos.push(s);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port)));
}

function upstream(cuerpo: string, tipo: "json" | "sse", contador: { hits: number }): Promise<number> {
  return escuchar(
    createServer(async (req, res) => {
      for await (const _ of req) void _;
      contador.hits += 1;
      setTimeout(() => {
        res.writeHead(200, { "content-type": tipo === "json" ? "application/json" : "text/event-stream" });
        res.end(cuerpo);
      }, 150);
    }),
  );
}

function ingesta(lotes: unknown[][]): Promise<number> {
  return escuchar(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (req.method === "GET" && (req.url ?? "").startsWith("/api/org/entitlements")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"features":[]}');
        return;
      }
      lotes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[]);
      res.writeHead(202, { "content-type": "application/json" });
      res.end('{"ingested":1}');
    }),
  );
}

async function pareja(respuesta: string, tipo: "json" | "sse", cuerpo: Record<string, unknown>) {
  const oficial = "https://api.anthropic.com";
  const lotes: unknown[][] = [];
  const lineas: string[] = [];
  const contador = { hits: 0 };
  const puerto = await upstream(respuesta, tipo, contador);
  const puertoIngesta = await ingesta(lotes);
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.origin === oficial) return fetch(`http://127.0.0.1:${puerto}${u.pathname}${u.search}`, init);
    return fetch(input, init);
  }) as typeof fetch;
  const gw = await arrancarGateway({
    license: testLicense(),
    puerto: 0 as never,
    upstream: oficial,
    fetchImpl,
    serviceAccountKey: "bvk_test",
    meteringUrl: `http://127.0.0.1:${puertoIngesta}`,
    seatId: "test-01",
    log: (l) => lineas.push(l),
    warn: () => {},
    coalescer: true,
  });
  recursos.push(gw);
  const texto = JSON.stringify(cuerpo);
  const pedir = () => fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body: texto }).then((r) => r.text());
  const p1 = pedir();
  await new Promise((r) => setTimeout(r, 40));
  const p2 = pedir();
  const [r1, r2] = await Promise.all([p1, p2]);
  expect(contador.hits).toBe(1);
  expect(r1).toBe(respuesta);
  expect(r2).toBe(respuesta);
  await gw.cerrar();
  await esperar(() => lotes.flat().length >= 2);
  const regs = lotes.flat() as Record<string, unknown>[];
  return { gemela: regs.find((r) => r["cacheResult"] === "singleflight")!, log: lineas.join("\n") };
}

const cuerpoMensajes = (stream: boolean) => ({
  model: MODELO,
  max_tokens: 64,
  temperature: 0,
  messages: [{ role: "user", content: PROMPT_NEUTRO }],
  ...(stream ? { stream: true } : {}),
});

describe("E7-sexies · el gateway", () => {
  for (const tipo of ["json", "sse"] as const) {
    it(`⛔ /v1/messages (${tipo}): la gemela de Haiku 322 es estimated (primary-text-refusal)`, async () => {
      const r = mensajes(ID_322);
      const { gemela, log } = await pareja(tipo === "json" ? JSON.stringify(r.json) : r.sse, tipo, cuerpoMensajes(tipo === "sse"));
      expect(gemela["basis"]).toBe("estimated");
      expect(gemela["referenceRequestId"]).toBeUndefined();
      expect(log).toContain("estimated, not by reference: primary-text-refusal");
    });
  }

  it("control: una frase hecha («I won't lie…») sigue dando referencia a su gemela", async () => {
    const { gemela, log } = await pareja(mensajes(CONTROLES_SDK[1]!).sse, "sse", cuerpoMensajes(true));
    expect(gemela["basis"]).toBe("reference");
    expect(log).not.toContain("primary-text-refusal");
  });
});
