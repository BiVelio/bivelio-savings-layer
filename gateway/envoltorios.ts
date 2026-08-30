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
): Envoltorio {
  const base = `http://127.0.0.1:${puerto}`;
  switch (comando) {
    case "claude":
      return { bin: "claude", args: resto, env: { ANTHROPIC_BASE_URL: base } };
    case "goose":
      return { bin: "goose", args: resto, env: { ANTHROPIC_HOST: base } };
    case "qwen":
      return {
        bin: "qwen",
        args: resto,
        env: { ANTHROPIC_BASE_URL: base },
        nota: "Qwen Code solo enruta por aquí con `security.auth.selectedType: \"anthropic\"` en ~/.qwen/settings.json (ver `bvsala doctor`).",
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
            ? "Auth ChatGPT detectada: el gateway enruta a chatgpt.com/backend-api/codex. El tráfico de suscripción se mide (equivalente a precio de lista) pero no se monetiza: no hay factura por tokens."
            : "Auth por API key: el gateway enruta a api.openai.com/v1.",
      };
    }
  }
}
