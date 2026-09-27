import { describe, it, expect, beforeEach } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { SavingsRequest } from "../src/contracts/types.js";

/**
 * EL RESPALDO DE CAPACIDAD: OPCIONAL, APAGADO, Y UNA SOLA VEZ.
 *
 * Un tier barato sin capacidad no espera: falla. OpenAI contesta 429 «Resource
 * Unavailable» («You will not be charged when this occurs»); Google, 503 o 429
 * y nunca sube la petición a estándar por su cuenta. Con
 * `priceLevers.onCapacityError: "standard"` la capa la repite UNA vez sin
 * `service_tier`, a precio estándar, y lo dice; sin configurarlo, el error sale
 * tal cual, como siempre.
 */

const OFICIAL = "https://api.openai.com/v1";

/** Contesta en orden la lista de (estado, cuerpo) y captura cada cuerpo enviado. */
function secuencia(respuestas: { estado: number; cuerpo: unknown }[]) {
  const enviados: Record<string, unknown>[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    enviados.push(JSON.parse(String(init.body)));
    const r = respuestas[Math.min(i++, respuestas.length - 1)]!;
    return new Response(typeof r.cuerpo === "string" ? r.cuerpo : JSON.stringify(r.cuerpo), {
      status: r.estado,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { enviados, fetchImpl };
}

const OK_ESTANDAR = {
  estado: 200,
  cuerpo: {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
    service_tier: "default",
  },
};
const SIN_CAPACIDAD = { estado: 429, cuerpo: '{"error":{"message":"Resource Unavailable","type":"resource_unavailable"}}' };

const peticion: SavingsRequest = {
  model: "openai/gpt-5-mini",
  messages: [{ role: "user", content: "enriquece esta fila" }],
  savings: { deferrable: true },
};

beforeEach(() => reiniciarAvisos());

describe("priceLevers.onCapacityError", () => {
  it("\"standard\": 429 y luego 200 → dos fetch, el segundo SIN `service_tier`, y el informe lo dice", async () => {
    const s = secuencia([SIN_CAPACIDAD, OK_ESTANDAR]);
    const layer = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }),
      priceLevers: { onCapacityError: "standard" },
    });
    const r = await layer.generate(peticion);

    expect(s.enviados).toHaveLength(2);
    expect(s.enviados[0]!["service_tier"]).toBe("flex");
    expect(s.enviados[1]).not.toHaveProperty("service_tier");
    expect(r.text).toBe("ok");
    const d = r.report.deferred!;
    expect(d.capacityFallback).toBe(true);
    expect(d.requestedTier).toBe("flex");
    expect(d.servedTier).toBe("default");
    expect(d.credited).toBe(false);
    expect(d.tierSaving).toBeUndefined();
    expect(d.estimatedTierSaving).toBeUndefined();
    expect(d.reason).toMatch(/no capacity/);
    // El intento rechazado no es una llamada facturada.
    expect(r.report.calls.actualLlm).toBe(1);
    expect(r.report.traces.some((t) => t.stage === "deferred-tier" && t.outcome === "capacity-fallback")).toBe(true);
  });

  it("\"standard\" también con 503 (la forma de Google)", async () => {
    const s = secuencia([{ estado: 503, cuerpo: "Service Unavailable" }, OK_ESTANDAR]);
    const layer = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }),
      priceLevers: { onCapacityError: "standard" },
    });
    const r = await layer.generate(peticion);
    expect(s.enviados).toHaveLength(2);
    expect(r.report.deferred!.capacityFallback).toBe(true);
  });

  it("⛔ \"standard\" repite UNA vez: si el estándar también falla, el error sale", async () => {
    const s = secuencia([SIN_CAPACIDAD, SIN_CAPACIDAD, OK_ESTANDAR]);
    const layer = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }),
      priceLevers: { onCapacityError: "standard" },
    });
    await expect(layer.generate(peticion)).rejects.toThrow(/provider 429/);
    // Ni una tercera llamada ni un fail-open: el proveedor ya falló dos veces.
    expect(s.enviados).toHaveLength(2);
  });

  it("\"throw\" o sin configurar: el error de siempre, y una sola llamada", async () => {
    for (const priceLevers of [undefined, { onCapacityError: "throw" as const }]) {
      const s = secuencia([SIN_CAPACIDAD, OK_ESTANDAR]);
      const layer = createSavingsLayer({
        provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }),
        ...(priceLevers ? { priceLevers } : {}),
      });
      await expect(layer.generate(peticion)).rejects.toThrow(/provider 429/);
      expect(s.enviados).toHaveLength(1);
    }
  });

  it("⛔ un 400 NUNCA dispara el respaldo", async () => {
    const s = secuencia([{ estado: 400, cuerpo: '{"error":{"message":"bad request"}}' }, OK_ESTANDAR]);
    const layer = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }),
      priceLevers: { onCapacityError: "standard" },
    });
    await expect(layer.generate(peticion)).rejects.toThrow(/provider 400/);
    expect(s.enviados).toHaveLength(1);
  });

  it("⛔ una petición NO diferible nunca se repite, aunque el respaldo esté configurado", async () => {
    const s = secuencia([SIN_CAPACIDAD, OK_ESTANDAR]);
    const layer = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: OFICIAL, fetchImpl: s.fetchImpl }),
      priceLevers: { onCapacityError: "standard" },
    });
    await expect(layer.generate({ ...peticion, savings: {} })).rejects.toThrow(/provider 429/);
    expect(s.enviados).toHaveLength(1);
  });
});
