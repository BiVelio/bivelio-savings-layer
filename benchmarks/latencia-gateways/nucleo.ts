/**
 * LATENCIA DE GATEWAYS · NÚCLEO PURO — cuánto añade un proxy local entre la app
 * y el proveedor, medido desde fuera contra un upstream FALSO que responde al
 * instante. Todo lo de este fichero es puro y determinista; los procesos, los
 * sockets y el reloj viven en arnes.ts.
 *
 * El diseño de la comparación, y por qué es así:
 *
 * - La unidad es la RONDA: una petición directa al upstream falso y la misma
 *   petición a través de CADA gateway, en orden aleatorio (con semilla). Así la
 *   deriva de la máquina (térmica, otro proceso, el GC) cae igual en todos los
 *   brazos, la diferencia de la ronda es el sobrecoste de cada gateway, y dos
 *   gateways se comparan en las mismas condiciones.
 * - El estimador es la MEDIANA de las diferencias pareadas, con IC del 95 % por
 *   bootstrap de percentiles. La media no: una sola pausa de GC de 40 ms en un
 *   brazo la mueve más que todo el efecto que se mide. La cola se publica aparte
 *   (p99 de cada brazo) y sin IC, porque con cientos de rondas el p99 son unas
 *   pocas muestras y un intervalo sobre él aparentaría una precisión que no hay.
 * - Se mide desde FUERA del gateway. LiteLLM publica su sobrecoste con una
 *   cabecera que calcula él mismo (`x-litellm-overhead-duration-ms`); Bifrost,
 *   con peticiones simuladas dentro de su propio banco. Aquí nadie se mide a sí
 *   mismo: el reloj es el del cliente y el upstream es el mismo para todos.
 *
 * Doctrina: DESCRIPTIVO. Esto mide latencia en una máquina concreta; no es
 * ahorro, no se suma a ningún libro y no se publica como cifra de producto sin
 * la máquina, las versiones y la fecha al lado.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { mulberry32 } from "../stats.js";

/**
 * ¿Es este módulo el que se lanzó? Por RUTA REAL: en macOS el tmpdir es
 * /var/folders y el cargador ESM resuelve el enlace a /private/var/folders, así
 * que comparar `import.meta.url` con `argv[1]` tal cual dice que no y el proceso
 * sale sin arrancar nada.
 */
export function esElPrincipal(urlDelModulo: string): boolean {
  const lanzado = process.argv[1];
  if (!lanzado) return false;
  try {
    return realpathSync(fileURLToPath(urlDelModulo)) === realpathSync(lanzado);
  } catch {
    return false;
  }
}

/** Un brazo de la ronda. */
export type Brazo = "directo" | "gateway";

/** Tiempos de una petición, en milisegundos desde que se empezó a escribir. */
export interface Tiempos {
  /** Primer byte del cuerpo de la respuesta (en stream, el primer trozo SSE). */
  primerByteMs: number;
  /** Respuesta completa leída. */
  totalMs: number;
}

/** Una ronda: los dos brazos de la misma petición. */
export interface Ronda {
  directo: Tiempos;
  gateway: Tiempos;
  /** Qué brazo salió primero en esta ronda. */
  primero: Brazo;
}

export interface Percentiles {
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

/**
 * Percentil por interpolación lineal entre rangos (el tipo 7 de Hyndman y Fan,
 * el de R y NumPy por defecto). `ordenados` tiene que venir ordenado.
 */
export function percentil(ordenados: readonly number[], p: number): number {
  const n = ordenados.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return ordenados[0]!;
  const q = Math.min(1, Math.max(0, p));
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return ordenados[lo]! + (h - lo) * (ordenados[hi]! - ordenados[lo]!);
}

export function percentiles(xs: readonly number[]): Percentiles {
  const o = [...xs].sort((a, b) => a - b);
  return {
    n: o.length,
    p50: percentil(o, 0.5),
    p90: percentil(o, 0.9),
    p99: percentil(o, 0.99),
    max: o.length ? o[o.length - 1]! : Number.NaN,
  };
}

export interface IC {
  punto: number;
  inferior: number;
  superior: number;
}

/**
 * IC por bootstrap de percentiles para la MEDIANA de una muestra (aquí, las
 * diferencias pareadas gateway − directo). Con semilla: el mismo fichero de
 * rondas da siempre el mismo intervalo.
 */
export function icMediana(xs: readonly number[], opts: { remuestras?: number; alfa?: number; semilla?: number } = {}): IC {
  const n = xs.length;
  const punto = percentil([...xs].sort((a, b) => a - b), 0.5);
  if (n < 2) return { punto, inferior: punto, superior: punto };
  const remuestras = opts.remuestras ?? 4000;
  const alfa = opts.alfa ?? 0.05;
  const rng = mulberry32(opts.semilla ?? 0x5eed_1a7);
  const medianas = new Array<number>(remuestras);
  const buf = new Array<number>(n);
  for (let r = 0; r < remuestras; r++) {
    for (let i = 0; i < n; i++) buf[i] = xs[(rng() * n) | 0]!;
    buf.sort((a, b) => a - b);
    medianas[r] = percentil(buf, 0.5);
  }
  medianas.sort((a, b) => a - b);
  return { punto, inferior: percentil(medianas, alfa / 2), superior: percentil(medianas, 1 - alfa / 2) };
}

/**
 * El orden de cada ronda cuando se miden VARIOS gateways a la vez: una
 * permutación aleatoria (Fisher-Yates con semilla) de los índices de los brazos,
 * con el 0 = directo. Así todos los gateways de un escenario viven la misma
 * carga de la máquina, ronda a ronda, y la comparación ENTRE gateways no depende
 * de a quién le tocó el rato malo — en una máquina compartida es la diferencia
 * entre medir el gateway y medir a los vecinos.
 */
export function ordenesMultibrazo(rondas: number, brazos: number, semilla = 0x0bde_13): number[][] {
  const rng = mulberry32(semilla);
  const out: number[][] = [];
  for (let r = 0; r < rondas; r++) {
    const o = Array.from({ length: brazos }, (_, i) => i);
    for (let i = o.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [o[i], o[j]] = [o[j]!, o[i]!];
    }
    out.push(o);
  }
  return out;
}

export interface ResumenDeEscenario {
  directo: { primerByte: Percentiles; total: Percentiles };
  gateway: { primerByte: Percentiles; total: Percentiles };
  /** Mediana de (gateway − directo) por ronda, con IC 95 %. */
  sobrecoste: { primerByteMs: IC; totalMs: IC };
  /** Diferencia de p99 (gateway − directo), sin IC: ver la cabecera. */
  sobrecosteP99Ms: { primerByte: number; total: number };
  /** Rondas en que salió primero cada brazo (el orden tiene que estar equilibrado). */
  orden: { directoPrimero: number; gatewayPrimero: number };
}

export function resumir(rondas: readonly Ronda[], semilla?: number): ResumenDeEscenario {
  const d1 = rondas.map((r) => r.directo.primerByteMs);
  const dT = rondas.map((r) => r.directo.totalMs);
  const g1 = rondas.map((r) => r.gateway.primerByteMs);
  const gT = rondas.map((r) => r.gateway.totalMs);
  const dif1 = rondas.map((r) => r.gateway.primerByteMs - r.directo.primerByteMs);
  const difT = rondas.map((r) => r.gateway.totalMs - r.directo.totalMs);
  const pd1 = percentiles(d1);
  const pdT = percentiles(dT);
  const pg1 = percentiles(g1);
  const pgT = percentiles(gT);
  return {
    directo: { primerByte: pd1, total: pdT },
    gateway: { primerByte: pg1, total: pgT },
    sobrecoste: {
      primerByteMs: icMediana(dif1, semilla !== undefined ? { semilla } : {}),
      totalMs: icMediana(difT, semilla !== undefined ? { semilla: semilla + 1 } : {}),
    },
    sobrecosteP99Ms: { primerByte: pg1.p99 - pd1.p99, total: pgT.p99 - pdT.p99 },
    orden: {
      directoPrimero: rondas.filter((r) => r.primero === "directo").length,
      gatewayPrimero: rondas.filter((r) => r.primero === "gateway").length,
    },
  };
}

// ── La petición ────────────────────────────────────────────────────────────

/**
 * Un cuerpo de Chat Completions de ~`bytes` bytes, determinista. El relleno es
 * texto de código plausible (no una sola letra repetida): un gateway que
 * comprima, trocee o tokenice ve lo que vería con un prompt real, y dos
 * ejecuciones mandan exactamente los mismos bytes.
 */
export function cuerpoDeChat(opts: { bytes: number; modelo: string; stream: boolean }): string {
  const linea = (i: number) =>
    `export function paso${i}(entrada: number[]): number { return entrada.reduce((a, b) => a + b * ${i % 97}, ${i}); }\n`;
  const base = {
    model: opts.modelo,
    messages: [
      { role: "system", content: "" },
      { role: "user", content: "Summarize what these functions have in common, in one sentence." },
    ],
    max_tokens: 64,
    temperature: 0,
    ...(opts.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
  const vacio = JSON.stringify(base).length;
  let relleno = "";
  for (let i = 0; relleno.length + vacio < opts.bytes; i++) relleno += linea(i);
  // Cada «\n» ocupa dos bytes en el JSON: se recorta hasta que el cuerpo
  // serializado mida exactamente lo pedido (o menos, y se rellena con espacios).
  let contenido = relleno.slice(0, Math.max(0, opts.bytes - vacio));
  for (;;) {
    base.messages[0]!.content = contenido;
    const sobra = JSON.stringify(base).length - opts.bytes;
    if (sobra <= 0) {
      base.messages[0]!.content = contenido + " ".repeat(-sobra);
      return JSON.stringify(base);
    }
    contenido = contenido.slice(0, contenido.length - Math.max(1, Math.floor(sobra / 2)));
  }
}

/** Los tokens de entrada que el upstream falso declara para un cuerpo: ≈ bytes/4. */
export function tokensDeEntradaFalsos(bytesDelCuerpo: number): number {
  return Math.max(1, Math.round(bytesDelCuerpo / 4));
}

// ── La fidelidad: ¿llega lo que el cliente mandó? ─────────────────────────

/**
 * Un cuerpo con los campos de Chat Completions que CAMBIAN LA FACTURA o el
 * comportamiento del proveedor: `prompt_cache_key` (enruta la caché de prefijo
 * de OpenAI), `service_tier` (Flex cobra la mitad), `store`, herramientas y
 * `parallel_tool_calls`. Un gateway que los pierda o los reescriba sube la
 * factura o cambia la respuesta sin romper nada visible.
 */
/**
 * La marca que el upstream falso reconoce en los mensajes para responder con un
 * usage FIJO: si no, el usage (≈ bytes/4) cambiaría con cualquier reescritura
 * del cuerpo y la comparación de respuestas culparía al gateway de algo que
 * hace el propio banco.
 */
export const MARCA_DE_FIDELIDAD = "[banco-fidelidad]";

/** El usage de entrada fijo de la prueba de fidelidad. */
export const ENTRADA_DE_FIDELIDAD = 100;

export function cuerpoDeFidelidad(modelo: string): string {
  // Sin `temperature` ni `seed`: los modelos que razonan no los aceptan y un
  // gateway que los quite por eso haría ruido sin cambiar la factura.
  // `max_completion_tokens` (no `max_tokens`) vale para todos los modelos
  // actuales de OpenAI, así que nadie tiene que traducirlo.
  return JSON.stringify({
    model: modelo,
    messages: [
      { role: "system", content: `You are a careful assistant. ${MARCA_DE_FIDELIDAD}` },
      { role: "user", content: "Add 2 and 3 with the tool." },
    ],
    max_completion_tokens: 64,
    store: false,
    prompt_cache_key: "banco-fidelidad",
    service_tier: "flex",
    tools: [
      {
        type: "function",
        function: {
          name: "add",
          description: "Adds two numbers",
          parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
        },
      },
    ],
    parallel_tool_calls: false,
  });
}

export interface Fidelidad {
  /** Los bytes llegaron iguales. */
  identicoEnBytes: boolean;
  /** Mismo JSON (orden de claves aparte) sin contar las claves de `ignorar`. */
  mismoJson: boolean;
  /** Claves de primer nivel que no llegaron. */
  perdidas: string[];
  /** Claves de primer nivel que llegaron sin haberse mandado. */
  anadidas: string[];
  /** Claves de primer nivel que llegaron con otro valor (sin contar `ignorar`). */
  cambiadas: string[];
}

function igualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => igualJson(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && igualJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Compara lo que se mandó con lo que llegó. `ignorar` son claves que el gateway
 * TIENE que reescribir por diseño (el `model` con prefijo de proveedor o alias),
 * para que no tapen lo demás. Un cuerpo que no es JSON solo se compara en bytes.
 */
export function compararCuerpos(enviado: string, recibido: string, ignorar: readonly string[] = []): Fidelidad {
  const identicoEnBytes = enviado === recibido;
  let a: Record<string, unknown>;
  let b: Record<string, unknown>;
  try {
    a = JSON.parse(enviado) as Record<string, unknown>;
    b = JSON.parse(recibido) as Record<string, unknown>;
  } catch {
    return { identicoEnBytes, mismoJson: identicoEnBytes, perdidas: [], anadidas: [], cambiadas: [] };
  }
  const perdidas = Object.keys(a).filter((k) => !(k in b));
  const anadidas = Object.keys(b).filter((k) => !(k in a));
  const cambiadas = Object.keys(a).filter((k) => k in b && !ignorar.includes(k) && !igualJson(a[k], b[k]));
  return {
    identicoEnBytes,
    mismoJson: perdidas.length === 0 && anadidas.length === 0 && cambiadas.length === 0,
    perdidas,
    anadidas,
    cambiadas,
  };
}

// ── Las conexiones salientes (vigia-conexiones.ts) ────────────────────────

export interface Extremo {
  /** Dirección remota tal como la da lsof con -nP (IPv4 o [IPv6]). */
  host: string;
  puerto: number;
}

/**
 * Los extremos REMOTOS no locales de la salida de `lsof -nP -iTCP -iUDP -F n`
 * (una línea `n<local>-><remoto>` por socket conectado). Se descartan loopback
 * (127.0.0.0/8, ::1) y los sockets sin par (escuchando). Puro para probarlo sin
 * lsof.
 */
export function extremosRemotos(salidaLsof: string): Extremo[] {
  const vistos = new Map<string, Extremo>();
  for (const cruda of salidaLsof.split("\n")) {
    const l = cruda.trim();
    if (!l.startsWith("n") || !l.includes("->")) continue;
    const remoto = l.slice(l.indexOf("->") + 2).trim();
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(remoto);
    if (!m) continue;
    const host = m[1]!;
    const puerto = Number(m[2]);
    if (esLoopback(host)) continue;
    vistos.set(`${host}:${puerto}`, { host, puerto });
  }
  return [...vistos.values()];
}

export function esLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return h === "::1" || h === "localhost" || /^127\./.test(h) || h === "::ffff:127.0.0.1";
}

// ── El informe ─────────────────────────────────────────────────────────────

const f = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");

/** Una fila de tabla Markdown por escenario (lo que el arnés imprime). */
export function filaMarkdown(objetivo: string, escenario: string, r: ResumenDeEscenario): string {
  const s1 = r.sobrecoste.primerByteMs;
  const sT = r.sobrecoste.totalMs;
  return (
    `| ${objetivo} | ${escenario} | ${r.gateway.total.n} | ` +
    `${f(r.directo.total.p50)} / ${f(r.gateway.total.p50)} | ` +
    `**${f(sT.punto)}** [${f(sT.inferior)}, ${f(sT.superior)}] | ` +
    `${f(s1.punto)} [${f(s1.inferior)}, ${f(s1.superior)}] | ` +
    `${f(r.directo.total.p99)} / ${f(r.gateway.total.p99)} |`
  );
}

export const CABECERA_MARKDOWN =
  "| Gateway | Escenario | Rondas | p50 total directo / vía gateway (ms) | Sobrecoste total, mediana [IC 95 %] (ms) | Sobrecoste 1.er byte, mediana [IC 95 %] (ms) | p99 total directo / vía gateway (ms) |\n" +
  "|---|---|---|---|---|---|---|";
