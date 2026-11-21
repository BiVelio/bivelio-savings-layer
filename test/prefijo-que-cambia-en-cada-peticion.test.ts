import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { ChatMessage, SavingsRequest } from "../src/contracts/types.js";

/**
 * LA CONFIGURACIÓN POR DEFECTO NO PUEDE SUBIR LA FACTURA.
 *
 * Con un `system` que lleva algo distinto en cada petición (la hora, un UUID, un
 * id de petición), la 1.2.3 ponía `cache_control` en TODAS las peticiones de
 * Anthropic y pagaba la prima de escritura (1,25×) sin leer nunca: 60 de 60
 * marcadas, +21,6 % de factura frente a no llevar capa.
 *
 * La 1.2.4 lo adivinaba con un detector de «contenido por petición» y fallaba en
 * los dos sentidos: valores ESTABLES (un UUID de sesión, la fecha del día, un
 * número de cliente) apagaban la caché de chats que sí la leían (−40,8 % en la
 * 1.2.3, +1,8 % con 8 chats a la vez), y valores que cambian de verdad («10:42
 * AM», un UUID v7, un id de petición) no los veía. Ahora no se adivina nada: la
 * verja mira si la CABECERA (herramientas + `system`) vuelve antes de que caduque
 * su entrada de caché (ver `prefix-cache-gate.ts`).
 *
 * Aquí se fija, en el camino real (el adaptador de Anthropic de verdad contra
 * una API falsa EN PROCESO que simula su caché: solo cachea donde hay
 * `cache_control`, lee el prefijo más largo ya escrito, mínimo 1.024 tokens, y
 * con reloj, caduca a los 5 minutos y una lectura renueva):
 *
 *   1. los falsos negativos de la 1.2.4: con la hora en cualquier formato, un
 *      UUID v7 o un id de petición, la factura baja en cuanto las primeras
 *      cabeceras caducan sin volver;
 *   2. los falsos positivos de la 1.2.4: un UUID de sesión, la fecha del día o
 *      un número de cliente se marcan como en la 1.2.3;
 *   3. que NADA de lo que ya ahorraba cambia: system estable, `cachePrefix`,
 *      conversación con historial, streaming y `cacheBreakpoints: "auto"`.
 *
 * Ningún byte sale del proceso: `fetchImpl` es una función local, y el reloj es
 * el de la capa (`now`), compartido con la API falsa.
 */

const MODELO = "anthropic/claude-sonnet-4-5";
const MINIMO = 1024;
const tok = (s: string): number => Math.ceil(s.length / 4);

interface Cuenta {
  llamadas: number;
  marcadas: number;
  plena: number;
  leidos: number;
  escritos: number;
  /** Por petición: ¿llevaba `cache_control`? */
  marcas: boolean[];
}

/**
 * API de Mensajes falsa con la caché de prompt de Anthropic (reglas públicas).
 * Con `reloj`, cada entrada caduca a los 5 minutos de su última escritura o
 * lectura; sin él, no caduca nunca.
 */
function anthropicFalso(reloj?: () => number): { fetchImpl: typeof fetch; cuenta: Cuenta } {
  const hasta = new Map<string, number>();
  const cache = {
    has: (h: string): boolean => {
      const t = hasta.get(h);
      if (t == null) return false;
      if (reloj == null) return true;
      if (t <= reloj()) return false;
      hasta.set(h, reloj() + 300_000); // leer renueva
      return true;
    },
    add: (h: string): void => void hasta.set(h, reloj ? reloj() + 300_000 : Infinity),
  };
  const cuenta: Cuenta = { llamadas: 0, marcadas: 0, plena: 0, leidos: 0, escritos: 0, marcas: [] };
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const bloques: { texto: string; bp: boolean }[] = [];
    for (const t of (body["tools"] as Record<string, unknown>[] | undefined) ?? []) {
      const { cache_control, ...resto } = t;
      bloques.push({ texto: "T:" + JSON.stringify(resto), bp: cache_control != null });
    }
    const system = body["system"];
    if (typeof system === "string") bloques.push({ texto: "S:" + system, bp: false });
    else for (const b of (system as Record<string, unknown>[] | undefined) ?? []) {
      bloques.push({ texto: "S:" + String(b["text"] ?? ""), bp: b["cache_control"] != null });
    }
    for (const m of body["messages"] as { role: string; content: string | Record<string, unknown>[] }[]) {
      if (typeof m.content === "string") bloques.push({ texto: `M:${m.role}:${m.content}`, bp: false });
      else for (const b of m.content) {
        const { cache_control, ...resto } = b;
        bloques.push({ texto: `M:${m.role}:${JSON.stringify(resto)}`, bp: cache_control != null });
      }
    }
    let acumulado = `modelo:${String(body["model"])}|`;
    const pref = bloques.map((b) => {
      acumulado += b.texto + "\u0001";
      return { hash: createHash("sha256").update(acumulado).digest("hex"), tokens: tok(acumulado) };
    });
    const total = pref.at(-1)?.tokens ?? 0;
    const puntos = bloques.flatMap((b, i) => (b.bp ? [i] : []));
    let leidos = 0;
    let escritos = 0;
    if (puntos.length > 0) {
      for (const p of puntos) {
        for (let j = p; j >= Math.max(0, p - 20); j--) {
          if (pref[j]!.tokens >= MINIMO && cache.has(pref[j]!.hash)) {
            leidos = Math.max(leidos, pref[j]!.tokens);
            break;
          }
        }
      }
      const ultimo = puntos.at(-1)!;
      if (pref[ultimo]!.tokens >= MINIMO && pref[ultimo]!.tokens > leidos) escritos = pref[ultimo]!.tokens - leidos;
      for (const p of puntos) if (pref[p]!.tokens >= MINIMO) cache.add(pref[p]!.hash);
    }
    cuenta.llamadas += 1;
    cuenta.marcas.push(puntos.length > 0);
    if (puntos.length > 0) cuenta.marcadas += 1;
    cuenta.plena += total - leidos - escritos;
    cuenta.leidos += leidos;
    cuenta.escritos += escritos;
    const usage = {
      input_tokens: total - leidos - escritos,
      output_tokens: 20,
      cache_read_input_tokens: leidos,
      cache_creation_input_tokens: escritos,
    };
    if (body["stream"] === true) {
      const ev = (tipo: string, data: Record<string, unknown>): string =>
        `event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...data })}\n\n`;
      const sse =
        ev("message_start", { message: { id: "msg_falso", type: "message", role: "assistant", content: [], usage: { ...usage, output_tokens: 1 } } }) +
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hecho." } }) +
        ev("content_block_stop", { index: 0 }) +
        ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }) +
        ev("message_stop", {});
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(
      JSON.stringify({ id: "msg_falso", type: "message", role: "assistant", content: [{ type: "text", text: "Hecho." }], stop_reason: "end_turn", usage }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, cuenta };
}

/** Lo que cobraría Anthropic por la entrada, en tokens a precio lleno: lectura 0,10×, escritura 1,25×. */
const coste = (c: Cuenta): number => c.plena + 0.1 * c.leidos + 1.25 * c.escritos;
/** Lo mismo sin capa: toda la entrada a 1×. */
const sinCapa = (c: Cuenta): number => c.plena + c.leidos + c.escritos;

/** Un reloj simulado que empieza en una hora fija y avanza a mano. */
function relojSimulado(): { now: () => number; pasar: (ms: number) => void } {
  let t = Date.UTC(2026, 10, 21, 10, 0, 0);
  return { now: () => t, pasar: (ms) => void (t += ms) };
}

function capa(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): SavingsPipeline {
  return new SavingsPipeline({
    provider: new AnthropicProvider({ apiKey: "clave-inventada", fetchImpl }),
    tokenizer: new TokenizerRegistry(),
    devUnlicensed: true,
    ...extra,
  } as never);
}

// Un system largo e inventado (≈ 3.300 tokens), con sitio en la SEGUNDA línea para la hora.
const REGLA = (i: number): string =>
  `Rule ${i}. When a customer writes about topic number ${i}, the assistant answers in two short sentences, ` +
  `cites the policy section ${i}.${i % 7} of the handbook, never promises refunds outside the thirty day window, ` +
  "and escalates to a human agent when the customer mentions legal action or repeated failures of the same device. ";
const CABEZA = "You are the support assistant of Acme Devices (an invented company). Follow every rule below.";
const REGLAS = Array.from({ length: 40 }, (_, i) => REGLA(i + 1)).join("\n");
const ESTABLE = `${CABEZA}\n${REGLAS}`;
const hora = (i: number): string => new Date(Date.UTC(2026, 10, 21, 10, 0, i)).toISOString();
/** La hora en una línea propia. */
const CON_HORA = (i: number): string => `${CABEZA}\nGenerated at ${hora(i)}.\n${REGLAS}`;
/** La hora en la MISMA línea que todo lo demás (un system de una sola línea), según el reloj. */
const CON_HORA_EN_LINEA = (ahora: number): string => `Current time: ${new Date(ahora).toISOString()}. ${ESTABLE.replace(/\n/g, " ")}`;

const pregunta = (i: number): string =>
  `Customer question ${i + 1}: the device with serial ${1000 + i * 37} does not turn on after charging. What do I tell them?`;
const peticion = (system: string, i: number, savings?: SavingsRequest["savings"]): SavingsRequest =>
  ({
    model: MODELO,
    messages: [
      { role: "system", content: system },
      { role: "user", content: pregunta(i) },
    ],
    ...(savings ? { savings } : {}),
  }) as SavingsRequest;

let avisos: string[] = [];
beforeEach(() => {
  reiniciarAvisos();
  avisos = [];
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void avisos.push(a.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Formatos de «ahora» y de ids por petición que el detector de la 1.2.4 no veía (o veía de más). */
const p2 = (n: number): string => String(n).padStart(2, "0");
const AMPM = (ms: number): string => {
  const d = new Date(ms);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${p2(d.getUTCMinutes())} ${h < 12 ? "AM" : "PM"}`;
};
const UNO = ["twelve", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"];
const MINUTOS = (m: number): string =>
  m === 0 ? "o'clock" : m < 10 ? `oh ${m}` : `${["", "", "twenty", "thirty", "forty", "fifty"][Math.floor(m / 10)]}${m % 10 ? `-${m % 10}` : ""}`;
const EN_PALABRAS = (ms: number): string => {
  const d = new Date(ms);
  return `It is ${UNO[d.getUTCHours() % 12]} ${MINUTOS(d.getUTCMinutes())} in the ${d.getUTCHours() < 12 ? "morning" : "afternoon"}`;
};
const hex = (s: string): string => createHash("sha256").update(s).digest("hex");
const UUID_V7 = (ms: number, i: number): string => {
  const t = Math.floor(ms).toString(16).padStart(12, "0");
  const r = hex(`v7-${i}`);
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${r.slice(0, 3)}-8${r.slice(3, 6)}-${r.slice(6, 18)}`;
};
const ID_DE_PETICION = (i: number): string => `req_${hex(`req-${i}`).slice(0, 24)}`;
const UUID_V4 = (s: string): string => {
  const x = hex(s);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-a${x.slice(17, 20)}-${x.slice(20, 32)}`;
};

/** `n` preguntas sueltas, `paso` ms entre una y otra, con la cabeza del system según el reloj. */
async function sueltas(
  n: number,
  paso: number,
  cabeza: (ahora: number, i: number) => string,
  extra: Record<string, unknown> = {},
  modo: "generate" | "stream" = "generate",
): Promise<Cuenta> {
  const reloj = relojSimulado();
  const f = anthropicFalso(reloj.now);
  const layer = capa(f.fetchImpl, { silenceWarnings: true, now: reloj.now, ...extra });
  for (let i = 0; i < n; i++) {
    const r = peticion(`${CABEZA}\n${cabeza(reloj.now(), i)}\n${REGLAS}`, i);
    if (modo === "stream") await layer.generateStream(r).result;
    else await layer.generate(r);
    reloj.pasar(paso);
  }
  return f.cuenta;
}

describe("FALSOS NEGATIVOS de la 1.2.4: lo que cambia en cada petición deja de pagar la prima en cuanto se ve que no vuelve", () => {
  // En la 1.2.3 todas estas cargas marcan 600 de 600 y no leen nada: +21 % de
  // factura. Con el reloj simulado, a los 5 minutos la primera cabecera caduca
  // sin haber vuelto; con 16 así, la clase es volátil y las nuevas dejan de
  // marcarse. Hasta entonces se marca exactamente como en la 1.2.3.
  const CASOS = [
    ["la hora ISO con segundos, 2 s entre peticiones", 2000, (t: number) => `Now: ${new Date(t).toISOString()}`, 165, 0.07],
    ["la hora RFC con segundos", 2000, (t: number) => `Date: ${new Date(t).toUTCString()}`, 165, 0.07],
    ["«10:42 AM» (cambia cada minuto, 61 s entre peticiones)", 61_000, (t: number) => `The time is ${AMPM(t)}.`, 20, 0.01],
    ["la hora en palabras", 61_000, (t: number) => `${EN_PALABRAS(t)}.`, 20, 0.01],
    ["un UUID v7 por petición, 1 s entre peticiones", 1000, (t: number, i: number) => `Trace ${UUID_V7(t, i)}`, 315, 0.135],
    ["un id de petición", 1000, (_t: number, i: number) => `Request id: ${ID_DE_PETICION(i)}`, 315, 0.135],
  ] as const;

  // it.skip: regla apagada hasta la 1.2.5 (`VERJA_DE_CABECERAS_ACTIVA = false` en
  // src/economics/prefix-cache-gate.ts). Fija la regla encendida; vuelve con ella.
  it.skip.each(CASOS)("%s: 600 peticiones", async (_n, paso, cabeza, marcadas, techo) => {
    const c = await sueltas(600, paso, cabeza);
    expect(c.llamadas).toBe(600);
    expect(c.leidos).toBe(0);
    // Las primeras, como la 1.2.3 (todas marcadas); desde que la clase es
    // volátil, ninguna.
    expect(c.marcadas).toBe(marcadas);
    expect(c.marcas.slice(0, marcadas)).toEqual(Array(marcadas).fill(true));
    // El dinero: la 1.2.3 pagaba la prima en las 600 (+21 % con este system);
    // aquí, solo la de las marcadas.
    const sobrecoste = coste(c) / sinCapa(c) - 1;
    const de123 = (0.25 * (c.escritos / marcadas) * 600) / sinCapa(c);
    expect(de123).toBeGreaterThan(0.2);
    expect(sobrecoste).toBeLessThan(techo);
    expect(sobrecoste).toBeLessThan(de123 * (marcadas / 600) + 0.001);
  });

  // it.skip: regla apagada hasta la 1.2.5 (`VERJA_DE_CABECERAS_ACTIVA = false` en
  // src/economics/prefix-cache-gate.ts). Fija la regla encendida; vuelve con ella.
  it.skip("también en streaming y con cacheBreakpoints: \"auto\"", async () => {
    const hora = (t: number): string => `Now: ${new Date(t).toISOString()}`;
    expect((await sueltas(600, 2000, hora, {}, "stream")).marcadas).toBe(165);
    expect((await sueltas(600, 2000, hora, { cacheBreakpoints: "auto" })).marcadas).toBe(165);
  });

  // it.skip: regla apagada hasta la 1.2.5 (`VERJA_DE_CABECERAS_ACTIVA = false` en
  // src/economics/prefix-cache-gate.ts). Fija la regla encendida; vuelve con ella.
  it.skip("un chat con la hora de cada turno en el system (10 chats × 60 turnos): de +24 % a cerca de 0", async () => {
    const reloj = relojSimulado();
    const f = anthropicFalso(reloj.now);
    const layer = capa(f.fetchImpl, { silenceWarnings: true, now: reloj.now });
    const historiales = new Map<number, ChatMessage[]>();
    for (let t = 0; t < 60; t++) {
      for (let chat = 0; chat < 10; chat++) {
        const h = historiales.get(chat) ?? [];
        const q: ChatMessage = { role: "user", content: `${pregunta(t)} (chat ${chat})` };
        const r = await layer.generate({
          model: MODELO,
          messages: [{ role: "system", content: `${ESTABLE}\nNow: ${new Date(reloj.now()).toISOString()}` }, ...h, q],
        } as SavingsRequest);
        historiales.set(chat, [...h, q, { role: "assistant", content: `${r.text} Answer ${t}. `.repeat(6) }]);
        reloj.pasar(2000);
      }
    }
    expect(f.cuenta.leidos).toBe(0);
    expect(f.cuenta.marcadas).toBe(165);
    expect(coste(f.cuenta) / sinCapa(f.cuenta) - 1).toBeLessThan(0.06);
  });

  it("MIENTRAS NINGUNA HA PODIDO CADUCAR (60 peticiones seguidas, sin reloj que avance) decide exactamente como la 1.2.3: 60 de 60", async () => {
    // Es el precio de no adivinar: hasta que pasa un TTL no hay prueba de que
    // la cabecera no vuelva. Nunca peor que la 1.2.3.
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    for (let i = 0; i < 60; i++) await layer.generate(peticion(CON_HORA(i), i));
    expect(f.cuenta.marcadas).toBe(60);
    expect(f.cuenta.leidos).toBe(0);
  });

  it("el aviso por consola es el de la 1.2.3: no promete que la capa deje de marcar (la regla está apagada en la 1.2.4)", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    for (let i = 0; i < 3; i++) await layer.generate(peticion(CON_HORA(i), i));
    const delAudit = avisos.filter((a) => a.includes("prompt cache"));
    expect(delAudit).toHaveLength(1);
    expect(delAudit[0]).toBe(
      "[bvsala] your system prompt carries per-request content (iso-timestamp); the provider prompt " +
        "cache can never hit on it, so cache reads you expect are billing as full writes. Move the " +
        "per-request value to the query tail. (reported once per process)",
    );
    expect(delAudit[0]).not.toContain("stops marking");
  });

  it("savings.cachePrefix: true lo arregla cuando la hora va en una línea propia: 60 marcadas, 59 lecturas", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    for (let i = 0; i < 60; i++) await layer.generate(peticion(CON_HORA(i), i, { cachePrefix: true }));
    expect(f.cuenta.marcadas).toBe(60);
    expect(f.cuenta.leidos).toBeGreaterThan(59 * 3000);
    expect(coste(f.cuenta) / sinCapa(f.cuenta)).toBeLessThan(0.3);
  });

  // it.skip: regla apagada hasta la 1.2.5 (`VERJA_DE_CABECERAS_ACTIVA = false` en
  // src/economics/prefix-cache-gate.ts). Fija la regla encendida; vuelve con ella.
  it.skip("LÍMITE CONOCIDO: con la hora en la misma línea que el resto, cachePrefix no tiene nada estable que separar; no hay descuento, pero la verja deja de pagar la prima", async () => {
    // `cachePrefix` mueve LÍNEAS enteras. Un system de una sola línea con la
    // hora dentro es todo él «línea mutable»: no queda prefijo estable.
    const reloj = relojSimulado();
    const f = anthropicFalso(reloj.now);
    const layer = capa(f.fetchImpl, { silenceWarnings: true, now: reloj.now });
    for (let i = 0; i < 600; i++) {
      await layer.generate(peticion(CON_HORA_EN_LINEA(reloj.now()), i, { cachePrefix: true }));
      reloj.pasar(2000);
    }
    expect(f.cuenta.leidos).toBe(0);
    expect(f.cuenta.marcadas).toBe(165);
  });
});

describe("FALSOS POSITIVOS de la 1.2.4: un valor estable en el system se marca como en la 1.2.3", () => {
  // Medido con la 1.2.4 (proveedor falso): 8 chats a la vez con el UUID de
  // sesión en el system pasaban de −40,8 % a +1,3 % (0 lecturas, y no se
  // recuperaba). Aquí: ninguna decisión sale de la verja de cabeceras (todas
  // son las de la 1.2.3), y desde el cuarto turno cada uno lee lo que escribió
  // el anterior (el primero y el segundo, con este system corto, no escriben
  // nada: el historial se marca desde el tercero).
  const CORTO = "You are a support assistant for an invented shop. Be brief.";
  const LARGO = (x: string): string => `Pasted background ${x}. `.repeat(120);
  async function chatsALaVez(
    chats: number,
    turnos: number,
    sistema: (c: number) => string,
    paso = 0,
  ): Promise<{ cuenta: Cuenta; leenDesdeElTurno4: boolean; deLaVerjaDeCabeceras: number }> {
    const reloj = relojSimulado();
    const f = anthropicFalso(paso > 0 ? reloj.now : undefined);
    const layer = capa(f.fetchImpl, { silenceWarnings: true, ...(paso > 0 ? { now: reloj.now } : {}) });
    const historiales = new Map<number, ChatMessage[]>();
    let leenDesdeElTurno4 = true;
    let deLaVerjaDeCabeceras = 0;
    for (let t = 0; t < turnos; t++) {
      for (let c = 0; c < chats; c++) {
        const h = historiales.get(c) ?? [];
        const q: ChatMessage = { role: "user", content: `Turn ${t + 1} of chat ${c}: ${LARGO(`${c}-${t}`)} what about order ${t}?` };
        const antes = f.cuenta.leidos;
        const r = await layer.generate({ model: MODELO, messages: [{ role: "system", content: sistema(c) }, ...h, q] } as SavingsRequest);
        if (t >= 3 && f.cuenta.leidos === antes) leenDesdeElTurno4 = false;
        for (const x of r.report.traces) if (/not seen before/.test(String(x.detail?.["reason"] ?? ""))) deLaVerjaDeCabeceras += 1;
        historiales.set(c, [...h, q, { role: "assistant", content: `${r.text} Answer ${t + 1} for chat ${c}.` }]);
        reloj.pasar(paso);
      }
    }
    return { cuenta: f.cuenta, leenDesdeElTurno4, deLaVerjaDeCabeceras };
  }

  it.each([
    ["8 chats a la vez con el UUID de sesión en el system", 8, (c: number) => `${CORTO} Session id: ${UUID_V4(`s${c}`)}.`],
    ["20 chats a la vez con el UUID de sesión", 20, (c: number) => `${CORTO} Session id: ${UUID_V4(`s${c}`)}.`],
    ["20 chats con la fecha RFC del día", 20, () => `${CORTO} Today is Sat, 21 Nov 2026.`],
    ["20 chats con la ISO de medianoche", 20, () => `${CORTO} Current date: 2026-11-21T00:00:00Z.`],
    ["20 chats con un número de cliente de 10 cifras", 20, (c: number) => `${CORTO} Customer account ${1734567890 + c * 7919}.`],
  ] as const)("%s × 8 turnos: deciden como la 1.2.3 y leen caché desde el turno 4", async (_n, chats, sistema) => {
    for (const paso of [0, 3000]) {
      const { cuenta, leenDesdeElTurno4, deLaVerjaDeCabeceras } = await chatsALaVez(chats, 8, sistema, paso);
      expect(deLaVerjaDeCabeceras).toBe(0);
      expect(leenDesdeElTurno4).toBe(true);
      // Con la 1.2.4: 0 lecturas y la entrada tan cara como sin capa.
      expect(coste(cuenta)).toBeLessThan(0.7 * sinCapa(cuenta));
    }
  });

  it("200 sesiones con su contrato y su UUID en el system, 20 a la vez, 2 preguntas: una escritura y una lectura por sesión, con y sin reloj", async () => {
    for (const paso of [0, 1000]) {
      const reloj = relojSimulado();
      const f = anthropicFalso(paso > 0 ? reloj.now : undefined);
      const layer = capa(f.fetchImpl, { silenceWarnings: true, ...(paso > 0 ? { now: reloj.now } : {}) });
      for (let base = 0; base < 200; base += 20) {
        for (let turno = 0; turno < 2; turno++) {
          for (let s = base; s < base + 20; s++) {
            await layer.generate({
              model: MODELO,
              messages: [
                { role: "system", content: `${DOCUMENTO(`c${s}`)}\nSession ${UUID_V4(`c${s}`)}.` },
                { role: "user", content: `Question ${turno + 1} of session ${s}: what happens with item ${turno + 3}?` },
              ],
            } as SavingsRequest);
            reloj.pasar(paso);
          }
        }
      }
      expect(f.cuenta.marcadas).toBe(400);
      expect(f.cuenta.leidos).toBe(f.cuenta.escritos);
    }
  });
});

describe("lo que ya ahorraba no cambia", () => {
  it("system largo y estable: 60 de 60 marcadas, 1 escritura y 59 lecturas", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    for (let i = 0; i < 60; i++) await layer.generate(peticion(ESTABLE, i));
    expect(f.cuenta.marcadas).toBe(60);
    const P = f.cuenta.escritos;
    expect(P).toBeGreaterThan(3000);
    expect(f.cuenta.leidos).toBe(59 * P);
    expect(coste(f.cuenta) / sinCapa(f.cuenta)).toBeLessThan(0.3);
    expect(avisos.filter((a) => a.includes("prompt cache"))).toHaveLength(0);
  });

  it("system estable en streaming: igual", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    for (let i = 0; i < 20; i++) await layer.generateStream(peticion(ESTABLE, i)).result;
    expect(f.cuenta.marcadas).toBe(20);
    expect(f.cuenta.leidos).toBe(19 * f.cuenta.escritos);
  });

  it('system estable con cacheBreakpoints: "auto": igual', async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl, { cacheBreakpoints: "auto" });
    for (let i = 0; i < 20; i++) await layer.generate(peticion(ESTABLE, i));
    expect(f.cuenta.marcadas).toBe(20);
    expect(f.cuenta.leidos).toBe(19 * f.cuenta.escritos);
  });

  // it.skip: regla apagada hasta la 1.2.5 (`VERJA_DE_CABECERAS_ACTIVA = false` en
  // src/economics/prefix-cache-gate.ts). Fija la regla encendida; vuelve con ella.
  it.skip("un system estable no deja de marcarse porque otro, del mismo modelo, cambie en cada petición", async () => {
    const reloj = relojSimulado();
    const f = anthropicFalso(reloj.now);
    const layer = capa(f.fetchImpl, { silenceWarnings: true, now: reloj.now });
    const delEstable: boolean[] = [];
    const delQueCambia: boolean[] = [];
    for (let i = 0; i < 300; i++) {
      await layer.generate(peticion(ESTABLE, i));
      delEstable.push(f.cuenta.marcas.at(-1)!);
      reloj.pasar(1000);
      await layer.generate(peticion(`${CABEZA}\nGenerated at ${new Date(reloj.now()).toISOString()}.\n${REGLAS}`, i));
      delQueCambia.push(f.cuenta.marcas.at(-1)!);
      reloj.pasar(1000);
    }
    expect(delEstable).toEqual(Array(300).fill(true));
    // Los que cambian: como la 1.2.3 hasta que caducan sin volver (5 min), y
    // desde ahí ninguno.
    expect(delQueCambia.slice(0, 150)).toEqual(Array(150).fill(true));
    expect(delQueCambia.slice(200)).toEqual(Array(100).fill(false));
    expect(f.cuenta.leidos).toBeGreaterThan(299 * 3000);
  });

  // it.skip: regla apagada hasta la 1.2.5 (`VERJA_DE_CABECERAS_ACTIVA = false` en
  // src/economics/prefix-cache-gate.ts). Fija la regla encendida; vuelve con ella.
  it.skip("un system estable que llega cuando la clase ya es volátil pierde UNA escritura, la primera, y desde la segunda se marca y lee", async () => {
    // Es la única diferencia con la 1.2.3 y solo existe en una clase donde al
    // menos el 90 % de las cabeceras recientes no volvieron antes de caducar:
    // ahí, marcar una cabecera nunca vista casi siempre era tirar la prima.
    const reloj = relojSimulado();
    const f = anthropicFalso(reloj.now);
    const layer = capa(f.fetchImpl, { silenceWarnings: true, now: reloj.now });
    for (let i = 0; i < 200; i++) {
      await layer.generate(peticion(CON_HORA(i), i));
      reloj.pasar(2000);
    }
    expect(f.cuenta.marcas.slice(170, 200)).toEqual(Array(30).fill(false)); // la clase es volátil
    const antes = f.cuenta.marcas.length;
    for (let i = 0; i < 20; i++) {
      await layer.generate(peticion(ESTABLE, i));
      reloj.pasar(2000);
    }
    expect(f.cuenta.marcas.slice(antes)).toEqual([false, ...Array(19).fill(true)]);
    expect(f.cuenta.leidos).toBeGreaterThan(18 * 3000);
  });

  it("una conversación con historial (huella nueva en cada turno) sigue marcando y leyendo", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    const historial: ChatMessage[] = [{ role: "system", content: ESTABLE }];
    for (let turno = 0; turno < 40; turno++) {
      historial.push({ role: "user", content: pregunta(turno) });
      const r = await layer.generate({ model: MODELO, messages: [...historial] } as SavingsRequest);
      historial.push({ role: "assistant", content: `${r.text} Answer number ${turno}: restart the device and check the charger. `.repeat(8) });
    }
    expect(f.cuenta.marcas).toEqual(Array(40).fill(true));
    // Todas menos la primera leen, y lo leído crece con el historial.
    expect(f.cuenta.leidos).toBeGreaterThan(39 * 3000);
    expect(coste(f.cuenta) / sinCapa(f.cuenta)).toBeLessThan(0.35);
  });
});

/**
 * MUCHAS SESIONES A LA VEZ, CADA UNA CON SU SYSTEM ESTABLE PROPIO
 * («chatea con tu documento»: el system es el documento de esa sesión).
 *
 * La revisión de #611 encontró que la primera versión del arreglo SUBÍA la
 * factura aquí. La clase de la verja no lleva el texto del system, así que
 * todas las sesiones caían en la misma clase; las primeras peticiones de cada
 * sesión son escrituras sin lectura, la clase se apagaba como si fuera el caso
 * de la fecha, y las sesiones siguientes dejaban de marcar: su segundo turno ya
 * no tenía nada que leer. Medido con 200 sesiones × 2 turnos, 20 intercaladas:
 * de −26,1 % en main a +5,4 %.
 *
 * Las cifras de MAIN de la tabla están medidas con este mismo fichero copiado a
 * main (20a36791) y se quedan fijas: la rama no puede costar más que eso.
 * `coste` es la entrada en tokens a precio lleno (lectura 0,10×, escritura
 * 1,25×), que es lo único que mueve esta palanca.
 */
const CLAUSULA = (s: string, i: number): string =>
  `Clause ${i} of contract ${s}. The supplier number ${s} delivers item ${i} within ${i} days, ` +
  "and the buyer pays within thirty days of delivery unless the goods are rejected in writing. ";
/** El «documento» inventado de una sesión: ≈ 1.700 tokens, distinto por sesión, igual en todos sus turnos. */
const DOCUMENTO = (s: string): string =>
  `You answer questions about the invented contract number ${s}. Use only the text below.\n` +
  Array.from({ length: 40 }, (_, i) => CLAUSULA(s, i + 1)).join("\n");

interface Carga {
  sesiones: number;
  turnos: number;
  /** Cuántas sesiones van intercaladas (turno 1 de todas, turno 2 de todas, …). */
  intercaladas: number;
  modo: "defecto" | "auto";
}

async function correr(c: Carga, una: (layer: SavingsPipeline, id: string, turno: number) => Promise<void>): Promise<Cuenta> {
  const f = anthropicFalso();
  const layer = capa(f.fetchImpl, { silenceWarnings: true, ...(c.modo === "auto" ? { cacheBreakpoints: "auto" } : {}) });
  for (let base = 0; base < c.sesiones; base += c.intercaladas) {
    for (let turno = 0; turno < c.turnos; turno++) {
      for (let s = base; s < Math.min(c.sesiones, base + c.intercaladas); s++) await una(layer, `s${s}`, turno);
    }
  }
  return f.cuenta;
}

/** Cada sesión con su system propio; cada turno, una pregunta suelta (sin historial). */
const sesionesConSystemPropio = (c: Carga): Promise<Cuenta> =>
  correr(c, async (layer, id, turno) => {
    await layer.generate({
      model: MODELO,
      messages: [
        { role: "system", content: DOCUMENTO(id) },
        { role: "user", content: `Question ${turno + 1} about contract ${id}: what happens with item ${turno + 3}?` },
      ],
    } as SavingsRequest);
  });

/** Un system común y un historial por sesión que crece en cada turno. */
const PEGADO = "Background paragraph the user pasted. ".repeat(60);
const chatsConHistorial = (c: Carga): Promise<Cuenta> => {
  const historiales = new Map<string, ChatMessage[]>();
  return correr(c, async (layer, id, turno) => {
    const h = historiales.get(id) ?? [];
    const q: ChatMessage = { role: "user", content: `Question ${turno + 1} of chat ${id}: ${PEGADO} what happens with item ${turno + 3}?` };
    const r = await layer.generate({ model: MODELO, messages: [{ role: "system", content: DOCUMENTO("comun") }, ...h, q] } as SavingsRequest);
    historiales.set(id, [...h, q, { role: "assistant", content: `${r.text} Answer ${turno + 1} for chat ${id}.` }]);
  });
};

const resumen = (c: Cuenta): { marcadas: number; escritos: number; leidos: number; coste: number } => ({
  marcadas: c.marcadas,
  escritos: c.escritos,
  leidos: c.leidos,
  coste: Math.round(coste(c)),
});

type Fijo = readonly [sesiones: number, turnos: number, intercaladas: number, modo: Carga["modo"], main: ReturnType<typeof resumen>];
const carga = ([sesiones, turnos, intercaladas, modo]: Fijo): Carga => ({ sesiones, turnos, intercaladas, modo });
const nombre = ([s, n, k, modo]: Fijo): string => `${s} sesiones × ${n} turnos, ${k} intercaladas (${modo})`;

describe("muchas sesiones a la vez, cada una con su system estable propio: la rama no cuesta más que main", () => {
  // Cifras de main (20a36791). En main todas las peticiones se marcan: una
  // escritura por sesión y una lectura por cada turno siguiente.
  const MAIN: Fijo[] = [
    [60, 2, 1, "defecto", { marcadas: 120, escritos: 107320, leidos: 107320, coste: 147522 }],
    [60, 2, 10, "defecto", { marcadas: 120, escritos: 107320, leidos: 107320, coste: 147522 }],
    [60, 3, 10, "defecto", { marcadas: 180, escritos: 107320, leidos: 214640, coste: 159574 }],
    [60, 5, 10, "defecto", { marcadas: 300, escritos: 107320, leidos: 429280, coste: 183678 }],
    [60, 2, 10, "auto", { marcadas: 120, escritos: 107320, leidos: 107320, coste: 147522 }],
    [60, 3, 10, "auto", { marcadas: 180, escritos: 107320, leidos: 214640, coste: 159574 }],
    // El caso del bloqueante: con la primera versión de #611 la clase se
    // apagaba a mitad de carga (226 marcadas de 400 en la carga del revisor) y
    // la factura quedaba POR ENCIMA de no llevar capa (+5,4 %).
    [200, 2, 20, "defecto", { marcadas: 400, escritos: 360200, leidos: 360200, coste: 495270 }],
    [300, 3, 50, "defecto", { marcadas: 900, escritos: 541400, leidos: 1082800, coste: 805430 }],
    [300, 4, 50, "auto", { marcadas: 1200, escritos: 541400, leidos: 1624200, coste: 866370 }],
  ];

  it.each(MAIN.map((f) => [nombre(f), f] as const))("%s", async (_n, fijo) => {
    const main = fijo[4];
    const c = await sesionesConSystemPropio(carga(fijo));
    // Lo que no puede pasar: pagar más que main.
    expect(Math.round(coste(c))).toBeLessThanOrEqual(main.coste);
    // Ni, por supuesto, más que sin capa.
    expect(coste(c)).toBeLessThan(sinCapa(c));
    // Y hoy es EXACTAMENTE lo de main: un system estable y sin fecha no pasa
    // por la clase. Si esto cambia a mejor, se actualiza la cifra a conciencia.
    expect(resumen(c)).toEqual(main);
    expect(c.marcadas).toBe(c.llamadas);
  });
});

describe("muchos chats a la vez con un system común y su propio historial: la rama no cuesta más que main", () => {
  // Aquí el prefijo SÍ incluye historial y la clase se le pasa a la verja; la
  // clase lee (cada turno lee lo que escribió el anterior), así que no se apaga.
  const MAIN: Fijo[] = [
    [150, 6, 50, "defecto", { marcadas: 900, escritos: 457602, leidos: 2467318, coste: 1441824 }],
    [150, 6, 50, "auto", { marcadas: 900, escritos: 546252, leidos: 2959206, coste: 1021288 }],
    [150, 3, 50, "defecto", { marcadas: 450, escritos: 184122, leidos: 822568, coste: 669549 }],
  ];

  it.each(MAIN.map((f) => [nombre(f), f] as const))("%s", async (_n, fijo) => {
    const main = fijo[4];
    const c = await chatsConHistorial(carga(fijo));
    expect(Math.round(coste(c))).toBeLessThanOrEqual(main.coste);
    expect(coste(c)).toBeLessThan(sinCapa(c));
    expect(resumen(c)).toEqual(main);
  });
});

describe("y el caso de la hora sigue acotado aunque antes haya mucho tráfico estable", () => {
  // it.skip: regla apagada hasta la 1.2.5 (`VERJA_DE_CABECERAS_ACTIVA = false` en
  // src/economics/prefix-cache-gate.ts). Fija la regla encendida; vuelve con ella.
  it.skip("600 peticiones con la hora en el system tras 200 sesiones de system estable: la clase se vuelve volátil igual", async () => {
    const reloj = relojSimulado();
    const f = anthropicFalso(reloj.now);
    const layer = capa(f.fetchImpl, { silenceWarnings: true, now: reloj.now });
    // 200 sesiones × 2 turnos de system estable propio: todas marcadas.
    for (let s = 0; s < 200; s++) {
      for (let turno = 0; turno < 2; turno++) {
        await layer.generate({
          model: MODELO,
          messages: [
            { role: "system", content: DOCUMENTO(`previa-${s}`) },
            { role: "user", content: `Question ${turno + 1}: what happens with item ${turno + 3}?` },
          ],
        } as SavingsRequest);
        reloj.pasar(1000);
      }
    }
    expect(f.cuenta.marcadas).toBe(400);
    const antes = f.cuenta.marcas.length;
    for (let i = 0; i < 600; i++) {
      await layer.generate(peticion(`${CABEZA}\nGenerated at ${new Date(reloj.now()).toISOString()}.\n${REGLAS}`, i));
      reloj.pasar(2000);
    }
    const marcas = f.cuenta.marcas.slice(antes);
    // Hasta que 32 cabeceras con hora han caducado sin volver (las 200 sesiones
    // estables aún pesan en la memoria de la clase) se marca como la 1.2.3.
    expect(marcas.slice(0, 150)).toEqual(Array(150).fill(true));
    expect(marcas.slice(200)).toEqual(Array(400).fill(false));
  });

  // it.skip: regla apagada hasta la 1.2.5 (`VERJA_DE_CABECERAS_ACTIVA = false` en
  // src/economics/prefix-cache-gate.ts). Fija la regla encendida; vuelve con ella.
  it.skip("sesiones cuyo system propio lleva además la hora de cada petición (600 sesiones × 2, 1 s): ninguna lectura posible y deja de marcarlas", async () => {
    const reloj = relojSimulado();
    const f = anthropicFalso(reloj.now);
    const layer = capa(f.fetchImpl, { silenceWarnings: true, now: reloj.now });
    for (let turno = 0; turno < 2; turno++) {
      for (let s = 0; s < 600; s++) {
        const system = DOCUMENTO(`con-hora-${s}`).replace("\n", `\nGenerated at ${new Date(reloj.now()).toISOString()}.\n`);
        await layer.generate({
          model: MODELO,
          messages: [
            { role: "system", content: system },
            { role: "user", content: `Question ${turno + 1}: what happens with item ${turno + 3}?` },
          ],
        } as SavingsRequest);
        reloj.pasar(1000);
      }
    }
    expect(f.cuenta.llamadas).toBe(1200);
    expect(f.cuenta.leidos).toBe(0);
    // 5 min a 1 s: 300 hasta la primera madura, 16 maduras y volátil. Antes: 1.200 de 1.200.
    expect(f.cuenta.marcas.slice(0, 300)).toEqual(Array(300).fill(true));
    expect(f.cuenta.marcadas).toBe(315);
  });
});

/**
 * REVISIÓN FINAL DE LA 1.2.4 (bloqueante): conversaciones que EMPIEZAN A LA VEZ en
 * un proceso recién arrancado, con un system por debajo del mínimo cacheable y
 * turnos largos. Con la clase de la verja aplicada también a los prefijos con
 * historial, las 8 primeras muestras de la clase eran primeros turnos de 8
 * conversaciones distintas (solo escriben), la clase se apagaba y no volvía a
 * leer: 20 chats × 20 turnos pasaban de −69,0 % (1.2.3) a +0,3 %. Ahora la clase
 * solo se usa cuando el system lleva contenido por petición detectado, y un
 * prefijo con historial decide como en la 1.2.3.
 */
describe("chats que empiezan a la vez con un system corto y turnos largos: siguen ahorrando como en la 1.2.3", () => {
  const CORTO = "You are a support assistant for an invented shop. Be brief.";
  const LARGO = (x: string): string => `Pasted background ${x}. `.repeat(120);
  const enFrio = async (chats: number, turnos: number): Promise<Cuenta> => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl, { silenceWarnings: true });
    const historiales = new Map<string, ChatMessage[]>();
    for (let t = 0; t < turnos; t++) {
      for (let c = 0; c < chats; c++) {
        const id = `frio-${chats}-${turnos}-${c}`;
        const h = historiales.get(id) ?? [];
        const q: ChatMessage = { role: "user", content: `Turn ${t + 1} of chat ${id}: ${LARGO(`${id}-${t}`)} what about order ${t}?` };
        const r = await layer.generate({ model: MODELO, messages: [{ role: "system", content: CORTO }, ...h, q] } as SavingsRequest);
        historiales.set(id, [...h, q, { role: "assistant", content: `${r.text} Answer ${t + 1} for chat ${id}.` }]);
      }
    }
    return f.cuenta;
  };

  it.each([
    [8, 8],
    [20, 8],
    [20, 20],
  ] as const)("%i chats × %i turnos a la vez: leen de la caché y la entrada cuesta mucho menos que sin capa", async (chats, turnos) => {
    const c = await enFrio(chats, turnos);
    // Cada turno a partir del segundo lee lo que escribió el anterior.
    expect(c.leidos).toBeGreaterThan(c.escritos);
    // Con el fallo, la entrada costaba lo mismo o más que sin capa.
    expect(coste(c)).toBeLessThan(0.7 * sinCapa(c));
  });
});

/**
 * LA 1.2.4 NO CUESTA MÁS QUE LA 1.2.3 (verificación 2).
 *
 * La regla «no marcar una cabecera nunca vista en una clase volátil» salía más
 * cara que la 1.2.3 en tráfico normal: llamadas auxiliares diminutas con la hora
 * junto a chats con su system propio, y ráfagas de sesiones tras un rato de
 * preguntas sueltas (la clase se volvía volátil y el primer turno de cada sesión
 * dejaba de escribirse, así que el segundo no tenía nada que leer). Además
 * rompía `savings.cachePrefix` a los 5 minutos. En la 1.2.4 está apagada
 * (`VERJA_DE_CABECERAS_ACTIVA = false`) y la verja decide como la 1.2.3.
 *
 * Las cifras de MAIN están medidas con este mismo fichero copiado a main
 * (20a36791, la 1.2.3) y se quedan fijas: la release no puede costar más.
 */
const MAIN_NOCHE = { marcadas: 170, escritos: 222950, leidos: 318500, coste: 314368 };
const MAIN_AUXILIARES = { marcadas: 920, escritos: 190260, leidos: 190260, coste: 347131 };
const MAIN_CACHE_PREFIX = { marcadas: 600, escritos: 3174, leidos: 1901226, coste: 220846 };
const MAIN_HORA_ISO = { marcadas: 600, escritos: 1908600, leidos: 0, coste: 2406651 };

describe("1.2.4 con la regla de la clase volátil apagada: nada cuesta más que la 1.2.3", () => {
  /** Planificador en tiempo simulado: cada evento a su instante (ms desde el inicio), en orden. */
  async function planificar(reloj: { now: () => number; pasar: (ms: number) => void }, eventos: { t: number; f: () => Promise<unknown> }[]): Promise<void> {
    const t0 = reloj.now();
    const orden = eventos.map((e, n) => ({ ...e, n })).sort((a, b) => a.t - b.t || a.n - b.n);
    for (const e of orden) {
      if (t0 + e.t > reloj.now()) reloj.pasar(t0 + e.t - reloj.now());
      await e.f();
    }
  }
  const ISO = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

  it("noche de 20 sesiones sueltas + 50 chats × 3 leen desde la ronda 2", async () => {
    // Noche: 20 sesiones de una sola pregunta, una por minuto, cada una con su
    // system (nunca vuelven); 10 min de silencio; mañana: 50 sesiones nuevas de
    // 3 preguntas, intercaladas a 1 s. Con la regla encendida la clase era
    // volátil al llegar la mañana: la ronda 1 no se marcaba y la 2 escribía en
    // vez de leer (medido con un proveedor falso: −35,8 % en la 1.2.3, −13,6 %).
    const reloj = relojSimulado();
    const f = anthropicFalso(reloj.now);
    const layer = capa(f.fetchImpl, { silenceWarnings: true, now: reloj.now });
    const sistema = (s: string): string => `Session ${UUID_V4(`sesion-${s}`)}.\n${ESTABLE}`;
    for (let s = 0; s < 20; s++) {
      await layer.generate(peticion(sistema(`noche-${s}`), s));
      reloj.pasar(60_000);
    }
    reloj.pasar(10 * 60_000);
    const leen: boolean[][] = [[], [], []];
    for (let ronda = 0; ronda < 3; ronda++) {
      for (let s = 0; s < 50; s++) {
        const antes = f.cuenta.leidos;
        await layer.generate({
          model: MODELO,
          messages: [
            { role: "system", content: sistema(`manana-${s}`) },
            { role: "user", content: `Question ${ronda + 1} of session ${s}: what happens with item ${ronda + 3}?` },
          ],
        } as SavingsRequest);
        leen[ronda]!.push(f.cuenta.leidos > antes);
        reloj.pasar(1000);
      }
    }
    expect(f.cuenta.marcadas).toBe(170);
    expect(leen[1]).toEqual(Array(50).fill(true));
    expect(leen[2]).toEqual(Array(50).fill(true));
    expect(Math.round(coste(f.cuenta))).toBeLessThanOrEqual(MAIN_NOCHE.coste);
    expect(resumen(f.cuenta)).toEqual(MAIN_NOCHE);
  });

  it("llamadas auxiliares diminutas con la hora + chats de 2 turnos: no cuestan más que la 1.2.3", async () => {
    // En el mismo modelo, una llamada auxiliar cada 1,5 s con la hora en un
    // system por debajo del mínimo cacheable (no cuesta nada de caché) y un chat
    // nuevo cada 20 s con el system propio de su cliente, 2 turnos a 40 s. Con la
    // regla encendida las auxiliares maduraban «de un solo uso», la clase se
    // volvía volátil y el primer turno de cada chat dejaba de escribirse:
    // −9,8 % en la 1.2.3, +2,4 % (más caro que sin capa).
    const reloj = relojSimulado();
    const f = anthropicFalso(reloj.now);
    const layer = capa(f.fetchImpl, { silenceWarnings: true, now: reloj.now });
    const inicio = reloj.now();
    const eventos: { t: number; f: () => Promise<unknown> }[] = [];
    const MIN = 20 * 60_000;
    for (let t = 0, i = 0; t < MIN; t += 1500, i++) {
      eventos.push({
        t,
        f: () =>
          layer.generate({
            model: MODELO,
            messages: [
              { role: "system", content: `Now: ${ISO(inicio + t)}. Classify the user's message into one word.` },
              { role: "user", content: `Classify message ${i}: where is my order ${i}?` },
            ],
          } as SavingsRequest),
      });
    }
    const historiales = new Map<number, ChatMessage[]>();
    const perfil = (c: number): string => `You are the personal assistant of customer ${UUID_V4(`cliente-${c}`)}.\n${REGLAS}`;
    for (let t = 0, c = 0; t < MIN; t += 20_000, c++) {
      for (let k = 0; k < 2; k++) {
        const chat = c;
        const turno = k;
        eventos.push({
          t: t + turno * 40_000 + 1,
          f: async () => {
            const h = historiales.get(chat) ?? [];
            const q: ChatMessage = { role: "user", content: `Turn ${turno + 1} of chat ${chat}: ${"Pasted background. ".repeat(60)} what about order ${turno}?` };
            const r = await layer.generate({ model: MODELO, messages: [{ role: "system", content: perfil(chat) }, ...h, q] } as SavingsRequest);
            historiales.set(chat, [...h, q, { role: "assistant", content: r.text }]);
          },
        });
      }
    }
    await planificar(reloj, eventos);
    expect(f.cuenta.llamadas).toBe(800 + 120);
    expect(coste(f.cuenta)).toBeLessThan(sinCapa(f.cuenta));
    expect(Math.round(coste(f.cuenta))).toBeLessThanOrEqual(MAIN_AUXILIARES.coste);
    expect(resumen(f.cuenta)).toEqual(MAIN_AUXILIARES);
  });

  it("savings.cachePrefix: true con la hora ISO en línea propia sigue dando el descuento con un reloj que avanza más de 5 minutos", async () => {
    // 600 peticiones a 2 s (20 minutos). Con la regla encendida la cabecera
    // entera (con la línea de la hora) estrenaba huella en cada petición, la
    // clase se volvía volátil a los 5 minutos y la parte estable dejaba de
    // marcarse: −75,3 % en la 1.2.3, −20,6 % (y −6,8 % en una hora).
    const reloj = relojSimulado();
    const f = anthropicFalso(reloj.now);
    const layer = capa(f.fetchImpl, { silenceWarnings: true, now: reloj.now });
    const leen: boolean[] = [];
    for (let i = 0; i < 600; i++) {
      const antes = f.cuenta.leidos;
      await layer.generate(peticion(`${CABEZA}\nGenerated at ${new Date(reloj.now()).toISOString()}.\n${REGLAS}`, i, { cachePrefix: true }));
      leen.push(f.cuenta.leidos > antes);
      reloj.pasar(2000);
    }
    expect(f.cuenta.marcadas).toBe(600);
    expect(leen.slice(1)).toEqual(Array(599).fill(true));
    expect(coste(f.cuenta) / sinCapa(f.cuenta)).toBeLessThan(0.3);
    expect(resumen(f.cuenta)).toEqual(MAIN_CACHE_PREFIX);
  });

  it("un system estable y otro con la hora, del mismo modelo: los dos se marcan como en la 1.2.3 y el estable lee", async () => {
    const reloj = relojSimulado();
    const f = anthropicFalso(reloj.now);
    const layer = capa(f.fetchImpl, { silenceWarnings: true, now: reloj.now });
    for (let i = 0; i < 300; i++) {
      await layer.generate(peticion(ESTABLE, i));
      reloj.pasar(1000);
      await layer.generate(peticion(`${CABEZA}\nGenerated at ${new Date(reloj.now()).toISOString()}.\n${REGLAS}`, i));
      reloj.pasar(1000);
    }
    expect(f.cuenta.marcas).toEqual(Array(600).fill(true));
    expect(f.cuenta.leidos).toBeGreaterThan(299 * 3000);
  });

  it("la hora ISO con segundos, 2 s entre peticiones: se marca como la 1.2.3 (600 de 600; la mejora vuelve en la 1.2.5)", async () => {
    const c = await sueltas(600, 2000, (t) => `Now: ${new Date(t).toISOString()}`);
    expect(c.marcadas).toBe(600);
    expect(resumen(c)).toEqual(MAIN_HORA_ISO);
  });
});
