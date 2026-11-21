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

  it("un system estable que llega DESPUÉS de apagarse la clase se marca desde su segunda petición", async () => {
    const f = anthropicFalso();
    const layer = capa(f.fetchImpl);
    for (let i = 0; i < 20; i++) await layer.generate(peticion(CON_HORA(i), i));
    const antes = f.cuenta.marcas.length;
    for (let i = 0; i < 20; i++) await layer.generate(peticion(ESTABLE, i));
    const marcas = f.cuenta.marcas.slice(antes);
    // Lo que se pierde frente a antes: una lectura, una vez.
    expect(marcas).toEqual([false, ...Array(19).fill(true)]);
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
