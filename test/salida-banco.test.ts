import { describe, it, expect } from "vitest";

import {
  ESTILOS,
  MAX_TOKENS_SALIDA,
  bootstrapReduccionPct,
  bootstrapReduccionPctPorTarea,
  construirPeticionSalida,
  ejecucionVacia,
  sinCabeceraDeAtribucion,
  sinFrontmatter,
  systemConEstilo,
  textoDeSkill,
  veredicto,
  type EjecucionSalida,
  type Estilo,
  type TextosDeEstilo,
} from "../benchmarks/salida/nucleo.js";
import { leerTextosDeEstilo } from "../benchmarks/salida/arnes.js";
import { prng, tareasDelAnillo1 } from "../benchmarks/anillo1/tareas.js";

/**
 * Verjas del banco de SALIDA — todo SIN red:
 *  · «base» es el system de la tarea INTACTO; los otros llevan su texto;
 *  · la sal de frío sigue en el byte 0 del system de la petición;
 *  · la petición NO lleva context_management ni beta: aquí se mide salida;
 *  · los textos de estilo se leen sin frontmatter ni cabecera de atribución;
 *  · el veredicto: publica solo con suelo de IC > 0 y puerta de éxito, dice
 *    cuando el coste total EMPEORA, y es determinista frente al orden.
 */

const tareas = tareasDelAnillo1();
const textos: TextosDeEstilo = { "savings-mode": "## Output\n- Lead with the answer.", caveman: "Respond terse like smart caveman." };

describe("systemConEstilo", () => {
  it("base devuelve el system de la tarea sin tocar un byte", () => {
    for (const t of tareas) expect(systemConEstilo(t.sistema, "base", textos)).toBe(t.sistema);
  });

  it("savings-mode y caveman llevan el system de la tarea Y su texto, separados por línea en blanco", () => {
    const t = tareas[0]!;
    for (const estilo of ["savings-mode", "caveman"] as const) {
      const s = systemConEstilo(t.sistema, estilo, textos);
      expect(s.startsWith(t.sistema)).toBe(true);
      expect(s.endsWith(textos[estilo])).toBe(true);
      expect(s).toBe(`${t.sistema}\n\n${textos[estilo]}`);
    }
    expect(systemConEstilo(t.sistema, "savings-mode", textos)).not.toContain(textos.caveman);
  });
});

describe("construirPeticionSalida", () => {
  const base = { tarea: tareas[0]!, modelo: "claude-sonnet-4-5", mensajes: [{ role: "user", content: "x" }], apiKey: "sk-test", textos };

  it("la sal es el PRIMER byte del system en los tres estilos y distingue estilos y reps", () => {
    const systems = new Set<string>();
    for (const estilo of ESTILOS) {
      for (const rep of [0, 1]) {
        const sal = `t-${base.tarea.id}-${estilo}-${rep}`;
        const p = construirPeticionSalida({ ...base, estilo, sal });
        const system = String(p.cuerpo.system);
        expect(system.startsWith(`[medicion-fria ${sal}]\n`)).toBe(true);
        expect(system.slice(`[medicion-fria ${sal}]\n`.length)).toBe(systemConEstilo(base.tarea.sistema, estilo, textos));
        systems.add(system);
      }
    }
    expect(systems.size).toBe(ESTILOS.length * 2);
  });

  it("NO lleva context_management ni cabecera beta: el banco de salida no toca la entrada", () => {
    for (const estilo of ESTILOS) {
      const p = construirPeticionSalida({ ...base, estilo, sal: "s" });
      expect(p.cuerpo.context_management).toBeUndefined();
      expect(p.cabeceras["anthropic-beta"]).toBeUndefined();
      expect(Object.keys(p.cuerpo).sort()).toEqual(["max_tokens", "messages", "model", "system", "tools"]);
    }
  });

  it("mismo techo de salida (2048) y mismas herramientas para los tres estilos", () => {
    const cuerpos = ESTILOS.map((estilo) => construirPeticionSalida({ ...base, estilo, sal: "s" }).cuerpo);
    for (const c of cuerpos) {
      expect(c.max_tokens).toBe(MAX_TOKENS_SALIDA);
      expect(c.max_tokens).toBe(2048);
      expect(JSON.stringify(c.tools)).toBe(JSON.stringify(cuerpos[0]!.tools));
      expect(c.messages).toBe(base.mensajes);
    }
  });
});

describe("textos de estilo", () => {
  it("sinFrontmatter quita el bloque YAML y solo ese", () => {
    expect(sinFrontmatter("---\nname: x\ndescription: y\n---\n# Hola\n")).toBe("# Hola\n");
    expect(sinFrontmatter("# Sin frontmatter\n---\nno es frontmatter\n")).toBe("# Sin frontmatter\n---\nno es frontmatter\n");
  });

  it("sinCabeceraDeAtribucion quita el comentario HTML inicial y solo ese", () => {
    expect(sinCabeceraDeAtribucion("<!--\n  Fuente: x\n-->\n---\nname: c\n---\nTexto\n")).toBe("---\nname: c\n---\nTexto\n");
    expect(sinCabeceraDeAtribucion("Texto <!-- no inicial -->\n")).toBe("Texto <!-- no inicial -->\n");
    expect(textoDeSkill("<!--\nFuente\n-->\n---\nname: c\n---\n\nTexto\n")).toBe("Texto");
  });

  it("los ficheros reales se leen limpios: savings-mode sin frontmatter, caveman sin cabecera ni frontmatter, ambos literales", () => {
    const reales = leerTextosDeEstilo();
    expect(reales["savings-mode"].startsWith("# Savings Mode")).toBe(true);
    expect(reales["savings-mode"]).toContain("## Never trade away");
    expect(reales["savings-mode"]).not.toMatch(/^---/);
    expect(reales["savings-mode"]).not.toContain("name: savings-mode");

    expect(reales.caveman.startsWith("Respond terse like smart caveman.")).toBe(true);
    expect(reales.caveman).toContain("Never drop not/never/no/only/except");
    expect(reales.caveman).not.toContain("<!--");
    expect(reales.caveman).not.toContain("Atribución");
    expect(reales.caveman).not.toContain("name: caveman");
    // El propio autor lo dice: sus reglas pesan; el banco mide ese peso como entrada.
    expect(reales.caveman.length).toBeGreaterThan(reales["savings-mode"].length);
  });
});

// ── Fixtures sintéticos para el veredicto ──

function fixture(opts: {
  estilos: readonly Estilo[];
  tareas?: number;
  reps?: number;
  salidaBase?: number;
  /** Tokens de salida del estilo como fracción de base (0,7 = reduce 30 %). */
  factorSalida?: Partial<Record<Estilo, number>>;
  /** Éxito por estilo como probabilidad (1 = siempre). */
  exito?: Partial<Record<Estilo, number>>;
  /** Tokens de entrada añadidos por turno por el texto del estilo. */
  entradaExtra?: Partial<Record<Estilo, number>>;
  semilla?: number;
}): EjecucionSalida[] {
  const r = prng(opts.semilla ?? 7);
  const out: EjecucionSalida[] = [];
  const nTareas = opts.tareas ?? 10;
  const reps = opts.reps ?? 2;
  for (let t = 0; t < nTareas; t++) {
    for (let rep = 0; rep < reps; rep++) {
      // El mundo de la pareja: misma masa de entrada y salida para todos los estilos.
      const salidaBase = Math.round((opts.salidaBase ?? 800) * (0.6 + 0.8 * r()));
      const entradaBase = Math.round(40_000 * (0.5 + r()));
      const turnos = 3 + Math.floor(r() * 4);
      for (const estilo of opts.estilos) {
        const factor = estilo === "base" ? 1 : (opts.factorSalida?.[estilo] ?? 1);
        const salida = Math.round(salidaBase * factor * (0.95 + 0.1 * r()));
        const entrada = entradaBase + turnos * (opts.entradaExtra?.[estilo] ?? 0);
        const pExito = opts.exito?.[estilo] ?? 1;
        const e = ejecucionVacia(tareas[t % tareas.length]!, estilo, rep);
        e.tarea = `tarea-${t}`;
        e.turnos = turnos;
        e.llamadas = turnos;
        e.entregado = true;
        e.exito = r() < pExito;
        e.tokens = { entrada, salida, cacheLeida: 0, cacheEscrita: 0 };
        e.tokensSalida = salida;
        e.costeSalidaUsd = (salida / 1000) * 0.015; // precio de salida de Sonnet
        e.costeTotalUsd = e.costeSalidaUsd + (entrada / 1000) * 0.003;
        e.charsEntrega = 40;
        e.charsTexto = salida * 4;
        out.push(e);
      }
    }
  }
  return out;
}

describe("veredicto", () => {
  it("un estilo que reduce la salida un 30 % con el mismo éxito es PUBLICABLE con el suelo del IC por encima de cero", () => {
    const ej = fixture({ estilos: ESTILOS, factorSalida: { "savings-mode": 0.7, caveman: 0.5 } });
    const v = veredicto(ej, ESTILOS);
    expect(v.estilos.map((s) => s.estilo)).toEqual(["savings-mode", "caveman"]);
    const sm = v.estilos[0]!;
    expect(sm.pares).toBe(20);
    expect(sm.tokensSalida.reduccionPct.media).toBeGreaterThan(25);
    expect(sm.tokensSalida.reduccionPct.media).toBeLessThan(35);
    expect(sm.tokensSalida.reduccionPct.inferior).toBeGreaterThan(0);
    expect(sm.tokensSalida.reduccionPct.inferior).toBeLessThan(sm.tokensSalida.reduccionPct.media);
    expect(sm.exito.puerta).toBe(true);
    expect(sm.exito.diferencia).toEqual({ media: 0, inferior: 0, superior: 0 });
    expect(sm.publicable).toBe(true);
    expect(sm.costeTotal.empeora).toBe(false);
    expect(sm.notas).toEqual([]);
    const cv = v.estilos[1]!;
    expect(cv.tokensSalida.reduccionPct.inferior).toBeGreaterThan(sm.tokensSalida.reduccionPct.inferior);
    expect(cv.publicable).toBe(true);
  });

  it("un estilo que reduce la salida pero PIERDE éxito no es publicable: QUALITY_FLOOR", () => {
    const ej = fixture({ estilos: ["base", "caveman"], factorSalida: { caveman: 0.5 }, exito: { base: 1, caveman: 0.4 }, tareas: 15 });
    const v = veredicto(ej, ["base", "caveman"]);
    const cv = v.estilos[0]!;
    expect(cv.tokensSalida.reduccionPct.inferior).toBeGreaterThan(0);
    expect(cv.exito.estilo).toBeLessThan(cv.exito.base);
    expect(cv.exito.diferencia!.superior).toBeLessThan(0);
    expect(cv.exito.puerta).toBe(false);
    expect(cv.publicable).toBe(false);
    expect(cv.notas.some((n) => n.includes("QUALITY_FLOOR"))).toBe(true);
  });

  it("el coste TOTAL puede EMPEORAR aunque la salida baje: el texto del estilo se paga como entrada, y se dice", () => {
    // 1.500 tokens extra por turno (lo que el autor de caveman avisa) contra un
    // ahorro de salida modesto: la factura sube.
    const ej = fixture({ estilos: ["base", "caveman"], factorSalida: { caveman: 0.8 }, entradaExtra: { caveman: 1500 } });
    const v = veredicto(ej, ["base", "caveman"]);
    const cv = v.estilos[0]!;
    expect(cv.tokensSalida.reduccionPct.inferior).toBeGreaterThan(0);
    expect(cv.tokensEntrada.estilo).toBeGreaterThan(cv.tokensEntrada.base);
    expect(cv.costeTotal.reduccionPct.media).toBeLessThan(0);
    expect(cv.costeTotal.empeora).toBe(true);
    expect(cv.notas.some((n) => n.includes("coste TOTAL empeora"))).toBe(true);
    // Publicable como cifra de SALIDA (eso es lo que mide el banco), con el aviso a la vista.
    expect(cv.publicable).toBe(true);
  });

  it("sin efecto real, el IC abraza el cero y no se publica", () => {
    const ej = fixture({ estilos: ["base", "savings-mode"] });
    const v = veredicto(ej, ["base", "savings-mode"]);
    const sm = v.estilos[0]!;
    expect(sm.tokensSalida.reduccionPct.inferior).toBeLessThanOrEqual(0);
    expect(sm.tokensSalida.reduccionPct.superior).toBeGreaterThanOrEqual(0);
    expect(sm.publicable).toBe(false);
    expect(sm.notas.some((n) => n.includes("no separa de cero"))).toBe(true);
  });

  it("es determinista: el orden de las ejecuciones no cambia ni un decimal", () => {
    const ej = fixture({ estilos: ESTILOS, factorSalida: { "savings-mode": 0.8, caveman: 0.6 }, exito: { caveman: 0.8 } });
    const directo = veredicto(ej, ESTILOS);
    const inverso = veredicto([...ej].reverse(), ESTILOS);
    const barajado = veredicto([...ej].sort((a, b) => a.tokensSalida - b.tokensSalida), ESTILOS);
    expect(JSON.stringify(inverso)).toBe(JSON.stringify(directo));
    expect(JSON.stringify(barajado)).toBe(JSON.stringify(directo));
  });

  it("una ejecución reventada (coste 0) sale de los pares medidos pero cuenta como fracaso en la puerta", () => {
    const ej = fixture({ estilos: ["base", "caveman"], factorSalida: { caveman: 0.6 }, tareas: 6 });
    const rota = ej.find((e) => e.estilo === "caveman" && e.tarea === "tarea-2" && e.rep === 1)!;
    Object.assign(rota, ejecucionVacia(tareas[0]!, "caveman", 1), { tarea: "tarea-2" });
    const v = veredicto(ej, ["base", "caveman"]);
    const cv = v.estilos[0]!;
    expect(cv.paresDeExito).toBe(12);
    expect(cv.pares).toBe(11);
    expect(cv.exito.estilo).toBe(11);
    expect(cv.exito.base).toBe(12);
  });

  it("con un solo par no hay IC ni publicación, y se dice", () => {
    const ej = fixture({ estilos: ["base", "caveman"], factorSalida: { caveman: 0.5 }, tareas: 1, reps: 1 });
    const v = veredicto(ej, ["base", "caveman"]);
    const cv = v.estilos[0]!;
    expect(cv.pares).toBe(1);
    expect(Number.isNaN(cv.tokensSalida.reduccionPct.inferior)).toBe(true);
    expect(cv.publicable).toBe(false);
    expect(cv.notas.some((n) => n.includes("sin IC"))).toBe(true);
  });
});

describe("bootstrapReduccionPct", () => {
  it("remuestrea la razón de sumas: brazos idénticos → IC que abraza el cero; misma semilla → mismos decimales", () => {
    const pares = Array.from({ length: 30 }, (_, i) => ({ base: 100 + i, estilo: 100 + i }));
    const ic = bootstrapReduccionPct(pares, 2000);
    expect(ic).toEqual({ media: 0, inferior: 0, superior: 0 });
    const ruido = Array.from({ length: 30 }, (_, i) => ({ base: 100 + i, estilo: i % 2 ? 90 + i : 110 + i }));
    const a = bootstrapReduccionPct(ruido, 2000);
    const b = bootstrapReduccionPct(ruido, 2000);
    expect(a).toEqual(b);
    expect(a.inferior).toBeLessThanOrEqual(a.media);
    expect(a.superior).toBeGreaterThanOrEqual(a.media);
  });

  it("pesa la MASA, no la media de porcentajes: una tarea gorda manda", () => {
    // Una tarea de 2.000 tokens al 50 % y nueve de 50 tokens sin cambio: la
    // masa baja un ~41 %; la media de porcentajes por pareja diría 5 %.
    const pares = [{ base: 2000, estilo: 1000 }, ...Array.from({ length: 9 }, () => ({ base: 50, estilo: 50 }))];
    const ic = bootstrapReduccionPct(pares, 2000);
    expect(ic.media).toBeCloseTo(100 * (1 - 1450 / 2450), 5);
  });
});

describe("lo que cazó la revisión del 06-09 — clúster por tarea, doble éxito, truncado, descomposición, errores", () => {
  it("⛔ el IC por TAREA es más ancho que el IC por pares cuando las reps de una tarea son casi idénticas", () => {
    // Reps gemelas (mismo fixture) no son unidades independientes: el IC por
    // pares regala suelo. El de tarea es el que se publica.
    const r = prng(11);
    const pares: { tarea: string; base: number; estilo: number }[] = [];
    for (let t = 0; t < 12; t++) {
      const base = 400 + Math.round(r() * 1600);
      const factor = 0.5 + r() * 0.4; // efecto muy distinto por tarea
      for (let rep = 0; rep < 3; rep++) pares.push({ tarea: `t${t}`, base, estilo: Math.round(base * factor) });
    }
    const porTarea = bootstrapReduccionPctPorTarea(pares);
    const porPares = bootstrapReduccionPct(pares);
    expect(porTarea.media).toBeCloseTo(porPares.media, 6);
    expect(porTarea.superior - porTarea.inferior).toBeGreaterThan(porPares.superior - porPares.inferior);
    expect(bootstrapReduccionPctPorTarea(pares)).toEqual(porTarea); // determinista
  });

  it("⛔ un estilo que fracasa más CORTO no publica con esa masa: solo cuentan los pares con doble éxito", () => {
    const ejecs = fixture({ estilos: ["base", "caveman"], tareas: 12, factorSalida: { caveman: 0.6 }, exito: { caveman: 1 } });
    // En la mitad de las tareas caveman fracasa y además emite casi nada.
    for (const e of ejecs) {
      const t = Number(e.tarea.split("-")[1]);
      if (e.estilo === "caveman" && t % 2 === 0) {
        e.exito = false;
        e.tokensSalida = 5;
        e.tokens.salida = 5;
        e.costeSalidaUsd = 0.0001;
      }
    }
    const v = veredicto(ejecs, ["base", "caveman"]).estilos[0]!;
    // Con TODOS los pares el ahorro parece enorme; con doble éxito, el real.
    expect(v.tokensSalida.reduccionPct.media).toBeGreaterThan(v.tokensSalidaDobleExito.reduccionPct.media);
    expect(v.tokensSalidaDobleExito.pares).toBe(12); // 6 tareas × 2 reps
    // Y la pérdida de éxito cierra la puerta.
    expect(v.exito.puerta).toBe(false);
    expect(v.publicable).toBe(false);
  });

  it("⛔ una salida TRUNCADA por max_tokens o un bloque thinking anulan la publicación, y se dice", () => {
    const t = fixture({ estilos: ["base", "savings-mode"], factorSalida: { "savings-mode": 0.7 } });
    t.find((e) => e.estilo === "base")!.truncados = 1;
    const v1 = veredicto(t, ["base", "savings-mode"]).estilos[0]!;
    expect(v1.publicable).toBe(false);
    expect(v1.truncados).toEqual({ base: 1, estilo: 0 });
    expect(v1.notas.join(" | ")).toMatch(/TRUNCADAS/);
    const u = fixture({ estilos: ["base", "savings-mode"], factorSalida: { "savings-mode": 0.7 } });
    u.find((e) => e.estilo === "savings-mode")!.bloquesThinking = 2;
    const v2 = veredicto(u, ["base", "savings-mode"]).estilos[0]!;
    expect(v2.publicable).toBe(false);
    expect(v2.notas.join(" | ")).toMatch(/thinking/);
  });

  it("la descomposición del ahorro total dice cuánto es ENTRADA, y avisa cuando manda la entrada", () => {
    // El estilo reduce la salida un 30 % pero, sobre todo, LEE mucho menos (entrada negativa = ahorro).
    const ejecs = fixture({ estilos: ["base", "savings-mode"], factorSalida: { "savings-mode": 0.7 }, entradaExtra: { "savings-mode": -6000 } });
    const v = veredicto(ejecs, ["base", "savings-mode"]).estilos[0]!;
    expect(v.descomposicionAhorroUsd.salida).toBeGreaterThan(0);
    expect(v.descomposicionAhorroUsd.entrada).toBeGreaterThan(v.descomposicionAhorroUsd.salida);
    expect(v.notas.join(" | ")).toMatch(/del ahorro TOTAL es ENTRADA/);
    expect(v.publicable).toBe(true); // la salida sigue publicable por su propio IC
  });

  it("un par con ejecución REVENTADA (error) sale de la puerta de éxito en vez de contar como fracaso del estilo", () => {
    const ejecs = fixture({ estilos: ["base", "caveman"], factorSalida: { caveman: 0.7 } });
    const rota = ejecs.find((e) => e.estilo === "base")!;
    rota.error = "API: overloaded";
    rota.exito = false;
    const v = veredicto(ejecs, ["base", "caveman"]).estilos[0]!;
    expect(v.paresConError).toBe(1);
    expect(v.exito.total).toBe(ejecs.length / 2 - 1);
    expect(v.exito.puerta).toBe(true);
    expect(v.notas.join(" | ")).toMatch(/reventada/);
  });

  it("lista las tareas SIN señal (ningún brazo las resuelve)", () => {
    const ejecs = fixture({ estilos: ["base", "caveman"], factorSalida: { caveman: 0.7 } });
    for (const e of ejecs) if (e.tarea === "tarea-3") e.exito = false;
    const v = veredicto(ejecs, ["base", "caveman"]).estilos[0]!;
    expect(v.tareasSinSenal).toEqual(["tarea-3"]);
  });
});
