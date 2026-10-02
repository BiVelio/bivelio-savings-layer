/**
 * El núcleo del banco de precisión de la caché semántica: conductores y
 * puntuación. Sin E/S de ficheros ni red (eso vive en `datos.ts` y `arnes.ts`),
 * así que se prueba entero en seco.
 *
 * SE MIDE LO QUE SE ENVÍA. Los conductores no reimplementan la caché: montan la
 * capa completa (`createSavingsLayer`, la política, la verja determinista, el
 * embebedor léxico y los suelos por defecto) con un proveedor falso, y leen el
 * resultado del INFORME (`report.cache.result`, `report.qualityLedger`). La
 * diferencia importa: la capa exige que la política deje pasar las DOS
 * peticiones (la que guarda y la que busca), cosa que un conductor de
 * componentes no ve. El conductor de componentes existe solo como diagnóstico.
 *
 * Ningún resultado lleva texto: uids o ids, decisión y similitud (D20).
 */
import { createSavingsLayer } from "../../src/pipeline/create.js";
import { InMemorySemanticCache, type SemanticCacheOptions } from "../../src/cache/semantic.js";
import type { SemanticCalibrationOptions, SemanticCalibrationStatus } from "../../src/cache/calibration.js";
import { canonicalize, type CanonicalRequest } from "../../src/canonicalization/canonicalize.js";
import { evaluatePolicy } from "../../src/policy/policy.js";
import type { CachedAnswer } from "../../src/cache/exact.js";
import type { Provider, ProviderResponse } from "../../src/providers/types.js";
import type { SavingsResult } from "../../src/contracts/types.js";
import { bootstrapProporcionPorGrupos, wilsonCI, type CI } from "../stats.js";
import { esBrazoNoComercial } from "./fuentes.js";

/** Un modelo con precio en el catálogo; el proveedor es falso, no se llama a nadie. */
export const MODELO = "openai/gpt-4o-mini";

/** Solo la caché semántica: ni exacta (repetiría) ni resolvers (contestarían antes). */
export const AHORROS = { semanticCache: true, exactCache: false, deterministicResolvers: false } as const;

const CENTINELA = "__bench_provider_answer_for_the_current_request__";

// ─── Tipos de los conjuntos ─────────────────────────────────────────────────

export interface CasoTripleta {
  uid: string;
  arm: string;
  split: string;
  current_request: string;
  cached_request: string;
  cached_answer: string;
}

export type Etiqueta = "reuse" | "reject" | "uncertain";

export interface FilaEtiqueta {
  uid: string;
  label: Etiqueta;
  reason_categories?: string[];
  label_source?: string;
}

export interface FilaBaseline {
  uid: string;
  decision: "reuse" | "reject";
}

export interface FilaStream {
  id: number;
  prompt: string;
  idSet: number;
}

// ─── Brazos y ORCAS ─────────────────────────────────────────────────────────

/** Sin `incluirOrcas`, fuera todo brazo derivado de ORCAS (decisión legal del dueño). */
export function filtrarBrazos<T extends { arm: string }>(casos: T[], incluirOrcas: boolean): T[] {
  return incluirOrcas ? casos : casos.filter((c) => !esBrazoNoComercial(c.arm));
}

// ─── Sondas: los parámetros que se envían, leídos del código ────────────────

export interface Suelos {
  similarityFloor: number;
  acceptFloor: number;
  embedder: "built_in" | "custom";
  /**
   * El suelo de SIMILITUD que de verdad hay que pasar: `find()` exige
   * similitud ≥ similarityFloor y confidence = min(similitud, verifierScore) ≥
   * acceptFloor, así que la similitud tiene que pasar LOS DOS, haya verificador
   * o no (el verificador solo puede rechazar más).
   */
  effectiveFloor: number;
}

const canonica = (texto: string, tenantId = "sonda"): CanonicalRequest =>
  canonicalize({ model: MODELO, messages: [{ role: "user", content: texto }], context: { tenantId } });

/**
 * Los suelos que aplica una caché, LEÍDOS de un acierto (`SemanticHit` los
 * declara), no copiados de un comentario: si alguien cambia un valor por
 * defecto, el documento publicado cambia con él.
 */
export async function sondearSuelos(fabrica: () => InMemorySemanticCache): Promise<Suelos> {
  const cache = fabrica();
  const c = canonica("probe for the configured floors of the semantic cache");
  await cache.store(c, { text: "probe", data: "probe", storedAtMs: 0 });
  const hit = await cache.find(c);
  if (!hit) throw new Error("probe: an identical request did not hit; the floors cannot be read");
  return {
    similarityFloor: hit.similarityFloor,
    acceptFloor: hit.acceptFloor,
    embedder: hit.embedder,
    effectiveFloor: Math.max(hit.similarityFloor, hit.acceptFloor),
  };
}

/** El tope de registros de una caché, medido: se guarda hasta que el tamaño deja de crecer. */
export async function sondearMaxRegistros(fabrica: () => InMemorySemanticCache, limite = 1_000_000): Promise<number> {
  const cache = fabrica();
  let anterior = -1;
  for (let i = 0; i < limite; i++) {
    await cache.store(canonica(`probe record number ${i}`), { text: "p", data: "p", storedAtMs: 0 });
    if (cache.size === anterior) return cache.size;
    anterior = cache.size;
  }
  throw new Error(`probe: the cache kept growing past ${limite} records`);
}

// ─── Conductor de tripletas, por la capa completa ───────────────────────────

export interface ResultadoTripleta {
  uid: string;
  arm: string;
  split: string;
  acierto: boolean;
  /** La política dejó consultar la caché en la segunda petición. */
  consultada: boolean;
  /**
   * La primera petición llegó a ESCRIBIRSE en la caché. La capa solo guarda lo
   * que la política deja pasar, así que un caso cuya petición guardada se veta
   * no puede acertar aunque la segunda se consulte: eso es lo que se envía, y
   * se cuenta aparte para que el documento lo diga.
   */
  guardada: boolean;
  similarity?: number;
}

function proveedorFalso(respuesta: () => string): Provider {
  return {
    id: "bench-semantic-cache",
    async generate(): Promise<ProviderResponse> {
      return { text: respuesta(), usage: { inputTokens: 10, outputTokens: 10 }, finishReason: "stop" };
    },
  };
}

function consulto(r: SavingsResult): boolean {
  return r.report.traces.some((t) => t.stage === "semantic-cache" && (t.outcome === "hit" || t.outcome === "miss"));
}

function similitudDe(r: SavingsResult): number | undefined {
  const m = r.report.qualityLedger?.cacheMatch;
  return m?.kind === "semantic" ? m.similarity : undefined;
}

/**
 * Cada caso, aislado con su propio `tenantId` (son independientes: por eso su
 * intervalo es Wilson). Primera petición con `cached_request`, a la que el
 * proveedor falso contesta `cached_answer`; segunda con `current_request`, a la
 * que contestaría un centinela. Acierto = `report.cache.result === "semantic"`.
 */
export async function conducirTripletas(
  casos: CasoTripleta[],
  fabrica: () => InMemorySemanticCache = () => new InMemorySemanticCache(),
): Promise<ResultadoTripleta[]> {
  let siguiente = "";
  const semanticCache = fabrica();
  // La etapa 12 no deja traza cuando escribe: se cuentan las escrituras en la
  // propia instancia, sin tocar la caché.
  let escrituras = 0;
  const guardar = semanticCache.store.bind(semanticCache);
  semanticCache.store = async (c, answer) => {
    escrituras++;
    await guardar(c, answer);
  };
  const layer = createSavingsLayer({
    provider: proveedorFalso(() => siguiente),
    semanticCacheStore: semanticCache,
    devUnlicensed: true,
    silenceWarnings: true,
  });
  const out: ResultadoTripleta[] = [];
  try {
    for (const c of casos) {
      const base = { model: MODELO, savings: { ...AHORROS }, context: { tenantId: `case:${c.uid}` } };
      siguiente = c.cached_answer;
      const antes = escrituras;
      await layer.generate({ ...base, messages: [{ role: "user", content: c.cached_request }] });
      const guardada = escrituras > antes;
      siguiente = CENTINELA;
      const r = await layer.generate({ ...base, messages: [{ role: "user", content: c.current_request }] });
      const acierto = r.report.cache.result === "semantic";
      // Un acierto que no sirviera la respuesta guardada sería un fallo del
      // conductor, no de la caché: mejor romper que puntuar otra cosa.
      if (acierto && r.text !== c.cached_answer) throw new Error(`${c.uid}: a hit did not serve the stored answer`);
      const s = similitudDe(r);
      out.push({
        uid: c.uid,
        arm: c.arm,
        split: c.split,
        acierto,
        consultada: consulto(r),
        guardada,
        ...(s !== undefined ? { similarity: s } : {}),
      });
    }
  } finally {
    await layer.close();
  }
  return out;
}

/**
 * DIAGNÓSTICO, no la medición: la caché y la política sueltas, sin la capa. Si
 * discrepa del conductor de la capa, la diferencia es justo lo que la capa
 * añade (p. ej. que la política deje pasar la petición que guarda).
 */
export async function conducirTripletasComponentes(
  casos: CasoTripleta[],
  fabrica: () => InMemorySemanticCache = () => new InMemorySemanticCache(),
): Promise<ResultadoTripleta[]> {
  const out: ResultadoTripleta[] = [];
  for (const c of casos) {
    const cache = fabrica();
    const guardada = canonica(c.cached_request, c.uid);
    const actual = canonica(c.current_request, c.uid);
    await cache.store(guardada, { text: "", data: null, storedAtMs: 0 });
    const consultada = evaluatePolicy(actual).allowSemanticCache;
    const hit = consultada ? await cache.find(actual) : null;
    out.push({
      uid: c.uid,
      arm: c.arm,
      split: c.split,
      acierto: hit != null,
      consultada,
      // Los componentes guardan sin preguntar a la política: justo la
      // diferencia con la capa que este diagnóstico existe para enseñar.
      guardada: true,
      ...(hit ? { similarity: hit.similarity } : {}),
    });
  }
  return out;
}

// ─── Puntuación de las tripletas ────────────────────────────────────────────

export interface Conteo {
  casos: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** `uncertain`: fuera de los denominadores de precisión y recall, reportados aparte. */
  inciertos: number;
  aciertosInciertos: number;
  aciertos: number;
}

export interface Metricas {
  conteo: Conteo;
  precision: CI | null;
  recall: CI | null;
  hitRate: CI | null;
  /** Reutilizaciones erróneas: aciertos sobre casos etiquetados `reject`. */
  wrongReuses: number;
}

export function contar(filas: { acierto: boolean; label: Etiqueta }[]): Conteo {
  const c: Conteo = { casos: 0, tp: 0, fp: 0, fn: 0, tn: 0, inciertos: 0, aciertosInciertos: 0, aciertos: 0 };
  for (const f of filas) {
    c.casos++;
    if (f.acierto) c.aciertos++;
    if (f.label === "uncertain") {
      c.inciertos++;
      if (f.acierto) c.aciertosInciertos++;
      continue;
    }
    const positivo = f.label === "reuse";
    if (f.acierto && positivo) c.tp++;
    else if (f.acierto) c.fp++;
    else if (positivo) c.fn++;
    else c.tn++;
  }
  return c;
}

export function metricas(c: Conteo): Metricas {
  return {
    conteo: c,
    precision: wilsonCI(c.tp, c.tp + c.fp),
    recall: wilsonCI(c.tp, c.tp + c.fn),
    hitRate: wilsonCI(c.aciertos, c.casos),
    wrongReuses: c.fp,
  };
}

export interface PuntuacionTripletas {
  total: Metricas;
  porBrazo: Record<string, Metricas>;
  porSplit: Record<string, Metricas>;
  /** Categorías (`reason_categories`) de los falsos positivos; un caso puede tener varias. */
  categoriasFalsosPositivos: Record<string, number>;
  /** Casos cuya segunda petición la política no dejó consultar. */
  noConsultados: number;
  /** Casos con la segunda petición consultada pero cuya petición guardada la política no dejó escribir. */
  sinGuardar: number;
  /**
   * Procedencia de las etiquetas de los casos medidos (`label_source`), contada
   * de los datos: el documento dice «asistidas por modelo» con estas cifras, no
   * con las de un comentario.
   */
  fuentesDeEtiqueta: Record<string, number>;
}

export function puntuarTripletas(resultados: ResultadoTripleta[], etiquetas: FilaEtiqueta[]): PuntuacionTripletas {
  const porUid = new Map(etiquetas.map((e) => [e.uid, e]));
  const filas = resultados.map((r) => {
    const e = porUid.get(r.uid);
    if (!e) throw new Error(`no label for ${r.uid}`);
    return { ...r, label: e.label, categorias: e.reason_categories ?? [], fuente: e.label_source ?? "(none)" };
  });
  const agrupar = (clave: (f: (typeof filas)[number]) => string): Record<string, Metricas> => {
    const grupos = new Map<string, typeof filas>();
    for (const f of filas) {
      const k = clave(f);
      grupos.set(k, [...(grupos.get(k) ?? []), f]);
    }
    return Object.fromEntries([...grupos].sort(([a], [b]) => a.localeCompare(b)).map(([k, fs]) => [k, metricas(contar(fs))]));
  };
  const categoriasFalsosPositivos: Record<string, number> = {};
  for (const f of filas) {
    if (!f.acierto || f.label !== "reject") continue;
    for (const cat of f.categorias.length ? f.categorias : ["(none)"]) {
      categoriasFalsosPositivos[cat] = (categoriasFalsosPositivos[cat] ?? 0) + 1;
    }
  }
  const fuentesDeEtiqueta: Record<string, number> = {};
  for (const f of filas) fuentesDeEtiqueta[f.fuente] = (fuentesDeEtiqueta[f.fuente] ?? 0) + 1;
  return {
    total: metricas(contar(filas)),
    porBrazo: agrupar((f) => f.arm),
    porSplit: agrupar((f) => f.split),
    categoriasFalsosPositivos,
    noConsultados: resultados.filter((r) => !r.consultada).length,
    sinGuardar: resultados.filter((r) => r.consultada && !r.guardada).length,
    fuentesDeEtiqueta,
  };
}

// ─── Autoverificación del puntuador (D19) ───────────────────────────────────

/**
 * Lo que el propio proyecto publica para su evaluador a umbral 0,70 (README de
 * reuse_compatibility en el commit fijado): 364 reutilizaciones correctas de 365
 * aciertos no inciertos, y 364 de las 505 que debían reutilizarse.
 */
export interface CifrasDelPuntuador {
  precision: { k: number; n: number };
  recall: { k: number; n: number };
}

export const PUBLICADO_POR_EL_PROYECTO: CifrasDelPuntuador = { precision: { k: 364, n: 365 }, recall: { k: 364, n: 505 } };

export interface Verificacion extends CifrasDelPuntuador {
  ok: boolean;
  esperado: CifrasDelPuntuador;
}

/** Solo uids, etiquetas y decisiones: ni una línea de texto. */
export function verificarPuntuador(
  etiquetas: FilaEtiqueta[],
  baseline: FilaBaseline[],
  esperado: CifrasDelPuntuador = PUBLICADO_POR_EL_PROYECTO,
): Verificacion {
  const porUid = new Map(etiquetas.map((e) => [e.uid, e.label]));
  const c = contar(
    baseline.map((b) => {
      const label = porUid.get(b.uid);
      if (!label) throw new Error(`no label for ${b.uid}`);
      return { acierto: b.decision === "reuse", label };
    }),
  );
  const precision = { k: c.tp, n: c.tp + c.fp };
  const recall = { k: c.tp, n: c.tp + c.fn };
  const ok =
    precision.k === esperado.precision.k &&
    precision.n === esperado.precision.n &&
    recall.k === esperado.recall.k &&
    recall.n === esperado.recall.n;
  return { ok, precision, recall, esperado };
}

/** El evaluador del proyecto sobre un subconjunto de casos, con ESTE mismo puntuador. */
export function puntuarBaseline(
  casos: { uid: string; arm: string; split: string }[],
  etiquetas: FilaEtiqueta[],
  baseline: FilaBaseline[],
): Metricas {
  const decision = new Map(baseline.map((b) => [b.uid, b.decision]));
  const label = new Map(etiquetas.map((e) => [e.uid, e.label]));
  return metricas(
    contar(
      casos.map((c) => {
        const d = decision.get(c.uid);
        const l = label.get(c.uid);
        if (!d || !l) throw new Error(`missing baseline decision or label for ${c.uid}`);
        return { acierto: d === "reuse", label: l };
      }),
    ),
  );
}

// ─── Stream de SemBenchmarkLmArena ──────────────────────────────────────────

/** La caché de siempre, que además avisa de cada escritura para llevar el espejo FIFO. */
class CacheInstrumentada extends InMemorySemanticCache {
  constructor(
    opciones: SemanticCacheOptions,
    private readonly alGuardar: (answer: CachedAnswer) => void,
  ) {
    super(opciones);
  }
  override async store(c: CanonicalRequest, answer: CachedAnswer): Promise<void> {
    await super.store(c, answer);
    this.alGuardar(answer);
  }
}

export interface PorClase {
  idSet: number;
  consultas: number;
  aciertos: number;
  correctos: number;
  erroneos: number;
  alcanzables: number;
}

export interface AciertoStream {
  id: number;
  /** El `id` de la fila cuya respuesta se sirvió. */
  servedBy: number;
  correcto: boolean;
  similarity?: number;
}

export interface ResultadoStream {
  n: number;
  consultas: number;
  aciertos: number;
  correctos: number;
  erroneos: number;
  /** Consultas cuya clase ya estaba en la caché en ese momento (lo que se podía acertar). */
  alcanzables: number;
  desalojos: number;
  maxRegistros: number;
  /** Aciertos «erróneos» en los que el prompt guardado es IDÉNTICO al de la consulta: ruido de etiqueta. */
  erroresConPromptIdentico: number;
  /** Prompts idénticos que el dataset asigna a más de una clase, entre las n filas. */
  promptsIdenticosEnVariasClases: number;
  /** Comprobación del espejo FIFO: tiene que ser 0. */
  correctosNoAlcanzables: number;
  noConsultados: number[];
  aciertosDetalle: AciertoStream[];
  porClase: PorClase[];
  /** Solo con `calibracion`: lo que hizo la calibración en línea durante el stream. */
  calibracion?: ResumenCalibracionStream;
}

export interface ResumenCalibracionStream {
  /** Candidatas no servidas, por motivo (`calibrating`, `below_floor`, `record_floor`, `audit`). */
  sondas: Record<string, number>;
  /** Etiquetas que llegaron a anotarse (la respuesta era guardable). */
  etiquetas: number;
  /** Posición (0-based entre las consultadas) del primer acierto servido, o null. */
  primerAcierto: number | null;
  /** El estado final del segmento de un solo turno. */
  estadoFinal: SemanticCalibrationStatus;
}

export const respuestaDe = (idSet: number, id: number) => `class:${idSet}|id:${id}`;
export const leerRespuesta = (t: string): { idSet: number; id: number } | null => {
  const m = /^class:(-?\d+)\|id:(-?\d+)$/.exec(t);
  return m ? { idSet: Number(m[1]), id: Number(m[2]) } : null;
};

/**
 * Una capa y un solo tenant; los prompts en el orden de la revisión fijada. El
 * proveedor contesta con la CLASE de la consulta que falló (`ID_Set`), así que
 * un acierto es correcto si la clase servida es la de la consulta — la
 * definición de correcto de la tarjeta del dataset.
 *
 * El tope de registros es el que se envía salvo que se pase otro: la caché
 * desaloja en FIFO, y el espejo de aquí lo sigue escritura a escritura para
 * saber qué clases eran alcanzables en cada consulta.
 */
export async function conducirStream(
  filas: FilaStream[],
  opts: {
    maxRegistros: number;
    opcionesCache?: SemanticCacheOptions;
    /**
     * La calibración en línea (opt-in del SDK). El juez es la definición de
     * correcto de la tarjeta del dataset: la respuesta guardada es de la MISMA
     * clase que la de la consulta. No se deja pasar otro juez.
     */
    calibracion?: Omit<SemanticCalibrationOptions, "judge">;
  },
): Promise<ResultadoStream> {
  const cola: number[] = [];
  const enCache = new Map<number, number>();
  let desalojos = 0;
  const alGuardar = (answer: CachedAnswer) => {
    const r = leerRespuesta(answer.text);
    if (!r) throw new Error("stream: stored an answer the provider did not write");
    if (cola.length >= opts.maxRegistros) {
      const fuera = cola.shift()!;
      enCache.set(fuera, (enCache.get(fuera) ?? 1) - 1);
      desalojos++;
    }
    cola.push(r.idSet);
    enCache.set(r.idSet, (enCache.get(r.idSet) ?? 0) + 1);
  };
  const juezDeClase = (guardada: CachedAnswer, fresca: CachedAnswer): boolean => {
    const a = leerRespuesta(guardada.text);
    const b = leerRespuesta(fresca.text);
    return a != null && b != null && a.idSet === b.idSet;
  };
  const semanticCache = new CacheInstrumentada(
    {
      ...opts.opcionesCache,
      maxRecords: opts.maxRegistros,
      ...(opts.calibracion ? { calibration: { ...opts.calibracion, judge: juezDeClase } } : {}),
    },
    alGuardar,
  );
  const sondas: Record<string, number> = {};
  let etiquetas = 0;
  let primerAcierto: number | null = null;
  let siguiente = "";
  const layer = createSavingsLayer({
    provider: proveedorFalso(() => siguiente),
    semanticCacheStore: semanticCache,
    devUnlicensed: true,
    silenceWarnings: true,
  });

  const promptDe = new Map<number, string>();
  const clasesPorPrompt = new Map<string, Set<number>>();
  const porClase = new Map<number, PorClase>();
  const clase = (idSet: number): PorClase => {
    let p = porClase.get(idSet);
    if (!p) porClase.set(idSet, (p = { idSet, consultas: 0, aciertos: 0, correctos: 0, erroneos: 0, alcanzables: 0 }));
    return p;
  };
  const res: ResultadoStream = {
    n: filas.length, consultas: 0, aciertos: 0, correctos: 0, erroneos: 0, alcanzables: 0, desalojos: 0,
    maxRegistros: opts.maxRegistros, erroresConPromptIdentico: 0, promptsIdenticosEnVariasClases: 0,
    correctosNoAlcanzables: 0, noConsultados: [], aciertosDetalle: [], porClase: [],
  };

  try {
    for (const f of filas) {
      promptDe.set(f.id, f.prompt);
      const clases = clasesPorPrompt.get(f.prompt) ?? new Set<number>();
      clases.add(f.idSet);
      clasesPorPrompt.set(f.prompt, clases);

      const alcanzable = (enCache.get(f.idSet) ?? 0) > 0;
      siguiente = respuestaDe(f.idSet, f.id);
      const r = await layer.generate({
        model: MODELO,
        savings: { ...AHORROS },
        context: { tenantId: "stream" },
        messages: [{ role: "user", content: f.prompt }],
      });
      // Las etiquetas se anotan sin `await` en el pipeline: aquí se espera a
      // que estén, para que la siguiente consulta vea el estado de verdad.
      if (opts.calibracion) {
        await semanticCache.settled();
        for (const t of r.report.traces) {
          const motivo = t.stage === "semantic-cache" && t.outcome === "miss" ? t.detail?.["calibration"] : undefined;
          if (typeof motivo === "string") sondas[motivo] = (sondas[motivo] ?? 0) + 1;
          if (t.stage === "semantic-calibration" && t.outcome === "label requested") etiquetas++;
        }
      }
      if (!consulto(r)) {
        res.noConsultados.push(f.id);
        continue;
      }
      const pc = clase(f.idSet);
      if (primerAcierto == null && r.report.cache.result === "semantic") primerAcierto = res.consultas;
      res.consultas++;
      pc.consultas++;
      if (alcanzable) {
        res.alcanzables++;
        pc.alcanzables++;
      }
      if (r.report.cache.result !== "semantic") continue;
      const servida = leerRespuesta(r.text);
      if (!servida) throw new Error(`stream: hit on ${f.id} served an unknown answer`);
      const correcto = servida.idSet === f.idSet;
      res.aciertos++;
      pc.aciertos++;
      if (correcto) {
        res.correctos++;
        pc.correctos++;
        if (!alcanzable) res.correctosNoAlcanzables++;
      } else {
        res.erroneos++;
        pc.erroneos++;
        if (promptDe.get(servida.id) === f.prompt) res.erroresConPromptIdentico++;
      }
      const s = similitudDe(r);
      res.aciertosDetalle.push({ id: f.id, servedBy: servida.id, correcto, ...(s !== undefined ? { similarity: s } : {}) });
    }
  } finally {
    await layer.close();
  }
  res.desalojos = desalojos;
  if (opts.calibracion) {
    res.calibracion = { sondas, etiquetas, primerAcierto, estadoFinal: semanticCache.calibrationStatus()! };
  }
  res.promptsIdenticosEnVariasClases = [...clasesPorPrompt.values()].filter((s) => s.size > 1).length;
  res.porClase = [...porClase.values()].sort((a, b) => a.idSet - b.idSet);
  return res;
}

export interface MetricasStream {
  hitRate: CI | null;
  precision: CI | null;
  errorRate: CI | null;
  recallAlcanzable: CI | null;
  /** Remuestreos y semilla del bootstrap por clase. */
  bootstrap: { resamples: number; seed: number; unidad: "ID_Set" };
}

/** Intervalos por bootstrap de CLASES (D17): las consultas de una clase no son independientes. */
export function metricasStream(r: ResultadoStream, resamples = 2000, seed = 20260927): MetricasStream {
  const g = (num: (p: PorClase) => number, den: (p: PorClase) => number) =>
    bootstrapProporcionPorGrupos(r.porClase.map((p) => ({ num: num(p), den: den(p) })), { resamples, seed });
  return {
    hitRate: g((p) => p.aciertos, (p) => p.consultas),
    precision: g((p) => p.correctos, (p) => p.aciertos),
    errorRate: g((p) => p.erroneos, (p) => p.consultas),
    recallAlcanzable: g((p) => p.correctos, (p) => p.alcanzables),
    bootstrap: { resamples, seed, unidad: "ID_Set" },
  };
}

/** El stream en seco, derivado de las tripletas del fixture: misma clase si `reuse`, otra si no. */
export function streamDesdeTripletas(casos: CasoTripleta[], etiquetas: FilaEtiqueta[]): FilaStream[] {
  const label = new Map(etiquetas.map((e) => [e.uid, e.label]));
  const filas: FilaStream[] = [];
  casos.forEach((c, i) => {
    const clase = 1000 + i;
    filas.push({ id: 2 * i, prompt: c.cached_request, idSet: clase });
    filas.push({ id: 2 * i + 1, prompt: c.current_request, idSet: label.get(c.uid) === "reuse" ? clase : 5000 + i });
  });
  return filas;
}
