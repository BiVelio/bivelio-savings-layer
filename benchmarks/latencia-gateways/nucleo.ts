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

// ── La fidelidad en el dialecto de Anthropic (E1, 2026-09-27) ─────────────

/**
 * Las betas que viajan con la prueba de fidelidad de Mensajes: el TTL de 1 h
 * (la que negocia Claude Code), las herramientas en línea (22-sep-2026) y los
 * cambios de herramientas por referencia a mitad de conversación. Un gateway que
 * pierda la cabecera o la reescriba cambia lo que el proveedor acepta y cobra.
 */
export const BETAS_DE_FIDELIDAD = "extended-cache-ttl-2025-04-11,inline-tools-2026-09-15,mid-conversation-tool-changes-2026-07-01";

/** Las cabeceras de Mensajes que tienen que llegar INTACTAS (en minúsculas). */
export const CABECERAS_DE_FIDELIDAD_ANTHROPIC = ["anthropic-version", "anthropic-beta"] as const;

/**
 * Un cuerpo de la API de Mensajes con lo que CAMBIA LA FACTURA de Claude o su
 * comportamiento, en las formas de la documentación oficial (consultada el
 * 2026-09-27):
 *
 *   · `cache_control` con `ttl: "1h"` en `system`, en una herramienta y en el
 *     último turno del usuario (la escritura de 1 h se cobra a 2×, la de 5 min a
 *     1,25×: un gateway que quite el `ttl` cambia la prima);
 *   · la búsqueda de herramientas: la herramienta de búsqueda, una herramienta
 *     diferida (`defer_loading: true`) y, en el historial, el resultado de la
 *     búsqueda con su bloque `tool_reference`;
 *   · las herramientas EN LÍNEA (beta `inline-tools-2026-09-15`): un mensaje
 *     `system` a mitad de conversación con un `tool_addition` que trae la
 *     definición entera y otro que añade por referencia (`tool_reference`).
 *     Existen para NO tocar `tools` y no invalidar la caché de prefijo.
 *
 * Con `stream` el mismo cuerpo pide SSE. La marca de fidelidad va en `system`:
 * el upstream falso responde con un usage FIJO (con el desglose de la escritura
 * de 1 h) para que la comparación de respuestas no culpe al gateway del banco.
 */
export function cuerpoDeFidelidadAnthropic(modelo: string, opts: { stream?: boolean } = {}): string {
  const unaHora = { type: "ephemeral", ttl: "1h" };
  return JSON.stringify({
    model: modelo,
    max_tokens: 64,
    system: [{ type: "text", text: `You are a careful assistant. ${MARCA_DE_FIDELIDAD}`, cache_control: unaHora }],
    tools: [
      { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      {
        name: "add",
        description: "Adds two numbers",
        input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
        cache_control: unaHora,
      },
      {
        name: "lookup_order",
        description: "Looks up an order by id",
        input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        defer_loading: true,
      },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "Find the order tool first." }] },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srvtoolu_banco_1", name: "tool_search_tool_regex", input: { query: "order" } },
          {
            type: "tool_search_tool_result",
            tool_use_id: "srvtoolu_banco_1",
            content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: "lookup_order" }] },
          },
          { type: "text", text: "Found it." },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Now add 2 and 3 with the tool.", cache_control: unaHora }] },
      {
        role: "system",
        content: [
          {
            type: "tool_addition",
            tool: {
              type: "tool_definition",
              definition: {
                name: "db_query",
                description: "Run a read-only SQL query against the analytics database.",
                input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
              },
            },
          },
          { type: "tool_addition", tool: { type: "tool_reference", name: "lookup_order" } },
        ],
      },
    ],
    ...(opts.stream ? { stream: true } : {}),
  });
}

/** Lo que el upstream falso declara para la prueba de fidelidad de Mensajes: una escritura de 1 h. */
export const USO_DE_FIDELIDAD_ANTHROPIC = {
  input_tokens: ENTRADA_DE_FIDELIDAD,
  cache_creation_input_tokens: 2048,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2048 },
  output_tokens: 12,
  service_tier: "standard",
} as const;

export interface FidelidadDeCabeceras {
  /** Las de CABECERAS_DE_FIDELIDAD_ANTHROPIC que no llegaron. */
  perdidas: string[];
  /** Las que llegaron con otro valor. */
  cambiadas: string[];
}

/** Compara las cabeceras que el cliente mandó con las que el upstream dice haber recibido. */
export function compararCabeceras(
  enviadas: Readonly<Record<string, string>>,
  recibidas: Readonly<Record<string, string | string[] | undefined>>,
  nombres: readonly string[] = CABECERAS_DE_FIDELIDAD_ANTHROPIC,
): FidelidadDeCabeceras {
  const perdidas: string[] = [];
  const cambiadas: string[] = [];
  for (const n of nombres) {
    const mandada = Object.entries(enviadas).find(([k]) => k.toLowerCase() === n)?.[1];
    if (mandada === undefined) continue;
    const llego = recibidas[n];
    if (llego === undefined) perdidas.push(n);
    else if ((Array.isArray(llego) ? llego.join(",") : llego) !== mandada) cambiadas.push(n);
  }
  return { perdidas, cambiadas };
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

export interface DiferenciasProfundas {
  /** Rutas JSON (`system[0].cache_control.ttl`) que estaban y no llegaron. */
  perdidas: string[];
  /** Rutas que llegaron sin haberse mandado. */
  anadidas: string[];
  /** Hojas que llegaron con otro valor (o con otro tipo). */
  cambiadas: string[];
}

/**
 * Qué cambió DENTRO de un JSON, ruta a ruta: `compararCuerpos` dice que cambió
 * `system`; esto dice que se perdió `system[0].cache_control.ttl`, que es lo que
 * decide la prima. Los arrays se comparan por posición. `ignorar` son claves de
 * PRIMER nivel (el `model` que el gateway reescribe por diseño). Como mucho
 * `tope` rutas por lista, para que un cuerpo reescrito entero no llene el informe.
 */
export function diferenciasProfundas(enviado: unknown, recibido: unknown, ignorar: readonly string[] = [], tope = 40): DiferenciasProfundas {
  const out: DiferenciasProfundas = { perdidas: [], anadidas: [], cambiadas: [] };
  const empujar = (l: string[], r: string) => {
    if (l.length < tope) l.push(r);
  };
  const esObjeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const andar = (a: unknown, b: unknown, ruta: string, nivel: number): void => {
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const r = `${ruta}[${i}]`;
        if (i >= b.length) empujar(out.perdidas, r);
        else if (i >= a.length) empujar(out.anadidas, r);
        else andar(a[i], b[i], r, nivel + 1);
      }
      return;
    }
    if (esObjeto(a) && esObjeto(b)) {
      for (const k of Object.keys(a)) {
        if (nivel === 0 && ignorar.includes(k)) continue;
        const r = ruta ? `${ruta}.${k}` : k;
        if (!(k in b)) empujar(out.perdidas, r);
        else andar(a[k], b[k], r, nivel + 1);
      }
      for (const k of Object.keys(b)) {
        if (nivel === 0 && ignorar.includes(k)) continue;
        if (!(k in a)) empujar(out.anadidas, ruta ? `${ruta}.${k}` : k);
      }
      return;
    }
    if (!igualJson(a, b)) empujar(out.cambiadas, ruta || "$");
  };
  andar(enviado, recibido, "", 0);
  return out;
}

/** Las claves de un `usage` de Mensajes, aplanadas un nivel (`cache_creation.ephemeral_1h_input_tokens`). */
function clavesDeUso(u: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (u === null || typeof u !== "object") return out;
  for (const [k, v] of Object.entries(u as Record<string, unknown>)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) out.set(`${k}.${k2}`, v2);
    } else out.set(k, v);
  }
  return out;
}

export interface FidelidadDeUso {
  /** Claves del `usage` directo que no llegaron (aplanadas un nivel). */
  perdidas: string[];
  anadidas: string[];
  cambiadas: string[];
}

/** Compara dos `usage` de Mensajes clave a clave: aquí vive la factura de la respuesta. */
export function compararUso(directo: unknown, viaGateway: unknown): FidelidadDeUso {
  const a = clavesDeUso(directo);
  const b = clavesDeUso(viaGateway);
  return {
    perdidas: [...a.keys()].filter((k) => !b.has(k)),
    anadidas: [...b.keys()].filter((k) => !a.has(k)),
    cambiadas: [...a.keys()].filter((k) => b.has(k) && !igualJson(a.get(k), b.get(k))),
  };
}

/** Los eventos de un SSE de Mensajes: su tipo y su `data` parseado (o null). */
export function eventosSse(texto: string): { evento: string; data: unknown }[] {
  const out: { evento: string; data: unknown }[] = [];
  for (const bloque of texto.replace(/\r\n/g, "\n").split("\n\n")) {
    if (bloque.trim() === "") continue;
    const evento = /^event: ?(.*)$/m.exec(bloque)?.[1]?.trim() ?? "message";
    const datos = [...bloque.matchAll(/^data: ?(.*)$/gm)].map((m) => m[1]).join("\n");
    let data: unknown = null;
    try {
      data = JSON.parse(datos);
    } catch {
      data = datos === "" ? null : datos;
    }
    out.push({ evento, data });
  }
  return out;
}

/** El `usage` de un SSE de Mensajes tal como lo leería quien mide: message_start ∪ message_delta. */
export function usoDeSse(texto: string): Record<string, unknown> {
  let uso: Record<string, unknown> = {};
  for (const { evento, data } of eventosSse(texto)) {
    const d = (data ?? {}) as { usage?: Record<string, unknown>; message?: { usage?: Record<string, unknown> } };
    const u = evento === "message_start" ? d.message?.usage : evento === "message_delta" ? d.usage : undefined;
    if (u && typeof u === "object") {
      const cc = { ...((uso["cache_creation"] as object | undefined) ?? {}), ...((u["cache_creation"] as object | undefined) ?? {}) };
      uso = { ...uso, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== null && v !== undefined)) };
      if (Object.keys(cc).length) uso["cache_creation"] = cc;
    }
  }
  return uso;
}

export interface FidelidadDeSse {
  identicoEnBytes: boolean;
  /** La misma secuencia de tipos de evento. */
  mismosEventos: boolean;
  eventosDirecto: string[];
  eventosGateway: string[];
  /** El `usage` fusionado (message_start ∪ message_delta), clave a clave. */
  uso: FidelidadDeUso;
}

/** Compara la respuesta SSE de Mensajes vía gateway con la directa. */
export function compararSseMensajes(directa: string, viaGateway: string): FidelidadDeSse {
  const ed = eventosSse(directa).map((e) => e.evento);
  const eg = eventosSse(viaGateway).map((e) => e.evento);
  return {
    identicoEnBytes: directa === viaGateway,
    mismosEventos: ed.length === eg.length && ed.every((e, i) => e === eg[i]),
    eventosDirecto: ed,
    eventosGateway: eg,
    uso: compararUso(usoDeSse(directa), usoDeSse(viaGateway)),
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
