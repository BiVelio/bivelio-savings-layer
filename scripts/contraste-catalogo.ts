/**
 * E4 · EL CONTRASTE DEL CATÁLOGO — `pnpm catalogo:contraste`.
 *
 * Compara los precios con los que BV-SALA mide y factura (src/pricing/: la fila
 * de CATALOGO del día, las primas de escritura de caché y las tarifas de tier)
 * con la tabla pública de LiteLLM (`model_prices_and_context_window.json`,
 * BerriAI/litellm, licencia MIT) FIJADA a un commit, y lista cada discrepancia
 * como ALARMA.
 *
 * DOCTRINA (la del vigía de precios de 2026-08-23, retirado el 2026-09-28 porque
 * este contraste compara todo lo que él comparaba y más): la tabla de
 * LiteLLM es una ALARMA, nunca una fuente. Este script no escribe en
 * src/pricing/ ni propone líneas para pegar: una discrepancia se resuelve
 * leyendo la página OFICIAL del proveedor, y lo que esa página diga queda
 * anotado en REVISADAS con su URL y su fecha. Si nos da la razón a nosotros, la
 * alarma se apaga mientras LiteLLM siga diciendo lo mismo; si se la da a ellos,
 * se corrige el catálogo, a mano, en su propio commit y con su fuente.
 *
 * Qué se compara, por fila del catálogo (todo modelo al que ponemos precio, que
 * es todo lo que podemos medir y facturar), en USD por 1K tokens:
 *   · estándar: entrada, salida, lectura de caché, escritura de caché a 5 min
 *     (`entrada × primaDeEscritura`) y, en Anthropic, a 1 h;
 *   · cada tier de TARIFAS_DE_TIER vigente ese día (flex, batch…), contra los
 *     campos `_flex` / `_batches` / `_priority` de LiteLLM.
 * Contra la entrada de LiteLLM del MISMO proveedor (`litellm_provider`
 * openai / anthropic / gemini): la de Vertex o Azure con el mismo nombre puede
 * tener otro precio y no es la factura de quien habla con el API del proveedor.
 *
 * Uso:
 *   pnpm catalogo:contraste                        # contra el commit fijado
 *   pnpm catalogo:contraste --commit main          # contra el último de main (lo resuelve y lo anota)
 *   pnpm catalogo:contraste --fichero <json>       # contra un fichero local, sin red
 *   pnpm catalogo:contraste --guardar              # benchmarks/evidencia/contraste-catalogo-<día>.json
 *   pnpm catalogo:contraste --salida <ruta.json>   # el informe donde se diga (el artefacto del workflow)
 *   pnpm catalogo:contraste --estricto             # sale con 1 si hay alarmas sin revisar
 *   pnpm catalogo:contraste --dia 2026-09-27       # el precio del catálogo en ese día
 *
 * La única red: raw.githubusercontent.com (la tabla) y, con `--commit main`,
 * api.github.com (qué commit es main). Nada más, y ninguna credencial.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { esElPrincipal } from "../benchmarks/latencia-gateways/nucleo.js";
import { CATALOGO, PRECIOS_AL_DIA, diaUtc, precioDeLista } from "../src/pricing/catalogo.js";
import { primaDeEscritura, primaDeEscritura1h } from "../src/pricing/primas.js";
import {
  TARIFAS_DE_TIER,
  TARIFAS_DE_TIER_AL_DIA,
  familiaDeTarifa,
  type OrigenDeTarifa,
  type TarifaDeTier,
} from "../src/pricing/tarifas-de-tier.js";

// ── La referencia fijada ───────────────────────────────────────────────────

export const REPOSITORIO_LITELLM = "BerriAI/litellm";
export const RUTA_TABLA_LITELLM = "model_prices_and_context_window.json";
/**
 * El commit de `main` de LiteLLM con el último cambio de la tabla el
 * 2026-09-27 (16:14 UTC, «update azure_ai/grok-4.6 input price…», #43446), y la
 * suma sha256 del fichero en ese commit. La 1.102.1 del experimento E6 es la
 * etiqueta `v1.102.1` (d09bbae1…), cuatro días anterior.
 */
export const COMMIT_FIJADO = "22b36cbcf6583e2d6b552cc0e87ae6ab82c46341";
export const SHA256_FIJADO = "71c2cd53d220c973d83bd78c805f147f212e1e0d978de85633f0d32acba7f3c6";

export const urlDeLaTabla = (commit: string): string =>
  `https://raw.githubusercontent.com/${REPOSITORIO_LITELLM}/${commit}/${RUTA_TABLA_LITELLM}`;

// ── Lo nuestro ─────────────────────────────────────────────────────────────

export type Campo = "entrada" | "salida" | "lectura" | "escritura" | "escritura1h";
export type Tramo = "estandar" | "flex" | "batch" | "priority";
export const CAMPOS: readonly Campo[] = ["entrada", "salida", "lectura", "escritura", "escritura1h"];

/** Precios comparables, en USD por 1K tokens. Un campo ausente es «no publicado». */
export type PrecioComparable = Partial<Record<Campo, number>>;

export interface FilaPropia {
  /** Clave de CATALOGO. */
  clave: string;
  origen: OrigenDeTarifa;
  tramo: Tramo;
  precio: PrecioComparable;
  /** De dónde sale cada cifra nuestra. */
  deDonde: string;
}

/**
 * Nuestras filas comparables el día `dia` (AAAA-MM-DD): una estándar por clave
 * de CATALOGO con precio ese día, y una por cada tier vigente de
 * TARIFAS_DE_TIER. Las claves sin familia de proveedor conocida no se comparan.
 */
export function filasPropias(dia: string): FilaPropia[] {
  const instante = Date.parse(`${dia}T12:00:00Z`);
  const out: FilaPropia[] = [];
  for (const clave of Object.keys(CATALOGO).sort()) {
    const origen = familiaDeTarifa(clave);
    const p = precioDeLista(clave, instante);
    if (!origen || !p) continue;
    const precio: PrecioComparable = {
      entrada: p.inputPer1k,
      salida: p.outputPer1k,
      escritura: p.inputPer1k * primaDeEscritura(clave),
    };
    if (p.cachedInputPer1k !== undefined) precio.lectura = p.cachedInputPer1k;
    // El TTL de 1 h solo existe en Anthropic (primas.ts): en los demás la función
    // devuelve la prima normal y no hay nada nuevo que comparar.
    if (origen === "anthropic") precio.escritura1h = p.inputPer1k * primaDeEscritura1h(clave);
    out.push({ clave, origen, tramo: "estandar", precio, deDonde: `src/pricing/catalogo.ts (PRECIOS_AL_DIA ${PRECIOS_AL_DIA}) + primas.ts` });
  }
  for (const origen of Object.keys(TARIFAS_DE_TIER) as OrigenDeTarifa[]) {
    for (const [tier, filas] of Object.entries(TARIFAS_DE_TIER[origen])) {
      const tramo = tramoDeTier(tier);
      if (!tramo) continue;
      for (const [clave, f] of Object.entries(filas as Readonly<Record<string, TarifaDeTier>>)) {
        if (f.vigenteHasta && dia > f.vigenteHasta) continue;
        const precio: PrecioComparable = { entrada: f.inputPer1k, salida: f.outputPer1k };
        if (f.cachedInputPer1k !== undefined) precio.lectura = f.cachedInputPer1k;
        if (f.cacheWritePer1k !== undefined) precio.escritura = f.cacheWritePer1k;
        out.push({ clave, origen, tramo, precio, deDonde: `src/pricing/tarifas-de-tier.ts (${f.fuente}, leída ${f.consultado})` });
      }
    }
  }
  return out;
}

function tramoDeTier(tier: string): Tramo | null {
  if (tier === "flex" || tier === "batch" || tier === "priority") return tier;
  return null;
}

// ── Lo suyo ────────────────────────────────────────────────────────────────

/** `litellm_provider` de la entrada que corresponde al API de cada proveedor. */
const PROVEEDOR_LITELLM: Readonly<Record<OrigenDeTarifa, { proveedor: string; prefijo: string }>> = {
  openai: { proveedor: "openai", prefijo: "openai" },
  anthropic: { proveedor: "anthropic", prefijo: "anthropic" },
  google: { proveedor: "gemini", prefijo: "gemini" },
};

export type TablaLiteLLM = Readonly<Record<string, unknown>>;

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * La entrada de LiteLLM para una clave nuestra: la clave tal cual o con el
 * prefijo del proveedor (`gemini/…`), y si no, su instantánea con fecha más
 * reciente (`claude-3-opus-20240229`). Siempre del MISMO proveedor.
 */
export function buscarEnLiteLLM(
  tabla: TablaLiteLLM,
  clave: string,
  origen: OrigenDeTarifa,
): { clave: string; datos: Record<string, unknown> } | null {
  const { proveedor, prefijo } = PROVEEDOR_LITELLM[origen];
  const delProveedor = (k: string): Record<string, unknown> | null => {
    const d = tabla[k];
    return esObjeto(d) && d["litellm_provider"] === proveedor ? d : null;
  };
  for (const k of [clave, `${prefijo}/${clave}`]) {
    const d = delProveedor(k);
    if (d) return { clave: k, datos: d };
  }
  const fechada = new RegExp(`^(?:${prefijo}/)?${clave.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d{8}|\\d{4}-\\d{2}-\\d{2})$`);
  const fecha = (k: string): string => (fechada.exec(k)?.[1] ?? "").replace(/-/g, "");
  const candidatas = Object.keys(tabla)
    .filter((k) => fechada.test(k) && delProveedor(k))
    .sort((a, b) => fecha(b).localeCompare(fecha(a)) || a.localeCompare(b));
  const k = candidatas[0];
  return k ? { clave: k, datos: delProveedor(k)! } : null;
}

const SUFIJO: Readonly<Record<Tramo, string>> = { estandar: "", flex: "_flex", batch: "_batches", priority: "_priority" };

/** Los precios de una entrada de LiteLLM para un tramo, pasados de por token a por 1K. */
export function precioDeLiteLLM(datos: Record<string, unknown>, tramo: Tramo): PrecioComparable {
  const s = SUFIJO[tramo];
  const porMil = (campo: string): number | undefined => {
    const v = datos[campo];
    return typeof v === "number" && Number.isFinite(v) ? v * 1000 : undefined;
  };
  const out: PrecioComparable = {};
  const poner = (c: Campo, v: number | undefined) => {
    if (v !== undefined) out[c] = v;
  };
  poner("entrada", porMil(`input_cost_per_token${s}`));
  poner("salida", porMil(`output_cost_per_token${s}`));
  poner("lectura", porMil(`cache_read_input_token_cost${s}`));
  poner("escritura", porMil(`cache_creation_input_token_cost${s}`));
  if (tramo === "estandar") poner("escritura1h", porMil("cache_creation_input_token_cost_above_1hr"));
  return out;
}

// ── El contraste ───────────────────────────────────────────────────────────

/** Iguales salvo el ruido de pasar de por token a por 1K (y de los literales). */
export function iguales(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-12 + 1e-6 * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * Una discrepancia ya contrastada con la página OFICIAL del proveedor. Vale
 * mientras LiteLLM siga diciendo `suyo`: si su cifra cambia, la alarma vuelve.
 */
export interface Revision {
  clave: string;
  tramo: Tramo;
  campo: Campo;
  /** Lo que decía LiteLLM (USD por 1K) cuando se revisó. */
  suyo: number;
  /** Lo que dice la página oficial: a quién le da la razón. */
  veredicto: "nosotros" | "litellm";
  /** URL oficial consultada. */
  fuente: string;
  /** AAAA-MM-DD en que se leyó. */
  consultado: string;
  /** Lo que dice la página, en corto. */
  nota: string;
}

export type TipoDeDiferencia = "difiere" | "solo-nuestro" | "solo-suyo";

export interface Diferencia {
  campo: Campo;
  tipo: TipoDeDiferencia;
  nuestro?: number;
  suyo?: number;
  /** La revisión que la cubre (solo `difiere`), si la hay y sigue vigente. */
  revision?: Revision;
}

export interface FilaContrastada {
  clave: string;
  origen: OrigenDeTarifa;
  tramo: Tramo;
  /** La clave de LiteLLM con la que se comparó, o null si no hay. */
  claveLiteLLM: string | null;
  estado: "coincide" | "difiere" | "sin-referencia";
  diferencias: Diferencia[];
  nuestro: PrecioComparable;
  suyo: PrecioComparable | null;
}

export interface Informe {
  dia: string;
  filas: FilaContrastada[];
  resumen: {
    filas: number;
    coinciden: number;
    conDiferencias: number;
    sinReferencia: number;
    /** `difiere` sin revisión vigente: lo que pide una persona. */
    alarmas: number;
    /** `difiere` cubiertas por una revisión vigente. */
    revisadas: number;
    /** Campos que solo publica uno de los dos (informativo). */
    soloUnLado: number;
  };
}

export function contrastar(tabla: TablaLiteLLM, opts: { dia: string; revisadas?: readonly Revision[] }): Informe {
  const revisadas = opts.revisadas ?? REVISADAS;
  const filas: FilaContrastada[] = [];
  for (const propia of filasPropias(opts.dia)) {
    const entrada = buscarEnLiteLLM(tabla, propia.clave, propia.origen);
    const suyo = entrada ? precioDeLiteLLM(entrada.datos, propia.tramo) : null;
    // Un tier sin ningún campo en LiteLLM es «sin referencia», no «solo nuestro».
    if (!entrada || !suyo || (propia.tramo !== "estandar" && Object.keys(suyo).length === 0)) {
      filas.push({ ...base(propia), claveLiteLLM: entrada?.clave ?? null, estado: "sin-referencia", diferencias: [], suyo: null });
      continue;
    }
    const diferencias: Diferencia[] = [];
    for (const campo of CAMPOS) {
      const n = propia.precio[campo];
      const s = suyo[campo];
      if (n === undefined && s === undefined) continue;
      if (n !== undefined && s !== undefined) {
        if (iguales(n, s)) continue;
        const revision = revisadas.find(
          (r) => r.clave === propia.clave && r.tramo === propia.tramo && r.campo === campo && iguales(r.suyo, s),
        );
        diferencias.push({ campo, tipo: "difiere", nuestro: n, suyo: s, ...(revision ? { revision } : {}) });
      } else if (n !== undefined) {
        // Nuestra escritura a 5 min sale SIEMPRE (entrada × prima); que LiteLLM no
        // la publique donde la prima es 1 (OpenAI antes de 5.6, Gemini) no dice nada.
        if (campo === "escritura" && propia.tramo === "estandar" && primaDeEscritura(propia.clave) === 1) continue;
        diferencias.push({ campo, tipo: "solo-nuestro", nuestro: n });
      } else {
        diferencias.push({ campo, tipo: "solo-suyo", suyo: s });
      }
    }
    const difiere = diferencias.some((d) => d.tipo === "difiere");
    filas.push({ ...base(propia), claveLiteLLM: entrada.clave, estado: difiere ? "difiere" : "coincide", diferencias, suyo });
  }
  const todas = filas.flatMap((f) => f.diferencias);
  return {
    dia: opts.dia,
    filas,
    resumen: {
      filas: filas.length,
      coinciden: filas.filter((f) => f.estado === "coincide").length,
      conDiferencias: filas.filter((f) => f.estado === "difiere").length,
      sinReferencia: filas.filter((f) => f.estado === "sin-referencia").length,
      alarmas: todas.filter((d) => d.tipo === "difiere" && !d.revision).length,
      revisadas: todas.filter((d) => d.tipo === "difiere" && d.revision).length,
      soloUnLado: todas.filter((d) => d.tipo !== "difiere").length,
    },
  };
}

function base(p: FilaPropia): Pick<FilaContrastada, "clave" | "origen" | "tramo" | "nuestro"> {
  return { clave: p.clave, origen: p.origen, tramo: p.tramo, nuestro: p.precio };
}

/** Las discrepancias que piden una persona: `difiere` sin revisión vigente. */
export function alarmas(informe: Informe): { fila: FilaContrastada; diferencia: Diferencia }[] {
  return informe.filas.flatMap((fila) =>
    fila.diferencias.filter((d) => d.tipo === "difiere" && !d.revision).map((diferencia) => ({ fila, diferencia })),
  );
}

const porMillon = (v: number | undefined): string => (v === undefined ? "—" : `$${+(v * 1000).toPrecision(6)}`);

/** El informe para una persona: alarmas primero, luego lo revisado y lo informativo. */
export function informeEnTexto(inf: Informe, referencia: string): string {
  const l: string[] = [];
  const r = inf.resumen;
  l.push(`Contraste del catálogo de BV-SALA con la tabla de LiteLLM (${referencia}) · precios del ${inf.dia}`);
  l.push(
    `${r.filas} filas: ${r.coinciden} coinciden, ${r.conDiferencias} con diferencias, ${r.sinReferencia} sin referencia · ` +
      `${r.alarmas} ALARMA(S) · ${r.revisadas} revisada(s) · ${r.soloUnLado} campo(s) que solo publica un lado`,
  );
  l.push("LiteLLM es una alarma, no una fuente: nada de esto cambia el catálogo. Cada alarma se resuelve con la página oficial del proveedor.");
  const al = alarmas(inf);
  if (al.length > 0) {
    l.push("", "ALARMAS (sin revisar):");
    for (const { fila, diferencia: d } of al) {
      l.push(`  ⛔ ${fila.clave} [${fila.tramo}] ${d.campo}: nuestro ${porMillon(d.nuestro)}/1M · LiteLLM (${fila.claveLiteLLM}) ${porMillon(d.suyo)}/1M`);
    }
  }
  const rev = inf.filas.flatMap((f) => f.diferencias.filter((d) => d.revision).map((d) => ({ f, d })));
  if (rev.length > 0) {
    l.push("", "Revisadas contra la página oficial:");
    for (const { f, d } of rev) {
      const q = d.revision!;
      l.push(
        `  ✓ ${f.clave} [${f.tramo}] ${d.campo}: nuestro ${porMillon(d.nuestro)} · LiteLLM ${porMillon(d.suyo)} → ` +
          `razón a ${q.veredicto === "nosotros" ? "BV-SALA" : "LiteLLM"} (${q.fuente}, ${q.consultado}): ${q.nota}`,
      );
    }
  }
  const unLado = inf.filas.flatMap((f) => f.diferencias.filter((d) => d.tipo !== "difiere").map((d) => ({ f, d })));
  if (unLado.length > 0) {
    l.push("", "Solo lo publica un lado (informativo):");
    for (const { f, d } of unLado) {
      l.push(
        `  · ${f.clave} [${f.tramo}] ${d.campo}: ${d.tipo === "solo-nuestro" ? `solo nosotros ${porMillon(d.nuestro)}` : `solo LiteLLM ${porMillon(d.suyo)}`}`,
      );
    }
  }
  const sin = inf.filas.filter((f) => f.estado === "sin-referencia");
  if (sin.length > 0) {
    l.push("", `Sin referencia en LiteLLM (${sin.length}): ${sin.map((f) => `${f.clave} [${f.tramo}]`).join(", ")}`);
  }
  return l.join("\n");
}

// ── Lo revisado ────────────────────────────────────────────────────────────

/**
 * Discrepancias YA contrastadas con la página oficial del proveedor. Cada una
 * con la cifra de LiteLLM que se revisó: si LiteLLM la cambia, vuelve a ser
 * alarma. Las que dieron la razón a LiteLLM no se quedan aquí: se corrigen en
 * el catálogo (con su fuente) y la diferencia desaparece.
 */
export const REVISADAS: readonly Revision[] = [
  {
    // LiteLLM v1.102.1 (la tabla que trae la rueda del experimento E6) dice
    // 1.375e-07 por token; su `main` ya dice 1.38e-07, como nosotros.
    clave: "o4-mini",
    tramo: "flex",
    campo: "lectura",
    suyo: 0.0001375,
    veredicto: "nosotros",
    fuente: "https://developers.openai.com/api/docs/pricing",
    consultado: "2026-09-27",
    nota:
      "tabla «Flex pricing data»: o4-mini $0.55 / $0.138 / - / $2.20 (entrada, entrada cacheada, escritura, salida). " +
      "Si la factura fuera 0,1375 (la mitad de 0,275), 0,138 deja el ahorro de Flex en la lectura por DEBAJO, el lado que no infla la comisión.",
  },
];

// ── La tabla, fijada ───────────────────────────────────────────────────────

export interface TablaDescargada {
  tabla: TablaLiteLLM;
  commit: string | null;
  url: string | null;
  sha256: string;
}

export function sha256(texto: string | Buffer): string {
  return createHash("sha256").update(texto).digest("hex");
}

async function resolverMain(): Promise<string> {
  const r = await fetch(
    `https://api.github.com/repos/${REPOSITORIO_LITELLM}/commits?path=${RUTA_TABLA_LITELLM}&sha=main&per_page=1`,
    { headers: { accept: "application/vnd.github+json", "user-agent": "bvsala-contraste-catalogo" } },
  );
  if (!r.ok) throw new Error(`no se pudo resolver main de ${REPOSITORIO_LITELLM}: HTTP ${r.status}`);
  const lista = (await r.json()) as { sha?: string }[];
  const sha = lista[0]?.sha;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("respuesta de GitHub sin sha de commit");
  return sha;
}

export async function descargarTabla(commitPedido: string): Promise<TablaDescargada> {
  const commit = commitPedido === "main" ? await resolverMain() : commitPedido;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`commit no válido: ${commit} (40 hex, o «main»)`);
  const url = urlDeLaTabla(commit);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`no se pudo bajar la tabla: HTTP ${r.status} (${url})`);
  const crudo = Buffer.from(await r.arrayBuffer());
  const suma = sha256(crudo);
  if (commit === COMMIT_FIJADO && suma !== SHA256_FIJADO) {
    throw new Error(`la tabla del commit fijado no tiene la suma fijada: ${suma} (se esperaba ${SHA256_FIJADO})`);
  }
  return { tabla: JSON.parse(crudo.toString("utf8")) as TablaLiteLLM, commit, url, sha256: suma };
}

// ── Como proceso propio ────────────────────────────────────────────────────

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function principal(): Promise<void> {
  const dia = arg("--dia") ?? diaUtc();
  const fichero = arg("--fichero");
  const t: TablaDescargada = fichero
    ? (() => {
        const crudo = readFileSync(fichero);
        return { tabla: JSON.parse(crudo.toString("utf8")) as TablaLiteLLM, commit: null, url: null, sha256: sha256(crudo) };
      })()
    : await descargarTabla(arg("--commit") ?? COMMIT_FIJADO);
  const informe = contrastar(t.tabla, { dia });
  const referencia = t.commit ? `${REPOSITORIO_LITELLM}@${t.commit.slice(0, 12)}, sha256 ${t.sha256.slice(0, 12)}…` : `${fichero}, sha256 ${t.sha256.slice(0, 12)}…`;
  console.log(informeEnTexto(informe, referencia));

  const documento = {
    que: "Contraste del catálogo de precios de BV-SALA con la tabla de LiteLLM (experimento E4). ALARMA, nunca fuente.",
    generado: new Date().toISOString(),
    referencia: {
      repositorio: REPOSITORIO_LITELLM,
      fichero: RUTA_TABLA_LITELLM,
      licencia: "MIT",
      commit: t.commit,
      url: t.url,
      sha256: t.sha256,
      entradas: Object.keys(t.tabla).length,
    },
    catalogo: { preciosAlDia: PRECIOS_AL_DIA, tarifasDeTierAlDia: TARIFAS_DE_TIER_AL_DIA, dia },
    resumen: informe.resumen,
    alarmas: alarmas(informe).map(({ fila, diferencia }) => ({ clave: fila.clave, tramo: fila.tramo, claveLiteLLM: fila.claveLiteLLM, ...diferencia })),
    filas: informe.filas,
  };
  const destinos: string[] = [];
  if (process.argv.includes("--guardar")) {
    destinos.push(join(dirname(fileURLToPath(import.meta.url)), "..", "benchmarks", "evidencia", `contraste-catalogo-${dia}.json`));
  }
  const salida = arg("--salida");
  if (salida) destinos.push(salida);
  for (const d of destinos) {
    mkdirSync(dirname(d), { recursive: true });
    writeFileSync(d, `${JSON.stringify(documento, null, 2)}\n`);
    console.log(`\nInforme: ${d}`);
  }
  if (process.argv.includes("--estricto") && informe.resumen.alarmas > 0) process.exitCode = 1;
}

if (esElPrincipal(import.meta.url)) await principal();
