/**
 * LOS ENVOLTORIOS — `bvsala <terminal> [args…]`: arrancar el gateway en un
 * puerto efímero, lanzar el terminal apuntándole y morir con él. Una tabla
 * pura (sin efectos) para que bin.ts solo ejecute y los tests solo afirmen.
 *
 * Solo entran terminales que se redirigen por ENTORNO o por flag de línea de
 * comandos: cero configuración persistente en la máquina del cliente. Los que
 * solo se configuran por archivo (Crush, Droid, Continue) o por UI (Cline, el
 * BYOK de Copilot en VS Code) van por `bvsala doctor`, que imprime el bloque
 * exacto.
 *
 * opencode y Kilo se configuran por archivo, pero los dos aceptan la config
 * ENTERA por una variable (`OPENCODE_CONFIG_CONTENT`, `KILO_CONFIG_CONTENT`)
 * que se fusiona por encima de los archivos global y de proyecto: eso los mete
 * aquí sin escribir nada en disco (docs/investigacion/2026-09-27/agentes-de-codigo.md).
 *
 * Formas del base URL (docs/PASARELA-S3-TERMINALES.md §3 y el informe de hoy,
 * verificadas por SDK): Claude Code, Goose, Qwen Code, el tipo `anthropic` de
 * Copilot CLI y Aider (litellm) lo quieren SIN `/v1` (su cliente añade
 * `/v1/messages`); opencode y Kilo CON `/v1` (añaden `/messages`); Codex con el
 * prefijo de su backend.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type ModoAuthCodex = "api-key" | "chatgpt";

export interface Envoltorio {
  bin: string;
  args: string[];
  env: Record<string, string>;
  /** Upstream que debe usar el gateway de este envoltorio (Anthropic si falta). */
  upstream?: string;
  nota?: string;
}

export const TERMINALES_CON_ENVOLTORIO = ["claude", "codex", "goose", "qwen", "opencode", "kilo", "copilot", "aider", "gemini"] as const;
export type TerminalConEnvoltorio = (typeof TERMINALES_CON_ENVOLTORIO)[number];

export function esTerminalConEnvoltorio(comando: string | undefined): comando is TerminalConEnvoltorio {
  return (TERMINALES_CON_ENVOLTORIO as readonly string[]).includes(comando ?? "");
}

export type BinarioResuelto =
  | { tipo: "exe"; ruta: string }
  | { tipo: "solo-shim"; ruta: string }
  | { tipo: "no-encontrado" };

/**
 * Resolución de binarios en WINDOWS, a mano, porque spawn no puede:
 *
 *   · libuv solo prueba `.com`/`.exe` al buscar en el PATH (jamás consulta
 *     PATHEXT): un `claude.exe` se encuentra sin extensión; un `claude.cmd`
 *     (el shim que deja `npm i -g`) termina en ENOENT.
 *   · Y lanzar un `.cmd`/`.bat` no es una opción segura: Node lo rechaza con
 *     EINVAL desde CVE-2024-27980 porque sus argumentos «a veces no pueden
 *     escaparse sin ambigüedad», y la vía `shell: true` concatena los args sin
 *     escape alguno (inyección; deprecada en runtime, DEP0190).
 *
 * Así que: `.exe`/`.com` → ruta directa (dir del PATH con prioridad, como
 * libuv); solo shim → se informa para negarse con guía. Pura e inyectable
 * para los tests.
 */
export function resolverBinarioWindows(
  bin: string,
  opts: { path?: string; existe?: (ruta: string) => boolean } = {},
): BinarioResuelto {
  const path = opts.path ?? process.env.PATH ?? "";
  const existe = opts.existe ?? existsSync;
  let shim: string | null = null;
  for (const dir of path.split(";").filter((d) => d.length > 0)) {
    for (const ext of [".exe", ".com"]) {
      const ruta = join(dir, bin + ext);
      if (existe(ruta)) return { tipo: "exe", ruta };
    }
    if (shim === null) {
      for (const ext of [".cmd", ".bat"]) {
        const ruta = join(dir, bin + ext);
        if (existe(ruta)) {
          shim = ruta;
          break;
        }
      }
    }
  }
  return shim !== null ? { tipo: "solo-shim", ruta: shim } : { tipo: "no-encontrado" };
}

/**
 * El modo de auth de Codex decide el DESTINO y el PREFIJO: con API key el
 * tráfico va a api.openai.com/v1; con la familia ChatGPT (Chatgpt,
 * ChatgptAuthTokens, Headers, AgentIdentity, PersonalAccessToken) va a
 * chatgpt.com/backend-api/codex — y `supports_codex_backend_routes()` solo
 * sobrevive si el base_url TERMINA exactamente en `/backend-api/codex`.
 *
 * Se decide sin tocar valores de credenciales: `BVSALA_CODEX_AUTH` manda; si
 * no, el campo `auth_mode` de ~/.codex/auth.json (un enum, nunca un secreto) o
 * la mera EXISTENCIA de las claves `tokens` / `OPENAI_API_KEY`. Nada de ese
 * archivo se registra ni se imprime jamás.
 */
export function modoAuthCodex(opts: { env?: NodeJS.ProcessEnv; leerAuth?: () => string | null } = {}): ModoAuthCodex {
  const env = opts.env ?? process.env;
  const forzado = env.BVSALA_CODEX_AUTH?.toLowerCase();
  if (forzado === "api-key" || forzado === "apikey") return "api-key";
  if (forzado === "chatgpt") return "chatgpt";
  let texto: string | null = null;
  try {
    texto = opts.leerAuth ? opts.leerAuth() : null;
  } catch {
    texto = null;
  }
  if (texto === null) return "api-key";
  try {
    const auth = JSON.parse(texto) as { auth_mode?: unknown; tokens?: unknown; OPENAI_API_KEY?: unknown };
    if (typeof auth.auth_mode === "string") {
      return auth.auth_mode.toLowerCase().replace(/[^a-z]/g, "") === "apikey" ? "api-key" : "chatgpt";
    }
    if (auth.tokens !== undefined && auth.tokens !== null) return "chatgpt";
    return "api-key";
  } catch {
    return "api-key";
  }
}

export const CODEX_DESTINO: Record<ModoAuthCodex, { upstream: string; prefijo: string }> = {
  "api-key": { upstream: "https://api.openai.com", prefijo: "/v1" },
  chatgpt: { upstream: "https://chatgpt.com", prefijo: "/backend-api/codex" },
};

const ORIGEN_ANTHROPIC = "https://api.anthropic.com";
const ORIGEN_OPENAI = "https://api.openai.com";
const ORIGEN_GEMINI = "https://generativelanguage.googleapis.com";

/** La variable que lleva la config inline de cada terminal de la familia opencode. */
const VARIABLE_DE_CONFIG = { opencode: "OPENCODE_CONFIG_CONTENT", kilo: "KILO_CONFIG_CONTENT" } as const;

/**
 * La config inline de opencode o Kilo con `provider.anthropic.options.baseURL`
 * apuntando al gateway. Si el usuario ya exporta su propia config inline, se
 * FUSIONA (solo se toca esa clave; su `apiKey`, sus modelos y lo demás siguen
 * como estaban) en vez de pisarla. Si no es un objeto JSON, no se adivina:
 * `null`, y `impedimentoDeEnvoltorio` lo dice antes de arrancar nada. El
 * contenido del usuario puede llevar una clave: jamás se imprime.
 */
export function configInlineConBaseURL(existente: string | undefined, baseURL: string): string | null {
  let raiz: Record<string, unknown> = {};
  if (existente !== undefined && existente.trim() !== "") {
    let parseado: unknown;
    try {
      parseado = JSON.parse(existente);
    } catch {
      return null;
    }
    if (typeof parseado !== "object" || parseado === null || Array.isArray(parseado)) return null;
    raiz = parseado as Record<string, unknown>;
  }
  const hijo = (padre: Record<string, unknown>, clave: string): Record<string, unknown> | null => {
    const v = padre[clave];
    if (v === undefined) return {};
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  };
  const provider = hijo(raiz, "provider");
  const anthropic = provider && hijo(provider, "anthropic");
  const options = anthropic && hijo(anthropic, "options");
  if (!provider || !anthropic || !options) return null;
  return JSON.stringify({
    ...raiz,
    provider: { ...provider, anthropic: { ...anthropic, options: { ...options, baseURL } } },
  });
}

export type DestinoCopilot = { ok: true; ruta: string } | { ok: false; error: string };

/**
 * Copilot CLI solo pasa por un base URL con BYOK (su propia clave de
 * proveedor): los modelos alojados por GitHub van a GitHub y no hay nada que
 * medir ahí. La doc oficial (use-byok-models, consultada el 2026-09-27) fija
 * `COPILOT_PROVIDER_BASE_URL` (obligatoria) y `COPILOT_PROVIDER_TYPE`
 * (`openai` por defecto, `azure` o `anthropic`).
 *
 * Solo se envuelve el tipo `anthropic` contra el origen OFICIAL, que es lo que
 * el catálogo sabe tarifar a precio de lista (Azure, un Ollama local o un
 * revendedor tienen otras tarifas, o ninguna). El tipo `openai` se queda fuera
 * POR AHORA: desde la 1.0.64 la CLI habla la Responses API por WebSocket con
 * BYOK («Add websocket responses support for BYOK OpenAI-compatible
 * providers», changelog de github/copilot-cli), el gateway responde 426 a todo
 * upgrade, y no sabemos si la CLI cae a HTTP como Codex. Un envoltorio que
 * puede romper la sesión no se publica sin validarlo en mano. Se conserva la
 * RUTA que el usuario ya tenía: si su config funcionaba directa, funciona igual.
 */
export function destinoCopilot(entorno: Record<string, string | undefined>): DestinoCopilot {
  const base = entorno.COPILOT_PROVIDER_BASE_URL?.trim() ?? "";
  if (base === "") {
    return {
      ok: false,
      error:
        "Copilot CLI goes through a base URL only with your own provider key (BYOK). Without " +
        "COPILOT_PROVIDER_BASE_URL it uses GitHub-hosted models, which never pass through the gateway: there is nothing " +
        "to meter (its /usage shows those AI credits). To meter BYOK with Anthropic, export COPILOT_PROVIDER_TYPE=anthropic, " +
        "COPILOT_PROVIDER_BASE_URL=https://api.anthropic.com, COPILOT_PROVIDER_API_KEY and COPILOT_MODEL, and run " +
        "`bvsala copilot` again.",
    };
  }
  const tipo = entorno.COPILOT_PROVIDER_TYPE?.trim().toLowerCase() || "openai";
  if (tipo === "openai") {
    return {
      ok: false,
      error:
        "`bvsala copilot` wraps the anthropic provider type only for now. With the openai type (the default) Copilot CLI " +
        "can call the Responses API over WebSocket, which the gateway answers with 426, and its fallback to HTTP is not " +
        "validated yet. To meter it by hand and check the log, see `bvsala doctor`.",
    };
  }
  if (tipo !== "anthropic") {
    return {
      ok: false,
      error:
        // El valor no se repite: una clave pegada en la variable equivocada no
        // puede acabar en stderr (y de ahí en un issue).
        "COPILOT_PROVIDER_TYPE is neither anthropic nor openai: the gateway prices only the provider's own API at its " +
        "list price (Azure, a local model or a reseller bills differently, or not at all), so `bvsala copilot` wraps " +
        "the anthropic type only.",
    };
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { ok: false, error: "COPILOT_PROVIDER_BASE_URL is not a URL: fix it so Copilot CLI works directly first." };
  }
  if (url.origin !== ORIGEN_ANTHROPIC) {
    return {
      ok: false,
      error:
        `COPILOT_PROVIDER_BASE_URL does not point at ${ORIGEN_ANTHROPIC}: the gateway prices only the provider's own API ` +
        "at its list price (a local model or a reseller bills differently, or not at all), so it does not wrap it.",
    };
  }
  return { ok: true, ruta: url.pathname.replace(/\/+$/, "") };
}

/**
 * Lo que impide lanzar un envoltorio, dicho ANTES de arrancar nada (ni
 * licencia, ni red, ni gateway). `null` = adelante. Puro: solo LEE el entorno,
 * y el mensaje nunca repite un valor que pueda ser una clave.
 */
export function impedimentoDeEnvoltorio(
  comando: TerminalConEnvoltorio,
  entorno: Record<string, string | undefined> = process.env,
): string | null {
  if (comando === "opencode" || comando === "kilo") {
    const variable = VARIABLE_DE_CONFIG[comando];
    if (configInlineConBaseURL(entorno[variable], "http://127.0.0.1:1/v1") === null) {
      return (
        `${variable} is set but is not a JSON object with an object at provider.anthropic.options, so the wrapper ` +
        "cannot add the gateway's baseURL without guessing (its value is not shown). Unset it, or use the manual " +
        `recipe in \`bvsala doctor\`.`
      );
    }
    return null;
  }
  if (comando === "copilot") {
    const d = destinoCopilot(entorno);
    return d.ok ? null : d.error;
  }
  return null;
}

/**
 * EL BASE URL QUE EL USUARIO YA TENÍA. El envoltorio pone el del gateway en la
 * variable del terminal (`ANTHROPIC_BASE_URL`…) y el gateway habla por defecto
 * con api.anthropic.com. Si el usuario ya apuntaba su terminal a OTRO endpoint
 * (un proxy de empresa, LiteLLM, z.ai, Moonshot…), pisarlo mandaba su sesión
 * —y el token de ESE proxy— a Anthropic: un 401 sin explicación y una
 * credencial en el host equivocado.
 *
 * La regla, por orden, y siempre del lado seguro (la credencial solo viaja al
 * host que el usuario ya había elegido):
 *   · sin variable previa, o apuntando al API oficial → nada cambia;
 *   · con `BVSALA_GATEWAY_UPSTREAM` puesto: si coincide con el origen previo,
 *     nada que hacer; si NO coincide, no se arranca (dos destinos distintos
 *     para una credencial: decide el usuario, no el envoltorio);
 *   · un origen pelado (sin ruta) → ESE es el upstream del gateway, con una
 *     línea que lo dice. Se mide igual; al no ser el API oficial, no se
 *     acredita ahorro (precio de lista solo en el proveedor);
 *   · con prefijo de ruta (`https://host/api/anthropic`) → no se arranca: el
 *     gateway reenvía a un ORIGEN y perdería el prefijo. Las excepciones: la
 *     ruta que el propio envoltorio pone detrás del gateway (`/v1` en Codex con
 *     API key, opencode y Kilo), que se conserva tal cual, y DeepSeek, cuyo
 *     `/anthropic` ya reescribe el gateway.
 *
 * A2-12 · la misma regla para todos los envoltorios, no solo los de Anthropic:
 * gemini (GOOGLE_GEMINI_BASE_URL), codex (OPENAI_BASE_URL) y opencode/Kilo (un
 * `provider.anthropic.options.baseURL` en su config inline). Codex con cuenta
 * ChatGPT y un OPENAI_BASE_URL propio no arranca: el envoltorio manda ese
 * tráfico a la ruta de chatgpt.com y no sabe reproducir el destino del usuario.
 * Pura: solo LEE el entorno, y el mensaje enseña como mucho el ORIGEN (nunca
 * usuario:contraseña ni la ruta, que pueden llevar una credencial).
 */
export type UpstreamHeredado =
  | { tipo: "ninguno" }
  | { tipo: "usar"; upstream: string; variable: string; aviso: string }
  | { tipo: "impedimento"; variable: string; error: string };

/**
 * El base URL previo de cada terminal: dónde lo lee (`variable`, el nombre que
 * se enseña), su valor, el origen oficial al que apunta por defecto y la ruta
 * que el envoltorio pone detrás del gateway (un valor previo con esa misma ruta
 * se reenvía tal cual).
 */
interface BaseUrlPrevio {
  variable: string;
  valor: string;
  oficial: string;
  ruta: "" | "/v1";
}

/** `provider.anthropic.options.baseURL` de la config inline de opencode o Kilo, si es un texto. */
function baseUrlDeConfigInline(contenido: string | undefined): string | undefined {
  if (contenido === undefined || contenido.trim() === "") return undefined;
  try {
    const v = (JSON.parse(contenido) as { provider?: { anthropic?: { options?: { baseURL?: unknown } } } })?.provider
      ?.anthropic?.options?.baseURL;
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  } catch {
    // Ilegible: lo dice impedimentoDeEnvoltorio antes de llegar aquí.
    return undefined;
  }
}

function baseUrlPrevio(
  comando: TerminalConEnvoltorio,
  entorno: Record<string, string | undefined>,
  upstreamElegido: string | undefined,
): BaseUrlPrevio | null {
  const primera = (variables: readonly string[], oficial: string, ruta: "" | "/v1"): BaseUrlPrevio | null => {
    const variable = variables.find((v) => (entorno[v] ?? "").trim() !== "");
    return variable === undefined ? null : { variable, valor: entorno[variable]!, oficial, ruta };
  };
  switch (comando) {
    case "claude":
    case "qwen":
      return primera(["ANTHROPIC_BASE_URL"], ORIGEN_ANTHROPIC, "");
    case "goose":
      return primera(["ANTHROPIC_HOST"], ORIGEN_ANTHROPIC, "");
    case "aider":
      // El mismo orden en que las lee litellm.
      return upstreamElegido === ORIGEN_OPENAI
        ? primera(["OPENAI_BASE_URL", "OPENAI_API_BASE"], ORIGEN_OPENAI, "")
        : primera(["ANTHROPIC_API_BASE", "ANTHROPIC_BASE_URL"], ORIGEN_ANTHROPIC, "");
    case "gemini":
      return primera(["GOOGLE_GEMINI_BASE_URL"], ORIGEN_GEMINI, "");
    case "codex":
      // El proveedor integrado de Codex lee OPENAI_BASE_URL (CON /v1, como el
      // `-c openai_base_url` que pone el envoltorio).
      return primera(["OPENAI_BASE_URL"], ORIGEN_OPENAI, "/v1");
    case "opencode":
    case "kilo": {
      const variable = VARIABLE_DE_CONFIG[comando];
      const valor = baseUrlDeConfigInline(entorno[variable]);
      return valor === undefined
        ? null
        : { variable: `provider.anthropic.options.baseURL in ${variable}`, valor, oficial: ORIGEN_ANTHROPIC, ruta: "/v1" };
    }
    default:
      // Copilot exige el origen oficial en su propia rama (destinoCopilot).
      return null;
  }
}

export function upstreamHeredado(
  comando: TerminalConEnvoltorio,
  entorno: Record<string, string | undefined> = process.env,
  /** `BVSALA_GATEWAY_UPSTREAM` ya resuelto a origen, si el usuario lo puso. */
  upstreamElegido?: string,
  /** El modo de auth de Codex (solo lo mira codex). */
  modoCodex?: ModoAuthCodex,
): UpstreamHeredado {
  const tabla = baseUrlPrevio(comando, entorno, upstreamElegido);
  if (tabla === null) return { tipo: "ninguno" };
  const variable = tabla.variable;
  const comoSeguir =
    `Run \`${comando}\` directly to keep using that endpoint (not metered), or unset ${variable} to go ` +
    `through the gateway to ${tabla.oficial}.`;
  let url: URL;
  try {
    url = new URL(tabla.valor.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("esquema");
  } catch {
    return {
      tipo: "impedimento",
      variable,
      error:
        `${variable} is already set but is not an http(s) URL, so the wrapper cannot tell where your terminal was ` +
        `pointing and will not replace it (its value is not shown). ${comoSeguir}`,
    };
  }
  if (url.origin === tabla.oficial) return { tipo: "ninguno" };
  if (comando === "codex" && modoCodex === "chatgpt") {
    return {
      tipo: "impedimento",
      variable,
      error:
        `${variable} points Codex at ${url.origin}, but Codex is signed in with ChatGPT and the wrapper sends that ` +
        "traffic to chatgpt.com/backend-api/codex: it cannot reproduce your endpoint, so it does not start and does " +
        `not replace your variable. ${comoSeguir}`,
    };
  }
  if (upstreamElegido !== undefined) {
    let elegido = upstreamElegido;
    try {
      elegido = new URL(upstreamElegido).origin;
    } catch {
      /* se compara tal cual */
    }
    if (elegido === url.origin) return { tipo: "ninguno" };
    return {
      tipo: "impedimento",
      variable,
      error:
        `${variable} points your terminal at ${url.origin} but BVSALA_GATEWAY_UPSTREAM sends this session to ` +
        `${elegido}: the credentials meant for one would be sent to the other, so the wrapper does not start. ` +
        "Unset one of the two so there is a single destination.",
    };
  }
  const ruta = url.pathname.replace(/\/+$/, "");
  const deepseekAnthropic = url.origin === "https://api.deepseek.com" && ruta === "/anthropic";
  // La ruta tiene que ser EXACTAMENTE la que el envoltorio pone detrás del
  // gateway: sin ella (o con otra) la petición llegaría a otra ruta del proxy.
  if ((ruta !== tabla.ruta && !deepseekAnthropic) || url.search !== "") {
    const queFalla =
      ruta === "" && url.search === ""
        ? `${variable} is already set to ${url.origin} without the ${tabla.ruta} path the wrapper always adds, so the ` +
          "gateway could not reproduce your endpoint. The wrapper"
        : `${variable} is already set to an endpoint with a path prefix at ${url.origin}. The gateway forwards to an ` +
          "origin and would drop that prefix, so the wrapper";
    return {
      tipo: "impedimento",
      variable,
      error:
        `${queFalla} does not start and does not replace your variable ` +
        `(your credentials for that endpoint are never sent to ${tabla.oficial}). ${comoSeguir}`,
    };
  }
  return {
    tipo: "usar",
    upstream: url.origin,
    variable,
    aviso:
      `${variable} was already set to ${url.origin}: the gateway forwards this session THERE instead of ` +
      `${tabla.oficial}, so your credentials only reach the endpoint you chose. Requests are metered; no saving is ` +
      `credited behind an endpoint that is not the provider's own API. To use ${tabla.oficial} instead, unset ${variable}.`,
  };
}

export function envoltorioDe(
  comando: TerminalConEnvoltorio,
  puerto: number,
  resto: string[],
  opts: {
    modoCodex?: ModoAuthCodex;
    /** El upstream que ya eligió el usuario (`BVSALA_GATEWAY_UPSTREAM`, resuelto a origen). Solo lo mira aider. */
    upstreamElegido?: string;
  } = {},
  /** Entorno del usuario (solo se LEE; nunca se imprime). Inyectable en tests. */
  entorno: Record<string, string | undefined> = process.env,
): Envoltorio {
  const base = `http://127.0.0.1:${puerto}`;
  switch (comando) {
    case "claude":
      // Con un ANTHROPIC_BASE_URL que no es api.anthropic.com, Claude Code APAGA por
      // defecto la búsqueda de herramientas y manda TODAS las definiciones (MCP incluidas)
      // en el prefijo de cada petición (doc oficial env-vars: «When set to a non-first-party
      // host, MCP tool search is disabled by default. Set ENABLE_TOOL_SEARCH=true if your
      // proxy forwards tool_reference blocks»). Este gateway reenvía anthropic-beta y los
      // bloques tool_reference intactos (servidor.ts), así que la activamos por defecto.
      // Medido el 2026-09-09 en el corpus del dueño: 253 tools = 450 KB por petición, el
      // 66 % de los bytes y el 25 % de la factura sombra del día. Si el usuario ya fijó
      // ENABLE_TOOL_SEARCH (true/false/auto/auto:N), se respeta tal cual.
      return {
        bin: "claude",
        args: resto,
        env: { ANTHROPIC_BASE_URL: base, ENABLE_TOOL_SEARCH: entorno.ENABLE_TOOL_SEARCH ?? "true" },
      };
    case "goose":
      return { bin: "goose", args: resto, env: { ANTHROPIC_HOST: base } };
    case "qwen":
      return {
        bin: "qwen",
        args: resto,
        env: { ANTHROPIC_BASE_URL: base },
        // La clave anidada es la que lee Qwen Code hoy (settingsSchema.ts de
        // QwenLM/qwen-code v0.28.3); para Anthropic no tiene modelo por defecto.
        nota:
          "Qwen Code routes through here with the Anthropic auth type: `security.auth.selectedType: \"anthropic\"` in " +
          "~/.qwen/settings.json (or --auth-type anthropic), and a Claude model in ANTHROPIC_MODEL or model.name " +
          "(see `bvsala doctor`).",
      };
    case "opencode":
    case "kilo": {
      // La config inline se fusiona por ENCIMA de la global y la de proyecto
      // (opencode: config.ts, antes solo de la de cuenta y la gestionada; Kilo:
      // fork de opencode, misma cadena). CON /v1: su capa de protocolo añade
      // `/messages` a `https://api.anthropic.com/v1` por defecto.
      const variable = VARIABLE_DE_CONFIG[comando];
      const contenido = configInlineConBaseURL(entorno[variable], `${base}/v1`);
      const nombre = comando === "opencode" ? "opencode" : "Kilo";
      return {
        bin: comando,
        args: resto,
        // Con un contenido ilegible, impedimentoDeEnvoltorio ya paró antes; aquí
        // solo se llega desde `--help` (sin gateway) o en tests.
        env: contenido === null ? {} : { [variable]: contenido },
        nota:
          `routes ${nombre}'s \`anthropic\` provider (your Anthropic API key) through the gateway, with ${variable}: ` +
          "nothing is written to disk. Other providers" +
          (comando === "kilo" ? ", the Kilo Gateway included," : "") +
          " go straight to their API and are not metered.",
      };
    }
    case "copilot": {
      // Con BYOK de Anthropic (el único tipo que se envuelve, ver destinoCopilot)
      // el upstream es el de por defecto: api.anthropic.com.
      const d = destinoCopilot(entorno);
      if (!d.ok) return { bin: "copilot", args: resto, env: {} };
      return {
        bin: "copilot",
        args: resto,
        env: { COPILOT_PROVIDER_BASE_URL: `${base}${d.ruta}` },
        nota: "BYOK with Anthropic: the gateway routes to api.anthropic.com. Your key and model stay as you exported them.",
      };
    }
    case "aider": {
      // Aider habla por litellm. Anthropic por defecto (el orden de aider con
      // ANTHROPIC_API_KEY presente elige sonnet): litellm lee ANTHROPIC_API_BASE
      // antes que ANTHROPIC_BASE_URL y añade `/v1/messages` si no termina así →
      // SIN /v1. Con BVSALA_GATEWAY_UPSTREAM=openai, OPENAI_BASE_URL y
      // OPENAI_API_BASE (litellm las lee en ese orden), CON /v1.
      if (opts.upstreamElegido === ORIGEN_OPENAI) {
        const inyeccion = entorno.BVSALA_GATEWAY_USAGE_INJECT === "1";
        return {
          bin: "aider",
          args: resto,
          env: { OPENAI_BASE_URL: `${base}/v1`, OPENAI_API_BASE: `${base}/v1` },
          upstream: ORIGEN_OPENAI,
          nota:
            "OpenAI models through the gateway (Anthropic ones go direct in this run). " +
            (inyeccion
              ? "Usage injection is on: streamed replies ask for their usage."
              : "litellm asks for streamed usage only when it talks to api.openai.com itself: streamed replies are " +
                "forwarded but NOT metered unless you relaunch with BVSALA_GATEWAY_USAGE_INJECT=1 (or use --no-stream)."),
        };
      }
      return {
        bin: "aider",
        args: resto,
        env: { ANTHROPIC_API_BASE: base },
        nota:
          "Anthropic models through the gateway; OpenAI and other providers go direct and are not metered " +
          "(for OpenAI models: BVSALA_GATEWAY_UPSTREAM=openai bvsala aider).",
      };
    }
    case "gemini":
      // La CLI de Gemini solo habla el protocolo generativelanguage
      // (GOOGLE_GEMINI_BASE_URL), no un endpoint compatible con OpenAI: el
      // gateway la envuelve con --upstream gemini y lee el usage de
      // :generateContent / :streamGenerateContent (gateway/gemini.ts). La
      // API key del usuario viaja en x-goog-api-key, intacta.
      return {
        bin: "gemini",
        args: resto,
        env: { GOOGLE_GEMINI_BASE_URL: base },
        upstream: ORIGEN_GEMINI,
        nota:
          "Gemini CLI through the gateway (GOOGLE_GEMINI_BASE_URL): usage is read from the Gemini responses, " +
          "metered for models with a list price. Your GEMINI_API_KEY stays yours and never reaches BiVelio.",
      };
    case "codex": {
      const modo = opts.modoCodex ?? "api-key";
      const destino = CODEX_DESTINO[modo];
      // `-c` es el override de máxima precedencia y muere con el proceso: no se
      // escribe ~/.codex/config.toml. No existe variable de entorno para esto.
      return {
        bin: "codex",
        args: ["-c", `openai_base_url="${base}${destino.prefijo}"`, ...resto],
        env: {},
        upstream: destino.upstream,
        nota:
          modo === "chatgpt"
            ? "ChatGPT auth detected: the gateway routes to chatgpt.com/backend-api/codex. Subscription traffic is metered at list-price equivalent (there is no per-token invoice) and no saving is credited on it."
            : "API key auth: the gateway routes to api.openai.com/v1.",
      };
    }
  }
}
