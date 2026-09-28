/**
 * EL DATASET BFCL, FIJADO POR COMMIT Y POR SHA-256.
 * ---------------------------------------------------------------------------
 * Berkeley Function Calling Leaderboard (gorilla-llm), licencia Apache-2.0:
 * https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard
 *
 * El dataset NO se versiona en este repositorio: se descarga en tiempo de
 * ejecución desde `raw.githubusercontent.com` en el commit fijado y cada fichero
 * se comprueba contra su sha256. Un fichero que no casa aborta la tirada: una
 * batería pública que cambia bajo los pies no es la misma batería.
 *
 * El commit es el último que tocó `bfcl_eval/data` (2025-12-17, #1266) en el
 * momento de fijarlo (2026-09-28).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_BFCL = "ShishirPatil/gorilla";
export const COMMIT_BFCL = "f7cf7359b7ac615a0b294831c5ba2bc95ee4a000";
export const LICENCIA_BFCL = "Apache-2.0";
const RAIZ = `https://raw.githubusercontent.com/${REPO_BFCL}/${COMMIT_BFCL}/berkeley-function-call-leaderboard/bfcl_eval/data`;

export const CATEGORIAS_AST = ["simple", "multiple", "parallel", "parallel_multiple"] as const;
export type CategoriaAst = (typeof CATEGORIAS_AST)[number];

/** Ruta relativa a `bfcl_eval/data` → sha256 del fichero en `COMMIT_BFCL`. */
export const MANIFIESTO: Readonly<Record<string, string>> = {
  "BFCL_v4_simple_python.json": "82dd63ba502eb2520c6b5d1d9a5c4b590e03ff261565175561f6228a367d1991",
  "possible_answer/BFCL_v4_simple_python.json": "90cd5bc653690ee8e459b5b3f3fc9458606f7f3fcbf795bb51b7dc581f8c86dc",
  "BFCL_v4_multiple.json": "aef168155ebd74b7ac2401198b201343bc7d16d7a3d7e0d4e6d8ee82c6969b2a",
  "possible_answer/BFCL_v4_multiple.json": "244e00ce9395df948bcafc7bee64e8f9c87ef70887587d83cae45b13699f3047",
  "BFCL_v4_parallel.json": "19f51a82eff42e5d62541aa500115a056eb78f437c2ba1f10415fd7c8e5dda84",
  "possible_answer/BFCL_v4_parallel.json": "8a6aa19c1adddc6a5a2f7e40f9dbf30cc7e95815e7b830c90589ab318229e0f0",
  "BFCL_v4_parallel_multiple.json": "8863ea8433239f55c5f016154cf0830853c89f693c6ea270396a2fa121960579",
  "possible_answer/BFCL_v4_parallel_multiple.json": "5ebf24f458c1f16300c05505d83d6f0a1b68b79be273a033febd0d4f840507e3",
  "BFCL_v4_multi_turn_base.json": "1a21a995d06fd6f20ba55de7bced30ef953ec35e998f502ec2ecf4d66ef1c43a",
  "possible_answer/BFCL_v4_multi_turn_base.json": "1fee67823b317571649177dd89d63969feaae4e810cc7448ee55ba797fb7c8fc",
  "multi_turn_func_doc/gorilla_file_system.json": "c4c1b741c71e2a17c97a5dc9c4a91d89978c4eaece56494d14272d5df6c650e9",
  "multi_turn_func_doc/math_api.json": "83fa31708c89442bdcf12ac4dfbe3be8663ec9183a1b1524a9fda98164bc7e0b",
  "multi_turn_func_doc/message_api.json": "4d58ea933a5d2b280d7a52366617fb47fecd333d7b0e08e724db6fa12fb5f847",
  "multi_turn_func_doc/posting_api.json": "87f9fc404a06e4107d7c366f1399c596440e84c16cb119faf374b2f532d86e8b",
  "multi_turn_func_doc/ticket_api.json": "31324e0380782664fe82ba05bd23517808ad55692b45a5fe7c3d4d395fe4f0f8",
  "multi_turn_func_doc/trading_bot.json": "1a7933fd8f0cb8fbec38aeae05cb8c24132747cad4904fe1c13ac3d01fc22c2d",
  "multi_turn_func_doc/travel_booking.json": "f17b950c13adddf41d0848077df58788252e4c2e7cad5cfa71c8c4bf04f57b26",
  "multi_turn_func_doc/vehicle_control.json": "0c8a66292844874ef7b168f343bc394d8615d2d9e1f4387999a9ee23011eac78",
};

const FICHERO_DE_CATEGORIA: Record<CategoriaAst, string> = {
  simple: "BFCL_v4_simple_python.json",
  multiple: "BFCL_v4_multiple.json",
  parallel: "BFCL_v4_parallel.json",
  parallel_multiple: "BFCL_v4_parallel_multiple.json",
};

/** Clase de la API multi-turn → fichero de documentación (el mismo mapeo que `bfcl_eval`). */
export const DOC_DE_CLASE: Readonly<Record<string, string>> = {
  GorillaFileSystem: "gorilla_file_system.json",
  MathAPI: "math_api.json",
  MessageAPI: "message_api.json",
  TwitterAPI: "posting_api.json",
  TicketAPI: "ticket_api.json",
  TradingBot: "trading_bot.json",
  TravelAPI: "travel_booking.json",
  VehicleControlAPI: "vehicle_control.json",
};

/** Documentación de una función tal como la trae BFCL (tipos "dict", "float", "tuple", "any"). */
export interface FuncionBfcl {
  name: string;
  description: string;
  parameters: { type: string; properties: Record<string, ParametroBfcl>; required?: string[] };
}
export interface ParametroBfcl {
  type?: string;
  description?: string;
  items?: ParametroBfcl;
  properties?: Record<string, ParametroBfcl>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  [k: string]: unknown;
}

export interface EntradaAst {
  id: string;
  categoria: CategoriaAst;
  pregunta: { role: string; content: string }[];
  funciones: FuncionBfcl[];
  /** `possible_answer`: una lista de llamadas; cada una {nombre: {param: [valores admitidos]}}. */
  respuesta: Record<string, Record<string, unknown[]>>[];
}

export interface EntradaMultiTurno {
  id: string;
  turnos: { role: string; content: string }[][];
  clases: string[];
  excluidas: string[];
  funciones: FuncionBfcl[];
  /** Llamadas de referencia por turno, en la sintaxis Python de BFCL (solo informativas aquí). */
  referencia: string[][];
}

const AQUI = dirname(fileURLToPath(import.meta.url));
export const DIR_CACHE = join(AQUI, ".cache", COMMIT_BFCL.slice(0, 12));

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * El contenido verificado de un fichero del manifiesto: de la caché local si ya
 * está (y vuelve a comprobarse su hash), si no, descargado. `descargar: false`
 * (las verjas, el --mock sin red) exige que ya esté en caché.
 */
export async function ficheroVerificado(ruta: string, opts: { descargar: boolean; fetchImpl?: typeof fetch }): Promise<string> {
  const esperado = MANIFIESTO[ruta];
  if (!esperado) throw new Error(`BFCL: ${ruta} no está en el manifiesto`);
  const local = join(DIR_CACHE, ruta);
  let buf: Buffer | null = existsSync(local) ? readFileSync(local) : null;
  if (!buf) {
    if (!opts.descargar) throw new Error(`BFCL: ${ruta} no está en caché y la tirada no descarga (ejecútala una vez con red)`);
    const r = await (opts.fetchImpl ?? fetch)(`${RAIZ}/${ruta}`);
    if (!r.ok) throw new Error(`BFCL: descarga de ${ruta} → HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  }
  const real = sha256(buf);
  if (real !== esperado) throw new Error(`BFCL: sha256 de ${ruta} no casa (esperado ${esperado}, obtenido ${real})`);
  if (!existsSync(local)) {
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, buf);
  }
  return buf.toString("utf8");
}

export function lineasJson<T>(texto: string): T[] {
  return texto
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

interface CrudaAst {
  id: string;
  question: { role: string; content: string }[][];
  function: FuncionBfcl[];
}

/** Las entradas de una categoría AST, emparejadas con su `possible_answer` por id. */
export async function cargarCategoria(cat: CategoriaAst, opts: { descargar: boolean }): Promise<EntradaAst[]> {
  const f = FICHERO_DE_CATEGORIA[cat];
  const preguntas = lineasJson<CrudaAst>(await ficheroVerificado(f, opts));
  const respuestas = new Map(
    lineasJson<{ id: string; ground_truth: EntradaAst["respuesta"] }>(await ficheroVerificado(`possible_answer/${f}`, opts)).map((r) => [
      r.id,
      r.ground_truth,
    ]),
  );
  return preguntas.map((p) => {
    const respuesta = respuestas.get(p.id);
    if (!respuesta) throw new Error(`BFCL: ${p.id} sin possible_answer`);
    // Las AST de estas cuatro categorías son de un solo turno.
    return { id: p.id, categoria: cat, pregunta: p.question[0] ?? [], funciones: p.function, respuesta };
  });
}

export async function cargarMultiTurno(opts: { descargar: boolean }): Promise<EntradaMultiTurno[]> {
  const crudas = lineasJson<{
    id: string;
    question: { role: string; content: string }[][];
    involved_classes: string[];
    excluded_function?: string[];
  }>(await ficheroVerificado("BFCL_v4_multi_turn_base.json", opts));
  const referencia = new Map(
    lineasJson<{ id: string; ground_truth: string[][] }>(
      await ficheroVerificado("possible_answer/BFCL_v4_multi_turn_base.json", opts),
    ).map((r) => [r.id, r.ground_truth]),
  );
  const docs = new Map<string, FuncionBfcl[]>();
  for (const [clase, fichero] of Object.entries(DOC_DE_CLASE)) {
    docs.set(clase, lineasJson<FuncionBfcl>(await ficheroVerificado(`multi_turn_func_doc/${fichero}`, opts)));
  }
  return crudas.map((c) => {
    const excluidas = c.excluded_function ?? [];
    const funciones = c.involved_classes.flatMap((cl) => docs.get(cl) ?? []).filter((f) => !excluidas.includes(f.name));
    return {
      id: c.id,
      turnos: c.question,
      clases: c.involved_classes,
      excluidas,
      funciones,
      referencia: referencia.get(c.id) ?? [],
    };
  });
}

/** Todos los ficheros del manifiesto, descargados y verificados. */
export async function prepararDataset(opts: { descargar: boolean }): Promise<void> {
  for (const ruta of Object.keys(MANIFIESTO)) await ficheroVerificado(ruta, opts);
}
