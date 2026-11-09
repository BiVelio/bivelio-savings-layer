import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SavingsPipeline } from "../src/pipeline/pipeline.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * LA AUDITORÍA DE CACHE BREAKS, en el camino real del pipeline.
 *
 * Con un `system` que lleva un timestamp (el patrón nº1 de los que rompen la
 * caché de prefijo en silencio), la capa tiene que: (1) dejarlo escrito en
 * `report.traces` como `cache-audit`, y (2) avisar UNA vez por proceso con el
 * portero de avisos (`silenceWarnings` lo calla). Diagnóstico, no rewriting:
 * el texto que ve el proveedor no cambia.
 */

class Testigo implements Provider {
  readonly id = "testigo";
  readonly vistas: ProviderRequest[] = [];
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.vistas.push(req);
    return { text: "ok", usage: { inputTokens: 100, outputTokens: 10 } };
  }
}

function capa(provider: Provider, extra: Record<string, unknown> = {}): SavingsPipeline {
  return new SavingsPipeline({
    provider,
    tokenizer: new TokenizerRegistry(),
    devUnlicensed: true,
    ...extra,
  } as never);
}

function peticion(system: string): SavingsRequest {
  return {
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      { role: "system", content: system },
      { role: "user", content: "¿Cuánto tarda un envío?" },
    ],
  } as SavingsRequest;
}

beforeEach(() => {
  reiniciarAvisos();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cache-audit en el pipeline", () => {
  it("escribe la traza cache-audit cuando el system lleva un timestamp", async () => {
    const p = new Testigo();
    const r = await capa(p).generate(peticion("Generado a las 2026-11-09T10:00:00Z. Sé conciso."));
    const ev = r.report.traces.find((t) => t.stage === "cache-audit");
    expect(ev).toBeDefined();
    expect(ev!.outcome).toBe("mutable-system-prefix");
    expect(ev!.detail?.patrones).toContain("iso-timestamp");
  });

  it("no escribe la traza cuando el system es estable", async () => {
    const p = new Testigo();
    const r = await capa(p).generate(peticion("Eres un asistente. Sé conciso."));
    expect(r.report.traces.some((t) => t.stage === "cache-audit")).toBe(false);
  });

  it("avisa una sola vez por proceso y patrón", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = new Testigo();
    const capaInstancia = capa(p);
    const system = "Sesión 2026-11-09T10:00:00Z.";
    await capaInstancia.generate(peticion(system));
    await capaInstancia.generate(peticion(system));
    const mensajes = aviso.mock.calls.map((c) => String(c[0]));
    expect(mensajes.filter((m) => m.includes("prompt cache")).length).toBe(1);
  });

  it("el aviso se calla con silenceWarnings", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = new Testigo();
    await capa(p, { silenceWarnings: true }).generate(peticion("Sesión 2026-11-09T10:00:00Z."));
    expect(aviso.mock.calls.filter((c) => String(c[0]).includes("prompt cache"))).toHaveLength(0);
  });

  it("no reescribe el system: el proveedor recibe el texto tal cual", async () => {
    const p = new Testigo();
    const system = "Sesión 2026-11-09T10:00:00Z.";
    await capa(p).generate(peticion(system));
    const visto = p.vistas[0]!.messages?.find((m) => m.role === "system");
    expect(visto?.content).toContain("2026-11-09T10:00:00Z");
  });
});
