import { describe, expect, it, vi } from "vitest";
import { juzgarPregunta } from "../benchmarks/publicados/mt-bench/mt-bench.js";
import {
  CATEGORIAS,
  DATASET,
  MODELOS_POR_DEFECTO,
  PresupuestoAgotado,
  Tope,
  combinarPartidas,
  costeDeUso,
  diferenciasDeCuerpo,
  leerVeredicto,
  ordenEstratificado,
  parsearPreguntas,
  peorCosteDeLlamada,
  promptDelJuez,
  puntuacionDeB,
  redactar,
  usoDeAnthropic,
  usoDeOpenAI,
  SinUsage,
  TOPE_DEL_JUEZ_USD,
  atribucionDelAhorro,
  claseDelAhorro,
  conRespuestasDe,
  diferenciasDeArbol,
  hostPermitido,
  parteDelJuez,
  topeDelCuerpo,
  topePorModelo,
  usoDeGoogle,
  usoDeFamilia,
  primaDeEscritura,
  MODELOS_GAMA_ALTA,
  TOPE_GAMA_ALTA_POR_MODELO_USD,
  type Pregunta,
  type PromptDelJuez,
} from "../benchmarks/publicados/mt-bench/nucleo.js";

const preguntas: Pregunta[] = CATEGORIAS.flatMap((c, ci) =>
  Array.from({ length: 10 }, (_, k) => ({ id: 81 + ci * 10 + k, categoria: c, turnos: [`q${ci}-${k}`, `f${ci}-${k}`] as [string, string] })),
);

describe("MT-Bench: dataset fijado", () => {
  it("fija commit y sha256 de los tres ficheros", () => {
    expect(DATASET.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const f of Object.values(DATASET.ficheros)) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(DATASET.license).toBe("Apache-2.0");
  });

  it("rechaza una pregunta que no tenga dos turnos o una categoría ajena", () => {
    expect(() => parsearPreguntas('{"question_id":1,"category":"math","turns":["a"]}')).toThrow(/2 turnos/);
    expect(() => parsearPreguntas('{"question_id":1,"category":"poesia","turns":["a","b"]}')).toThrow(/categoría/);
  });
});

describe("MT-Bench: subconjunto estratificado", () => {
  it("es reproducible con la misma semilla y recorre las 80", () => {
    const a = ordenEstratificado(preguntas).map((p) => p.id);
    const b = ordenEstratificado(preguntas).map((p) => p.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(80);
    expect(ordenEstratificado(preguntas, 1).map((p) => p.id)).not.toEqual(a);
  });

  it("cualquier prefijo está equilibrado por categoría (±1)", () => {
    const orden = ordenEstratificado(preguntas);
    for (let k = 1; k <= 80; k++) {
      const cuenta = new Map<string, number>();
      for (const p of orden.slice(0, k)) cuenta.set(p.categoria, (cuenta.get(p.categoria) ?? 0) + 1);
      const valores = CATEGORIAS.map((c) => cuenta.get(c) ?? 0);
      expect(Math.max(...valores) - Math.min(...valores)).toBeLessThanOrEqual(1);
    }
  });
});

describe("MT-Bench: coste desde el usage del proveedor", () => {
  const precio = { inputPer1k: 0.001, outputPer1k: 0.005, cachedInputPer1k: 0.0001 };

  it("Anthropic: input_tokens no incluye la caché; la escritura va con prima", () => {
    const u = usoDeAnthropic({ usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400 } });
    expect(u).toMatchObject({ entrada: 1000, cacheLeida: 2000, cacheEscrita: 400, salida: 200 });
    expect(costeDeUso(precio, 1.25, u)).toBeCloseTo(0.001 + 0.0002 + 0.0005 + 0.001, 10);
  });

  it("OpenAI: prompt_tokens incluye cached_tokens; el razonamiento va dentro de la salida", () => {
    const u = usoDeOpenAI({ usage: { prompt_tokens: 3000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 1024 }, completion_tokens_details: { reasoning_tokens: 300 } } });
    expect(u).toMatchObject({ entrada: 1976, cacheLeida: 1024, cacheEscrita: 0, salida: 500, razonamiento: 300 });
  });

  it("sin usage no hay cifra: error, nunca un 0", () => {
    expect(() => usoDeAnthropic({ content: [] })).toThrow(SinUsage);
    expect(() => usoDeOpenAI({ choices: [] })).toThrow(SinUsage);
  });
});

describe("MT-Bench: el tope es duro", () => {
  it("no deja salir una llamada cuya reserva no cabe, contando lo que está en vuelo", () => {
    const gastos: number[] = [];
    const t = new Tope("prueba", 1, (x) => gastos.push(x));
    const r1 = t.reservar(0.6);
    expect(() => t.reservar(0.5)).toThrow(PresupuestoAgotado);
    t.cerrar(r1, 0.1);
    expect(t.gastado).toBeCloseTo(0.1);
    const r2 = t.reservar(0.9);
    t.cerrar(r2, 0.2);
    expect(t.gastado).toBeCloseTo(0.3);
    expect(gastos).toEqual([0.1, 0.2]);
    expect(t.excesos).toBe(0);
  });

  it("el peor coste de una llamada acota salida al tope y entrada con prima", () => {
    const p = { inputPer1k: 0.002, outputPer1k: 0.01 };
    const peor = peorCosteDeLlamada(p, 1.25, 2000, 1024, 0);
    expect(peor).toBeCloseTo(((1000 + 16) / 1000) * 0.002 * 1.25 + 1.024 * 0.01, 10);
  });
});

describe("MT-Bench: juez de pares con posiciones intercambiadas", () => {
  it("lee el veredicto como FastChat", () => {
    expect(leerVeredicto("bla [[A]]")).toBe("A");
    expect(leerVeredicto("bla [[B]]")).toBe("B");
    expect(leerVeredicto("bla [[C]]")).toBe("empate");
    expect(leerVeredicto("sin formato")).toBe("error");
  });

  it("diagnostica el HTTP del juez sin exponer el cuerpo", async () => {
    const prompts = new Map<string, PromptDelJuez>([
      ["pair-v2", { name: "pair-v2", type: "pairwise", output_format: "[[A]]", system_prompt: "judge", prompt_template: "{question} {answer_a} {answer_b}" }],
      ["pair-v2-multi-turn", { name: "pair-v2-multi-turn", type: "pairwise", output_format: "[[A]]", system_prompt: "judge", prompt_template: "{question_1} {answer_a_1} {answer_b_1} {question_2} {answer_a_2} {answer_b_2}" }],
    ]);
    const pregunta: Pregunta = { id: 81, categoria: "writing", turnos: ["q1", "q2"] };
    const resultado = {
      A: [{ texto: "a1" }, { texto: "a2" }],
      B: [{ texto: "b1" }, { texto: "b2" }],
    } as Parameters<typeof juzgarPregunta>[0];
    const dataset: Parameters<typeof juzgarPregunta>[2] = {
      origen: "sintetico-mock", preguntas: [pregunta], referencias: new Map(), prompts,
    };
    const credenciales = { juez: { base: "https://juez.invalid/v1", clave: "test-secret", modelo: "openai/gpt-4o" } } as Parameters<typeof juzgarPregunta>[3];
    const diagnostico = vi.spyOn(console, "error").mockImplementation(() => {});
    let llamadas = 0;
    try {
      const juicios = await juzgarPregunta(
        resultado, pregunta, dataset, credenciales, new Tope("juez", 1, () => {}),
        { inputPer1k: 0.001, outputPer1k: 0.005 },
        async () => { llamadas++; return new Response("provider-secret-body", { status: 401 }); },
        true,
      );

      expect(juicios.every((juicio) => juicio.ganador === "error")).toBe(true);
      expect(llamadas).toBe(4);
      expect(diagnostico).toHaveBeenCalledTimes(4);
      expect(diagnostico.mock.calls.every(([mensaje]) => mensaje === "MT-Bench: juez HTTP 401 (openai/gpt-4o)")).toBe(true);
      expect(JSON.stringify(diagnostico.mock.calls)).not.toContain("secret");
    } finally {
      diagnostico.mockRestore();
    }
  });

  it("traduce la segunda partida a brazos y declara empate si discrepan", () => {
    // partida 1: Assistant A = brazo A. partida 2: Assistant A = brazo B.
    expect(combinarPartidas("B", "A")).toEqual({ ganador: "B", inconsistente: false });
    expect(combinarPartidas("A", "B")).toEqual({ ganador: "A", inconsistente: false });
    expect(combinarPartidas("A", "A")).toEqual({ ganador: "empate", inconsistente: true });
    expect(combinarPartidas("empate", "empate")).toEqual({ ganador: "empate", inconsistente: false });
    expect(combinarPartidas("error", "A").ganador).toBe("error");
    expect([puntuacionDeB("B"), puntuacionDeB("empate"), puntuacionDeB("A")]).toEqual([1, 0.5, 0]);
  });

  it("usa el prompt con referencia en math/reasoning/coding y coloca al primero como Assistant A", () => {
    const prompts = new Map<string, PromptDelJuez>(
      ["pair-v2", "pair-v2-multi-turn", "pair-math-v1", "pair-math-v1-multi-turn"].map((n) => [
        n,
        { name: n, type: "pairwise", output_format: "[[A]]", system_prompt: n, prompt_template: "R:{ref_answer_1}|{ref_answer_2} A:{answer_a}{answer_a_2} B:{answer_b}{answer_b_2}" },
      ]),
    );
    const a = { preguntas: ["q1", "q2"] as [string, string], respuestas: ["a1", "a2"] as [string, string] };
    const b = { preguntas: ["q1", "q2"] as [string, string], respuestas: ["b1", "b2"] as [string, string] };
    const sinRef = promptDelJuez(prompts, 1, a, b, undefined);
    expect(sinRef.nombre).toBe("pair-v2");
    expect(sinRef.user).toContain("A:a1");
    const conRef = promptDelJuez(prompts, 2, b, a, { id: 1, turnos: ["r1", "r2"] });
    expect(conRef.nombre).toBe("pair-math-v1-multi-turn");
    // En el turno 2 las claves del turno 1 no existen y quedan tal cual.
    expect(conRef.user).toBe("R:r1|r2 A:{answer_a}b2 B:{answer_b}a2");
  });
});

describe("MT-Bench: el cable y los secretos", () => {
  it("un content de solo-texto en bloques es el mismo cuerpo; cache_control no", () => {
    const a = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hola" }] };
    const b = { messages: [{ role: "user", content: [{ type: "text", text: "hola" }] }], max_tokens: 10, model: "m" };
    expect(diferenciasDeCuerpo(a, b)).toEqual([]);
    const c = { ...a, messages: [{ role: "user", content: [{ type: "text", text: "hola", cache_control: { type: "ephemeral" } }] }] };
    expect(diferenciasDeCuerpo(a, c)).toEqual(["messages:cache_control"]);
    const d = { ...a, messages: [{ role: "user", content: "adiós" }] };
    expect(diferenciasDeCuerpo(a, d)).toEqual(["messages"]);
  });

  it("0.4.31: el tope de salida ya no se excluye del diff — si A y B no mandan el mismo, se ve", () => {
    const a = { model: "m", max_completion_tokens: 1024, messages: [{ role: "user", content: "hola" }] };
    expect(diferenciasDeCuerpo(a, { ...a })).toEqual([]);
    expect(diferenciasDeCuerpo(a, { ...a, max_completion_tokens: 4096 })).toEqual(["max_completion_tokens"]);
    const { max_completion_tokens: _, ...sinTope } = a;
    expect(diferenciasDeCuerpo(a, sinTope)).toEqual(["max_completion_tokens"]);
  });

  it("en el turno 2 compara con la respuesta de B puesta en la historia de A", () => {
    const a = { model: "m", messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "respuesta de A" }, { role: "user", content: "q2" }] };
    const b = { model: "m", messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "respuesta de B" }, { role: "user", content: "q2" }] };
    expect(diferenciasDeCuerpo(a, b)).toEqual(["messages"]);
    expect(diferenciasDeCuerpo(conRespuestasDe(a, ["respuesta de B"]), b)).toEqual([]);
    // Lo que la capa añada (una marca de caché en la respuesta) sigue viéndose.
    const bMarcado = { ...b, messages: [b.messages[0], { role: "assistant", content: [{ type: "text", text: "respuesta de B", cache_control: { type: "ephemeral" } }] }, b.messages[2]] };
    expect(diferenciasDeCuerpo(conRespuestasDe(a, ["respuesta de B"]), bMarcado)).toEqual(["messages:cache_control"]);
  });

  it("tapa el valor de una clave y cualquier cabecera de autenticación", () => {
    const clave = "sk-ant-api03-ESTO-ES-DE-PRUEBA-0000";
    const t = redactar(`fallo con x-api-key: ${clave} y Authorization: Bearer abcdefgh12345`, [clave]);
    expect(t).not.toContain(clave);
    expect(t).not.toContain("abcdefgh12345");
  });
});

describe("MT-Bench 0.4.31: tope nativo, presupuesto, hosts y fuente", () => {
  it("el transporte lee el tope del cuerpo y no acepta una petición sin él", () => {
    expect(topeDelCuerpo({ max_tokens: 1024 })).toBe(1024);
    expect(topeDelCuerpo({ max_completion_tokens: 4096 })).toBe(4096);
    expect(topeDelCuerpo({ model: "x" })).toBeNull();
    expect(topeDelCuerpo({ max_completion_tokens: 0 })).toBeNull();
    expect(topeDelCuerpo({ max_tokens: "10" })).toBeNull();
  });

  it("topes duros: 0,80 $ por modelo de OpenAI, 1,25 $ por modelo de Anthropic, 0,50 $ de juez en total", () => {
    expect(topePorModelo({ familia: "openai" })).toBe(0.8);
    expect(topePorModelo({ familia: "anthropic" })).toBe(1.25);
    expect(TOPE_DEL_JUEZ_USD).toBe(0.5);
  });

  it("claude-sonnet-5 no recibe temperature (el API la rechaza) y lleva 4096 porque piensa por defecto", () => {
    const s = MODELOS_POR_DEFECTO.find((m) => m.id === "claude-sonnet-5")!;
    expect(s).toMatchObject({ familia: "anthropic", temperatura: false, maxSalida: 4096 });
    const h = MODELOS_POR_DEFECTO.find((m) => m.id === "claude-haiku-4-5")!;
    expect(h).toMatchObject({ familia: "anthropic", temperatura: true, maxSalida: 1024 });
  });

  it("el juez reparte lo que QUEDA entre los modelos pendientes y nunca pasa del total", () => {
    expect(parteDelJuez(0.5, 0, 2)).toBeCloseTo(0.25);
    // El primero gastó 0,20: al segundo le toca el resto entero.
    expect(parteDelJuez(0.5, 0.2, 1)).toBeCloseTo(0.3);
    expect(parteDelJuez(0.5, 0.6, 1)).toBe(0);
    expect(parteDelJuez(0.5, 0, 0)).toBe(0);
    let gastado = 0;
    for (let pendientes = 4; pendientes >= 1; pendientes--) gastado += parteDelJuez(0.5, gastado, pendientes);
    expect(gastado).toBeLessThanOrEqual(0.5 + 1e-12);
  });

  it("la clase del ahorro sale del IC95, no del punto", () => {
    expect(claseDelAhorro({ lower: 0.01, upper: 0.2 }, 40)).toBe("ahorro");
    expect(claseDelAhorro({ lower: -0.2, upper: -0.01 }, 40)).toBe("sobrecoste");
    expect(claseDelAhorro({ lower: -0.01, upper: 0.3 }, 40)).toBe("indistinguible de 0");
    // Con una pregunta el bootstrap da un «intervalo» de un punto: no se clasifica.
    expect(claseDelAhorro({ lower: -0.06, upper: -0.06 }, 1)).toBe("muestra insuficiente");
    expect(claseDelAhorro(null, 0)).toBe("sin datos");
  });

  it("la guarda de hosts solo deja salir a los proveedores, el juez y el dataset, por https", () => {
    for (const u of ["https://api.openai.com/v1/chat/completions", "https://api.anthropic.com/v1/messages", "https://ai-gateway.vercel.sh/v1/chat/completions", "https://raw.githubusercontent.com/lm-sys/FastChat/x"]) {
      expect(hostPermitido(u)).toBe(true);
    }
    for (const u of ["https://bivelio.com/api/metering", "https://licencias.bivelio.com/v1", "http://api.openai.com/v1", "https://api.openai.com.evil.example/v1", "no es una url"]) {
      expect(hostPermitido(u)).toBe(false);
    }
  });

  it("diff de árbol: vacío solo si es la etiqueta byte a byte (ni cambios, ni sobrantes, ni faltantes)", () => {
    const tag = new Map([["src/a.ts", "h1"], ["src/b.ts", "h2"]]);
    expect(diferenciasDeArbol(tag, new Map(tag))).toEqual([]);
    expect(diferenciasDeArbol(tag, new Map([["src/a.ts", "h1"], ["src/b.ts", "OTRO"]]))).toEqual(["M src/b.ts"]);
    expect(diferenciasDeArbol(tag, new Map([["src/a.ts", "h1"]]))).toEqual(["D src/b.ts"]);
    expect(diferenciasDeArbol(tag, new Map([...tag, ["src/c.ts", "h3"]]))).toEqual(["A src/c.ts"]);
  });

  it("un ahorro significativo NO es de la capa si el cable solo cambió prompt_cache_key y no hubo caché", () => {
    const base = { clase: "ahorro" as const, diferenciasDelCable: { prompt_cache_key: 80 }, lecturasDeCacheA: 0, lecturasDeCacheB: 0, ahorroDeclaradoUsd: 0 };
    expect(atribucionDelAhorro(base).atribuible).toBe(false);
    expect(atribucionDelAhorro({ ...base, lecturasDeCacheB: 5 }).atribuible).toBe(true);
    expect(atribucionDelAhorro({ ...base, diferenciasDelCable: { messages: 3 } }).atribuible).toBe(true);
    expect(atribucionDelAhorro({ ...base, ahorroDeclaradoUsd: 0.01 }).atribuible).toBe(true);
    expect(atribucionDelAhorro({ ...base, clase: "muestra insuficiente" }).atribuible).toBeNull();
  });

  it("una marca cache_control que no escribió ni leyó un token no es efecto de la capa; si escribió, sí", () => {
    const base = { clase: "sobrecoste" as const, diferenciasDelCable: { "messages:cache_control": 80 }, lecturasDeCacheA: 0, lecturasDeCacheB: 0, ahorroDeclaradoUsd: 0 };
    expect(atribucionDelAhorro({ ...base, tokensEscritosEnCacheB: 0 }).atribuible).toBe(false);
    expect(atribucionDelAhorro({ ...base, tokensEscritosEnCacheB: 1200 }).atribuible).toBe(true);
    // Sin el dato, lo conservador: cuenta como cambio con efecto.
    expect(atribucionDelAhorro(base).atribuible).toBe(true);
  });
});

describe("MT-Bench gama alta (2026-09-29): Gemini, precios citados y topes", () => {
  it("Gemini (endpoint compatible): el razonamiento está solo en total_tokens y se factura como salida", () => {
    // Forma medida en vivo: 13 de entrada, 3 de salida visible, total 193.
    const u = usoDeGoogle({ usage: { prompt_tokens: 13, completion_tokens: 3, total_tokens: 193 } });
    expect(u).toEqual({ entrada: 13, cacheLeida: 0, cacheEscrita: 0, salida: 180, razonamiento: 177 });
    const c = usoDeGoogle({ usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 600 } } });
    expect(c.entrada).toBe(400);
    expect(c.cacheLeida).toBe(600);
    expect(c.salida).toBe(10);
    // Sin total_tokens no se sabe cuánto pensó: error, nunca un 0.
    expect(() => usoDeGoogle({ usage: { prompt_tokens: 13, completion_tokens: 3 } })).toThrow(SinUsage);
    expect(usoDeFamilia("google", { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 5 } }).salida).toBe(4);
    expect(usoDeFamilia("openai", { usage: { prompt_tokens: 1, completion_tokens: 1 } }).salida).toBe(1);
    expect(primaDeEscritura("google")).toBe(1);
  });

  it("topes: 1,25 $ por modelo en cualquier familia y 0,50 $ de juez", () => {
    expect(TOPE_GAMA_ALTA_POR_MODELO_USD).toBe(1.25);
    expect(TOPE_DEL_JUEZ_USD).toBe(0.5);
  });

  it("la lista no repite los ya medidos y el único sin fila lleva precio oficial citado", () => {
    const ids = MODELOS_GAMA_ALTA.map((m) => m.id);
    for (const ya of ["claude-haiku-4-5", "claude-sonnet-5", "gpt-4o-mini", "gpt-5.4-mini"]) expect(ids).not.toContain(ya);
    const sonnet = MODELOS_GAMA_ALTA.find((m) => m.id === "claude-sonnet-5-5")!;
    expect(sonnet.precioOficial?.fuente).toMatch(/^https:\/\/platform\.claude\.com\//);
    expect(sonnet.precioOficial?.consultado).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sonnet.precioOficial?.precio).toEqual({ inputPer1k: 0.002, outputPer1k: 0.01, cachedInputPer1k: 0.0002 });
    // Los modelos de razonamiento o que rechazan temperature no la llevan en ningún brazo.
    for (const m of MODELOS_GAMA_ALTA.filter((x) => x.familia !== "google")) expect(m.temperatura).toBe(false);
  });

  it("OpenAI (gpt-5.6+): la escritura de caché va aparte, dentro de prompt_tokens, y con prima", () => {
    const u = usoDeOpenAI({ usage: { prompt_tokens: 1692, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1692 } } });
    expect(u).toMatchObject({ entrada: 0, cacheLeida: 0, cacheEscrita: 1692, salida: 100 });
    const precio = { inputPer1k: 0.004, outputPer1k: 0.02, cachedInputPer1k: 0.0004 };
    expect(costeDeUso(precio, 1.25, u)).toBeCloseTo(1.692 * 0.004 * 1.25 + 0.1 * 0.02, 10);
  });

  it("la guarda de hosts deja salir al host oficial de Gemini y a nada que se le parezca", () => {
    expect(hostPermitido("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")).toBe(true);
    expect(hostPermitido("http://generativelanguage.googleapis.com/v1beta/openai")).toBe(false);
    expect(hostPermitido("https://generativelanguage.googleapis.com.evil.example/v1beta")).toBe(false);
    expect(hostPermitido("https://aiplatform.googleapis.com/v1")).toBe(false);
  });
});
