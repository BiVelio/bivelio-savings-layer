/**
 * DE LA DOCUMENTACIÓN DE BFCL AL ESQUEMA QUE VIAJA EN EL CABLE.
 * ---------------------------------------------------------------------------
 * Port de lo que hace `bfcl_eval` para los modelos de llamada nativa
 * (`model_handler/utils.py`: `convert_to_tool`, `_cast_to_openai_type` y
 * `func_doc_language_specific_pre_processing`), para que la batería mida lo
 * mismo que el leaderboard:
 *
 *   · el nombre con puntos pasa a guiones bajos (`math.factorial` →
 *     `math_factorial`): ni OpenAI ni Anthropic admiten `.` en un nombre;
 *   · los tipos de Python a JSON Schema (`dict`→object, `float`→number con
 *     `format: float` y la coletilla en la descripción, `tuple`→array,
 *     `any`→string, lo desconocido → string);
 *   · la coletilla del lenguaje en la descripción de la función.
 *
 * LOS DOS BRAZOS RECIBEN EXACTAMENTE ESTE ESQUEMA: la conversión es del banco,
 * no de la capa, así que no puede explicar ninguna diferencia A≠B.
 */
import type { FuncionBfcl, ParametroBfcl } from "./datos.js";

const GORILLA_A_OPENAPI: Readonly<Record<string, string>> = {
  integer: "integer",
  number: "number",
  float: "number",
  string: "string",
  boolean: "boolean",
  bool: "boolean",
  array: "array",
  list: "array",
  dict: "object",
  object: "object",
  tuple: "array",
  any: "string",
  byte: "integer",
  short: "integer",
  long: "integer",
  double: "number",
  char: "string",
};

export type EsquemaJson = Record<string, unknown>;

export interface HerramientaNeutral {
  /** Nombre en el cable (sin puntos). */
  nombre: string;
  /** Nombre original de BFCL (el que usa `possible_answer`). */
  original: string;
  descripcion: string;
  parametros: EsquemaJson;
}

export function nombreDeCable(nombre: string): string {
  return nombre.replace(/\./g, "_");
}

function tipo(t: string | undefined): string {
  return (t && GORILLA_A_OPENAPI[t]) || "string";
}

function convertirPropiedades(props: Record<string, ParametroBfcl>): Record<string, EsquemaJson> {
  const out: Record<string, EsquemaJson> = {};
  for (const [k, v] of Object.entries(props)) {
    const p: EsquemaJson = { ...v };
    if (v.type === undefined) {
      p["type"] = "string";
    } else {
      if (v.type === "float") {
        p["format"] = "float";
        p["description"] = `${v.description ?? ""} This is a float type value.`;
      }
      p["type"] = tipo(v.type);
    }
    if (p["type"] === "array" || p["type"] === "object") {
      if (v.properties) {
        p["properties"] = convertirPropiedades(v.properties);
      } else if (v.items) {
        const items: EsquemaJson = { ...v.items, type: tipo(v.items.type) };
        if (items["type"] === "array" && v.items.items) {
          items["items"] = { ...v.items.items, type: tipo(v.items.items.type) };
        } else if (items["type"] === "object" && v.items.properties) {
          items["properties"] = convertirPropiedades(v.items.properties);
        }
        p["items"] = items;
      }
    }
    out[k] = p;
  }
  return out;
}

export function herramientaDe(f: FuncionBfcl, lenguaje = "Python 3 syntax"): HerramientaNeutral {
  const parametros: EsquemaJson = {
    ...f.parameters,
    type: "object",
    properties: convertirPropiedades(f.parameters.properties ?? {}),
  };
  return {
    nombre: nombreDeCable(f.name),
    original: f.name,
    descripcion: `${f.description} Note that the provided function is in ${lenguaje}.`,
    parametros,
  };
}

/** Herramientas en el dialecto de Mensajes de Anthropic. */
export function herramientasAnthropic(hs: HerramientaNeutral[]): EsquemaJson[] {
  return hs.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.parametros }));
}

/** Herramientas en el dialecto de Chat Completions. */
export function herramientasOpenAI(hs: HerramientaNeutral[]): EsquemaJson[] {
  return hs.map((h) => ({ type: "function", function: { name: h.nombre, description: h.descripcion, parameters: h.parametros } }));
}
