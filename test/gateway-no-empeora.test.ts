import { createServer, request as peticionHttp, type IncomingHttpHeaders, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { arrancarGateway, type GatewayArrancado, type OpcionesGateway } from "../gateway/servidor.js";
import { BETA_ESFUERZO } from "../gateway/esfuerzo.js";
import { configDeDiales } from "../gateway/diales.js";
import { parsearParaReescribir, reserializacionFiel } from "../gateway/reserializacion.js";
import { costeMedido, informeMedido } from "../gateway/medidor.js";
import { rebajarTtlDeCache } from "../gateway/tarifa.js";
import {
  ENTRADA_MINIMA_PARA_ESPERAR_CACHE,
  VigiaDeDegradacion,
  degradacionDeCache,
  esTraficoDeClaudeCode,
  lineaDeDegradacion,
  resumenDeDegradaciones,
  usoConFormaDeDegradacion,
  verMarcasDeCache,
} from "../gateway/degradacion.js";
import { CAMPOS_DEL_REGISTRO_DE_USO, parseUsageRecords } from "../apps/web/lib/metering/usage.js";
import { testLicense } from "./helpers/test-license.js";
import { oficialHaciaElMock } from "./helpers/gateway-oficial.js";

/**
 * LA GARANTÍA DE «NO EMPEORAR» DEL GATEWAY — la batería que citan el README y
 * docs/terminales/README.md (recomendación n.º 6 del informe de competencia del
 * 26-09-2026).
 *
 * Un proxy delante del proveedor puede subir la factura sin romper nada visible:
 * perdiendo una marca de caché, una cabecera beta, un bloque que no conoce. Esto
 * lo demuestra contra un upstream FALSO que guarda los BYTES que recibe:
 *
 *  1. Sin palancas armadas, el cuerpo llega byte a byte y las cabeceras del
 *     cliente llegan todas (salvo las de salto de RFC 7230, `host` y
 *     `content-length`), con `tool_reference`, tool search, el TTL de 1 h,
 *     `cache_control` en cada sitio donde la API lo lee, el advisor y cualquier
 *     `anthropic-beta`. La respuesta vuelve igual. Con el cuerpo compacto de
 *     Claude Code (el que toda palanca armada reescribiría) y, al lado, un
 *     control: la misma configuración con la palanca armada SÍ lo cambia.
 *  2. Con cada palanca armada (TTL, esfuerzo por turno, modelo hermano, diales,
 *     usage en Chat Completions), lo que llega es el cuerpo del cliente MÁS el
 *     cambio que esa palanca declara, y nada más, comparado como TEXTO (el orden
 *     de las claves también es prompt). El «esperado» se escribe aquí a mano,
 *     ruta a ruta: no sale del código que se prueba. Y la palanca de TTL no
 *     acredita ahorro si la petición declara herramientas de servidor.
 *  3. Cuando reescribir cambiaría algo que la palanca no declara (números no
 *     canónicos, claves con forma de índice o repetidas, UTF-8 inválido), no se
 *     reescribe.
 *  4. Un 400 tras una reescritura se reintenta una vez con la petición intacta.
 *  5. El vigía nota el tráfico que sale peor de lo que pidió el cliente (caché
 *     ignorada, TTL acortado aguas arriba, tool search apagado por Claude Code al
 *     ver un proxy, este incluido): una línea por sesión, un contador local y
 *     ningún campo nuevo en el registro de uso.
 *
 * Ninguna petición sale de 127.0.0.1.
 */

// ── Infraestructura ───────────────────────────────────────────────────────

let recursos: (Server | GatewayArrancado)[] = [];
afterEach(async () => {
  for (const r of recursos) {
    if ("cerrar" in r) await r.cerrar();
    else await new Promise((res) => r.close(res));
  }
  recursos = [];
});

interface Recibida {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface Respuesta {
  status?: number;
  headers?: Record<string, string>;
  body: string;
}

/** Un SSE de Anthropic con el usage que se le pida (message_start + message_delta). */
function sse(usage: Record<string, unknown>, model = "claude-fable-5-1"): string {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_01", model, usage: { ...usage, output_tokens: 1 } } })}\n\n`,
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { ...usage, output_tokens: 12 } })}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
}

/** Un turno sano: lee el prefijo, escribe el delta a 1 h. */
const USO_SANO = {
  input_tokens: 40,
  cache_read_input_tokens: 18_000,
  cache_creation_input_tokens: 600,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 600 },
};

const CABECERAS_DE_RESPUESTA = {
  "content-type": "text/event-stream",
  "request-id": "req_011CZ",
  "anthropic-ratelimit-input-tokens-remaining": "1999000",
  "anthropic-organization-id": "org-opaque",
  "x-cualquier-cosa-futura": "sin tocar",
};

function arrancarUpstream(recibidas: Recibida[], responder?: (r: Recibida, n: number) => Respuesta): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r: Recibida = { path: req.url ?? "", headers: { ...req.headers }, body: Buffer.concat(chunks) };
      recibidas.push(r);
      const out = responder?.(r, recibidas.length) ?? { body: sse(USO_SANO) };
      res.writeHead(out.status ?? 200, out.headers ?? CABECERAS_DE_RESPUESTA);
      res.end(out.body);
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

/** El control plane falso: entitlements con las features pedidas e ingesta que guarda los lotes. */
function arrancarPlataforma(features: string[], lotes: unknown[][] = []): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if ((req.url ?? "").startsWith("/api/org/entitlements")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ features, refreshAfterSeconds: 300 }));
        return;
      }
      if (chunks.length > 0) lotes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[]);
      res.writeHead(202, { "content-type": "application/json" });
      res.end('{"ingested":1}');
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

async function gateway(
  upstream: number,
  opciones: { plataforma?: number; lineas?: string[] } & Partial<OpcionesGateway> = {},
): Promise<GatewayArrancado> {
  const { plataforma, lineas, ...resto } = opciones;
  const g = await arrancarGateway({
    license: testLicense(),
    puerto: 0,
    ...oficialHaciaElMock(upstream),
    ...(plataforma !== undefined
      ? { serviceAccountKey: "bvk_test", meteringUrl: `http://127.0.0.1:${plataforma}/api/metering/usage`, seatId: "seat-test" }
      : {}),
    log: (l) => lineas?.push(l),
    warn: () => {},
    avisosDeNoMedido: false,
    ...resto,
  });
  recursos.push(g);
  // El canal de entitlements se refresca al arrancar: se deja asentar.
  if (plataforma !== undefined) await new Promise((r) => setTimeout(r, 150));
  return g;
}

/** Una petición HTTP cruda (node:http): deja mandar la misma cabecera dos veces. */
function enviar(
  puerto: number,
  cuerpo: Buffer | string,
  cabeceras: Record<string, string | string[]> = {},
  ruta = "/v1/messages?beta=true",
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = peticionHttp(
      { host: "127.0.0.1", port: puerto, path: ruta, method: "POST", headers: { "content-type": "application/json", ...cabeceras } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(cuerpo);
  });
}

const json = (b: Buffer): Record<string, unknown> => JSON.parse(b.toString("utf8")) as Record<string, unknown>;
const clon = <T>(o: T): T => structuredClone(o);

// ── La petición de referencia: todo lo que un proxy podría perder ─────────

/**
 * Las betas que Claude Code manda (docs/PASARELA-F0.md, corpus 08-2026) más
 * una que aún no existe: el passthrough tiene que dejar pasar también las que
 * no conoce.
 */
const BETAS_DEL_CLIENTE =
  "oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05," +
  "claude-code-20250219,advisor-tool-2026-03-01,extended-cache-ttl-2025-04-11,una-beta-del-futuro-2027-01-01";

const CABECERAS_DEL_CLIENTE: Record<string, string> = {
  "anthropic-beta": BETAS_DEL_CLIENTE,
  "anthropic-version": "2023-06-01",
  "x-api-key": "sk-ant-test-no-real",
  "x-claude-code-session-id": "sesion-1",
  "user-agent": "claude-cli/2.1.260 (external, cli)",
  "x-app": "cli",
  "x-stainless-retry-count": "0",
  "anthropic-dangerous-direct-browser-access": "true",
};

const MARCA_1H = { type: "ephemeral", ttl: "1h" } as const;

/**
 * Un cuerpo /v1/messages con `cache_control` en CADA sitio donde la API lo lee
 * (raíz, system, tools, bloques de texto, imagen, documento, tool_use,
 * tool_result, un bloque anidado en un tool_result y otro en el `source.content`
 * de un documento), las dos formas de
 * `tool_reference` (la de la búsqueda propia de Claude Code en un tool_result y
 * la del tool search del servidor), herramientas diferidas, el advisor con su
 * resultado cifrado, y dos SEÑUELOS: una clave `cache_control` que es contenido
 * (un argumento de una herramienta y una propiedad de su esquema). Diez marcas:
 * más de las cuatro que admite la API real, a propósito — esto es un catálogo de
 * sitios, y el gateway no valida, reenvía.
 */
function peticionCompleta(model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 32_000,
    stream: true,
    cache_control: { ...MARCA_1H },
    thinking: { type: "adaptive" },
    metadata: { user_id: "opaque-user-hash" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    system: [
      { type: "text", text: "You are Claude Code.", cache_control: { ...MARCA_1H } },
      { type: "text", text: "Environment: darwin" },
    ],
    tools: [
      { name: "ToolSearch", description: "Search the deferred tools", input_schema: { type: "object", properties: { query: { type: "string" } } } },
      {
        name: "Bash",
        description: "Run a shell command",
        input_schema: {
          type: "object",
          properties: {
            command: { type: "string" },
            // SEÑUELO: un argumento que se LLAMA cache_control es contenido, no una marca.
            cache_control: { type: "object", properties: { ttl: { type: "string" } }, ttl: "1h" },
          },
        },
        cache_control: { ...MARCA_1H },
      },
      { name: "WebFetch", description: "Fetch a URL", input_schema: { type: "object", properties: { url: { type: "string" } } }, defer_loading: true },
      {
        name: "mcp__github__create_issue",
        description: "Create a GitHub issue",
        input_schema: { type: "object", properties: { title: { type: "string" } } },
        defer_loading: true,
      },
      { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      { type: "advisor_20260301", name: "advisor", model: "claude-opus-5", max_uses: 3, caching: { type: "ephemeral", ttl: "1h" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Read the page, then file an issue. Café, naïve, 漢字, 🙂." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" }, cache_control: { ...MARCA_1H } },
          { type: "document", source: { type: "text", media_type: "text/plain", data: "spec" }, cache_control: { ...MARCA_1H } },
          {
            type: "document",
            source: { type: "content", content: [{ type: "text", text: "chapter 1", cache_control: { ...MARCA_1H } }] },
            title: "notes",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig-opaque-abc" },
          { type: "server_tool_use", id: "srvtoolu_01", name: "advisor", input: {} },
          {
            type: "advisor_tool_result",
            tool_use_id: "srvtoolu_01",
            content: { type: "advisor_redacted_result", encrypted_content: "enc-opaque-xyz", stop_reason: "end_turn" },
          },
          { type: "server_tool_use", id: "srvtoolu_02", name: "tool_search_tool_regex", input: { pattern: "github" } },
          {
            type: "tool_search_tool_result",
            tool_use_id: "srvtoolu_02",
            content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: "mcp__github__create_issue" }] },
          },
          { type: "tool_use", id: "toolu_01", name: "ToolSearch", input: { query: "select:WebFetch" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "tool_reference", tool_name: "WebFetch" }], cache_control: { ...MARCA_1H } },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_02",
            name: "Bash",
            // SEÑUELO: los argumentos de una llamada son lo que el modelo escribió.
            input: { command: "echo ok", cache_control: { type: "ephemeral", ttl: "1h" } },
            cache_control: { ...MARCA_1H },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_02", content: [{ type: "text", text: "ok", cache_control: { ...MARCA_1H } }] },
          { type: "text", text: "Now summarise it.", cache_control: { ...MARCA_1H } },
        ],
      },
    ],
  };
}

/**
 * Las diez marcas de peticionCompleta, escritas a mano: el «esperado» de la
 * palanca de TTL no puede salir de la función que se prueba.
 */
const RUTAS_DE_LAS_MARCAS: (string | number)[][] = [
  [],
  ["system", 0],
  ["tools", 1],
  ["messages", 0, "content", 1],
  ["messages", 0, "content", 2],
  ["messages", 0, "content", 3, "source", "content", 0],
  ["messages", 2, "content", 0],
  ["messages", 3, "content", 0],
  ["messages", 4, "content", 0, "content", 0],
  ["messages", 4, "content", 1],
];

function en(o: unknown, ruta: (string | number)[]): Record<string, unknown> {
  let x = o as Record<string | number, unknown>;
  for (const paso of ruta) x = x[paso] as Record<string | number, unknown>;
  return x as Record<string, unknown>;
}

/** La petición tal cual, con las diez marcas (y SOLO ellas) a 5 min. */
function conMarcasA5m(o: Record<string, unknown>): Record<string, unknown> {
  const c = clon(o);
  for (const ruta of RUTAS_DE_LAS_MARCAS) (en(c, ruta).cache_control as Record<string, unknown>).ttl = "5m";
  return c;
}

/**
 * La misma petición escrita como la escribiría un cliente cualquiera: con
 * sangría, escapes \u y \/, un número `1.0`, una clave `"0"` y una extensión
 * que no conocemos. Reescribirla cambiaría cosas que ninguna palanca declara.
 */
function textoDeOtroCliente(o: Record<string, unknown>): Buffer {
  const texto = JSON.stringify(o, null, 2).replace(
    "{\n",
    '{\n  "x_client_extension": {"ratio": 1.0, "0": "index-like key", "escaped": "caf\\u00e9 \\/ ok"},\n',
  );
  return Buffer.from(texto, "utf8");
}

// ── 1 · Sin palancas armadas: byte a byte ────────────────────────────────

/** Las cuatro features de palanca: una licencia con todas. */
const TODAS = ["cache_ttl_tuning", "per_turn_effort", "sibling_model_routing", "context_elision"];

/** Las banderas locales de las palancas opt-in, todas puestas. */
const BANDERAS_LOCALES = { esfuerzo: "low", modeloHermano: true, dialesElision: true } as const;

/**
 * El cuerpo de Claude Code tal cual viaja: JSON compacto, el que TODA palanca
 * armada reescribiría. Con él, «llega byte a byte» solo puede ser verdad si las
 * palancas están de verdad desarmadas (el control positivo de abajo lo prueba).
 */
const cuerpoDeClaudeCode = (model = "claude-fable-5"): Buffer => Buffer.from(JSON.stringify(peticionCompleta(model)), "utf8");

describe("1 · sin palancas armadas, el gateway reenvía byte a byte", () => {
  /**
   * Cada caso trae su gemelo ARMADO, que solo cambia el factor que desarma. El
   * control positivo exige que el gemelo SÍ cambie el cuerpo de Claude Code:
   * así el «byte a byte» del caso desarmado demuestra algo sobre las palancas
   * y no sobre la verja de la reserialización.
   */
  const CASOS: { nombre: string; desarmado: (u: number) => Promise<GatewayArrancado>; armado: (u: number) => Promise<GatewayArrancado> }[] = [
    {
      nombre: "sin canal de licencia (solo en proceso: `bvsala` no arranca sin BIVELIO_SERVICE_KEY)",
      desarmado: (u) => gateway(u, { ...BANDERAS_LOCALES }),
      armado: async (u) => gateway(u, { plataforma: await arrancarPlataforma(TODAS), ...BANDERAS_LOCALES }),
    },
    {
      nombre: "con clave y una licencia sin features, con las banderas locales puestas",
      desarmado: async (u) => gateway(u, { plataforma: await arrancarPlataforma([]), ...BANDERAS_LOCALES }),
      armado: async (u) => gateway(u, { plataforma: await arrancarPlataforma(TODAS), ...BANDERAS_LOCALES }),
    },
    {
      nombre: "con todas las features y banderas pero BVSALA_GATEWAY_ELISION=0",
      desarmado: async (u) => gateway(u, { plataforma: await arrancarPlataforma(TODAS), ...BANDERAS_LOCALES, elision: false }),
      armado: async (u) => gateway(u, { plataforma: await arrancarPlataforma(TODAS), ...BANDERAS_LOCALES, elision: true }),
    },
  ];

  const CUERPOS: [string, () => Buffer][] = [
    ["el cuerpo de Claude Code (JSON compacto)", () => cuerpoDeClaudeCode()],
    ['el de otro cliente (sangría, escapes, un 1.0, una clave "0")', () => textoDeOtroCliente(peticionCompleta("claude-fable-5"))],
  ];

  for (const { nombre, desarmado, armado } of CASOS) {
    for (const [queCuerpo, hacerCuerpo] of CUERPOS) {
      it(`${nombre} · ${queCuerpo}: cuerpo, ruta y cabeceras llegan intactos, y la respuesta vuelve igual`, async () => {
        const recibidas: Recibida[] = [];
        const respuesta = sse(USO_SANO);
        const upstream = await arrancarUpstream(recibidas, () => ({ body: respuesta }));
        const g = await desarmado(upstream);
        const cuerpo = hacerCuerpo();

        const r = await enviar(g.puerto, cuerpo, CABECERAS_DEL_CLIENTE);

        expect(r.status).toBe(200);
        expect(recibidas).toHaveLength(1);
        const llegada = recibidas[0]!;
        // El cuerpo: los MISMOS bytes, no un JSON equivalente.
        expect(llegada.body.equals(cuerpo)).toBe(true);
        // La ruta con su query.
        expect(llegada.path).toBe("/v1/messages?beta=true");
        // Cada cabecera del cliente, con su valor exacto.
        for (const [k, v] of Object.entries(CABECERAS_DEL_CLIENTE)) expect(llegada.headers[k], k).toBe(v);
        // La respuesta: los mismos bytes y las mismas cabeceras (salvo las de transporte).
        expect(r.body.toString("utf8")).toBe(respuesta);
        for (const [k, v] of Object.entries(CABECERAS_DE_RESPUESTA)) expect(r.headers[k], k).toBe(v);
      });
    }

    it(`${nombre} · CONTROL: el gemelo armado SÍ reescribe el cuerpo de Claude Code (el test distingue)`, async () => {
      const recibidas: Recibida[] = [];
      const upstream = await arrancarUpstream(recibidas);
      const g = await armado(upstream);
      const cuerpo = cuerpoDeClaudeCode();

      await enviar(g.puerto, cuerpo, CABECERAS_DEL_CLIENTE);

      expect(recibidas[0]!.body.equals(cuerpo)).toBe(false);
      expect(json(recibidas[0]!.body).model).toBe("claude-fable-5-1");
    });
  }

  it("una anthropic-beta repetida en dos líneas llega como UNA lista con las dos, en su orden (RFC 9110 §5.3)", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas);
    const g = await gateway(upstream);
    await enviar(g.puerto, JSON.stringify(peticionCompleta("claude-fable-5-1")), {
      "anthropic-beta": ["advisor-tool-2026-03-01", "extended-cache-ttl-2025-04-11"],
    });
    expect(recibidas[0]!.headers["anthropic-beta"]).toBe("advisor-tool-2026-03-01, extended-cache-ttl-2025-04-11");
  });

  it("count_tokens y cualquier otra ruta, también byte a byte: con todo armado salvo el modelo hermano, la única palanca que toca count_tokens", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas, () => ({
      headers: { "content-type": "application/json" },
      body: '{"input_tokens":123}',
    }));
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma(TODAS), esfuerzo: "low", dialesElision: true });
    const cuerpos = [cuerpoDeClaudeCode("claude-fable-5"), textoDeOtroCliente(peticionCompleta("claude-fable-5"))];
    for (const cuerpo of cuerpos) {
      await enviar(g.puerto, cuerpo, CABECERAS_DEL_CLIENTE, "/v1/messages/count_tokens?beta=true");
      await enviar(g.puerto, cuerpo, CABECERAS_DEL_CLIENTE, "/v1/files");
    }
    expect(recibidas.map((r) => r.path)).toEqual([
      "/v1/messages/count_tokens?beta=true",
      "/v1/files",
      "/v1/messages/count_tokens?beta=true",
      "/v1/files",
    ]);
    recibidas.forEach((r, i) => expect(r.body.equals(cuerpos[Math.floor(i / 2)]!), r.path).toBe(true));
  });

  it("count_tokens · CONTROL: con la bandera del modelo hermano, count_tokens cambia `model` y nada más; /v1/files sigue intacto", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas, () => ({
      headers: { "content-type": "application/json" },
      body: '{"input_tokens":123}',
    }));
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma(TODAS), ...BANDERAS_LOCALES });
    const cuerpo = cuerpoDeClaudeCode("claude-fable-5");

    await enviar(g.puerto, cuerpo, CABECERAS_DEL_CLIENTE, "/v1/messages/count_tokens?beta=true");
    await enviar(g.puerto, cuerpo, CABECERAS_DEL_CLIENTE, "/v1/files");

    expect(recibidas[0]!.body.toString("utf8")).toBe(JSON.stringify({ ...peticionCompleta("claude-fable-5"), model: "claude-fable-5-1" }));
    expect(recibidas[1]!.body.equals(cuerpo)).toBe(true);
  });
});

// ── 2 · Con palancas armadas: solo cambia lo declarado ───────────────────

describe("2 · con cada palanca armada, solo cambia lo que esa palanca declara", () => {
  it("TTL (cache_ttl_tuning, PRO por defecto): las DIEZ marcas pasan de 1h a 5m —la de la raíz y la del documento incluidas— y nada más; ni los señuelos ni el `caching` del advisor", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas);
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma(["cache_ttl_tuning"]) });
    const original = peticionCompleta("claude-fable-5-1");

    await enviar(g.puerto, JSON.stringify(original), CABECERAS_DEL_CLIENTE);

    // Texto contra texto: también el ORDEN de las claves, que es parte del prompt.
    expect(recibidas[0]!.body.toString("utf8")).toBe(JSON.stringify(conMarcasA5m(original)));
    // Los señuelos siguen pidiendo 1h: son contenido.
    const llegada = json(recibidas[0]!.body);
    expect(en(llegada, ["messages", 3, "content", 0, "input", "cache_control"]).ttl).toBe("1h");
    expect(en(llegada, ["tools", 1, "input_schema", "properties", "cache_control"]).ttl).toBe("1h");
    expect(en(llegada, ["tools", 5, "caching"]).ttl).toBe("1h");
    // Las cabeceras, intactas: esta palanca no añade betas.
    for (const [k, v] of Object.entries(CABECERAS_DEL_CLIENTE)) expect(recibidas[0]!.headers[k], k).toBe(v);
  });

  it("TTL: el turno ENCADENADO (poco nuevo sobre un prefijo ya escrito) viaja byte a byte", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas);
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma(["cache_ttl_tuning"]) });
    // Un historial largo: el turno siguiente añade una fracción pequeña.
    const primero = peticionCompleta("claude-fable-5-1");
    (primero.messages as unknown[]).unshift(
      ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} `.repeat(400) })),
    );
    const segundo = clon(primero);
    (segundo.messages as unknown[]).push({ role: "assistant", content: "sure" }, { role: "user", content: "and one more thing" });

    await enviar(g.puerto, JSON.stringify(primero), CABECERAS_DEL_CLIENTE);
    const cuerpo2 = Buffer.from(JSON.stringify(segundo), "utf8");
    await enviar(g.puerto, cuerpo2, CABECERAS_DEL_CLIENTE);

    expect(json(recibidas[0]!.body)).not.toEqual(primero); // el arranque sí se rebaja
    expect(recibidas[1]!.body.equals(cuerpo2)).toBe(true);
  });

  it("esfuerzo por turno (per_turn_effort): un mensaje de sistema AÑADIDO al final y la beta añadida al final de la del cliente; nada más", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas);
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma(["per_turn_effort"]), esfuerzo: "low" });
    const original = peticionCompleta("claude-fable-5-1");

    await enviar(g.puerto, JSON.stringify(original), CABECERAS_DEL_CLIENTE);

    const esperado = clon(original);
    (esperado.messages as unknown[]).push({ role: "system", content: [], output_config: { effort: "low" } });
    expect(recibidas[0]!.body.toString("utf8")).toBe(JSON.stringify(esperado));
    expect(recibidas[0]!.headers["anthropic-beta"]).toBe(`${BETAS_DEL_CLIENTE},${BETA_ESFUERZO}`);
    for (const [k, v] of Object.entries(CABECERAS_DEL_CLIENTE)) {
      if (k !== "anthropic-beta") expect(recibidas[0]!.headers[k], k).toBe(v);
    }
  });

  it("⛔ esfuerzo por turno a un nivel que NO rebaja el defecto (max): la petición llega byte a byte", async () => {
    // La palanca es un techo: hasta el 2026-09-27 `max` se aplicaba y SUBÍA la
    // salida a precio de lista. Ahora no toca ni el cuerpo ni la beta.
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas);
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma(["per_turn_effort"]), esfuerzo: "max" });
    const original = JSON.stringify(peticionCompleta("claude-fable-5-1"));

    await enviar(g.puerto, original, CABECERAS_DEL_CLIENTE);

    expect(recibidas[0]!.body.toString("utf8")).toBe(original);
    for (const [k, v] of Object.entries(CABECERAS_DEL_CLIENTE)) expect(recibidas[0]!.headers[k], k).toBe(v);
  });

  it("modelo hermano (sibling_model_routing + bandera): solo `model`; cabeceras intactas", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas);
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma(["sibling_model_routing"]), modeloHermano: true });
    const original = peticionCompleta("claude-fable-5");

    await enviar(g.puerto, JSON.stringify(original), CABECERAS_DEL_CLIENTE);

    expect(recibidas[0]!.body.toString("utf8")).toBe(JSON.stringify({ ...original, model: "claude-fable-5-1" }));
    for (const [k, v] of Object.entries(CABECERAS_DEL_CLIENTE)) expect(recibidas[0]!.headers[k], k).toBe(v);
  });

  it("diales de elisión (armados a mano): solo `context_management`, con el edit del cliente conservado delante", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas);
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma(["context_elision"]), dialesElision: true });
    const original = peticionCompleta("claude-fable-5-1");

    await enviar(g.puerto, JSON.stringify(original), CABECERAS_DEL_CLIENTE);

    const esperado = clon(original);
    esperado.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }, configDeDiales().edits[0]] };
    expect(recibidas[0]!.body.toString("utf8")).toBe(JSON.stringify(esperado));
    // La beta de context management ya venía del cliente: la cabecera no cambia.
    for (const [k, v] of Object.entries(CABECERAS_DEL_CLIENTE)) expect(recibidas[0]!.headers[k], k).toBe(v);
  });

  it("tres a la vez (TTL, que PRO trae, más esfuerzo y hermano, que son opt-in): la suma exacta de lo que declara cada una", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas);
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma(TODAS), esfuerzo: "medium", modeloHermano: true });
    const original = peticionCompleta("claude-fable-5");

    await enviar(g.puerto, JSON.stringify(original), CABECERAS_DEL_CLIENTE);

    const esperado = conMarcasA5m({ ...original, model: "claude-fable-5-1" });
    (esperado.messages as unknown[]).push({ role: "system", content: [], output_config: { effort: "medium" } });
    expect(recibidas[0]!.body.toString("utf8")).toBe(JSON.stringify(esperado));
    expect(recibidas[0]!.headers["anthropic-beta"]).toBe(`${BETAS_DEL_CLIENTE},${BETA_ESFUERZO}`);
  });

  it("usage en streams de Chat Completions (BVSALA_GATEWAY_USAGE_INJECT=1): `\"stream_options\":{\"include_usage\":true},` insertado tras la `{` y el resto, byte a byte", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas, () => ({
      headers: { "content-type": "text/event-stream" },
      body: 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
    }));
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma([]), usageInject: true });
    // Escrito a mano, con un 1.0 y sangría: la inserción es textual y no reserializa nada.
    const cuerpo = '{\n  "model": "gpt-5.1",\n  "stream": true,\n  "temperature": 1.0,\n  "messages": [{"role": "user", "content": "caf\\u00e9"}]\n}';

    await enviar(g.puerto, cuerpo, { authorization: "Bearer sk-test-no-real" }, "/v1/chat/completions");

    expect(recibidas[0]!.body.toString("utf8")).toBe(`{"stream_options":{"include_usage":true},${cuerpo.slice(1)}`);
    expect(recibidas[0]!.headers.authorization).toBe("Bearer sk-test-no-real");
  });

  it("⛔ si reescribir cambiaría algo no declarado (un `1.0`, una clave \"0\"), ninguna palanca toca el cuerpo: byte a byte", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas);
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma(TODAS), esfuerzo: "low", modeloHermano: true, dialesElision: true });
    const cuerpo = textoDeOtroCliente(peticionCompleta("claude-fable-5"));

    await enviar(g.puerto, cuerpo, CABECERAS_DEL_CLIENTE);

    expect(recibidas[0]!.body.equals(cuerpo)).toBe(true);
    for (const [k, v] of Object.entries(CABECERAS_DEL_CLIENTE)) expect(recibidas[0]!.headers[k], k).toBe(v);
  });

  it("⛔ un 400 del proveedor tras la rebaja de TTL se reintenta UNA vez con la petición del cliente, intacta", async () => {
    const recibidas: Recibida[] = [];
    // Rechaza cualquier cuerpo con un ttl de 5m: la forma de un 400 que causa la reescritura.
    const upstream = await arrancarUpstream(recibidas, (r) =>
      r.body.includes('"ttl":"5m"')
        ? { status: 400, headers: { "content-type": "application/json" }, body: '{"type":"error","error":{"type":"invalid_request_error","message":"ttl"}}' }
        : { body: sse(USO_SANO) },
    );
    const lineas: string[] = [];
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma(["cache_ttl_tuning"]), lineas });
    const cuerpo = Buffer.from(JSON.stringify(peticionCompleta("claude-fable-5-1")), "utf8");

    const r = await enviar(g.puerto, cuerpo, CABECERAS_DEL_CLIENTE);

    expect(r.status).toBe(200);
    expect(recibidas).toHaveLength(2);
    expect(recibidas[1]!.body.equals(cuerpo)).toBe(true);
    expect(lineas.some((l) => l.includes("(cache TTL); forwarding it unchanged"))).toBe(true);
  });

  // ── El dinero de la palanca de TTL con herramientas de servidor ─────────
  // «This automatic breakpoint always uses the default 5-minute TTL,
  // independent of any TTL you set on your own cache_control markers» —
  // https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching#server-tool-results-are-cached-automatically
  // (consultada el 2026-09-27). Con una herramienta de servidor, parte de lo
  // escrito a 5 min puede ser de la API y no de la palanca: no se acredita.

  /** Solo la marca de la raíz y una búsqueda web: una forma que la palanca no tocaba antes de acreditar la raíz. */
  const conBusquedaWeb = (): Record<string, unknown> => ({
    model: "claude-fable-5-1",
    max_tokens: 1024,
    stream: true,
    cache_control: { type: "ephemeral", ttl: "1h" },
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: "search the news" }],
  });

  it("💶 TTL + herramienta de servidor: la palanca se aplica (el cliente paga 1,25× y no 2×), pero el registro no acredita ni un céntimo", async () => {
    const recibidas: Recibida[] = [];
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstream(recibidas, () => ({ body: sse(USO_TTL_A_5M) }));
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma(["cache_ttl_tuning"], lotes) });
    const original = conBusquedaWeb();

    await enviar(g.puerto, JSON.stringify(original), { "x-claude-code-session-id": "s-servidor" });

    expect(recibidas[0]!.body.toString("utf8")).toBe(JSON.stringify({ ...original, cache_control: { type: "ephemeral", ttl: "5m" } }));
    await g.cerrar();
    const registros = lotes.flat() as Record<string, unknown>[];
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({ basis: "measured", netSavings: 0 });
    expect(registros[0]!.baselineCost).toBe(registros[0]!.actualCost);
    expect(() => parseUsageRecords(registros, "org-test")).not.toThrow();
  });

  it("💶 CONTROL: la misma petición sin la herramienta de servidor sí acredita la diferencia de tarifa", async () => {
    const recibidas: Recibida[] = [];
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstream(recibidas, () => ({ body: sse(USO_TTL_A_5M) }));
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma(["cache_ttl_tuning"], lotes) });
    const { tools: _sinHerramientas, ...original } = conBusquedaWeb();

    await enviar(g.puerto, JSON.stringify(original), { "x-claude-code-session-id": "s-cliente" });

    expect(recibidas[0]!.body.toString("utf8")).toBe(JSON.stringify({ ...original, cache_control: { type: "ephemeral", ttl: "5m" } }));
    await g.cerrar();
    const registros = lotes.flat() as Record<string, unknown>[];
    expect(registros).toHaveLength(1);
    expect(registros[0]!.basis).toBe("measured");
    expect(registros[0]!.netSavings as number).toBeGreaterThan(0);
    expect(registros[0]!.baselineCost as number).toBeGreaterThan(registros[0]!.actualCost as number);
  });

  it("💶 las piezas puras: rebajarTtlDeCache avisa de la herramienta de servidor e informeMedido no la acredita", () => {
    const r = rebajarTtlDeCache(conBusquedaWeb());
    expect(r).toMatchObject({ rebajadas: 1, yaEran5m: 0, herramientaDeServidor: true });
    // Un MCP por el conector también corre en el servidor; bash o el editor, no.
    expect(rebajarTtlDeCache({ ...conBusquedaWeb(), tools: [], mcp_servers: [{ type: "url", url: "https://x", name: "x" }] })?.herramientaDeServidor).toBe(true);
    expect(rebajarTtlDeCache({ ...conBusquedaWeb(), tools: [{ type: "bash_20250124", name: "bash" }] })?.herramientaDeServidor).toBe(false);

    const medido = costeMedido("claude-fable-5-1", USO_TTL_A_5M)!;
    type Coste = { cost: { baselineEstimate: number; actual: number; netSavings: number } };
    const con = informeMedido("r1", "claude-fable-5-1", medido, undefined, null, { rebajadas: 1, yaEran5m: 0, herramientaDeServidor: true }) as unknown as Coste;
    expect(con.cost.netSavings).toBe(0);
    expect(con.cost.baselineEstimate).toBe(con.cost.actual);
    const sin = informeMedido("r2", "claude-fable-5-1", medido, undefined, null, { rebajadas: 1, yaEran5m: 0, herramientaDeServidor: false }) as unknown as Coste;
    expect(sin.cost.netSavings).toBeGreaterThan(0);
  });
});

// ── 3 · La verja de la reserialización fiel ──────────────────────────────

describe("3 · reescribir solo cuando JSON.stringify devuelve lo mismo que el proveedor leería", () => {
  it("un JSON normal (el de cualquier SDK) es fiel", () => {
    expect(reserializacionFiel(JSON.stringify(peticionCompleta("m")))).toBe(true);
    expect(reserializacionFiel('{"a": [1, -2, 0.5, 1.5e-7, 1e+21], "b": "1.0", "c": {"x10": true}}')).toBe(true);
  });

  it("números que JavaScript reescribiría: 1.0, 1e5, 1E5, -0, 2^64", () => {
    for (const n of ["1.0", "1e5", "1E5", "-0", "18446744073709551616", "0.10"]) {
      expect(reserializacionFiel(`{"a":${n}}`), n).toBe(false);
    }
  });

  it("claves con forma de índice (JavaScript las ordena delante), también escapadas", () => {
    expect(reserializacionFiel('{"b":1,"0":2}')).toBe(false);
    expect(reserializacionFiel('{"b":1,"\\u0031":2}')).toBe(false);
    expect(reserializacionFiel('{"b":1,"01":2,"-1":3,"4294967295":4}')).toBe(true);
    // Una cadena "0" que NO es clave no importa.
    expect(reserializacionFiel('{"b":["0","1"]}')).toBe(true);
  });

  it("claves duplicadas en un mismo objeto (reescribir borraría una; RFC 8259 §4), también escapadas; la misma clave en objetos distintos, sí", () => {
    expect(reserializacionFiel('{"a":1,"a":2}')).toBe(false);
    expect(reserializacionFiel('{"a":1,"\\u0061":2}')).toBe(false);
    expect(reserializacionFiel('{"x":{"a":1,"b":{"a":2}},"a":[{"a":1},{"a":2}],"s":"{\\"a\\":1,\\"a\\":2}"}')).toBe(true);
    expect(parsearParaReescribir(Buffer.from('{"model":"m","messages":[],"model":"n"}'))).toBeNull();
  });

  it("UTF-8 inválido, una BOM o un cuerpo comprimido: no se reescribe", () => {
    expect(parsearParaReescribir(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))).toBeNull();
    expect(parsearParaReescribir(Buffer.from('﻿{"a":1}', "utf8"))).toBeNull();
    expect(parsearParaReescribir(Buffer.from('{"a":1}'), "gzip")).toBeNull();
    expect(parsearParaReescribir(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
  });
});

// ── 4 · El vigía del tráfico degradado ───────────────────────────────────

/** Una petición sin herramientas de servidor, con marcas en system y en el último mensaje. */
function peticionSimple(ttl: "1h" | "5m" | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const marca = ttl === undefined ? { type: "ephemeral" } : { type: "ephemeral", ttl };
  return {
    model: "claude-fable-5-1",
    max_tokens: 1024,
    stream: true,
    system: [{ type: "text", text: "system", cache_control: { ...marca } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { ...marca } }] }],
    ...extra,
  };
}

const USO_SIN_CACHE = { input_tokens: 20_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const USO_TTL_A_5M = {
  input_tokens: 30,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 9_000,
  cache_creation: { ephemeral_5m_input_tokens: 9_000, ephemeral_1h_input_tokens: 0 },
};

describe("4 · el vigía: firmas puras", () => {
  it("verMarcasDeCache cuenta solo las marcas reales, sabe si hay una en la cola y ve las herramientas de servidor", () => {
    const v = verMarcasDeCache(peticionCompleta("m"));
    expect(v).toEqual({ marcas: 10, de1h: 10, deOtroTtl: 0, enLaCola: true, herramientaDeServidor: true });
    const soloSystem = peticionSimple("1h");
    delete (en(soloSystem, ["messages", 0, "content", 0]) as { cache_control?: unknown }).cache_control;
    expect(verMarcasDeCache(soloSystem)).toMatchObject({ marcas: 1, enLaCola: false, herramientaDeServidor: false });
    // Las herramientas del cliente con tipo (bash, editor…) no cuentan como de servidor.
    expect(verMarcasDeCache(peticionSimple("1h", { tools: [{ type: "bash_20250124", name: "bash" }] })).herramientaDeServidor).toBe(false);
    expect(verMarcasDeCache(peticionSimple("1h", { tools: [{ type: "web_search_20260209", name: "web_search" }] })).herramientaDeServidor).toBe(true);
  });

  it("cacheIgnorada: marca en la cola, entrada por encima del mayor mínimo cacheable y ni lectura ni escritura", () => {
    const vista = verMarcasDeCache(peticionSimple("5m"));
    expect(degradacionDeCache({ vista, uso: USO_SIN_CACHE, ttlReescritoPorLaCapa: false })).toBe("cacheIgnorada");
    // Por debajo del mínimo, no cachear es lo esperado.
    const pequena = { ...USO_SIN_CACHE, input_tokens: ENTRADA_MINIMA_PARA_ESPERAR_CACHE - 1 };
    expect(degradacionDeCache({ vista, uso: pequena, ttlReescritoPorLaCapa: false })).toBeNull();
    // Sin marcas no se pidió caché.
    const sinMarcas = verMarcasDeCache({ model: "m", messages: [{ role: "user", content: "hola" }] });
    expect(degradacionDeCache({ vista: sinMarcas, uso: USO_SIN_CACHE, ttlReescritoPorLaCapa: false })).toBeNull();
    // Un turno sano no dice nada.
    expect(degradacionDeCache({ vista, uso: USO_SANO, ttlReescritoPorLaCapa: false })).toBeNull();
  });

  it("ttlAcortado: todo pedía 1h, nadie de aquí lo tocó y se escribió solo a 5m; con la palanca o con herramientas de servidor, no", () => {
    const vista = verMarcasDeCache(peticionSimple("1h"));
    expect(degradacionDeCache({ vista, uso: USO_TTL_A_5M, ttlReescritoPorLaCapa: false })).toBe("ttlAcortado");
    expect(degradacionDeCache({ vista, uso: USO_TTL_A_5M, ttlReescritoPorLaCapa: true })).toBeNull();
    const mixta = verMarcasDeCache(peticionSimple("1h", { cache_control: { type: "ephemeral" } }));
    expect(degradacionDeCache({ vista: mixta, uso: USO_TTL_A_5M, ttlReescritoPorLaCapa: false })).toBeNull();
    const conServidor = verMarcasDeCache(peticionSimple("1h", { tools: [{ type: "web_search_20260209", name: "web_search" }] }));
    expect(degradacionDeCache({ vista: conServidor, uso: USO_TTL_A_5M, ttlReescritoPorLaCapa: false })).toBeNull();
  });

  it("esTraficoDeClaudeCode: por su id de sesión o su user-agent, y nada más", () => {
    expect(esTraficoDeClaudeCode({ "x-claude-code-session-id": "s1" })).toBe(true);
    expect(esTraficoDeClaudeCode({ "user-agent": "claude-cli/2.1.260 (external, cli)" })).toBe(true);
    expect(esTraficoDeClaudeCode({ "user-agent": "python-httpx/0.28.1" })).toBe(false);
    expect(esTraficoDeClaudeCode({ "x-claude-code-session-id": "" })).toBe(false);
    expect(esTraficoDeClaudeCode({})).toBe(false);
  });

  it("el filtro barato por usage deja fuera el turno sano sin parsear nada", () => {
    expect(usoConFormaDeDegradacion(USO_SANO)).toBe(false);
    expect(usoConFormaDeDegradacion(USO_SIN_CACHE)).toBe(true);
    expect(usoConFormaDeDegradacion(USO_TTL_A_5M)).toBe(true);
  });

  it("el vigía cuenta todo y dice una vez por sesión y tipo; el resumen solo existe si hubo algo", () => {
    const v = new VigiaDeDegradacion();
    expect(v.anotar("cacheIgnorada", "a")).toBe(true);
    expect(v.anotar("cacheIgnorada", "a")).toBe(false);
    expect(v.anotar("cacheIgnorada", "b")).toBe(true);
    expect(v.anotar("ttlAcortado", "a")).toBe(true);
    expect(v.contadores()).toEqual({ cacheIgnorada: 3, ttlAcortado: 1, busquedaApagada: 0 });
    expect(resumenDeDegradaciones({ cacheIgnorada: 0, ttlAcortado: 0, busquedaApagada: 0 })).toBeNull();
    expect(resumenDeDegradaciones(v.contadores())).toContain("3 request(s) with cache_control but no cache read or write");
  });

  it("las líneas están en inglés y dicen qué mirar", () => {
    for (const tipo of ["cacheIgnorada", "ttlAcortado", "busquedaApagada"] as const) {
      const l = lineaDeDegradacion(tipo, { sesion: "s1", entrada: 20_000, escrita5m: 9_000, definiciones: 142 });
      expect(l.startsWith("[gateway] degraded traffic (session s1) · ")).toBe(true);
      expect(l).not.toMatch(/[áéíóúñ¿¡]/);
      expect(l).toContain("once per session");
    }
  });
});

describe("4 · el vigía de punta a punta: una línea por sesión, un contador, y nada nuevo en el cable", () => {
  it("cacheIgnorada: tres peticiones de dos sesiones → dos líneas, contador 3, y los registros pasan la ingesta real", async () => {
    const recibidas: Recibida[] = [];
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstream(recibidas, () => ({ body: sse(USO_SIN_CACHE) }));
    const lineas: string[] = [];
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma([], lotes), lineas });
    const cuerpo = JSON.stringify(peticionSimple("5m"));

    await enviar(g.puerto, cuerpo, { "x-claude-code-session-id": "sesion-a" });
    await enviar(g.puerto, cuerpo, { "x-claude-code-session-id": "sesion-a" });
    await enviar(g.puerto, cuerpo, { "x-claude-code-session-id": "sesion-b" });

    const avisos = lineas.filter((l) => l.startsWith("[gateway] degraded traffic"));
    expect(avisos).toHaveLength(2);
    expect(avisos[0]).toContain("(session sesion-a)");
    expect(avisos[0]).toContain("20000 input tokens");
    expect(avisos[1]).toContain("(session sesion-b)");
    expect(g.degradaciones()).toEqual({ cacheIgnorada: 3, ttlAcortado: 0, busquedaApagada: 0 });

    // Lo degradado NO viaja: cada registro cabe en la lista blanca de la ingesta.
    await g.cerrar();
    const registros = lotes.flat() as Record<string, unknown>[];
    expect(registros).toHaveLength(3);
    for (const reg of registros) {
      for (const k of Object.keys(reg)) expect(CAMPOS_DEL_REGISTRO_DE_USO, k).toContain(k);
    }
    expect(() => parseUsageRecords(registros, "org-test")).not.toThrow();
  });

  it("ttlAcortado: el cliente pide 1h, el proveedor escribe a 5m y la palanca no estaba → línea; con la palanca aplicada → nada", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas, () => ({ body: sse(USO_TTL_A_5M) }));
    const lineas: string[] = [];
    const sinPalanca = await gateway(upstream, { plataforma: await arrancarPlataforma([]), lineas });
    await enviar(sinPalanca.puerto, JSON.stringify(peticionSimple("1h")), { "x-claude-code-session-id": "s1" });
    expect(sinPalanca.degradaciones().ttlAcortado).toBe(1);
    expect(lineas.filter((l) => l.includes('asked for ttl "1h"'))).toHaveLength(1);

    const lineas2: string[] = [];
    const conPalanca = await gateway(upstream, { plataforma: await arrancarPlataforma(["cache_ttl_tuning"]), lineas: lineas2 });
    await enviar(conPalanca.puerto, JSON.stringify(peticionSimple("1h")), { "x-claude-code-session-id": "s1" });
    // El arranque en frío se rebajó: los 5 minutos son nuestros y están declarados.
    expect(json(recibidas.at(-1)!.body)).toEqual(peticionSimple("5m"));
    expect(conPalanca.degradaciones().ttlAcortado).toBe(0);
    expect(lineas2.filter((l) => l.startsWith("[gateway] degraded traffic"))).toHaveLength(0);
  });

  it("busquedaApagada: Claude Code con el catálogo entero sin diferir → contada en cada petición y dicha una vez por sesión; con diferidas, o desde otro cliente, nada", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstream(recibidas);
    const lineas: string[] = [];
    const g = await gateway(upstream, { plataforma: await arrancarPlataforma([]), lineas });
    const herramienta = (i: number, diferida: boolean) => ({
      name: `mcp__srv__t${i}`,
      description: "a tool",
      input_schema: { type: "object", properties: {} },
      ...(diferida ? { defer_loading: true } : {}),
    });
    const sinBusqueda = JSON.stringify(peticionSimple("1h", { tools: Array.from({ length: 45 }, (_, i) => herramienta(i, false)) }));
    const conBusqueda = JSON.stringify(
      peticionSimple("1h", { tools: [herramienta(0, false), ...Array.from({ length: 44 }, (_, i) => herramienta(i + 1, true))] }),
    );

    await enviar(g.puerto, sinBusqueda, { "x-claude-code-session-id": "s1" });
    await enviar(g.puerto, sinBusqueda, { "x-claude-code-session-id": "s1" });
    await enviar(g.puerto, conBusqueda, { "x-claude-code-session-id": "s2" });
    // Un agente cualquiera con 45 herramientas no «tenía» tool search: no es tráfico degradado.
    await enviar(g.puerto, sinBusqueda, { "user-agent": "python-httpx/0.28.1" });

    expect(g.degradaciones().busquedaApagada).toBe(2);
    const avisos = lineas.filter((l) => l.includes("tool search is off"));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("45 full tool definitions");
    // Y el vigía no toca nada: los cuerpos viajaron tal cual.
    expect(recibidas[0]!.body.toString("utf8")).toBe(sinBusqueda);
  });
});

// ── 5 · Lo que se publica dice lo que hace esto ──────────────────────────

describe("5 · la garantía publicada cita esta batería y dice sus límites", () => {
  const leer = (ruta: string) => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), "utf8");

  it("docs/terminales/README.md (viaja en npm) explica la garantía, cita el test y enseña la línea del vigía", () => {
    const guia = leer("../docs/terminales/README.md");
    expect(guia).toContain("## What the gateway guarantees");
    expect(guia).toContain("test/gateway-no-empeora.test.ts");
    expect(guia).toContain("[gateway] degraded traffic");
    for (const cosa of ["tool_reference", "defer_loading", "cache_control", "anthropic-beta", "advisor", 'ttl: "1h"']) {
      expect(guia, cosa).toContain(cosa);
    }
    // Los límites, dichos: la reserialización, las de salto y lo que el vigía no ve.
    expect(guia).toMatch(/Limits/);
    expect(guia).toMatch(/hop-by-hop/);
    // La palanca de TTL con herramientas de servidor: no se acredita, y se dice por qué con la fuente.
    expect(guia).toContain(
      "https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching#server-tool-results-are-cached-automatically",
    );
    expect(guia).toContain("its saving is recorded as zero");
    // El tool search apagado lo causa CUALQUIER proxy, este incluido: no se le echa la culpa a otro.
    expect(guia).toContain("this gateway included");
    expect(guia).not.toContain("because of something other than the gateway");
  });

  it("el README cita la batería, dice que el repositorio es privado y no culpa a otro del tool search apagado", () => {
    const readme = leer("../README.md");
    expect(readme).toContain("test/gateway-no-empeora.test.ts");
    expect(readme).toContain("the repository is private");
    expect(readme).toContain("this one included");
    expect(readme).not.toContain("something else in the chain");
  });
});
