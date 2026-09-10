/**
 * SALIDA · POR CLASE DE TAREA — la salida es el ~10 % de la factura y NO tiene
 * palanca. La anatomía global (anatomia.ts) dice CUÁNTO es thinking, tool_use y
 * prosa; no dice DÓNDE. Este arnés parte el mismo corpus del espía en CLASES DE
 * TAREA observables y mide el dinero de salida de cada una, para poder decir a
 * qué clase apuntaría una palanca y cuánto es su techo aritmético.
 *
 * LA TAXONOMÍA no se inventa: sale de lo que el corpus deja ver de cada turno.
 *   · el LLAMADOR — ¿trae la petición herramientas declaradas? Sin ellas no es
 *     un turno de agente sino una llamada interna de Claude Code (título de la
 *     conversación con max_tokens=64 y stop_sequence, sonda de cuota con
 *     max_tokens=1, resúmenes sin herramientas).
 *   · lo que el turno PRODUJO — la familia de herramienta que domina los
 *     caracteres de `tool_use` de la respuesta (escritura / shell / lectura /
 *     orquestación / otras), o NINGUNA cuando el turno solo escribió prosa.
 * Cada petición cae en UNA clase y solo una; `sin-cuerpo` es el residuo honesto
 * de las respuestas cuyo cuerpo el espía no guardó.
 *
 * DINERO: el reparto calibrado se suma por (clase × modelo), nunca en agregado
 * — el mismo motivo que `resumirEstratificado`: la prosa se concentra en el
 * modelo barato y el JSON en el caro, y un ratio global movería dinero entre
 * ellos.
 *
 * PRIVACIDAD (doctrina de sombra-corpus / anillo2 / anatomía): del contenido no
 * sale NADA. Solo números y nombres de herramienta. MEMORIA: readline línea a
 * línea; el corpus son gigabytes y jamás se carga un fichero entero.
 *
 * SIN RED: el corpus ya capturado es el dato; no se llama al proveedor.
 *
 * Uso:  pnpm salida:por-clase [captura.jsonl ...]
 *       (sin argumentos: todas las capturas de ~/.bvsala-f0)
 * Salida: benchmarks/out/salida-por-clase-<fecha>.json + tabla por stderr.
 */
import { createReadStream, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { medir } from "./anatomia.js";
import {
  acumuladorVacio,
  agregar,
  resumirEstratificado,
  type Acumulador,
  type AnatomiaRespuesta,
  type Resumen,
  type UsoConSalida,
} from "./anatomia-nucleo.js";

// ── La taxonomía ──

/** Familia de una herramienta por lo que su JSON de entrada TRANSPORTA. */
export type Familia = "escritura" | "shell" | "estructurado" | "lectura" | "orquestacion" | "otras";

/** Orden fijo para desempatar (y para las tablas): determinista siempre. */
export const FAMILIAS: readonly Familia[] = ["escritura", "shell", "estructurado", "lectura", "orquestacion", "otras"];

/**
 * Nombre de herramienta → familia. La lista se cierra con `otras`, que es donde
 * caen las MCP y cualquier herramienta que aparezca mañana: una clase nueva
 * jamás se cuela en silencio dentro de otra.
 *
 * · escritura   — el JSON LLEVA el fichero (o el trozo): su masa ES el trabajo.
 * · shell       — el JSON lleva una orden; corto de escribir, caro de leer.
 * · estructurado— el JSON ES el entregable y no toca disco: el informe con
 *   esquema que un subagente devuelve al padre (StructuredOutput) y el guion de
 *   un Workflow. Sale aparte de `otras` porque mueve DINERO (10 % de la salida
 *   del corpus) y su palanca no es la de un fichero: es el esquema.
 * · lectura     — el JSON es una ruta o una consulta: masa casi nula.
 * · orquestacion— delegar, anotar, preguntar: prompts de subagente incluidos.
 */
export const POR_FAMILIA: Record<Familia, readonly string[]> = {
  escritura: ["Write", "Edit", "MultiEdit", "NotebookEdit", "ApplyPatch", "StrReplace", "str_replace_editor", "create_file"],
  shell: ["Bash", "BashOutput", "KillShell", "KillBash", "Monitor", "Terminal"],
  estructurado: ["StructuredOutput", "Workflow"],
  lectura: ["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch"],
  orquestacion: [
    "Agent",
    "Task",
    "TodoWrite",
    "SendMessage",
    "Skill",
    "TaskOutput",
    "TaskStop",
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
    "PushNotification",
    "SendFeedback",
    "CronCreate",
    "CronDelete",
    "CronList",
  ],
  otras: [],
};

const INDICE: Map<string, Familia> = new Map(
  FAMILIAS.flatMap((f) => POR_FAMILIA[f].map((n) => [n, f] as [string, Familia])),
);

export function familiaDeHerramienta(nombre: string): Familia {
  return INDICE.get(nombre) ?? "otras";
}

/** Las clases de tarea. `sin-cuerpo` es el residuo, no una clase de verdad. */
export type Clase =
  | "agente-escritura"
  | "agente-shell"
  | "agente-estructurado"
  | "agente-lectura"
  | "agente-orquestacion"
  | "agente-otras"
  | "agente-prosa"
  | "interno-sin-herramientas"
  | "sin-cuerpo";

export const CLASES: readonly Clase[] = [
  "agente-escritura",
  "agente-shell",
  "agente-estructurado",
  "agente-lectura",
  "agente-orquestacion",
  "agente-otras",
  "agente-prosa",
  "interno-sin-herramientas",
  "sin-cuerpo",
];

/** De familia dominante a clase: la mitad «agente-*» de la taxonomía. */
const CLASE_DE_FAMILIA: Record<Familia, Clase> = {
  escritura: "agente-escritura",
  shell: "agente-shell",
  estructurado: "agente-estructurado",
  lectura: "agente-lectura",
  orquestacion: "agente-orquestacion",
  otras: "agente-otras",
};

/** Lo que la CLASIFICACIÓN necesita de la petición (no del contenido). */
export interface FormaDePeticion {
  /** El array `tools` del cuerpo, tal cual (o lo que hubiera en su lugar). */
  tools: unknown;
}

/** El resultado de clasificar: la clase y por qué, para poder auditarlo. */
export interface Clasificacion {
  clase: Clase;
  /** Familia dominante (null si el turno no llamó a ninguna herramienta). */
  familia: Familia | null;
  /** Fracción de los caracteres de tool_use que se lleva la familia dominante:
   *  1 = turno puro; < 1 = turno MIXTO clasificado por su masa mayor. */
  purezaFamilia: number;
}

/**
 * Clasifica UN turno. Exhaustiva y excluyente por construcción: hay exactamente
 * un `return` por rama y todas las ramas devuelven una clase de `CLASES`.
 *
 * El orden importa y es deliberado:
 *   1. sin cuerpo de respuesta → no se puede mirar lo que produjo: `sin-cuerpo`.
 *   2. sin herramientas declaradas → no es un turno de agente: `interno-*`.
 *      (va ANTES de mirar la respuesta: una llamada interna no puede llamar a
 *      herramientas aunque el modelo lo intentase.)
 *   3. con herramientas: manda la familia que domina los caracteres de
 *      tool_use; sin ningún tool_use, `agente-prosa`.
 */
export function clasificar(peticion: FormaDePeticion, anatomia: AnatomiaRespuesta | null): Clasificacion {
  if (anatomia === null) return { clase: "sin-cuerpo", familia: null, purezaFamilia: 0 };
  const conHerramientas = Array.isArray(peticion.tools) && peticion.tools.length > 0;
  if (!conHerramientas) return { clase: "interno-sin-herramientas", familia: null, purezaFamilia: 0 };

  const chars: Record<Familia, number> = { escritura: 0, shell: 0, estructurado: 0, lectura: 0, orquestacion: 0, otras: 0 };
  const llamadas: Record<Familia, number> = { escritura: 0, shell: 0, estructurado: 0, lectura: 0, orquestacion: 0, otras: 0 };
  let totalLlamadas = 0;
  let totalChars = 0;
  for (const [nombre, h] of Object.entries(anatomia.herramientas)) {
    const f = familiaDeHerramienta(nombre);
    chars[f] += h.chars;
    llamadas[f] += h.llamadas;
    totalLlamadas += h.llamadas;
    totalChars += h.chars;
  }
  if (totalLlamadas === 0) return { clase: "agente-prosa", familia: null, purezaFamilia: 0 };

  // Dominante por caracteres; empate (p. ej. varias herramientas con input {})
  // se rompe por llamadas y, si persiste, por el orden fijo de FAMILIAS.
  let mejor: Familia = FAMILIAS[0]!;
  for (const f of FAMILIAS) {
    if (chars[f] > chars[mejor] || (chars[f] === chars[mejor] && llamadas[f] > llamadas[mejor])) mejor = f;
  }
  return {
    clase: CLASE_DE_FAMILIA[mejor],
    familia: mejor,
    purezaFamilia: totalChars > 0 ? chars[mejor] / totalChars : llamadas[mejor] / totalLlamadas,
  };
}

// ── El techo aritmético ──

/**
 * Lo que un recorte daría en esta clase, en dinero. NO es una promesa: es
 * aritmética sobre la masa medida. Se separa la masa DIRIGIBLE (thinking, que
 * tiene dial de presupuesto; prosa, que un estilo de salida acorta) de la que
 * NO lo es sin perder el trabajo (el JSON de tool_use lleva el fichero o la
 * orden: recortarlo es escribir peor).
 */
export interface Techo {
  salidaUsd: number;
  usdPorDia: number;
  masaUsd: { thinking: number; prosa: number; toolUse: number };
  /** Recorte hipotético de TODA la salida de la clase. */
  siRecortaTodo: Record<"10%" | "20%" | "30%", number>;
  /** Recorte hipotético SOLO de la masa dirigible. */
  siRecortaThinking: Record<"30%" | "50%", number>;
  siRecortaProsa: Record<"30%" | "50%", number>;
}

export function techoDeClase(r: Resumen, dias: number): Techo {
  const c = r.dinero.porMasaCalibrado;
  const thinking = c.thinking;
  const prosa = c.text;
  const toolUse = c.tool_use;
  const total = r.dinero.salidaUsd;
  const d = Math.max(1, dias);
  const red = (x: number) => Number(x.toFixed(4));
  return {
    salidaUsd: red(total),
    usdPorDia: red(total / d),
    masaUsd: { thinking: red(thinking), prosa: red(prosa), toolUse: red(toolUse) },
    siRecortaTodo: { "10%": red(total * 0.1), "20%": red(total * 0.2), "30%": red(total * 0.3) },
    siRecortaThinking: { "30%": red(thinking * 0.3), "50%": red(thinking * 0.5) },
    siRecortaProsa: { "30%": red(prosa * 0.3), "50%": red(prosa * 0.5) },
  };
}

// ── Sonda del JSON de Bash: ¿orden o carga? ──

/**
 * `agente-shell` es la clase que más dinero mueve y la MITAD de ese dinero es
 * el JSON de Bash. Antes de decir «no se puede recortar: es una orden» hay que
 * saber cuánto de ese JSON es realmente una orden y cuánto es un FICHERO que
 * viaja dentro de la orden: en este corpus el agente escribe con
 * `cat > f <<'EOF' … EOF`, y el cuerpo del heredoc es contenido, no sintaxis.
 * La distinción cambia el veredicto: la orden se puede acortar; el fichero no.
 *
 * Solo salen CONTADORES. El comando vive lo que dura la función.
 */
export interface MasaDeComando {
  comandos: number;
  chars: number;
  /** Caracteres dentro del cuerpo de un heredoc: contenido, no sintaxis. */
  charsHeredoc: number;
  conHeredoc: number;
  /** Comandos que no se pudieron parsear (JSON truncado por max_tokens). */
  ilegibles: number;
}

export function masaVacia(): MasaDeComando {
  return { comandos: 0, chars: 0, charsHeredoc: 0, conHeredoc: 0, ilegibles: 0 };
}

/** Caracteres del comando que caen dentro del cuerpo de algún heredoc. */
export function charsDeHeredoc(comando: string): number {
  let total = 0;
  const re = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g;
  let m: RegExpExecArray | null;
  let desde = 0;
  while ((m = re.exec(comando)) !== null) {
    if (m.index < desde) continue; // ya dentro de un cuerpo contado
    const marca = m[1] ?? m[2] ?? m[3];
    if (!marca) continue;
    const inicio = comando.indexOf("\n", m.index);
    if (inicio === -1) break;
    // El cierre es una línea cuyo contenido (sin tabuladores de `<<-`) es la marca.
    const cierre = new RegExp(`\n[\t ]*${marca.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&")}[\t ]*(?:\n|$)`);
    const resto = comando.slice(inicio);
    const c = cierre.exec(resto);
    const fin = c ? inicio + c.index : comando.length;
    total += Math.max(0, fin - (inicio + 1));
    desde = c ? fin + c[0].length : comando.length;
    re.lastIndex = desde;
  }
  return Math.min(total, comando.length);
}

/**
 * Recorre un SSE y mide la masa de los `input_json` de Bash. Reconstruye el
 * JSON parcial de cada bloque `tool_use` llamado Bash, lee su `command` y lo
 * reduce a contadores. Un JSON truncado (respuesta cortada por max_tokens) no
 * parsea: se cuenta en `ilegibles` y no se inventa nada.
 */
export function masaBashDeSse(utf8: string, acum: MasaDeComando): void {
  const abiertos = new Map<number, string[] | null>();
  for (const bloque of utf8.split("\n\n")) {
    const ev = /^event: (.+)$/m.exec(bloque)?.[1];
    if (ev !== "content_block_start" && ev !== "content_block_delta") continue;
    const data = /^data: (.+)$/m.exec(bloque)?.[1];
    if (!data) continue;
    let d: { index?: number; content_block?: { type?: unknown; name?: unknown }; delta?: { type?: unknown; partial_json?: unknown } };
    try {
      d = JSON.parse(data) as typeof d;
    } catch {
      continue;
    }
    const i = typeof d.index === "number" ? d.index : -1;
    if (i < 0) continue;
    if (ev === "content_block_start") {
      abiertos.set(i, d.content_block?.type === "tool_use" && d.content_block.name === "Bash" ? [] : null);
      continue;
    }
    const trozos = abiertos.get(i);
    if (trozos && d.delta?.type === "input_json_delta" && typeof d.delta.partial_json === "string") trozos.push(d.delta.partial_json);
  }
  for (const trozos of abiertos.values()) {
    if (!trozos) continue;
    acum.comandos += 1;
    let comando: string;
    try {
      const v = JSON.parse(trozos.join("")) as { command?: unknown };
      if (typeof v.command !== "string") {
        acum.ilegibles += 1;
        continue;
      }
      comando = v.command;
    } catch {
      acum.ilegibles += 1;
      continue;
    }
    const h = charsDeHeredoc(comando);
    acum.chars += comando.length;
    acum.charsHeredoc += h;
    if (h > 0) acum.conHeredoc += 1;
  }
}

// ── El arnés ──

/** Lo que este arnés lee de un registro del espía (el resto se ignora). */
interface Registro {
  at?: string;
  method?: string;
  path?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: { model?: unknown; messages?: unknown; tools?: unknown; max_tokens?: unknown };
  sse?: { usage?: { usage: UsoConSalida }[] };
  responseBodyBase64?: string;
  responseBodyOmitted?: string;
}

interface Cuenta {
  lineas: number;
  candidatas: number;
  ilegibles: number;
  sinUsage: number;
  sinPrecio: number;
  cuerpoOmitido: number;
  cuerpoIlegible: number;
}

/** Un estrato: el acumulador global de la clase y los suyos por modelo. */
interface Estrato {
  global: Acumulador;
  porModelo: Map<string, Acumulador>;
}

function estratoVacio(): Estrato {
  return { global: acumuladorVacio(), porModelo: new Map() };
}

function anotar(e: Estrato, m: Parameters<typeof agregar>[1]): void {
  agregar(e.global, m);
  let a = e.porModelo.get(m.model);
  if (!a) e.porModelo.set(m.model, (a = acumuladorVacio()));
  agregar(a, m);
}

const PREFILTRO = '"path":"/v1/messages"';

/** Lo que se acumula además de los acumuladores de anatomía. */
interface Extras {
  /** max_tokens visto en las llamadas internas: separa título de resumen. */
  maxTokensInternos: Record<string, number>;
  /** Turnos de subagente (cabecera x-claude-code-agent-id) por clase. */
  subagente: Record<string, number>;
  /** Turnos MIXTOS (la familia dominante no se lleva todo el tool_use). */
  mixtos: Record<string, number>;
  purezaSuma: Record<string, number>;
  purezaN: Record<string, number>;
  /** Masa de los comandos de Bash de los turnos de `agente-shell`. */
  bash: MasaDeComando;
}

function extrasVacios(): Extras {
  return { maxTokensInternos: {}, subagente: {}, mixtos: {}, purezaSuma: {}, purezaN: {}, bash: masaVacia() };
}

async function leer(
  ruta: string,
  estratos: Map<Clase, Estrato>,
  todo: Estrato,
  cuenta: Cuenta,
  extras: Extras,
  rango: { desde: string | null; hasta: string | null },
  dias: Set<string>,
): Promise<void> {
  const rl = createInterface({ input: createReadStream(ruta), crlfDelay: Infinity });
  for await (const linea of rl) {
    if (!linea) continue;
    cuenta.lineas += 1;
    // Prefiltro por substring ANTES de parsear: casi todos los bytes del
    // fichero son cuerpos base64; parsear cada línea para descartarla costaría
    // más que leerla.
    if (!linea.includes(PREFILTRO)) continue;
    cuenta.candidatas += 1;
    let r: Registro;
    try {
      r = JSON.parse(linea) as Registro;
    } catch {
      cuenta.ilegibles += 1;
      continue;
    }
    if (r.method !== "POST" || r.path !== "/v1/messages") continue;
    const m = medir(r, cuenta);
    if (!m) continue;
    const { clase, purezaFamilia } = clasificar({ tools: r.requestBody?.tools }, m.anatomia);
    let e = estratos.get(clase);
    if (!e) estratos.set(clase, (e = estratoVacio()));
    anotar(e, m);
    anotar(todo, m);
    if (r.at) {
      if (rango.desde === null || r.at < rango.desde) rango.desde = r.at;
      if (rango.hasta === null || r.at > rango.hasta) rango.hasta = r.at;
      dias.add(r.at.slice(0, 10));
    }
    if (clase === "interno-sin-herramientas") {
      const k = String(r.requestBody?.max_tokens ?? "?");
      extras.maxTokensInternos[k] = (extras.maxTokensInternos[k] ?? 0) + 1;
    }
    if (r.requestHeaders?.["x-claude-code-agent-id"]) extras.subagente[clase] = (extras.subagente[clase] ?? 0) + 1;
    // Solo en la clase que decide el veredicto, y solo sobre SSE: el cuerpo se
    // vuelve a decodificar aquí y muere en `masaBashDeSse`.
    if (clase === "agente-shell" && r.sse && r.responseBodyBase64) {
      masaBashDeSse(Buffer.from(r.responseBodyBase64, "base64").toString("utf8"), extras.bash);
    }
    if (m.anatomia && Object.keys(m.anatomia.herramientas).length > 0) {
      extras.purezaSuma[clase] = (extras.purezaSuma[clase] ?? 0) + purezaFamilia;
      extras.purezaN[clase] = (extras.purezaN[clase] ?? 0) + 1;
      if (purezaFamilia < 1) extras.mixtos[clase] = (extras.mixtos[clase] ?? 0) + 1;
    }
  }
}

/**
 * PRESTAR LA CALIBRACIÓN. El ratio chars/token de la prosa y del JSON es una
 * propiedad del MODELO y del tipo de contenido, no de la clase de tarea: medido
 * dentro de una clase estrecha sale de un puñado de respuestas puras (en el
 * corpus, `agente-shell` tiene DOS respuestas de prosa pura) y el reparto se
 * caería al proporcional por falta de muestra. Se mide una vez por modelo sobre
 * el corpus ENTERO y se presta a cada estrato (clase × modelo) de ese modelo.
 * No mueve dinero entre modelos —cada uno usa el suyo—, solo entre prosa y JSON
 * dentro de un modelo, que es justo lo que la calibración corrige.
 */
function prestarCalibracion(e: Estrato, delModelo: Map<string, Acumulador["calibracion"]>): void {
  for (const [modelo, a] of e.porModelo) {
    const c = delModelo.get(modelo);
    if (c && c.prosaTokens > 0 && c.jsonTokens > 0) a.calibracion = { ...c };
  }
}

/** El resumen de un estrato con su calibrado sumado por modelo. */
function resumirEstrato(e: Estrato): Resumen {
  return resumirEstratificado(e.global, [...e.porModelo.values()]);
}

function tabla(filas: [string, Resumen, Techo][], salidaTotal: number): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const cab = [
    "clase".padEnd(26),
    "pet".padStart(6),
    "%pet".padStart(6),
    "tokSal".padStart(10),
    "$sal".padStart(9),
    "%$sal".padStart(7),
    "$/día".padStart(7),
    "thk%".padStart(6),
    "tool%".padStart(6),
    "prosa%".padStart(7),
    "$thk".padStart(8),
    "$tool".padStart(8),
    "$prosa".padStart(8),
    "trunc%".padStart(7),
  ].join(" ");
  const totalPet = filas.reduce((s, [, r]) => s + r.peticiones, 0);
  const cuerpo = filas.map(([nombre, r, t]) =>
    [
      nombre.slice(0, 26).padEnd(26),
      String(r.peticiones).padStart(6),
      pct(totalPet ? r.peticiones / totalPet : 0).padStart(6),
      String(r.tokensSalida.total).padStart(10),
      r.dinero.salidaUsd.toFixed(2).padStart(9),
      pct(salidaTotal ? r.dinero.salidaUsd / salidaTotal : 0).padStart(7),
      t.usdPorDia.toFixed(2).padStart(7),
      pct(r.dinero.shareDeSalidaPorMasaCalibrado.thinking).padStart(6),
      pct(r.dinero.shareDeSalidaPorMasaCalibrado.tool_use).padStart(6),
      pct(r.dinero.shareDeSalidaPorMasaCalibrado.text).padStart(7),
      t.masaUsd.thinking.toFixed(2).padStart(8),
      t.masaUsd.toolUse.toFixed(2).padStart(8),
      t.masaUsd.prosa.toFixed(2).padStart(8),
      pct(r.truncadas.share).padStart(7),
    ].join(" "),
  );
  return [cab, ...cuerpo].join("\n");
}

async function main(): Promise<void> {
  const DIR = join(homedir(), ".bvsala-f0");
  const ficheros = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync(DIR)
        .filter((f) => f.startsWith("captura-") && f.endsWith(".jsonl"))
        .map((f) => join(DIR, f));
  if (!ficheros.length) {
    console.error("[por-clase] no hay capturas; graba con scripts/espia-anthropic.mjs");
    process.exit(1);
  }

  const estratos = new Map<Clase, Estrato>();
  const todo = estratoVacio();
  const extras = extrasVacios();
  const cuenta: Cuenta = { lineas: 0, candidatas: 0, ilegibles: 0, sinUsage: 0, sinPrecio: 0, cuerpoOmitido: 0, cuerpoIlegible: 0 };
  const rango = { desde: null as string | null, hasta: null as string | null };
  const dias = new Set<string>();
  const t0 = Date.now();
  for (const f of ficheros) {
    console.error(`[por-clase] leyendo ${f.split("/").pop()} …`);
    await leer(f, estratos, todo, cuenta, extras, rango, dias);
    console.error(`[por-clase]   acumulado: ${todo.global.peticiones} peticiones (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }

  // La calibración del corpus entero, por modelo, ANTES de resumir las clases.
  const calibPorModelo = new Map<string, Acumulador["calibracion"]>(
    [...todo.porModelo.entries()].map(([m, a]) => [m, a.calibracion]),
  );
  for (const e of estratos.values()) prestarCalibracion(e, calibPorModelo);

  const global = resumirEstrato(todo);
  const nDias = dias.size;
  const porClase = [...estratos.entries()]
    .map(([c, e]) => [c, resumirEstrato(e)] as [Clase, Resumen])
    .sort((a, b) => b[1].dinero.salidaUsd - a[1].dinero.salidaUsd);
  const conTecho = porClase.map(([c, r]) => [c, r, techoDeClase(r, nDias)] as [Clase, Resumen, Techo]);

  const calibracionUsada = Object.fromEntries(
    [...calibPorModelo.entries()].map(([m, c]) => [
      m,
      {
        prosaCharsPorToken: c.prosaTokens > 0 ? Number((c.prosaChars / c.prosaTokens).toFixed(3)) : null,
        nProsa: c.nProsa,
        jsonCharsPorToken: c.jsonTokens > 0 ? Number((c.jsonChars / c.jsonTokens).toFixed(3)) : null,
        nJson: c.nJson,
      },
    ]),
  );

  const informe = {
    fecha: new Date().toISOString(),
    version: "salida-por-clase-v1",
    nota: [
      "TAXONOMÍA: el llamador (¿la petición declara `tools`?) × la familia de herramienta que DOMINA los caracteres de tool_use de la respuesta. Cada petición cae en una sola clase; `sin-cuerpo` es el residuo de respuestas sin cuerpo guardado. Las clases suman el total: lo verifica test/salida-por-clase.test.ts.",
      "DINERO: reparto calibrado (chars/token medidos por tipo) sumado por (clase × modelo), nunca en agregado — el texto vive en el modelo barato y el JSON en el caro. El ratio chars/token se mide POR MODELO sobre el corpus entero y se presta a sus clases: medido dentro de una clase estrecha no hay muestra (agente-shell tiene 2 respuestas de prosa pura). Descriptivo: jamás base de comisión.",
      "TECHO: aritmética sobre la masa medida, NO una promesa de ahorro. `siRecortaTodo` incluye el JSON de tool_use, que en `agente-escritura` ES el fichero: recortarlo es escribir peor, no ahorrar.",
      "MIXTOS: `purezaFamiliaMedia` < 1 significa turnos que llaman a familias distintas a la vez; se clasifican por su masa mayor. Cuanto más baja, menos limpia es la clase.",
      "Solo cifras y nombres de herramienta: del contenido del corpus no sale nada.",
    ],
    capturas: ficheros.map((f) => f.split("/").pop()),
    rango,
    dias: nDias,
    descartes: cuenta,
    familias: POR_FAMILIA,
    calibracionPorModelo: calibracionUsada,
    global: {
      peticiones: global.peticiones,
      salidaUsd: global.dinero.salidaUsd,
      entradaUsd: global.dinero.entradaUsd,
      shareSalida: global.dinero.shareSalida,
      repartoCalibrado: global.dinero.porMasaCalibrado,
      shareRepartoCalibrado: global.dinero.shareDeSalidaPorMasaCalibrado,
    },
    porClase: Object.fromEntries(
      conTecho.map(([c, r, t]) => [
        c,
        {
          peticiones: r.peticiones,
          sharePeticiones: global.peticiones ? Number((r.peticiones / global.peticiones).toFixed(4)) : 0,
          shareSalidaUsd: global.dinero.salidaUsd ? Number((r.dinero.salidaUsd / global.dinero.salidaUsd).toFixed(4)) : 0,
          subagente: extras.subagente[c] ?? 0,
          mixtos: extras.mixtos[c] ?? 0,
          purezaFamiliaMedia: extras.purezaN[c] ? Number(((extras.purezaSuma[c] ?? 0) / extras.purezaN[c]!).toFixed(4)) : null,
          techo: t,
          resumen: r,
        },
      ]),
    ),
    maxTokensInternos: extras.maxTokensInternos,
    bashOrdenOCarga: {
      ...extras.bash,
      shareHeredoc: extras.bash.chars > 0 ? Number((extras.bash.charsHeredoc / extras.bash.chars).toFixed(4)) : 0,
      charsPorComando: extras.bash.comandos > 0 ? Math.round(extras.bash.chars / extras.bash.comandos) : 0,
      nota: "chars del `command` de cada llamada a Bash en turnos agente-shell, y cuántos caen dentro del cuerpo de un heredoc (contenido de fichero viajando dentro de la orden). Recortar la ORDEN es posible; recortar el CUERPO es escribir peor.",
    },
  };

  const parcial = process.argv.slice(2).length ? "-parcial" : "";
  const salida = join("benchmarks", "out", `salida-por-clase-${new Date().toISOString().slice(0, 10)}${parcial}.json`);
  mkdirSync(join("benchmarks", "out"), { recursive: true });
  writeFileSync(salida, JSON.stringify(informe, null, 2));

  console.error("");
  console.error(tabla(conTecho, global.dinero.salidaUsd));
  console.error("");
  console.error(`[por-clase] ${nDias} días · salida $${global.dinero.salidaUsd.toFixed(2)} de $${(global.dinero.salidaUsd + global.dinero.entradaUsd).toFixed(2)} (${(global.dinero.shareSalida * 100).toFixed(1)} %)`);
  console.error(`[por-clase] descartes: ${JSON.stringify(cuenta)}`);
  console.error(`[por-clase] artefacto: ${salida}`);
}

// Solo corre como script; importado (tests) no toca disco.
if (process.argv[1]?.endsWith("por-clase.ts")) {
  main().catch((e) => {
    console.error("[por-clase] error:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
