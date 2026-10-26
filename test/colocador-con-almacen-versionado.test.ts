import { beforeEach, describe, expect, it } from "vitest";

import {
  InMemoryCacheBreakpointStore,
  type CacheBreakpointStore,
  type VersionedBreakpointValue,
  type VersionedCacheBreakpointStore,
} from "../src/cache/breakpoint-store.js";
import { EspejoDeCache } from "../src/economics/colocador-de-cache.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { ChatMessage, SavingsRequest } from "../src/contracts/types.js";
import { CacheAnthropicSimulada } from "../benchmarks/colocador-de-cache/simulador.js";
import { reloj } from "../benchmarks/colocador-de-cache/escenarios.js";

class AlmacenVersionado implements VersionedCacheBreakpointStore {
  private version = 0;
  private lecturasIniciales = 0;
  private esperando = 0;
  private liberar?: () => void;
  private barrera?: Promise<void>;
  conflictos = 0;

  constructor(
    private readonly interior = new InMemoryCacheBreakpointStore(),
    private readonly sincronizadas = 0,
  ) {}

  get(key: string): Promise<unknown> {
    return this.interior.get(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.version++;
    await this.interior.set(key, value, ttlMs);
  }

  async getVersioned(key: string): Promise<VersionedBreakpointValue | null> {
    const value = await this.interior.get(key);
    const actual = value == null && this.version === 0
      ? null
      : { value, version: String(this.version) };
    if (this.lecturasIniciales++ < this.sincronizadas) {
      this.barrera ??= new Promise<void>((resolve) => { this.liberar = resolve; });
      this.esperando++;
      if (this.esperando === this.sincronizadas) this.liberar?.();
      await this.barrera;
    }
    return actual;
  }

  async compareAndSet(
    key: string,
    value: string,
    ttlMs: number,
    expectedVersion: string | null,
  ): Promise<boolean> {
    await Promise.resolve();
    const actual = this.version === 0 ? null : String(this.version);
    if (actual !== expectedVersion) {
      this.conflictos++;
      return false;
    }
    await this.set(key, value, ttlMs);
    return true;
  }
}

beforeEach(() => reiniciarAvisos());

function capa(sim: CacheAnthropicSimulada, ahora: () => number, store: CacheBreakpointStore) {
  return createSavingsLayer({
    provider: new AnthropicProvider({ fetchImpl: sim.fetch }),
    cacheBreakpoints: "auto",
    cacheBreakpointStore: store,
    now: ahora,
    silenceWarnings: true,
  });
}

function peticion(n: number): SavingsRequest {
  const messages: ChatMessage[] = [
    { role: "system", content: "Reglas estables del agente. ".repeat(400) },
    { role: "user", content: `Solicitud independiente ${n}. `.repeat(400) },
  ];
  return { model: "anthropic/claude-sonnet-4-5", messages } as SavingsRequest;
}

describe("cacheBreakpointStore con compare-and-set", () => {
  it("fusiona todas las observaciones cuando 24 réplicas leen la misma revisión", async () => {
    const r = reloj();
    const sim = new CacheAnthropicSimulada(r.ahora);
    const store = new AlmacenVersionado(new InMemoryCacheBreakpointStore({ now: r.ahora }), 24);
    const resultados = await Promise.all(
      Array.from({ length: 24 }, (_, n) => capa(sim, r.ahora, store).generate(peticion(n))),
    );

    expect(resultados).toHaveLength(24);
    expect(store.conflictos).toBeGreaterThan(0);
    const [clave] = [...(store as unknown as {
      interior: { entradas: Map<string, unknown> };
    }).interior.entradas.keys()];
    const final = JSON.parse(String(await store.get(clave!))) as {
      v: number;
      e: [string, ...unknown[]][];
    };
    expect(final.v).toBe(1);
    expect(new Set(final.e.map((entrada) => entrada[0])).size, JSON.stringify(final)).toBeGreaterThanOrEqual(24);
    expect(
      resultados.flatMap((resultado) => resultado.report.traces).filter((traza) => traza.outcome === "store-error"),
    ).toHaveLength(0);
  });

  it("agota las fusiones acotadas sin recurrir a una escritura incondicional", async () => {
    const r = reloj();
    const sim = new CacheAnthropicSimulada(r.ahora);
    let lecturas = 0;
    let intentos = 0;
    let escrituras = 0;
    const store: VersionedCacheBreakpointStore = {
      get: async () => null,
      set: async () => { escrituras++; },
      getVersioned: async () => {
        lecturas++;
        return { value: null, version: "7" };
      },
      compareAndSet: async () => {
        intentos++;
        return false;
      },
    };
    const resultado = await capa(sim, r.ahora, store).generate(peticion(1));

    expect(resultado.text).toBeTypeOf("string");
    expect(lecturas).toBe(64);
    expect(intentos).toBe(64);
    expect(escrituras).toBe(0);
    const errores = resultado.report.traces.filter((traza) => traza.outcome === "store-error");
    expect(errores).toHaveLength(1);
    expect(String(errores[0]!.detail?.["reason"])).toContain("bounded merge budget");
  });

  it("no pisa una instantánea de un SDK más nuevo", async () => {
    const r = reloj();
    const sim = new CacheAnthropicSimulada(r.ahora);
    const futuro = JSON.stringify({ v: 99 });
    let intentos = 0;
    const store: VersionedCacheBreakpointStore = {
      get: async () => futuro,
      set: async () => undefined,
      getVersioned: async () => ({ value: futuro, version: "1" }),
      compareAndSet: async () => {
        intentos++;
        return true;
      },
    };
    const resultado = await capa(sim, r.ahora, store).generate(peticion(1));

    expect(intentos).toBe(0);
    expect(resultado.report.traces.some((traza) =>
      traza.outcome === "store-error" && /newer SDK/.test(String(traza.detail?.["reason"])),
    )).toBe(true);
    expect(new EspejoDeCache().importarClase("cualquiera", futuro)).toBe("newer");
  });
});
