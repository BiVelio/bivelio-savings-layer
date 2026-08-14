/**
 * LA VISTA ÚNICA. Los tres corpus de dominio se escribieron en paralelo y NO
 * comparten forma: facturación publicó `tipos.ts`, contratos escribió su
 * `forma.ts` «mínima» antes de que la otra existiera, y soporte inventó una
 * tercera. Las tres son razonables y ninguna es la de al lado:
 *
 *   ·  facturación  `evidencia[]`  `presupuesto.unidades_max`  citas POR CAMPO
 *   ·  contratos    `unidades[]`   `presupuesto.maxUnidades`   `citasObligatorias[]`
 *   ·  soporte      `evidencia[]`  ← SIN PRESUPUESTO            `citas[]`
 *
 * Mientras eso siga así, la frase de aceptación de F6 —«sin degradación por
 * idioma NI POR TIPO DOCUMENTAL»— no se puede calcular: no hay una sola cifra
 * que cubra los tres dominios. Este fichero es esa cifra. No reescribe los
 * datos de nadie: los PROYECTA sobre el mínimo común que un arnés necesita para
 * puntuar un selector, y deja constancia de lo que ha tenido que inventar.
 *
 * LO QUE TIENE QUE INVENTAR, y por qué se marca en vez de esconderse: los 40
 * casos de soporte no traen presupuesto. Sin presupuesto no hay knapsack —
 * mandarlo todo es óptimo, gratis y correcto—, así que esos casos, tal y como
 * están escritos, aprueban a CUALQUIER selector que no tire nada. La vista les
 * imputa uno con una regla explícita (`PRESUPUESTO_IMPUTADO`) y marca cada caso
 * con `presupuestoImputado: true`. Una cifra medida sobre un presupuesto
 * imputado no es una cifra que el autor del caso haya elegido, y el informe la
 * separa siempre.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CasoDelCorpus, FicheroDeCasos } from "./tipos.js";
import { citasObligatorias } from "./tipos.js";
import type { CasoDeEvidencia } from "./knapsack-evidencia/forma.js";

export type Origen = "facturacion" | "contratos" | "soporte";

export interface UnidadVista {
  id: string;
  /** `derogada` de contratos se proyecta a `distractora`: se puede tirar. */
  papel: "necesaria" | "distractora" | "contradictoria";
  /** El papel tal y como lo escribió el autor, sin proyectar. */
  papelOriginal: string;
  texto: string;
  /** Posición en la lista tal y como llega del recuperador. 0-indexada. */
  orden: number;
}

export interface CasoVista {
  id: string;
  origen: Origen;
  idioma: "es" | "ca";
  dominio: string;
  dificultad: "facil" | "media" | "dificil";
  trampas: string[];
  consulta: string;
  unidades: UnidadVista[];
  /** Cuántas unidades como mucho puede mandar el selector. */
  presupuestoMax: number;
  /** `true` si el presupuesto no lo escribió el autor: lo puso esta vista. */
  presupuestoImputado: boolean;
  /** Ids con `papel === "necesaria"`. */
  necesarias: string[];
  /** Ids que hay que poder citar. Superconjunto habitual de `necesarias`. */
  citas: string[];
  abstencion: boolean;
  /**
   * Los valores de la respuesta, aplanados a texto. Sirven para una sola cosa:
   * preguntarle al corpus si la respuesta se puede ADIVINAR sin la evidencia.
   */
  valores: Array<{ campo: string; valor: string; critico: boolean }>;
  /**
   * Las citas de CADA campo, cuando el corpus de origen las escribe por campo.
   * Solo facturación lo hace; contratos y soporte declaran una lista global y
   * aquí llega `undefined`. La distinción no es cosmética: sin ella, «campo
   * crítico conservado» solo se puede aproximar con la lista global, y un
   * arnés que no distinga las dos cosas está informando de una cobertura más
   * fina de la que puede medir. `corpus/arnes/metricas.ts` cuenta las dos por
   * separado.
   */
  citasPorCampo?: Record<string, string[]>;
  nota: string;
}

/**
 * La regla de imputación de presupuesto para los casos que no lo traen.
 *
 * `max(necesarias, ceil(total * 0.5))`, y como poco una menos que el total.
 * El 0,5 no sale de ninguna teoría: es la mediana de `unidades_max / total` de
 * los 110 casos que SÍ declaran presupuesto (facturación y contratos). Se usa
 * esa y no un número redondo para que los 40 casos imputados no queden
 * sistemáticamente más flojos ni más duros que el resto, que es lo que
 * convertiría el desglose por dominio en un artefacto.
 *
 * ⚠️ ES UN RESPALDO, NO LA FUENTE. `corpus/auditoria/reparar.ts` ya ESCRIBIÓ un
 * presupuesto dentro de `benchmarks/corpus/soporte/casos.json`, y el fichero de
 * datos manda sobre cualquier recálculo. Esta función se quedó en 0,6 mientras
 * `reparar.ts` escribía con 0,5, así que la vista medía 10 de los 40 casos de
 * soporte contra un presupuesto de 3 que el fichero declaraba como 2 — un
 * cuarto del dominio puntuado contra una cifra que no está escrita en ninguna
 * parte y que nadie eligió. `corpus/arnes/cargar.ts` compara las dos y falla si
 * vuelven a separarse.
 */
export function PRESUPUESTO_IMPUTADO(totalUnidades: number, necesarias: number): number {
  const porFraccion = Math.ceil(totalUnidades * 0.5);
  return Math.min(Math.max(necesarias, porFraccion), Math.max(1, totalUnidades - 1));
}

// ─── Proyecciones ────────────────────────────────────────────────────────────

function valorATexto(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["cantidad", "iso", "valor", "unidad"]) {
      if (k in o) return String(o[k]);
    }
    return JSON.stringify(o);
  }
  return String(v);
}

function deFacturacion(caso: CasoDelCorpus): CasoVista {
  const valores =
    caso.respuesta.tipo === "valor"
      ? caso.respuesta.campos.map((c) => ({
          campo: c.nombre,
          valor: valorATexto(c.valor),
          critico: c.critico,
        }))
      : [{ campo: "abstencion", valor: caso.respuesta.motivo, critico: true }];

  const citasPorCampo: Record<string, string[]> =
    caso.respuesta.tipo === "valor"
      ? Object.fromEntries(caso.respuesta.campos.map((c) => [c.nombre, [...c.citas]]))
      : { abstencion: [...caso.respuesta.citas] };

  return {
    citasPorCampo,
    id: caso.id,
    origen: "facturacion",
    idioma: caso.idioma,
    dominio: "facturacion-y-cobros",
    dificultad: caso.dificultad,
    trampas: caso.trampas,
    consulta: caso.consulta,
    unidades: caso.evidencia.map((u, i) => ({
      id: u.id,
      papel: u.papel,
      papelOriginal: u.papel,
      texto: u.texto,
      orden: i,
    })),
    presupuestoMax: caso.presupuesto.unidades_max,
    presupuestoImputado: false,
    necesarias: caso.evidencia.filter((u) => u.papel === "necesaria").map((u) => u.id),
    citas: citasObligatorias(caso),
    abstencion: caso.respuesta.tipo === "abstencion",
    valores,
    nota: caso.nota ?? "",
  };
}

function deContratos(caso: CasoDeEvidencia): CasoVista {
  const criticos = new Set(caso.camposCriticos);
  return {
    id: caso.id,
    origen: "contratos",
    idioma: caso.idioma,
    dominio: "contratos",
    dificultad: caso.dificultad,
    trampas: caso.trampas,
    consulta: caso.consulta,
    unidades: caso.unidades.map((u, i) => ({
      id: u.id,
      // `derogada` no es un papel de la vista: para el selector es exactamente
      // lo mismo que una distractora — se puede tirar sin perder nada — y
      // mantenerla aparte haría que las cifras de dos dominios no se sumaran.
      papel: u.papel === "derogada" ? "distractora" : u.papel,
      papelOriginal: u.papel,
      texto: u.texto,
      orden: i,
    })),
    presupuestoMax: caso.presupuesto.maxUnidades,
    presupuestoImputado: false,
    necesarias: caso.unidades.filter((u) => u.papel === "necesaria").map((u) => u.id),
    citas: caso.citasObligatorias,
    abstencion: caso.respuesta.abstenerse,
    valores: Object.entries(caso.respuesta.campos).map(([campo, valor]) => ({
      campo,
      valor: valorATexto(valor),
      critico: criticos.has(campo),
    })),
    nota: caso.nota,
  };
}

/** La forma de soporte, escrita aquí porque su corpus no exporta tipos. */
interface CasoSoporte {
  id: string;
  idioma: "es" | "ca";
  dominio: string;
  subdominio: string;
  dificultad: "facil" | "media" | "dificil";
  trampas: string[];
  consulta: string;
  evidencia: Array<{ id: string; papel: string; texto: string }>;
  respuesta:
    | { tipo: "estructurada"; campos: Record<string, unknown> }
    | { tipo: "abstencion"; motivo: string; falta?: string };
  camposCriticos: string[];
  citas: string[];
  abstencion: unknown;
  /** Lo escribió `corpus/auditoria/reparar.ts`, no el autor del caso. */
  presupuesto?: { unidades_max: number };
  nota: string;
}

function deSoporte(caso: CasoSoporte): CasoVista {
  const criticos = new Set(caso.camposCriticos);
  const necesarias = caso.evidencia.filter((u) => u.papel === "necesaria").map((u) => u.id);
  const campos =
    caso.respuesta.tipo === "estructurada"
      ? Object.entries(caso.respuesta.campos)
      : Object.entries(caso.respuesta as Record<string, unknown>).filter(([k]) => k !== "tipo");

  return {
    id: caso.id,
    origen: "soporte",
    idioma: caso.idioma,
    dominio: "soporte-y-politicas",
    dificultad: caso.dificultad,
    trampas: caso.trampas,
    consulta: caso.consulta,
    unidades: caso.evidencia.map((u, i) => ({
      id: u.id,
      papel: u.papel as UnidadVista["papel"],
      papelOriginal: u.papel,
      texto: u.texto,
      orden: i,
    })),
    // El fichero manda. `reparar.ts` ya escribió el presupuesto dentro del JSON
    // y recalcularlo aquí era medir contra una cifra que no está en ningún
    // sitio: las dos reglas se separaron (0,5 contra 0,6) y 10 de los 40 casos
    // se puntuaban con un presupuesto de 3 cuando el fichero decía 2.
    presupuestoMax:
      caso.presupuesto?.unidades_max ??
      PRESUPUESTO_IMPUTADO(caso.evidencia.length, necesarias.length),
    // Sigue siendo `true`: lo puso un script, no el autor del caso.
    presupuestoImputado: true,
    necesarias,
    citas: caso.citas ?? [],
    abstencion: caso.respuesta.tipo === "abstencion",
    valores: campos.map(([campo, valor]) => ({
      campo,
      valor: valorATexto(valor),
      critico: criticos.has(campo),
    })),
    nota: caso.nota ?? "",
  };
}

// ─── Carga ───────────────────────────────────────────────────────────────────

const leer = (ruta: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), "utf8"));

/** Los 150 casos de los tres dominios, en una sola lista comparable. */
export function cargarCorpusEntero(): CasoVista[] {
  const fac = ["./facturacion-y-cobros/casos-es.json", "./facturacion-y-cobros/casos-ca.json"]
    .flatMap((r) => (leer(r) as FicheroDeCasos).casos)
    .map(deFacturacion);

  const ct = [
    "./knapsack-evidencia/contratos/contratos.es.json",
    "./knapsack-evidencia/contratos/contratos.ca.json",
  ]
    .flatMap((r) => leer(r) as CasoDeEvidencia[])
    .map(deContratos);

  const sop = ((leer("../benchmarks/corpus/soporte/casos.json") as { casos: CasoSoporte[] }).casos)
    .map(deSoporte);

  return [...fac, ...ct, ...sop];
}

/** Un caso de la clase incómoda. Es la forma de facturación con dos añadidos. */
export interface CasoIncomodo extends CasoVista {
  /** La familia del agujero: `presupuesto-insuficiente`, `evidencia-por-ausencia`, … */
  clase: string;
  /** Por qué hoy no sabríamos resolverlo. Es el contenido del caso, no un adorno. */
  porQueNoSabemosResolverlo: string;
  /** `true` cuando necesarias > presupuesto: NO existe selección correcta. */
  irresoluble: boolean;
}

/**
 * Los casos de la clase incómoda. Viven aparte y NUNCA se agregan con los 150:
 * rompen a propósito el invariante `necesarias <= unidades_max`, así que
 * mezclados solo bajarían la nota sin decir por qué. Se corren y se leen solos.
 */
export function cargarClaseIncomoda(): CasoIncomodo[] {
  const f = leer("./clase-incomoda/casos.json") as {
    casos: Array<CasoDelCorpus & { clase: string; porQueNoSabemosResolverlo: string }>;
  };
  return f.casos.map((c) => {
    const base = deFacturacion(c);
    return {
      ...base,
      dominio: "clase-incomoda",
      clase: c.clase,
      porQueNoSabemosResolverlo: c.porQueNoSabemosResolverlo,
      irresoluble: base.necesarias.length > base.presupuestoMax,
    };
  });
}
