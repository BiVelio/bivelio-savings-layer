import { describe, expect, it } from "vitest";

import { detectarContenidoMutable } from "../src/cache/cache-audit.js";

describe("cache-audit · detectarContenidoMutable (pura, sin red, sin estado)", () => {
  it("devuelve [] para texto vacío o sin contenido mutable", () => {
    expect(detectarContenidoMutable("")).toEqual([]);
    expect(
      detectarContenidoMutable("You are a helpful assistant. Answer in the user's language. Be concise."),
    ).toEqual([]);
  });

  it("señala un timestamp ISO 8601 en la cabecera de system", () => {
    const r = detectarContenidoMutable("Generated at 2026-11-09T10:05:00Z. Be polite.");
    expect(r.map((f) => f.patron)).toContain("iso-timestamp");
    expect(r[0]!.muestra).toContain("2026-11-09T10:05:00Z");
  });

  it("señala también el ISO con espacio y sin zona", () => {
    const r = detectarContenidoMutable("last sync 2026-11-09 10:05:00");
    expect(r.map((f) => f.patron)).toContain("iso-timestamp");
  });

  it("señala un UUID v4 (versión 4, variante 8/9/a/b)", () => {
    const r = detectarContenidoMutable("session 550e8400-e29b-41d4-a716-446655440000");
    expect(r.map((f) => f.patron)).toContain("uuid-v4");
  });

  it("NO señala un UUID que no es v4 (versión 1)", () => {
    const r = detectarContenidoMutable("session 550e8400-e29b-11d4-a716-446655440000");
    expect(r.map((f) => f.patron)).not.toContain("uuid-v4");
  });

  it("señala una fecha RFC 2822", () => {
    const r = detectarContenidoMutable("Today is Mon, 09 Nov 2026.");
    expect(r.map((f) => f.patron)).toContain("rfc2822-date");
  });

  it("señala una época en milisegundos (13 cifras, Date.now())", () => {
    const r = detectarContenidoMutable(`now=${Date.now()}`);
    expect(r.map((f) => f.patron)).toContain("epoch-millis");
  });

  it("señala una época en segundos (10 cifras, 2020-2033) como posible", () => {
    const r = detectarContenidoMutable("created 1768000000");
    expect(r.map((f) => f.patron)).toContain("epoch-seconds");
  });

  it("NO se inventa con números de otra magnitud", () => {
    const r = detectarContenidoMutable("id 12345678 · id 123456789012 · id 12345678901 · id 1234567890");
    expect(r).toEqual([]);
  });

  it("es determinista y no duplica el mismo hallazgo", () => {
    const texto = "t 2026-11-09T10:05:00Z · t 2026-11-09T10:05:00Z";
    const a = detectarContenidoMutable(texto);
    const b = detectarContenidoMutable(texto);
    expect(a).toEqual(b);
    expect(a.filter((f) => f.patron === "iso-timestamp")).toHaveLength(1);
  });

  it("recorta la muestra para no volcar el prompt del cliente", () => {
    const r = detectarContenidoMutable("token " + "a".repeat(80) + " 2026-11-09T10:05:00Z");
    const iso = r.find((f) => f.patron === "iso-timestamp");
    expect(iso!.muestra.length).toBeLessThanOrEqual(48);
  });
});
