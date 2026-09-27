import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryCacheBreakpointStore, type CacheBreakpointStore } from "../src/cache/breakpoint-store.js";
import { EspejoDeCache, huellasDePrefijos, claveDelAlmacen } from "../src/economics/colocador-de-cache.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { ChatMessage, SavingsRequest, SavingsResult } from "../src/contracts/types.js";
import { CacheAnthropicSimulada, dolares } from "../benchmarks/colocador-de-cache/simulador.js";
import { agente, chatLento, ragDeUnSoloUso, reloj, type Reloj } from "../benchmarks/colocador-de-cache/escenarios.js";

/**
 * EL COLOCADOR EN SERVERLESS: EL ESPEJO EN UN ALMACÉN (`cacheBreakpointStore`).
 *
 * Con una instancia por petición el espejo en memoria no llega a tener
 * muestras nunca y `cacheBreakpoints: "auto"` se queda en la colocación fija
 * para siempre. Lo que se fija aquí:
 *
 *   1. SIN almacén, el cable y `cost.actual` son byte a byte los de antes de
 *      que existiera (huellas grabadas en origin/main, c8f0c0c).
 *   2. CON almacén y una sola instancia, las decisiones son exactamente las
 *      mismas que sin él: restaurar el espejo no cambia nada.
 *   3. Con una capa NUEVA por petición y un almacén compartido, la segunda
 *      instancia aprende de la primera; sin almacén no aprende ninguna.
 *   4. Un almacén que falla no rompe nada y no borra lo aprendido.
 *   5. En el almacén solo hay huellas y cuentas, nunca texto del cliente.
 */

const PRECIO_SONNET_4_5 = { inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0003 };
type Capa = ReturnType<typeof createSavingsLayer>;

beforeEach(() => reiniciarAvisos());

function capa(sim: CacheAnthropicSimulada, r: Reloj, store?: CacheBreakpointStore): Capa {
  return createSavingsLayer({
    provider: new AnthropicProvider({ fetchImpl: sim.fetch }),
    cacheBreakpoints: "auto",
    ...(store ? { cacheBreakpointStore: store } : {}),
    now: r.ahora,
    silenceWarnings: true,
  });
}

/** Una «capa» que en cada petición construye otra nueva: una instancia serverless por petición. */
function unaPorPeticion(crear: () => Capa): Capa & { instancias: () => number } {
  let n = 0;
  return {
    generate: (req: SavingsRequest) => {
      n++;
      return crear().generate(req);
    },
    instancias: () => n,
  } as unknown as Capa & { instancias: () => number };
}

function contable(layer: Capa) {
  const informes: SavingsResult<unknown>["report"][] = [];
  const orig = layer.generate.bind(layer);
  (layer as { generate: typeof layer.generate }).generate = (async (req: SavingsRequest) => {
    const r = await orig(req);
    informes.push(r.report);
    return r;
  }) as typeof layer.generate;
  return {
    informes,
    trazas: (etapa: string) => informes.flatMap((r) => r.traces.filter((t) => t.stage === etapa)),
  };
}

type Escenario = (l: Capa, r: Reloj) => Promise<void>;
const ESCENARIOS: [string, Escenario][] = [
  ["agente", (l, r) => agente(l, r, { runs: 6, pasos: 12, huecoMs: 4000, entreRuns: 30_000 })],
  ["rag", (l, r) => ragDeUnSoloUso(l, r, { n: 80, huecoMs: 10_000 })],
  ["chat", (l, r) => chatLento(l, r, { conversaciones: 10, turnos: 6, huecoMs: 8 * 60_000 })],
];

async function correr(escenario: Escenario, montar: (sim: CacheAnthropicSimulada, r: Reloj) => Capa) {
  const r = reloj();
  const sim = new CacheAnthropicSimulada(r.ahora);
  const layer = montar(sim, r);
  const c = contable(layer);
  await escenario(layer, r);
  return { sim, ...c, factura: dolares(sim.total(), PRECIO_SONNET_4_5) };
}

// La traza del colocador sin el campo que solo existe con almacén.
const decisiones = (informes: SavingsResult<unknown>["report"][]) =>
  informes.map((i) => ({
    actual: i.cost.actual,
    trazas: i.traces
      .filter((t) => t.stage === "prefix-cache-placement" || t.stage === "prefix-cache")
      .map((t) => {
        const { mirrorStore: _fuera, ...resto } = (t.detail ?? {}) as Record<string, unknown>;
        return [t.stage, t.outcome, resto];
      }),
  }));

// ─── 1 y 2. Sin almacén nada cambia; con almacén y una instancia, tampoco ────

/**
 * Huella de los cuerpos que salieron por el cable y del `cost.actual` de cada
 * petición, con `cacheBreakpoints: "auto"` y SIN almacén, grabada en
 * origin/main (c8f0c0c) antes de que el almacén existiera.
 *
 * Si otro cambio LEGÍTIMO toca lo que el colocador pone en el cable, este test
 * falla y hay que regrabar las huellas (el mismo cálculo que `huellaDelCable`).
 * Lo que NO puede pasar es que las cambie el almacén: sin él, el camino es el
 * de siempre.
 */
const HUELLAS_DE_C8F0C0C: Record<string, string> = {
  agente: "da9dd926acfab8de0764ba3b606ad2181dd9eb143d6ecc25848917c178ebafca",
  rag: "f1102df0c5095032c9fcdfd343ed7023d33dc542ed7ca5b74e214d9015b1803c",
  chat: "60c3d2763e978b1ae50518cfc24853fdcd9ce19c8d9bd5542bf8541137946355",
};

const huellaDelCable = (sim: CacheAnthropicSimulada, informes: SavingsResult<unknown>["report"][]) =>
  createHash("sha256")
    .update(JSON.stringify({ cuerpos: sim.cuerpos, actual: informes.map((i) => i.cost.actual) }))
    .digest("hex");

describe("sin almacén, el colocador es byte a byte el de antes", () => {
  for (const [nombre, escenario] of ESCENARIOS) {
    it(`⛔ ${nombre}: el cable y cost.actual coinciden con la huella grabada en c8f0c0c`, async () => {
      const { sim, informes } = await correr(escenario, (s, r) => capa(s, r));
      expect(huellaDelCable(sim, informes)).toBe(HUELLAS_DE_C8F0C0C[nombre]);
    });
  }
});

describe("con almacén y UNA instancia, las decisiones son las mismas que sin él", () => {
  for (const [nombre, escenario] of ESCENARIOS) {
    it(`${nombre}: mismos cuerpos, mismas trazas, mismo coste`, async () => {
      const sin = await correr(escenario, (s, r) => capa(s, r));
      const con = await correr(escenario, (s, r) => capa(s, r, new InMemoryCacheBreakpointStore({ now: r.ahora })));
      expect(con.sim.cuerpos).toEqual(sin.sim.cuerpos);
      expect(decisiones(con.informes)).toEqual(decisiones(sin.informes));
      // Y el almacén se usó de verdad: la primera petición lo encontró vacío y el resto, cargado.
      const estados = con.trazas("prefix-cache-placement").map((t) => t.detail?.["mirrorStore"]).filter(Boolean);
      expect(estados[0]).toBe("empty");
      expect(estados.slice(1).every((e) => e === "loaded" || e === "empty")).toBe(true);
      expect(estados.filter((e) => e === "loaded").length).toBeGreaterThan(estados.length / 2);
    });
  }
});

// ─── 3. Serverless: una capa nueva por petición ─────────────────────────────

describe("serverless: una instancia nueva en cada petición", () => {
  const AGENTE: Escenario = (l, r) => agente(l, r, { runs: 6, pasos: 12, huecoMs: 4000, entreRuns: 30_000 });
  const conCola = (f: { puntos: { bloque: number }[]; totalBloques: number }) =>
    f.totalBloques > 2 && f.puntos.some((p) => p.bloque === f.totalBloques - 1);

  it("⛔ sin almacén no aprende nunca: ni una petición marca la cola", async () => {
    let capas!: ReturnType<typeof unaPorPeticion>;
    const { sim } = await correr(AGENTE, (s, r) => (capas = unaPorPeticion(() => capa(s, r))));
    expect(capas.instancias()).toBe(72);
    expect(sim.facturas.some(conCola)).toBe(false);
  });

  it("con un almacén compartido cada instancia aprende de las anteriores, y la factura es la de un servidor que no reinicia", async () => {
    const largo = await correr(AGENTE, (s, r) => capa(s, r));
    const sinAlmacen = await correr(AGENTE, (s, r) => unaPorPeticion(() => capa(s, r)));
    let store!: InMemoryCacheBreakpointStore;
    const conAlmacen = await correr(AGENTE, (s, r) => {
      store = new InMemoryCacheBreakpointStore({ now: r.ahora });
      return unaPorPeticion(() => capa(s, r, store));
    });
    expect(conAlmacen.sim.facturas.filter(conCola).length).toBeGreaterThan(40);
    expect(conAlmacen.factura).toBeLessThan(0.5 * sinAlmacen.factura);
    // La verja de aciertos vive en cada instancia (y en una nueva explora, o
    // sea marca): lo que decide dónde es el espejo, y ese sí es el mismo.
    expect(conAlmacen.factura).toBeCloseTo(largo.factura, 6);
    expect(store.size).toBe(1);
  });

  it("un cliente de KV que devuelve el JSON ya parseado (Upstash, Vercel KV) funciona igual", async () => {
    const interior = new InMemoryCacheBreakpointStore();
    const deserializa: CacheBreakpointStore = {
      get: async (k) => {
        const v = await interior.get(k);
        return v == null ? null : JSON.parse(v);
      },
      set: async (k, v, ttl) => {
        await interior.set(k, v, ttl);
        return "OK";
      },
    };
    const { sim, trazas } = await correr(AGENTE, (s, r) => unaPorPeticion(() => capa(s, r, deserializa)));
    expect(sim.facturas.filter(conCola).length).toBeGreaterThan(40);
    expect(trazas("prefix-cache-placement").some((t) => t.detail?.["mirrorStore"] === "unreadable")).toBe(false);
  });

  it("la segunda instancia aprende de la primera: lo que una midió, la otra lo usa en su primera petición", async () => {
    const r = reloj();
    const sim = new CacheAnthropicSimulada(r.ahora);
    const store = new InMemoryCacheBreakpointStore({ now: r.ahora });
    const msgs: ChatMessage[] = [
      { role: "system", content: "Eres un agente de código. Lee antes de editar. ".repeat(300) },
      { role: "user", content: "Tarea: arregla el test que falla." },
    ];
    const paso = async (layer: Capa, i: number) => {
      const res = await layer.generate({ model: "anthropic/claude-sonnet-4-5", messages: msgs.map((m) => ({ ...m })) } as SavingsRequest);
      r.avanzar(4000);
      const id = `c${i}`;
      msgs.push({ role: "assistant", content: `Leo ${i}.`, toolCalls: [{ id, name: "leer", arguments: `{"i":${i}}` }] });
      msgs.push({ role: "tool", toolCallId: id, name: "leer", content: `resultado ${i} `.repeat(600) });
      return res.report.traces.find((t) => t.stage === "prefix-cache-placement")!;
    };
    // La instancia A hace seis pasos: con 5 de 5 continuaciones ya es concluyente.
    const a = capa(sim, r, store);
    for (let i = 0; i < 6; i++) await paso(a, i);
    // La B nace ahora. Con el almacén, su PRIMERA petición ya marca la cola.
    const b = await paso(capa(sim, r, store), 6);
    expect(b.detail?.["mirrorStore"]).toBe("loaded");
    expect(b.detail?.["tail"]).toBe(true);
    expect(String(b.detail?.["reason"])).toMatch(/tail marked/);
    // Una C sin almacén, en el mismo punto, empieza de cero.
    const c = await paso(capa(sim, r), 7);
    expect(c.detail?.["tail"]).toBe(false);
    expect(String(c.detail?.["reason"])).toMatch(/not conclusive yet/);
  });
});

// ─── 4. Un almacén que falla ────────────────────────────────────────────────

class AlmacenRoto implements CacheBreakpointStore {
  escrituras = 0;
  constructor(
    private readonly falla: { get?: boolean; set?: boolean },
    readonly interior = new InMemoryCacheBreakpointStore(),
  ) {}
  async get(k: string) {
    if (this.falla.get) throw new Error("redis://usuario:secreto@host:6379 ECONNREFUSED");
    return this.interior.get(k);
  }
  async set(k: string, v: string, ttl: number) {
    this.escrituras++;
    if (this.falla.set) throw new Error("redis://usuario:secreto@host:6379 READONLY");
    return this.interior.set(k, v, ttl);
  }
}

describe("un almacén que falla no rompe nada ni borra lo aprendido", () => {
  const PASOS: Escenario = (l, r) => agente(l, r, { runs: 1, pasos: 8, huecoMs: 4000, entreRuns: 0 });

  it("si la lectura falla: colocación fija, la petición sale, NO se escribe y la traza no filtra el error", async () => {
    const roto = new AlmacenRoto({ get: true });
    const fija = await correr(PASOS, (s, r) => unaPorPeticion(() => capa(s, r)));
    const con = await correr(PASOS, (s, r) => unaPorPeticion(() => capa(s, r, roto)));
    expect(con.sim.cuerpos).toEqual(fija.sim.cuerpos);
    expect(roto.escrituras).toBe(0);
    const trazas = con.trazas("prefix-cache-placement");
    expect(trazas.filter((t) => t.detail?.["mirrorStore"] === "unavailable")).toHaveLength(8);
    expect(trazas.filter((t) => t.outcome === "store-error")).toHaveLength(8);
    expect(JSON.stringify(trazas)).not.toMatch(/secreto|redis:\/\//);
  });

  it("si la escritura falla: la petición sale y la traza lo dice", async () => {
    const roto = new AlmacenRoto({ set: true });
    const con = await correr(PASOS, (s, r) => capa(s, r, roto));
    expect(con.informes).toHaveLength(8);
    const errores = con.trazas("prefix-cache-placement").filter((t) => t.outcome === "store-error");
    expect(errores).toHaveLength(8);
    expect(String(errores[0]!.detail?.["reason"])).toMatch(/could not write the placement store \(Error\)/);
    expect(JSON.stringify(errores)).not.toMatch(/secreto/);
  });

  it("lo que escribió un SDK más nuevo no se lee ni se pisa; lo ilegible se trata como vacío y se rehace", async () => {
    const store = new InMemoryCacheBreakpointStore();
    const r = reloj();
    const sim = new CacheAnthropicSimulada(r.ahora);
    const layer = capa(sim, r, store);
    // Una pregunta distinta cada vez: la misma saldría de la caché exacta sin llamar.
    let n = 0;
    const req = () =>
      ({ model: "anthropic/claude-sonnet-4-5", messages: [
        { role: "system", content: "Reglas fijas. ".repeat(400) },
        { role: "user", content: `pregunta ${n++}` },
      ] }) as SavingsRequest;
    await layer.generate(req());
    const [clave] = [...(store as unknown as { entradas: Map<string, unknown> }).entradas.keys()];
    const futuro = JSON.stringify({ v: 99, lo: "que sea" });
    await store.set(clave!, futuro, 60_000);
    const res = await layer.generate(req());
    const t = res.report.traces.filter((x) => x.stage === "prefix-cache-placement");
    expect(t[0]!.detail?.["mirrorStore"]).toBe("unreadable");
    expect(t.some((x) => x.outcome === "store-error" && /newer SDK/.test(String(x.detail?.["reason"])))).toBe(true);
    expect(await store.get(clave!)).toBe(futuro);

    await store.set(clave!, "{basura", 60_000);
    const otra = await layer.generate(req());
    expect(otra.report.traces.find((x) => x.stage === "prefix-cache-placement")!.detail?.["mirrorStore"]).toBe("unreadable");
    expect(JSON.parse((await store.get(clave!))!).v).toBe(1);
  });
});

// ─── 5. Qué hay en el almacén ───────────────────────────────────────────────

describe("en el almacén solo hay huellas y cuentas", () => {
  it("ni una palabra del prompt: claves con la huella de la clase y valores sin texto", async () => {
    const store = new InMemoryCacheBreakpointStore();
    const r = reloj();
    const sim = new CacheAnthropicSimulada(r.ahora);
    const layer = capa(sim, r, store);
    await agente(layer, r, { runs: 2, pasos: 6, huecoMs: 4000, entreRuns: 1000 });
    const entradas = (store as unknown as { entradas: Map<string, { valor: string }> }).entradas;
    expect(entradas.size).toBe(1);
    for (const [k, { valor }] of entradas) {
      expect(k).toMatch(/^bvsala:cache-breakpoints:v1:[0-9a-z]+\.[0-9a-z]+$/);
      for (const palabra of ["agente", "Tarea", "fichero", "leer_fichero", "arregla", "claude"]) {
        expect(valor).not.toContain(palabra);
        expect(k).not.toContain(palabra);
      }
    }
  });
});

// ─── El espejo, pieza a pieza ───────────────────────────────────────────────

describe("EspejoDeCache: exportar e importar una clase", () => {
  const msg = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });

  it("un espejo restaurado sigue exactamente como el que no se paró: mismas coincidencias y misma estadística", () => {
    const vivo = new EspejoDeCache();
    let restaurado = new EspejoDeCache();
    const base = [msg("system", "reglas")];
    let t = 1_000_000;
    let hilo = [...base, msg("user", "q0")];
    for (let i = 0; i < 40; i++) {
      const huellas = huellasDePrefijos("raiz", hilo);
      const clase = huellas[1]!;
      const a = vivo.observar(clase, huellas, t);
      const b = restaurado.observar(clase, huellas, t);
      expect(b).toEqual(a);
      const reg = { clase, huellas, tramos: { S: 1, T: hilo.length }, enviada: t, ultimoMarcado: "T" as const, posicionDelProveedor: 100 + i, ttl: "5m" as const };
      vivo.registrar(reg);
      restaurado.registrar(reg);
      if (a) {
        vivo.verificar(clase, a, i % 3 === 0 ? 0 : 1e9);
        restaurado.verificar(clase, b!, i % 3 === 0 ? 0 : 1e9);
      }
      // Reinicio en cada petición: exportar, pasar por texto, importar en uno nuevo.
      const texto = restaurado.exportarClase(clase);
      restaurado = new EspejoDeCache();
      expect(restaurado.importarClase(clase, texto)).toBe("loaded");
      expect(restaurado.estadistica(clase, t)).toEqual(vivo.estadistica(clase, t));
      // Cada tanto, una conversación nueva; a veces, un hueco de más de 5 min.
      hilo = i % 7 === 6 ? [...base, msg("user", `q${i}`)] : [...hilo, msg("assistant", `a${i}`), msg("user", `q${i}`)];
      t += i % 5 === 4 ? 6 * 60_000 : 4000;
    }
    expect(vivo.estadistica(huellasDePrefijos("raiz", base.concat(msg("user", "x")))[1]!, t).T.muestras5m).toBeGreaterThan(10);
  });

  it("una instantánea de otra clase, mal formada o con cuentas imposibles no se carga", () => {
    const e = new EspejoDeCache();
    const huellas = huellasDePrefijos("raiz", [msg("system", "s"), msg("user", "u")]);
    e.registrar({ clase: huellas[1]!, huellas, tramos: { S: 1, T: 2 }, enviada: 0 });
    const bueno = JSON.parse(e.exportarClase(huellas[1]!));
    const casos = [
      "no es json",
      JSON.stringify({ ...bueno, clase: "otra" }),
      JSON.stringify({ ...bueno, c: { ...bueno.c, S: [[1, 2, 0], [0, 0, 0], [0, 0, 0]] } }),
      JSON.stringify({ ...bueno, e: [["", "S", 1, 0, 0, 0, null, null, null]] }),
      JSON.stringify({ ...bueno, e: [["h.h", "S", 1, 0, 0, 0, null, null]] }),
      JSON.stringify({ ...bueno, cur: [9, 0, 0] }),
      JSON.stringify({ ...bueno, co: bueno.pr + 1 }),
    ];
    for (const texto of casos) expect(new EspejoDeCache().importarClase(huellas[1]!, texto)).toBe("invalid");
    expect(new EspejoDeCache().importarClase(huellas[1]!, JSON.stringify({ ...bueno, v: 2 }))).toBe("newer");
    expect(new EspejoDeCache().importarClase(huellas[1]!, JSON.stringify(bueno))).toBe("loaded");
    expect(claveDelAlmacen(huellas[1]!)).toBe(`bvsala:cache-breakpoints:v1:${huellas[1]}`);
  });
});

describe("InMemoryCacheBreakpointStore", () => {
  it("respeta el TTL con el reloj inyectado y acota el tamaño", async () => {
    let t = 0;
    const s = new InMemoryCacheBreakpointStore({ now: () => t, maxEntries: 2 });
    await s.set("a", "1", 1000);
    t = 1000;
    expect(await s.get("a")).toBe("1");
    t = 1001;
    expect(await s.get("a")).toBeNull();
    await s.set("a", "1", 10);
    await s.set("b", "2", 10);
    await s.set("c", "3", 10);
    expect(s.size).toBe(2);
    expect(await s.get("a")).toBeNull();
    expect(await s.get("c")).toBe("3");
  });
});
