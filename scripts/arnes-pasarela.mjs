#!/usr/bin/env node
/**
 * F2 · EL ARNÉS DE LA PASARELA — la puerta que una palanca debe cruzar antes
 * de encenderse por defecto (plan maestro: «solo se enciende lo que el arnés
 * demuestre inocuo»).
 *
 * Qué hace: repite las sesiones GRABADAS del corpus (capturas del espía,
 * ~/.bvsala-f0/*.jsonl con cuerpo de respuesta) contra un upstream de replay
 * local, a través del gateway REAL compilado en dist/, dos veces:
 *
 *   1. con la palanca APAGADA (la referencia), y
 *   2. con la palanca ENCENDIDA (BVSALA_GATEWAY_COALESCE=1) — incluida una
 *      pasada de duplicados concurrentes por cada petición, que es el caso
 *      que la coalescencia toca.
 *
 * Veredicto: PASA solo si cada respuesta con la palanca encendida es
 * BYTE A BYTE idéntica a la de referencia, también para las gemelas. Nada de
 * juicio semántico: la palanca de coalescencia no debe cambiar ni una coma.
 *
 * Todo corre en 127.0.0.1: ni una petición sale de la máquina… salvo la
 * licencia. Desde que el gateway exige licencia al arrancar (LICENSE §2), el
 * binario necesita BIVELIO_SERVICE_KEY de una org con licencia y red a
 * savings.bivelio.com, o BIVELIO_LICENSE_KEY si no hay red. OJO: con la clave
 * exportada, el tráfico del arnés se mide en producción (ya pasaba).
 *
 * Uso:
 *   npm run build                       # el arnés prueba el gateway de dist/
 *   node scripts/arnes-pasarela.mjs [captura.jsonl]   # por defecto, la última
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// El arnés prueba EL BINARIO REAL de dist/ — el mismo artefacto que recibe el
// cliente — lanzándolo como proceso, no importando módulos.
const BIN = fileURLToPath(new URL("../dist/gateway/bin.js", import.meta.url));
if (!existsSync(BIN)) {
  console.error("[arnes] falta dist/gateway/bin.js — ejecuta `npm run build` primero.");
  process.exit(2);
}

/** Arranca `bvsala gateway` y devuelve {puerto, parar}. */
function arrancarBinario(entorno) {
  return new Promise((resolve, reject) => {
    const hijo = spawn(process.execPath, [BIN, "gateway", "--port", "0"], {
      env: { ...process.env, ...entorno },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let salida = "";
    let listo = false;
    const t = setTimeout(() => reject(new Error(`el gateway no arrancó:\n${salida}`)), 15000);
    hijo.stdout.on("data", (d) => {
      salida += String(d);
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(salida);
      if (m && !listo) {
        listo = true;
        clearTimeout(t);
        resolve({ puerto: Number(m[1]), parar: () => new Promise((ok) => { hijo.on("exit", ok); hijo.kill("SIGTERM"); }) });
      }
    });
    // stderr también: ahí sale POR QUÉ no arrancó (la licencia, el puerto…).
    hijo.stderr.on("data", (d) => {
      salida += String(d);
    });
    hijo.on("exit", (code) => {
      if (!listo && code !== 0) {
        clearTimeout(t);
        reject(new Error(`el gateway salió con código ${code} sin arrancar:\n${salida}`));
      }
    });
    hijo.on("error", reject);
  });
}

// ── el corpus ──
const DIR = join(homedir(), ".bvsala-f0");
const fichero =
  process.argv[2] ??
  (() => {
    const todos = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).sort();
    if (!todos.length) throw new Error(`no hay capturas en ${DIR}; graba una con scripts/espia-anthropic.mjs`);
    return join(DIR, todos.at(-1));
  })();

const registros = readFileSync(fichero, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => r.method === "POST" && r.requestBody && r.responseBodyBase64);

if (!registros.length) {
  console.error(
    `[arnes] la captura ${fichero} no trae cuerpos de respuesta grabados ` +
      "(son de una versión anterior del espía). Graba una sesión nueva y reintenta.",
  );
  process.exit(2);
}
console.log(`[arnes] corpus: ${fichero} — ${registros.length} peticiones con respuesta grabada`);

// ── upstream de replay: sirve la respuesta grabada de cada petición ──
// La clave lleva la RUTA además del cuerpo: sin ella, un mismo cuerpo contra
// /v1/messages y /v1/messages/count_tokens serviría la respuesta equivocada.
const porClave = new Map(registros.map((r) => [`${r.path}\n${JSON.stringify(r.requestBody)}`, r]));
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const clave = (() => {
    try {
      const ruta = new URL(req.url ?? "/", "http://x").pathname;
      return `${ruta}\n${JSON.stringify(JSON.parse(Buffer.concat(chunks).toString("utf8")))}`;
    } catch {
      return "";
    }
  })();
  const r = porClave.get(clave);
  if (!r) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"peticion fuera del corpus"}');
    return;
  }
  // El content-type ORIGINAL de la captura: con el espía v2 el corpus trae
  // también respuestas no-SSE (stream:false, count_tokens), y servirlas
  // etiquetadas como SSE haría que el gateway recorriera la rama equivocada —
  // el arnés certificaría un camino que nunca ejercitó.
  res.writeHead(r.responseStatus ?? 200, {
    "content-type": r.responseHeaders?.["content-type"] ?? "text/event-stream",
  });
  // Troceado en fragmentos pequeños para ejercitar el ensamblado SSE real.
  const cuerpo = Buffer.from(r.responseBodyBase64, "base64");
  for (let i = 0; i < cuerpo.length; i += 512) res.write(cuerpo.subarray(i, i + 512));
  res.end();
});
await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

// ── las dos pasadas ──
async function pasada(coalescer) {
  const gw = await arrancarBinario({
    BVSALA_GATEWAY_UPSTREAM: upstreamUrl,
    ...(coalescer ? { BVSALA_GATEWAY_COALESCE: "1" } : {}),
  });
  const respuestas = [];
  for (const r of registros) {
    const cuerpo = JSON.stringify(r.requestBody);
    const pedir = () =>
      fetch(`http://127.0.0.1:${gw.puerto}${r.path}${r.query ?? ""}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: cuerpo,
      }).then(async (x) => ({ status: x.status, cuerpo: Buffer.from(await x.arrayBuffer()) }));
    if (coalescer) {
      // El caso que la palanca toca: la petición Y su gemela concurrente.
      const p1 = pedir();
      await new Promise((x) => setTimeout(x, 15));
      const p2 = pedir();
      const [a, b] = await Promise.all([p1, p2]);
      respuestas.push(a, b);
    } else {
      const a = await pedir();
      respuestas.push(a, a); // referencia duplicada: la gemela debe recibir LO MISMO
    }
  }
  await gw.parar();
  return respuestas;
}

const referencia = await pasada(false);
const conPalanca = await pasada(true);

// ── veredicto ──
let fallos = 0;
for (let i = 0; i < referencia.length; i++) {
  const a = referencia[i];
  const b = conPalanca[i];
  if (a.status !== b.status || !a.cuerpo.equals(b.cuerpo)) {
    fallos += 1;
    console.error(`[arnes] ✕ respuesta ${i}: status ${a.status}→${b.status}, bytes ${a.cuerpo.length}→${b.cuerpo.length}`);
  }
}
upstream.close();

if (fallos) {
  console.error(`[arnes] ⛔ FALLA: ${fallos}/${referencia.length} respuestas difieren con la palanca encendida.`);
  process.exit(1);
}
console.log(
  `[arnes] ✅ PASA: ${referencia.length} respuestas (originales + gemelas) byte a byte idénticas con la coalescencia encendida.`,
);
