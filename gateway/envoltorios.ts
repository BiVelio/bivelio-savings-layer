/**
 * LOS ENVOLTORIOS — `bvsala <terminal> [args…]`: arrancar el gateway en un
 * puerto efímero, lanzar el terminal apuntándole y morir con él. Una tabla
 * pura (sin efectos) para que bin.ts solo ejecute y los tests solo afirmen.
 *
 * Solo entran terminales que se redirigen por ENTORNO o por flag de línea de
 * comandos: cero configuración persistente en la máquina del cliente. Los que
 * se configuran por archivo (opencode, Crush, Droid) o por UI (Cline, Kilo)
 * van por `bvsala doctor`, que imprime el bloque exacto.
 *
 * Formas del base URL (docs/PASARELA-S3-TERMINALES.md §3, verificadas por SDK):
 * Claude Code, Goose y Qwen Code lo quieren SIN `/v1` (su SDK añade
 * `/v1/messages`); Codex lo quiere con el prefijo de su backend.
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

export const TERMINALES_CON_ENVOLTORIO = ["claude", "codex", "goose", "qwen"] as const;
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

export function envoltorioDe(
  comando: TerminalConEnvoltorio,
  puerto: number,
  resto: string[],
  opts: { modoCodex?: ModoAuthCodex } = {},
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
        nota: "Qwen Code only routes through here with `security.auth.selectedType: \"anthropic\"` in ~/.qwen/settings.json (see `bvsala doctor`).",
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
            ? "ChatGPT auth detected: the gateway routes to chatgpt.com/backend-api/codex. Subscription traffic is metered (list-price equivalent) but not billed: there is no per-token invoice."
            : "API key auth: the gateway routes to api.openai.com/v1.",
      };
    }
  }
}
