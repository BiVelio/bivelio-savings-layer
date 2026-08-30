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
  "comprobar: en el log del gateway debe aparecer `[gateway] POST /v1/messages …`; " +
  "si ves `/v1/v1/messages`, sobra un /v1; si ves `POST /messages` a secas, falta uno.";

const TERMINALES: readonly Terminal[] = [
  {
    id: "claude",
    nombre: "Claude Code",
    binario: "claude",
    configs: [],
    detectable: true,
    receta: ({ base }) => [
      "usa `bvsala claude` — arranca el gateway en un puerto efímero, lanza `claude` apuntándole y lo apaga al salir.",
      `a mano: ANTHROPIC_BASE_URL=${base} claude   (sin /v1: el cliente añade /v1/messages)`,
    ],
  },
  {
    id: "codex",
    nombre: "Codex CLI",
    binario: "codex",
    configs: [join(".codex", "config.toml"), join(".codex", "auth.json")],
    detectable: true,
    receta: ({ base, rutas }) => [
      "usa `bvsala codex` — el prefijo del base URL depende del modo de auth y lo resuelve el envoltorio:",
      `  API key           → openai_base_url=${base}/v1`,
      `  suscripción ChatGPT → openai_base_url=${base}/backend-api/codex   (tiene que terminar exactamente ahí)`,
      `${rutas[1]}: solo se comprueba que exista; nunca se lee.`,
    ],
  },
  {
    id: "opencode",
    nombre: "opencode",
    binario: "opencode",
    configs: [join(".config", "opencode", "opencode.json")],
    detectable: true,
    receta: ({ baseV1, rutas }) => [
      `mecanismo: ${rutas[0]} → provider.anthropic.options.baseURL (el opencode.json del proyecto pisa al global). CON /v1.`,
      "{",
      '  "provider": {',
      '    "anthropic": {',
      `      "options": { "baseURL": "${baseV1}" }`,
      "    }",
      "  }",
      "}",
      'alternativa: "baseURL": "{env:BVSALA_BASE_URL}" y exportar la variable; trampa: sin la variable, baseURL queda vacío.',
    ],
  },
  {
    id: "goose",
    nombre: "Goose",
    binario: "goose",
    configs: [join(".config", "goose", "config.yaml")],
    detectable: true,
    receta: ({ base, rutas }) => [
      `mecanismo: variable de entorno ANTHROPIC_HOST (pisa ${rutas[0]}). SIN /v1.`,
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
      `mecanismo: ${rutas[0]} (Bash); crush.json está deprecado. CON /v1 y SIN barra final (el SDK Go resuelve relativo: /v1/ → /v1/v1/messages).`,
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
      `mecanismo: variable de entorno ANTHROPIC_BASE_URL + ${rutas[0]} con selectedType = anthropic. SIN /v1 (el SDK TS oficial añade /v1/messages).`,
      `ANTHROPIC_BASE_URL=${base} ANTHROPIC_API_KEY=… qwen`,
      `comprueba a mano que ${rutas[0]} lleve selectedType: anthropic — el doctor no lee el archivo.`,
    ],
  },
  {
    id: "droid",
    nombre: "Droid (Factory)",
    binario: "droid",
    configs: [join(".factory", "settings.json")],
    detectable: true,
    receta: ({ base, rutas }) => [
      `mecanismo: ${rutas[0]} → customModels[] con provider "anthropic". SIN /v1 [inferido: validar en mano contra el log del gateway].`,
      "{",
      '  "customModels": [',
      "    {",
      '      "model": "<id de modelo Anthropic>",',
      '      "displayName": "<nombre visible>",',
      '      "provider": "anthropic",',
      `      "baseUrl": "${base}",`,
      '      "apiKey": "<tu API key de Anthropic>"',
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
      "mecanismo: UI → proveedor Anthropic → marca «Use custom base URL». CON /v1 (Cline fija https://api.anthropic.com/v1 y solo normaliza la URL oficial exacta).",
      `Base URL: ${baseV1}`,
    ],
  },
  {
    id: "kilo",
    nombre: "Kilo Code",
    configs: [],
    detectable: false,
    receta: ({ baseV1 }) => [
      "mecanismo: UI → proveedor custom, Provider API «Anthropic Messages». Probar CON /v1 primero (linaje Cline) [inferido: validar en mano].",
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
    throw new RangeError(`[bvsala doctor] puerto inválido: ${String(puerto)}`);
  }
  const home = opts.home ?? homedir();
  const existe = opts.existe ?? existsSync;
  const enPath = opts.enPath ?? buscadorEnPath(opts.path ?? process.env.PATH ?? "", existe);

  const base = `http://127.0.0.1:${puerto}`;
  const baseV1 = `${base}/v1`;
  const detectados: string[] = [];
  const lineas: string[] = [
    `bvsala doctor — gateway local en ${base}`,
    "Solo imprime: no escribe ninguna configuración. Detección por existencia (binarios en PATH y",
    "archivos de configuración de usuario); nunca se lee el contenido de ningún archivo.",
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
      estado = "sin detección automática (extensión de editor)";
    } else if (detectado) {
      const pistas = [
        ...(enElPath ? [`binario \`${t.binario}\` en PATH`] : []),
        ...presentes.map((r) => `config presente: ${r}`),
      ];
      estado = `detectado — ${pistas.join("; ")}`;
    } else {
      estado = "no detectado";
    }

    lineas.push(`» ${t.id}: ${estado}`);
    lineas.push(`  ${t.nombre}`);
    for (const l of t.receta({ base, baseV1, rutas })) lineas.push(`  ${l}`);
    lineas.push(`  ${COMPROBAR}`);
    lineas.push("");
  }

  lineas.push(
    "Regla BYOK: las recetas del anillo Anthropic (Goose, Qwen Code, opencode, Crush, Droid, Cline, Kilo) son",
    "para API key. Nunca enrutes por el gateway el OAuth de una suscripción Claude Pro/Max desde un harness",
    "de terceros — Anthropic lo prohíbe. Claude Code y Codex con suscripción se enrutan y se miden, pero no",
    "se monetizan: no hay factura por tokens.",
    "Detalle por terminal: docs/terminales/<terminal>.md",
  );

  return { texto: lineas.join("\n"), detectados };
}
