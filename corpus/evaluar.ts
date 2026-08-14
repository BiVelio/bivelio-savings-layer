/**
 * EL PUNTUADOR DEL CORPUS. No es el knapsack: es la regla contra la que se
 * puntúa un knapsack cualquiera, escrita ANTES de que exista, para que nadie
 * pueda ajustarla al algoritmo que salga.
 *
 * Traduce el criterio de aceptación de F6 —«100 % de conservación de campos
 * críticos en el golden set, citas válidas y accesibles, sin degradación por
 * idioma ni tipo documental»— a algo que devuelve `true` o `false` por caso.
 *
 * LA CIFRA QUE HAY QUE MIRAR PRIMERO NO ES LA TASA DE APROBADOS. Es
 * `invertidos`: los casos donde el selector tiró la unidad que MANDA y se quedó
 * con la que quedaba derogada. Ahí el modelo no se queda corto ni pide más
 * contexto: contesta, con una respuesta bien formada, lo contrario de lo
 * correcto. Un fallo por quedarse sin evidencia lo ve el cliente; este no.
 */

import {
  camposCriticos,
  citasObligatorias,
  type CasoDelCorpus,
} from "./tipos.js";

export interface ResultadoDeSeleccion {
  casoId: string;
  /** Lo seleccionado cabe en `presupuesto.unidades_max`. */
  dentroDePresupuesto: boolean;
  /** Sobrevive TODA la evidencia que sostiene algún campo crítico. */
  conservaCriticos: boolean;
  /** Unidades obligatorias que el selector tiró. */
  faltan: string[];
  /** Campos críticos que se quedan sin una sola cita accesible. */
  camposHuerfanos: string[];
  /** Distractoras que sobrevivieron: no invalidan la respuesta, se pagan en tokens. */
  distractorasRetenidas: string[];
  /**
   * ⚠️ El fallo caro: la unidad que manda se tiró y la desplazada sobrevivió.
   * La respuesta sale bien formada y dice lo contrario de lo correcto.
   */
  invertidaPorContradiccion: boolean;
  aprobado: boolean;
}

/** Puntúa UNA selección de ids de unidades contra el caso que la juzga. */
export function evaluarSeleccion(caso: CasoDelCorpus, seleccion: string[]): ResultadoDeSeleccion {
  const elegidas = new Set(seleccion);
  const obligatorias = citasObligatorias(caso);
  const faltan = obligatorias.filter((id) => !elegidas.has(id));

  const camposHuerfanos = camposCriticos(caso)
    .filter((c) => !c.citas.some((id) => elegidas.has(id)))
    .map((c) => c.nombre);

  const distractorasRetenidas = caso.evidencia
    .filter((u) => u.papel === "distractora" && elegidas.has(u.id))
    .map((u) => u.id);

  const d = caso.desempate;
  const invertidaPorContradiccion =
    !!d &&
    d.regla !== "ninguna" &&
    !!d.ganadora &&
    !elegidas.has(d.ganadora) &&
    d.desplazadas.some((id) => elegidas.has(id));

  const dentroDePresupuesto = elegidas.size <= caso.presupuesto.unidades_max;
  const conservaCriticos = faltan.length === 0 && camposHuerfanos.length === 0;

  return {
    casoId: caso.id,
    dentroDePresupuesto,
    conservaCriticos,
    faltan,
    camposHuerfanos,
    distractorasRetenidas,
    invertidaPorContradiccion,
    aprobado: dentroDePresupuesto && conservaCriticos && !invertidaPorContradiccion,
  };
}

/** Lo que un selector tiene que ser: del caso a los ids que se mandan al modelo. */
export type Selector = (caso: CasoDelCorpus) => string[];

export interface Desglose {
  total: number;
  aprobados: number;
  invertidos: number;
}

export interface InformeDelCorpus {
  total: number;
  aprobados: number;
  /** Casos donde ganó la unidad derogada. Se informa aparte SIEMPRE. */
  invertidos: number;
  /** Casos que se pasaron del presupuesto: el ahorro no se materializó. */
  fueraDePresupuesto: number;
  /** Unidades distractoras retenidas, sumadas: los tokens que se pagaron de más. */
  distractorasRetenidas: number;
  /** Sin degradación por idioma es un requisito, no un extra: aquí se ve. */
  porIdioma: Record<string, Desglose>;
  porDificultad: Record<string, Desglose>;
  porTrampa: Record<string, Desglose>;
  fallos: ResultadoDeSeleccion[];
}

function suma(mapa: Record<string, Desglose>, clave: string, r: ResultadoDeSeleccion): void {
  const d = (mapa[clave] ??= { total: 0, aprobados: 0, invertidos: 0 });
  d.total += 1;
  if (r.aprobado) d.aprobados += 1;
  if (r.invertidaPorContradiccion) d.invertidos += 1;
}

/** Corre un selector sobre el corpus entero y devuelve el informe desglosado. */
export function evaluarCorpus(casos: CasoDelCorpus[], seleccionar: Selector): InformeDelCorpus {
  const informe: InformeDelCorpus = {
    total: casos.length,
    aprobados: 0,
    invertidos: 0,
    fueraDePresupuesto: 0,
    distractorasRetenidas: 0,
    porIdioma: {},
    porDificultad: {},
    porTrampa: {},
    fallos: [],
  };

  for (const caso of casos) {
    const r = evaluarSeleccion(caso, seleccionar(caso));
    if (r.aprobado) informe.aprobados += 1;
    else informe.fallos.push(r);
    if (r.invertidaPorContradiccion) informe.invertidos += 1;
    if (!r.dentroDePresupuesto) informe.fueraDePresupuesto += 1;
    informe.distractorasRetenidas += r.distractorasRetenidas.length;
    suma(informe.porIdioma, caso.idioma, r);
    suma(informe.porDificultad, caso.dificultad, r);
    for (const t of caso.trampas) suma(informe.porTrampa, t, r);
  }

  return informe;
}
