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
    return Math.ceil(this.primeraMirada * 1.5 ** k);
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
