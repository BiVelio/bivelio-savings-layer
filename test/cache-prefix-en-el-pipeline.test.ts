import { describe, expect, it } from "vitest";

import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * EL REORDEN DEL PREFIJO CACHEABLE, en el camino real del pipeline.
 *
 * Con `savings.cachePrefix: true` y un `system` que lleva un timestamp (el
 * patrón nº1 de los que rompen la caché de prefijo en silencio), la capa tiene
 * que: (1) partir la cabecera en [estable][mutable], (2) declarar prefijo solo
 * la parte estable (`stablePrefixMessages: 1`), (3) trazarlo, (4) NO mutar el
 * request del llamante, y (5) callar la auditoría de cache breaks (la cola
 * mutable ya está fuera del prefijo). Sin el flag, la petición viaja tal cual.
 */

class Testigo implements Provider {
  readonly id = "testigo";
  readonly vistas: ProviderRequest[] = [];
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.vistas.push(req);
    return { text: "ok", usage: { inputTokens: 100, outputTokens: 10 } };
  }
}

function capa(provider: Provider): SavingsPipeline {
  return new SavingsPipeline({ provider, tokenizer: new TokenizerRegistry(), devUnlicensed: true } as never);
}

const SISTEMA_CON_FECHA = "Eres un asistente.\nHoy es 2026-11-15T10:00:00Z.\nSé conciso.";

function peticion(system: string, cachePrefix?: boolean): SavingsRequest {
  return {
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      { role: "system", content: system },
      { role: "user", content: "¿Cuánto tarda un envío?" },
    ],
    ...(cachePrefix !== undefined ? { savings: { cachePrefix } } : {}),
  } as SavingsRequest;
}

describe("cache-prefix en el pipeline", () => {
  it("con cachePrefix parte la cabecera y declara prefijo solo la parte estable", async () => {
    const p = new Testigo();
    const r = await capa(p).generate(peticion(SISTEMA_CON_FECHA, true));
    const req = p.vistas[0]!;
    // La cabecera queda partida: [estable][mutable], y el usuario sigue.
    expect(req.messages).toHaveLength(3);
    expect(req.messages[0]).toEqual({ role: "system", content: "Eres un asistente.\nSé conciso." });
    expect(req.messages[1]).toEqual({ role: "system", content: "Hoy es 2026-11-15T10:00:00Z." });
    expect(req.messages[2]!.role).toBe("user");
    // Solo la parte estable se declara prefijo cacheable.
    expect(req.stablePrefixMessages).toBe(1);
    // La traza dice qué se movió y por qué.
    const ev = r.report.traces.find((t) => t.stage === "cache-prefix");
    expect(ev).toBeDefined();
    expect(ev!.outcome).toBe("reordered");
    expect(ev!.detail?.movedLines).toBe(1);
    expect(ev!.detail?.patterns).toContain("iso-timestamp");
    // La auditoría no dobla la advertencia: dentro del prefijo ya no hay mutable.
    expect(r.report.traces.some((t) => t.stage === "cache-audit")).toBe(false);
  });

  it("no muta el request del llamante", async () => {
    const p = new Testigo();
    const pet = peticion(SISTEMA_CON_FECHA, true);
    const original = JSON.parse(JSON.stringify(pet.messages));
    await capa(p).generate(pet);
    expect(pet.messages).toEqual(original);
  });

  it("sin el flag la petición viaja tal cual (un solo system, sin traza de reorden)", async () => {
    const p = new Testigo();
    const r = await capa(p).generate(peticion(SISTEMA_CON_FECHA));
    const req = p.vistas[0]!;
    expect(req.messages).toHaveLength(2);
    expect(req.messages[0]).toEqual({ role: "system", content: SISTEMA_CON_FECHA });
    expect(r.report.traces.some((t) => t.stage === "cache-prefix")).toBe(false);
  });

  it("con flag pero sin líneas mutables: traza skipped y petición intacta", async () => {
    const p = new Testigo();
    const r = await capa(p).generate(peticion("Eres un asistente. Sé conciso.", true));
    expect(p.vistas[0]!.messages).toHaveLength(2);
    const ev = r.report.traces.find((t) => t.stage === "cache-prefix");
    expect(ev?.outcome).toBe("skipped");
    expect(ev?.detail?.reason).toContain("no mutable lines");
  });

  it("con flag y todo el system mutable: skipped (no hay prefijo estable)", async () => {
    const p = new Testigo();
    const r = await capa(p).generate(peticion("Hoy es 2026-11-15T10:00:00Z.", true));
    expect(p.vistas[0]!.messages).toHaveLength(2);
    const ev = r.report.traces.find((t) => t.stage === "cache-prefix");
    expect(ev?.outcome).toBe("skipped");
  });
});
