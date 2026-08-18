import { describe, it, expect } from "vitest";

import {
  CarryoverPorHash,
  carryoverEnLote,
  compresorConCarryover,
} from "../src/cache/carryover.js";
import { InMemorySemanticCache } from "../src/cache/semantic.js";
import { embebedorLocal } from "../src/cache/embedder-local.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import type { CanonicalRequest } from "../src/canonicalization/canonicalize.js";
import type { Compressor } from "../src/compression/compression.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
} from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * Carry-over por content-hash: el pase auxiliar se paga UNA vez por versión de
 * contenido, nunca por petición.
 *
 * Dos consumidores quedan fijados aquí además del mecanismo:
 *
 *  · la caché semántica pagaba un embed traído DOS veces en cada miss (find()
 *    embebe la consulta, store() re-embebe el mismo normalizedText);
 *  · el pipeline pagaba el compresor por el mismo contenido en cada petición
 *    que lo repitiera.
 *
 * Y una frontera que los tests vigilan tanto como el ahorro: nada de esto toca
 * los 4 libros. Es gasto auxiliar de la capa, no tokens del cliente.
 */

// ─── El mecanismo ────────────────────────────────────────────────────────────

describe("CarryoverPorHash.obtener", () => {
  it("el mismo contenido paga el cálculo una sola vez", () => {
    const llamadas: string[] = [];
    const fn = (t: string) => {
      llamadas.push(t);
      return `${t}!`;
    };
    const memo = new CarryoverPorHash<string>();

    expect(memo.obtener("hola", fn)).toBe("hola!");
    expect(memo.obtener("hola", fn)).toBe("hola!");
    expect(llamadas).toEqual(["hola"]);
    expect(memo.stats()).toMatchObject({ aciertos: 1, fallos: 1 });
  });

  it("un cálculo síncrono se devuelve síncrono, en el fallo y en el acierto", async () => {
    const memo = new CarryoverPorHash<number[]>();
    const fallo = memo.obtener("abc", (t) => [t.length]);
    // Sin `await`: envolver al embebedor local no puede añadir un salto de
    // microtarea al camino de la petición.
    expect(Array.isArray(fallo)).toBe(true);
    const acierto = memo.obtener("abc", (t) => [t.length]);
    expect(acierto).toBe(fallo);

    // Y tras un fallo ASÍNCRONO ya resuelto, el acierto también es síncrono.
    await memo.obtener("xyz", async (t) => [t.length]);
    expect(Array.isArray(memo.obtener("xyz", async (t) => [t.length]))).toBe(true);
  });

  it("dos lecturas concurrentes comparten UNA ejecución (coalescencia)", async () => {
    let resolver!: (v: string) => void;
    let llamadas = 0;
    const fn = () =>
      new Promise<string>((res) => {
        llamadas += 1;
        resolver = res;
      });
    const memo = new CarryoverPorHash<string>();

    const p1 = memo.obtener("t", fn);
    const p2 = memo.obtener("t", fn);
    expect(p2).toBe(p1);
    resolver("v");
    await expect(p1).resolves.toBe("v");
    expect(llamadas).toBe(1);
    expect(memo.stats()).toMatchObject({ fallos: 1, coalescidas: 1 });
  });

  it("un error NUNCA se memoriza: el siguiente lector reintenta", async () => {
    let intentos = 0;
    const fn = async () => {
      intentos += 1;
      if (intentos === 1) throw new Error("boom");
      return "ok";
    };
    const memo = new CarryoverPorHash<string>();

    await expect(Promise.resolve(memo.obtener("e", fn))).rejects.toThrow("boom");
    await expect(Promise.resolve(memo.obtener("e", fn))).resolves.toBe("ok");
    expect(intentos).toBe(2);
  });

  it("el tope expulsa por LRU real: tocar una entrada la salva", () => {
    const llamadas: string[] = [];
    const fn = (t: string) => {
      llamadas.push(t);
      return t;
    };
    const memo = new CarryoverPorHash<string>({ maxEntradas: 2 });

    memo.obtener("a", fn);
    memo.obtener("b", fn);
    memo.obtener("a", fn); // toque: «a» pasa a ser la más reciente
    memo.obtener("c", fn); // expulsa a «b», no a «a»
    expect(memo.size).toBe(2);

    memo.obtener("a", fn); // sigue dentro
    memo.obtener("b", fn); // expulsada: se recalcula
    expect(llamadas).toEqual(["a", "b", "c", "b"]);
  });

  it("invalidar deja la entrada stale con el valor viejo como pista, y no sirve lecturas", () => {
    let llamadas = 0;
    const fn = () => {
      llamadas += 1;
      return `v${llamadas}`;
    };
    const memo = new CarryoverPorHash<string>();

    expect(memo.obtener("x", fn)).toBe("v1");
    expect(memo.invalidar("x")).toBe(true);
    expect(memo.invalidar("nunca-guardado")).toBe(false);
    // La pista sigue legible para quien la quiera (un resumidor futuro puede
    // sembrar con ella), pero una lectura normal recomputa.
    expect(memo.inspeccionar("x")).toEqual({ estado: "stale", valor: "v1" });
    expect(memo.obtener("x", fn)).toBe("v2");
    expect(memo.inspeccionar("x")).toEqual({ estado: "ready", valor: "v2" });
  });

  it("invalidar alcanza a un cálculo EN VUELO: aterriza como pista, no como valor vivo", async () => {
    let resolver!: (v: string) => void;
    let llamadas = 0;
    const fn = () =>
      new Promise<string>((res) => {
        llamadas += 1;
        resolver = res;
      });
    const memo = new CarryoverPorHash<string>();

    const p = memo.obtener("doc", fn);
    // La única computación está en el aire: invalidar TIENE que verla (antes
    // devolvía false y el vuelo aterrizaba como ready, perdiendo la invalidación).
    expect(memo.invalidar("doc")).toBe(true);
    resolver("pre-invalidacion");
    await expect(p).resolves.toBe("pre-invalidacion");
    expect(memo.inspeccionar("doc")).toEqual({
      estado: "stale",
      valor: "pre-invalidacion",
    });
    // Y el siguiente lector recomputa en limpio.
    const q = memo.obtener("doc", fn);
    resolver("fresco");
    await expect(q).resolves.toBe("fresco");
    expect(llamadas).toBe(2);
    expect(memo.inspeccionar("doc")).toEqual({ estado: "ready", valor: "fresco" });
  });
});

describe("carryoverEnLote — N contenidos, una llamada, y solo con los sucios", () => {
  it("deduplica, respeta el orden de primera aparición y alinea por posición", async () => {
    const memo = new CarryoverPorHash<string>();
    memo.guardar("b", "B!");
    memo.guardar("d", "D!");
    const lotes: (readonly string[])[] = [];
    const procesa = (sucios: readonly string[]) => {
      lotes.push(sucios);
      return sucios.map((s) => s.toUpperCase());
    };

    const resultado = await carryoverEnLote(["a", "b", "a", "c", "d"], procesa, memo);
    expect(lotes).toEqual([["a", "c"]]); // una llamada, solo sucios, «a» una vez
    expect(resultado).toEqual(["A", "B!", "A", "C", "D!"]);

    // Segunda pasada: todo en caché, cero llamadas.
    await carryoverEnLote(["a", "b", "c", "d"], procesa, memo);
    expect(lotes).toHaveLength(1);
  });

  it("un transformador desalineado es un error, no una caché corrupta", async () => {
    const memo = new CarryoverPorHash<string>();
    await expect(
      carryoverEnLote(["a", "b"], () => ["solo-uno"], memo),
    ).rejects.toThrow(/1 resultados para 2 contenidos/);
    // Y no dejó nada a medias que un lector posterior pudiera confundir.
    expect(memo.size).toBe(0);
  });

  it("un lote mayor que el tope devuelve TODO: la caché es memo, no el canal de retorno", async () => {
    const memo = new CarryoverPorHash<string>({ maxEntradas: 2 });
    let lotes = 0;
    const resultado = await carryoverEnLote(
      ["a", "b", "c", "d"],
      (sucios) => {
        lotes += 1;
        return sucios.map((s) => s.toUpperCase());
      },
      memo,
    );
    // Antes: la relectura final pasaba por la LRU, que ya había expulsado a los
    // primeros miembros del propio lote → error tras PAGAR la llamada entera.
    expect(resultado).toEqual(["A", "B", "C", "D"]);
    expect(lotes).toBe(1);
    expect(memo.size).toBeLessThanOrEqual(2);
  });

  it("maxEntradas 0 se clampa en vez de convertir cada lote en un error", async () => {
    const memo = new CarryoverPorHash<string>({ maxEntradas: 0 });
    const resultado = await carryoverEnLote(["a"], (s) => s.map((x) => `${x}!`), memo);
    expect(resultado).toEqual(["a!"]);
    expect(memo.size).toBe(1);
  });
});

// ─── Consumidor 1: el compresor ──────────────────────────────────────────────

function compresorContador(
  opts: { skipped?: boolean; fidelityPassed?: boolean } = {},
) {
  const estado = { llamadas: 0 };
  const compresor: Compressor = {
    async compress({ text }) {
      estado.llamadas += 1;
      const podado = text
        .split(/\s+/)
        .filter((p) => p !== "RUIDO")
        .join(" ");
      return {
        compressed: podado,
        skipped: opts.skipped ?? false,
        fidelityPassed: opts.fidelityPassed ?? true,
        originalTokens: text.length,
        compressedTokens: podado.length,
        protectedSpans: 0,
        reason: "poda de prueba",
      };
    },
  };
  return { estado, compresor };
}

describe("compresorConCarryover", () => {
  it("la misma entrada comprime una vez y re-sirve el MISMO resultado", async () => {
    const { estado, compresor } = compresorContador();
    const envuelto = compresorConCarryover(compresor);

    const req = { text: "RUIDO texto RUIDO útil" };
    const primero = await envuelto.compress(req);
    const segundo = await envuelto.compress(req);
    expect(estado.llamadas).toBe(1);
    expect(segundo).toEqual(primero);
  });

  it("un resultado skipped o sin fidelidad NO se recuerda", async () => {
    for (const caso of [{ skipped: true }, { fidelityPassed: false }]) {
      const { estado, compresor } = compresorContador(caso);
      const envuelto = compresorConCarryover(compresor);
      await envuelto.compress({ text: "igual" });
      await envuelto.compress({ text: "igual" });
      expect(estado.llamadas).toBe(2);
    }
  });

  it("ratio y spans protegidos forman parte de la identidad de la entrada", async () => {
    const { estado, compresor } = compresorContador();
    const envuelto = compresorConCarryover(compresor);

    await envuelto.compress({ text: "mismo texto", targetRatio: 0.5 });
    await envuelto.compress({ text: "mismo texto", targetRatio: 0.8 });
    expect(estado.llamadas).toBe(2);

    // La frontera span/texto no puede ser ambigua: mover «b» de un lado a otro
    // tiene que producir claves DISTINTAS.
    await envuelto.compress({ text: "c", protectedSpans: [{ id: "x", text: "a b" }] });
    await envuelto.compress({ text: "b c", protectedSpans: [{ id: "x", text: "a" }] });
    expect(estado.llamadas).toBe(4);
  });

  it("un span con comillas y corchetes no fabrica la clave de otra petición (inyectividad)", async () => {
    const { estado, compresor } = compresorContador();
    const envuelto = compresorConCarryover(compresor);
    // El intento de inyección contra un concatenador ingenuo: el texto del span
    // imita la codificación de dos spans. stableStringify escapa y no colisiona.
    await envuelto.compress({
      text: "t",
      protectedSpans: [{ id: "x", text: 'a"],["y","b' }],
    });
    await envuelto.compress({
      text: "t",
      protectedSpans: [
        { id: "x", text: "a" },
        { id: "y", text: "b" },
      ],
    });
    expect(estado.llamadas).toBe(2);
  });

  it("un resultado que excede el tope de bytes se sirve pero NO se recuerda", async () => {
    const { estado, compresor } = compresorContador();
    const envuelto = compresorConCarryover(compresor, { maxBytesPorEntrada: 4 });
    const req = { text: "RUIDO contenido bastante mas largo que cuatro bytes" };
    await envuelto.compress(req);
    await envuelto.compress(req);
    // Se pagó dos veces: el resultado era demasiado grande para quedarse.
    expect(estado.llamadas).toBe(2);
  });
});

// ─── Consumidor 2: la caché semántica ────────────────────────────────────────

const canonica = (texto: string): CanonicalRequest => {
  const original: SavingsRequest = {
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: texto }],
  };
  return {
    model: "openai/gpt-4o-mini",
    modelFamily: "gpt-4o-mini",
    messages: [{ role: "user", content: texto }],
    normalizedText: texto,
    systemPromptHash: "sys",
    toolsetHash: "tools",
    structuredDataHash: "data",
    schemaVersion: "v1",
    contractId: null,
    temperature: null,
    seed: null,
    tenantId: "t1",
    authorizationScope: "default",
    principal: null,
    locale: "es",
    knowledgeEpoch: "e1",
    freshnessBucket: "f",
    safetyPolicyVersion: "s1",
    tokenizer: undefined,
    original,
  };
};

describe("caché semántica — un embed traído se paga una vez por texto", () => {
  it("store() reutiliza el embedding y el miss deja de pagar doble", async () => {
    let llamadas = 0;
    const embed = async (texto: string) => {
      llamadas += 1;
      return [texto.length, 1, 2];
    };
    const cache = new InMemorySemanticCache({ embed });
    const c1 = canonica("cuantos asientos activos hay");

    // Con la caché vacía find() ni siquiera embebe (comportamiento previo).
    expect(await cache.find(c1)).toBeNull();
    expect(llamadas).toBe(0);

    await cache.store(c1, { text: "42", storedAtMs: 0 });
    expect(llamadas).toBe(1);

    // Antes: find() re-embebía el mismo texto → 2 llamadas. Ahora: carry-over.
    const hit = await cache.find(c1);
    expect(hit?.record.answer.text).toBe("42");
    expect(llamadas).toBe(1);

    // Y el camino del miss real (find embebe, store re-embebía): una llamada,
    // no dos, para el texto nuevo.
    const c2 = canonica("otro texto distinto");
    expect(await cache.find(c2)).toBeNull();
    await cache.store(c2, { text: "43", storedAtMs: 0 });
    expect(llamadas).toBe(2);
  });

  it("el embebedor local NO se envuelve: microsegundos y cero dinero no se memorizan", () => {
    const cache = new InMemorySemanticCache();
    // Identidad, no comportamiento: si alguien envuelve el local, esto cae.
    expect((cache as unknown as { embed: unknown }).embed).toBe(embebedorLocal);
  });

  it("embebedorLocal pasado EXPLÍCITO tampoco se envuelve: la verja es de identidad", () => {
    // embebedorLocal es export público: una capa de config que siempre rellena
    // `embed` lo pasa explícito, y tiene que recibir el mismo trato que omitirlo.
    const cache = new InMemorySemanticCache({ embed: embebedorLocal });
    expect((cache as unknown as { embed: unknown }).embed).toBe(embebedorLocal);
  });

  it("un embedding vacío o de ceros NO queda fijado en el memo", async () => {
    let llamadas = 0;
    const embed = async (texto: string) => {
      llamadas += 1;
      // Primer intento degradado (fallback vacío de un SDK), después el real.
      return llamadas === 1 ? [] : [texto.length, 1, 2];
    };
    const cache = new InMemorySemanticCache({ embed });
    const c = canonica("consulta con embedder degradado");

    await cache.store(c, { text: "42", storedAtMs: 0 }); // 1ª llamada: []
    // Sin veto, el [] quedaría memoizado y este find lo reutilizaría para
    // siempre (miss silencioso permanente); con veto, se re-paga el embed y
    // llega el vector bueno.
    await cache.find(c);
    expect(llamadas).toBe(2);
  });
});

// ─── Consumidor 2b: el pipeline entero ───────────────────────────────────────

class ProveedorFijo implements Provider {
  readonly id = "fijo";
  llamadas = 0;
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    this.llamadas += 1;
    return { text: "ok", usage: { inputTokens: 100, outputTokens: 10 } };
  }
}

const repetir = (palabra: string, veces: number): string =>
  Array.from({ length: veces }, () => palabra).join(" ");

describe("pipeline — el compresor no se paga dos veces por el mismo contenido", () => {
  it("la segunda petición idéntica re-sirve la compresión y la contabilidad no cambia", async () => {
    const { estado, compresor } = compresorContador();
    const proveedor = new ProveedorFijo();
    const capa = createSavingsLayer({ provider: proveedor, compressor: compresor });

    // El caso de la verja 3 del banco: contexto largo de verdad, el compresor
    // SÍ corre. exactCache apagada para que la segunda petición llegue al
    // proveedor (y por tanto a la etapa de compresión) en vez de servirse.
    const texto = `${repetir("RUIDO", 700)} ${repetir("texto", 350)}`;
    const peticion = (): SavingsRequest => ({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: texto }],
      savings: { compression: true, exactCache: false },
    });

    const res1 = await capa.generate(peticion());
    const trasLaPrimera = estado.llamadas;
    expect(trasLaPrimera).toBeGreaterThan(0);

    const res2 = await capa.generate(peticion());
    // El proveedor sí se pagó dos veces (la caché exacta está apagada)…
    expect(proveedor.llamadas).toBe(2);
    // …pero el sidecar de compresión, no: mismo contenido, carry-over.
    expect(estado.llamadas).toBe(trasLaPrimera);
    // Y la decisión económica sale idéntica con el resultado re-servido.
    expect(res2.report.tokens.compressedInput).toBe(res1.report.tokens.compressedInput);
  });

  it("el memo de compresión NO cruza tenants: mismo texto, tenants distintos, dos pagos", async () => {
    const { estado, compresor } = compresorContador();
    const proveedor = new ProveedorFijo();
    const capa = createSavingsLayer({ provider: proveedor, compressor: compresor });
    const texto = `${repetir("RUIDO", 700)} ${repetir("texto", 350)}`;
    const peticion = (tenantId: string): SavingsRequest => ({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: texto }],
      context: { tenantId },
      savings: { compression: true, exactCache: false },
    });

    await capa.generate(peticion("tenant-a"));
    const trasA = estado.llamadas;
    expect(trasA).toBeGreaterThan(0);
    // Otro tenant, mismo contenido: un memo compartido le serviría a coste ~0 y
    // delataría que otro tenant envió ese mismo contenido. Paga su propio pase.
    await capa.generate(peticion("tenant-b"));
    expect(estado.llamadas).toBe(trasA * 2);
    // Y el mismo tenant repitiendo sí re-sirve del suyo.
    await capa.generate(peticion("tenant-b"));
    expect(estado.llamadas).toBe(trasA * 2);
  });
});
