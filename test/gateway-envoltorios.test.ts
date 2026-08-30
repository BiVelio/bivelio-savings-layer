import { describe, it, expect } from "vitest";

import { envoltorioDe, esTerminalConEnvoltorio, modoAuthCodex, CODEX_DESTINO } from "../gateway/envoltorios.js";

/**
 * La tabla de envoltorios es pura: aquí se afirma la FORMA exacta del base URL
 * por terminal (docs/PASARELA-S3-TERMINALES.md §3) y que el modo de auth de
 * Codex se decide sin tocar jamás un valor de credencial.
 */
describe("envoltorioDe — la forma exacta del base URL por terminal", () => {
  it("claude, goose y qwen: base URL SIN /v1 y sin barra final, por la variable de cada uno", () => {
    expect(envoltorioDe("claude", 8402, ["-p", "hola"]).env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8402" });
    expect(envoltorioDe("goose", 8402, ["session"]).env).toEqual({ ANTHROPIC_HOST: "http://127.0.0.1:8402" });
    expect(envoltorioDe("qwen", 8402, []).env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8402" });
    for (const t of ["claude", "goose", "qwen"] as const) {
      const e = envoltorioDe(t, 8402, ["x"]);
      expect(e.bin).toBe(t);
      expect(e.args).toEqual(["x"]); // los args del usuario pasan intactos
      expect(e.upstream).toBeUndefined(); // dialecto Anthropic: upstream por defecto
    }
  });

  it("codex con API key: -c openai_base_url con prefijo /v1 y upstream api.openai.com; sin tocar el entorno", () => {
    const e = envoltorioDe("codex", 8402, ["exec", "hola"], { modoCodex: "api-key" });
    expect(e.bin).toBe("codex");
    expect(e.args[0]).toBe("-c");
    // Cadena TOML entrecomillada: la doc de Codex documenta `--config model='"gpt-5.6-terra"'`
    // («Values are parsed as TOML»); sin shell por medio, las comillas van dentro del argv.
    expect(e.args[1]).toBe('openai_base_url="http://127.0.0.1:8402/v1"');
    expect(e.args.slice(2)).toEqual(["exec", "hola"]);
    expect(e.env).toEqual({});
    expect(e.upstream).toBe("https://api.openai.com");
  });

  it("codex con auth ChatGPT: el base URL TERMINA exactamente en /backend-api/codex y el upstream es chatgpt.com", () => {
    const e = envoltorioDe("codex", 8402, [], { modoCodex: "chatgpt" });
    expect(e.args[1]).toMatch(/127\.0\.0\.1:8402\/backend-api\/codex"?$/);
    expect(e.args[1]).not.toMatch(/codex\/"?$/); // sin barra final
    expect(e.upstream).toBe("https://chatgpt.com");
    expect(e.nota).toContain("validación");
  });

  it("solo claude/codex/goose/qwen tienen envoltorio; el resto va por doctor", () => {
    expect(esTerminalConEnvoltorio("goose")).toBe(true);
    expect(esTerminalConEnvoltorio("opencode")).toBe(false);
    expect(esTerminalConEnvoltorio(undefined)).toBe(false);
  });
});

describe("modoAuthCodex — decidido sin tocar valores de credenciales", () => {
  const SIN_ENV = {} as NodeJS.ProcessEnv;

  it("BVSALA_CODEX_AUTH manda sobre todo", () => {
    expect(modoAuthCodex({ env: { BVSALA_CODEX_AUTH: "chatgpt" } as NodeJS.ProcessEnv, leerAuth: () => '{"auth_mode":"ApiKey"}' })).toBe("chatgpt");
    expect(modoAuthCodex({ env: { BVSALA_CODEX_AUTH: "api-key" } as NodeJS.ProcessEnv, leerAuth: () => '{"tokens":{}}' })).toBe("api-key");
  });

  it("auth_mode es un enum: ApiKey → api-key; toda la familia ChatGPT → chatgpt", () => {
    expect(modoAuthCodex({ env: SIN_ENV, leerAuth: () => '{"auth_mode":"ApiKey","OPENAI_API_KEY":"x"}' })).toBe("api-key");
    expect(modoAuthCodex({ env: SIN_ENV, leerAuth: () => '{"auth_mode":"api_key"}' })).toBe("api-key");
    for (const m of ["Chatgpt", "ChatgptAuthTokens", "Headers", "AgentIdentity", "PersonalAccessToken", "chatgpt"]) {
      expect(modoAuthCodex({ env: SIN_ENV, leerAuth: () => JSON.stringify({ auth_mode: m, tokens: {} }) }), m).toBe("chatgpt");
    }
  });

  it("sin auth_mode: la EXISTENCIA de `tokens` decide chatgpt; sin ella, api-key", () => {
    expect(modoAuthCodex({ env: SIN_ENV, leerAuth: () => '{"tokens":{"id_token":"x"}}' })).toBe("chatgpt");
    expect(modoAuthCodex({ env: SIN_ENV, leerAuth: () => '{"OPENAI_API_KEY":"x"}' })).toBe("api-key");
  });

  it("sin archivo, archivo ilegible o error de lectura: api-key (el segmento por defecto)", () => {
    expect(modoAuthCodex({ env: SIN_ENV, leerAuth: () => null })).toBe("api-key");
    expect(modoAuthCodex({ env: SIN_ENV, leerAuth: () => "no es json" })).toBe("api-key");
    expect(
      modoAuthCodex({
        env: SIN_ENV,
        leerAuth: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBe("api-key");
  });

  it("la tabla de destinos es la del doc: /v1 ↔ api.openai.com, /backend-api/codex ↔ chatgpt.com", () => {
    expect(CODEX_DESTINO["api-key"]).toEqual({ upstream: "https://api.openai.com", prefijo: "/v1" });
    expect(CODEX_DESTINO.chatgpt).toEqual({ upstream: "https://chatgpt.com", prefijo: "/backend-api/codex" });
  });
});
