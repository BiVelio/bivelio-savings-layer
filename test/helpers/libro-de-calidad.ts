import { expect } from "vitest";

import type { QualityLedger, SavingsReport } from "../../src/contracts/types.js";

/**
 * Las invariantes entre el veredicto (`qualityStatus`) y su evidencia
 * (`qualityLedger`). Si alguna se rompe, el informe se contradice a sí mismo:
 * una etiqueta que dice una cosa y un libro que cuenta otra.
 *
 * `rejected` MANDA sobre la procedencia (una respuesta que incumple su contrato
 * es `rejected` venga de donde venga), así que las implicaciones hacia
 * `task_equivalent` y `exact` se comprueban fuera de ese caso.
 */
export function comprobarCoherencia(report: SavingsReport): void {
  const libro = report.qualityLedger;
  expect(libro, "todo informe construido por la capa lleva libro de calidad").toBeDefined();
  const l = libro!;
  const origen = l.source === "coalesced" ? l.sharedFrom : l.source;
  const estado = report.qualityStatus;

  if (l.source === "coalesced") expect(l.sharedFrom).toBeDefined();
  else expect(l.sharedFrom).toBeUndefined();

  if (estado === "rejected") expect(l.schema?.outcome).toBe("failed");
  if (l.schema?.outcome === "failed") expect(estado).toBe("rejected");
  if (estado === "bounded_degradation") expect(l.cascade?.outcome).toBe("accepted");
  if (estado === "task_equivalent") expect(origen).toBe("semantic_cache");
  if (origen === "semantic_cache" && estado !== "rejected") expect(estado).toBe("task_equivalent");
  if (estado === "exact") expect(["exact_cache", "deterministic"]).toContain(origen);

  // Los bloques que dependen del origen.
  if (l.cacheMatch) expect(["exact_cache", "semantic_cache"]).toContain(origen);
  if (origen === "exact_cache") expect(l.cacheMatch?.kind).toBe("exact");
  if (origen === "semantic_cache") expect(l.cacheMatch?.kind).toBe("semantic");
  if (l.truncation) expect(["provider", "fail_open"]).toContain(origen);
  if (origen === "provider" || origen === "fail_open") expect(l.truncation).toBeDefined();
  if (l.repair) expect(origen).toBe("provider");
  if (l.schema?.outcome === "passed") expect(l.schema.errorCount).toBe(0);
  if (l.schema?.outcome === "failed") expect(l.schema.errorCount).toBeGreaterThan(0);
  if (report.modelCascade) expect(l.cascade).toBeDefined();
  else expect(l.cascade).toBeUndefined();
}

/** Claves que huelen a dinero o a tokens, a cualquier profundidad. */
export function clavesDeDinero(libro: QualityLedger | undefined): string[] {
  const malas: string[] = [];
  const recorrer = (v: unknown, ruta: string): void => {
    if (v == null || typeof v !== "object") return;
    for (const [k, hijo] of Object.entries(v as Record<string, unknown>)) {
      if (/cost|price|usd|saving|token|basis/i.test(k)) malas.push(`${ruta}.${k}`);
      recorrer(hijo, `${ruta}.${k}`);
    }
  };
  recorrer(libro, "qualityLedger");
  return malas;
}

/** Todos los valores de texto del libro, a cualquier profundidad. */
export function textosDelLibro(libro: QualityLedger | undefined): string[] {
  const out: string[] = [];
  const recorrer = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") for (const h of Object.values(v)) recorrer(h);
  };
  recorrer(libro);
  return out;
}
