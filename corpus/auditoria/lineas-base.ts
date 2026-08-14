/**
 * LAS LÍNEAS BASE TONTAS. Un corpus no se juzga por lo que dice de sí mismo,
 * se juzga por lo que le saca un selector que no piensa. Si «coge las primeras
 * k» o «coge las que más se parecen a la pregunta» aprueban, entonces aprobar
 * este corpus no es evidencia de nada y F6 podría gatearse con un `slice`.
 *
 * Ninguna de estas seis mira los papeles ni las citas: solo ven `consulta`,
 * `unidades[].texto` y el presupuesto. Es exactamente lo que verá el knapsack.
 *
 * La que más importa es `solape-lexico-k`, y no es un hombre de paja: es un
 * recuperador BM25 de una línea, o sea el estado del arte de 1994 y lo que ya
 * hace el propio recuperador que produjo estas unidades. Un knapsack que no le
 * gane no es una palanca de ahorro, es una segunda pasada del mismo ranking.
 */

import { normalizeText } from "../../src/canonicalization/canonicalize.js";
import type { CasoVista } from "../vista.js";

export type Selector = (caso: CasoVista) => string[];

export interface ResultadoCaso {
  casoId: string;
  seleccion: string[];
  /** Todas las necesarias sobreviven. */
  conservaNecesarias: boolean;
  /** Todas las citas obligatorias sobreviven. */
  citasVivas: boolean;
  dentroDePresupuesto: boolean;
  /** Lo que decide F6: las tres cosas a la vez. */
  resuelto: boolean;
  /** Fracción de unidades tiradas: el ahorro bruto del caso. */
  ahorro: number;
}

export interface Informe {
  nombre: string;
  total: number;
  resueltos: number;
  tasa: number;
  /** Media de la fracción de unidades tiradas. Cero = no ahorró nada. */
  ahorroMedio: number;
  fueraDePresupuesto: number;
  porIdioma: Record<string, { total: number; resueltos: number }>;
  porOrigen: Record<string, { total: number; resueltos: number }>;
  porDificultad: Record<string, { total: number; resueltos: number }>;
  porTrampa: Record<string, { total: number; resueltos: number }>;
  fallos: string[];
}

export function evaluar(caso: CasoVista, seleccion: readonly string[]): ResultadoCaso {
  const s = new Set(seleccion);
  const conservaNecesarias = caso.necesarias.every((id) => s.has(id));
  const citasVivas = caso.citas.every((id) => s.has(id));
  const dentroDePresupuesto = s.size <= caso.presupuestoMax;
  return {
    casoId: caso.id,
    seleccion: [...s],
    conservaNecesarias,
    citasVivas,
    dentroDePresupuesto,
    resuelto: conservaNecesarias && citasVivas && dentroDePresupuesto,
    ahorro: 1 - s.size / caso.unidades.length,
  };
}

function acumula(
  mapa: Record<string, { total: number; resueltos: number }>,
  clave: string,
  ok: boolean,
): void {
  const d = (mapa[clave] ??= { total: 0, resueltos: 0 });
  d.total += 1;
  if (ok) d.resueltos += 1;
}

export function correr(nombre: string, casos: CasoVista[], selector: Selector): Informe {
  const inf: Informe = {
    nombre,
    total: casos.length,
    resueltos: 0,
    tasa: 0,
    ahorroMedio: 0,
    fueraDePresupuesto: 0,
    porIdioma: {},
    porOrigen: {},
    porDificultad: {},
    porTrampa: {},
    fallos: [],
  };
  let ahorro = 0;
  for (const caso of casos) {
    const r = evaluar(caso, selector(caso));
    if (r.resuelto) inf.resueltos += 1;
    else inf.fallos.push(caso.id);
    if (!r.dentroDePresupuesto) inf.fueraDePresupuesto += 1;
    ahorro += r.ahorro;
    acumula(inf.porIdioma, caso.idioma, r.resuelto);
    acumula(inf.porOrigen, caso.origen, r.resuelto);
    acumula(inf.porDificultad, caso.dificultad, r.resuelto);
    for (const t of caso.trampas) acumula(inf.porTrampa, t, r.resuelto);
  }
  inf.tasa = casos.length === 0 ? 0 : inf.resueltos / casos.length;
  inf.ahorroMedio = casos.length === 0 ? 0 : ahorro / casos.length;
  return inf;
}

// ─── Los selectores ──────────────────────────────────────────────────────────

/** Mandarlo todo. Nunca pierde una necesaria y nunca ahorra un céntimo. */
export const todo: Selector = (c) => c.unidades.map((u) => u.id);

/** Las k primeras tal y como las devolvió el recuperador. */
export const primerosK: Selector = (c) =>
  c.unidades.slice(0, c.presupuestoMax).map((u) => u.id);

/** Las k últimas. Existe para detectar el sesgo de posición INVERSO. */
export const ultimosK: Selector = (c) =>
  c.unidades.slice(Math.max(0, c.unidades.length - c.presupuestoMax)).map((u) => u.id);

/** Las k más largas: «lo que más texto tiene es lo que más dice». */
export const masLargasK: Selector = (c) =>
  [...c.unidades]
    .sort((a, b) => b.texto.length - a.texto.length || a.orden - b.orden)
    .slice(0, c.presupuestoMax)
    .map((u) => u.id);

const PARADAS = new Set(
  ("de la el los las un una unos unas y o a en que es se del al por para con sin " +
    "no si su sus lo le les mi me te ha he han hay como cuando donde cual cuales " +
    "es ca dels als amb per que qui quan on el la els les un una uns unes i o " +
    "del pel als hi ho ja no si es s l d n m t").split(/\s+/),
);

function tokens(texto: string): string[] {
  return normalizeText(texto)
    .split(/[^\p{L}\p{N}.,/-]+/u)
    .map((t) => t.replace(/^[.,/-]+|[.,/-]+$/g, ""))
    .filter((t) => t.length > 1 && !PARADAS.has(t));
}

/**
 * BM25-lite dentro del caso: idf calculado sobre las propias unidades, que es
 * lo que hace que un identificador raro («F-2024-118») pese mucho y «cláusula»
 * no pese nada. Sin normalización por longitud a propósito: la versión que más
 * acierta es la que hay que batir.
 */
export const solapeLexicoK: Selector = (c) => {
  const q = new Set(tokens(c.consulta));
  const docs = c.unidades.map((u) => new Set(tokens(u.texto)));
  const n = docs.length;
  const df = new Map<string, number>();
  for (const t of q) df.set(t, docs.filter((d) => d.has(t)).length);

  const puntuadas = c.unidades.map((u, i) => {
    let s = 0;
    for (const t of q) {
      const d = docs[i];
      if (d && d.has(t)) s += Math.log(1 + n / (1 + (df.get(t) ?? 0)));
    }
    return { id: u.id, orden: u.orden, s };
  });
  return puntuadas
    .sort((a, b) => b.s - a.s || a.orden - b.orden)
    .slice(0, c.presupuestoMax)
    .map((u) => u.id);
};

/** Generador determinista: el azar de un informe tiene que ser reproducible. */
function lcg(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * k unidades al azar, promediado sobre `repeticiones` tiradas. Es el SUELO:
 * cualquier baremo por debajo de esto significa que el corpus premia elegir mal.
 */
export function azarK(casos: CasoVista[], repeticiones = 400, semilla = 20260814): number {
  const rnd = lcg(semilla);
  let resueltos = 0;
  for (let r = 0; r < repeticiones; r++) {
    for (const c of casos) {
      const ids = c.unidades.map((u) => u.id);
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const a = ids[i] as string;
        const b = ids[j] as string;
        ids[i] = b;
        ids[j] = a;
      }
      if (evaluar(c, ids.slice(0, c.presupuestoMax)).resuelto) resueltos += 1;
    }
  }
  return resueltos / (repeticiones * casos.length);
}

/** El techo: exactamente lo que hay que conservar, ni una unidad más. */
export const oraculo: Selector = (c) => [...new Set([...c.necesarias, ...c.citas])];
