// ═══════════════════════════════════════════════════════════════════════════
// LA CALIBRACIÓN DE LA CACHÉ SEMÁNTICA: EL SUELO LO FIJAN LAS ETIQUETAS, NO UN 0,85.
// ═══════════════════════════════════════════════════════════════════════════
//
// Módulo INTERNO (nombres en español; no se reexporta desde `cache/index.ts`).
// Lo usan `calibration.ts` (la función pública fuera de línea) y `semantic.ts`
// (la calibración en línea). Todo puro: ni E/S ni reloj ni azar.
//
// QUÉ SE GARANTIZA, Y CON QUÉ SUPUESTOS. El informe de investigación
// (docs/investigacion/2026-09-27/cache-semantica-calibrada.md) lo razona entero;
// aquí va lo que hace falta para leer el código:
//
//   · La hipótesis nula de un umbral t es «entre las reutilizaciones con
//     puntuación ≥ t, la tasa de erróneas supera δ». Certificar t = rechazarla.
//   · Las etiquetas se reparten en DOS mitades independientes de su contenido
//     (paridad de llegada en línea; moneda con semilla fuera de línea). La mitad
//     de SELECCIÓN elige el candidato; la mitad RETENIDA lo pone a prueba con un
//     test binomial exacto (equivalente a la cota de Clopper-Pearson). Como el
//     candidato no ha visto la mitad retenida, la prueba es exacta y la
//     afirmación es sobre la población, no sobre la muestra: con probabilidad
//     ≥ 1−α, la tasa de reutilizaciones erróneas a partir del suelo es ≤ δ.
//   · En línea se mira muchas veces: la mirada k llega con ⌈L0·1,5^k⌉
//     etiquetas (L0 = las que la primera necesita, por dos) y gasta
//     α_k = 6α/(π²(k+1)²) del presupuesto, que suma α (serie de Basilea): la
//     confianza vale para TODA la vida de la caché, no solo para una mirada.
//     Con miradas equiespaciadas α_k caería como 1/n²; en progresión
//     geométrica cae como 1/log²(n). La razón 1,5 es un término medio entre
//     ese ahorro y el retraso (de hasta un 50 %) en ver un suelo que ya se
//     podía certificar. En el stream de LmArena, cada vez y ×2 dieron la
//     primera certificación en sitios parecidos: no hay una razón óptima que
//     medir ahí, y esta no se vende como tal.
//   · La selección no propone UN candidato sino una escalera: el umbral más
//     bajo que ella sola certificaría a α, α/4, α/16, α/64 y α/256 (cuanto más
//     estricto, más alto). Con uno solo —el más agresivo— la mitad retenida lo
//     tumbaba casi la mitad de las veces, porque se elegía justo en la
//     frontera: medido por Monte Carlo con verdad conocida, certificaba en 166
//     de 300 tiradas. Los peldaños (y el suelo que venía de antes) se prueban
//     en SECUENCIA FIJA, del más conservador al más agresivo, y se para en el
//     primero que no pasa (Learn-then-Test, arXiv 2110.01052): no hace falta
//     repartir α entre ellos, porque ninguno ha visto la mitad retenida.
//   · Supuestos: el tráfico es intercambiable (i.i.d.) mientras dura la
//     calibración, y una respuesta guardada no es MÁS probable que esté mal a
//     mayor puntuación (el mismo supuesto que hace de cualquier umbral algo con
//     sentido). Con ese segundo supuesto, que en línea se etiqueten todas las
//     candidatas bajo el suelo y solo una muestra por encima solo puede hacer
//     la prueba MÁS exigente, nunca más laxa.
//   · Lo «correcto» lo decide el juez (`judge`). La garantía es tan buena como
//     él: con el juez por defecto, «correcta» = idéntica.

import type {
  SemanticCalibrationSegmentState,
  SemanticCalibrationState,
} from "./calibration.js";

/** La rejilla es FIJA y previa a los datos: 1.001 umbrales, 0,000 … 1,000. */
export const PASOS_REJILLA = 1000;

/** El índice de rejilla de una puntuación; −1 si no puede certificarse nunca. */
export function indiceEnRejilla(puntuacion: number): number {
  if (!Number.isFinite(puntuacion) || puntuacion < 0) return -1;
  if (puntuacion >= 1) return PASOS_REJILLA;
  // El épsilon absorbe el ruido de coma flotante de 0,85 * 1000 = 849,999…
  return Math.floor(puntuacion * PASOS_REJILLA + 1e-9);
}

export const umbralDeIndice = (i: number): number => i / PASOS_REJILLA;

/**
 * P(Bin(n, p) ≤ e): el valor p exacto contra «la tasa de erróneas es p o más».
 * En escala logarítmica, porque (1−p)^n se va a cero con n de miles.
 */
export function colaInferiorBinomial(n: number, e: number, p: number): number {
  if (e >= n) return 1;
  if (e < 0) return 0;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let termino = n * lq;
  const terminos = [termino];
  let max = termino;
  for (let k = 0; k < e; k++) {
    termino += Math.log(n - k) - Math.log(k + 1) + lp - lq;
    terminos.push(termino);
    if (termino > max) max = termino;
  }
  let suma = 0;
  for (const t of terminos) suma += Math.exp(t - max);
  return Math.min(1, Math.exp(max + Math.log(suma)));
}

/** ¿Rechaza el test binomial exacto «tasa > δ» con `e` erróneas de `n`, a nivel α? */
export function certifica(n: number, e: number, delta: number, alfa: number): boolean {
  if (n <= 0) return false;
  // Con e ≥ nδ el valor p ronda o supera 1/2: ni se calcula.
  if (e >= n * delta) return false;
  return colaInferiorBinomial(n, e, delta) <= alfa;
}

/** Las etiquetas retenidas, TODAS correctas, que hacen falta para certificar algo. */
export function etiquetasMinimas(delta: number, alfa: number): number {
  return Math.ceil(Math.log(alfa) / Math.log1p(-delta));
}

/** El trozo de α que gasta la mirada k (k = 0, 1, …): suma α entre todas. */
export function alfaDeMirada(alfa: number, k: number): number {
  return (6 * alfa) / (Math.PI * Math.PI * (k + 1) * (k + 1));
}

/** Etiquetas por umbral de la rejilla: cuántas y cuántas erróneas. */
export class Histograma {
  readonly total = new Uint32Array(PASOS_REJILLA + 1);
  readonly erroneas = new Uint32Array(PASOS_REJILLA + 1);
  n = 0;

  anotar(indice: number, correcta: boolean): void {
    this.total[indice]!++;
    if (!correcta) this.erroneas[indice]!++;
    this.n++;
  }

  copiarDe(otro: Histograma): void {
    this.total.set(otro.total);
    this.erroneas.set(otro.erroneas);
    this.n = otro.n;
  }

  /** Acumulados desde arriba: en [i] van las etiquetas con índice ≥ i. */
  acumulados(): { n: Uint32Array; e: Uint32Array } {
    const n = new Uint32Array(PASOS_REJILLA + 2);
    const e = new Uint32Array(PASOS_REJILLA + 2);
    for (let i = PASOS_REJILLA; i >= 0; i--) {
      n[i] = n[i + 1]! + this.total[i]!;
      e[i] = e[i + 1]! + this.erroneas[i]!;
    }
    return { n, e };
  }
}

/**
 * El candidato de la mitad de SELECCIÓN: el umbral más bajo que esa mitad, por
 * sí sola, certificaría. Solo mira la selección, así que puede ser tan agresivo
 * como quiera: quien decide es la mitad retenida.
 */
export function candidatoDeSeleccion(h: Histograma, delta: number, alfa: number): number | null {
  const { n, e } = h.acumulados();
  let mejor: number | null = null;
  for (let i = PASOS_REJILLA; i >= 0; i--) {
    if (certifica(n[i]!, e[i]!, delta, alfa)) mejor = i;
  }
  if (mejor == null) return null;
  // Por debajo de la puntuación más baja que se ha visto, todos los umbrales
  // cuentan las mismas etiquetas: se sube hasta ella. Si no, el suelo saldría
  // 0,000 —cierto, pero ilegible— cuando lo que manda es el suelo de similitud.
  while (mejor < PASOS_REJILLA && h.total[mejor] === 0) mejor++;
  return mejor;
}

/** La escalera de candidatos de la selección: a α, α/4, α/16, α/64 y α/256. */
export function candidatosDeSeleccion(h: Histograma, delta: number, alfa: number): number[] {
  const out: number[] = [];
  for (const f of [1, 1 / 4, 1 / 16, 1 / 64, 1 / 256]) {
    const c = candidatoDeSeleccion(h, delta, alfa * f);
    if (c != null) out.push(c);
  }
  return out;
}

export interface Certificado {
  indice: number;
  /** Etiquetas retenidas con puntuación ≥ el suelo, y cuántas erróneas. */
  retenidas: number;
  erroneas: number;
}

/**
 * Secuencia fija sobre la mitad RETENIDA: los candidatos, del umbral más alto
 * al más bajo; se queda el último que pasa y se para en el primero que no.
 */
export function secuenciaFija(
  h: Histograma,
  candidatos: readonly number[],
  delta: number,
  alfa: number,
): Certificado | null {
  const { n, e } = h.acumulados();
  const orden = [...new Set(candidatos)].sort((a, b) => b - a);
  let ultimo: Certificado | null = null;
  for (const c of orden) {
    if (!certifica(n[c]!, e[c]!, delta, alfa)) break;
    ultimo = { indice: c, retenidas: n[c]!, erroneas: e[c]! };
  }
  return ultimo;
}

/**
 * La calibración EN LÍNEA de un segmento de tráfico. Recibe etiquetas
 * (puntuación, correcta) y, cada vez que crecen la mitad, vuelve a probar el suelo.
 */
export class EstadoDeCalibracion {
  private readonly seleccion = new Histograma();
  private readonly retenida = new Histograma();
  private etiquetas = 0;
  private miradas = 0;
  private candidatoPrevio: number | null = null;
  private certificado: Certificado | null = null;
  /** Etiquetas de la primera mirada: las que la mitad retenida necesita para ella, por dos. */
  readonly primeraMirada: number;

  constructor(
    readonly delta: number,
    readonly alfa: number,
  ) {
    this.primeraMirada = 2 * etiquetasMinimas(delta, alfaDeMirada(alfa, 0));
  }

  /** Cuántas etiquetas hacen falta para la mirada k: ⌈L0·1,5^k⌉. */
  etiquetasDeLaMirada(k: number): number {
    return umbralDeMirada(this.primeraMirada, k);
  }

  /**
   * TODO lo que hace falta para seguir exactamente donde se quedó: las dos
   * mitades por separado, cuántas miradas se hicieron (o sea, cuánto α se ha
   * gastado ya), el candidato que venía de antes y el certificado vigente.
   * Restaurarlo y seguir anotando da, etiqueta a etiqueta, los mismos suelos
   * que no haber parado nunca (lo fija el test de Monte Carlo con reinicios).
   */
  exportar(): SemanticCalibrationSegmentState {
    return {
      labeled: this.etiquetas,
      looks: this.miradas,
      previousCandidate: this.candidatoPrevio,
      certified: this.certificado
        ? {
            floorIndex: this.certificado.indice,
            heldOut: this.certificado.retenidas,
            wrong: this.certificado.erroneas,
          }
        : null,
      selection: dispersar(this.seleccion),
      heldOut: dispersar(this.retenida),
    };
  }

  /**
   * El inverso de `exportar`, VALIDADO. Todo lo que no cuadre se rechaza con
   * `CalibrationStateError`: un estado que no se puede defender no se usa.
   *
   * LO QUE IMPORTA DE VERDAD: `looks` no se lee, se COMPRUEBA. Es función de
   * `labeled` (una mirada por cada umbral ⌈L0·1,5^k⌉ alcanzado), y si un
   * estado pudiera traer menos miradas de las que sus etiquetas ya gastaron,
   * la siguiente mirada volvería a gastar el α de la primera —el trozo más
   * gordo, 6α/π²— sobre datos que ya se miraron. Reiniciar el gasto de α en
   * cada arranque es exactamente lo que rompería la garantía.
   */
  static restaurar(
    delta: number,
    alfa: number,
    datos: unknown,
    donde: string,
  ): EstadoDeCalibracion {
    const e = new EstadoDeCalibracion(delta, alfa);
    const mal = (que: string): never => {
      throw new CalibrationStateError(`importCalibration: ${donde}: ${que}`);
    };
    if (datos === null || typeof datos !== "object" || Array.isArray(datos)) mal("not an object");
    const d = datos as Record<string, unknown>;
    const labeled = d["labeled"];
    if (!esEnteroNoNegativo(labeled)) mal("`labeled` must be a non-negative integer");
    const n = labeled as number;
    const seleccion = leerHistograma(d["selection"], `${donde}.selection`);
    const retenida = leerHistograma(d["heldOut"], `${donde}.heldOut`);
    // La paridad de llegada reparte: la etiqueta i va a la selección si i es
    // par. Con `n` etiquetas, ⌈n/2⌉ en una mitad y ⌊n/2⌋ en la otra, siempre.
    if (seleccion.n !== Math.ceil(n / 2) || retenida.n !== Math.floor(n / 2)) {
      mal(
        `the two halves hold ${seleccion.n} and ${retenida.n} labels, but ${n} labels split by arrival ` +
          `order give ${Math.ceil(n / 2)} and ${Math.floor(n / 2)}`,
      );
    }
    const miradasEsperadas = miradasTras(e.primeraMirada, n);
    if (d["looks"] !== miradasEsperadas) {
      mal(
        `\`looks\` is ${String(d["looks"])}, but ${n} labels have already spent ${miradasEsperadas} tests ` +
          `of the confidence budget; a state cannot start that spending over`,
      );
    }
    const previo = d["previousCandidate"];
    if (previo !== null && !esIndiceDeRejilla(previo)) mal("`previousCandidate` must be null or a grid index");
    const cert = d["certified"];
    let certificado: Certificado | null = null;
    if (cert !== null) {
      if (cert === undefined || typeof cert !== "object" || Array.isArray(cert)) mal("`certified` must be null or an object");
      const c = cert as Record<string, unknown>;
      if (!esIndiceDeRejilla(c["floorIndex"])) mal("`certified.floorIndex` must be a grid index");
      if (!esEnteroNoNegativo(c["heldOut"]) || !esEnteroNoNegativo(c["wrong"])) {
        mal("`certified.heldOut` and `certified.wrong` must be non-negative integers");
      }
      certificado = {
        indice: c["floorIndex"] as number,
        retenidas: c["heldOut"] as number,
        erroneas: c["wrong"] as number,
      };
      if (miradasEsperadas === 0) mal("a floor is certified but no test has run yet");
      if (previo !== certificado.indice) mal("`previousCandidate` must be the certified floor");
      // El certificado lo dio la ÚLTIMA mirada, con su trozo de α y con las
      // retenidas que había entonces: tiene que pasar ESE test, y lo llegado
      // después solo puede sumar por encima del suelo, nunca restar.
      const ultima = miradasEsperadas - 1;
      const enLaMirada = umbralDeMirada(e.primeraMirada, ultima);
      const retenidasEnLaMirada = Math.floor(enLaMirada / 2);
      if (certificado.retenidas > retenidasEnLaMirada || certificado.erroneas > certificado.retenidas) {
        mal("the certificate counts more held-out labels than there were when it was issued");
      }
      if (!certifica(certificado.retenidas, certificado.erroneas, delta, alfaDeMirada(alfa, ultima))) {
        mal("the certificate does not pass the test it claims to have passed");
      }
      const { n: nAcum, e: eAcum } = retenida.acumulados();
      const masN = nAcum[certificado.indice]! - certificado.retenidas;
      const masE = eAcum[certificado.indice]! - certificado.erroneas;
      if (masN < 0 || masE < 0 || masE > masN || masN > retenida.n - retenidasEnLaMirada) {
        mal("the held-out labels at the floor do not extend the ones the certificate counted");
      }
    } else if (miradasEsperadas === 0 && previo !== null) {
      mal("`previousCandidate` is set but no test has run yet");
    }
    e.seleccion.copiarDe(seleccion);
    e.retenida.copiarDe(retenida);
    e.etiquetas = n;
    e.miradas = miradasEsperadas;
    e.candidatoPrevio = previo as number | null;
    e.certificado = certificado;
    return e;
  }

  anotar(puntuacion: number, correcta: boolean): void {
    const i = indiceEnRejilla(puntuacion);
    if (i < 0) return;
    // La paridad de LLEGADA reparte: no depende de la etiqueta, y con tráfico
    // intercambiable las dos mitades son muestras independientes.
    (this.etiquetas % 2 === 0 ? this.seleccion : this.retenida).anotar(i, correcta);
    this.etiquetas++;
    if (this.etiquetas >= this.etiquetasDeLaMirada(this.miradas)) this.mirar();
  }

  private mirar(): void {
    const alfaK = alfaDeMirada(this.alfa, this.miradas);
    this.miradas++;
    const escalera = candidatosDeSeleccion(this.seleccion, this.delta, alfaK);
    // Todos los candidatos salen SOLO de la selección (el previo también lo
    // eligió ella), así que ninguno ha visto la mitad retenida que los juzga.
    const candidatos = this.candidatoPrevio == null ? escalera : [...escalera, this.candidatoPrevio];
    const r = secuenciaFija(this.retenida, candidatos, this.delta, alfaK);
    this.certificado = r;
    this.candidatoPrevio = r?.indice ?? escalera[escalera.length - 1] ?? this.candidatoPrevio;
  }

  /** El suelo certificado (índice de rejilla), o null mientras no haya ninguno. */
  get suelo(): number | null {
    return this.certificado?.indice ?? null;
  }

  resumen(): {
    suelo: number | null;
    etiquetas: number;
    retenidas: number;
    retenidasEnSuelo: number;
    erroneasEnSuelo: number;
    miradas: number;
    minimasParaLaSiguiente: number;
    etiquetasParaLaSiguiente: number;
  } {
    return {
      suelo: this.suelo,
      etiquetas: this.etiquetas,
      retenidas: this.retenida.n,
      retenidasEnSuelo: this.certificado?.retenidas ?? 0,
      erroneasEnSuelo: this.certificado?.erroneas ?? 0,
      miradas: this.miradas,
      minimasParaLaSiguiente: etiquetasMinimas(this.delta, alfaDeMirada(this.alfa, this.miradas)),
      etiquetasParaLaSiguiente: this.etiquetasDeLaMirada(this.miradas),
    };
  }
}

// ── EL ESTADO QUE SOBREVIVE A UN REINICIO ───────────────────────────────────
//
// En serverless cada instancia vive una petición o unos minutos, y en un
// servidor cada despliegue es un reinicio: con el estado solo en memoria, la
// calibración volvía a empezar cada vez y el arranque en frío (miles de
// etiquetas) se pagaba otra vez. Exportarlo y restaurarlo lo evita SIN tocar la
// garantía, porque lo que se guarda es el experimento entero, no un resumen:
//
//   · las dos mitades POR SEPARADO: la retenida nunca se mezcla con la de
//     selección, así que ningún candidato futuro la habrá visto;
//   · el número de miradas, que es cuánto α se ha gastado ya. Se valida contra
//     el número de etiquetas: no se puede volver a gastar el de la primera;
//   · el candidato previo y el certificado vigente, que es lo que se sirve.
//
// Y lo que NO cubre, dicho en el README y en el JSDoc: la garantía es de UNA
// línea de historia. Dos procesos que siguen a la vez desde el mismo estado son
// dos experimentos que gastan el mismo α restante; cada uno mantiene su cota,
// pero la probabilidad de que ALGUNO certifique un suelo malo crece con cuántos
// lo hagan. Eso no se puede impedir desde dentro sin un almacén con escritura
// condicional; se documenta.

/**
 * Thrown by `importCalibration` / `exportCalibration` when a calibration state
 * cannot be used as-is: another embedder, verifier, judge or configuration, a
 * newer format, or numbers that do not add up.
 */
export class CalibrationStateError extends Error {
  constructor(message: string) {
    super(`[bvsala] ${message}`);
    this.name = "CalibrationStateError";
  }
}

/** Qué se guarda en `format`. Un estado de otra cosa no se lee. */
export const FORMATO_DEL_ESTADO = "bvsala.semantic-calibration";
/**
 * Versión del estado. SUBIRLA si cambia el test, la rejilla, la escalera de
 * candidatos, el reparto de α o el calendario de miradas: un estado de otro
 * método no dice nada del de ahora, y leerlo mezclaría dos experimentos.
 */
export const VERSION_DEL_ESTADO = 1;

/** Quién puntúa y quién juzga, y los números del test: lo que un estado tiene que compartir con la caché que lo importa. */
export interface IdentidadDeCalibracion {
  embedder: string;
  verifier: string | null;
  judge: string;
  backend?: string;
  maxErrorRate: number;
  confidence: number;
  similarityThreshold: number;
}

const SEGMENTOS = ["single_shot", "agentic"] as const;
type Segmento = (typeof SEGMENTOS)[number];

export function escribirEstado(
  id: IdentidadDeCalibracion,
  estados: ReadonlyMap<Segmento, EstadoDeCalibracion>,
): SemanticCalibrationState {
  const segments: SemanticCalibrationState["segments"] = {};
  for (const s of SEGMENTOS) {
    const e = estados.get(s);
    if (e) segments[s] = e.exportar();
  }
  return {
    format: FORMATO_DEL_ESTADO,
    version: VERSION_DEL_ESTADO,
    embedder: id.embedder,
    verifier: id.verifier,
    judge: id.judge,
    ...(id.backend !== undefined ? { backend: id.backend } : {}),
    config: {
      maxErrorRate: id.maxErrorRate,
      confidence: id.confidence,
      similarityThreshold: id.similarityThreshold,
      grid: PASOS_REJILLA,
    },
    segments,
  };
}

/**
 * Lee un estado exportado y lo convierte en los estados en línea de cada
 * segmento, o rechaza. Todo o nada: si algo falla no se devuelve nada.
 */
export function leerEstado(datos: unknown, id: IdentidadDeCalibracion): Map<Segmento, EstadoDeCalibracion> {
  const mal = (que: string): never => {
    throw new CalibrationStateError(`importCalibration: ${que}`);
  };
  if (datos === null || typeof datos !== "object" || Array.isArray(datos)) mal("the state must be an object");
  const d = datos as Record<string, unknown>;
  if (d["format"] !== FORMATO_DEL_ESTADO) mal(`not a semantic calibration state (format ${JSON.stringify(d["format"])})`);
  const v = d["version"];
  if (typeof v === "number" && v > VERSION_DEL_ESTADO) {
    mal(`this state was exported by a newer SDK (version ${v}); this one reads version ${VERSION_DEL_ESTADO}`);
  }
  if (v !== VERSION_DEL_ESTADO) mal(`unknown state version ${JSON.stringify(v)}`);
  const config = (d["config"] ?? {}) as Record<string, unknown>;
  const distintos: string[] = [];
  const comparar = (nombre: string, guardado: unknown, aqui: unknown) => {
    if (guardado !== aqui) distintos.push(`${nombre}: ${JSON.stringify(guardado)} in the state, ${JSON.stringify(aqui)} here`);
  };
  comparar("embedder", d["embedder"], id.embedder);
  comparar("verifier", d["verifier"], id.verifier);
  comparar("judge", d["judge"], id.judge);
  comparar("backend", d["backend"] ?? null, id.backend ?? null);
  comparar("maxErrorRate", config["maxErrorRate"], id.maxErrorRate);
  comparar("confidence", config["confidence"], id.confidence);
  comparar("similarityThreshold", config["similarityThreshold"], id.similarityThreshold);
  comparar("grid", config["grid"], PASOS_REJILLA);
  if (distintos.length > 0) {
    mal(
      `the state was recorded under a different setup (${distintos.join("; ")}). A floor certified ` +
        "under one setup says nothing about another: start a new calibration instead",
    );
  }
  const segs = d["segments"];
  if (segs === null || typeof segs !== "object" || Array.isArray(segs)) mal("`segments` must be an object");
  const out = new Map<Segmento, EstadoDeCalibracion>();
  for (const [nombre, valor] of Object.entries(segs as Record<string, unknown>)) {
    if (!(SEGMENTOS as readonly string[]).includes(nombre)) mal(`unknown segment ${JSON.stringify(nombre)}`);
    out.set(
      nombre as Segmento,
      EstadoDeCalibracion.restaurar(id.maxErrorRate, 1 - id.confidence, valor, `segments.${nombre}`),
    );
  }
  return out;
}

function umbralDeMirada(primera: number, k: number): number {
  return Math.ceil(primera * 1.5 ** k);
}

/** Miradas que ya se hicieron con `n` etiquetas: una por cada umbral alcanzado. */
function miradasTras(primera: number, n: number): number {
  let k = 0;
  while (umbralDeMirada(primera, k) <= n) k++;
  return k;
}

function esEnteroNoNegativo(x: unknown): boolean {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 0xffff_ffff;
}

function esIndiceDeRejilla(x: unknown): boolean {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= PASOS_REJILLA;
}

/** El histograma en disperso: `[índice, etiquetas, erróneas]` solo donde hay algo. */
function dispersar(h: Histograma): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i <= PASOS_REJILLA; i++) {
    if (h.total[i]! > 0) out.push([i, h.total[i]!, h.erroneas[i]!]);
  }
  return out;
}

function leerHistograma(datos: unknown, donde: string): Histograma {
  const mal = (que: string): never => {
    throw new CalibrationStateError(`importCalibration: ${donde}: ${que}`);
  };
  if (!Array.isArray(datos)) mal("must be an array of [gridIndex, labels, wrong]");
  const h = new Histograma();
  let previo = -1;
  for (const fila of datos as unknown[]) {
    if (!Array.isArray(fila) || fila.length !== 3) mal("each entry must be [gridIndex, labels, wrong]");
    const [i, n, e] = fila as unknown[];
    if (!esIndiceDeRejilla(i) || (i as number) <= previo) mal("grid indices must be increasing integers in [0, 1000]");
    if (!esEnteroNoNegativo(n) || (n as number) === 0) mal("label counts must be positive integers");
    if (!esEnteroNoNegativo(e) || (e as number) > (n as number)) mal("wrong counts must be integers between 0 and the label count");
    h.total[i as number] = n as number;
    h.erroneas[i as number] = e as number;
    h.n += n as number;
    previo = i as number;
  }
  if (h.n > 0xffff_ffff) mal("too many labels");
  return h;
}

/** Los números de una calibración, validados y con sus valores por defecto. */
export function validarCalibracion(o: { maxErrorRate: number; confidence?: number; auditRate?: number }): {
  maxErrorRate: number;
  confidence: number;
  auditRate: number;
} {
  const { maxErrorRate } = o;
  const confidence = o.confidence ?? 0.95;
  const auditRate = o.auditRate ?? 0.05;
  // Mensajes en inglés: los lee el cliente. La confianza ESTRICTAMENTE por
  // encima de 0,5 es lo que hace exacto el atajo de `certifica` (e ≥ nδ).
  if (!(maxErrorRate > 0 && maxErrorRate <= 0.5)) {
    throw new RangeError(`calibration.maxErrorRate must be in (0, 0.5]; got ${maxErrorRate}`);
  }
  if (!(confidence > 0.5 && confidence < 1)) {
    throw new RangeError(`calibration.confidence must be in (0.5, 1); got ${confidence}`);
  }
  if (!(auditRate >= 0 && auditRate < 1)) {
    throw new RangeError(`calibration.auditRate must be in [0, 1); got ${auditRate}`);
  }
  return { maxErrorRate, confidence, auditRate };
}

/** PRNG con semilla (mulberry32): el reparto fuera de línea es reproducible. */
export function mulberry32(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
