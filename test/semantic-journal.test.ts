import { describe, expect, it } from "vitest";

import {
  CalibrationStateError,
  createMockProvider,
  createSavingsLayer,
  InMemorySemanticCache,
  SemanticCalibrationJournal,
  type SemanticCacheStore,
  type SemanticCalibrationIdentity,
  type SemanticCalibrationState,
} from "../src/index.js";
import { canonicalize } from "../src/canonicalization/canonicalize.js";
import type { CachedAnswer } from "../src/cache/exact.js";

const ID: SemanticCalibrationIdentity = {
  embedder: "custom:journal-test",
  verifier: null,
  judge: "built_in:same-answer-v1",
  maxErrorRate: 0.5,
  confidence: 0.9,
  similarityThreshold: 0.6,
};

const clone = (state: SemanticCalibrationState): SemanticCalibrationState =>
  JSON.parse(JSON.stringify(state)) as SemanticCalibrationState;

describe("SemanticCalibrationJournal", () => {
  it("restaura un estado viejo sin backend y no lo inventa al exportar", () => {
    const origen = new SemanticCalibrationJournal(ID);
    origen.record("single_shot", 0.9, true);
    const viejo = clone(origen.export());
    delete viejo.backend;

    const destino = new SemanticCalibrationJournal(ID);
    destino.import(viejo);

    expect(destino.status("single_shot")).toEqual(origen.status("single_shot"));
    expect(destino.export()).toEqual(viejo);
    expect("backend" in destino.export()).toBe(false);
  });

  it("incluye backend cuando existe y rechaza el de otro backend", () => {
    const origen = new SemanticCalibrationJournal({ ...ID, backend: "memory" });
    origen.record("single_shot", 0.9, true);
    const estado = origen.export();
    expect(estado.backend).toBe("memory");

    const mismo = new SemanticCalibrationJournal({ ...ID, backend: "memory" });
    mismo.import(estado);
    expect(mismo.status("single_shot")).toEqual(origen.status("single_shot"));

    const otro = new SemanticCalibrationJournal({ ...ID, backend: "postgres" });
    expect(() => otro.import(estado)).toThrow(CalibrationStateError);
    expect(() => otro.import(estado)).toThrow(/backend: "memory" in the state, "postgres" here/);
    expect(otro.status("single_shot").labeled).toBe(0);

    const sinBackend = new SemanticCalibrationJournal(ID);
    expect(() => sinBackend.import(estado)).toThrow(/backend: "memory" in the state, null here/);
    expect(sinBackend.status("single_shot").labeled).toBe(0);
  });

  it("importa todo o nada y nunca mezcla una historia con etiquetas locales", () => {
    const origen = new SemanticCalibrationJournal(ID);
    origen.record("single_shot", 0.9, true);
    origen.record("agentic", 0.8, true);
    const estado = origen.export();

    const destino = new SemanticCalibrationJournal(ID);
    const roto = clone(estado);
    roto.segments.agentic!.looks = 99;
    expect(() => destino.import(roto)).toThrow(CalibrationStateError);
    expect(destino.status("single_shot").labeled).toBe(0);
    expect(destino.status("agentic").labeled).toBe(0);

    destino.import(estado);
    const antes = destino.export();
    expect(() => destino.import(estado)).toThrow(/already recorded 1 labels in the single_shot segment/);
    expect(destino.export()).toEqual(antes);
  });

  it("produce exactamente los mismos estados que la caché en memoria", async () => {
    const cola: number[] = [];
    const cache = new InMemorySemanticCache({
      embed: () => {
        const score = cola.shift()!;
        return [score, Math.sqrt(1 - score * score)];
      },
      embedderId: "journal-test",
      similarityThreshold: 0.6,
      calibration: {
        maxErrorRate: 0.5,
        confidence: 0.9,
        auditRate: 0,
        perRecordFloors: false,
      },
    });
    const canonical = canonicalize({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "summarize the quarterly report" }],
    });
    const answer = (text: string): CachedAnswer => ({ text, data: text, storedAtMs: 0 });
    cola.push(1);
    await cache.store(canonical, answer("ok"));

    const journal = new SemanticCalibrationJournal(ID);
    for (let i = 0; i < 100; i++) {
      const score = 0.6 + (i % 40) / 100;
      const correct = i % 7 !== 0;
      cola.push(score);
      const resultado = await cache.lookup(canonical);
      const probe = resultado.probe ?? {
        reason: "audit" as const,
        score: resultado.hit!.confidence,
        segment: "single_shot" as const,
        record: resultado.hit!.record,
      };
      expect(probe.score).toBeCloseTo(score, 12);
      await cache.observe(probe, answer(correct ? "ok" : "not ok"));
      journal.record("single_shot", score, correct);
      expect(journal.status("single_shot")).toEqual(cache.calibrationStatus("single_shot"));
    }
    await cache.settled();
    expect(journal.export()).toEqual(cache.exportCalibration());
  });
});

describe("SemanticCacheStore estructural y close", () => {
  const store = (settled?: () => Promise<void>): SemanticCacheStore => ({
    calibrated: false,
    lookup: async () => ({ hit: null, probe: null }),
    store: async () => {},
    observe: async () => null,
    ...(settled ? { settled } : {}),
  });

  it("acepta un backend estructural y espera settled al cerrar", async () => {
    let llamadas = 0;
    const semanticCacheStore = store(async () => {
      llamadas++;
    });
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "ok" }),
      semanticCacheStore,
      devUnlicensed: true,
    });
    await layer.close();
    expect(llamadas).toBe(1);
  });

  it("propaga un error inesperado de settled después del cierre", async () => {
    const layer = createSavingsLayer({
      provider: createMockProvider({ answer: "ok" }),
      semanticCacheStore: store(async () => {
        throw new Error("settled failed");
      }),
      devUnlicensed: true,
    });
    await expect(layer.close()).rejects.toThrow("settled failed");
  });
});
