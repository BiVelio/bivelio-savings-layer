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
  /** Falso en los que no se pueden detectar (Cline, Kilo). */
  detectable: boolean;
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
      `mechanism: ${rutas[0]} → provider.anthropic.options.baseURL (the project's opencode.json overrides the global one). WITH /v1.`,
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
    id: "kilo",
    nombre: "Kilo Code",
    configs: [],
    detectable: false,
    receta: ({ baseV1 }) => [
      "mechanism: UI → custom provider, Provider API \"Anthropic Messages\". Try WITH /v1 first (Cline lineage) [inferred: validate by hand].",
      `Base URL: ${baseV1}`,
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
      estado = "no automatic detection (editor extension)";
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
    for (const l of t.receta({ base, baseV1, rutas })) lineas.push(`  ${l}`);
    lineas.push(`  ${COMPROBAR}`);
    lineas.push("");
  }

  lineas.push(
    "BYOK rule: the recipes for the Anthropic-compatible terminals (Goose, Qwen Code, opencode, Crush, Droid, Cline,",
    "Kilo) are for API keys. Never route the OAuth of a Claude Pro/Max subscription through the gateway from a",
    "third-party harness — Anthropic forbids it. Claude Code and Codex on a subscription are routed and metered,",
    "but not billed: there is no per-token invoice.",
    "Per-terminal detail: docs/terminales/<terminal>.md",
  );

  return { texto: lineas.join("\n"), detectados };
}
