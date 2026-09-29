/**
 * La batería GSM8K sin red: el flujo, la extracción de la respuesta, las cuentas
 * y el arnés completo contra un proveedor falso. Nada aquí llama a un modelo.
 */
import { describe, expect, it } from "vitest";

import {
  caidaDeCapa,
  claveAnthropicValida,
  quitarPromptCacheKey,
  conContador,
  googleDesdeSonda,
  HOSTS_PERMITIDOS,
  MODELOS_GAMA_ALTA,
  origenDelAhorro,
  pensamientoOculto,
  precioDelBanco,
  medirModelo,
  nombreDelDocumento,
  peticionDe,
  peticionDirecta,
  PresupuestoAgotado,
  proveedorSeco,
  TOPE_DE_SALIDA,
  topeDeSalida,
  topeDuroPara,
} from "../benchmarks/publicados/gsm8k/arnes.js";
import { fabricaDeCapa, PAQUETE_NPM, SinLicencia } from "../benchmarks/publicados/gsm8k/capa.js";
import { compararModelo } from "../benchmarks/publicados/gsm8k/comparar.js";
import {
  construirFlujo,
  extraerNumeroFinal,
  mensajeDeUsuario,
  oroDe,
  parafrasisSuperficie,
  varianteCifra,
  variantePalabra,
} from "../benchmarks/publicados/gsm8k/flujo.js";
import type { FilaGsm8k } from "../benchmarks/publicados/gsm8k/fuente.js";
import { desgloseDelAhorro, resumir, type Ensayo } from "../benchmarks/publicados/gsm8k/medir.js";
import { preguntasSinRed, repetirSinRed } from "../benchmarks/publicados/gsm8k/sin-red.js";

const NOMBRES = ["Ana", "Luis", "Marta", "Pere", "Joan", "Eva", "Iker", "Nora", "Olga", "Raul"];
/** Un test sintético con la forma de GSM8K: cifras, números en letra y «####». */
function testSintetico(n = 60): FilaGsm8k[] {
  return Array.from({ length: n }, (_, i) => {
    const a = 3 + (i % 7);
    const b = 10 + i;
    return {
      question: `${NOMBRES[i % NOMBRES.length]} has ${b} marbles and buys two bags with ${a} marbles each. How many marbles does ${NOMBRES[i % NOMBRES.length]} have in total?`,
      answer: `${b} + 2*${a} = <<${b}+2*${a}=${b + 2 * a}>>${b + 2 * a}\n#### ${b + 2 * a}`,
    };
  });
}

describe("GSM8K: oro y respuesta final", () => {
  it("lee el oro tras ####, sin separadores de miles", () => {
    expect(oroDe("... \n#### 1,200")).toBe(1200);
    expect(oroDe("x\n#### -3")).toBe(-3);
    expect(() => oroDe("sin marca")).toThrow();
  });

  it("extrae el número tras el último ####, o el último número del texto", () => {
    expect(extraerNumeroFinal("so 5 + 3 = 8\n#### 8")).toBe(8);
    expect(extraerNumeroFinal("#### $1,234.50")).toBe(1234.5);
    expect(extraerNumeroFinal("The answer is 42.")).toBe(42);
    expect(extraerNumeroFinal("no numbers")).toBeNull();
  });
});

describe("GSM8K: plantillas", () => {
  it("la variante de cifra cambia el primer entero y la de palabra no toca dígitos", () => {
    expect(varianteCifra("A robe takes 2 bolts and 3.5 more")).toBe("A robe takes 3 bolts and 3.5 more");
    expect(varianteCifra("sin cifras")).toBeNull();
    expect(variantePalabra("She eats three eggs and Two more")).toBe("She eats four eggs and Two more");
    expect(variantePalabra("Twice a day")).toBe("Three times a day");
    expect(variantePalabra("nothing")).toBeNull();
  });

  it("la paráfrasis de superficie no toca cifras", () => {
    expect(parafrasisSuperficie("Ana has $1,200. How much?")).toBe("ana  has  $1,200.  how  much");
  });
});

describe("GSM8K: el flujo", () => {
  const test = testSintetico(150);

  it("con 100 únicos: 200 peticiones, 60 repeticiones y 10 de cada clase derivada", () => {
    const f = construirFlujo(test, { nUnicos: 100, semilla: 7 });
    expect(f.peticiones).toHaveLength(200);
    expect(f.cuenta).toEqual({
      original: 100,
      repeticion: 60,
      superficie: 10,
      lexica: 10,
      "variante-cifra": 10,
      "variante-palabra": 10,
    });
  });

  it("es determinista y cada derivada va DESPUÉS de su original", () => {
    const a = construirFlujo(test, { nUnicos: 40, semilla: 11 });
    const b = construirFlujo(test, { nUnicos: 40, semilla: 11 });
    expect(a.peticiones).toEqual(b.peticiones);
    const posOriginal = new Map(a.peticiones.filter((q) => q.clase === "original").map((q) => [q.familia, q.pos]));
    for (const q of a.peticiones) {
      if (q.clase !== "original") expect(q.pos).toBeGreaterThan(posOriginal.get(q.familia)!);
    }
  });

  it("las variantes no tienen oro y su texto difiere del original", () => {
    const f = construirFlujo(test, { nUnicos: 40, semilla: 3 });
    const orig = new Map(f.problemas.map((p) => [p.idx, p.pregunta]));
    for (const q of f.peticiones.filter((x) => x.clase.startsWith("variante"))) {
      expect(q.oro).toBeNull();
      expect(q.texto).not.toBe(orig.get(q.familia));
    }
  });
});

describe("GSM8K: las cuentas", () => {
  const base = (p: Partial<Ensayo>): Ensayo => ({
    pos: 0, familia: 0, clase: "original", oro: 5, huella: "h0", brazo: "A", numero: 5, correcto: true,
    coste: 1, llamadas: 1, entrada: 100, cacheada: 0, escrita: 0, salida: 10, latenciaMs: 10, fuente: "provider",
    ...p,
  });

  it("una variante servida de caché sin texto previo idéntico es un hallazgo grave; con texto previo, no", () => {
    const ensayos: Ensayo[] = [
      base({ pos: 0, brazo: "A" }),
      base({ pos: 0, brazo: "E", coste: 1 }),
      base({ pos: 1, brazo: "A", clase: "variante-palabra", oro: null, correcto: null, huella: "h1", numero: 7 }),
      base({ pos: 1, brazo: "E", clase: "variante-palabra", oro: null, correcto: null, huella: "h1", numero: 5, fuente: "semantic_cache", coste: 0, similitud: 0.97 }),
      base({ pos: 2, brazo: "A", clase: "variante-palabra", oro: null, correcto: null, huella: "h1", numero: 7 }),
      base({ pos: 2, brazo: "E", clase: "variante-palabra", oro: null, correcto: null, huella: "h1", numero: 5, fuente: "exact_cache", coste: 0 }),
    ];
    const r = resumir(ensayos);
    expect(r.variantesPorBrazo.E).toEqual({ n: 2, deCache: 2, deOtra: 1 });
    expect(r.variantesServidasDeOtra[0]).toMatchObject({ pos: 1, numeroServido: 5, numeroA: 7, numeroDelOriginal: 5 });
    const c = r.comparaciones.find((x) => x.brazo === "E")!;
    expect(c.costeA).toBe(3);
    expect(c.costeBrazo).toBe(1);
  });

  it("el desglose separa lo que la capa no llamó de lo que ahorró la caché de prefijo", () => {
    const ensayos: Ensayo[] = [
      base({ pos: 0, brazo: "A", coste: 1, entrada: 2000 }),
      base({ pos: 0, brazo: "B", coste: 1.1, entrada: 2000, escrita: 1900 }),
      base({ pos: 1, brazo: "A", coste: 1, entrada: 2000 }),
      base({ pos: 1, brazo: "B", coste: 0.4, entrada: 2000, cacheada: 1900 }),
      base({ pos: 2, brazo: "A", coste: 1, entrada: 2000 }),
      base({ pos: 2, brazo: "B", coste: 0, llamadas: 0, entrada: 0, fuente: "exact_cache" }),
    ];
    const d = desgloseDelAhorro(ensayos, { inputPer1k: 0.001, cachedInputPer1k: 0.0001, prima: 1.25 });
    const b = d.find((x) => x.brazo === "B")!;
    expect(b.ahorroTotalUsd).toBeCloseTo(1.5);
    expect(b.ahorroPorNoLlamarUsd).toBeCloseTo(1);
    expect(b.ahorroEnLlamadasUsd).toBeCloseTo(0.5);
    expect(b).toMatchObject({ llamadas: 2, llamadasConLectura: 1, llamadasConEscritura: 1, tokensLeidos: 1900, tokensEscritos: 1900 });
    // 1900 × 0,0009/1000 − 1900 × 0,001 × 0,25/1000
    expect(b.prefijoNetoUsd).toBeCloseTo(0.001235, 6);
    expect(b.entradaMediaPorLlamada).toBe(2000);
    expect(d.find((x) => x.brazo === "A")!.ahorroTotalUsd).toBe(0);
  });

  it("la caja corta ANTES de la llamada que la pasaría", async () => {
    const caja = { tope: 0.001, gasto: 0.0009, peorLlamada: 0.0005 };
    const c = { coste: 0, llamadas: 0, entrada: 0, cacheada: 0, escrita: 0, salida: 0 };
    let llamadas = 0;
    const p = conContador(
      { id: "x", generate: async () => { llamadas++; return { text: "#### 1", usage: { inputTokens: 1, outputTokens: 1 } }; } },
      "openai/gpt-4o-mini",
      caja,
      c,
    );
    await expect(p.generate({ model: "openai/gpt-4o-mini", messages: [] })).rejects.toBeInstanceOf(PresupuestoAgotado);
    expect(llamadas).toBe(0);
  });
});

describe("GSM8K: la capa y el arnés, sin red", () => {
  it("sin BIVELIO_LICENSE_KEY y sin --desde-fuente, aborta antes de gastar", async () => {
    await expect(fabricaDeCapa({ desdeFuente: false, env: {} })).rejects.toBeInstanceOf(SinLicencia);
  });

  it("apunta a la 0.4.31 publicada: integrity del registro, etiqueta y documento propio", () => {
    expect(PAQUETE_NPM.version).toBe("0.4.31");
    expect(PAQUETE_NPM.integrity).toBe("sha512-ePCN+dZr+VuMUSGm2TelDkt7TR6jSi/SCTomomDK/bfF92FHr1eFUdgTWQODCdQf8C8c+/h6AA/up46DXO2mLQ==");
    expect(PAQUETE_NPM.commit).toBe("00c99c803c0ab6f3c11b7ab87f3c75a38d609b1c");
    // El de la 0.4.30 (gsm8k.{json,md}) no se pisa.
    expect(nombreDelDocumento("0.4.31")).toBe("gsm8k-0431");
    // La tirada de Claude va aparte y no pisa la de OpenAI.
    expect(nombreDelDocumento("0.4.31", "claude")).toBe("gsm8k-0431-claude");
    expect(() => nombreDelDocumento("0.4.31", "../x")).toThrow();
  });

  it("todos los brazos llevan el MISMO tope nativo (0.4.31, #381) y la petición no pide la semántica", () => {
    expect(topeDeSalida("openai/gpt-4o-mini")).toBe(TOPE_DE_SALIDA);
    const req = peticionDe("openai/gpt-5.4-mini", "SYS", "1+1?", TOPE_DE_SALIDA);
    expect(req.maxOutputTokens).toBe(1024);
    expect(req.savings).toBeUndefined();
    expect(peticionDirecta(req, "openai/gpt-5.4-mini").maxOutputTokens).toBe(1024);
  });

  it("topes duros: 0,80 $ por modelo de OpenAI, 1,25 $ por modelo de Anthropic", () => {
    expect(topeDuroPara("openai/gpt-4o-mini")).toBe(0.8);
    expect(topeDuroPara("anthropic/claude-haiku-4-5")).toBe(1.25);
  });

  it("la clave de Anthropic se comprueba gratis: un 401 en GET /v1/models la declara inválida sin sonda", async () => {
    const urls: string[] = [];
    const f401 = (async (u: string) => {
      urls.push(String(u));
      return new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;
    expect(await claveAnthropicValida("https://api.anthropic.com/v1", "x", f401)).toMatch(/^no medibles: clave inválida/);
    expect(urls).toEqual(["https://api.anthropic.com/v1/models?limit=1"]);
    const f200 = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await claveAnthropicValida("https://api.anthropic.com/v1/", "x", f200)).toBe("ok");
  });

  it("mide un modelo de punta a punta con el proveedor falso: A y los tres brazos con capa", async () => {
    const test = testSintetico(80);
    const f = construirFlujo(test, { nUnicos: 20, semilla: 20260928 });
    const oros = new Map<string, number>();
    for (const q of f.peticiones) if (q.oro !== null) oros.set(mensajeDeUsuario(q.texto), q.oro);
    const capa = await fabricaDeCapa({ desdeFuente: true, env: {} });
    const m = await medirModelo({
      model: "openai/gpt-4o-mini",
      test,
      sistema: "Solve it.\n\nQuestion: 1+1\nAnswer: 2\n#### 2",
      brazos: ["A", "B", "S", "E"],
      nUnicosMax: 20,
      topeUsd: 1.25,
      crudo: () => proveedorSeco(oros),
      host: null,
      runId: "test",
      capa,
    });
    expect(m.estado).toBe("medido");
    expect(m.peticionesCompletadas).toBe(40);
    // La caja de un modelo de OpenAI es la de 0,80 $ aunque se pida más.
    expect(m.gasto.topeUsd).toBe(0.8);
    // `semanticCacheDefault: true` en la capa ENCIENDE la caché de S y E sin tocar la petición.
    expect(m.registrosSemanticos?.E).toBeGreaterThan(0);
    const r = m.resumen!;
    expect(r.brazos.A!.exactitud.aciertos).toBe(r.brazos.A!.exactitud.n);
    // Las repeticiones exactas salen de la caché exacta en B: B llama menos que A.
    expect(r.brazos.B!.llamadasAlProveedor).toBeLessThan(r.brazos.A!.llamadasAlProveedor);
    expect(r.brazos.B!.fuentes["exact_cache"]).toBeGreaterThan(0);
    expect(m.gasto.totalUsd).toBeLessThan(1.25);
  });

  it("fija los únicos de una tirada anterior aunque la previsión diga otros", async () => {
    const test = testSintetico(80);
    const oros = new Map<string, number>();
    for (const q of construirFlujo(test, { nUnicos: 15, semilla: 20260928 }).peticiones) if (q.oro !== null) oros.set(mensajeDeUsuario(q.texto), q.oro);
    const capa = await fabricaDeCapa({ desdeFuente: true, env: {} });
    const m = await medirModelo({
      model: "openai/gpt-4o-mini", test, sistema: "Solve it.", brazos: ["A", "B"], nUnicosMax: 40, nUnicosFijo: 15,
      topeUsd: 1.25, crudo: () => proveedorSeco(oros), host: null, runId: "test", capa,
    });
    expect(m.nUnicos).toBe(15);
    expect(m.peticionesCompletadas).toBe(30);
    // Contra sí misma: mismo flujo, cifras idénticas.
    const c = compararModelo(m.modelo, m.ensayos!, m.ensayos!, 15, 15);
    expect(c.mismoFlujo).toBe(true);
    expect(c.posiciones).toBe(30);
    for (const f of c.filas) expect(f.despues).toEqual(f.antes);
    // Un flujo recortado (la caja cortó la tirada nueva) se compara en el prefijo común.
    const corto = compararModelo(m.modelo, m.ensayos!, m.ensayos!.filter((e) => e.pos < 10), 15, 15);
    expect(corto.posiciones).toBe(10);
  });

  it("sin red: el interruptor de la capa (semanticCacheDefault) decide lo mismo que el de cada petición", async () => {
    const ps = preguntasSinRed(testSintetico(30), 3);
    const capa = await fabricaDeCapa({ desdeFuente: true, env: {} });
    const envio = await repetirSinRed(ps, "semantica-envio", "SYS", capa);
    const defecto = await repetirSinRed(ps, "semantica-defecto-capa", "SYS", capa);
    expect(defecto.llamadasAlProveedor).toBe(envio.llamadasAlProveedor);
    expect(defecto.erroneas).toBe(envio.erroneas);
    expect(defecto.registrosSemanticos).toBeGreaterThan(0);
    const sin = await repetirSinRed(ps, "semantica-sin-interruptor", "SYS", capa);
    expect(sin.registrosSemanticos).toBe(0);
  });

  it("la repetición sin red recorre cada problema con sus derivadas", async () => {
    const test = testSintetico(12);
    const ps = preguntasSinRed(test, 1);
    expect(ps.filter((p) => p.clase === "original")).toHaveLength(12);
    const capa = await fabricaDeCapa({ desdeFuente: true, env: {} });
    const r = await repetirSinRed(ps, "defecto", "SYS", capa);
    expect(r.peticiones).toBe(ps.length);
    expect(r.erroneas).toBe(0);
  });
});

describe("GSM8K gama alta (2026-09-29): topes, precios, Gemini y origen del ahorro, sin red", () => {
  it("la gama alta lleva 1,25 $ por modelo, OpenAI incluido; el resto no cambia", () => {
    for (const m of MODELOS_GAMA_ALTA) expect(topeDuroPara(m)).toBe(1.25);
    expect(topeDuroPara("openai/gpt-4o-mini")).toBe(0.8);
    expect(topeDuroPara("openai/gpt-5.4-mini")).toBe(0.8);
  });

  it("Gemini solo por su origen oficial, y el host está en la guarda", () => {
    expect(HOSTS_PERMITIDOS).toContain("generativelanguage.googleapis.com");
    const ok = googleDesdeSonda({}, { BVSALA_SONDA_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai", BVSALA_SONDA_API_KEY: "k" });
    expect(ok.googleBaseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(googleDesdeSonda({}, { BVSALA_SONDA_BASE_URL: "https://pasarela.example.com/v1", BVSALA_SONDA_API_KEY: "k" })).toEqual({});
    expect(googleDesdeSonda({ googleBaseUrl: "https://x.example/v1" }, { BVSALA_SONDA_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai" })).toEqual({});
  });

  it("un modelo sin fila se mide solo con el precio oficial citado; con fila, manda el catálogo", () => {
    const s55 = precioDelBanco("anthropic/claude-sonnet-5-5");
    expect(s55.conocido).toBe(true);
    expect(s55.precio).toEqual({ inputPer1k: 0.002, outputPer1k: 0.01, cachedInputPer1k: 0.0002 });
    expect(s55.fueraDeCatalogo).toMatch(/^https:\/\/platform\.claude\.com\/docs\/en\/about-claude\/pricing \(consultado 2026-09-29\)/);
    const o55 = precioDelBanco("anthropic/claude-opus-5-5");
    expect(o55.fueraDeCatalogo).toBeUndefined();
    expect(o55.precio.inputPer1k).toBe(0.004);
    expect(precioDelBanco("anthropic/claude-inventado-9").conocido).toBe(false);
  });

  it("el pensamiento de Gemini que completion_tokens no cuenta se factura como salida", async () => {
    const resp = (total: number) => ({
      text: "#### 72",
      usage: { inputTokens: 44, outputTokens: 56, cachedInputTokens: 0 },
      raw: { usage: { prompt_tokens: 44, completion_tokens: 56, total_tokens: total } },
    });
    expect(pensamientoOculto("google/gemini-3.8-flash", resp(215))).toBe(115);
    expect(pensamientoOculto("openai/gpt-5.5", resp(215))).toBe(0);
    expect(pensamientoOculto("google/gemini-3.8-flash", { text: "", usage: { inputTokens: 1, outputTokens: 1 } })).toBe(0);
    const caja = { tope: 1, gasto: 0, peorLlamada: 0 };
    const c = { coste: 0, llamadas: 0, entrada: 0, cacheada: 0, escrita: 0, salida: 0, pensamiento: 0 };
    const p = conContador({ id: "g", generate: async () => resp(215) }, "google/gemini-3.8-flash", caja, c);
    await p.generate({ model: "google/gemini-3.8-flash", messages: [] });
    expect(c.pensamiento).toBe(115);
    expect(c.salida).toBe(56);
    // 44 de entrada a 0,75 $/M y 171 de salida a 3,75 $/M.
    expect(c.coste).toBeCloseTo((44 * 0.75 + 171 * 3.75) / 1e6, 12);
  });

  it("el origen del ahorro parte coste(A) − coste(brazo) en caché de la capa + llamadas, sin resto", () => {
    const e = (p: Partial<Ensayo>): Ensayo => ({
      pos: 0, familia: 0, clase: "original", oro: 5, huella: "h", brazo: "A", numero: 5, correcto: true,
      coste: 0.01, llamadas: 1, entrada: 2000, cacheada: 0, escrita: 0, salida: 90, latenciaMs: 1, fuente: "provider", ...p,
    });
    const ensayos = [
      e({ pos: 0 }), e({ pos: 0, brazo: "B", coste: 0.012, escrita: 2000 }),
      e({ pos: 1 }), e({ pos: 1, brazo: "B", coste: 0.004, cacheada: 2000 }),
      e({ pos: 2 }), e({ pos: 2, brazo: "B", coste: 0, llamadas: 0, entrada: 0, salida: 0, fuente: "exact_cache" }),
    ];
    const o = origenDelAhorro(ensayos, "anthropic/claude-opus-5-5").B!;
    expect(o.cacheCapa).toEqual({ posiciones: 1, usd: 0.01 });
    expect(o.llamadas.posiciones).toBe(2);
    expect(o.cacheCapa.usd + o.llamadas.usd).toBeCloseTo(o.costeA - o.costeBrazo, 12);
    // Opus 5.5: lectura a 0,20 $/M (entrada 4 $/M) y escritura a 1,25×.
    expect(o.descuentoPrefijoBrazo).toBeCloseTo((2000 * (4 - 0.2) - 2000 * 4 * 0.25) / 1e6, 12);
    expect(o.descuentoPrefijoA).toBe(0);
    expect(o.tokensLeidosDeCacheBrazo).toBe(2000);
  });

  it("el parche declarado de Gemini quita SOLO prompt_cache_key y deja el resto intacto", () => {
    const q = quitarPromptCacheKey(JSON.stringify({ model: "gemini-3.8-flash", prompt_cache_key: "abc", max_tokens: 1024 }));
    expect(q.quitado).toBe(true);
    expect(JSON.parse(q.body as string)).toEqual({ model: "gemini-3.8-flash", max_tokens: 1024 });
    expect(quitarPromptCacheKey(JSON.stringify({ model: "x" })).quitado).toBe(false);
    expect(quitarPromptCacheKey("no json").quitado).toBe(false);
    expect(quitarPromptCacheKey(undefined).quitado).toBe(false);
  });

  it("un brazo con capa que falla en TODAS sus peticiones no es un ahorro del 100 %: es una caída", () => {
    const e = (p: Partial<Ensayo>): Ensayo => ({
      pos: 0, familia: 0, clase: "original", oro: 5, huella: "h", brazo: "A", numero: 5, correcto: true,
      coste: 0.01, llamadas: 1, entrada: 10, cacheada: 0, escrita: 0, salida: 5, latenciaMs: 1, fuente: "provider", ...p,
    });
    const caida = [e({}), e({ brazo: "B", coste: 0, llamadas: 0, numero: null, correcto: false, error: "provider 400: Unknown name \"prompt_cache_key\"" })];
    expect(caidaDeCapa(resumir(caida), caida)).toMatch(/arm B failed.*prompt_cache_key/);
    const sana = [e({}), e({ brazo: "B" })];
    expect(caidaDeCapa(resumir(sana), sana)).toBeUndefined();
  });
});
