/**
 * Descarga, verificación y lectura de los conjuntos públicos del banco de
 * precisión de la caché semántica. Todo va a `benchmarks/out/cache-semantica/datos/`,
 * que git ignora: los datos NO se redistribuyen desde este repositorio.
 *
 * Reglas: se baja SIEMPRE la revisión fijada en `fuentes.ts`; lo que no casa
 * con su huella aborta (no se mide sobre un fichero que no es el citado); y al
 * leer se vuelve a comprobar, para que un fichero tocado a mano después de la
 * descarga tampoco pase.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FUENTE_BASELINE_JEV,
  FUENTE_CASOS,
  FUENTE_ETIQUETAS,
  FUENTE_LMARENA,
  type Fuente,
} from "./fuentes.js";

export const DIR_SALIDA = fileURLToPath(new URL("../out/cache-semantica/", import.meta.url));
export const DIR_DATOS = join(DIR_SALIDA, "datos");

export function sha256Hex(datos: Uint8Array | string): string {
  return createHash("sha256").update(datos).digest("hex");
}

/** Ruta local de un fichero de las tripletas (por su nombre en la URL). */
export function rutaTripletas(dir: string, fuente: Fuente): string {
  return join(dir, "gptcache", fuente.url.split("/").pop()!);
}

/** Baja un fichero pequeño fijado por sha256 y aborta si no casa. */
export async function descargarVerificado(
  fuente: Fuente,
  destino: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!fuente.sha256) throw new Error(`${fuente.id}: no pinned sha256; refusing to download an unverifiable file`);
  const res = await fetchImpl(fuente.url);
  if (!res.ok) throw new Error(`${fuente.id}: HTTP ${res.status} from ${fuente.url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha = sha256Hex(bytes);
  if (sha !== fuente.sha256) {
    throw new Error(`${fuente.id}: sha256 mismatch (got ${sha}, pinned ${fuente.sha256}); aborting`);
  }
  if (bytes.byteLength !== fuente.bytes) {
    throw new Error(`${fuente.id}: size mismatch (got ${bytes.byteLength}, pinned ${fuente.bytes}); aborting`);
  }
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, bytes);
}

export async function descargarTripletas(dir = DIR_DATOS, fetchImpl: typeof fetch = fetch): Promise<void> {
  for (const f of [FUENTE_CASOS, FUENTE_ETIQUETAS, FUENTE_BASELINE_JEV]) {
    await descargarVerificado(f, rutaTripletas(dir, f), fetchImpl);
  }
}

// ─── SemBenchmarkLmArena ────────────────────────────────────────────────────
//
// El parquet pesa 6,6 GB en UN solo row group. Se lee por rangos HTTP con
// hyparquet y solo las tres columnas que hacen falta (`id`, `prompt`, `ID_Set`,
// todas SNAPPY, que hyparquet descomprime sin dependencias). La API `rows` de
// datasets-server no permite fijar revisión ni elegir columnas, por eso no se usa.
//
// El fichero no se baja entero, así que su sha256 no se puede recalcular aquí:
// se fija el oid LFS en `fuentes.ts` y se COMPRUEBA contra lo que declara el
// propio hub en la redirección (`x-linked-etag`, `x-linked-size`, y el commit en
// `x-repo-commit`), además del tamaño exacto y el número de filas de los
// metadatos. Lo que sí se hashea es el JSONL extraído, y ese sha256 viaja en el
// artefacto.

/** Lo que el hub declara del fichero fijado, sin seguir la redirección al CDN. */
export async function verificarHuellaLfs(fuente: Fuente = FUENTE_LMARENA, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!fuente.lfsOid) throw new Error(`${fuente.id}: no pinned LFS oid`);
  const res = await fetchImpl(fuente.url, { method: "HEAD", redirect: "manual" });
  const etag = res.headers.get("x-linked-etag")?.replace(/^W\//, "").replace(/"/g, "");
  const talla = res.headers.get("x-linked-size");
  const commit = res.headers.get("x-repo-commit");
  if (etag !== fuente.lfsOid) {
    throw new Error(`${fuente.id}: the hub reports LFS oid ${etag ?? "(none)"}, pinned ${fuente.lfsOid}; aborting`);
  }
  if (talla !== String(fuente.bytes)) {
    throw new Error(`${fuente.id}: the hub reports ${talla ?? "(no)"} bytes, pinned ${fuente.bytes}; aborting`);
  }
  if (commit != null && commit !== fuente.revision) {
    throw new Error(`${fuente.id}: the hub resolved revision ${commit}, pinned ${fuente.revision}; aborting`);
  }
}

export interface FilaLmArena {
  id: number;
  prompt: string;
  idSet: number;
}

export interface Extraccion {
  fuente: string;
  revision: string;
  bytesParquet: number;
  /** Oid LFS que declaró el hub, comprobado contra el fijado antes de leer. */
  lfsOid: string;
  filas: number;
  sha256: string;
}

const RUTA_LMARENA = (dir: string) => join(dir, "lmarena", "prompts.jsonl");
const RUTA_EXTRACCION = (dir: string) => join(dir, "lmarena", "extraccion.json");

export async function extraerLmArena(dir = DIR_DATOS): Promise<Extraccion> {
  const { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } = await import("hyparquet");
  await verificarHuellaLfs();
  const file = await asyncBufferFromUrl({ url: FUENTE_LMARENA.url });
  if (file.byteLength !== FUENTE_LMARENA.bytes) {
    throw new Error(
      `${FUENTE_LMARENA.id}: size ${file.byteLength} != pinned ${FUENTE_LMARENA.bytes}; not the pinned revision, aborting`,
    );
  }
  const meta = await parquetMetadataAsync(file);
  if (Number(meta.num_rows) !== FUENTE_LMARENA.filas) {
    throw new Error(`${FUENTE_LMARENA.id}: ${meta.num_rows} rows != pinned ${FUENTE_LMARENA.filas}; aborting`);
  }
  const filas = await parquetReadObjects({ file, columns: ["id", "prompt", "ID_Set"] });
  const jsonl = filas
    .map((r) => JSON.stringify({ id: Number(r["id"]), prompt: String(r["prompt"]), idSet: Number(r["ID_Set"]) }))
    .join("\n");
  mkdirSync(join(dir, "lmarena"), { recursive: true });
  writeFileSync(RUTA_LMARENA(dir), jsonl);
  const extraccion: Extraccion = {
    fuente: FUENTE_LMARENA.id,
    revision: FUENTE_LMARENA.revision,
    bytesParquet: file.byteLength,
    lfsOid: FUENTE_LMARENA.lfsOid!,
    filas: filas.length,
    sha256: sha256Hex(jsonl),
  };
  writeFileSync(RUTA_EXTRACCION(dir), JSON.stringify(extraccion, null, 2));
  return extraccion;
}

/**
 * OPCIONAL (`--embebedor dataset:<col>`): los vectores precomputados de una
 * columna del parquet, por `id`. El parquet tiene un solo row group, así que
 * leer una columna de vectores transfiere del orden de 1 GB. No se persiste.
 */
export async function cargarVectoresLmArena(columna: string, n: number): Promise<Map<number, number[]>> {
  const { asyncBufferFromUrl, parquetReadObjects } = await import("hyparquet");
  await verificarHuellaLfs();
  const file = await asyncBufferFromUrl({ url: FUENTE_LMARENA.url });
  if (file.byteLength !== FUENTE_LMARENA.bytes) throw new Error(`${FUENTE_LMARENA.id}: not the pinned revision`);
  const filas = await parquetReadObjects({ file, columns: ["id", columna], rowStart: 0, rowEnd: n });
  const out = new Map<number, number[]>();
  for (const r of filas) {
    out.set(Number(r["id"]), vectorDeCelda(r[columna], columna));
  }
  return out;
}

/**
 * Una celda de vector tal como la entrega hyparquet. En la revisión fijada las
 * columnas `emb_*` son BYTE_ARRAY con el vector escrito como TEXTO JSON
 * («[-0.44, -0.77, …]»), y hyparquet las devuelve como cadena: el camino
 * `--embebedor dataset:<columna>` no llegaba a correr nunca porque solo
 * aceptaba arrays. Se aceptan las tres formas; cualquier otra cosa rompe.
 */
export function vectorDeCelda(v: unknown, columna: string): number[] {
  if (typeof v === "string") {
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "number")) return parsed as number[];
    throw new Error(`column ${columna} holds text that is not a JSON array of numbers`);
  }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v as ArrayLike<number>, Number);
  throw new Error(`column ${columna} is not a vector column`);
}

// ─── Lectura verificada ─────────────────────────────────────────────────────

export function leerJsonl<T>(ruta: string): T[] {
  return readFileSync(ruta, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

function leerVerificado(fuente: Fuente, dir: string): string {
  const ruta = rutaTripletas(dir, fuente);
  if (!existsSync(ruta)) {
    throw new Error(`${fuente.id}: missing ${ruta}. Run \`pnpm cache-semantica --descargar\` first.`);
  }
  const bytes = readFileSync(ruta);
  const sha = sha256Hex(bytes);
  if (sha !== fuente.sha256) throw new Error(`${fuente.id}: local file sha256 ${sha} != pinned ${fuente.sha256}`);
  return bytes.toString("utf8");
}

const jsonlDe = <T>(texto: string): T[] =>
  texto
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);

export function leerCasos<T>(dir = DIR_DATOS): T[] {
  return jsonlDe<T>(leerVerificado(FUENTE_CASOS, dir));
}
export function leerEtiquetas<T>(dir = DIR_DATOS): T[] {
  return jsonlDe<T>(leerVerificado(FUENTE_ETIQUETAS, dir));
}
export function leerBaselineJev<T>(dir = DIR_DATOS): T[] {
  return jsonlDe<T>(leerVerificado(FUENTE_BASELINE_JEV, dir));
}

export function hayTripletas(dir = DIR_DATOS): boolean {
  return [FUENTE_CASOS, FUENTE_ETIQUETAS, FUENTE_BASELINE_JEV].every((f) => existsSync(rutaTripletas(dir, f)));
}

export function hayLmArena(dir = DIR_DATOS): boolean {
  return existsSync(RUTA_LMARENA(dir)) && existsSync(RUTA_EXTRACCION(dir));
}

/** Las primeras `n` filas (0 = todas), en el orden de la revisión fijada. */
export function leerLmArena(dir = DIR_DATOS, n = 0): { filas: FilaLmArena[]; extraccion: Extraccion } {
  if (!hayLmArena(dir)) {
    throw new Error(`missing SemBenchmarkLmArena extraction in ${dir}. Run \`pnpm cache-semantica --descargar\` first.`);
  }
  const extraccion = JSON.parse(readFileSync(RUTA_EXTRACCION(dir), "utf8")) as Extraccion;
  const texto = readFileSync(RUTA_LMARENA(dir), "utf8");
  const sha = sha256Hex(texto);
  if (sha !== extraccion.sha256 || extraccion.revision !== FUENTE_LMARENA.revision) {
    throw new Error(`SemBenchmarkLmArena extraction does not match its record (sha ${sha}); re-run --descargar`);
  }
  const todas = jsonlDe<FilaLmArena>(texto);
  return { filas: n > 0 ? todas.slice(0, n) : todas, extraccion };
}
