import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BETA_ESFUERZO, aplicarEsfuerzo, type Esfuerzo } from "../gateway/esfuerzo.js";
import { tareasDelAnillo1 } from "../benchmarks/anillo1/tareas.js";
import {
  BRAZOS,
  CLASES,
  MAX_TOKENS_ESFUERZO,
  UMBRALES_POR_DEFECTO,
  celda,
  construirPeticionEsfuerzo,
  costeEsperado,
  cotaSuperiorClopperPearson,
  cuerpoDeControl,
  decidir,
  diagnosticoDeColocacion,
  dictaminar,
  ejecutarTareaEsfuerzo,
  nivelesQueRebajan,
  ordenDeEjecucion,
  paresNecesarios,
  prevuelo,
  type Brazo,
  type Clase,
  type EjecucionEsfuerzo,
  type Pedir,
  type PeticionConstruida,
  type RespuestaMessages,
} from "../benchmarks/esfuerzo/nucleo.js";
import { nivelEfectivo, pasoDeCache, proveedorSimulado, unidadesDelPrompt } from "../benchmarks/esfuerzo/simulado.js";
import { TAREAS_DE_HUMO, correr, redecidir, type Artefacto } from "../benchmarks/esfuerzo/banco.js";

/**
 * EL BANCO DEL ESFUERZO — las verjas, todas SIN red.
 *
 * La palanca D lleva armada y apagada desde el 2026-09-10 porque es la única que
 * puede empeorar la respuesta y nunca se midió. Estas verjas protegen tres
 * cosas: que el brazo «dial-final» es BYTE A BYTE lo que manda el gateway (si
 * no, el banco mediría otra palanca), que el criterio no enciende nada sin la
 * muestra que lo respalda (ni sobre una tirada simulada), y que la tirada en
 * seco no toca la red ni lee una clave.
 */

const tareas = tareasDelAnillo1();
const porId = new Map(tareas.map((t) => [t.id, t]));
const aguja = porId.get("log-aguja-500")!;
const MODELO = "claude-opus-5";
const base = { tarea: aguja, sal: "t-x", modelo: MODELO, mensajes: [{ role: "user", content: aguja.enunciado }], apiKey: "k" };
const cuerpoDe = (p: PeticionConstruida) => JSON.parse(p.texto) as Record<string, unknown>;

describe("cada brazo manda lo que dice, y el de la palanca es el gateway", () => {
  it("control: sin esfuerzo, sin dial, sin beta; sal en el byte 0 y caché automática", () => {
    const p = construirPeticionEsfuerzo({ ...base, brazo: "control", nivel: null });
    const c = cuerpoDe(p);
    expect(c.output_config).toBeUndefined();
    expect((c.messages as unknown[]).length).toBe(1);
    expect(p.cabeceras["anthropic-beta"]).toBeUndefined();
    expect(String(c.system).startsWith("[medicion-fria t-x]\n")).toBe(true);
    expect(c.cache_control).toEqual({ type: "ephemeral" });
    expect(c.max_tokens).toBe(MAX_TOKENS_ESFUERZO);
  });

  it("⛔ dial-final son EXACTAMENTE los bytes del gateway (aplicarEsfuerzo) y su beta", () => {
    const p = construirPeticionEsfuerzo({ ...base, brazo: "dial-final", nivel: "low" });
    const delGateway = aplicarEsfuerzo(Buffer.from(JSON.stringify(cuerpoDeControl(base)), "utf8"), "low")!;
    expect(p.texto).toBe(delGateway.cuerpo.toString("utf8"));
    expect(p.cabeceras["anthropic-beta"]).toBe(BETA_ESFUERZO);
    const msgs = cuerpoDe(p).messages as unknown[];
    expect(msgs.at(-1)).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
  });

  it("dial-inicial: el dial PRIMERO y el resto intacto; raíz: output_config sin beta", () => {
    const ini = cuerpoDe(construirPeticionEsfuerzo({ ...base, brazo: "dial-inicial", nivel: "medium" }));
    expect((ini.messages as unknown[])[0]).toEqual({ role: "system", content: [], output_config: { effort: "medium" } });
    expect((ini.messages as unknown[]).slice(1)).toEqual(base.mensajes);
    const raiz = construirPeticionEsfuerzo({ ...base, brazo: "raiz", nivel: "low" });
    expect(cuerpoDe(raiz).output_config).toEqual({ effort: "low" });
    expect(cuerpoDe(raiz).messages).toEqual(base.mensajes);
    expect(raiz.cabeceras["anthropic-beta"]).toBeUndefined();
  });

  it("todos comparten modelo, techo, system, herramientas y caché: solo cambia el esfuerzo", () => {
    const comunes = (b: Brazo) => {
      const { messages: _m, output_config: _o, ...resto } = cuerpoDe(
        construirPeticionEsfuerzo({ ...base, brazo: b, nivel: b === "control" ? null : "low" }),
      );
      return resto;
    };
    for (const b of BRAZOS) expect(comunes(b)).toEqual(comunes("control"));
  });

  it("⛔ un nivel que no rebaja el defecto, o un modelo sin la palanca, no se construye", () => {
    expect(() => construirPeticionEsfuerzo({ ...base, brazo: "dial-final", nivel: "high" })).toThrow(/does not lower/);
    expect(() => construirPeticionEsfuerzo({ ...base, modelo: "claude-opus-5-5", brazo: "raiz", nivel: "medium" })).toThrow(/does not lower/);
    expect(() => construirPeticionEsfuerzo({ ...base, modelo: "claude-fable-5", brazo: "dial-final", nivel: "low" })).toThrow();
    expect(() => construirPeticionEsfuerzo({ ...base, brazo: "raiz", nivel: null })).toThrow(/needs an effort level/);
  });
});

/** Un agente de guion que RESUELVE log-aguja-500 leyendo lo que devuelven las herramientas. */
function agenteQueResuelve(capturadas: PeticionConstruida[], opts: { thinking?: number; truncar?: boolean } = {}): Pedir {
  return async (p) => {
    capturadas.push(p);
    const msgs = cuerpoDe(p).messages as { role: string; content: unknown }[];
    const turno = msgs.filter((m) => m.role === "assistant").length;
    const usage = { input_tokens: 1000, output_tokens: 300, output_tokens_details: { thinking_tokens: opts.thinking ?? 120 } };
    if (opts.truncar) return { content: [{ type: "text", text: "a medias" }], stop_reason: "max_tokens", usage };
    if (turno === 0) {
      return { content: [{ type: "thinking" }, { type: "tool_use", id: "t0", name: "buscar", input: { patron: "status=500" } }], stop_reason: "tool_use", usage };
    }
    const ultimoUsuario = [...msgs].reverse().find((m) => m.role === "user")!;
    const texto = JSON.stringify(ultimoUsuario.content);
    const rid = /rid=(req_[0-9a-f]{8}) status=500/.exec(texto)?.[1] ?? "nada";
    return { content: [{ type: "tool_use", id: "t1", name: "entregar", input: { respuesta: rid } }], stop_reason: "tool_use", usage };
  };
}

describe("el bucle: fiel al cliente, tarifado con el medidor de producción", () => {
  it("resuelve con la verificación del anillo 1 y suma tokens, dinero y pensamiento", async () => {
    const capturadas: PeticionConstruida[] = [];
    const e = await ejecutarTareaEsfuerzo({ ...base, brazo: "control", nivel: null, rep: 0, pedir: agenteQueResuelve(capturadas) });
    expect(e.exito).toBe(true);
    expect(e.turnos).toBe(2);
    expect(e.tokens.salida).toBe(600);
    expect(e.thinkingTokens).toBe(240);
    expect(e.bloquesThinking).toBe(1);
    // Opus 5: 25 $/M de salida → 600 tokens = 0,015 $.
    expect(e.costeSalidaUsd).toBeCloseTo(0.015, 10);
    expect(e.costeTotalUsd).toBeGreaterThan(e.costeSalidaUsd);
  });

  it("⛔ el historial es el del CLIENTE: el dial va en cada petición y nunca queda en la siguiente", async () => {
    const capturadas: PeticionConstruida[] = [];
    await ejecutarTareaEsfuerzo({ ...base, brazo: "dial-final", nivel: "low", rep: 0, pedir: agenteQueResuelve(capturadas) });
    expect(capturadas).toHaveLength(2);
    const [m0, m1] = capturadas.map((p) => cuerpoDe(p).messages as unknown[]);
    expect(m0!.at(-1)).toMatchObject({ role: "system", output_config: { effort: "low" } });
    expect(m1!.at(-1)).toMatchObject({ role: "system", output_config: { effort: "low" } });
    // Lo que el cliente mandó en el turno 0 (sin el dial) es prefijo del turno 1.
    expect(m1!.slice(0, m0!.length - 1)).toEqual(m0!.slice(0, -1));
    expect(m1!.filter((m) => (m as { output_config?: unknown }).output_config !== undefined)).toHaveLength(1);
  });

  it("un turno cortado por max_tokens se cuenta como truncado y la tarea no se entrega", async () => {
    const e = await ejecutarTareaEsfuerzo({ ...base, brazo: "control", nivel: null, rep: 0, pedir: agenteQueResuelve([], { truncar: true }) });
    expect(e.truncados).toBe(1);
    expect(e.entregado).toBe(false);
    expect(e.exito).toBe(false);
  });

  it("un error del proveedor revienta la ejecución (el arnés la marca y la saca de la verja)", async () => {
    const pedir: Pedir = async () => ({ error: { type: "invalid_request_error", message: "nope" } });
    await expect(ejecutarTareaEsfuerzo({ ...base, brazo: "control", nivel: null, rep: 0, pedir })).rejects.toThrow(/API: invalid_request_error/);
  });
});

describe("el proveedor simulado rechaza lo que la API rechaza y emula la caché documentada", () => {
  it("⛔ un dial sin su beta, o en un modelo sin esfuerzo por turno, es un 400", async () => {
    const sim = proveedorSimulado({ dialFinalRige: true });
    const p = construirPeticionEsfuerzo({ ...base, brazo: "dial-final", nivel: "low" });
    const sinBeta = await sim({ ...p, cabeceras: { ...p.cabeceras, "anthropic-beta": "" } });
    expect(sinBeta.error?.message).toContain(BETA_ESFUERZO);
    const otroModelo = await sim({ ...p, texto: p.texto.replace(`"${MODELO}"`, '"claude-fable-5"') });
    expect(otroModelo.error?.message).toContain("per-turn effort");
    expect((await sim(p)).error).toBeUndefined();
  });

  it("el nivel efectivo: raíz o defecto, un dial ANTES del último usuario rige, uno DETRÁS solo si se declara", () => {
    const dial = (n: Esfuerzo) => ({ role: "system", content: [], output_config: { effort: n } });
    const u = { role: "user", content: "x" };
    expect(nivelEfectivo({ model: MODELO, messages: [u] }, true)).toBe("high");
    expect(nivelEfectivo({ model: "claude-opus-5-5", messages: [u] }, true)).toBe("medium");
    expect(nivelEfectivo({ model: MODELO, output_config: { effort: "low" }, messages: [u] }, false)).toBe("low");
    expect(nivelEfectivo({ model: MODELO, messages: [dial("low"), u] }, false)).toBe("low");
    expect(nivelEfectivo({ model: MODELO, messages: [u, dial("low")] }, false)).toBe("high");
    expect(nivelEfectivo({ model: MODELO, messages: [u, dial("low")] }, true)).toBe("low");
  });

  it("un dial DETRÁS del punto de ruptura no toca el prefijo; uno delante del último usuario lo rompe; la raíz cambiada, entera", () => {
    const u0 = { role: "user", content: "a".repeat(4000) };
    const a0 = { role: "assistant", content: [{ type: "text", text: "b".repeat(4000) }] };
    const u1 = { role: "user", content: "c".repeat(400) };
    const dial = { role: "system", content: [], output_config: { effort: "low" } };
    const sys = { model: MODELO, system: "s".repeat(2000), tools: [] };
    // Turno 0 y turno 1 con el dial al FINAL: el turno 1 lee todo el turno 0.
    const e0 = pasoDeCache([], unidadesDelPrompt({ ...sys, messages: [u0, dial] }));
    const e1 = pasoDeCache([e0.entrada], unidadesDelPrompt({ ...sys, messages: [u0, a0, u1, dial] }));
    expect(e1.leidos).toBe(e0.escritos);
    // Con el dial DELANTE del último usuario, el prefijo del turno 0 no casa entero.
    const f0 = pasoDeCache([], unidadesDelPrompt({ ...sys, messages: [dial, u0] }));
    const f1 = pasoDeCache([f0.entrada], unidadesDelPrompt({ ...sys, messages: [u0, a0, dial, u1] }));
    expect(f1.leidos).toBeLessThan(f0.escritos);
    // Cambiar la raíz entre turnos no lee nada: «changing it between requests invalidates cache breakpoints».
    const r1 = pasoDeCache([e0.entrada], unidadesDelPrompt({ ...sys, output_config: { effort: "low" }, messages: [u0, a0, u1] }));
    expect(r1.leidos).toBe(0);
  });
});

describe("estadística: la cota de pérdidas no se deja engañar por muestras pequeñas", () => {
  it("Clopper-Pearson unilateral: 0/n = 1 − 0,05^(1/n); 1/20 = 0,2161; x = n → 1", () => {
    expect(cotaSuperiorClopperPearson(0, 60)).toBeCloseTo(1 - Math.pow(0.05, 1 / 60), 12);
    expect(cotaSuperiorClopperPearson(1, 20)).toBeCloseTo(0.2161, 3);
    expect(cotaSuperiorClopperPearson(5, 5)).toBe(1);
    expect(cotaSuperiorClopperPearson(0, 0)).toBe(1);
    for (let x = 0; x < 10; x++) expect(cotaSuperiorClopperPearson(x + 1, 60)).toBeGreaterThan(cotaSuperiorClopperPearson(x, 60));
  });

  it("los pares necesarios cuadran con la cota: 59 al 5 %, 29 al 10 %", () => {
    expect(paresNecesarios(0.05)).toBe(59);
    expect(paresNecesarios(0.1)).toBe(29);
    expect(cotaSuperiorClopperPearson(0, 59)).toBeLessThanOrEqual(0.05);
    expect(cotaSuperiorClopperPearson(0, 58)).toBeGreaterThan(0.05);
  });
});

// ── Ejecuciones sintéticas para el criterio ──

interface Forma {
  reps: number;
  /** Factor de la salida del brazo frente a control (por tarea, con un poco de ruido). */
  salida?: number;
  /** Factor de la entrada del brazo. */
  entrada?: number;
  /** Caché leída del brazo como fracción de la de control. */
  cache?: number;
  /** ¿Pierde el brazo este par? */
  pierde?: (tarea: string, clase: Clase, rep: number) => boolean;
  truncaControl?: boolean;
  /** Control no resuelve nada (y el brazo tampoco). */
  nadieResuelve?: boolean;
  niveles?: Esfuerzo[];
}

function sinteticas(f: Forma): EjecucionEsfuerzo[] {
  const out: EjecucionEsfuerzo[] = [];
  tareas.forEach((t, i) => {
    for (let rep = 0; rep < f.reps; rep++) {
      const salidaC = 0.02 + i * 0.001 + rep * 0.0002;
      const entradaC = 0.1 + i * 0.01;
      const mk = (brazo: Brazo, nivel: Esfuerzo | null, fs: number, fe: number, fc: number, exito: boolean, trunc: number): EjecucionEsfuerzo => ({
        tarea: t.id,
        clase: t.clase,
        brazo,
        nivel,
        rep,
        exito,
        entregado: exito,
        turnos: 3,
        llamadas: 3,
        tokens: { entrada: 1000, salida: Math.round(salidaC * fs * 40_000), cacheLeida: Math.round(9000 * fc), cacheEscrita: 1000 },
        bloquesThinking: 1,
        costeSalidaUsd: salidaC * fs,
        costeTotalUsd: salidaC * fs + entradaC * fe,
        truncados: trunc,
        maxSalidaTurno: 500,
      });
      out.push(mk("control", null, 1, 1, 1, !f.nadieResuelve, f.truncaControl ? 1 : 0));
      for (const nivel of f.niveles ?? (["low"] as Esfuerzo[])) {
        const ruido = 1 + ((i * 7 + rep * 3) % 5) * 0.01;
        const exito = !f.nadieResuelve && !(f.pierde?.(t.id, t.clase, rep) ?? false);
        out.push(mk("dial-final", nivel, (f.salida ?? 0.6) * ruido, f.entrada ?? 1, f.cache ?? 1, exito, 0));
      }
    }
  });
  return out;
}

describe("el criterio para encenderla", () => {
  it("60 pares sin pérdidas, −40 % de salida, factura y caché intactas → ENCIENDE en global", () => {
    const d = decidir(sinteticas({ reps: 4 }), { simulado: false, modelo: MODELO });
    expect(d.global.nivel).toBe("low");
    expect(d.global.sueloSalidaPct!).toBeGreaterThan(30);
    expect(d.todas[0]!.dictamen.motivos).toEqual([]);
  });

  it("⛔ la misma tirada marcada SIMULADA no enciende nada", () => {
    const d = decidir(sinteticas({ reps: 4 }), { simulado: true, modelo: MODELO });
    expect(d.global.nivel).toBeNull();
    expect(d.todas[0]!.dictamen.motivos.join(" ")).toContain("simulated");
  });

  it("⛔ 30 pares perfectos no bastan al 5 % (IC [0, 0] no es evidencia); al 10 % sí", () => {
    const e = sinteticas({ reps: 2 });
    const al5 = decidir(e, { simulado: false, modelo: MODELO });
    expect(al5.global.nivel).toBeNull();
    expect(al5.todas[0]!.dictamen.motivos.join(" ")).toMatch(/upper bound of the loss rate/);
    const al10 = decidir(e, { simulado: false, modelo: MODELO, umbrales: { ...UMBRALES_POR_DEFECTO, margenCalidad: 0.1 } });
    expect(al10.global.nivel).toBe("low");
  });

  it("por clase NO enciende con la muestra que basta en global: cada clase tiene 12–20 pares", () => {
    const d = decidir(sinteticas({ reps: 4 }), { simulado: false, modelo: MODELO });
    expect(d.porClase.map((k) => k.clase)).toEqual([...CLASES]);
    for (const k of d.porClase) expect(k.nivel, k.clase).toBeNull();
  });

  it("⛔ «cero pérdidas» sobre un corpus que control no resuelve no es evidencia de nada", () => {
    const d = decidir(sinteticas({ reps: 4, nadieResuelve: true }), { simulado: false, modelo: MODELO });
    expect(d.global.nivel).toBeNull();
    expect(d.todas[0]!.celda.exito.cotaDePerdidas).toBe(1);
    expect(d.todas[0]!.dictamen.motivos.join(" ")).toContain("among the 0 pairs control solved");
  });

  it("⛔ perder éxito de tarea apaga, por mucha salida que ahorre", () => {
    const d = decidir(sinteticas({ reps: 4, salida: 0.3, pierde: (_t, _c, rep) => rep === 0 }), { simulado: false, modelo: MODELO });
    expect(d.global.nivel).toBeNull();
    expect(d.todas[0]!.dictamen.motivos.join(" ")).toContain("QUALITY");
  });

  it("⛔ sin recorte de salida no hay nada que encender", () => {
    const d = decidir(sinteticas({ reps: 4, salida: 1 }), { simulado: false, modelo: MODELO });
    expect(d.global.nivel).toBeNull();
    expect(d.todas[0]!.dictamen.motivos.join(" ")).toContain("OUTPUT");
  });

  it("⛔ si la factura TOTAL sube (más entrada), apaga aunque la salida baje", () => {
    const d = decidir(sinteticas({ reps: 4, entrada: 1.5 }), { simulado: false, modelo: MODELO });
    expect(d.todas[0]!.dictamen.motivos.join(" ")).toContain("TOTAL");
  });

  it("⛔ el peaje de caché que la palanca prometió no pagar la apaga", () => {
    const d = decidir(sinteticas({ reps: 4, cache: 0.5 }), { simulado: false, modelo: MODELO });
    expect(d.todas[0]!.dictamen.motivos.join(" ")).toContain("CACHE");
  });

  it("⛔ una respuesta truncada (aunque sea del control) anula la comparación", () => {
    const d = decidir(sinteticas({ reps: 4, truncaControl: true }), { simulado: false, modelo: MODELO });
    expect(d.todas[0]!.dictamen.motivos.join(" ")).toContain("TRUNCATED");
  });

  it("⛔ una clase dañada no se esconde en la media: global apagado aunque el conjunto pase", () => {
    // Con un margen laxo (30 %) el conjunto pasa, pero «otro» pierde la mitad de sus pares.
    const e = sinteticas({ reps: 4, pierde: (_t, clase, rep) => clase === "otro" && rep % 2 === 0 });
    const u = { ...UMBRALES_POR_DEFECTO, margenCalidad: 0.3 };
    expect(dictaminar(celda(e, "dial-final", "low", "todas"), u, false).encender).toBe(true);
    const d = decidir(e, { simulado: false, modelo: MODELO, umbrales: u });
    expect(d.global.nivel).toBeNull();
    expect(d.global.motivos.join(" ")).toContain("otro");
  });

  it("entre dos niveles que pasan, gana el de mayor suelo de salida", () => {
    const e = sinteticas({ reps: 4, niveles: ["low", "medium"] }).map((x) =>
      x.nivel === "medium" ? { ...x, costeSalidaUsd: x.costeSalidaUsd * 1.3, costeTotalUsd: x.costeTotalUsd + x.costeSalidaUsd * 0.3 } : x,
    );
    expect(decidir(e, { simulado: false, modelo: MODELO }).global.nivel).toBe("low");
  });

  it("es determinista: el orden de las ejecuciones no cambia ni un decimal", () => {
    const e = sinteticas({ reps: 3, salida: 0.7 });
    const barajadas = [...e].sort((a, b) => (a.tarea + a.rep + a.brazo).localeCompare(b.tarea + b.rep + b.brazo)).reverse();
    expect(JSON.stringify(decidir(barajadas, { simulado: false, modelo: MODELO }))).toBe(
      JSON.stringify(decidir(e, { simulado: false, modelo: MODELO })),
    );
  });
});

describe("prevuelo y plan", () => {
  it("solo se miden niveles que rebajan el defecto: low y medium en Opus 5, solo low en Opus 5.5", () => {
    expect(nivelesQueRebajan(MODELO)).toEqual(["low", "medium"]);
    expect(nivelesQueRebajan("claude-opus-5-5")).toEqual(["low"]);
  });

  it("⛔ rechaza antes de gastar: nivel que no rebaja, brazo desconocido, sin control, modelo sin la palanca", () => {
    const ok = { modelo: MODELO, brazos: ["control", "dial-final"], niveles: ["low"], reps: 1, tareas: ["log-aguja-500"] };
    expect(prevuelo(ok)).toEqual([]);
    expect(prevuelo({ ...ok, niveles: ["high"] }).join(" ")).toContain("does not lower");
    expect(prevuelo({ ...ok, brazos: ["control", "dial-medio"] }).join(" ")).toContain("unknown arms");
    expect(prevuelo({ ...ok, brazos: ["dial-final"] }).join(" ")).toContain("control");
    expect(prevuelo({ ...ok, modelo: "claude-fable-5" }).join(" ")).toContain("per-turn effort");
    expect(prevuelo({ ...ok, reps: 0 }).join(" ")).toContain("reps");
  });

  it("el orden: por tarea y rep, control primero; y el techo de salida es la cuenta dura", () => {
    const plan = { modelo: MODELO, brazos: ["control", "dial-final", "raiz"] as Brazo[], niveles: ["low", "medium"] as Esfuerzo[], reps: 2, tareas: ["log-aguja-500"], ejecuciones: 10 };
    const orden = ordenDeEjecucion(plan);
    expect(orden).toHaveLength(1 * 2 * (1 + 2 * 2));
    expect(orden[0]).toEqual({ tarea: "log-aguja-500", rep: 0, brazo: "control", nivel: null });
    const coste = costeEsperado(plan, { "log-aguja-500": 8 })!;
    // 10 ejecuciones × 8 turnos × 16.000 tokens × 25 $/M.
    expect(coste.techoSalidaUsd).toBeCloseTo(10 * 8 * 16_000 * 0.000025, 6);
    expect(coste.referenciaEntradaUsd).toBeGreaterThan(0);
  });
});

describe("la tirada EN SECO: sin red, sin clave, y nunca enciende nada", () => {
  let dir = "";
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const opciones = (extra: Partial<Parameters<typeof correr>[0]> = {}): Parameters<typeof correr>[0] => {
    dir = mkdtempSync(join(tmpdir(), "bvsala-esfuerzo-"));
    return {
      seco: true,
      humo: true,
      modelo: MODELO,
      brazos: [...BRAZOS],
      niveles: ["low", "medium"],
      reps: 4,
      tareas: [],
      umbrales: UMBRALES_POR_DEFECTO,
      outDir: dir,
      log: () => {},
      ...extra,
    };
  };

  it("recorre el mismo bucle contra el simulador, escribe el artefacto marcado y no llama a fetch", async () => {
    const espia = vi.spyOn(globalThis, "fetch");
    const { ruta, artefacto } = await correr(opciones());
    expect(espia).not.toHaveBeenCalled();
    const leido = JSON.parse(readFileSync(ruta, "utf8")) as Artefacto;
    expect(leido.simulated).toBe(true);
    expect(leido.simulatorAssumptions?.trailingDialGoverns).toBe(true);
    expect(leido.tasks).toEqual(TAREAS_DE_HUMO);
    expect(leido.runs).toHaveLength(2 * (1 + 3 * 2));
    expect(leido.runs.every((r) => r.error === undefined && r.costeTotalUsd > 0)).toBe(true);
    expect(artefacto.decision.brazo).toBe("dial-final");
    expect(artefacto.decision.global.nivel).toBeNull();
    for (const d of artefacto.decisionByArm) for (const t of d.todas) expect(t.dictamen.motivos[0]).toContain("simulated");
    // La promesa de la palanca, en la emulación documentada: ningún brazo paga peaje de caché.
    for (const d of artefacto.decisionByArm) for (const t of d.todas) expect(t.dictamen.motivos.join(" ")).not.toContain("CACHE");
  });

  it("si el dial final NO rigiera la respuesta en curso, el banco lo destapa (diagnóstico de colocación)", async () => {
    const { artefacto } = await correr(opciones({ simulador: { dialFinalRige: false } }));
    const final = artefacto.decisionByArm.find((d) => d.brazo === "dial-final")!;
    expect(final.todas[0]!.celda.tokensSalida.reduccionPct.media).toBe(0);
    expect(artefacto.placement.join(" ")).toContain("placement");
    expect(diagnosticoDeColocacion(artefacto.runs)).toEqual(artefacto.placement);
  });

  it("⛔ en vivo sin clave ni presupuesto no empieza (y no toca la red)", async () => {
    const espia = vi.spyOn(globalThis, "fetch");
    await expect(correr(opciones({ seco: false }))).rejects.toThrow(/BVSALA_ESFUERZO_BUDGET_USD/);
    await expect(correr(opciones({ seco: false, presupuestoUsd: 5 }))).rejects.toThrow(/API_KEY/);
    expect(espia).not.toHaveBeenCalled();
  });

  it("⛔ en vivo, el presupuesto aborta la tirada y el artefacto lo dice", async () => {
    const pedirEnVivo: Pedir = async (): Promise<RespuestaMessages> => ({
      content: [{ type: "tool_use", id: "t", name: "entregar", input: { respuesta: "x" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100_000, output_tokens: 1000 },
    });
    const { artefacto } = await correr(opciones({ seco: false, presupuestoUsd: 0.6, pedirEnVivo }));
    expect(artefacto.simulated).toBe(false);
    expect(artefacto.aborted).toBe(true);
    expect(artefacto.costUsd).toBeGreaterThan(0.6);
    expect(artefacto.runs.length).toBeLessThan(14);
  });

  it("--decidir recalcula exactamente la misma decisión sobre el artefacto", async () => {
    const { ruta, artefacto } = await correr(opciones());
    const otra = redecidir(ruta, UMBRALES_POR_DEFECTO, () => {});
    expect(JSON.stringify(otra)).toBe(JSON.stringify(artefacto.decisionByArm));
  });
});
