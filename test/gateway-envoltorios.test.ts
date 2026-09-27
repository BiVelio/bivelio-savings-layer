import { describe, it, expect } from "vitest";

import {
  envoltorioDe,
  esTerminalConEnvoltorio,
  modoAuthCodex,
  resolverBinarioWindows,
  CODEX_DESTINO,
  configInlineConBaseURL,
  destinoCopilot,
  impedimentoDeEnvoltorio,
} from "../gateway/envoltorios.js";

/**
 * La tabla de envoltorios es pura: aquí se afirma la FORMA exacta del base URL
 * por terminal (docs/PASARELA-S3-TERMINALES.md §3) y que el modo de auth de
 * Codex se decide sin tocar jamás un valor de credencial.
 */
describe("envoltorioDe — la forma exacta del base URL por terminal", () => {
  it("claude: activa la búsqueda de herramientas por defecto y respeta lo que ya fijó el usuario", () => {
    // Sin la variable, Claude Code la apaga al ver un base URL ajeno y manda todas las
    // definiciones de herramientas en cada petición: el envoltorio la enciende.
    expect(envoltorioDe("claude", 8402, [], {}, {}).env.ENABLE_TOOL_SEARCH).toBe("true");
    // El usuario puede apagarla o afinarla; el envoltorio nunca pisa su valor.
    for (const v of ["false", "auto", "auto:5"]) {
      expect(envoltorioDe("claude", 8402, [], {}, { ENABLE_TOOL_SEARCH: v }).env.ENABLE_TOOL_SEARCH).toBe(v);
    }
    // Solo claude: goose y qwen no leen esa variable.
    expect(envoltorioDe("goose", 8402, [], {}, {}).env).not.toHaveProperty("ENABLE_TOOL_SEARCH");
    expect(envoltorioDe("qwen", 8402, [], {}, {}).env).not.toHaveProperty("ENABLE_TOOL_SEARCH");
  });

  it("claude, goose y qwen: base URL SIN /v1 y sin barra final, por la variable de cada uno", () => {
    expect(envoltorioDe("claude", 8402, ["-p", "hola"], {}, {}).env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8402",
      ENABLE_TOOL_SEARCH: "true",
    });
    expect(envoltorioDe("goose", 8402, ["session"]).env).toEqual({ ANTHROPIC_HOST: "http://127.0.0.1:8402" });
    expect(envoltorioDe("qwen", 8402, []).env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8402" });
    for (const t of ["claude", "goose", "qwen"] as const) {
      const e = envoltorioDe(t, 8402, ["x"], {}, {});
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
    // Se mide a precio de lista SIN comisión; la licencia por asiento se paga igual.
    expect(e.nota).toContain("no commission");
    expect(e.nota).not.toContain("not billed");
  });

  it("los que se enrutan por entorno tienen envoltorio; los de archivo o UI van por doctor", () => {
    for (const t of ["claude", "codex", "goose", "qwen", "opencode", "kilo", "copilot", "aider"]) {
      expect(esTerminalConEnvoltorio(t), t).toBe(true);
    }
    // Crush, Droid y Continue solo por archivo; Cline y el BYOK de VS Code por UI;
    // Gemini CLI y Cursor no se miden (ver doctor).
    for (const t of ["crush", "droid", "continue", "cn", "cline", "gemini", "cursor"]) {
      expect(esTerminalConEnvoltorio(t), t).toBe(false);
    }
    expect(esTerminalConEnvoltorio(undefined)).toBe(false);
  });
});

describe("resolverBinarioWindows — .exe directo; el shim .cmd de npm se detecta para negarse con guía", () => {
  // En macOS path.join usa «/»: el matcher normaliza separadores para que el
  // test valga en cualquier plataforma (en Windows real, join produce «\»).
  const existeDe = (rutas: string[]) => (ruta: string) =>
    rutas.some((r) => ruta.replaceAll("\\", "/").endsWith(r.replaceAll("\\", "/")));

  it("un .exe en el PATH gana aunque un shim .cmd esté en un directorio anterior", () => {
    const r = resolverBinarioWindows("claude", {
      path: "C:\\npm;C:\\bin",
      existe: existeDe(["npm/claude.cmd", "bin/claude.exe"]),
    });
    expect(r.tipo).toBe("exe");
    expect((r as { ruta: string }).ruta.endsWith("claude.exe")).toBe(true);
  });

  it("solo shim .cmd (instalación npm global) → solo-shim con la ruta, para el mensaje", () => {
    const r = resolverBinarioWindows("codex", { path: "C:\\npm", existe: existeDe(["npm/codex.cmd"]) });
    expect(r.tipo).toBe("solo-shim");
    expect((r as { ruta: string }).ruta.endsWith("codex.cmd")).toBe(true);
  });

  it(".com cuenta como ejecutable (semántica de libuv); .ps1 no cuenta como nada", () => {
    expect(resolverBinarioWindows("goose", { path: "C:\\x", existe: existeDe(["goose.com"]) }).tipo).toBe("exe");
    expect(resolverBinarioWindows("qwen", { path: "C:\\x", existe: existeDe(["qwen.ps1"]) }).tipo).toBe("no-encontrado");
  });

  it("PATH vacío o binario ausente → no-encontrado", () => {
    expect(resolverBinarioWindows("claude", { path: "", existe: () => true }).tipo).toBe("no-encontrado");
    expect(resolverBinarioWindows("claude", { path: "C:\\x;C:\\y", existe: () => false }).tipo).toBe("no-encontrado");
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

describe("opencode y Kilo — la config entera por variable, fusionada y sin tocar el disco", () => {
  it("sin config inline previa: solo provider.anthropic.options.baseURL, CON /v1", () => {
    const oc = envoltorioDe("opencode", 8402, ["run", "hola"], {}, {});
    expect(oc.bin).toBe("opencode");
    expect(oc.args).toEqual(["run", "hola"]);
    expect(oc.upstream).toBeUndefined(); // Anthropic, el upstream por defecto
    expect(JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      provider: { anthropic: { options: { baseURL: "http://127.0.0.1:8402/v1" } } },
    });
    const kilo = envoltorioDe("kilo", 8402, [], {}, {});
    expect(kilo.bin).toBe("kilo");
    expect(JSON.parse(kilo.env.KILO_CONFIG_CONTENT!)).toEqual({
      provider: { anthropic: { options: { baseURL: "http://127.0.0.1:8402/v1" } } },
    });
    // Cada uno con SU variable: la de opencode no le sirve a Kilo, y al revés.
    expect(oc.env).not.toHaveProperty("KILO_CONFIG_CONTENT");
    expect(kilo.env).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
    expect(kilo.nota).toContain("Kilo Gateway");
  });

  it("con config inline del usuario: la fusiona y solo cambia baseURL (su clave y sus modelos siguen)", () => {
    const suya = JSON.stringify({
      model: "anthropic/claude-sonnet-4-6",
      provider: {
        anthropic: { options: { apiKey: "{env:MI_CLAVE}", baseURL: "https://api.anthropic.com/v1", timeout: 1 }, models: { x: {} } },
        openai: { options: { apiKey: "{env:OTRA}" } },
      },
    });
    const e = envoltorioDe("opencode", 9000, [], {}, { OPENCODE_CONFIG_CONTENT: suya });
    expect(JSON.parse(e.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      provider: {
        anthropic: { options: { apiKey: "{env:MI_CLAVE}", baseURL: "http://127.0.0.1:9000/v1", timeout: 1 }, models: { x: {} } },
        openai: { options: { apiKey: "{env:OTRA}" } },
      },
    });
  });

  it("una config inline ilegible no se adivina: impedimento antes de arrancar, sin repetir su valor", () => {
    for (const malo of ["{ // jsonc\n }", "[1,2]", '"texto"', '{"provider": 3}', '{"provider": {"anthropic": {"options": []}}}']) {
      expect(configInlineConBaseURL(malo, "http://127.0.0.1:1/v1"), malo).toBeNull();
      const msg = impedimentoDeEnvoltorio("opencode", { OPENCODE_CONFIG_CONTENT: malo });
      expect(msg, malo).toContain("OPENCODE_CONFIG_CONTENT is set but is not a JSON object");
      expect(msg, malo).toContain("its value is not shown");
      expect(msg!.includes(malo), malo).toBe(false);
    }
    expect(impedimentoDeEnvoltorio("kilo", { KILO_CONFIG_CONTENT: "sk-ant-no-es-json" })).toContain("KILO_CONFIG_CONTENT");
    expect(impedimentoDeEnvoltorio("kilo", { KILO_CONFIG_CONTENT: "sk-ant-no-es-json" })).not.toContain("sk-ant");
    // Vacía o ausente: adelante.
    expect(impedimentoDeEnvoltorio("opencode", {})).toBeNull();
    expect(impedimentoDeEnvoltorio("opencode", { OPENCODE_CONFIG_CONTENT: "  " })).toBeNull();
  });
});

describe("Copilot CLI — solo BYOK de Anthropic contra su API oficial", () => {
  const CLAVE = "sk-ant-api03-SECRETO";

  it("sin COPILOT_PROVIDER_BASE_URL (modelos de GitHub) no hay nada que medir: impedimento", () => {
    const msg = impedimentoDeEnvoltorio("copilot", { COPILOT_MODEL: "x" });
    expect(msg).toContain("GitHub-hosted models, which never pass through the gateway");
    expect(msg).toContain("COPILOT_PROVIDER_BASE_URL");
  });

  it("anthropic: base SIN /v1, upstream por defecto, y su clave y su modelo intactos", () => {
    const entorno = {
      COPILOT_PROVIDER_TYPE: "anthropic",
      COPILOT_PROVIDER_BASE_URL: "https://api.anthropic.com/",
      COPILOT_PROVIDER_API_KEY: CLAVE,
      COPILOT_MODEL: "claude-opus-5",
    };
    expect(impedimentoDeEnvoltorio("copilot", entorno)).toBeNull();
    expect(destinoCopilot(entorno)).toEqual({ ok: true, ruta: "" });
    const e = envoltorioDe("copilot", 8402, ["-p", "hola"], {}, entorno);
    expect(e.bin).toBe("copilot");
    expect(e.args).toEqual(["-p", "hola"]);
    expect(e.env).toEqual({ COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:8402" });
    expect(e.upstream).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain(CLAVE);
  });

  it("openai (el tipo por defecto) todavía no: Responses por WebSocket sin validar tras el 426; remite al doctor", () => {
    for (const entorno of [
      { COPILOT_PROVIDER_BASE_URL: "https://api.openai.com/v1" },
      { COPILOT_PROVIDER_TYPE: "OpenAI", COPILOT_PROVIDER_BASE_URL: "https://api.openai.com/v1" },
    ]) {
      const msg = impedimentoDeEnvoltorio("copilot", entorno);
      expect(msg).toContain("wraps the anthropic provider type only for now");
      expect(msg).toContain("WebSocket");
      expect(msg).toContain("bvsala doctor");
    }
  });

  it("azure, un modelo local o un revendedor: no se envuelven (no hay precio de lista que sea su factura)", () => {
    expect(impedimentoDeEnvoltorio("copilot", { COPILOT_PROVIDER_TYPE: "azure", COPILOT_PROVIDER_BASE_URL: "https://x.openai.azure.com" }))
      .toContain("wraps the anthropic type only");
    expect(
      impedimentoDeEnvoltorio("copilot", { COPILOT_PROVIDER_TYPE: "anthropic", COPILOT_PROVIDER_BASE_URL: "http://localhost:4000" }),
    ).toContain("does not point at https://api.anthropic.com");
    expect(impedimentoDeEnvoltorio("copilot", { COPILOT_PROVIDER_TYPE: "anthropic", COPILOT_PROVIDER_BASE_URL: "no es url" })).toContain(
      "is not a URL",
    );
  });

  it("un valor raro en el tipo (una clave pegada donde no era) no se repite en el mensaje", () => {
    const msg = impedimentoDeEnvoltorio("copilot", { COPILOT_PROVIDER_TYPE: CLAVE, COPILOT_PROVIDER_BASE_URL: "https://a.b" });
    expect(msg).toContain("COPILOT_PROVIDER_TYPE is neither anthropic nor openai");
    expect(msg).not.toContain("sk-ant");
  });
});

describe("Aider — por litellm: Anthropic por defecto, OpenAI si se pide", () => {
  it("por defecto: ANTHROPIC_API_BASE SIN /v1 (litellm añade /v1/messages) y upstream Anthropic", () => {
    const e = envoltorioDe("aider", 8402, ["--sonnet"], {}, {});
    expect(e.bin).toBe("aider");
    expect(e.args).toEqual(["--sonnet"]);
    expect(e.env).toEqual({ ANTHROPIC_API_BASE: "http://127.0.0.1:8402" });
    expect(e.upstream).toBeUndefined();
    expect(e.nota).toContain("BVSALA_GATEWAY_UPSTREAM=openai");
  });

  it("con BVSALA_GATEWAY_UPSTREAM=openai: las dos variables que lee litellm, CON /v1", () => {
    const e = envoltorioDe("aider", 8402, [], { upstreamElegido: "https://api.openai.com" }, {});
    expect(e.env).toEqual({ OPENAI_BASE_URL: "http://127.0.0.1:8402/v1", OPENAI_API_BASE: "http://127.0.0.1:8402/v1" });
    expect(e.upstream).toBe("https://api.openai.com");
    // litellm solo pide el usage en stream cuando habla con api.openai.com: se dice cómo medirlo.
    expect(e.nota).toContain("NOT metered unless you relaunch with BVSALA_GATEWAY_USAGE_INJECT=1");
    const conInyeccion = envoltorioDe("aider", 8402, [], { upstreamElegido: "https://api.openai.com" }, { BVSALA_GATEWAY_USAGE_INJECT: "1" });
    expect(conInyeccion.nota).toContain("Usage injection is on: streamed replies ask for their usage");
  });

  it("aider no tiene impedimento previo: su configuración la resuelve aider", () => {
    expect(impedimentoDeEnvoltorio("aider", {})).toBeNull();
    expect(impedimentoDeEnvoltorio("claude", {})).toBeNull();
  });
});
