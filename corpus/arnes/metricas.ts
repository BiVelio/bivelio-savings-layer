/**
 * LAS MÉTRICAS. La frase de aceptación de F6, traducida a números que se pueden
 * discutir: «100 % de conservación de campos críticos en el golden set, citas
 * válidas y accesibles, SIN DEGRADACIÓN POR IDIOMA NI TIPO DOCUMENTAL».
 *
 * ─── LAS CUATRO CIFRAS, Y POR QUÉ NINGUNA SOBRA ─────────────────────────────
 *
 *   1. COBERTURA DE CAMPOS CRÍTICOS — cuántos campos que la respuesta DEBE
 *      contener siguen sostenidos por su evidencia. Es el criterio literal.
 *   2. CITAS CONSERVADAS — una cita a una unidad que no se mandó es una cita
 *      muerta, y una respuesta con citas muertas es indistinguible de una
 *      inventada.
 *   3. TASA DE ABSTENCIÓN CORRECTA — de los 22 casos cuya respuesta correcta es
 *      no responder, en cuántos SIGUE siendo posible abstenerse después de
 *      seleccionar. Un selector que se queda con un solo lado de una
 *      contradicción no pierde información: FABRICA una respuesta. El modelo
 *      contesta con seguridad, bien redactado y citado, lo que ya no tiene
 *      contradicción que lo desmienta.
 *   4. TOKENS AHORRADOS — sin esta, «conserva el 100 %» lo cumple `mandarloTodo`
 *      y la verja no dice nada. Es la única cifra que permite comparar calidad
 *      contra ahorro, que es la única comparación que decide si F6 vale.
 *
 * ─── EL PRESUPUESTO NO ENTRA EN EL APROBADO, Y ES DELIBERADO ────────────────
 *
 * `aprobado` mide CONSERVACIÓN. `dentroDePresupuesto` se informa aparte. Si se
 * mezclaran, el selector por defecto —mandarlo todo— suspendería los 150 casos
 * y la verja no podría distinguir «todavía no hay knapsack» de «el knapsack
 * rompe cosas», que es justo lo que tiene que distinguir el día que F6 se
 * enchufe. Un selector que aprueba sin entrar en presupuesto sale con 0 % de
 * ahorro, y eso se lee en la misma tabla.
 *
 * ─── LA MEDIA MIENTE, Y EL PLAN LO PROHÍBE ──────────────────────────────────
 *
 * `porIdiomaYDominio` es el cruce, no dos listas sueltas. Un catalán al 100 %
 * en soporte y al 60 % en contratos da una media por idioma decente y una media
 * por dominio decente, y esconde exactamente la celda que el plan prohíbe. Lo
 * que se mira primero es `peorCelda`.
 */

import type { TokenEstimator } from "../../src/tokenizer/estimator.js";
import type { CasoDelArnes } from "./cargar.js";
import type { SelectorConChuleta } from "./selectores.js";
import { CONTADOR_POR_DEFECTO, contarTokens, type CuentaDeTokens } from "./tokens.js";
import { trampasCanonicas } from "./trampas.js";

// ─── Por caso ────────────────────────────────────────────────────────────────

export interface ResultadoDelCaso {
  casoId: string;
  idioma: "es" | "ca";
  dominio: string;
  dificultad: string;
  trampas: string[];
  seleccion: string[];
  /** Ids que el selector devolvió y no existen en el caso. Suspende. */
  idsInventados: string[];
  /** Citas obligatorias que el selector tiró. */
  citasMuertas: string[];
  /** Unidades `necesaria` que el selector tiró. */
  necesariasPerdidas: string[];
  camposCriticos: number;
  /** Campos críticos con TODAS sus citas vivas. */
  camposCriticosIntactos: number;
  /** Campos críticos que se quedaron sin NINGUNA cita: el fallo catastrófico. */
  camposCriticosHuerfanos: string[];
  /**
   * `por-campo` cuando el corpus de origen dice qué unidades sostienen CADA
   * campo (solo facturación); `global` cuando solo hay una lista para todo el
   * caso y hay que atribuírsela entera a cada campo.
   */
  granularidadDeCitas: "por-campo" | "global";
  esAbstencion: boolean;
  /** En un caso de abstención: ¿sigue siendo posible abstenerse? */
  abstencionSostenible: boolean;
  /** Por qué dejó de serlo, si dejó de serlo. */
  abstencionRota?: string;
  dentroDePresupuesto: boolean;
  tokens: CuentaDeTokens;
  /** Conserva todo lo que hacía falta. No mira el presupuesto. */
  aprobado: boolean;
}

const enUnaLinea = (ids: readonly string[]): string => ids.slice().sort().join(",");

/**
 * ¿Sigue siendo posible abstenerse después de seleccionar?
 *
 * Dos condiciones, y la segunda no la implica la primera en un caso donde una
 * unidad contradictoria no esté citada:
 *
 *   · Si el caso tiene dos lados contradictorios, sobreviven al menos dos. Con
 *     uno solo la contradicción desaparece y el caso pasa a tener una respuesta
 *     perfectamente defendible que el corpus dice que es incorrecta.
 *   · Sobreviven las citas que ENSEÑAN el hueco o el choque. Abstenerse sin
 *     poder mostrar por qué es callarse.
 *
 * SE COMPRUEBAN EN ESE ORDEN a propósito. En los 150 casos de hoy los dos lados
 * de una contradicción están siempre citados, así que tirar uno rompe las dos
 * condiciones a la vez y el diagnóstico se puede elegir. «Falta una cita» manda
 * a mirar la bibliografía; «sobrevive un solo lado de la contradicción y el
 * selector ha fabricado la respuesta» manda a mirar lo que de verdad pasó. La
 * cita muerta se sigue informando aparte, en `citasMuertas`.
 */
export function abstencionSigueSiendoPosible(
  caso: CasoDelArnes,
  elegidas: ReadonlySet<string>,
): { ok: boolean; motivo?: string } {
  const contradictorias = caso.unidades.filter((u) => u.papel === "contradictoria");
  if (contradictorias.length >= 2) {
    const vivas = contradictorias.filter((u) => elegidas.has(u.id));
    if (vivas.length < 2) {
      return {
        ok: false,
        motivo: `sobrevive un solo lado de la contradicción (${enUnaLinea(vivas.map((u) => u.id))}): el caso pasa a tener respuesta y el selector la ha fabricado`,
      };
    }
  }
  const muertas = caso.citas.filter((id) => !elegidas.has(id));
  if (muertas.length > 0) {
    return {
      ok: false,
      motivo: `se tiraron las citas que enseñan por qué no se puede responder (${enUnaLinea(muertas)})`,
    };
  }
  return { ok: true };
}

/** Puntúa UNA selección contra el caso que la juzga. */
export function puntuarCaso(
  caso: CasoDelArnes,
  seleccion: readonly string[],
  contador: TokenEstimator = CONTADOR_POR_DEFECTO,
): ResultadoDelCaso {
  const existentes = new Set(caso.unidades.map((u) => u.id));
  const idsInventados = [...new Set(seleccion.filter((id) => !existentes.has(id)))];
  const elegidas = new Set(seleccion.filter((id) => existentes.has(id)));

  const citasMuertas = caso.citas.filter((id) => !elegidas.has(id));
  const necesariasPerdidas = caso.necesarias.filter((id) => !elegidas.has(id));

  const criticos = caso.valores.filter((v) => v.critico);
  const porCampo = caso.citasPorCampo;
  const granularidadDeCitas = porCampo ? "por-campo" : "global";
  const citasDe = (campo: string): string[] => porCampo?.[campo] ?? caso.citas;

  let camposCriticosIntactos = 0;
  const camposCriticosHuerfanos: string[] = [];
  for (const v of criticos) {
    const suyas = citasDe(v.campo);
    if (suyas.every((id) => elegidas.has(id))) camposCriticosIntactos += 1;
    if (suyas.length > 0 && !suyas.some((id) => elegidas.has(id))) {
      camposCriticosHuerfanos.push(v.campo);
    }
  }

  const abst = caso.abstencion
    ? abstencionSigueSiendoPosible(caso, elegidas)
    : { ok: true, motivo: undefined };

  const aprobado =
    idsInventados.length === 0 &&
    citasMuertas.length === 0 &&
    necesariasPerdidas.length === 0 &&
    camposCriticosIntactos === criticos.length &&
    abst.ok;

  const resultado: ResultadoDelCaso = {
    casoId: caso.id,
    idioma: caso.idioma,
    dominio: caso.dominio,
    dificultad: caso.dificultad,
    trampas: caso.trampas,
    seleccion: [...elegidas],
    idsInventados,
    citasMuertas,
    necesariasPerdidas,
    camposCriticos: criticos.length,
    camposCriticosIntactos,
    camposCriticosHuerfanos,
    granularidadDeCitas,
    esAbstencion: caso.abstencion,
    abstencionSostenible: abst.ok,
    dentroDePresupuesto: elegidas.size <= caso.presupuestoMax,
    tokens: contarTokens(caso, elegidas, contador),
    aprobado,
  };
  if (abst.motivo) resultado.abstencionRota = abst.motivo;
  return resultado;
}

// ─── Agregados ───────────────────────────────────────────────────────────────

export interface Celda {
  clave: string;
  total: number;
  aprobados: number;
  /** `aprobados / total`. */
  tasa: number;
  camposCriticos: number;
  camposCriticosIntactos: number;
  /** `camposCriticosIntactos / camposCriticos`. El criterio literal de F6. */
  coberturaDeCamposCriticos: number;
  citas: number;
  citasVivas: number;
  citasConservadas: number;
  abstenciones: number;
  abstencionesCorrectas: number;
  /** `abstencionesCorrectas / abstenciones`. `1` si no hay abstenciones. */
  tasaDeAbstencionCorrecta: number;
  fueraDePresupuesto: number;
  tokensTotales: number;
  tokensAhorrados: number;
  /** `tokensAhorrados / tokensTotales`. */
  fraccionAhorrada: number;
}

function celdaVacia(clave: string): Celda {
  return {
    clave,
    total: 0,
    aprobados: 0,
    tasa: 0,
    camposCriticos: 0,
    camposCriticosIntactos: 0,
    coberturaDeCamposCriticos: 1,
    citas: 0,
    citasVivas: 0,
    citasConservadas: 1,
    abstenciones: 0,
    abstencionesCorrectas: 0,
    tasaDeAbstencionCorrecta: 1,
    fueraDePresupuesto: 0,
    tokensTotales: 0,
    tokensAhorrados: 0,
    fraccionAhorrada: 0,
  };
}

function acumular(celda: Celda, caso: CasoDelArnes, r: ResultadoDelCaso): void {
  celda.total += 1;
  if (r.aprobado) celda.aprobados += 1;
  celda.camposCriticos += r.camposCriticos;
  celda.camposCriticosIntactos += r.camposCriticosIntactos;
  celda.citas += caso.citas.length;
  celda.citasVivas += caso.citas.length - r.citasMuertas.length;
  if (r.esAbstencion) {
    celda.abstenciones += 1;
    if (r.abstencionSostenible) celda.abstencionesCorrectas += 1;
  }
  if (!r.dentroDePresupuesto) celda.fueraDePresupuesto += 1;
  celda.tokensTotales += r.tokens.totales;
  celda.tokensAhorrados += r.tokens.ahorrados;
}

function cerrar(celda: Celda): Celda {
  celda.tasa = celda.total === 0 ? 0 : celda.aprobados / celda.total;
  celda.coberturaDeCamposCriticos =
    celda.camposCriticos === 0 ? 1 : celda.camposCriticosIntactos / celda.camposCriticos;
  celda.citasConservadas = celda.citas === 0 ? 1 : celda.citasVivas / celda.citas;
  celda.tasaDeAbstencionCorrecta =
    celda.abstenciones === 0 ? 1 : celda.abstencionesCorrectas / celda.abstenciones;
  celda.fraccionAhorrada =
    celda.tokensTotales === 0 ? 0 : celda.tokensAhorrados / celda.tokensTotales;
  return celda;
}

export interface Informe {
  /** Qué selector produjo esto. Un informe sin nombre no se puede comparar. */
  selector: string;
  contador: { id: string; exacto: boolean };
  global: Celda;
  porIdioma: Celda[];
  porDominio: Celda[];
  /** El CRUCE. Es lo que una media por idioma y otra por dominio esconden. */
  porIdiomaYDominio: Celda[];
  porDificultad: Celda[];
  porTrampa: Celda[];
  /** Cuántos casos traen citas por campo y cuántos solo una lista global. */
  granularidad: { porCampo: number; global: number };
  /** Los casos suspendidos, enteros. Un informe sin los fallos no se puede arreglar. */
  fallos: ResultadoDelCaso[];
  resultados: ResultadoDelCaso[];
}

export interface OpcionesDeInforme {
  nombre?: string;
  contador?: TokenEstimator;
}

/** Corre un selector sobre el corpus entero y devuelve el informe desglosado. */
export function puntuarCorpus(
  casos: readonly CasoDelArnes[],
  seleccionar: SelectorConChuleta,
  opciones: OpcionesDeInforme = {},
): Informe {
  const contador = opciones.contador ?? CONTADOR_POR_DEFECTO;
  const global = celdaVacia("global");
  const mapas: Record<string, Map<string, Celda>> = {
    idioma: new Map(),
    dominio: new Map(),
    cruce: new Map(),
    dificultad: new Map(),
    trampa: new Map(),
  };
  const en = (mapa: string, clave: string): Celda => {
    const m = mapas[mapa]!;
    let c = m.get(clave);
    if (!c) {
      c = celdaVacia(clave);
      m.set(clave, c);
    }
    return c;
  };

  const resultados: ResultadoDelCaso[] = [];
  const granularidad = { porCampo: 0, global: 0 };

  for (const caso of casos) {
    const r = puntuarCaso(caso, seleccionar(caso), contador);
    resultados.push(r);
    if (r.granularidadDeCitas === "por-campo") granularidad.porCampo += 1;
    else granularidad.global += 1;

    acumular(global, caso, r);
    acumular(en("idioma", caso.idioma), caso, r);
    acumular(en("dominio", caso.dominio), caso, r);
    acumular(en("cruce", `${caso.idioma}·${caso.dominio}`), caso, r);
    acumular(en("dificultad", caso.dificultad), caso, r);
    // Canónicas: si no, `apostrof` y `apostrofo` salen en dos filas de dos y
    // parecen dos trampas cubiertas donde hay una sola, mal cubierta.
    for (const t of trampasCanonicas(caso.trampas)) acumular(en("trampa", t), caso, r);
  }

  const lista = (mapa: string): Celda[] =>
    [...mapas[mapa]!.values()].map(cerrar).sort((a, b) => a.clave.localeCompare(b.clave));

  return {
    selector: opciones.nombre ?? "sin nombre",
    contador: { id: contador.id, exacto: contador.exact },
    global: cerrar(global),
    porIdioma: lista("idioma"),
    porDominio: lista("dominio"),
    porIdiomaYDominio: lista("cruce"),
    porDificultad: lista("dificultad"),
    porTrampa: lista("trampa"),
    granularidad,
    fallos: resultados.filter((r) => !r.aprobado),
    resultados,
  };
}

// ─── La frase de aceptación, hecha booleano ──────────────────────────────────

export interface Degradacion {
  /** `idioma`, `dominio` o `idioma×dominio`. */
  eje: string;
  clave: string;
  metrica: string;
  valor: number;
  umbral: number;
}

/**
 * Las celdas que no llegan al umbral, POR EJE. Vacío = «sin degradación por
 * idioma ni por tipo documental».
 *
 * El umbral por defecto es 1: el criterio de F6 dice 100 %, y un 99,3 % global
 * con el catalán de contratos al 88 % es exactamente el informe que el plan
 * prohíbe publicar como aprobado. Se puede bajar para medir un selector en
 * desarrollo, pero entonces el umbral se escribe en el informe y se discute.
 */
export function degradaciones(informe: Informe, umbral = 1): Degradacion[] {
  const salida: Degradacion[] = [];
  const ejes: Array<[string, Celda[]]> = [
    ["idioma", informe.porIdioma],
    ["dominio", informe.porDominio],
    ["idioma×dominio", informe.porIdiomaYDominio],
  ];
  for (const [eje, celdas] of ejes) {
    for (const c of celdas) {
      const metricas: Array<[string, number]> = [
        ["coberturaDeCamposCriticos", c.coberturaDeCamposCriticos],
        ["citasConservadas", c.citasConservadas],
        ["tasaDeAbstencionCorrecta", c.tasaDeAbstencionCorrecta],
      ];
      for (const [metrica, valor] of metricas) {
        if (valor < umbral) salida.push({ eje, clave: c.clave, metrica, valor, umbral });
      }
    }
  }
  return salida;
}

/** La celda del cruce que peor va. Es lo que hay que mirar antes que la media. */
export function peorCelda(informe: Informe): Celda | undefined {
  return [...informe.porIdiomaYDominio].sort(
    (a, b) => a.coberturaDeCamposCriticos - b.coberturaDeCamposCriticos || a.tasa - b.tasa,
  )[0];
}

/** Cuánto separa a la mejor celda del cruce de la peor. Cero = sin brecha. */
export function brecha(informe: Informe): number {
  const valores = informe.porIdiomaYDominio.map((c) => c.coberturaDeCamposCriticos);
  if (valores.length === 0) return 0;
  return Math.max(...valores) - Math.min(...valores);
}
