import { describe, it, expect } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { SavingsRequest, SavingsReport } from "../src/contracts/types.js";

/**
 * PUENTE ESQUEMA ↔ RUNTIME. Este fichero existe porque su ausencia costó cara:
 * el CHECK `usage_daily_calls_add_up` de la migración 0008 exigía
 * `avoided + actual <= requests`, un invariante FALSO para el propio SDK (una
 * reparación emite actualLlm=2 con requests=1). Llegó a producción porque ningún
 * test contrastaba lo que las migraciones exigen con lo que el pipeline emite de
 * verdad: los tests probaban el SDK, las migraciones no las probaba nadie.
 *
 * Aquí se ejecuta el pipeline REAL por sus caminos reales, se construye el
 * registro de uso tal cual lo manda el emisor, y se comprueba contra la
 * aritmética EXACTA de los CHECK. Si alguien endurece un CHECK o cambia lo que
 * emite el pipeline, esto se pone rojo antes de llegar a la base de datos.
 */

// --- la aritmética de los CHECK, transcrita literalmente de las migraciones ---

/** 0008 (la rota, se conserva para demostrar POR QUÉ rompía). */
const checkViejo = (f: { requests: number; avoided: number; actual: number }) =>
  f.avoided + f.actual <= f.requests;

/** 0011 (la corregida). */
const checkNuevo = (f: { requests: number; avoided: number; actual: number }) =>
  f.avoided <= f.requests && f.avoided + f.actual <= 2 * f.requests;

/** Acumulación del ON CONFLICT de la RPC: cada registro suma requests=1. */
function acumular(reports: SavingsReport[]) {
  return reports.reduce(
    (acc, r) => ({
      requests: acc.requests + 1,
      avoided: acc.avoided + r.calls.avoidedLlm,
      actual: acc.actual + r.calls.actualLlm,
    }),
    { requests: 0, avoided: 0, actual: 0 },
  );
}

// --- proveedores que fuerzan cada camino real ---

class Normal implements Provider {
  readonly id = "normal";
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    return { text: '{"answer":"ok"}', usage: { inputTokens: 100, outputTokens: 10 } };
  }
}

class ObligaAReparar implements Provider {
  readonly id = "repara";
  n = 0;
  async generate(_r: ProviderRequest): Promise<ProviderResponse> {
    this.n += 1;
    return this.n === 1
      ? { text: "{roto", usage: { inputTokens: 100, outputTokens: 10 } }
      : { text: '{"answer":"ok"}', usage: { inputTokens: 110, outputTokens: 8 } };
  }
}

const MODELOS = { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } };

const conContrato = (): SavingsRequest => ({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "responde en el formato" }],
  response: {
    contractId: "c1",
    version: "v1",
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
  },
  savings: { exactCache: false },
});

describe("esquema vs SDK — usage_daily_calls_add_up", () => {
  it("el camino de REPARACIÓN viola el CHECK de 0008 y satisface el de 0011 (la causa exacta del 500 en prod)", async () => {
    const capa = createSavingsLayer({ provider: new ObligaAReparar(), costModels: MODELOS });
    const res = await capa.generate(conContrato());
    expect(res.report.calls.actualLlm).toBe(2); // la reparación es real

    const fila = acumular([res.report]);
    expect(checkViejo(fila)).toBe(false); // 0008: 0+2 <= 1 → FALSO → 500 → bucle
    expect(checkNuevo(fila)).toBe(true); //  0011: 2 <= 2*1 → la ingesta pasa
  });

  it("el camino NORMAL satisface los dos", async () => {
    const capa = createSavingsLayer({ provider: new Normal(), costModels: MODELOS });
    const fila = acumular([(await capa.generate(conContrato())).report]);
    expect(fila).toEqual({ requests: 1, avoided: 0, actual: 1 });
    expect(checkViejo(fila)).toBe(true);
    expect(checkNuevo(fila)).toBe(true);
  });

  it("el camino EVITADO (caché exacta) satisface los dos", async () => {
    const capa = createSavingsLayer({ provider: new Normal(), costModels: MODELOS });
    const req: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "explica que es un monad" }],
    };
    await capa.generate(req); // siembra
    const hit = await capa.generate(req); // acierto
    expect(hit.report.cache.result).toBe("exact");
    const fila = acumular([hit.report]);
    expect(fila).toEqual({ requests: 1, avoided: 1, actual: 0 });
    expect(checkViejo(fila)).toBe(true);
    expect(checkNuevo(fila)).toBe(true);
  });

  it("un día mixto realista (normales + reparaciones + evitadas) pasa el CHECK nuevo", async () => {
    const reports: SavingsReport[] = [];
    const capaN = createSavingsLayer({ provider: new Normal(), costModels: MODELOS });
    const capaR = createSavingsLayer({ provider: new ObligaAReparar(), costModels: MODELOS });
    reports.push((await capaN.generate(conContrato())).report);
    reports.push((await capaR.generate(conContrato())).report);
    const req: SavingsRequest = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "pregunta repetida" }],
    };
    await capaN.generate(req);
    reports.push((await capaN.generate(req)).report);

    const fila = acumular(reports);
    expect(checkNuevo(fila)).toBe(true);
    // y el viejo falla, demostrando que UNA reparación al día bastaba para
    // congelar la ingesta del día entero de la organización:
    expect(checkViejo(fila)).toBe(false);
  });

  it("el CHECK nuevo NO es un cheque en blanco: sigue cazando datos imposibles", () => {
    expect(checkNuevo({ requests: 1, avoided: 2, actual: 0 })).toBe(false); // evitar más de lo pedido
    expect(checkNuevo({ requests: 1, avoided: 0, actual: 3 })).toBe(false); // más de 2 llamadas/petición
    expect(checkNuevo({ requests: 2, avoided: 1, actual: 4 })).toBe(false); // mezcla imposible
  });
});

/**
 * Los cuatro totales de tokens que añade la migración 0015, contra informes
 * REALES del pipeline.
 *
 * La restricción que el cuerpo pide —«la capa nunca gasta más de lo que habría
 * costado sin ella»— es FALSA, y aquí se demuestra con el mismo proveedor que ya
 * reprodujo el 500 de producción. Si alguien la añade alguna vez, este test cae
 * antes de que lo haga la ingesta de un cliente.
 */
const acumularTokens = (reports: SavingsReport[]) =>
  reports.reduce(
    (a, r) => ({
      baselineInput: a.baselineInput + r.tokens.baselineInput,
      actualInput: a.actualInput + r.tokens.actualInput,
      baselineOutput: a.baselineOutput + r.tokens.baselineOutput,
      actualOutput: a.actualOutput + r.tokens.actualOutput,
    }),
    { baselineInput: 0, actualInput: 0, baselineOutput: 0, actualOutput: 0 },
  );

/** Lo único que 0015 SÍ afirma. */
const sinNegativos = (f: Record<string, number>) => Object.values(f).every((v) => v >= 0);

describe("esquema vs SDK — los totales de tokens de 0015", () => {
  it("el camino NORMAL nunca produce un contador negativo", async () => {
    const capa = createSavingsLayer({ provider: new Normal(), costModels: MODELOS });
    const f = acumularTokens([(await capa.generate(conContrato())).report]);
    expect(sinNegativos(f)).toBe(true);
    expect(f.actualInput).toBeGreaterThan(0);
  });

  it("LA REPARACIÓN GASTA MÁS QUE EL BASELINE — por eso 0015 no restringe eso", async () => {
    const capa = createSavingsLayer({ provider: new ObligaAReparar(), costModels: MODELOS });
    const res = await capa.generate(conContrato());
    expect(res.report.calls.actualLlm).toBe(2);

    const f = acumularTokens([res.report]);
    // La segunda llamada suma a `actual` y se DESCUENTA del baseline para que el
    // reintento no se pague a sí mismo. Resultado: actual > baseline.
    expect(f.actualInput).toBeGreaterThan(f.baselineInput);
    // O sea que un CHECK `actual_input_tokens <= baseline_input_tokens` habría
    // reventado la transacción del lote entero, devuelto 500 y dejado a la org
    // sin reportar — el defecto de 0008, repetido.
    expect(f.actualInput <= f.baselineInput).toBe(false);
    // Y lo que 0015 sí afirma se sigue cumpliendo.
    expect(sinNegativos(f)).toBe(true);
  });

  it("el ahorro de tokens puede salir NEGATIVO, y es un dato válido", async () => {
    const capa = createSavingsLayer({ provider: new ObligaAReparar(), costModels: MODELOS });
    const f = acumularTokens([(await capa.generate(conContrato())).report]);
    const ahorro =
      f.baselineInput - f.actualInput + (f.baselineOutput - f.actualOutput);
    expect(ahorro).toBeLessThan(0);
  });

  it("un día mixto (normales + reparación) sigue sin negativos", async () => {
    const normal = createSavingsLayer({ provider: new Normal(), costModels: MODELOS });
    const roto = createSavingsLayer({ provider: new ObligaAReparar(), costModels: MODELOS });
    const reports = [
      (await normal.generate(conContrato())).report,
      (await normal.generate(conContrato())).report,
      (await roto.generate(conContrato())).report,
    ];
    expect(sinNegativos(acumularTokens(reports))).toBe(true);
  });
});
