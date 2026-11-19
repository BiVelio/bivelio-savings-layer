import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { BIN, cajaLimpia, exigirBinCompilado, type Caja } from "./helpers/bvsala-proceso.js";

/**
 * A2-12 · `bvsala gemini`, `bvsala codex` y `bvsala opencode` RESPETAN EL
 * ENDPOINT QUE EL USUARIO YA TENÍA, como `bvsala claude` desde el #599 (G2).
 *
 * Antes, quien apuntaba Gemini CLI a su proxy con GOOGLE_GEMINI_BASE_URL, o
 * tenía un `baseURL` propio en la config inline de opencode, veía su variable
 * sustituida por la del gateway, y el gateway reenviaba a Google o a Anthropic:
 * la clave de su proxy acababa en un servidor que no eligió. Aquí se lanza el
 * bin compilado con terminales falsos que imprimen lo que recibieron. Hosts
 * inventados: nada sale a la red (los terminales falsos no llaman a nadie).
 */
describe.skipIf(process.platform === "win32")("A2-12 · el envoltorio no pisa el endpoint previo del usuario", () => {
  let caja: Caja;
  beforeAll(() => exigirBinCompilado());
  afterEach(() => caja?.limpiar());

  const correr = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [BIN, ...args], { env: caja.env(env), encoding: "utf8", timeout: 20_000 });

  it("gemini: el gateway reenvía al proxy del usuario y lo dice", () => {
    caja = cajaLimpia();
    caja.terminal("gemini", "process.stdout.write('GOOGLE_GEMINI_BASE_URL=' + process.env.GOOGLE_GEMINI_BASE_URL + '\\n');");
    const r = correr(["gemini", "-p", "hola"], { GOOGLE_GEMINI_BASE_URL: "https://gemini-proxy.ejemplo.invalid" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+ → https:\/\/gemini-proxy\.ejemplo\.invalid\n/);
    expect(r.stderr).toContain("GOOGLE_GEMINI_BASE_URL was already set to https://gemini-proxy.ejemplo.invalid");
    expect(r.stdout).toMatch(/^GOOGLE_GEMINI_BASE_URL=http:\/\/127\.0\.0\.1:\d+\n$/);
  });

  it("opencode: el baseURL inline del usuario pasa a ser el upstream y su apiKey sigue en la config", () => {
    caja = cajaLimpia();
    caja.terminal("opencode", "process.stdout.write(process.env.OPENCODE_CONFIG_CONTENT + '\\n');");
    const r = correr(["opencode"], {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { anthropic: { options: { baseURL: "https://llm-proxy.ejemplo.invalid/v1", apiKey: "CLAVE-INVENTADA" } } },
      }),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+ → https:\/\/llm-proxy\.ejemplo\.invalid\n/);
    expect(r.stderr).not.toContain("CLAVE-INVENTADA");
    const config = JSON.parse(r.stdout) as { provider: { anthropic: { options: { baseURL: string; apiKey: string } } } };
    expect(config.provider.anthropic.options.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(config.provider.anthropic.options.apiKey).toBe("CLAVE-INVENTADA");
  });

  it("codex con API key: OPENAI_BASE_URL propio → el gateway reenvía allí y el hijo ve el gateway", () => {
    caja = cajaLimpia();
    caja.terminal(
      "codex",
      "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), base: process.env.OPENAI_BASE_URL }) + '\\n');",
    );
    const r = correr(["codex", "exec", "hola"], { OPENAI_BASE_URL: "https://azure-proxy.ejemplo.invalid/v1" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+ → https:\/\/azure-proxy\.ejemplo\.invalid\n/);
    const visto = JSON.parse(r.stdout) as { args: string[]; base: string };
    const puerto = /127\.0\.0\.1:(\d+)/.exec(r.stderr)![1];
    expect(visto.args).toContain(`openai_base_url="http://127.0.0.1:${puerto}/v1"`);
    expect(visto.base).toBe(`http://127.0.0.1:${puerto}/v1`);
    // Y no dice a la vez que va a api.openai.com: el aviso de arriba ya nombra el destino.
    expect(r.stderr).not.toContain("routes to api.openai.com");
  });

  it("codex con API key y un OPENAI_BASE_URL con otra ruta: no arranca, exit 1, y no lanza el terminal", () => {
    caja = cajaLimpia();
    caja.terminal("codex", "process.stdout.write('LANZADO\\n');");
    const r = correr(["codex"], { OPENAI_BASE_URL: "https://proxy.ejemplo.invalid/openai/deployments/x" });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("LANZADO");
    expect(r.stderr).toContain("OPENAI_BASE_URL is already set to an endpoint with a path prefix at https://proxy.ejemplo.invalid");
    expect(r.stderr).not.toContain("deployments");
  });
});
