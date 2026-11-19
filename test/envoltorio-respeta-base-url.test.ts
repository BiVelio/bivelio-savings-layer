import { describe, expect, it } from "vitest";

import { upstreamHeredado } from "../gateway/envoltorios.js";

/**
 * `bvsala claude` RESPETA EL ANTHROPIC_BASE_URL QUE EL USUARIO YA TENÍA.
 *
 * El envoltorio ponía el base URL del gateway en la variable del terminal y el
 * gateway hablaba con api.anthropic.com sin mirar si el usuario ya apuntaba a
 * otro endpoint (proxy de empresa, LiteLLM, z.ai…): la sesión fallaba con 401
 * y el token de ESE proxy acababa enviado a Anthropic.
 *
 * La regla elegida es la más segura: la credencial solo viaja al host que el
 * usuario ya había elegido. O ese origen pasa a ser el upstream del gateway
 * (con una línea que lo dice), o el envoltorio no arranca y explica por qué.
 * NUNCA se sustituye en silencio por api.anthropic.com.
 *
 * Hosts de ejemplo inventados; la función es pura (no arranca nada).
 */
describe("upstreamHeredado — el base URL previo del usuario", () => {
  it("sin variable, vacía, o apuntando al API oficial: nada cambia", () => {
    expect(upstreamHeredado("claude", {})).toEqual({ tipo: "ninguno" });
    expect(upstreamHeredado("claude", { ANTHROPIC_BASE_URL: "  " })).toEqual({ tipo: "ninguno" });
    expect(upstreamHeredado("claude", { ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toEqual({ tipo: "ninguno" });
    expect(upstreamHeredado("claude", { ANTHROPIC_BASE_URL: "https://api.anthropic.com/" })).toEqual({ tipo: "ninguno" });
    expect(upstreamHeredado("claude", { ANTHROPIC_BASE_URL: "https://API.Anthropic.com:443" })).toEqual({ tipo: "ninguno" });
  });

  it("⛔ con un proxy propio, ESE es el upstream (no api.anthropic.com) y hay una línea de aviso", () => {
    const r = upstreamHeredado("claude", { ANTHROPIC_BASE_URL: "https://proxy.ejemplo.invalid", ANTHROPIC_AUTH_TOKEN: "token-inventado-del-proxy" });
    expect(r.tipo).toBe("usar");
    if (r.tipo !== "usar") return;
    expect(r.upstream).toBe("https://proxy.ejemplo.invalid");
    expect(r.variable).toBe("ANTHROPIC_BASE_URL");
    expect(r.aviso).toContain("https://proxy.ejemplo.invalid");
    expect(r.aviso).toContain("instead of https://api.anthropic.com");
    expect(r.aviso).toContain("unset ANTHROPIC_BASE_URL");
    // El aviso no repite ninguna credencial del entorno.
    expect(r.aviso).not.toContain("token-inventado-del-proxy");
  });

  it("⛔ también en loopback (un LiteLLM local): su token tampoco puede acabar en Anthropic", () => {
    const r = upstreamHeredado("claude", { ANTHROPIC_BASE_URL: "http://127.0.0.1:9911/" });
    expect(r).toMatchObject({ tipo: "usar", upstream: "http://127.0.0.1:9911" });
  });

  it("⛔ con prefijo de ruta el gateway no puede reenviar fielmente: no arranca, y no enseña ni la ruta ni credenciales", () => {
    const r = upstreamHeredado("claude", { ANTHROPIC_BASE_URL: "https://usuario:secreto-inventado@proxy.ejemplo.invalid/api/anthropic/tenant-77" });
    expect(r.tipo).toBe("impedimento");
    if (r.tipo !== "impedimento") return;
    expect(r.error).toContain("https://proxy.ejemplo.invalid");
    expect(r.error).toContain("never sent to https://api.anthropic.com");
    expect(r.error).toContain("unset ANTHROPIC_BASE_URL");
    expect(r.error).not.toContain("secreto-inventado");
    expect(r.error).not.toContain("tenant-77");
  });

  it("la excepción con ruta: el endpoint Anthropic de DeepSeek, que el gateway ya reescribe", () => {
    expect(upstreamHeredado("claude", { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" })).toMatchObject({
      tipo: "usar",
      upstream: "https://api.deepseek.com",
    });
  });

  it("un valor que no es una URL http(s): no arranca, y el valor no se enseña", () => {
    for (const v of ["token-pegado-por-error-en-la-variable", "ftp://proxy.ejemplo.invalid"]) {
      const r = upstreamHeredado("claude", { ANTHROPIC_BASE_URL: v });
      expect(r.tipo).toBe("impedimento");
      if (r.tipo === "impedimento") expect(r.error).not.toContain(v);
    }
  });

  it("con BVSALA_GATEWAY_UPSTREAM: si coincide con el previo, nada que hacer; ⛔ si NO coincide, no arranca (dos destinos para una credencial)", () => {
    expect(upstreamHeredado("claude", { ANTHROPIC_BASE_URL: "https://proxy.ejemplo.invalid" }, "https://proxy.ejemplo.invalid")).toEqual({ tipo: "ninguno" });
    expect(upstreamHeredado("claude", { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" }, "https://api.deepseek.com")).toEqual({ tipo: "ninguno" });
    const r = upstreamHeredado("claude", { ANTHROPIC_BASE_URL: "https://proxy.ejemplo.invalid" }, "https://api.anthropic.com");
    expect(r.tipo).toBe("impedimento");
    if (r.tipo === "impedimento") {
      expect(r.error).toContain("https://proxy.ejemplo.invalid");
      expect(r.error).toContain("https://api.anthropic.com");
    }
    // Sin base URL previo, la variable de bvsala manda como siempre.
    expect(upstreamHeredado("claude", {}, "https://api.deepseek.com")).toEqual({ tipo: "ninguno" });
  });

  it("cada terminal por SU variable: qwen (ANTHROPIC_BASE_URL), goose (ANTHROPIC_HOST), aider (ANTHROPIC_API_BASE antes que ANTHROPIC_BASE_URL)", () => {
    expect(upstreamHeredado("qwen", { ANTHROPIC_BASE_URL: "https://proxy.ejemplo.invalid" })).toMatchObject({ tipo: "usar", upstream: "https://proxy.ejemplo.invalid" });
    expect(upstreamHeredado("goose", { ANTHROPIC_HOST: "https://proxy.ejemplo.invalid" })).toMatchObject({ tipo: "usar", variable: "ANTHROPIC_HOST" });
    // goose no lee ANTHROPIC_BASE_URL: no es su variable.
    expect(upstreamHeredado("goose", { ANTHROPIC_BASE_URL: "https://proxy.ejemplo.invalid" })).toEqual({ tipo: "ninguno" });
    expect(
      upstreamHeredado("aider", { ANTHROPIC_API_BASE: "https://uno.ejemplo.invalid", ANTHROPIC_BASE_URL: "https://dos.ejemplo.invalid" }),
    ).toMatchObject({ tipo: "usar", upstream: "https://uno.ejemplo.invalid", variable: "ANTHROPIC_API_BASE" });
  });

  it("aider con OpenAI (BVSALA_GATEWAY_UPSTREAM=openai): un OPENAI_BASE_URL que no es api.openai.com tampoco se pisa", () => {
    const openai = "https://api.openai.com";
    expect(upstreamHeredado("aider", { OPENAI_BASE_URL: "https://api.openai.com/v1" }, openai)).toEqual({ tipo: "ninguno" });
    expect(upstreamHeredado("aider", { OPENAI_API_BASE: "https://proxy.ejemplo.invalid/v1" }, openai).tipo).toBe("impedimento");
  });

  // ── A2-12 · la misma regla para gemini, codex y opencode/Kilo ──────────────

  it("⛔ gemini: un GOOGLE_GEMINI_BASE_URL propio pasa a ser el upstream; el oficial no cambia nada; con ruta, no arranca", () => {
    expect(upstreamHeredado("gemini", { GOOGLE_GEMINI_BASE_URL: "https://generativelanguage.googleapis.com" })).toEqual({ tipo: "ninguno" });
    const r = upstreamHeredado("gemini", { GOOGLE_GEMINI_BASE_URL: "https://gemini-proxy.ejemplo.invalid", GEMINI_API_KEY: "clave-inventada" });
    expect(r).toMatchObject({ tipo: "usar", upstream: "https://gemini-proxy.ejemplo.invalid", variable: "GOOGLE_GEMINI_BASE_URL" });
    if (r.tipo === "usar") {
      expect(r.aviso).toContain("instead of https://generativelanguage.googleapis.com");
      expect(r.aviso).not.toContain("clave-inventada");
    }
    expect(upstreamHeredado("gemini", { GOOGLE_GEMINI_BASE_URL: "https://gemini-proxy.ejemplo.invalid/tenant-9" }).tipo).toBe("impedimento");
  });

  it("⛔ codex con API key: un OPENAI_BASE_URL propio con /v1 pasa a ser el upstream; con otra ruta o sin /v1, no arranca", () => {
    expect(upstreamHeredado("codex", { OPENAI_BASE_URL: "https://api.openai.com/v1" }, undefined, "api-key")).toEqual({ tipo: "ninguno" });
    expect(upstreamHeredado("codex", { OPENAI_BASE_URL: "https://azure-proxy.ejemplo.invalid/v1" }, undefined, "api-key")).toMatchObject({
      tipo: "usar",
      upstream: "https://azure-proxy.ejemplo.invalid",
      variable: "OPENAI_BASE_URL",
    });
    const otraRuta = upstreamHeredado("codex", { OPENAI_BASE_URL: "https://proxy.ejemplo.invalid/openai/v1" }, undefined, "api-key");
    expect(otraRuta.tipo).toBe("impedimento");
    if (otraRuta.tipo === "impedimento") expect(otraRuta.error).toContain("never sent to https://api.openai.com");
    const sinV1 = upstreamHeredado("codex", { OPENAI_BASE_URL: "https://proxy.ejemplo.invalid" }, undefined, "api-key");
    expect(sinV1.tipo).toBe("impedimento");
    if (sinV1.tipo === "impedimento") expect(sinV1.error).toContain("without the /v1 path");
  });

  it("⛔ codex con cuenta ChatGPT y un OPENAI_BASE_URL propio: no arranca (el envoltorio manda ese tráfico a chatgpt.com)", () => {
    const r = upstreamHeredado("codex", { OPENAI_BASE_URL: "https://azure-proxy.ejemplo.invalid/v1" }, undefined, "chatgpt");
    expect(r.tipo).toBe("impedimento");
    if (r.tipo === "impedimento") {
      expect(r.error).toContain("https://azure-proxy.ejemplo.invalid");
      expect(r.error).toContain("signed in with ChatGPT");
      expect(r.error).toContain("unset OPENAI_BASE_URL");
    }
  });

  it("⛔ opencode y Kilo: un baseURL propio en la config inline pasa a ser el upstream y su apiKey no se enseña", () => {
    const config = (baseURL: string) =>
      JSON.stringify({ provider: { anthropic: { options: { baseURL, apiKey: "CLAVE-INVENTADA-DEL-PROXY" } } } });
    for (const [t, variable] of [["opencode", "OPENCODE_CONFIG_CONTENT"], ["kilo", "KILO_CONFIG_CONTENT"]] as const) {
      expect(upstreamHeredado(t, { [variable]: config("https://api.anthropic.com/v1") })).toEqual({ tipo: "ninguno" });
      expect(upstreamHeredado(t, { [variable]: JSON.stringify({ provider: { anthropic: { options: { apiKey: "x" } } } }) })).toEqual({ tipo: "ninguno" });
      const r = upstreamHeredado(t, { [variable]: config("https://llm-proxy.ejemplo.invalid/v1") });
      expect(r, t).toMatchObject({ tipo: "usar", upstream: "https://llm-proxy.ejemplo.invalid" });
      if (r.tipo === "usar") {
        expect(r.variable).toBe(`provider.anthropic.options.baseURL in ${variable}`);
        expect(r.aviso).not.toContain("CLAVE-INVENTADA-DEL-PROXY");
      }
      const conRuta = upstreamHeredado(t, { [variable]: config("https://llm-proxy.ejemplo.invalid/api/anthropic/v1") });
      expect(conRuta.tipo, t).toBe("impedimento");
      if (conRuta.tipo === "impedimento") expect(conRuta.error).not.toContain("CLAVE-INVENTADA-DEL-PROXY");
    }
  });

  it("los terminales que no se redirigen por esas variables no se tocan", () => {
    for (const t of ["codex", "gemini", "opencode", "kilo", "copilot"] as const) {
      expect(upstreamHeredado(t, { ANTHROPIC_BASE_URL: "https://proxy.ejemplo.invalid" })).toEqual({ tipo: "ninguno" });
    }
  });
});
