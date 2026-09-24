import { describe, it, expect } from "vitest";

import { resolverUpstream, UPSTREAM_ALIASES } from "../gateway/upstream.js";

/**
 * `--upstream` y BVSALA_GATEWAY_UPSTREAM: a qué proveedor habla un gateway.
 * Función pura; bin.ts solo ejecuta lo que decide.
 */
describe("resolverUpstream — el proveedor de ESTE gateway", () => {
  it("los alias openai y anthropic dan su origen, sin distinguir mayúsculas ni espacios", () => {
    expect(resolverUpstream({ flag: "openai" })).toEqual({ ok: true, upstream: "https://api.openai.com", origen: "flag" });
    expect(resolverUpstream({ flag: "OpenAI " })).toEqual({ ok: true, upstream: "https://api.openai.com", origen: "flag" });
    expect(resolverUpstream({ flag: "anthropic" })).toEqual({ ok: true, upstream: "https://api.anthropic.com", origen: "flag" });
    expect(resolverUpstream({ env: "openai" })).toEqual({ ok: true, upstream: "https://api.openai.com", origen: "env" });
    expect(UPSTREAM_ALIASES["openai"]).toBe("https://api.openai.com");
  });

  it("el flag manda sobre la variable de entorno", () => {
    expect(resolverUpstream({ flag: "openai", env: "https://api.anthropic.com" })).toEqual({
      ok: true,
      upstream: "https://api.openai.com",
      origen: "flag",
    });
  });

  it("sin flag ni variable (o con la variable vacía): upstream undefined y la cadena de siempre", () => {
    expect(resolverUpstream({})).toEqual({ ok: true, upstream: undefined, origen: "none" });
    expect(resolverUpstream({ env: "" })).toEqual({ ok: true, upstream: undefined, origen: "none" });
    expect(resolverUpstream({ env: "   " })).toEqual({ ok: true, upstream: undefined, origen: "none" });
  });

  it("una URL con ruta se queda en su ORIGEN y avisa de que la ruta se ignora (no se rechaza: funcionaba)", () => {
    const r = resolverUpstream({ env: "https://api.openai.com/v1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.upstream).toBe("https://api.openai.com");
    expect(r.origen).toBe("env");
    expect(r.aviso).toContain("is ignored");
    expect(r.aviso).toContain('"/v1"');
  });

  it("un origen limpio no avisa, con o sin barra final", () => {
    for (const valor of ["http://127.0.0.1:9000/", "http://127.0.0.1:9000"]) {
      const r = resolverUpstream({ flag: valor });
      expect(r, valor).toEqual({ ok: true, upstream: "http://127.0.0.1:9000", origen: "flag" });
    }
  });

  it("query o hash también cuentan como algo que se ignora", () => {
    const r = resolverUpstream({ flag: "https://gw.example.com/?x=1" });
    expect(r.ok && r.aviso).toContain("is ignored");
  });

  it("protocolos que no son http(s) y valores que no son URL → error", () => {
    for (const valor of ["ftp://x", "openai.com", "file:///etc/hosts", "no es nada"]) {
      const r = resolverUpstream({ flag: valor });
      expect(r.ok, valor).toBe(false);
      if (!r.ok) expect(r.error).toContain(`invalid upstream "${valor}"`);
    }
  });

  it("--upstream sin valor (flag: null) → error que dice qué poner", () => {
    const r = resolverUpstream({ flag: null, env: "openai" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("needs a value");
  });
});
