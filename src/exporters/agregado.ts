import type { CostBasis } from "../tokenizer/accounting.js";
import { redondear, tieneDinero } from "./atributos.js";
import type { SavingsRecord } from "./tipos.js";

// INTERNO: el ÚNICO agregador, el que usan la serie y FOCUS. Que sea uno solo es
// la garantía de que los dos formatos cuentan lo mismo.
//
// Reglas (cada una tiene su test):
//  · `shadow` no entra: es hipotético.
//  · Un grupo es de UN basis: nunca se mezclan bases en una fila.
//  · El dinero se suma en bruto y se redondea a 1e-10 al salir.
//  · `unmeasured` sale con contadores y el dinero a null.
//  · Periodos en UTC, con el fin EXCLUSIVO (FOCUS: «exclusive end bound»).

export type BasisExportado = Exclude<CostBasis, "shadow">;
export const ORDEN_BASIS: readonly BasisExportado[] = ["measured", "reference", "estimated", "unmeasured"];

const HORA = 3_600_000;
const DIA = 24 * HORA;

export type Granularidad = "hour" | "day";

export function validarGranularidad(g: unknown, fn: string): Granularidad {
  if (g === undefined) return "day";
  if (g === "hour" || g === "day") return g;
  throw new TypeError(`[bvsala] ${fn}: granularity must be "hour" or "day"`);
}

export function validarMoneda(c: unknown, fn: string): string {
  if (c === undefined) return "USD";
  if (typeof c === "string" && /^[A-Z]{3}$/.test(c)) return c;
  throw new TypeError(`[bvsala] ${fn}: currency must be an ISO 4217 code such as "USD"`);
}

/** El instante de un registro en ms, o TypeError. El mensaje lleva, como mucho, el requestId. */
export function instanteDe(r: SavingsRecord, fn: string): number {
  const at = r.at;
  let ms = Number.NaN;
  if (at instanceof Date) ms = at.getTime();
  else if (typeof at === "number") ms = at;
  else if (typeof at === "string" && at.trim() !== "") ms = Date.parse(at);
  if (!Number.isFinite(ms)) {
    throw new TypeError(
      `[bvsala] ${fn}: invalid "at" for request ${String(r.report?.requestId)}: ` +
        "expected an ISO 8601 string, epoch milliseconds or a valid Date",
    );
  }
  return ms;
}

export function inicioDePeriodo(ms: number, g: Granularidad): number {
  const paso = g === "hour" ? HORA : DIA;
  return Math.floor(ms / paso) * paso;
}

export function finDePeriodo(inicio: number, g: Granularidad): number {
  return inicio + (g === "hour" ? HORA : DIA);
}

/** `YYYY-MM-DDTHH:mm:ssZ`, el formato de fecha de FOCUS (sin milisegundos). */
export function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface Grupo<X> {
  inicio: number;
  fin: number;
  modelo: string;
  basis: BasisExportado;
  clave: string;
  extra: X;
  peticiones: number;
  llamadas: number;
  evitadas: number;
  baseline: number;
  actual: number;
  ahorro: number;
  suelo: number | undefined;
  tokens: {
    baselineInput: number;
    actualInput: number;
    eliminatedInput: number;
    compressedInput: number;
    providerCachedInput: number | undefined;
    baselineOutput: number;
    actualOutput: number;
    eliminatedOutput: number;
  };
}

function cifra(v: unknown, campo: string, requestId: string, fn: string): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new TypeError(`[bvsala] ${fn}: report ${requestId} has no finite number in ${campo}`);
}

/**
 * Agrupa los registros por periodo × modelo × basis × `claveExtra`. Devuelve
 * los grupos en orden determinista: periodo, modelo, basis (measured,
 * reference, estimated, unmeasured) y el resto de la clave.
 */
export function agregar<X>(
  records: Iterable<SavingsRecord>,
  g: Granularidad,
  fn: string,
  claveExtra: (r: SavingsRecord, inicio: number) => { clave: string; extra: X },
): Grupo<X>[] {
  const grupos = new Map<string, Grupo<X>>();
  for (const r of records) {
    if (!r || typeof r !== "object" || !r.report || typeof r.report !== "object") {
      throw new TypeError(`[bvsala] ${fn}: every record must be { at, report }`);
    }
    const rep = r.report;
    const basis = rep.cost?.basis;
    if (basis === "shadow") continue;
    if (!ORDEN_BASIS.includes(basis as BasisExportado)) {
      throw new TypeError(`[bvsala] ${fn}: report ${String(rep.requestId)} has an unknown cost basis`);
    }
    const b = basis as BasisExportado;
    const inicio = inicioDePeriodo(instanteDe(r, fn), g);
    const { clave: claveExtraTexto, extra } = claveExtra(r, inicio);
    const clave = JSON.stringify([inicio, rep.model, b, claveExtraTexto]);
    let grupo = grupos.get(clave);
    if (!grupo) {
      grupo = {
        inicio,
        fin: finDePeriodo(inicio, g),
        modelo: rep.model,
        basis: b,
        clave: claveExtraTexto,
        extra,
        peticiones: 0,
        llamadas: 0,
        evitadas: 0,
        baseline: 0,
        actual: 0,
        ahorro: 0,
        suelo: undefined,
        tokens: {
          baselineInput: 0,
          actualInput: 0,
          eliminatedInput: 0,
          compressedInput: 0,
          providerCachedInput: undefined,
          baselineOutput: 0,
          actualOutput: 0,
          eliminatedOutput: 0,
        },
      };
      grupos.set(clave, grupo);
    }
    const id = String(rep.requestId);
    grupo.peticiones += 1;
    grupo.llamadas += cifra(rep.calls?.actualLlm, "calls.actualLlm", id, fn);
    grupo.evitadas += cifra(rep.calls?.avoidedLlm, "calls.avoidedLlm", id, fn);
    const t = rep.tokens;
    grupo.tokens.baselineInput += cifra(t?.baselineInput, "tokens.baselineInput", id, fn);
    grupo.tokens.actualInput += cifra(t?.actualInput, "tokens.actualInput", id, fn);
    grupo.tokens.eliminatedInput += cifra(t?.eliminatedInput, "tokens.eliminatedInput", id, fn);
    grupo.tokens.compressedInput += cifra(t?.compressedInput, "tokens.compressedInput", id, fn);
    grupo.tokens.baselineOutput += cifra(t?.baselineOutput, "tokens.baselineOutput", id, fn);
    grupo.tokens.actualOutput += cifra(t?.actualOutput, "tokens.actualOutput", id, fn);
    grupo.tokens.eliminatedOutput += cifra(t?.eliminatedOutput, "tokens.eliminatedOutput", id, fn);
    if (t.providerCachedInput !== undefined) {
      grupo.tokens.providerCachedInput =
        (grupo.tokens.providerCachedInput ?? 0) + cifra(t.providerCachedInput, "tokens.providerCachedInput", id, fn);
    }
    if (tieneDinero(b)) {
      const base = cifra(rep.cost.baselineEstimate, "cost.baselineEstimate", id, fn);
      const act = cifra(rep.cost.actual, "cost.actual", id, fn);
      grupo.baseline += base;
      grupo.actual += act;
      grupo.ahorro += base - act;
      if (rep.cost.eliminatedInputFloorCost !== undefined) {
        grupo.suelo =
          (grupo.suelo ?? 0) + cifra(rep.cost.eliminatedInputFloorCost, "cost.eliminatedInputFloorCost", id, fn);
      }
    }
  }
  const orden = (b: BasisExportado) => ORDEN_BASIS.indexOf(b);
  return [...grupos.values()].sort(
    (x, y) =>
      x.inicio - y.inicio ||
      (x.modelo < y.modelo ? -1 : x.modelo > y.modelo ? 1 : 0) ||
      orden(x.basis) - orden(y.basis) ||
      (x.clave < y.clave ? -1 : x.clave > y.clave ? 1 : 0),
  );
}

/** El dinero de un grupo, redondeado, con null donde no hay dinero que decir. */
export function dineroDe(grupo: Grupo<unknown>): {
  baseline: number | null;
  actual: number | null;
  measured: number | null;
  reference: number | null;
  estimated: number | null;
  suelo: number | null;
} {
  const conDinero = tieneDinero(grupo.basis);
  const ahorro = redondear(grupo.ahorro);
  return {
    baseline: conDinero ? redondear(grupo.baseline) : null,
    actual: conDinero ? redondear(grupo.actual) : null,
    measured: grupo.basis === "measured" ? ahorro : null,
    reference: grupo.basis === "reference" ? ahorro : null,
    estimated: grupo.basis === "estimated" ? ahorro : null,
    suelo: conDinero && grupo.suelo !== undefined ? redondear(grupo.suelo) : null,
  };
}

/** Un objeto de etiquetas con claves ordenadas, para usarlo como clave estable. */
export function textoEstable(o: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** Valida un objeto de etiquetas devuelto por el llamante: strings, o TypeError. */
export function etiquetas(
  o: Record<string, string> | undefined,
  que: string,
  fn: string,
): Record<string, string> {
  if (o === undefined || o === null) return {};
  if (typeof o !== "object" || Array.isArray(o)) {
    throw new TypeError(`[bvsala] ${fn}: ${que} must return an object of strings`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== "string") throw new TypeError(`[bvsala] ${fn}: ${que} value for "${k}" must be a string`);
    out[k] = v;
  }
  return out;
}
