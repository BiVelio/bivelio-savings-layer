import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

import {
  createMockProvider,
  createSavingsLayer,
  instrumentSavingsLayer,
  toCsv,
  toFocusRows,
  toLangfuseGeneration,
  toSavingsSeries,
  type SavingsRecord,
} from "../src/index.js";

/**
 * NADA DE ESTO HABLA CON BIVELIO, NI CON NADIE.
 *
 * Los exportadores ponen los libros en el pipeline de observabilidad y FinOps
 * del CLIENTE: los spans van a SUS exportadores y los ficheros se quedan donde él
 * los escriba. Este fichero lo ata por tres lados: con `fetch` saboteado todo
 * sigue funcionando; el bundle publicado no importa OpenTelemetry en tiempo de
 * ejecución; y el paquete sigue sin `dependencies` y con todos sus peers
 * OPCIONALES. Que el cable (`UsageWire`) no cambia lo vigila ya
 * test/licencia-alineada.test.ts.
 */

const RAIZ = fileURLToPath(new URL("..", import.meta.url));

describe("⛔ los exportadores no tocan la red", () => {
  const original = globalThis.fetch;
  let llamadas = 0;
  beforeEach(() => {
    llamadas = 0;
    globalThis.fetch = (() => {
      llamadas += 1;
      throw new Error("red prohibida en este test");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("generate y generateStream instrumentados funcionan sin red, y las funciones por lotes también", async () => {
    const exporter = new InMemorySpanExporter();
    const tracer = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const layer = createSavingsLayer({ provider: createMockProvider({ answer: "ok" }) });
    const traced = instrumentSavingsLayer(layer, {
      tracer,
      langfuse: { metadata: true, cost: true },
      datadog: { metadata: true },
    });
    const registros: SavingsRecord[] = [];
    const a = await traced.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hola" }] });
    registros.push({ at: Date.now(), report: a.report });
    const b = await traced.generateStream({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "adios" }] })
      .result;
    registros.push({ at: Date.now(), report: b.report });
    await Promise.resolve();
    expect(exporter.getFinishedSpans()).toHaveLength(2);

    expect(toCsv(toFocusRows(registros, { billingAccountId: "org" }))).toContain("BV-SALA savings ledger");
    expect(toSavingsSeries(registros).length).toBeGreaterThan(0);
    expect(toLangfuseGeneration(a.report).model).toBe("gpt-4o-mini");
    expect(llamadas).toBe(0);
    layer.close();
  });
});

describe("⛔ el paquete publicado no depende de OpenTelemetry", () => {
  it("dist/index.js no contiene `@opentelemetry/`: no hay import en tiempo de ejecución", () => {
    const dist = `${RAIZ}dist/index.js`;
    expect(existsSync(dist), "falta dist/index.js: corre `pnpm build` antes").toBe(true);
    // Un booleano y no `.not.toContain`: si falla, que no vuelque 230 KB de bundle.
    const src = readFileSync(dist, "utf8");
    const i = src.indexOf("@opentelemetry/");
    expect(i, i < 0 ? "" : src.slice(Math.max(0, i - 80), i + 40)).toBe(-1);
  });

  it("sin `dependencies`, y todo peerDependency es OPCIONAL", () => {
    const pkg = JSON.parse(readFileSync(`${RAIZ}package.json`, "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
    const peers = Object.keys(pkg.peerDependencies ?? {});
    expect(peers).toContain("@opentelemetry/api");
    for (const p of peers) expect(pkg.peerDependenciesMeta?.[p]?.optional, p).toBe(true);
  });

  it("ningún fuente de src/ importa @opentelemetry: los tipos son estructurales", () => {
    const indice = readFileSync(`${RAIZ}src/exporters/index.ts`, "utf8");
    for (const f of ["index", "tipos", "atributos", "otel", "langfuse", "agregado", "serie", "focus", "csv", "proveedor"]) {
      const src = readFileSync(`${RAIZ}src/exporters/${f}.ts`, "utf8");
      expect(src, f).not.toMatch(/from\s+["']@opentelemetry\//);
      expect(src, f).not.toMatch(/import\(\s*["']@opentelemetry\//);
    }
    expect(indice).not.toContain("export *");
  });
});
