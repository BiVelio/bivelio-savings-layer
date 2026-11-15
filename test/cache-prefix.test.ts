import { describe, it, expect } from "vitest";

import { reordenarPrefijoCacheable } from "../src/cache/cache-prefix.js";

/**
 * EL REORDENADOR DEL PREFIJO CACHEABLE: la otra mitad de la auditoría.
 *
 * La auditoría diagnostica (dice qué rompe la caché); este módulo ARREGLA con
 * permiso del llamante: las líneas del `system` con contenido mutable pasan al
 * final, dejando un prefijo estable cacheable. Aquí se fija: el reorden por
 * líneas, el punto de corte (el prefijo estable nunca contiene lo mutable), los
 * casos en que NO se toca nada (null) y el determinismo.
 */

describe("reordenarPrefijoCacheable", () => {
  it("mueve la línea mutable al final y deja lo estable delante", () => {
    const r = reordenarPrefijoCacheable(
      "You are a helpful assistant.\nCurrent date: 2026-11-09T10:00:00Z\nAnswer politely.",
    )!;
    expect(r.texto).toBe(
      "You are a helpful assistant.\nAnswer politely.\nCurrent date: 2026-11-09T10:00:00Z",
    );
    expect(r.movidas.map((m) => m.linea)).toEqual(["Current date: 2026-11-09T10:00:00Z"]);
    expect(r.patrones).toEqual(["iso-timestamp"]);
  });

  it("el corte separa de verdad: lo estable no contiene lo mutable y la cola sí", () => {
    const r = reordenarPrefijoCacheable(
      "Rule one.\nNow: 2026-11-09T10:00:00Z\nRule two.\n",
    )!;
    expect(r.texto.slice(0, r.corte)).not.toContain("2026-11-09T10:00:00Z");
    expect(r.texto.slice(0, r.corte)).toContain("Rule one");
    expect(r.texto.slice(0, r.corte)).toContain("Rule two");
    expect(r.texto.slice(r.corte)).toContain("Now: 2026-11-09T10:00:00Z");
  });

  it("varias líneas mutables conservan su orden relativo", () => {
    const r = reordenarPrefijoCacheable(
      "You are a helper.\nTrace id: 550e8400-e29b-41d4-a716-446655440000\nDate: 2026-11-09T10:00:00Z\nBe brief.",
    )!;
    expect(r.movidas.map((m) => m.linea)).toEqual([
      "Trace id: 550e8400-e29b-41d4-a716-446655440000",
      "Date: 2026-11-09T10:00:00Z",
    ]);
    // El orden relativo de las estables también se conserva.
    expect(r.texto).toBe(
      "You are a helper.\nBe brief.\nTrace id: 550e8400-e29b-41d4-a716-446655440000\nDate: 2026-11-09T10:00:00Z",
    );
    expect(r.patrones.sort()).toEqual(["iso-timestamp", "uuid-v4"]);
  });

  it("detecta RFC 2822 y epoch en milisegundos", () => {
    const r = reordenarPrefijoCacheable(
      "Helper.\nGenerated: Mon, 09 Nov 2026 10:00:00 GMT\nStamp: 1794259200123\nGo.",
    )!;
    expect(r.patrones.sort()).toEqual(["epoch-millis", "rfc2822-date"]);
    expect(r.texto).toBe("Helper.\nGo.\nGenerated: Mon, 09 Nov 2026 10:00:00 GMT\nStamp: 1794259200123");
  });

  it("un epoch en segundos (10 cifras) también mueve la línea", () => {
    const r = reordenarPrefijoCacheable("Helper.\nExpires: 1794259200\nGo.")!;
    expect(r.patrones).toEqual(["epoch-seconds"]);
    expect(r.texto).toBe("Helper.\nGo.\nExpires: 1794259200");
  });

  it("sin contenido mutable devuelve null (no se toca nada)", () => {
    expect(reordenarPrefijoCacheable("You are a helpful assistant.\nAnswer politely.")).toBeNull();
  });

  it("todo mutable devuelve null: no hay prefijo estable que cachear", () => {
    expect(
      reordenarPrefijoCacheable("Now: 2026-11-09T10:00:00Z\nTrace: 550e8400-e29b-41d4-a716-446655440000"),
    ).toBeNull();
  });

  it("vacío o solo espacios devuelve null", () => {
    expect(reordenarPrefijoCacheable("")).toBeNull();
    expect(reordenarPrefijoCacheable("   \n  ")).toBeNull();
  });

  it("conserva CRLF y el salto de línea final", () => {
    const r = reordenarPrefijoCacheable("Rule one.\r\nNow: 2026-11-09T10:00:00Z\r\nRule two.\r\n")!;
    expect(r.texto).toBe("Rule one.\r\nRule two.\r\nNow: 2026-11-09T10:00:00Z\r\n");
    expect(r.texto.slice(r.corte)).toBe("\r\nNow: 2026-11-09T10:00:00Z\r\n");
  });

  it("las líneas en blanco se quedan en la parte estable", () => {
    const r = reordenarPrefijoCacheable("Rule one.\n\nNow: 2026-11-09T10:00:00Z\nRule two.")!;
    expect(r.texto).toBe("Rule one.\n\nRule two.\nNow: 2026-11-09T10:00:00Z");
    expect(r.texto.slice(0, r.corte)).toBe("Rule one.\n\nRule two.");
  });

  it("es determinista: misma entrada, misma salida", () => {
    const texto = "A.\nT: 2026-11-09T10:00:00Z\nB.\nId: 550e8400-e29b-41d4-a716-446655440000\nC.";
    const a = reordenarPrefijoCacheable(texto);
    const b = reordenarPrefijoCacheable(texto);
    expect(a).toEqual(b);
  });
});
