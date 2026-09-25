import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse, ProviderStreamOptions } from "../src/providers/types.js";
import type { SavingsRequest } from "../src/contracts/types.js";
import { parseVerificationBatch, VerificationValidationError } from "../apps/web/lib/verificacion/wire.js";
import { precioDelUso as precioDelSdk } from "../src/verification/precio.js";
import { precioDelUso as precioDeLaWeb } from "../apps/web/lib/verificacion/wire.js";
import { mulberry32 } from "../benchmarks/stats.js";

/**
 * PUENTE SDK ↔ SERVIDOR del canal de verificación (el patrón de
 * esquema-vs-sdk.test.ts). Se corre el pipeline REAL con verificación, se
 * captura el sobre que el emisor manda de verdad y se pasa por el validador del
 * servidor: si uno cambia sin el otro, esto se pone rojo antes de que un lote
 * entero se pierda con un 400 sin reintento.
 *
 * Y la aritmética del único CHECK de 0030 (≥ 0), transcrita.
 */

class Proveedor implements Provider {
  readonly id = "contrato";
  async generate(req: ProviderRequest, options?: ProviderStreamOptions): Promise<ProviderResponse> {
    const copia = options?.signal !== undefined;
    return {
      text: req.schema ? '{"answer":"ok"}' : "hecho",
      usage: {
        inputTokens: 40 + req.messages.length * 13 + (req.tools?.length ?? 0) * 50,
        outputTokens: 11,
        ...(copia ? {} : { cachedInputTokens: 16 }),
      },
      finishReason: copia ? "length" : "stop",
    };
  }
}

async function sobresReales(): Promise<Array<Record<string, unknown>>> {
  const sobres: Array<Record<string, unknown>> = [];
  const fetchFalso = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/metering/verification")) sobres.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 202 });
  }) as unknown as typeof fetch;
  const layer = createSavingsLayer({
    provider: new Proveedor(),
    serviceAccountKey: "bvk_prueba",
    licenseServerUrl: "https://savings.example.test",
    meteringFetch: fetchFalso,
    silenceWarnings: true,
    verification: { sampleRate: 1 },
  });
  const peticiones: SavingsRequest[] = [
    { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "resume el informe" }] },
    { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "resume el informe" }] },
    { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "What is 2 + 2 * 3?" }] },
    {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "clasifica" }],
      response: { contractId: "c:v1", schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } },
    },
    { model: "acme/sin-precio", messages: [{ role: "user", content: "hola" }] },
    { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hola" }], savings: { verification: false } },
  ];
  for (const q of peticiones) await layer.generate(q);
  await new Promise((r) => setTimeout(r, 10));
  layer.close();
  await new Promise((r) => setTimeout(r, 10));
  return sobres;
}

/** El CHECK `verification_samples_no_negatives` de 0030, transcrito. */
const checkMuestras = (m: Record<string, unknown>): boolean => {
  const n = (k: string) => (m[k] === undefined ? 0 : Number(m[k]));
  return [
    "optimizedCost", "optimizedInputTokens", "optimizedCachedInputTokens", "optimizedOutputTokens",
    "naiveCost", "naiveInputTokens", "naiveCachedInputTokens", "naiveOutputTokens",
    "inputPer1k", "cachedInputPer1k", "outputPer1k",
  ].every((k) => n(k) >= 0);
};

describe("el sobre real del SDK pasa el validador del servidor", () => {
  it("entero, sin descartes, con muestras y conteos", async () => {
    const sobres = await sobresReales();
    expect(sobres.length).toBeGreaterThan(0);
    let muestras = 0;
    let conteos = 0;
    for (const s of sobres) {
      const lote = parseVerificationBatch(s, Date.now());
      expect(lote.dropped).toBe(0);
      muestras += lote.samples.length;
      conteos += lote.counts.length;
      for (const m of lote.samples) expect(checkMuestras(m as unknown as Record<string, unknown>)).toBe(true);
    }
    expect(muestras).toBe(4);
    expect(conteos).toBeGreaterThanOrEqual(4);
  });

  it("y sus variantes mutadas NO", async () => {
    const [sobre] = await sobresReales();
    const base = sobre as { batchId: string; samples: Array<Record<string, unknown>>; counts: Array<Record<string, unknown>> };
    const muta = (f: (s: typeof base) => void) => {
      const copia = structuredClone(base);
      f(copia);
      return () => parseVerificationBatch(copia, Date.now());
    };
    expect(muta((s) => ((s.samples[0]!["prompt"] = "hola"), undefined))).toThrow(VerificationValidationError);
    expect(muta((s) => ((s.samples[0]!["basis"] = "measured"), undefined))).toThrow(/must be "verification"/);
    expect(muta((s) => delete s.samples[0]!["requestId"])).toThrow(/missing field "requestId"/);
    expect(muta((s) => ((s.samples[0]!["optimizedCost"] = -1), undefined))).toThrow(VerificationValidationError);
    expect(muta((s) => ((s as Record<string, unknown>)["orgId"] = "otra"))).toThrow(/unknown field "orgId"/);
    expect(muta((s) => ((s.counts[0]!["category"] = "inventada"), undefined))).toThrow(VerificationValidationError);
  });
});

describe("el precio de la web es el del SDK, portado tal cual", () => {
  it("500 casos con semilla, bit a bit", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const u = {
        inputTokens: Math.floor(rng() * 100_000),
        outputTokens: Math.floor(rng() * 8_000),
        cachedInputTokens: Math.floor(rng() * 50_000),
      };
      const p = {
        inputPer1k: rng() * 0.01,
        outputPer1k: rng() * 0.03,
        ...(rng() < 0.5 ? { cachedInputPer1k: rng() * 0.005 } : {}),
      };
      expect(precioDeLaWeb(u, p)).toBe(precioDelSdk(u, p));
    }
  });
});
