/**
 * `bvsala mcp` — UN SERVIDOR MCP DE SOLO LECTURA sobre los metadatos del gateway
 * LOCAL (plan Caveman 2026-10-14, D12).
 *
 * Un cliente MCP (Claude Code, Codex, un IDE) lo lanza por stdio y puede
 * preguntar, sin salir de la máquina:
 *
 *   · `gateway_status`           — el estado del gateway (`GET /_bvsala/v1/status`);
 *   · `session_costs`            — el coste por sesión de lo que el buzón guarda,
 *                                  por base de coste y sin mezclarlas;
 *   · `compaction_opportunities` — las decisiones de la compactación sin pérdida
 *                                  de tool outputs (D03), por código de motivo.
 *
 * Las reglas, y por qué:
 *
 *   · SOLO LECTURA. No hay herramienta que cambie nada: ni encender una palanca,
 *     ni proponer o lanzar un experimento. Las mutaciones esperan a que exista
 *     la API canónica que las autorice y las audite; hasta entonces, un agente
 *     no tiene por dónde tocar la configuración ni el gasto.
 *   · SOLO METADATOS. Lo que se lee son las rutas locales del gateway, que ya no
 *     llevan contenido: `status` no lleva claves, y `summary` (D12) es una suma
 *     de contadores, bases de coste, modelos y CÓDIGOS de motivo, sin un solo id
 *     de petición ni un byte de prompt, respuesta o tool output.
 *   · SOLO EL GATEWAY LOCAL. El alcance es el proyecto de ESTE gateway: la URL
 *     tiene que ser de loopback (127.0.0.1, localhost, [::1]) y por http. Nada
 *     habla con BiVelio ni con el proveedor.
 *   · SIN DEPENDENCIAS. El SDK de MCP no es una dependencia del paquete, así que
 *     el marco se hace a mano: JSON-RPC 2.0, un mensaje por línea en stdin y
 *     stdout (el transporte stdio de MCP). stdout es SOLO del protocolo; lo
 *     demás, a stderr.
 *   · EL CATÁLOGO, BAJO DEMANDA. `tools/list` pagina (dos herramientas por
 *     página, con `nextCursor`) y cada esquema de entrada es mínimo: ninguna
 *     herramienta acepta argumentos.
 */

import { ESQUEMA_RESUMEN, type ResumenLocal } from "./informes-locales.js";

/** Las versiones del protocolo MCP que este servidor habla, de la más nueva a la más vieja. */
export const VERSIONES_MCP = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
/** El puerto por defecto de `bvsala gateway`. */
export const PUERTO_POR_DEFECTO = 8402;
/** Lo más que se lee de una línea: un mensaje más largo es un error, no una espera infinita. */
export const MAX_BYTES_POR_MENSAJE = 1024 * 1024;
const TAMANO_DE_PAGINA = 2;
const TOPE_MS = 5_000;

// Códigos de error de JSON-RPC 2.0.
export const ERROR_PARSEO = -32700;
export const ERROR_PETICION = -32600;
export const ERROR_METODO = -32601;
export const ERROR_PARAMETROS = -32602;

/** Una herramienta del catálogo. Todas son de solo lectura y sin argumentos. */
interface Herramienta {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, never>; additionalProperties: false };
  annotations: { title: string; readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false };
}

const sinArgumentos = { type: "object", properties: {}, additionalProperties: false } as const;
const anotar = (title: string) =>
  ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }) as const;

export const HERRAMIENTAS: readonly Herramienta[] = [
  {
    name: "gateway_status",
    title: "Local gateway status",
    description:
      "Status of the local bvsala gateway: version, upstream origin, license state and plan, whether metering is on, and the report mailbox headers. No keys, no content.",
    inputSchema: sinArgumentos,
    annotations: anotar("Local gateway status"),
  },
  {
    name: "session_costs",
    title: "Cost per session",
    description:
      "Cost per Claude Code session of the requests this gateway's report mailbox holds (the last N, one hour at most): requests, metered or not and why, and money per cost basis (measured, reference, estimated…) kept apart, never added together. Counts and USD only: no request ids, no content.",
    inputSchema: sinArgumentos,
    annotations: anotar("Cost per session"),
  },
  {
    name: "compaction_opportunities",
    title: "Tool-output compaction opportunities",
    description:
      "What the lossless-data tool-output compaction decided on the requests in this gateway's mailbox: how many tool outputs were compacted, how many were bypassed and why (reason codes), and the ESTIMATED tokens before and after. Estimates, never a verified saving. Read-only: it proposes nothing and changes nothing.",
    inputSchema: sinArgumentos,
    annotations: anotar("Compaction opportunities"),
  },
];

/** Lo que cada código de motivo significa como oportunidad. En inglés: lo lee el agente. */
const OPORTUNIDAD_POR_MOTIVO: Readonly<Record<string, string>> = {
  applied: "already compacted: whitespace removed from strict JSON.",
  not_smaller: "already compact: removing whitespace would not save a token. Nothing to gain.",
  below_threshold: "would save fewer characters than the minimum. Nothing worth changing.",
  not_json: "not a JSON object or array. Out of scope for lossless-data.",
  invalid_json: "looks like JSON but is not strict JSON. Left as is; fixing the tool's output is the only lossless way.",
  duplicate_keys: "JSON with a repeated key: parsers keep only one value, so it cannot be compacted without changing what it says. Fix the tool.",
  invalid_unicode: "contains an unpaired surrogate. Left as is.",
  protected: "a file view or an excepted tool: kept verbatim on purpose (agents edit files by exact match).",
};

// ── El marco: JSON-RPC 2.0 ───────────────────────────────────────────────────

type Id = string | number | null;
interface Respuesta {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ok = (id: Id, result: unknown): Respuesta => ({ jsonrpc: "2.0", id, result });
const fallo = (id: Id, code: number, message: string): Respuesta => ({ jsonrpc: "2.0", id, error: { code, message } });

function esIdValido(v: unknown): v is string | number {
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
}

export interface OpcionesDeMcp {
  /** La URL BASE del gateway local, ya comprobada (ver {@link urlDelGateway}). */
  gateway: string;
  /** La versión del paquete, para `serverInfo`. */
  version: string;
  /** Inyectable para las pruebas. Por defecto, el `fetch` global. */
  fetch?: typeof fetch;
}

/**
 * La URL del gateway a partir de los argumentos de `bvsala mcp`
 * (`--gateway <url>` o `--port <n>`), o el error. Solo loopback y http.
 */
export function urlDelGateway(args: readonly string[]): { ok: true; url: string } | { ok: false; mensaje: string } {
  let url = `http://127.0.0.1:${PUERTO_POR_DEFECTO}`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const v = args[i + 1];
    if (a === "--gateway" && v !== undefined) {
      url = v;
      i++;
    } else if (a === "--port" && v !== undefined) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, mensaje: `--port needs a port number, got ${JSON.stringify(v)}` };
      url = `http://127.0.0.1:${n}`;
      i++;
    } else {
      return { ok: false, mensaje: `unknown option: ${a}\nusage: bvsala mcp [--gateway http://127.0.0.1:<port> | --port <port>]` };
    }
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, mensaje: `--gateway is not a URL: ${JSON.stringify(url)}` };
  }
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.username || u.password) {
    return {
      ok: false,
      mensaje: "bvsala mcp reads only the local gateway: --gateway must be http://127.0.0.1:<port> (or localhost), without credentials.",
    };
  }
  return { ok: true, url: u.origin };
}

/**
 * El servidor como función de UNA línea a (como mucho) UNA línea: lo que entra
 * por stdin y lo que sale por stdout, sin el transporte. Una notificación (sin
 * `id`) nunca tiene respuesta: devuelve `null`.
 */
export function crearServidorMcp(o: OpcionesDeMcp): { manejar(linea: string): Promise<string | null> } {
  const pedir = o.fetch ?? fetch;

  async function leer(ruta: string): Promise<{ ok: true; json: unknown } | { ok: false; mensaje: string }> {
    let r: Response;
    try {
      r = await pedir(`${o.gateway}${ruta}`, { method: "GET", signal: AbortSignal.timeout(TOPE_MS), headers: { accept: "application/json" } });
    } catch {
      return {
        ok: false,
        mensaje: `the local gateway at ${o.gateway} is not answering. Start it (bvsala gateway --upstream anthropic) or pass --gateway/--port.`,
      };
    }
    let json: unknown;
    try {
      json = await r.json();
    } catch {
      return { ok: false, mensaje: `the local gateway answered ${r.status} without JSON on ${ruta}` };
    }
    if (!r.ok) {
      // El mensaje de error es del propio gateway (sin contenido). Un 402 es la licencia.
      const m = (json as { error?: { message?: unknown } } | null)?.error?.message;
      return { ok: false, mensaje: `the local gateway answered ${r.status} on ${ruta}${typeof m === "string" ? `: ${m}` : ""}` };
    }
    return { ok: true, json };
  }

  const resultado = (datos: Record<string, unknown>) => ({
    content: [{ type: "text", text: JSON.stringify(datos) }],
    structuredContent: datos,
    isError: false,
  });
  const errorDeHerramienta = (mensaje: string) => ({ content: [{ type: "text", text: mensaje }], isError: true });
  const alcance = { gateway: o.gateway, readOnly: true, note: "metadata of this local gateway only: no request ids, no content" };

  async function resumen(): Promise<{ ok: true; r: ResumenLocal } | { ok: false; mensaje: string }> {
    const l = await leer("/_bvsala/v1/summary");
    if (!l.ok) return l;
    const r = l.json as ResumenLocal;
    if (r?.schema !== ESQUEMA_RESUMEN) {
      return { ok: false, mensaje: `the local gateway does not serve ${ESQUEMA_RESUMEN} (an older bvsala?): update it to use this tool.` };
    }
    return { ok: true, r };
  }

  async function llamar(nombre: string): Promise<unknown> {
    if (nombre === "gateway_status") {
      const l = await leer("/_bvsala/v1/status");
      return l.ok ? resultado({ scope: alcance, status: l.json }) : errorDeHerramienta(l.mensaje);
    }
    if (nombre === "session_costs") {
      const s = await resumen();
      if (!s.ok) return errorDeHerramienta(s.mensaje);
      return resultado({
        scope: alcance,
        window: s.r.window,
        sessions: s.r.sessions,
        note:
          "Only requests sent with the header x-bvsala-report: 1 are in the mailbox (the last N, one hour at most), so this is not your whole bill. " +
          "Money is grouped by cost basis and never added across bases: measured and estimated are different things.",
      });
    }
    // compaction_opportunities
    const s = await resumen();
    if (!s.ok) return errorDeHerramienta(s.mensaje);
    const c = s.r.toolOutputCompaction;
    const oportunidades = Object.entries(c.byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, toolOutputs]) => ({ reason, toolOutputs, meaning: OPORTUNIDAD_POR_MOTIVO[reason] ?? "unknown reason code." }));
    return resultado({
      scope: alcance,
      window: s.r.window,
      toolOutputs: c.decisions,
      applied: c.applied,
      coverage: c.decisions === 0 ? null : Math.round((c.applied / c.decisions) * 1000) / 1000,
      estimatedTokens: { before: c.appliedTokensBefore, after: c.appliedTokensAfter, basis: c.tokenBasis },
      opportunities: oportunidades,
      note:
        c.decisions === 0
          ? "No tool-output decisions in this window. lossless-data runs where the request is built by the SDK (createSavingsLayer with toolOutputCompaction: { profile: 'lossless-data' }); the gateway forwards bytes and does not compact tool outputs. Nothing here is a saving."
          : "Token counts are local estimates, never a verified saving. Experiments (turning a lever on, A/B) are not available here: they wait for the canonical API.",
    });
  }

  async function responder(m: Record<string, unknown>): Promise<Respuesta | null> {
    const tieneId = "id" in m;
    const id: Id = tieneId && esIdValido(m.id) ? m.id : null;
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string" || (tieneId && !esIdValido(m.id))) {
      // Una respuesta del cliente (result/error sin method) no se contesta.
      if (m.jsonrpc === "2.0" && typeof m.method !== "string" && ("result" in m || "error" in m)) return null;
      return fallo(id, ERROR_PETICION, "invalid JSON-RPC 2.0 request");
    }
    const params = (m.params ?? {}) as Record<string, unknown>;
    if (m.params !== undefined && (m.params === null || typeof m.params !== "object" || Array.isArray(m.params))) {
      return tieneId ? fallo(id, ERROR_PARAMETROS, "params must be an object") : null;
    }
    // Las notificaciones no llevan respuesta, ni siquiera de error.
    if (!tieneId) return null;

    switch (m.method) {
      case "initialize": {
        const pedida = params.protocolVersion;
        const version = (VERSIONES_MCP as readonly unknown[]).includes(pedida) ? (pedida as string) : VERSIONES_MCP[0];
        return ok(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "bvsala", title: "BiVelio Savings Layer (local, read-only)", version: o.version },
          instructions:
            "Read-only metadata of the local bvsala gateway: status, cost per session, and tool-output compaction decisions. No content is ever returned and nothing can be changed from here.",
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list": {
        let desde = 0;
        if (params.cursor !== undefined) {
          const c = typeof params.cursor === "string" ? /^p(\d{1,4})$/.exec(params.cursor) : null;
          desde = c ? Number(c[1]) : -1;
          if (desde <= 0 || desde >= HERRAMIENTAS.length) return fallo(id, ERROR_PARAMETROS, "invalid cursor");
        }
        const pagina = HERRAMIENTAS.slice(desde, desde + TAMANO_DE_PAGINA);
        const siguiente = desde + TAMANO_DE_PAGINA;
        return ok(id, { tools: pagina, ...(siguiente < HERRAMIENTAS.length ? { nextCursor: `p${siguiente}` } : {}) });
      }
      case "tools/call": {
        const nombre = params.name;
        if (typeof nombre !== "string" || !HERRAMIENTAS.some((h) => h.name === nombre)) {
          return fallo(id, ERROR_PARAMETROS, `unknown tool: ${typeof nombre === "string" ? nombre.slice(0, 80) : String(nombre)}`);
        }
        const args = params.arguments;
        if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length > 0)) {
          return fallo(id, ERROR_PARAMETROS, `${nombre} takes no arguments`);
        }
        return ok(id, await llamar(nombre));
      }
      default:
        return fallo(id, ERROR_METODO, `method not found: ${m.method.slice(0, 80)}`);
    }
  }

  return {
    async manejar(linea: string): Promise<string | null> {
      const texto = linea.replace(/\r$/, "");
      if (texto.trim() === "") return null;
      if (Buffer.byteLength(texto, "utf8") > MAX_BYTES_POR_MENSAJE) {
        return JSON.stringify(fallo(null, ERROR_PETICION, `message larger than ${MAX_BYTES_POR_MENSAJE} bytes`));
      }
      let m: unknown;
      try {
        m = JSON.parse(texto);
      } catch {
        return JSON.stringify(fallo(null, ERROR_PARSEO, "parse error"));
      }
      if (Array.isArray(m)) return JSON.stringify(fallo(null, ERROR_PETICION, "batches are not supported"));
      if (m === null || typeof m !== "object") return JSON.stringify(fallo(null, ERROR_PETICION, "invalid JSON-RPC 2.0 request"));
      const r = await responder(m as Record<string, unknown>);
      return r === null ? null : JSON.stringify(r);
    },
  };
}

/**
 * El transporte stdio: una línea de `entrada`, una respuesta en `salida`, en
 * orden. Termina cuando se cierra la entrada. Una línea más larga que el tope
 * se descarta entera y se contesta con un error.
 */
export function servirPorStdio(
  entrada: NodeJS.ReadableStream,
  salida: NodeJS.WritableStream,
  o: OpcionesDeMcp,
): Promise<void> {
  const servidor = crearServidorMcp(o);
  let resto = "";
  let descartando = false;
  // En orden: cada respuesta espera a la anterior, aunque una herramienta tarde.
  let cola: Promise<void> = Promise.resolve();
  const encolar = (linea: string) => {
    cola = cola.then(async () => {
      const r = await servidor.manejar(linea);
      if (r !== null) salida.write(`${r}\n`);
    });
  };
  return new Promise((resolve) => {
    entrada.setEncoding?.("utf8");
    entrada.on("data", (trozo: string | Buffer) => {
      resto += typeof trozo === "string" ? trozo : trozo.toString("utf8");
      let i: number;
      while ((i = resto.indexOf("\n")) >= 0) {
        const linea = resto.slice(0, i);
        resto = resto.slice(i + 1);
        if (descartando) {
          descartando = false;
          continue;
        }
        encolar(linea);
      }
      if (resto.length > MAX_BYTES_POR_MENSAJE) {
        resto = "";
        if (!descartando) {
          descartando = true;
          encolar("x".repeat(MAX_BYTES_POR_MENSAJE + 1));
        }
      }
    });
    entrada.on("end", () => {
      if (resto !== "" && !descartando) encolar(resto);
      void cola.then(() => resolve());
    });
  });
}
