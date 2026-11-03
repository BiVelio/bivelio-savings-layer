import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * `bvsala doctor`: detecta qué terminales de codificación hay en la máquina e
 * imprime, para cada uno, el bloque exacto que lo enruta por el gateway local.
 *
 * Solo imprime. Y solo mira EXISTENCIA — binarios en el PATH y archivos de
 * configuración de usuario —: este módulo no abre ni lee ningún archivo, y en
 * el informe solo aparecen rutas, jamás contenidos (auth.json, settings con
 * apiKey, etc.).
 *
 * La forma del base URL es la trampa central (docs/PASARELA-S3-TERMINALES.md
 * §3): depende del SDK de cada terminal, y una URL copiada de un terminal a
 * otro rompe en silencio (`/v1/v1/messages` → 404 sin medir).
 */
export interface InformeDoctor {
  texto: string;
  /** Ids de los terminales detectados, en el orden del informe. */
  detectados: string[];
}

export interface OpcionesDoctor {
  /** Directorio home; por defecto `os.homedir()`. */
  home?: string;
  /** PATH a sondear; por defecto `process.env.PATH`. */
  path?: string;
  /** Sonda de existencia de rutas; por defecto `fs.existsSync`. */
  existe?: (ruta: string) => boolean;
  /** Sonda de binarios en PATH; por defecto recorre `path` con `existe`, sin spawn. */
  enPath?: (bin: string) => boolean;
}

interface Contexto {
  /** `http://127.0.0.1:PUERTO`, sin `/v1` y sin barra final. */
  base: string;
  /** `http://127.0.0.1:PUERTO/v1`, sin barra final. */
  baseV1: string;
  /** El puerto, para las recetas que arrancan su propio gateway. */
  puerto: number;
  /** Rutas absolutas de las configs del terminal, en el orden de `configs`. */
  rutas: string[];
}

interface Terminal {
  id: string;
  nombre: string;
  /** Binario a buscar en el PATH; ausente en extensiones de editor. */
  binario?: string;
  /** Configs de usuario, relativas al home, que se comprueban por existencia. */
  configs: string[];
  /** Las líneas del bloque de configuración. */
  receta: (ctx: Contexto) => string[];
  /** Falso en los que no se pueden detectar (Cline, el BYOK de VS Code, los SDK). */
  detectable: boolean;
  /**
   * La línea de comprobación contra el log, si no es la de /v1/messages; `null`
   * en los que el gateway no puede medir (no hay línea que buscar).
   */
  comprobar?: string | null;
  /** El estado de los no detectables, si no es el de una extensión de editor. */
  estadoSinDeteccion?: string;
}

const COMPROBAR =
  "check: the gateway log must show `[gateway] POST /v1/messages …`; " +
  "if you see `/v1/v1/messages`, there is one /v1 too many; if you see a bare `POST /messages`, one is missing.";

const TERMINALES: readonly Terminal[] = [
  {
    id: "claude",
    nombre: "Claude Code",
    binario: "claude",
    configs: [],
    detectable: true,
    receta: ({ base }) => [
      "use `bvsala claude` — starts the gateway on an ephemeral port, launches `claude` pointed at it and shuts it down on exit.",
      `by hand: ANTHROPIC_BASE_URL=${base} claude   (no /v1: the client appends /v1/messages)`,
    ],
  },
  {
    id: "codex",
    nombre: "Codex CLI",
    binario: "codex",
    configs: [join(".codex", "config.toml"), join(".codex", "auth.json")],
    detectable: true,
    // Codex solo habla la Responses API: su línea es la de /responses, no la de Messages.
    comprobar:
      "check: the gateway log must show `[gateway] POST /v1/responses …` (API key) or `POST /backend-api/codex/responses …` " +
      "(ChatGPT); `/v1/v1/responses` means one /v1 too many.",
    receta: ({ base, rutas }) => [
      "use `bvsala codex` — the base URL prefix depends on the auth mode and the wrapper resolves it:",
      `  API key             → openai_base_url=${base}/v1`,
      `  ChatGPT subscription → openai_base_url=${base}/backend-api/codex   (must end exactly there)`,
      `${rutas[1]}: only checked for existence; never read.`,
    ],
  },
  {
    id: "opencode",
    nombre: "opencode",
    binario: "opencode",
    configs: [join(".config", "opencode", "opencode.json")],
    detectable: true,
    receta: ({ baseV1, rutas }) => [
      "use `bvsala opencode` — routes the `anthropic` provider through the gateway with OPENCODE_CONFIG_CONTENT, which",
      "opencode merges over the global and project files: nothing is written to disk. Other providers go direct.",
      `by hand: ${rutas[0]} → provider.anthropic.options.baseURL (the project's opencode.json overrides the global one). WITH /v1.`,
      "{",
      '  "provider": {',
      '    "anthropic": {',
      `      "options": { "baseURL": "${baseV1}" }`,
      "    }",
      "  }",
      "}",
      'alternative: "baseURL": "{env:BVSALA_BASE_URL}" and export the variable; pitfall: without the variable, baseURL is empty.',
    ],
  },
  {
    id: "kilo",
    nombre: "Kilo Code (CLI, VS Code, JetBrains)",
    binario: "kilo",
    configs: [join(".config", "kilo", "kilo.json"), join(".config", "kilo", "kilo.jsonc")],
    detectable: true,
    receta: ({ baseV1, rutas }) => [
      "use `bvsala kilo` for the CLI — routes the `anthropic` provider (your API key) with KILO_CONFIG_CONTENT: nothing is",
      "written to disk. The Kilo Gateway provider (Kilo's own hosted models) and any other provider go direct.",
      `by hand (the VS Code and JetBrains extensions read the same file): ${rutas[0]} → provider.anthropic.options.baseURL. WITH /v1.`,
      "{",
      '  "provider": {',
      '    "anthropic": {',
      `      "options": { "baseURL": "${baseV1}" }`,
      "    }",
      "  }",
      "}",
    ],
  },
  {
    id: "copilot",
    nombre: "GitHub Copilot CLI (your own key, BYOK)",
    binario: "copilot",
    configs: [join(".copilot", "config.json")],
    detectable: true,
    comprobar:
      "check: the gateway log must show `[gateway] POST /v1/messages …` (anthropic); `/v1/v1/messages` means one /v1 too many.",
    receta: ({ base, baseV1 }) => [
      "only with your own provider key (BYOK). GitHub-hosted models do not use a base URL: nothing to meter there (/usage).",
      "anthropic type: use `bvsala copilot` with your BYOK variables exported — it keeps your model and key and points",
      `COPILOT_PROVIDER_BASE_URL at the gateway. By hand: COPILOT_PROVIDER_TYPE=anthropic COPILOT_PROVIDER_BASE_URL=${base}   (NO /v1)`,
      `openai type [not validated]: COPILOT_PROVIDER_BASE_URL=${baseV1} against \`bvsala gateway --upstream openai\` (WITH /v1).`,
      "It may call the Responses API over WebSocket, which the gateway answers with 426: keep it only if the log shows",
      "POST /v1/responses or /v1/chat/completions lines with a cost; `did not ask for usage` → BVSALA_GATEWAY_USAGE_INJECT=1.",
    ],
  },
  {
    id: "aider",
    nombre: "Aider",
    binario: "aider",
    configs: [".aider.conf.yml"],
    detectable: true,
    receta: ({ base, baseV1 }) => [
      "use `bvsala aider` — Anthropic models by default. Aider calls through litellm, which reads ANTHROPIC_API_BASE",
      "before ANTHROPIC_BASE_URL and appends /v1/messages: NO /v1.",
      `by hand: ANTHROPIC_API_BASE=${base} aider`,
      `OpenAI models: BVSALA_GATEWAY_UPSTREAM=openai bvsala aider --model <OpenAI model>; by hand, OPENAI_API_BASE=${baseV1} (WITH /v1).`,
      "litellm asks for streamed usage only when it talks to api.openai.com itself: through the gateway, streamed OpenAI",
      "replies are metered only with BVSALA_GATEWAY_USAGE_INJECT=1 or aider --no-stream. An --openai-api-base flag or",
      "openai-api-base in .aider.conf.yml overrides the variable.",
    ],
  },
  {
    id: "goose",
    nombre: "Goose",
    binario: "goose",
    configs: [join(".config", "goose", "config.yaml")],
    detectable: true,
    receta: ({ base, rutas }) => [
      `mechanism: ANTHROPIC_HOST environment variable (overrides ${rutas[0]}). NO /v1.`,
      `ANTHROPIC_HOST=${base} ANTHROPIC_API_KEY=… goose`,
    ],
  },
  {
    id: "crush",
    nombre: "Crush",
    binario: "crush",
    configs: [join(".config", "crush", "crushrc")],
    detectable: true,
    receta: ({ baseV1, rutas }) => [
      `mechanism: ${rutas[0]} (Bash); crush.json is deprecated. WITH /v1 and NO trailing slash (the Go SDK resolves relative paths: /v1/ → /v1/v1/messages).`,
      `provider add bvsala --type anthropic --base-url ${baseV1} --api-key "$ANTHROPIC_API_KEY"`,
    ],
  },
  {
    id: "qwen",
    nombre: "Qwen Code",
    binario: "qwen",
    configs: [join(".qwen", "settings.json")],
    detectable: true,
    receta: ({ base, rutas }) => [
      `mechanism: ANTHROPIC_BASE_URL environment variable + ${rutas[0]} with selectedType = anthropic. NO /v1 (the official TS SDK appends /v1/messages).`,
      `ANTHROPIC_BASE_URL=${base} ANTHROPIC_API_KEY=… qwen`,
      `check by hand that ${rutas[0]} has selectedType: anthropic — the doctor does not read the file.`,
    ],
  },
  {
    id: "droid",
    nombre: "Droid (Factory)",
    binario: "droid",
    configs: [join(".factory", "settings.json")],
    detectable: true,
    receta: ({ base, rutas }) => [
      `mechanism: ${rutas[0]} → customModels[] with provider "anthropic". NO /v1 [inferred: validate by hand against the gateway log].`,
      "{",
      '  "customModels": [',
      "    {",
      '      "model": "<Anthropic model id>",',
      '      "displayName": "<display name>",',
      '      "provider": "anthropic",',
      `      "baseUrl": "${base}",`,
      '      "apiKey": "<your Anthropic API key>"',
      "    }",
      "  ]",
      "}",
    ],
  },
  {
    id: "cline",
    nombre: "Cline",
    configs: [],
    detectable: false,
    receta: ({ baseV1 }) => [
      "mechanism: UI → Anthropic provider → tick \"Use custom base URL\". WITH /v1 (Cline defaults to https://api.anthropic.com/v1 and only normalizes the exact official URL).",
      `Base URL: ${baseV1}`,
    ],
  },
  {
    id: "continue",
    nombre: "Continue (cn CLI and IDE extensions)",
    binario: "cn",
    configs: [join(".continue", "config.yaml")],
    detectable: true,
    receta: ({ baseV1, rutas }) => [
      `mechanism: ${rutas[0]} → the model's apiBase. WITH /v1 (Continue adds the trailing slash and resolves \`messages\` against it).`,
      "models:",
      "  - name: <display name>",
      "    provider: anthropic",
      "    model: <Anthropic model id>",
      "    apiKey: <your Anthropic API key>",
      `    apiBase: ${baseV1}`,
    ],
  },
  {
    id: "vscode-copilot",
    nombre: "GitHub Copilot in VS Code (your own key, BYOK)",
    configs: [],
    detectable: false,
    receta: ({ baseV1 }) => [
      "mechanism: Manage Language Models → Add Models → Custom Endpoint, API type Messages; VS Code opens",
      "chatLanguageModels.json. Put the FULL path in the model's url (VS Code uses an explicit /messages path as-is):",
      `"url": "${baseV1}/messages"`,
      "BYOK covers chat and utility tasks: inline suggestions and embeddings stay on GitHub and are not metered here.",
    ],
  },
  {
    id: "gemini",
    nombre: "Gemini CLI",
    binario: "gemini",
    configs: [join(".gemini", "settings.json")],
    detectable: true,
    comprobar: null,
    receta: ({ base, puerto }) => [
      `one command: bvsala gemini   (wraps the CLI: GOOGLE_GEMINI_BASE_URL=${base} and the gateway's own --upstream gemini)`,
      `manual: start \`bvsala gateway --upstream gemini --port ${puerto}\`, then run the Gemini CLI with GOOGLE_GEMINI_BASE_URL=${base}`,
      "The gateway reads usage from :generateContent / :streamGenerateContent responses and meters models with a",
      "list price; your GEMINI_API_KEY travels in x-goog-api-key, intact, and never reaches BiVelio.",
    ],
  },
  {
    id: "cursor",
    nombre: "Cursor (your own OpenAI-compatible key, BYOK)",
    binario: "cursor",
    configs: [".cursor"],
    detectable: true,
    comprobar: null,
    receta: ({ baseV1, puerto }) => [
      "mechanism: Cursor → Settings → Models → OpenAI API Base URL override (BYOK: your own API key for OpenAI-compatible models).",
      `start: bvsala gateway --upstream openai --port ${puerto}   (deepseek, qwen, glm, moonshot and ollama work the same)`,
      `base URL: ${baseV1}   (WITH /v1)`,
      "Only requests Cursor sends with YOUR key to that base URL pass through the gateway; its own models go",
      "through Cursor's servers and cannot reach a gateway on 127.0.0.1 (their usage dashboard meters those).",
    ],
  },
  {
    id: "claude-via-deepseek",
    nombre: "Claude Code with DeepSeek (its Anthropic-format endpoint)",
    configs: [],
    detectable: false,
    estadoSinDeteccion: "no detection: it is a Claude Code configuration, not a new binary",
    comprobar: "check: the gateway log must show [gateway] POST /v1/messages → … with the model id in the line.",
    receta: ({ base, puerto }) => [
      `start: bvsala gateway --upstream deepseek --port ${puerto}   (the gateway rewrites /v1/messages to DeepSeek's /anthropic endpoint)`,
      `env:   ANTHROPIC_BASE_URL=${base}   ANTHROPIC_AUTH_TOKEN=<your DeepSeek API key>   ANTHROPIC_MODEL=deepseek-flash`,
      "Why: DeepSeek cache reads cost $0.003/1M and off-peak input $0.15/1M — the cheapest sibling for Claude traffic,",
      "served in Anthropic's own protocol. Metered for models with a list price in the catalog.",
    ],
  },
  {
    id: "openai-compat-cn",
    nombre: "DeepSeek, Qwen, GLM, Moonshot — any OpenAI SDK (Chat Completions)",
    configs: [],
    detectable: false,
    estadoSinDeteccion: "no detection: any language, through the SDK's base URL",
    comprobar:
      "check: the gateway log must show `[gateway] POST /v1/chat/completions …`; if you see `/v1/v1/chat/completions`, there is one /v1 too many.",
    receta: ({ baseV1, puerto }) => [
      `start: bvsala gateway --upstream deepseek --port ${puerto}   (qwen, glm, moonshot, minimax and openrouter work the same: one gateway per upstream)`,
      `python: client = OpenAI(base_url="${baseV1}", api_key="…")   (WITH /v1: the SDK appends /chat/completions)`,
      `node:   const client = new OpenAI({ baseURL: "${baseV1}" })`,
      'streaming: pass stream_options={"include_usage": True} or the stream is forwarded but NOT metered; the last chunk then has an empty choices list.',
      "Metered for models with a list price in the catalog; a model without one is forwarded but not metered.",
    ],
  },
  {
    id: "ollama-local",
    nombre: "Ollama (or vLLM / LM Studio) — local open-weight models",
    configs: [],
    detectable: false,
    estadoSinDeteccion: "no detection: any OpenAI SDK, pointed at your local server through the gateway",
    receta: ({ baseV1, puerto }) => [
      `start: bvsala gateway --upstream ollama --port ${puerto}   (vllm → localhost:8000, lmstudio → localhost:1234)`,
      `python: client = OpenAI(base_url="${baseV1}", api_key="ollama")   (WITH /v1)`,
      "Local models have no list price, so this traffic is forwarded and logged, not metered in dollars:",
      "use it to give coding agents a local free tier while the gateway keeps metering the paid calls.",
    ],
  },
  // Los SDK oficiales, en cualquier lenguaje: no hay binario ni config que
  // buscar, así que no se detectan; la receta va siempre. Cada URL termina en
  // comillas a propósito (el test de formas de URL las recorta ahí).
  {
    id: "python-openai",
    nombre: "Python, or any OpenAI SDK (Chat Completions)",
    configs: [],
    detectable: false,
    estadoSinDeteccion: "no detection: any language, through the SDK's base URL",
    comprobar:
      "check: the gateway log must show `[gateway] POST /v1/chat/completions …`; if you see `/v1/v1/chat/completions`, there is one /v1 too many.",
    receta: ({ baseV1, puerto }) => [
      `start: bvsala gateway --upstream openai --port ${puerto}   (one gateway per upstream: if Claude Code already uses this port, pick another and change the URL below to match)`,
      `python: client = OpenAI(base_url="${baseV1}")   (WITH /v1: the SDK appends /chat/completions)`,
      `node:   const client = new OpenAI({ baseURL: "${baseV1}" })`,
      'streaming: pass stream_options={"include_usage": True} (Node: stream_options: { include_usage: true }) or the stream is forwarded but NOT metered; the last chunk then has an empty choices list, so read chunk.choices only when it is not empty.',
      "stream=False is metered from the usage in the JSON body, and so is client.responses.create. Cost is priced at the model's list price;",
      "a model without one is forwarded but not metered, and the gateway log says so on every such request.",
    ],
  },
  {
    id: "python-anthropic",
    nombre: "Python, or any Anthropic SDK (Messages)",
    configs: [],
    detectable: false,
    estadoSinDeteccion: "no detection: any language, through the SDK's base URL",
    receta: ({ base, puerto }) => [
      `start: bvsala gateway --port ${puerto}   (Anthropic is the default upstream)`,
      `python: client = Anthropic(base_url="${base}")   (NO /v1: the SDK appends /v1/messages)`,
      `node:   const client = new Anthropic({ baseURL: "${base}" })`,
      "streamed and stream=False requests are both metered.",
    ],
  },
];

/** Recorre el PATH directorio a directorio con `existe`; nunca lanza procesos. */
function buscadorEnPath(path: string, existe: (ruta: string) => boolean): (bin: string) => boolean {
  const dirs = path.split(delimiter).filter((d) => d.length > 0);
  const sufijos = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return (bin) => dirs.some((dir) => sufijos.some((s) => existe(join(dir, bin + s))));
}

export async function doctor(puerto: number, opts: OpcionesDoctor = {}): Promise<InformeDoctor> {
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
    throw new RangeError(`[bvsala doctor] invalid port: ${String(puerto)}`);
  }
  const home = opts.home ?? homedir();
  const existe = opts.existe ?? existsSync;
  const enPath = opts.enPath ?? buscadorEnPath(opts.path ?? process.env.PATH ?? "", existe);

  const base = `http://127.0.0.1:${puerto}`;
  const baseV1 = `${base}/v1`;
  const detectados: string[] = [];
  const lineas: string[] = [
    `bvsala doctor — local gateway at ${base}`,
    "Print only: it writes no configuration. Detection by existence (binaries on the PATH and",
    "user configuration files); the contents of a file are never read.",
    "The gateway starts with no keys at all (COMMUNITY mode: every local saving lever on, nothing sent to BiVelio).",
    "BIVELIO_SERVICE_KEY adds the cloud dashboard, org entitlements and team metering.",
    "",
  ];

  for (const t of TERMINALES) {
    const rutas = t.configs.map((c) => join(home, c));
    const enElPath = t.binario !== undefined && enPath(t.binario);
    const presentes = rutas.filter((r) => existe(r));
    const detectado = enElPath || presentes.length > 0;
    if (detectado) detectados.push(t.id);

    let estado: string;
    if (!t.detectable) {
      estado = t.estadoSinDeteccion ?? "no automatic detection (editor extension)";
    } else if (detectado) {
      const pistas = [
        ...(enElPath ? [`binary \`${t.binario}\` on PATH`] : []),
        ...presentes.map((r) => `config present: ${r}`),
      ];
      estado = `detected — ${pistas.join("; ")}`;
    } else {
      estado = "not detected";
    }

    lineas.push(`» ${t.id}: ${estado}`);
    lineas.push(`  ${t.nombre}`);
    for (const l of t.receta({ base, baseV1, puerto, rutas })) lineas.push(`  ${l}`);
    if (t.comprobar !== null) lineas.push(`  ${t.comprobar ?? COMPROBAR}`);
    lineas.push("");
  }

  lineas.push(
    "BYOK rule: the recipes for the third-party terminals (opencode, Kilo, Copilot, Aider, Goose, Crush, Qwen Code, Droid,",
    "Cline, Continue) are for API keys. Never route the OAuth of a Claude Pro/Max subscription through the gateway from a",
    "third-party harness - Anthropic forbids it. Claude Code and Codex on a subscription are routed and metered at",
    "list-price equivalent, with no commission (there is no per-token invoice); the per-seat license applies.",
    "Any language through the gateway: it measures every request whose usage it can read (Anthropic Messages, OpenAI Chat",
    "Completions and Responses) for models with a list price, and its log line says when one is not metered. The saving",
    "levers of the SDK (npm) are TypeScript; the gateway's own levers apply to Anthropic /v1/messages with a PRO license.",
    "Per-terminal detail: docs/terminales/<terminal>.md",
  );

  return { texto: lineas.join("\n"), detectados };
}
