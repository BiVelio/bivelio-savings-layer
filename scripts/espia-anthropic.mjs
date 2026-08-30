#!/usr/bin/env node
/**
 * F0 · EL ESPÍA DE TRÁFICO — proxy local de GRABACIÓN para catalogar la
 * superficie exacta de la API de Anthropic que usa Claude Code (u otra
 * herramienta que respete ANTHROPIC_BASE_URL).
 *
 * Qué es: un passthrough puro. Reenvía cada petición byte a byte a
 * api.anthropic.com, devuelve la respuesta en streaming sin tocarla, y
 * escribe a disco un registro por petición con TODO lo que el gateway de F1
 * necesitará soportar: método, ruta, cabeceras (credenciales REDACTADAS),
 * forma del cuerpo, tipos de evento SSE y los eventos `usage`.
 *
 * Qué NO es: no optimiza, no mide facturación, no altera nada. Cero lógica
 * entre el cliente y el proveedor — si este proxy cambia una coma, el catálogo
 * que produce miente.
 *
 * Uso:
 *   node scripts/espia-anthropic.mjs [puerto]            # por defecto 8402
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude -p "Responde solo OK"
 *
 * Entorno:
 *   BVSALA_ESPIA_UPSTREAM     upstream (por defecto https://api.anthropic.com)
 *   BVSALA_ESPIA_MAX_CUERPO   tope de cuerpo grabado por respuesta, en bytes
 *                             (por defecto 4000000; inválido → se ignora y avisa)
 *
 * Las capturas quedan en ~/.bvsala-f0/captura-<timestamp>.jsonl — SOLO en la
 * máquina local. Contienen los prompts de la sesión grabada (son tuyos y no
 * salen de aquí); las credenciales (authorization, x-api-key, cookies) se
 * redactan SIEMPRE antes de escribir.
 */
import { createServer } from "node:http";
import { mkdirSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PUERTO = Number(process.argv[2] ?? 8402);
const UPSTREAM = process.env.BVSALA_ESPIA_UPSTREAM ?? "https://api.anthropic.com";
/**
 * Tope de cuerpo grabado por respuesta (v2: parametrizable). Por encima, el
 * cuerpo NO se guarda (un cuerpo truncado no sirve para el replay del arnés)
 * pero el registro lo dice con `responseBodyOmitted` en vez de callar — en v1
 * el registro simplemente dejaba de ser replayable sin rastro.
 */
const MAX_CUERPO = (() => {
  const bruto = Number(process.env.BVSALA_ESPIA_MAX_CUERPO || 4_000_000);
  if (Number.isFinite(bruto) && bruto > 0) return bruto;
  console.error(`[espia] BVSALA_ESPIA_MAX_CUERPO inválido («${process.env.BVSALA_ESPIA_MAX_CUERPO}»); uso 4000000`);
  return 4_000_000;
})();

const DIR = join(homedir(), ".bvsala-f0");
mkdirSync(DIR, { recursive: true });
const fichero = join(DIR, `captura-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
const salida = createWriteStream(fichero, { flags: "a" });

/** Cabeceras cuyo VALOR jamás se escribe a disco. */
const SENSIBLES = new Set(["authorization", "x-api-key", "cookie", "set-cookie", "proxy-authorization"]);

function redactar(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = SENSIBLES.has(k.toLowerCase()) ? "«presente, redactado»" : v;
  }
  return out;
}

/** Describe la FORMA de un JSON sin perder lo estructural (claves, tipos, tamaños). */
function forma(valor, profundidad = 0) {
  if (valor === null) return "null";
  if (Array.isArray(valor)) {
    return { array: valor.length, ejemplo: valor.length && profundidad < 6 ? forma(valor[0], profundidad + 1) : undefined };
  }
  if (typeof valor === "object") {
    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = profundidad < 6 ? forma(v, profundidad + 1) : typeof v;
    return out;
  }
  if (typeof valor === "string") return `string(${valor.length})`;
  return typeof valor;
}

/**
 * v2 · Resumen por tipo de bloque del cuerpo de /v1/messages: cuántos bloques
 * y cuántos bytes serializados pesa cada tipo (tool_result, text, tool_use…),
 * más el peso de system y tools. Solo conteos y tamaños — el contenido ya está
 * en requestBody, esto es el índice para el análisis de S1.
 */
function resumenDeBloques(json) {
  const porTipo = {};
  const anota = (tipo, valor) => {
    const bytes = Buffer.byteLength(typeof valor === "string" ? valor : JSON.stringify(valor ?? ""));
    const t = (porTipo[tipo] ??= { n: 0, bytes: 0 });
    t.n += 1;
    t.bytes += bytes;
  };
  for (const m of json.messages) {
    if (!m || typeof m !== "object") {
      anota("?:invalido", m);
      continue;
    }
    if (typeof m.content === "string") anota(`${m.role}:text`, m.content);
    else if (Array.isArray(m.content)) for (const b of m.content) anota(`${m.role}:${b?.type ?? "?"}`, b);
  }
  if (json.system !== undefined) anota("system", json.system);
  if (Array.isArray(json.tools)) for (const t of json.tools) anota("tools", t);
  return {
    mensajes: json.messages.length,
    porTipo,
    totalBytes: Object.values(porTipo).reduce((s, t) => s + t.bytes, 0),
    context_management: json.context_management !== undefined ? forma(json.context_management) : undefined,
  };
}

let n = 0;

const server = createServer(async (req, res) => {
  const id = ++n;
  const t0 = Date.now();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const cuerpo = Buffer.concat(chunks);

  const url = new URL(req.url ?? "/", UPSTREAM);
  const registro = {
    id,
    at: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    query: url.search || undefined,
    // v2 · correlación de sesión/subagente: el puerto del socket del cliente
    // distingue procesos concurrentes (agente principal vs subagentes) que en
    // v1 se entremezclaban sin nada que los separase salvo el contenido.
    clientPort: req.socket.remotePort,
    requestHeaders: redactar(req.headers),
    requestBytes: cuerpo.length,
  };
  // El cuerpo completo va aparte (es local y es tuyo); la forma va SIEMPRE.
  let json;
  try {
    json = JSON.parse(cuerpo.toString("utf8"));
    registro.requestShape = forma(json);
    registro.requestBody = json;
    // v2 · metadata del cliente (p.ej. user_id de Claude Code) a mano para
    // correlacionar sin bucear en el cuerpo.
    if (json && typeof json === "object" && json.metadata) registro.requestMeta = json.metadata;
  } catch {
    registro.requestShape = cuerpo.length ? `raw(${cuerpo.length}B)` : "empty";
  }
  // v2 · resumen de bloques por tipo (la cifra clave de S1: ¿cuánto pesan los
  // tool_result?). En su PROPIO try: un cuerpo con messages malformados no
  // puede desdecir el requestShape ya calculado ni tocar el passthrough.
  if (Array.isArray(json?.messages)) {
    try {
      registro.bloques = resumenDeBloques(json);
    } catch {}
  }

  let upstream;
  try {
    // Passthrough: mismas cabeceras (host aparte), mismo cuerpo, sin tocar nada.
    const h = { ...req.headers };
    delete h.host;
    delete h["content-length"]; // fetch la recalcula; una desincronía rompería el upstream
    upstream = await fetch(url, {
      method: req.method,
      headers: h,
      body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : cuerpo,
      redirect: "manual",
      duplex: "half",
    });
  } catch (err) {
    registro.error = String(err);
    salida.write(JSON.stringify(registro) + "\n");
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "espia: upstream unreachable", detail: String(err) }));
    console.error(`[espia] #${id} ${req.method} ${url.pathname} → upstream inalcanzable: ${err}`);
    return;
  }

  registro.status = upstream.status;
  registro.responseHeaders = redactar(Object.fromEntries(upstream.headers.entries()));

  // Reenvía la respuesta EN STREAMING (crítico para SSE) mientras observa.
  //
  // HALLAZGO F0 nº1: el fetch de Node ya DESCOMPRIME el cuerpo (br/gzip), así
  // que reenviar el `content-encoding` original hace que el cliente intente
  // descomprimir texto plano y muera con BrotliDecompressionError (visto con
  // Claude Code real). Se quitan las cabeceras de transporte; el resto pasa
  // intacto. El gateway de F1 hereda esta misma regla.
  const headRespuesta = Object.fromEntries(upstream.headers.entries());
  delete headRespuesta["content-encoding"];
  delete headRespuesta["content-length"];
  delete headRespuesta["transfer-encoding"];
  res.writeHead(upstream.status, headRespuesta);
  const esSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  const eventos = {};
  const usos = [];
  let respuestaBytes = 0;
  let resto = "";
  let cuerpoRespuesta = [];

  if (upstream.body) {
    for await (const chunk of upstream.body) {
      respuestaBytes += chunk.length;
      res.write(chunk);
      if (esSse) {
        resto += Buffer.from(chunk).toString("utf8");
        let idx;
        while ((idx = resto.indexOf("\n\n")) >= 0) {
          const bloque = resto.slice(0, idx);
          resto = resto.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(bloque)?.[1];
          if (ev) eventos[ev] = (eventos[ev] ?? 0) + 1;
          const data = /^data: (.+)$/m.exec(bloque)?.[1];
          if (data && (ev === "message_start" || ev === "message_delta")) {
            try {
              const d = JSON.parse(data);
              const usage = d.usage ?? d.message?.usage;
              if (usage) usos.push({ evento: ev, usage });
            } catch {}
          }
        }
      }
      // El cuerpo COMPLETO (también el SSE) se guarda para el arnés de F2
      // (scripts/arnes-pasarela.mjs): sin cuerpos grabados no hay replay.
      // Solo local, con tope parametrizable (BVSALA_ESPIA_MAX_CUERPO).
      if (respuestaBytes <= MAX_CUERPO) cuerpoRespuesta.push(chunk);
    }
  }
  res.end();

  registro.ms = Date.now() - t0;
  registro.responseBytes = respuestaBytes;
  if (esSse) registro.sse = { eventos, usage: usos };
  // v2 · el cuerpo se guarda también para respuestas NO-SSE (stream:false,
  // count_tokens…): en v1 caían del corpus del arnés, que filtra por
  // responseBodyBase64, y el análisis de S1 no veía su usage.
  if (respuestaBytes <= MAX_CUERPO) {
    registro.responseBodyBase64 = Buffer.concat(cuerpoRespuesta).toString("base64");
    registro.responseStatus = upstream.status;
    if (!esSse) {
      try {
        registro.responseShape = forma(JSON.parse(Buffer.concat(cuerpoRespuesta).toString("utf8")));
      } catch {}
    }
  } else {
    registro.responseBodyOmitted = `supera BVSALA_ESPIA_MAX_CUERPO (${MAX_CUERPO} B); el registro no es replayable`;
  }
  salida.write(JSON.stringify(registro) + "\n");
  console.log(
    `[espia] #${id} ${req.method} ${url.pathname} → ${upstream.status} (${registro.ms}ms, ${respuestaBytes}B${esSse ? `, SSE: ${Object.entries(eventos).map(([k, v]) => `${k}×${v}`).join(" ")}` : ""})`,
  );
});

// Sin timeout de keep-alive: con el defecto (5 s) cada pausa humana cerraba la
// conexión y undici reconectaba con OTRO puerto efímero — el clientPort dejaba
// de correlacionar turnos de una misma conversación (hallazgo de la revisión
// de S1). Es un proxy local de grabación: mantener sockets vivos no cuesta.
server.keepAliveTimeout = 0;
server.listen(PUERTO, "127.0.0.1", () => {
  console.log(`[espia] escuchando en http://127.0.0.1:${PUERTO} → ${UPSTREAM}`);
  console.log(`[espia] captura: ${fichero}`);
  console.log(`[espia] prueba:  ANTHROPIC_BASE_URL=http://127.0.0.1:${PUERTO} claude -p "Responde solo OK"`);
});
