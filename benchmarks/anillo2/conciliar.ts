/**
 * ANILLO 2 · CONCILIAR — el lector STREAMING de la conciliación diaria
 * transcript↔espía (núcleo puro en conciliacion.ts).
 *
 * Lee dos fuentes y las reduce a ids, timestamps, modelo, usage y nombre de
 * proyecto en cuanto las toca:
 * - Transcripts de Claude Code: ~/.claude/projects/**\/*.jsonl (recursivo:
 *   los subagentes viven en <sessionId>/subagents/*.jsonl). Solo entran las
 *   líneas con "type":"assistant" y "requestId" (prefiltro por substring
 *   ANTES de JSON.parse: la mayoría de las líneas son usuario/tool_result y
 *   no hay por qué parsearlas), y de ellas solo los campos del tipo — NADA
 *   de `message.content`.
 * - Capturas del espía: ~/.bvsala-f0/captura-*.jsonl. La viva pesa gigabytes:
 *   readline línea a línea, prefiltro por '"at":"<día>' (que va al principio
 *   de la línea) y por path /v1/messages antes de parsear. Solo se extraen
 *   at, path, request-id de responseHeaders, x-claude-code-session-id y
 *   status.
 * VERJA DE FORMA: cada id/timestamp/modelo/versión que cruza al artefacto
 * tiene que casar con la forma que Claude Code escribe hoy (uuid, req_…, ISO
 * Z, nombre de modelo, semver); lo que no casa se cuenta en `formaRara` y no
 * sale — el único muro entre «id» y «cualquier string» no puede ser un
 * typeof.
 *
 * Ventana: se leen el día pedido y sus vecinos (±1) — una respuesta que
 * cruza la medianoche o un transcript escrito con retraso no se pierden; el
 * núcleo decide qué cuenta. Los ficheros con mtime anterior a la ventana no
 * pueden contener nada del día y se saltan sin abrirlos.
 *
 * Uso:  pnpm anillo2:conciliar [--dia YYYY-MM-DD] [--proyectos DIR] [--capturas DIR]
 *       (por defecto: hoy UTC, ~/.claude/projects, ~/.bvsala-f0)
 * Salida: benchmarks/out/anillo2-conciliacion-<día>.json + resumen por stderr.
 */
import { createReadStream, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { createInterface } from "node:readline";

import type { UsoSse } from "../../gateway/medidor.js";
import { FORMA, MODELO_SINTETICO, conciliar, type TurnoTranscript, type VistoEnEspia } from "./conciliacion.js";
import { diaDe } from "./nucleo.js";

interface Args {
  dia: string;
  proyectos: string;
  capturas: string;
}

function leerArgs(argv: string[]): Args {
  const args: Args = {
    dia: new Date().toISOString().slice(0, 10),
    proyectos: join(homedir(), ".claude", "projects"),
    capturas: join(homedir(), ".bvsala-f0"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    if (a === "--dia" && v) {
      if (!diaDe(v) || v.length !== 10) throw new Error(`--dia debe ser YYYY-MM-DD, no «${v}»`);
      args.dia = v;
      i++;
    } else if (a === "--proyectos" && v) {
      args.proyectos = v;
      i++;
    } else if (a === "--capturas" && v) {
      args.capturas = v;
      i++;
    } else {
      throw new Error(`argumento desconocido: ${a}`);
    }
  }
  return args;
}

/** El día pedido y sus vecinos, como strings YYYY-MM-DD. */
function ventana(dia: string): string[] {
  const t0 = Date.parse(`${dia}T00:00:00Z`);
  return [-1, 0, 1].map((d) => new Date(t0 + d * 86_400_000).toISOString().slice(0, 10));
}

/** Todos los *.jsonl bajo un directorio, recursivo y en orden estable. */
function ficherosJsonl(dir: string, salida: string[] = []): string[] {
  let entradas: import("node:fs").Dirent[];
  try {
    entradas = readdirSync(dir, { withFileTypes: true });
  } catch {
    return salida;
  }
  for (const e of entradas.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) ficherosJsonl(ruta, salida);
    else if (e.isFile() && e.name.endsWith(".jsonl")) salida.push(ruta);
  }
  return salida;
}

/** Solo los campos numéricos del usage: nada más cruza. */
function usageLimpio(u: unknown): UsoSse | undefined {
  if (u === null || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : undefined);
  const uso: UsoSse = {};
  if (n("input_tokens") !== undefined) uso.input_tokens = n("input_tokens");
  if (n("output_tokens") !== undefined) uso.output_tokens = n("output_tokens");
  if (n("cache_read_input_tokens") !== undefined) uso.cache_read_input_tokens = n("cache_read_input_tokens");
  if (n("cache_creation_input_tokens") !== undefined) uso.cache_creation_input_tokens = n("cache_creation_input_tokens");
  const cc = o["cache_creation"];
  if (cc !== null && typeof cc === "object") {
    const c = cc as Record<string, unknown>;
    uso.cache_creation = {};
    if (typeof c["ephemeral_5m_input_tokens"] === "number") uso.cache_creation.ephemeral_5m_input_tokens = c["ephemeral_5m_input_tokens"];
    if (typeof c["ephemeral_1h_input_tokens"] === "number") uso.cache_creation.ephemeral_1h_input_tokens = c["ephemeral_1h_input_tokens"];
  }
  return Object.keys(uso).length ? uso : undefined;
}

interface DescartesTranscript {
  ficheros: number;
  ficherosSaltados: number;
  lineas: number;
  ilegibles: number;
  sinRequestId: number;
  sinteticos: number;
  sinSesion: number;
  /** id/timestamp/modelo con una forma que Claude Code no escribe: fuera (verja de privacidad). */
  formaRara: number;
}

async function leerTranscript(ruta: string, dias: string[], turnos: TurnoTranscript[], c: DescartesTranscript): Promise<void> {
  const subagenteFichero = ruta.includes(`${sep}subagents${sep}`);
  const rl = createInterface({ input: createReadStream(ruta), crlfDelay: Infinity });
  for await (const linea of rl) {
    if (!linea) continue;
    c.lineas += 1;
    // Prefiltro por substring ANTES de parsear: la mayoría de las líneas no
    // son de la API, y las que sí lo son pero caen fuera de la ventana tampoco.
    if (!linea.includes('"type":"assistant"') || !linea.includes('"requestId"')) continue;
    if (!dias.some((d) => linea.includes(`"timestamp":"${d}`))) continue;
    let o: {
      type?: unknown;
      requestId?: unknown;
      sessionId?: unknown;
      timestamp?: unknown;
      cwd?: unknown;
      version?: unknown;
      isSidechain?: unknown;
      message?: { model?: unknown; usage?: unknown };
    };
    try {
      o = JSON.parse(linea) as typeof o;
    } catch {
      c.ilegibles += 1;
      continue;
    }
    if (o.type !== "assistant") continue;
    if (typeof o.requestId !== "string" || !o.requestId) {
      c.sinRequestId += 1;
      continue;
    }
    const model = typeof o.message?.model === "string" ? o.message.model : "?";
    if (model === MODELO_SINTETICO) {
      c.sinteticos += 1;
      continue;
    }
    if (typeof o.sessionId !== "string" || typeof o.timestamp !== "string") {
      c.sinSesion += 1;
      continue;
    }
    if (!dias.includes(diaDe(o.timestamp) ?? "")) continue;
    if (
      !FORMA.sessionId.test(o.sessionId) ||
      !FORMA.requestId.test(o.requestId) ||
      !FORMA.timestamp.test(o.timestamp) ||
      !FORMA.model.test(model)
    ) {
      c.formaRara += 1;
      continue;
    }
    turnos.push({
      sessionId: o.sessionId,
      requestId: o.requestId,
      timestamp: o.timestamp,
      model,
      proyecto: typeof o.cwd === "string" && o.cwd ? basename(o.cwd) : "?",
      subagente: o.isSidechain === true || subagenteFichero,
      usage: usageLimpio(o.message?.usage),
      version: typeof o.version === "string" && FORMA.version.test(o.version) ? o.version : undefined,
    });
  }
}

interface DescartesCaptura {
  ficheros: number;
  ficherosSaltados: number;
  lineas: number;
  ilegibles: number;
  sinRequestId: number;
  otrosPaths: number;
}

async function leerCaptura(ruta: string, dias: string[], vistos: VistoEnEspia[], c: DescartesCaptura): Promise<void> {
  const rl = createInterface({ input: createReadStream(ruta), crlfDelay: Infinity });
  for await (const linea of rl) {
    if (!linea) continue;
    c.lineas += 1;
    // "at" va al principio de la línea: el prefiltro por día es barato y evita
    // parsear los megabytes de cuerpo de todo lo que no es de la ventana.
    if (!dias.some((d) => linea.includes(`"at":"${d}`))) continue;
    if (!linea.includes('"path":"/v1/messages"')) {
      c.otrosPaths += 1;
      continue;
    }
    let o: {
      at?: unknown;
      method?: unknown;
      path?: unknown;
      status?: unknown;
      requestHeaders?: Record<string, unknown>;
      responseHeaders?: Record<string, unknown>;
    };
    try {
      o = JSON.parse(linea) as typeof o;
    } catch {
      c.ilegibles += 1;
      continue;
    }
    if (o.path !== "/v1/messages" || o.method !== "POST" || typeof o.at !== "string") {
      c.otrosPaths += 1;
      continue;
    }
    const rid = o.responseHeaders?.["request-id"];
    if (typeof rid !== "string" || !rid) {
      c.sinRequestId += 1;
      continue;
    }
    const sid = o.requestHeaders?.["x-claude-code-session-id"];
    vistos.push({
      requestId: rid,
      at: o.at,
      sesionCabecera: typeof sid === "string" && sid ? sid : undefined,
      status: typeof o.status === "number" ? o.status : undefined,
    });
  }
}

async function main() {
  const args = leerArgs(process.argv.slice(2));
  const dias = ventana(args.dia);
  const desdeMs = Date.parse(`${dias[0]}T00:00:00Z`);
  const noEsViejo = (ruta: string) => statSync(ruta).mtimeMs >= desdeMs;

  const turnos: TurnoTranscript[] = [];
  const dt: DescartesTranscript = {
    ficheros: 0,
    ficherosSaltados: 0,
    lineas: 0,
    ilegibles: 0,
    sinRequestId: 0,
    sinteticos: 0,
    sinSesion: 0,
    formaRara: 0,
  };
  const transcripts = ficherosJsonl(args.proyectos);
  console.error(`[conciliar] día ${args.dia} (ventana ${dias[0]}…${dias[2]}) · ${transcripts.length} transcripts en ${args.proyectos}`);
  for (const f of transcripts) {
    if (!noEsViejo(f)) {
      dt.ficherosSaltados += 1;
      continue;
    }
    dt.ficheros += 1;
    await leerTranscript(f, dias, turnos, dt);
  }
  console.error(`[conciliar] transcripts: ${dt.ficheros} leídos (${dt.ficherosSaltados} sin tocar por mtime), ${turnos.length} líneas de API en ventana`);

  const vistos: VistoEnEspia[] = [];
  const dc: DescartesCaptura = { ficheros: 0, ficherosSaltados: 0, lineas: 0, ilegibles: 0, sinRequestId: 0, otrosPaths: 0 };
  let capturas: string[] = [];
  try {
    capturas = readdirSync(args.capturas)
      .filter((f) => f.startsWith("captura-") && f.endsWith(".jsonl"))
      .sort()
      .map((f) => join(args.capturas, f));
  } catch {
    console.error(`[conciliar] sin directorio de capturas ${args.capturas}: el espía se trata como vacío`);
  }
  for (const f of capturas) {
    if (!noEsViejo(f)) {
      dc.ficherosSaltados += 1;
      continue;
    }
    dc.ficheros += 1;
    const mb = Math.round(statSync(f).size / 1e6);
    console.error(`[conciliar] leyendo ${basename(f)} (${mb} MB) …`);
    await leerCaptura(f, dias, vistos, dc);
  }
  console.error(`[conciliar] capturas: ${dc.ficheros} leídas (${dc.ficherosSaltados} sin tocar por mtime), ${vistos.length} respuestas /v1/messages en ventana`);

  const informe = conciliar(args.dia, turnos, vistos);

  for (const s of informe.porSesion) {
    console.error(
      `[conciliar] ${s.estado.padEnd(14)} ${s.sessionId} (${s.proyecto}) turnos=${s.turnos} vistos=${s.vistos} fugas=${s.fugas} laterales=${s.laterales} $fuera=${s.dineroFueraUsd} $total=${s.dineroTotalUsd}`,
    );
  }
  const g = informe.global;
  console.error(
    `[conciliar] GLOBAL ${g.dia}: ${g.sesiones} sesiones, ${g.turnos} turnos, ${g.vistos} vistos, ${g.fugas} fugas (${g.pctTurnosFuera} %), $${g.dineroFueraUsd} fuera de $${g.dineroTotalUsd}; laterales sin transcript ${g.lateralesSinTranscript} (huérfanos ${g.lateralesHuerfanos}, con error ${g.lateralesConError})`,
  );
  for (const f of g.fisuras) console.error(`[conciliar] FISURA: ${f}`);
  if (!g.fisuras.length) console.error(`[conciliar] día COMPLETO: todas las sesiones encadenadas, 0 fugas`);

  const salida = join("benchmarks", "out", `anillo2-conciliacion-${args.dia}.json`);
  mkdirSync(join("benchmarks", "out"), { recursive: true });
  writeFileSync(
    salida,
    JSON.stringify(
      {
        fecha: new Date().toISOString(),
        // Rutas relativas al home: el artefacto se pega en PRs e informes y no
        // tiene por qué llevar el usuario de la máquina.
        fuentes: { proyectos: sinHome(args.proyectos), capturas: sinHome(args.capturas), ventana: dias },
        descartes: { transcripts: dt, capturas: dc },
        ...informe,
      },
      null,
      2,
    ),
  );
  console.error(`[conciliar] artefacto: ${salida}`);
}

const sinHome = (p: string): string => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

main().catch((e) => {
  console.error("[conciliar] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
