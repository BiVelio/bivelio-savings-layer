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
 * Con un `system` que lleva algo distinto en cada petición (fecha y hora, UUID,
 * epoch), la 1.2.3 ponía `cache_control` en TODAS las peticiones de Anthropic y
 * pagaba la prima de escritura (1,25×) sin leer nunca: 60 de 60 marcadas,
 * +21,6 % de factura frente a no llevar capa. La exploración «acotada a 8» se
 * contaba por la huella del prefijo, que lleva su texto y por tanto era nueva en
 * cada petición: la traza decía «exploring the prefix cache (0/8)» en la 1 y en
 * la 60.
 *
 * Aquí se fija, en el camino real (el adaptador de Anthropic de verdad contra
 * una API falsa EN PROCESO que simula su caché: solo cachea donde hay
 * `cache_control`, lee el prefijo más largo ya escrito, mínimo 1.024 tokens):
 *
 *   1. que ese caso marca 8 y no 60, y lo que cuesta de más;
 *   2. que NADA de lo que ya ahorraba cambia: system estable, `cachePrefix`,
 *      conversación con historial, streaming y `cacheBreakpoints: "auto"`.
 *
 * Ningún byte sale del proceso: `fetchImpl` es una función local.
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

/** API de Mensajes falsa con la caché de prompt de Anthropic (reglas públicas). */
function anthropicFalso(): { fetchImpl: typeof fetch; cuenta: Cuenta } {
  const cache = new Set<string>();
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
/** La hora en la MISMA línea que todo lo demás (un system de una sola línea). */
const CON_HORA_EN_LINEA = (i: number): string => `Current time: ${hora(i)}. ${ESTABLE.replace(/\n/g, " ")}`;

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

describe("system con la fecha y la hora de cada petición (el caso que subía la factura)", () => {
  it("de 60 peticiones se marcan 8, no 60, y el sobrecoste es el de esa exploración", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    const razones: string[] = [];
    for (let i = 0; i < 60; i++) {
      const r = await layer.generate(peticion(CON_HORA(i), i));
      const t = r.report.traces.find((x) => x.stage === "prefix-cache" && x.outcome !== "measured");
      razones.push(String(t?.detail?.["reason"]));
    }
    expect(f.cuenta.llamadas).toBe(60);
    // Antes: 60 de 60.
    expect(f.cuenta.marcadas).toBe(8);
    expect(f.cuenta.marcas.slice(0, 8)).toEqual(Array(8).fill(true));
    expect(f.cuenta.marcas.slice(8)).toEqual(Array(52).fill(false));
    expect(f.cuenta.leidos).toBe(0);
    // La exploración AVANZA: antes decía «(0/8)» en la petición 1 y en la 60.
    expect(razones[0]).toMatch(/exploring the prefix cache \(0\/8\)/);
    expect(razones[59]).toMatch(/marking OFF for prefixes not seen before/);
    // El dinero: antes +21,6 %; ahora la prima de 8 escrituras repartida en 60
    // peticiones (≈ +2,9 %), y de ahí en adelante 0.
    const sobrecoste = coste(f.cuenta) / sinCapa(f.cuenta) - 1;
    expect(sobrecoste).toBeGreaterThan(0);
    expect(sobrecoste).toBeLessThan(0.035);
    // Y el recibo de la capa dice lo mismo que el contador del proveedor.
    const ultima = await layer.generate(peticion(CON_HORA(60), 60));
    expect(ultima.report.cost.actual).toBeCloseTo(ultima.report.cost.baselineEstimate, 9);
  });

  it("a la larga el sobrecoste tiende a cero: 600 peticiones, 32 marcadas", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl, { silenceWarnings: true });
    for (let i = 0; i < 600; i++) await layer.generate(peticion(CON_HORA(i), i));
    // 8 de exploración + reintentos tras 64, 128 y 256 peticiones sin marcar.
    expect(f.cuenta.marcadas).toBe(32);
    expect(coste(f.cuenta) / sinCapa(f.cuenta) - 1).toBeLessThan(0.014);
  });

  it("también en streaming", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    for (let i = 0; i < 60; i++) await layer.generateStream(peticion(CON_HORA(i), i)).result;
    expect(f.cuenta.llamadas).toBe(60);
    expect(f.cuenta.marcadas).toBe(8);
  });

  it('también con cacheBreakpoints: "auto"', async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl, { cacheBreakpoints: "auto" });
    for (let i = 0; i < 60; i++) await layer.generate(peticion(CON_HORA(i), i));
    expect(f.cuenta.marcadas).toBe(8);
  });

  it("el aviso dice lo que pasa ahora y nombra savings.cachePrefix", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    for (let i = 0; i < 3; i++) await layer.generate(peticion(CON_HORA(i), i));
    const delAudit = avisos.filter((a) => a.includes("per-request content"));
    expect(delAudit).toHaveLength(1);
    expect(delAudit[0]).toContain("iso-timestamp");
    expect(delAudit[0]).toContain("stops marking that prefix");
    expect(delAudit[0]).toContain("savings.cachePrefix: true");
    // Ya no es verdad que «las lecturas se facturan como escrituras» para siempre.
    expect(delAudit[0]).not.toContain("billing as full writes");
  });

  it("savings.cachePrefix: true lo arregla cuando la hora va en una línea propia: 60 marcadas, 59 lecturas", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    for (let i = 0; i < 60; i++) await layer.generate(peticion(CON_HORA(i), i, { cachePrefix: true }));
    expect(f.cuenta.marcadas).toBe(60);
    expect(f.cuenta.leidos).toBeGreaterThan(59 * 3000);
    expect(coste(f.cuenta) / sinCapa(f.cuenta)).toBeLessThan(0.3);
  });

  it("LÍMITE CONOCIDO: con la hora en la misma línea que el resto, cachePrefix no tiene nada estable que separar; ya no sube la factura, pero tampoco hay descuento", async () => {
    // `cachePrefix` mueve LÍNEAS enteras. Un system de una sola línea con la
    // hora dentro es todo él «línea mutable»: no queda prefijo estable.
    // No se arregla aquí; queda fijado para que el día que se arregle se note.
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    for (let i = 0; i < 60; i++) await layer.generate(peticion(CON_HORA_EN_LINEA(i), i, { cachePrefix: true }));
    expect(f.cuenta.leidos).toBe(0);
    expect(f.cuenta.marcadas).toBe(8);
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
    expect(avisos.filter((a) => a.includes("per-request content"))).toHaveLength(0);
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

  it("un system estable no deja de marcarse porque otro, del mismo modelo, cambie en cada petición", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    const delEstable: boolean[] = [];
    const delQueCambia: boolean[] = [];
    for (let i = 0; i < 60; i++) {
      await layer.generate(peticion(ESTABLE, i));
      delEstable.push(f.cuenta.marcas.at(-1)!);
      await layer.generate(peticion(CON_HORA(i), i));
      delQueCambia.push(f.cuenta.marcas.at(-1)!);
    }
    expect(delEstable).toEqual(Array(60).fill(true));
    // Como mucho la exploración (aquí 6: las dos primeras muestras de la clase
    // son la escritura y la lectura del estable).
    expect(delQueCambia.filter(Boolean).length).toBeGreaterThan(0);
    expect(delQueCambia.filter(Boolean).length).toBeLessThanOrEqual(8);
    expect(delQueCambia.slice(8)).toEqual(Array(52).fill(false));
  });

  it("un system estable que llega DESPUÉS de apagarse la clase se marca desde su PRIMERA petición, como en main", async () => {
    // Antes de la revisión de #611 este test esperaba [false, true × 19]: la
    // clase apagada por el system con hora frenaba también la primera petición
    // del estable («se pierde una lectura, una vez»). Con una sola app era poco;
    // con muchas sesiones, cada una con su system estable propio, esa primera
    // petición sin marcar es la ESCRITURA que la segunda iba a leer, y la
    // factura subía (ver «muchas sesiones a la vez», abajo).
    //
    // Ahora la clase solo se le pasa a la verja cuando el prefijo incluye
    // historial o cuando el system lleva contenido por petición DETECTADO
    // (fecha, UUID, epoch). Un system estable y sin nada de eso decide solo por
    // su huella, igual que en main: se marca desde la primera.
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    for (let i = 0; i < 20; i++) await layer.generate(peticion(CON_HORA(i), i));
    expect(f.cuenta.marcas.slice(8)).toEqual(Array(12).fill(false)); // la clase está apagada
    const antes = f.cuenta.marcas.length;
    for (let i = 0; i < 20; i++) await layer.generate(peticion(ESTABLE, i));
    const marcas = f.cuenta.marcas.slice(antes);
    expect(marcas).toEqual(Array(20).fill(true));
    // 1 escritura y 19 lecturas: no se pierde ninguna.
    expect(f.cuenta.leidos).toBeGreaterThan(19 * 3000);
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

describe("y el caso de la fecha sigue acotado con el arreglo de la revisión", () => {
  it("60 peticiones con la hora en el system: 8 marcadas, aunque antes hayan pasado 200 sesiones de system estable", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl, { silenceWarnings: true });
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
      }
    }
    expect(f.cuenta.marcadas).toBe(400);
    const antes = f.cuenta.marcas.length;
    for (let i = 0; i < 60; i++) await layer.generate(peticion(CON_HORA(i), i));
    const marcas = f.cuenta.marcas.slice(antes);
    expect(marcas.filter(Boolean)).toHaveLength(8);
    expect(marcas.slice(8)).toEqual(Array(52).fill(false));
  });

  it("sesiones cuyo system propio lleva además la hora de cada petición: 8 de exploración y un reintento, no 120", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl, { silenceWarnings: true });
    let n = 0;
    for (let turno = 0; turno < 2; turno++) {
      for (let s = 0; s < 60; s++) {
        const system = DOCUMENTO(`con-hora-${s}`).replace("\n", `\nGenerated at ${hora(n++)}.\n`);
        await layer.generate({
          model: MODELO,
          messages: [
            { role: "system", content: system },
            { role: "user", content: `Question ${turno + 1}: what happens with item ${turno + 3}?` },
          ],
        } as SavingsRequest);
      }
    }
    expect(f.cuenta.llamadas).toBe(120);
    // 8 de exploración; tras 64 sin marcar, un reintento de otras 8 (el mismo
    // ritmo que «600 peticiones, 32 marcadas», arriba). Antes: 120 de 120.
    expect(f.cuenta.marcas.slice(0, 8)).toEqual(Array(8).fill(true));
    expect(f.cuenta.marcas.slice(8, 72)).toEqual(Array(64).fill(false));
    expect(f.cuenta.marcadas).toBe(16);
    expect(f.cuenta.leidos).toBe(0);
  });
});
