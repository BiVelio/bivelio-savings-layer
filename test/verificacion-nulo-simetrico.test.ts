import { describe, expect, it } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { muestraEnElCable } from "../src/verification/emisor.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import { clasificar } from "../src/verification/clasificar.js";
import type { SavingsRequest, SavingsResult } from "../src/contracts/types.js";
import type { Provider, ProviderRequest, ProviderResponse, ProviderStreamOptions } from "../src/providers/types.js";
import type { VerificationCheck } from "../src/contracts/verification.js";
import { informeDelBancoPropio, motivoDeNoComparable, type FilaDeResumen, type Par } from "../apps/web/lib/verificacion/banco-propio.js";
import { mulberry32 } from "../apps/web/lib/verificacion/bootstrap.js";
import { parseVerificationBatch } from "../apps/web/lib/verificacion/wire.js";

/**
 * EL INSTRUMENTO TIENE QUE MARCAR CERO CON UNA CAPA QUE NO HACE NADA.
 *
 * El hallazgo de la revisión adversaria, de punta a punta: SDK → cable → validador
 * del servidor → informe del panel. Un proveedor que NO distingue la copia de la
 * servida (misma distribución: salida de 100-400 tokens o, con un 20 %, cortada en
 * el tope de 500) y una capa que no toca nada (todo cae en `unchanged`).
 *
 * La servida cortada se excluye antes de mandar la copia (`truncated`, clasificar.ts).
 * Con la regla vieja la copia cortada SÍ se quedaba como par: con el mismo tope en
 * los dos brazos es la salida más cara posible, así que quedarse solo con las
 * servidas no cortadas fabricaba un ~15 % de «ahorro» sobre tráfico intacto. La
 * regla simétrica (banco-propio.ts, `motivoDeNoComparable`) aparta también la copia
 * cortada, y el suelo vuelve a no estar por encima de cero.
 */

const TOPE = 500;

class ProveedorQueNoDistingue implements Provider {
  readonly id = "sin-distincion";
  private readonly rng = mulberry32(12345);
  async generate(_req: ProviderRequest, _o?: ProviderStreamOptions): Promise<ProviderResponse> {
    const cortada = this.rng() < 0.2;
    const salida = cortada ? TOPE : 100 + Math.floor(this.rng() * 300);
    return { text: "x".repeat(10), usage: { inputTokens: 200, outputTokens: salida }, finishReason: cortada ? "length" : "stop" };
  }
}

describe("nulo simétrico: una capa que no hace nada no fabrica ahorro", () => {
  it("SDK → cable → validador → informe: el suelo no queda por encima de cero (con la regla vieja, ≈ +15 %)", async () => {
    reiniciarAvisos();
    const checks: VerificationCheck[] = [];
    let i = 0;
    const layer = createSavingsLayer({
      provider: new ProveedorQueNoDistingue(),
      generateId: () => `req-${++i}`,
      silenceWarnings: true,
      verification: { sampleRate: 1, onCheck: (c) => checks.push(c) },
    });
    const conteos: Record<string, number> = {};
    for (let k = 0; k < 1500; k++) {
      const r = await layer.generate({
        model: "openai/gpt-4o-mini",
        // Sin contrato: el tope lo simula el proveedor, igual para los dos brazos.
        messages: [{ role: "user", content: `question number ${k} about something` }],
      });
      // La copia sale en el siguiente turno del bucle: se deja salir antes de la siguiente.
      await new Promise((z) => setTimeout(z, 0));
      const v = r.report.verification!;
      const clave = v.stratum ?? v.excluded!;
      conteos[clave] = (conteos[clave] ?? 0) + 1;
    }
    await new Promise((z) => setTimeout(z, 20));
    layer.close();

    // Nada de lo que hace la capa cambia la petición: todo lo elegible es `unchanged`.
    expect(Object.keys(conteos).sort()).toEqual(["truncated", "unchanged"]);

    // Por el cable del SDK y el validador del servidor, en sobres de 500.
    const ahora = Date.now();
    const cable = checks.map((c) => muestraEnElCable(c, { ahora: Date.now() })).filter((m) => m !== null);
    const validadas = [];
    for (let j = 0; j < cable.length; j += 500) {
      validadas.push(...parseVerificationBatch({ batchId: `lote-nulo-${j}`, samples: cable.slice(j, j + 500), counts: [] }, ahora).samples);
    }
    const pares: Par[] = validadas
      .filter((m) => m.outcome === "paired")
      .map((m) => ({
        stratum: m.stratum,
        naiveCost: m.naiveCost!,
        optimizedCost: m.optimizedCost,
        naiveInputTokens: m.naiveInputTokens!,
        naiveOutputTokens: m.naiveOutputTokens!,
        cachedInputPer1k: m.cachedInputPer1k ?? null,
        outputPer1k: m.outputPer1k,
        naiveFinishReason: m.naiveFinishReason ?? null,
        naiveContract: m.naiveContract ?? null,
      }));
    expect(pares.length).toBe(conteos["unchanged"]);
    const cortadas = pares.filter((p) => motivoDeNoComparable(p) === "truncated").length;
    expect(cortadas).toBeGreaterThan(100); // la copia se corta con la misma frecuencia que la servida

    const resumen: FilaDeResumen[] = [
      {
        outcome: "paired",
        stratum: "unchanged",
        samples: pares.length,
        naiveCost: pares.reduce((n, p) => n + p.naiveCost, 0),
        naiveTruncated: cortadas,
        naiveIncomplete: 0,
        naiveContractMissed: 0,
      },
    ];
    const informe = informeDelBancoPropio({ conteos, resumen, pares, totalPares: pares.length, semilla: 7, remuestreos: 2000 });
    expect(informe.estado).toBe("listo");
    expect(informe.noComparables.truncadas).toBe(cortadas);
    expect(informe.paresEnTitular).toBe(pares.length - cortadas);
    expect(informe.titular!.fraccion.lower).toBeLessThanOrEqual(0);
    expect(informe.titular!.fraccion.upper).toBeGreaterThanOrEqual(0);

    // El agujero que se cierra, medido sobre los MISMOS pares con la regla vieja.
    const a = pares.reduce((n, p) => n + p.naiveCost, 0);
    const b = pares.reduce((n, p) => n + p.optimizedCost, 0);
    expect(1 - b / a).toBeGreaterThan(0.1);
  });

  it("la misma regla en los dos lados: clasificar() para la servida y motivoDeNoComparable() para la copia", () => {
    // Quien cambie una sin la otra reabre el agujero: este test lo ata.
    const equivalente: Record<string, ReturnType<typeof motivoDeNoComparable>> = {
      truncated: "truncated",
      incomplete: "incomplete",
      contract_failed: "contract_missed",
    };
    const fines = ["stop", "tool_calls", undefined, "length", "content_filter", "stop_sequence", "other"] as const;
    for (const fin of fines) {
      for (const contratoFallido of [false, true]) {
        const servida = clasificar({
          request: { model: "openai/gpt-4o-mini", messages: [] } as SavingsRequest,
          result: {
            requestId: "x",
            data: undefined,
            text: "",
            ...(fin !== undefined ? { finishReason: fin } : {}),
            report: {
              model: "openai/gpt-4o-mini",
              calls: { avoidedLlm: 0, actualRetrieval: 0 },
              constraints: { structurallyValid: !contratoFallido },
              cost: { basis: "measured", baselineEstimate: 0.001 },
              tokens: { eliminatedInput: 0, compressedInput: 0 },
            },
          } as unknown as SavingsResult,
          via: "optimizado",
          precio: () => ({ inputPer1k: 0.00015, outputPer1k: 0.0006 }),
        });
        const copia = motivoDeNoComparable({ naiveFinishReason: fin ?? null, naiveContract: contratoFallido ? "missed" : "met" });
        const esperado = "excluida" in servida ? equivalente[servida.excluida] : null;
        expect(copia, `${fin}/${contratoFallido}`).toBe(esperado);
      }
    }
  });
});
