import { describe, it, expect } from "vitest";
import { trace, type Span, type Tracer, type TracerProvider } from "@opentelemetry/api";

import {
  createMockProvider,
  createSavingsLayer,
  instrumentSavingsLayer,
  recordSavingsOnSpan,
  type SpanLike,
  type TracerLike,
  type TracerProviderLike,
} from "../src/index.js";
import { informeSintetico } from "./helpers/informe-sintetico.js";

/**
 * LOS TIPOS ESTRUCTURALES ENCAJAN CON LOS REALES.
 *
 * El SDK no importa `@opentelemetry/api` (es un peer OPCIONAL y su tipo acabaría
 * en el `.d.ts`), así que `SpanLike`, `TracerLike` y `TracerProviderLike` son
 * formas escritas a mano. Que un `Tracer` real —con TRES sobrecargas genéricas
 * de `startActiveSpan`— sea asignable a la nuestra no se da por supuesto: lo
 * demuestra este fichero COMPILANDO, porque `tsconfig.json` incluye `test/**` y
 * `pnpm typecheck` lo pasa contra @opentelemetry/api 1.9. El `it` de abajo solo
 * existe para que vitest no lo dé por vacío.
 */

function compila(): void {
  const layer = createSavingsLayer({ provider: createMockProvider() });
  // `trace` (la API global) como TracerProvider, y un Tracer suyo.
  instrumentSavingsLayer(layer, { tracer: trace });
  instrumentSavingsLayer(layer, { tracer: trace.getTracer("x") });
  // Un span activo cualquiera.
  recordSavingsOnSpan(trace.getActiveSpan()!, informeSintetico());
  // Y las asignaciones directas, para que un fallo señale el tipo exacto.
  const tracer: TracerLike = trace.getTracer("y") satisfies Tracer;
  const proveedor: TracerProviderLike = trace.getTracerProvider() satisfies TracerProvider;
  const span: SpanLike = trace.wrapSpanContext({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }) satisfies Span;
  void tracer;
  void proveedor;
  void span;
  layer.close();
}

describe("los tipos estructurales de los exportadores", () => {
  it("compilan contra @opentelemetry/api 1.9 (lo comprueba `pnpm typecheck`)", () => {
    expect(typeof compila).toBe("function");
  });
});
