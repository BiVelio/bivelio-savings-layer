/**
 * EL COMPROBADOR AST DE BFCL, PORTADO.
 * ---------------------------------------------------------------------------
 * Port de `bfcl_eval/eval_checker/ast_eval/ast_checker.py` (commit fijado en
 * datos.ts) para las cuatro categorías AST en Python: `simple`, `multiple`,
 * `parallel` y `parallel_multiple`. Mismas reglas:
 *
 *   · nombre de función (con `.`→`_`, como hace BFCL con los modelos de FC);
 *   · requeridos presentes, ningún parámetro inesperado, opcional ausente solo
 *     si `""` está entre las respuestas posibles;
 *   · comprobación de tipo con la distinción int/float de Python (por eso los
 *     argumentos se leen con un parser que conserva si el número se escribió
 *     con decimales: `JSON.parse` la borra) y la conversión automática
 *     int→float de Python;
 *   · la regla de «variable» de BFCL: si el tipo de la respuesta posible no es
 *     el de la documentación, un valor de ese otro tipo pasa sin mirar valor;
 *   · cadenas normalizadas (`[ ,./-_*^]` fuera, minúsculas, `'`→`"`), listas,
 *     diccionarios y listas de diccionarios con los mismos comprobadores;
 *   · `parallel*`: sin orden, cada respuesta posible consume una llamada.
 *
 * Lo que NO se porta, porque no aplica a Python: los tipos de Java/JavaScript.
 */
import type { CategoriaAst, FuncionBfcl } from "./datos.js";
import { nombreDeCable } from "./esquema.js";

/** Un número JSON con memoria de cómo se escribió. */
export class NumJ {
  constructor(
    readonly v: number,
    readonly flotante: boolean,
  ) {}
}
export type ValorJ = string | boolean | null | NumJ | ValorJ[] | { [k: string]: ValorJ };

/** JSON → ValorJ, conservando si cada número era entero o flotante en el texto. */
export function parsearJson(texto: string): ValorJ {
  let i = 0;
  const ws = () => {
    while (i < texto.length && /\s/.test(texto[i]!)) i++;
  };
  const err = (m: string): never => {
    throw new SyntaxError(`JSON inválido en ${i}: ${m}`);
  };
  const valor = (): ValorJ => {
    ws();
    const c = texto[i];
    if (c === "{") {
      i++;
      const o: Record<string, ValorJ> = {};
      ws();
      if (texto[i] === "}") {
        i++;
        return o;
      }
      for (;;) {
        ws();
        const k = valor();
        if (typeof k !== "string") err("clave no es cadena");
        ws();
        if (texto[i] !== ":") err("se esperaba ':'");
        i++;
        o[k as string] = valor();
        ws();
        if (texto[i] === ",") {
          i++;
          continue;
        }
        if (texto[i] === "}") {
          i++;
          return o;
        }
        err("se esperaba ',' o '}'");
      }
    }
    if (c === "[") {
      i++;
      const a: ValorJ[] = [];
      ws();
      if (texto[i] === "]") {
        i++;
        return a;
      }
      for (;;) {
        a.push(valor());
        ws();
        if (texto[i] === ",") {
          i++;
          continue;
        }
        if (texto[i] === "]") {
          i++;
          return a;
        }
        err("se esperaba ',' o ']'");
      }
    }
    if (c === '"') {
      const ini = i;
      i++;
      while (i < texto.length && texto[i] !== '"') i += texto[i] === "\\" ? 2 : 1;
      i++;
      return JSON.parse(texto.slice(ini, i)) as string;
    }
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(texto.slice(i));
    if (m) {
      i += m[0].length;
      return new NumJ(Number(m[0]), m[1] !== undefined || m[2] !== undefined);
    }
    for (const [lit, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (texto.startsWith(lit, i)) {
        i += lit.length;
        return v;
      }
    }
    return err(`carácter inesperado '${c ?? "EOF"}'`);
  };
  const v = valor();
  ws();
  if (i !== texto.length) err("basura al final");
  return v;
}

type TipoPy = "str" | "int" | "float" | "bool" | "list" | "dict" | "none";

function tipoPy(v: ValorJ): TipoPy {
  if (v === null) return "none";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (v instanceof NumJ) return v.flotante ? "float" : "int";
  if (Array.isArray(v)) return "list";
  return "dict";
}

const MAPA_PY: Readonly<Record<string, TipoPy>> = {
  string: "str",
  integer: "int",
  float: "float",
  boolean: "bool",
  array: "list",
  tuple: "list",
  dict: "dict",
  any: "str",
};
const CON_ANIDADO = new Set(["array", "tuple"]);

/** `==` de Python sobre valores JSON (1 == 1.0; listas y dicts en profundidad). */
export function igualPy(a: ValorJ, b: ValorJ): boolean {
  if (a instanceof NumJ || b instanceof NumJ || typeof a === "boolean" || typeof b === "boolean") {
    const na = a instanceof NumJ ? a.v : typeof a === "boolean" ? Number(a) : undefined;
    const nb = b instanceof NumJ ? b.v : typeof b === "boolean" ? Number(b) : undefined;
    return na !== undefined && nb !== undefined && na === nb;
  }
  if (typeof a === "string" || typeof b === "string" || a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, k) => igualPy(x, b[k]!));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && igualPy(a[k]!, b[k]!));
}

const enPy = (v: ValorJ, lista: ValorJ[]): boolean => lista.some((x) => igualPy(v, x));

export function normalizarCadena(s: string): string {
  return s.replace(/[ ,./\-_*^]/g, "").toLowerCase().replace(/'/g, '"');
}
const normSiCadena = (v: ValorJ): ValorJ => (typeof v === "string" ? normalizarCadena(v) : v);

export interface Veredicto {
  valido: boolean;
  error?: string;
}
const ok: Veredicto = { valido: true };
const mal = (error: string): Veredicto => ({ valido: false, error });

function tipoDeRespuestaPosible(posibles: ValorJ[]): TipoPy | null {
  for (const p of posibles) if (p !== "") return tipoPy(p);
  return null;
}

function comprobarTipo(valor: ValorJ, posibles: ValorJ[], esperado: TipoPy, anidado: TipoPy | null): Veredicto & { variable?: boolean } {
  const tipoPosible = tipoDeRespuestaPosible(posibles);
  const esVariable = tipoPosible !== null && tipoPosible !== esperado;
  if (tipoPy(valor) === esperado) {
    if (anidado === null) return { valido: true, variable: esVariable };
    for (const item of posibles) {
      // Python: una respuesta posible que no es lista (el "" de opcional) deja la bandera en True.
      if (!Array.isArray(item)) return { valido: true, variable: esVariable };
      let bien = true;
      for (const v of valor as ValorJ[]) {
        if (!comprobarTipo(v, item, anidado, null).valido) {
          bien = false;
          break;
        }
      }
      if (bien) return { valido: true, variable: esVariable };
    }
    return mal(`tipo anidado incorrecto en la lista`);
  }
  if (tipoPosible !== null && tipoPy(valor) === tipoPosible) return { valido: true, variable: true };
  return mal(`tipo incorrecto: esperado ${esperado}, recibido ${tipoPy(valor)}`);
}

function comprobarDict(valor: Record<string, ValorJ>, posibles: ValorJ[]): Veredicto {
  let ultimo: Veredicto = mal("dict sin respuesta posible");
  for (const p of posibles) {
    if (p === "") continue;
    const pos = p as Record<string, ValorJ[]>;
    let bien = true;
    for (const [k, v] of Object.entries(valor)) {
      if (!(k in pos)) {
        ultimo = mal(`clave inesperada ${k} en dict`);
        bien = false;
        break;
      }
      if (!enPy(normSiCadena(v), (pos[k] ?? []).map(normSiCadena))) {
        ultimo = mal(`valor inválido en dict[${k}]`);
        bien = false;
        break;
      }
    }
    if (bien) {
      for (const [k, v] of Object.entries(pos)) {
        if (!(k in valor) && !v.includes("")) {
          ultimo = mal(`falta la clave ${k} en dict`);
          bien = false;
          break;
        }
      }
    }
    if (bien) return ok;
  }
  return ultimo;
}

function comprobarListaDeDicts(valor: ValorJ[], posibles: ValorJ[]): Veredicto {
  let ultimo: Veredicto = mal("lista de dicts sin respuesta posible");
  for (const p of posibles) {
    const lista = Array.isArray(p) ? p : [];
    if (lista.length !== valor.length) {
      ultimo = mal("longitud de lista de dicts distinta");
      continue;
    }
    let bien = true;
    for (let k = 0; k < valor.length; k++) {
      const r = comprobarDict(valor[k] as Record<string, ValorJ>, [lista[k]!]);
      if (!r.valido) {
        ultimo = r;
        bien = false;
        break;
      }
    }
    if (bien) return ok;
  }
  return ultimo;
}

function comprobarLista(valor: ValorJ[], posibles: ValorJ[]): Veredicto {
  const v = valor.map(normSiCadena);
  // En Python, iterar la cadena vacía (marcador de opcional) da una lista vacía.
  const ps = posibles.map((p) => (Array.isArray(p) ? p.map(normSiCadena) : typeof p === "string" ? [...p].map(normSiCadena) : [p]));
  return ps.some((p) => igualPy(v, p)) ? ok : mal("lista fuera de las respuestas posibles");
}

/** Una llamada del modelo: {nombreDeCable: {param: valor}}. */
export type LlamadaModelo = Record<string, Record<string, ValorJ>>;

export function comprobarSimple(func: FuncionBfcl, llamada: LlamadaModelo, posible: Record<string, Record<string, ValorJ[]>>): Veredicto {
  const nombre = nombreDeCable(func.name);
  const respuestas = posible[func.name] ?? posible[nombre];
  if (!respuestas) return mal(`la respuesta posible no es de ${func.name}`);
  const params = llamada[nombre];
  if (!params) return mal(`función ${nombre} no encontrada en la salida`);
  const detalle = func.parameters.properties ?? {};
  for (const req of func.parameters.required ?? []) {
    if (!(req in params)) return mal(`falta el parámetro requerido ${req}`);
  }
  for (const [p, crudo] of Object.entries(params)) {
    if (!(p in detalle) || !(p in respuestas)) return mal(`parámetro inesperado ${p}`);
    const desc = detalle[p]!;
    const tipoDoc = desc.type ?? "string";
    const esperado = MAPA_PY[tipoDoc] ?? "str";
    let valor = crudo;
    // Python convierte int→float solo.
    if (tipoDoc === "float" && valor instanceof NumJ && !valor.flotante) valor = new NumJ(valor.v, true);
    const anidado = CON_ANIDADO.has(tipoDoc) && desc.items?.type ? (MAPA_PY[desc.items.type] ?? "str") : null;
    const posibles = respuestas[p]!;
    const t = comprobarTipo(valor, posibles, esperado, anidado);
    if (!t.valido) return mal(`${p}: ${t.error}`);
    if (t.variable) continue;
    let r: Veredicto;
    if (esperado === "dict") r = comprobarDict(valor as Record<string, ValorJ>, posibles);
    else if (esperado === "list" && anidado === "dict") r = comprobarListaDeDicts(valor as ValorJ[], posibles);
    else if (esperado === "str") r = enPy(normalizarCadena(valor as string), posibles.map(normSiCadena)) ? ok : mal("cadena fuera de las respuestas posibles");
    else if (esperado === "list") r = comprobarLista(valor as ValorJ[], posibles);
    else r = enPy(valor, posibles) ? ok : mal("valor fuera de las respuestas posibles");
    if (!r.valido) return mal(`${p}: ${r.error}`);
  }
  for (const [p, posibles] of Object.entries(respuestas)) {
    if (!(p in params) && !posibles.includes("")) return mal(`falta el parámetro opcional ${p} (sin "" entre las posibles)`);
  }
  return ok;
}

function descripcionDe(funcs: FuncionBfcl[], nombre: string): FuncionBfcl | undefined {
  return funcs.find((f) => f.name === nombre) ?? funcs.find((f) => nombreDeCable(f.name) === nombreDeCable(nombre));
}

/**
 * El veredicto BFCL de una entrada AST. `posible` es el `ground_truth`
 * parseado con `parsearJson` (para conservar int/float también en él).
 */
export function comprobarEntrada(
  categoria: CategoriaAst,
  funcs: FuncionBfcl[],
  salida: LlamadaModelo[],
  posible: Record<string, Record<string, ValorJ[]>>[],
): Veredicto {
  if (categoria === "parallel" || categoria === "parallel_multiple") {
    if (salida.length !== posible.length) return mal(`número de llamadas: esperado ${posible.length}, recibido ${salida.length}`);
    const usadas = new Set<number>();
    for (const pos of posible) {
      const nombre = Object.keys(pos)[0]!;
      const f = descripcionDe(funcs, nombre);
      if (!f) return mal(`sin descripción para ${nombre}`);
      let ultimo: Veredicto = mal(`ninguna llamada casa con ${nombre}`);
      let casada = false;
      for (let k = 0; k < salida.length; k++) {
        if (usadas.has(k)) continue;
        const r = comprobarSimple(f, salida[k]!, pos);
        if (r.valido) {
          usadas.add(k);
          casada = true;
          break;
        }
        ultimo = r;
      }
      if (!casada) return ultimo;
    }
    return ok;
  }
  if (salida.length !== 1 || posible.length !== 1) return mal(`se esperaba exactamente 1 llamada, hubo ${salida.length}`);
  const nombre = Object.keys(posible[0]!)[0]!;
  const f = categoria === "simple" ? funcs[0] : descripcionDe(funcs, nombre);
  if (!f) return mal(`sin descripción para ${nombre}`);
  return comprobarSimple(f, salida[0]!, posible[0]!);
}

/** Las llamadas de herramienta devueltas (nombre + argumentos en crudo) → salida BFCL. */
export function salidaDeLlamadas(llamadas: { name: string; arguments: string }[]): LlamadaModelo[] | { error: string } {
  const out: LlamadaModelo[] = [];
  for (const l of llamadas) {
    let args: ValorJ;
    try {
      args = l.arguments.trim() === "" ? {} : parsearJson(l.arguments);
    } catch (e) {
      return { error: `argumentos no son JSON: ${(e as Error).message}` };
    }
    if (args === null || typeof args !== "object" || Array.isArray(args) || args instanceof NumJ) {
      return { error: "argumentos no son un objeto" };
    }
    out.push({ [l.name]: args as Record<string, ValorJ> });
  }
  return out;
}
