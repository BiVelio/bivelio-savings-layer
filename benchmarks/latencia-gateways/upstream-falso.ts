/**
 * EL UPSTREAM FALSO del banco de latencia: un proveedor que responde AL
 * INSTANTE (o con el retardo que se le pida) en los dialectos que hablan los
 * gateways que se comparan. Todo lo que tarde una petición por encima de lo que
 * tarda directa contra él es del gateway.
 *
 *   POST …/chat/completions   OpenAI Chat Completions, con y sin stream (el
 *                             usage va en el último trozo si se pidió
 *                             `stream_options.include_usage`, como en OpenAI).
 *   POST /v1/messages         Anthropic Messages, con y sin stream.
 *   GET  …/models             Una lista mínima (hay gateways que la piden).
 *   GET  /banco/ultima-peticion  Los BYTES del último cuerpo de Chat Completions
 *                             o Messages que llegó (la prueba de fidelidad del
 *                             arnés los compara con lo que mandó el cliente).
 *   GET  /banco/ultimas-cabeceras  Las cabeceras de esa misma petición, en JSON
 *                             (la fidelidad de Mensajes mira `anthropic-beta` y
 *                             `anthropic-version`).
 *   POST /api/metering/usage  Una ingesta falsa de BiVelio para el modo «medido»
 *   GET  /api/org/entitlements  del gateway de BV-SALA: cuenta lo que recibe y
 *                             no concede ninguna palanca.
 *
 * El usage es determinista (≈ bytes/4 de entrada, 12 de salida; fijo en la
 * prueba de fidelidad, y en Mensajes con una escritura de caché de 1 h y una
 * llamada a herramienta) y el modelo de la respuesta es el de la petición.
 * Ninguna respuesta sale de 127.0.0.1.
 *
 * Se usa de dos maneras: importado (los tests) o como proceso propio
 * (`tsx benchmarks/latencia-gateways/upstream-falso.ts --puerto 9911`), que es
 * como lo arranca el arnés para no compartir bucle de eventos con el cliente.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  esElPrincipal,
  ENTRADA_DE_FIDELIDAD,
  MARCA_DE_FIDELIDAD,
  tokensDeEntradaFalsos,
  USO_DE_FIDELIDAD_ANTHROPIC,
} from "./nucleo.js";

export interface OpcionesUpstreamFalso {
  /** 0 = efímero. */
  puerto?: number;
  /** Retardo antes de la primera respuesta (ms). Por defecto 0. */
  retardoMs?: number;
  /** Trozos de contenido en un stream. Por defecto 8. */
  trozos?: number;
  /** Separación entre trozos (ms). Por defecto 1. */
  entreTrozosMs?: number;
}

export interface UpstreamFalso {
  puerto: number;
  cerrar(): Promise<void>;
  /** Peticiones recibidas por tipo (para comprobar que el gateway las reenvió). */
  recuento(): Readonly<Record<string, number>>;
}

const esperar = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

async function leerCuerpo(req: IncomingMessage): Promise<Buffer> {
  const trozos: Buffer[] = [];
  for await (const t of req) trozos.push(t as Buffer);
  return Buffer.concat(trozos);
}

function json(res: ServerResponse, status: number, cuerpo: unknown): void {
  const s = JSON.stringify(cuerpo);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

export function arrancarUpstreamFalso(opts: OpcionesUpstreamFalso = {}): Promise<UpstreamFalso> {
  const retardoMs = opts.retardoMs ?? 0;
  const trozos = Math.max(1, opts.trozos ?? 8);
  const entreTrozosMs = opts.entreTrozosMs ?? 1;
  const cuenta: Record<string, number> = {};
  let ultimoCuerpo: Buffer = Buffer.alloc(0);
  let ultimasCabeceras: Record<string, string | string[] | undefined> = {};
  const contar = (k: string) => (cuenta[k] = (cuenta[k] ?? 0) + 1);

  const servidor = createServer(async (req, res) => {
    const ruta = (req.url ?? "/").split("?")[0]!;
    try {
      if (req.method === "GET" && ruta.endsWith("/models")) {
        contar("models");
        return json(res, 200, {
          object: "list",
          data: ["gpt-4o-mini", "claude-haiku-4-5"].map((id) => ({ id, object: "model", created: 0, owned_by: "bench" })),
        });
      }
      if (req.method === "GET" && ruta === "/banco/ultima-peticion") {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": ultimoCuerpo.length });
        res.end(ultimoCuerpo);
        return;
      }
      if (req.method === "GET" && ruta === "/banco/ultimas-cabeceras") {
        return json(res, 200, ultimasCabeceras);
      }
      if (req.method === "GET" && ruta === "/api/org/entitlements") {
        contar("entitlements");
        return json(res, 200, { features: [], refreshAfterSeconds: 300 });
      }
      if (req.method !== "POST") return json(res, 404, { error: { message: "not found" } });

      const crudo = await leerCuerpo(req);
      if (ruta === "/api/metering/usage") {
        contar("ingesta");
        return json(res, 200, { accepted: true });
      }
      if (ruta.endsWith("/chat/completions") || ruta === "/v1/messages") {
        ultimoCuerpo = crudo;
        ultimasCabeceras = { ...req.headers };
      }
      let cuerpo: Record<string, unknown> = {};
      try {
        cuerpo = JSON.parse(crudo.toString("utf8")) as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: { message: "invalid json" } });
      }
      const modelo = typeof cuerpo.model === "string" ? cuerpo.model : "gpt-4o-mini";
      // La prueba de fidelidad lleva una marca en los mensajes (Chat
      // Completions) o en `system` (Mensajes) y recibe un usage fijo
      // (nucleo.ts → MARCA_DE_FIDELIDAD); lo demás, ≈ bytes/4.
      const deFidelidad =
        JSON.stringify(cuerpo.messages ?? "").includes(MARCA_DE_FIDELIDAD) ||
        JSON.stringify(cuerpo.system ?? "").includes(MARCA_DE_FIDELIDAD);
      const entrada = deFidelidad ? ENTRADA_DE_FIDELIDAD : tokensDeEntradaFalsos(crudo.length);
      await esperar(retardoMs);

      if (ruta.endsWith("/chat/completions")) {
        contar(cuerpo.stream === true ? "chat-stream" : "chat");
        const uso = { prompt_tokens: entrada, completion_tokens: 12, total_tokens: entrada + 12, prompt_tokens_details: { cached_tokens: 0 } };
        const base = { id: "chatcmpl-bench", created: 1_790_000_000, model: modelo, system_fingerprint: "fp_bench" };
        if (cuerpo.stream !== true) {
          return json(res, 200, {
            ...base,
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "OK ".repeat(trozos).trim() }, logprobs: null, finish_reason: "stop" }],
            usage: uso,
          });
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const trozo = (delta: Record<string, unknown>, fin: string | null) =>
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, logprobs: null, finish_reason: fin }] })}\n\n`;
        res.write(trozo({ role: "assistant", content: "" }, null));
        for (let i = 0; i < trozos; i++) {
          await esperar(entreTrozosMs);
          res.write(trozo({ content: "OK " }, null));
        }
        res.write(trozo({}, "stop"));
        const pideUso = (cuerpo.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true;
        if (pideUso) res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [], usage: uso })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }

      if (ruta === "/v1/messages" && deFidelidad) {
        // La fidelidad de Mensajes: una llamada a herramienta y una escritura de
        // caché de 1 h con su desglose, que es lo que un gateway tiene que
        // devolver intacto para que quien mide aguas abajo tarife la prima a 2×.
        contar(cuerpo.stream === true ? "messages-stream" : "messages");
        const uso = USO_DE_FIDELIDAD_ANTHROPIC;
        const herramienta = { type: "tool_use", id: "toolu_bench", name: "add", input: { a: 2, b: 3 } };
        if (cuerpo.stream !== true) {
          return json(res, 200, {
            id: "msg_bench",
            type: "message",
            role: "assistant",
            model: modelo,
            content: [herramienta],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: uso,
          });
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const ev = (tipo: string, datos: unknown) => `event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`;
        res.write(ev("message_start", { type: "message_start", message: { id: "msg_bench", type: "message", role: "assistant", model: modelo, content: [], stop_reason: null, stop_sequence: null, usage: { ...uso, output_tokens: 1 } } }));
        res.write(ev("content_block_start", { type: "content_block_start", index: 0, content_block: { ...herramienta, input: {} } }));
        res.write(ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a": 2, ' } }));
        res.write(ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"b": 3}' } }));
        res.write(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
        res.write(ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: uso.output_tokens } }));
        res.end(ev("message_stop", { type: "message_stop" }));
        return;
      }

      if (ruta === "/v1/messages") {
        contar(cuerpo.stream === true ? "messages-stream" : "messages");
        const uso = { input_tokens: entrada, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 12 };
        if (cuerpo.stream !== true) {
          return json(res, 200, {
            id: "msg_bench",
            type: "message",
            role: "assistant",
            model: modelo,
            content: [{ type: "text", text: "OK ".repeat(trozos).trim() }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: uso,
          });
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const ev = (tipo: string, datos: unknown) => `event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`;
        res.write(ev("message_start", { type: "message_start", message: { id: "msg_bench", type: "message", role: "assistant", model: modelo, content: [], stop_reason: null, usage: { ...uso, output_tokens: 1 } } }));
        res.write(ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        for (let i = 0; i < trozos; i++) {
          await esperar(entreTrozosMs);
          res.write(ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK " } }));
        }
        res.write(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
        res.write(ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } }));
        res.end(ev("message_stop", { type: "message_stop" }));
        return;
      }

      contar("otra");
      return json(res, 404, { error: { message: `no route ${ruta}` } });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: { message: String(e) } });
      else res.destroy();
    }
  });
  servidor.keepAliveTimeout = 60_000;

  return new Promise((resolver, rechazar) => {
    servidor.once("error", rechazar);
    servidor.listen(opts.puerto ?? 0, "127.0.0.1", () => {
      const dir = servidor.address();
      const puerto = typeof dir === "object" && dir ? dir.port : 0;
      resolver({
        puerto,
        recuento: () => ({ ...cuenta }),
        cerrar: () =>
          new Promise<void>((r) => {
            servidor.closeAllConnections();
            servidor.close(() => r());
          }),
      });
    });
  });
}

// ── Como proceso propio ───────────────────────────────────────────────────

function argNum(nombre: string): number | undefined {
  const i = process.argv.indexOf(nombre);
  if (i < 0) return undefined;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : undefined;
}

if (esElPrincipal(import.meta.url)) {
  const puertoPedido = argNum("--puerto");
  const retardo = argNum("--retardo-ms");
  const trozosPedidos = argNum("--trozos");
  const entre = argNum("--entre-trozos-ms");
  const u = await arrancarUpstreamFalso({
    ...(puertoPedido !== undefined ? { puerto: puertoPedido } : {}),
    ...(retardo !== undefined ? { retardoMs: retardo } : {}),
    ...(trozosPedidos !== undefined ? { trozos: trozosPedidos } : {}),
    ...(entre !== undefined ? { entreTrozosMs: entre } : {}),
  });
  // El arnés espera esta línea (o el mensaje IPC) para saber el puerto.
  if (process.send) process.send({ listo: u.puerto });
  else console.log(`LISTO ${u.puerto}`);
  process.on("message", (m) => {
    if ((m as { pide?: string }).pide === "recuento") process.send?.({ recuento: u.recuento() });
  });
  const salir = () => void u.cerrar().then(() => process.exit(0));
  process.on("SIGTERM", salir);
  process.on("SIGINT", salir);
  process.on("disconnect", salir);
}
