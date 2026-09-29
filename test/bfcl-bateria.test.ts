/**
 * La batería BFCL (benchmarks/publicados/bfcl): el comprobador AST portado, la
 * conversión de esquemas, el presupuesto duro, el cable, las reglas de
 * aislamiento de caché y la verja de hosts. Sin red.
 */
import { describe, expect, it } from "vitest";

import { comprobarEntrada, NumJ, normalizarCadena, parsearJson, salidaDeLlamadas, type ValorJ } from "../benchmarks/publicados/bfcl/ast.js";
import { conArgumentoCambiado, familiaDe, HOSTS_OFICIALES, MODELOS_GAMA_ALTA, muestraEstratificada, NOMBRE_POR_DEFECTO, PRECIOS_CITADOS, proveedorDe, techoDe, TOPE_GAMA_ALTA, TOPE_MAXIMO, violacionesDeCache, type VarianteMultiTurno } from "../benchmarks/publicados/bfcl/arnes.js";
import { cuerpoBrazoA, diferenciasDelCable, leerRespuesta, normalizarBase } from "../benchmarks/publicados/bfcl/brazos.js";
import { costeDeUso, crearCable, Presupuesto, PresupuestoAgotado, Semaforo, sinSecretos, unidadEnCurso, usoDeRespuesta, type LlamadaDelCable } from "../benchmarks/publicados/bfcl/cable.js";
import type { EntradaAst, FuncionBfcl } from "../benchmarks/publicados/bfcl/datos.js";
import { herramientaDe } from "../benchmarks/publicados/bfcl/esquema.js";
import { COMMIT_DEL_TAG, INTEGRIDAD_NPM, instalarVerjaDeHosts, SHA256_DIST_NPM, TAG_RELEASE, VERSION_PAQUETE } from "../benchmarks/publicados/bfcl/procedencia.js";
import { claveSimulada, fetchSimulado } from "../benchmarks/publicados/bfcl/simulador.js";
import { AnthropicProvider, createSavingsLayer, OpenAICompatibleProvider } from "../src/index.js";

const area: FuncionBfcl = {
  name: "geometry.area",
  description: "Area of a triangle.",
  parameters: {
    type: "dict",
    properties: {
      base: { type: "integer", description: "base" },
      height: { type: "float", description: "height" },
      unit: { type: "string", description: "unit" },
      opts: { type: "dict", description: "options", properties: { round: { type: "boolean" } } },
      tags: { type: "array", items: { type: "string" }, description: "tags" },
    },
    required: ["base", "height"],
  },
};
const posible = (x: unknown) => parsearJson(JSON.stringify(x)) as unknown as Record<string, Record<string, ValorJ[]>>[];
const gt = posible([{ "geometry.area": { base: [10], height: [5.0], unit: ["units", ""], opts: ["", { round: [true] }], tags: [["a", "b"], ""] } }]);
const llamada = (args: string) => {
  const s = salidaDeLlamadas([{ name: "geometry_area", arguments: args }]);
  if ("error" in s) throw new Error(s.error);
  return s;
};

describe("BFCL · comprobador AST portado", () => {
  it("el parser conserva si el número se escribió como flotante", () => {
    const v = parsearJson('{"a": 5, "b": 5.0, "c": 1e3, "d": [1, "x"]}') as Record<string, ValorJ>;
    expect(v["a"]).toEqual(new NumJ(5, false));
    expect(v["b"]).toEqual(new NumJ(5, true));
    expect((v["c"] as NumJ).flotante).toBe(true);
  });

  it("normaliza cadenas como BFCL", () => {
    expect(normalizarCadena("New York, NY")).toBe("newyorkny");
    expect(normalizarCadena("it's")).toBe('it"s');
  });

  it("acepta la llamada correcta, con int para un float (conversión de Python) y el opcional omitido", () => {
    expect(comprobarEntrada("simple", [area], llamada('{"base": 10, "height": 5}'), gt).valido).toBe(true);
    expect(comprobarEntrada("simple", [area], llamada('{"base": 10, "height": 5.0, "unit": "Units", "tags": ["A", "b"]}'), gt).valido).toBe(true);
    expect(comprobarEntrada("simple", [area], llamada('{"base": 10, "height": 5, "opts": {"round": true}}'), gt).valido).toBe(true);
  });

  it("rechaza un float donde la documentación pide integer, un valor fuera, un requerido ausente y un parámetro inesperado", () => {
    expect(comprobarEntrada("simple", [area], llamada('{"base": 10.0, "height": 5}'), gt).valido).toBe(false);
    expect(comprobarEntrada("simple", [area], llamada('{"base": 11, "height": 5}'), gt).valido).toBe(false);
    expect(comprobarEntrada("simple", [area], llamada('{"base": 10}'), gt).valido).toBe(false);
    expect(comprobarEntrada("simple", [area], llamada('{"base": 10, "height": 5, "color": "red"}'), gt).valido).toBe(false);
    expect(comprobarEntrada("simple", [area], llamada('{"base": 10, "height": 5, "opts": {"round": false}}'), gt).valido).toBe(false);
  });

  it("un opcional sin \"\" entre las posibles es obligatorio de facto", () => {
    const g = posible([{ "geometry.area": { base: [10], height: [5.0], unit: ["cm"] } }]);
    expect(comprobarEntrada("simple", [area], llamada('{"base": 10, "height": 5}'), g).valido).toBe(false);
  });

  it("parallel: sin orden y cada respuesta consume una llamada", () => {
    const g = posible([{ "geometry.area": { base: [1], height: [2.0] } }, { "geometry.area": { base: [3], height: [4.0] } }]);
    const s = salidaDeLlamadas([
      { name: "geometry_area", arguments: '{"base":3,"height":4}' },
      { name: "geometry_area", arguments: '{"base":1,"height":2}' },
    ]);
    if ("error" in s) throw new Error(s.error);
    expect(comprobarEntrada("parallel", [area], s, g).valido).toBe(true);
    expect(comprobarEntrada("parallel", [area], [s[0]!, s[0]!], g).valido).toBe(false);
    expect(comprobarEntrada("parallel", [area], [s[0]!], g).valido).toBe(false);
  });

  it("multiple: exactamente una llamada, a la función de la respuesta", () => {
    const otra: FuncionBfcl = { name: "other", description: "", parameters: { type: "dict", properties: {}, required: [] } };
    expect(comprobarEntrada("multiple", [otra, area], llamada('{"base": 10, "height": 5}'), gt).valido).toBe(true);
    expect(comprobarEntrada("multiple", [otra, area], [], gt).valido).toBe(false);
  });

  it("unos argumentos que no son JSON son un fallo, no una excepción", () => {
    expect("error" in salidaDeLlamadas([{ name: "x", arguments: "{no" }])).toBe(true);
  });
});

describe("BFCL · esquema en el cable", () => {
  it("convierte tipos y nombres como bfcl_eval", () => {
    const h = herramientaDe(area);
    expect(h.nombre).toBe("geometry_area");
    expect(h.descripcion).toMatch(/Python 3 syntax\.$/);
    const p = h.parametros as { type: string; properties: Record<string, Record<string, unknown>> };
    expect(p.type).toBe("object");
    expect(p.properties["height"]).toMatchObject({ type: "number", format: "float" });
    expect(String(p.properties["height"]!["description"])).toMatch(/This is a float type value\.$/);
    expect(p.properties["opts"]!["type"]).toBe("object");
    expect(p.properties["tags"]).toMatchObject({ type: "array", items: { type: "string" } });
  });

  it("normaliza la URL base sin exponer nada más que el host", () => {
    expect(normalizarBase("api.openai.com")).toBe("https://api.openai.com/v1");
    expect(normalizarBase("https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com/v1");
  });

  it("detecta que B omite herramientas o cambia el cuerpo", () => {
    const hs = [herramientaDe(area), herramientaDe({ ...area, name: "b" })];
    const a = cuerpoBrazoA("openai", "openai/gpt-4o-mini", [{ role: "user", content: "hi" }], hs, {});
    const b = { ...a, tools: (a["tools"] as unknown[]).slice(0, 1), prompt_cache_key: "k" };
    const d = diferenciasDelCable(a, b).diferencias;
    expect(d.some((x) => x.startsWith("tools: B omits 1/2"))).toBe(true);
    expect(d.some((x) => x.startsWith("prompt_cache_key"))).toBe(true);
    expect(diferenciasDelCable(a, a).diferencias).toEqual([]);
  });
});

describe("BFCL · presupuesto y cable", () => {
  const precio = { inputPer1k: 0.001, outputPer1k: 0.005, cachedInputPer1k: 0.0001 };

  it("cuesta el usage crudo de cada proveedor con primas de escritura", () => {
    const ua = usoDeRespuesta("anthropic", { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } })!;
    expect(ua.entrada).toBe(1300);
    expect(costeDeUso(ua, precio, 1.25)).toBeCloseTo(0.1 * 0.001 + 1 * 0.0001 + 0.2 * 0.001 * 1.25 + 0.01 * 0.005, 12);
    const uo = usoDeRespuesta("openai", { usage: { prompt_tokens: 2000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 1024 } } })!;
    expect(costeDeUso(uo, precio, 1)).toBeCloseTo(0.976 * 0.001 + 1.024 * 0.0001 + 0.05 * 0.005, 12);
    expect(usoDeRespuesta("openai", { usage: {} })).toBeNull();
  });

  it("reserva por unidad y nunca deja salir una llamada cuyo peor caso cruza el tope", async () => {
    const p = new Presupuesto("m", 0.01);
    expect(p.reservar(0.004)).toBe(true);
    expect(p.reservar(0.007)).toBe(false);
    expect(p.agotado).toBe(true);
    let llamadas = 0;
    const cable = crearCable({
      familia: "anthropic",
      presupuesto: new Presupuesto("m", 0.001),
      precio,
      prima: 1.25,
      semaforo: new Semaforo(1),
      base: async () => {
        llamadas++;
        return new Response("{}");
      },
    });
    await expect(cable("https://x.invalid/v1/messages", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(PresupuestoAgotado);
    expect(llamadas).toBe(0);
  });

  it("reintenta los 429, carga el coste al brazo de la unidad y no guarda cabeceras", async () => {
    let n = 0;
    const pres = new Presupuesto("m", 1);
    const cable = crearCable({
      familia: "openai",
      presupuesto: pres,
      precio,
      prima: 1,
      semaforo: new Semaforo(2),
      pausasMs: [1, 1],
      dormir: async () => {},
      base: async () => {
        n++;
        if (n === 1) return new Response('{"error":"rate"}', { status: 429 });
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1000, completion_tokens: 0 } }), { status: 200 });
      },
    });
    const reg: LlamadaDelCable[] = [];
    const r = await unidadEnCurso.run({ unidad: "u", brazo: "A", registro: reg }, () =>
      cable("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer sk-secretsecretsecret" }, body: '{"model":"x"}' }),
    );
    expect(r.status).toBe(200);
    expect(n).toBe(2);
    expect(reg[0]!.intentos).toBe(2);
    expect(pres.porBrazo.A).toBeCloseTo(0.001, 12);
    expect(JSON.stringify(reg)).not.toMatch(/secret|Bearer/);
  });

  it("redacta credenciales en textos de error", () => {
    expect(sinSecretos('x-api-key: "sk-ant-abcdef123456" and Bearer abc.def')).not.toMatch(/abcdef123456|abc\.def/);
  });
});

describe("BFCL · muestra, variantes y aislamiento de caché", () => {
  const e = (id: string, categoria: EntradaAst["categoria"]): EntradaAst => ({ id, categoria, pregunta: [], funciones: [], respuesta: [] });
  it("muestra estratificada: determinista, n por categoría, en turno rotatorio", () => {
    const por = new Map<EntradaAst["categoria"], EntradaAst[]>([
      ["simple", Array.from({ length: 10 }, (_, i) => e(`s${i}`, "simple"))],
      ["parallel", Array.from({ length: 10 }, (_, i) => e(`p${i}`, "parallel"))],
    ]);
    const m1 = muestraEstratificada(por, 3, 7);
    expect(m1.map((x) => x.id)).toEqual(muestraEstratificada(por, 3, 7).map((x) => x.id));
    expect(m1.map((x) => x.categoria)).toEqual(["simple", "parallel", "simple", "parallel", "simple", "parallel"]);
  });

  it("V3 cambia un argumento", () => {
    expect(conArgumentoCambiado([{ name: "cd", arguments: '{"folder":"doc"}' }])![0]!.arguments).toBe('{"folder":"doc_alt"}');
    expect(conArgumentoCambiado([{ name: "ls", arguments: "{}" }])![0]!.arguments).toBe('{"bfcl_variant":"alt"}');
    expect(conArgumentoCambiado([])).toBeNull();
  });

  const v = (variante: VarianteMultiTurno["variante"], cacheB: string, textoB: string): VarianteMultiTurno => ({
    variante,
    cacheB,
    textoB,
    costeA: 0,
    costeB: 0,
    llamadasAlProveedorB: cacheB === "miss" ? 1 : 0,
    llamadasB: 0,
    textoA: "",
    basisB: "measured",
  });
  it("una respuesta cacheada que cruza isError o argumentos es una violación; la repetición exacta no", () => {
    expect(violacionesDeCache([v("V1-base", "miss", "ok"), v("V2-isError", "miss", "err"), v("V4-repite-V1", "exact", "ok"), v("V5-repite-V2", "exact", "err")])).toEqual([]);
    expect(violacionesDeCache([v("V1-base", "miss", "ok"), v("V2-isError", "exact", "ok")])).toHaveLength(1);
    expect(violacionesDeCache([v("V1-base", "miss", "ok"), v("V3-args", "exact", "ok")])).toHaveLength(1);
    expect(violacionesDeCache([v("V1-base", "miss", "ok"), v("V2-isError", "miss", "err"), v("V5-repite-V2", "exact", "ok")]).length).toBeGreaterThan(0);
  });
});

describe("BFCL · extremo a extremo sin red", () => {
  it("la capa devuelve exactamente las llamadas que trajo el proveedor (simulado), en los dos dialectos", async () => {
    const hs = [herramientaDe(area)];
    const respuestas = new Map([[claveSimulada("Area?", ["geometry_area"]), [{ nombre: "geometry_area", args: { base: 10, height: 5.5 } }]]]);
    for (const familia of ["anthropic", "openai"] as const) {
      const reg: LlamadaDelCable[] = [];
      const cable = crearCable({ familia, presupuesto: new Presupuesto("m", 1), precio: { inputPer1k: 0.001, outputPer1k: 0.005 }, prima: 1.25, semaforo: new Semaforo(2), base: fetchSimulado(respuestas) });
      const provider =
        familia === "anthropic"
          ? new AnthropicProvider({ apiKey: "k", baseUrl: "https://mock.invalid/v1", fetchImpl: cable, stripProviderPrefix: true })
          : new OpenAICompatibleProvider({ apiKey: "k", baseUrl: "https://mock.invalid/v1", fetchImpl: cable, stripProviderPrefix: true });
      const capa = createSavingsLayer({ provider, devUnlicensed: true, silenceWarnings: true });
      const r = await unidadEnCurso.run({ unidad: "u", brazo: "B", registro: reg }, () =>
        capa.generate({ model: `${familia}/m`, messages: [{ role: "user", content: "Area?" }], tools: hs.map((h) => ({ id: h.nombre, description: h.descripcion, parameters: h.parametros })) as never }),
      );
      const cruda = leerRespuesta(familia, reg[0]!.respuesta);
      expect(r.toolCalls?.map((t) => [t.name, JSON.parse(t.arguments)])).toEqual(cruda.llamadas.map((t) => [t.name, JSON.parse(t.arguments)]));
      expect(r.toolCalls?.[0]?.arguments).toBe(cruda.llamadas[0]!.arguments);
    }
  });

  it("la verja de hosts rechaza cualquier host que no sea de un proveedor permitido", async () => {
    const verja = instalarVerjaDeHosts(["api.openai.com"]);
    try {
      await expect(fetch("https://savings.bivelio.com/api/ingest")).rejects.toThrow(/host guard/);
      expect([...verja.rechazados]).toEqual(["savings.bivelio.com"]);
    } finally {
      verja.retirar();
    }
  });

  it("con la 0.4.31 un catálogo sin tipar de más de 8 herramientas sale ENTERO al cable (#382)", async () => {
    const hs = Array.from({ length: 20 }, (_, i) => herramientaDe({ ...area, name: `tool_${i}` }));
    const respuestas = new Map([[claveSimulada("Area?", hs.map((h) => h.nombre)), [{ nombre: "tool_17", args: { base: 10, height: 5.5 } }]]]);
    // El fuente del repo (≥ 0.4.31, con #382), no el de la etiqueta: la CI hace el
    // checkout sin etiquetas y `cargarSdk` solo hace falta en las tiradas de verdad.
    const sdk = { AnthropicProvider, OpenAICompatibleProvider, createSavingsLayer };
    for (const familia of ["anthropic", "openai"] as const) {
      const reg: LlamadaDelCable[] = [];
      const cable = crearCable({ familia, presupuesto: new Presupuesto("m", 1), precio: { inputPer1k: 0.001, outputPer1k: 0.005 }, prima: 1.25, semaforo: new Semaforo(2), base: fetchSimulado(respuestas) });
      const provider =
        familia === "anthropic"
          ? new sdk.AnthropicProvider({ apiKey: "k", baseUrl: "https://mock.invalid/v1", fetchImpl: cable, stripProviderPrefix: true })
          : new sdk.OpenAICompatibleProvider({ apiKey: "k", baseUrl: "https://mock.invalid/v1", fetchImpl: cable, stripProviderPrefix: true });
      const capa = sdk.createSavingsLayer({ provider, devUnlicensed: true, silenceWarnings: true });
      const r = await unidadEnCurso.run({ unidad: "u", brazo: "B", registro: reg }, () =>
        capa.generate({ model: `${familia}/m`, messages: [{ role: "user", content: "Area?" }], tools: hs.map((h) => ({ id: h.nombre, description: h.descripcion, parameters: h.parametros })) as never }),
      );
      expect(((reg[0]!.peticion as Record<string, unknown>)["tools"] as unknown[]).length).toBe(20);
      expect(r.toolCalls?.[0]?.name).toBe("tool_17");
      expect(r.report.tokens.eliminatedInput).toBe(0);
    }
  }, 60_000);
});

describe("BFCL · procedencia y tope de la tirada 0.4.31", () => {
  it("el brazo B está fijado a la 0.4.31 del tag y de npm", () => {
    expect(VERSION_PAQUETE).toBe("0.4.31");
    expect(TAG_RELEASE).toBe("v0.4.31");
    expect(COMMIT_DEL_TAG).toBe("00c99c803c0ab6f3c11b7ab87f3c75a38d609b1c");
    expect(INTEGRIDAD_NPM).toBe("sha512-ePCN+dZr+VuMUSGm2TelDkt7TR6jSi/SCTomomDK/bfF92FHr1eFUdgTWQODCdQf8C8c+/h6AA/up46DXO2mLQ==");
    expect(SHA256_DIST_NPM).toMatch(/^[0-9a-f]{64}$/);
    expect(NOMBRE_POR_DEFECTO).toBe("bfcl-0431");
  });

  it("el tope duro por modelo es 0,80 $ en OpenAI y 1,25 $ en Anthropic", () => {
    expect(TOPE_MAXIMO).toEqual({ openai: 0.8, anthropic: 1.25, google: 0.8 });
    expect(familiaDe("openai/gpt-4o-mini")).toBe("openai");
    expect(familiaDe("anthropic/claude-sonnet-5")).toBe("anthropic");
  });
});

describe("BFCL · batería de gama alta (2026-09-29)", () => {
  it("1,25 $ por modelo de gama alta, sea cual sea su familia; el resto conserva su techo", () => {
    expect(TOPE_GAMA_ALTA).toBe(1.25);
    for (const m of MODELOS_GAMA_ALTA) expect(techoDe(m)).toBe(1.25);
    expect(techoDe("openai/gpt-4o-mini")).toBe(0.8);
    expect(techoDe("anthropic/claude-haiku-4-5")).toBe(1.25);
  });

  it("Gemini: proveedor google, dialecto OpenAI, y solo su host oficial", () => {
    expect(proveedorDe("google/gemini-3.8-flash")).toBe("google");
    expect(familiaDe("google/gemini-3.8-flash")).toBe("openai");
    expect(proveedorDe("openai/gpt-5.5")).toBe("openai");
    expect(HOSTS_OFICIALES.google).toBe("generativelanguage.googleapis.com");
  });

  it("el precio citado de claude-sonnet-5-5 es el de la página oficial, con URL y fecha", () => {
    const c = PRECIOS_CITADOS["claude-sonnet-5-5"]!;
    expect(c.precio).toEqual({ inputPer1k: 0.002, outputPer1k: 0.01, cachedInputPer1k: 0.0002 });
    expect(c.prima).toBe(1.25);
    expect(c.fuente).toMatch(/platform\.claude\.com.*2026-09-29/);
  });

  it("el pensamiento que Gemini deja fuera de completion_tokens se cobra como salida", () => {
    const u = usoDeRespuesta("openai", { usage: { prompt_tokens: 46, completion_tokens: 16, total_tokens: 105 } })!;
    expect(u.salida).toBe(59);
    expect(u.razonamiento).toBe(43);
    const o = usoDeRespuesta("openai", { usage: { prompt_tokens: 46, completion_tokens: 16, total_tokens: 62 } })!;
    expect(o.salida).toBe(16);
  });

  it("el extra_content de una llamada (thought_signature) se lee y el brazo A lo reenvía", () => {
    const cruda = { choices: [{ message: { tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" }, extra_content: { google: { thought_signature: "sig" } } }] } }] };
    const l = leerRespuesta("openai", cruda).llamadas;
    expect(l[0]!.extra).toEqual({ google: { thought_signature: "sig" } });
    const cuerpo = cuerpoBrazoA("openai", "google/gemini-3.8-flash", [{ role: "user", content: "x" }, { role: "assistant", content: "", llamadas: l }], [], {});
    const msgs = cuerpo["messages"] as Record<string, unknown>[];
    expect((msgs[1]!["tool_calls"] as Record<string, unknown>[])[0]!["extra_content"]).toEqual({ google: { thought_signature: "sig" } });
  });

  it("intentarReservar espera mientras otras unidades retienen presupuesto y solo para cuando no cabe nunca", () => {
    const p = new Presupuesto("m", 1);
    expect(p.intentarReservar(0.6)).toBe("si");
    expect(p.intentarReservar(0.6)).toBe("esperar");
    p.liberar(0.6);
    expect(p.intentarReservar(0.6)).toBe("si");
    p.liberar(0.6);
    p.cargar("A", 0.5);
    expect(p.intentarReservar(0.6)).toBe("no");
    expect(p.agotado).toBe(true);
  });
});
