/**
 * EL BANCO SEMANAL · DEL ARTEFACTO DE CADA ARNÉS A UNA MEDICIÓN COMÚN.
 * ---------------------------------------------------------------------------
 * Cada batería escribe su propio JSON con su propia forma. Aquí se lee lo que
 * los umbrales necesitan y NADA MÁS, por la ruta exacta de cada arnés. Los
 * tipos son los mínimos: si un arnés cambia la forma de su artefacto, este
 * fichero falla al leerlo (`campo()`), no devuelve un cero que parezca un
 * resultado limpio.
 *
 * «Fallo de la capa» (capa-falla) no existe como campo en ninguna batería: se
 * deriva igual en las cuatro, como un error en un brazo CON la capa cuando el
 * brazo SIN ella (A), en la misma pregunta, no lo tuvo. Un error del proveedor
 * que golpea a los dos brazos no es de la capa; uno que solo ve la capa, sí.
 *
 * Salvo la CUOTA del proveedor (run 36786990486; ../publicados/cuota.ts): un
 * 429 por cuota o límite de tasa, en cualquiera de los dos brazos, saca el ítem
 * de la comparación en los dos y se cuenta aparte (`excluidosPorCuota`). Si la
 * celda se queda así sin ítems comparables, o por debajo de
 * MINIMO_COMPARABLE_TRAS_CUOTA, es «no medible — cuota del proveedor» (aviso).
 *
 * Todo es puro: recibe el JSON ya leído.
 */
import { esErrorDeCuota } from "../publicados/cuota.js";
import type { Bateria, ModeloDelBanco } from "./plan.js";

export interface IntervaloDeConfianza {
  point: number;
  lower: number;
  upper: number;
}

export interface Exactitud {
  /** El brazo con la capa que se compara con A (B, o S/E en GSM8K). */
  brazo: string;
  metrica: string;
  /** B − A (o la tasa de victoria de B en MT-Bench). */
  valor: number | null;
  ic95?: IntervaloDeConfianza | null;
  p?: number;
  /** Peor con significación: el IC entero por debajo de 0 (o de 0,5 en MT-Bench), o McNemar p < 0,05 en contra. */
  peorSignificativo: boolean;
}

export interface InformeVsFactura {
  brazo: string;
  /** Lo que el informe de la capa (`report.cost.actual`) dice que costó. */
  informeUsd: number;
  /** Lo que costó según el `usage` del proveedor a precio de lista (la cuenta del arnés). */
  facturaUsd: number;
  llamadas: number;
}

export interface Medicion {
  bateria: Bateria;
  modelo: string;
  estado: "medido" | "no-medible";
  motivo?: string;
  gastoUsd: number;
  /** La parte de `gastoUsd` que es del juez de MT-Bench (va por la pasarela: otra factura). Solo MT-Bench. */
  gastoJuezUsd?: number;
  /** Ítems con los dos brazos válidos (pares, preguntas o prompts). */
  n: number;
  /** El arnés paró antes de terminar la submuestra por su tope: la medición vale, pero es menor. */
  cortadaPorTope: boolean;
  /** XSTest: el arnés dejó de empezar ítems al agotar su `--plazo-min` (prefijo estratificado, como el corte por tope). */
  cortadaPorPlazo?: boolean;
  /** GSM8K: respuestas servidas de otra pregunta (brazos con capa en vivo + repetición sin red). */
  respuestasDeOtraPregunta?: number;
  /** BFCL: llamadas a herramienta que la capa devolvió distintas de las que recibió del proveedor, o herramientas omitidas. */
  llamadasCambiadas?: number;
  /** XSTest: negativas servidas desde la caché (o escritas en ella). */
  negativasCacheadas?: number;
  /** XSTest: negativas con ahorro acreditado o con registro de referencia. */
  negativasAcreditadas?: number;
  fallosDeLaCapa: number;
  /**
   * Ítems sacados de la comparación (en los dos brazos) porque el proveedor
   * respondió 429 por cuota o límite de tasa en A o en B. No son de la capa:
   * van a los avisos, nunca a `fallosDeLaCapa` (ver `cuotaAtribuible`).
   */
  excluidosPorCuota?: number;
  /** Hasta 5 ejemplos de fallos de la capa (ya pasados por el `sinSecretos` de cada arnés). */
  ejemplosDeFallos: string[];
  exactitud: Exactitud[];
  informeVsFactura: InformeVsFactura[];
  /**
   * MT-Bench: por qué NO hay tasa de victoria aunque la celda se midiera (el juez
   * juzgó menos de `MINIMO_DE_TURNOS_JUZGADOS` turnos). Va al resumen y a los
   * avisos: una calidad sin medir no puede pasar por un empate.
   */
  calidadSinMedir?: string;
  /**
   * La celda donde la capa NO intervino: está SOLO cuando el artefacto lo
   * demuestra (MT-Bench y BFCL; ver `sinIntervencionMtBench` y `sinIntervencionBfcl`). Lleva los
   * campos neutros en los que difirió el cable, con su cuenta. Con él, una
   * calidad peor de B no es de la capa: `exactitud-peor` pasa a aviso
   * (umbrales.ts). Sin él —intervino, o no se sabe— la regla actúa igual.
   */
  sinIntervencion?: { camposNeutros: Record<string, number> };
}

/**
 * EL MÍNIMO DE TURNOS JUZGADOS para publicar la tasa de victoria de B en
 * MT-Bench. Hallazgo del run 36611942632: las cuatro celdas medidas dieron
 * «victoria de B 0.500 [0.500, 0.500]» con UN turno juzgado (el juez se cortó en
 * la primera pregunta por su tope; ver TOPE_DEL_JUEZ_POR_MODELO_USD en plan.ts),
 * y ese turno era un empate por partidas discrepantes. Un intervalo [0,5, 0,5]
 * sobre un turno no es «sin diferencia»: es «sin medir». Con 8 turnos el
 * bootstrap ya no degenera en un punto.
 */
export const MINIMO_DE_TURNOS_JUZGADOS = 8;

type J = Record<string, unknown>;

/** Lee un campo que TIENE que estar. Si falta, el arnés cambió de forma: se dice, no se inventa un 0. */
function campo<T>(o: unknown, ruta: string): T {
  let x: unknown = o;
  for (const k of ruta.split(".")) {
    if (x === null || typeof x !== "object" || !(k in (x as J))) throw new Error(`el artefacto no tiene ${ruta} (¿cambió la forma del arnés?)`);
    x = (x as J)[k];
  }
  return x as T;
}

const suma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const ejemplos = (xs: string[]) => [...new Set(xs)].slice(0, 5).map((e) => e.slice(0, 240));
const esPresupuesto = (e: string) => /presupuesto|budget/i.test(e);
/** Un arnés que corrió y no llegó a medir un solo ítem (su tope no alcanzó ni para uno, o el proveedor no respondió). */
export const NINGUNO = "0 ítems medidos: el tope de la celda no alcanzó para uno, o el proveedor no respondió";

// ── La cuota del proveedor ──────────────────────────────────────────────────

/** El comienzo del motivo de una celda que la cuota del proveedor dejó sin medir. */
export const CUOTA_DEL_PROVEEDOR = "cuota del proveedor";

/**
 * EL MÍNIMO DE ÍTEMS COMPARABLES cuando la cuota se llevó alguno. Por debajo,
 * la celda es «no medible — cuota del proveedor»: lo que queda es demasiado
 * poco para decir que la capa no empeora. GSM8K, el mismo mínimo con el que su
 * arnés ya se declara no medible («budget fits only n unique problems», < 10);
 * BFCL y XSTest, el mismo; MT-Bench, las preguntas que dan los turnos mínimos
 * del juez (MINIMO_DE_TURNOS_JUZGADOS / 2). Solo actúa si hubo exclusiones por
 * cuota: una celda cortada por su tope con pocos ítems sigue midiéndose.
 */
export const MINIMO_COMPARABLE_TRAS_CUOTA: Record<Bateria, number> = {
  gsm8k: 10,
  bfcl: 10,
  xstest: 10,
  "mt-bench": MINIMO_DE_TURNOS_JUZGADOS / 2,
};

/**
 * ¿Puede atribuirse a la cuota un 429 de esta celda? Solo si el brazo con la
 * capa NO mandó más peticiones al proveedor que el brazo A. Un 429 que la capa
 * provocara sola (más peticiones que A: reintentos propios, llamadas extra) no
 * debería existir; si existe, es de la capa y cuenta como `capa-falla`: con
 * B > A no se excluye nada y los errores se cuentan como siempre.
 */
export function cuotaAtribuible(peticionesA: number, peticionesB: number): boolean {
  return peticionesB <= peticionesA;
}

const notaDeCuotaNoAtribuible = (a: number, b: number) =>
  `429 de cuota con más peticiones al proveedor en B (${b}) que en A (${a}): no se excluye, cuenta como de la capa`;

/**
 * El cierre común: una celda con 0 ítems comparables NUNCA es «medida» (XSTest
 * con Gemini 3.1 Pro en el run 36786990486 salía «medida», n=40, con los 40
 * ítems en 429 en los dos brazos). Tampoco una que la cuota dejó por debajo del
 * mínimo sin ningún fallo de la capa. Los fallos de la capa se conservan: una
 * celda no medible con `fallosDeLaCapa` > 0 sigue haciendo fallar (umbrales.ts).
 */
function cerrar(m: Medicion, sinNada = NINGUNO): Medicion {
  if (m.estado !== "medido") return m;
  const ex = m.excluidosPorCuota ?? 0;
  const min = MINIMO_COMPARABLE_TRAS_CUOTA[m.bateria];
  const porCuota = ex > 0 && m.fallosDeLaCapa === 0 && m.n < min;
  if (m.n > 0 && !porCuota) return m;
  const motivo =
    ex > 0
      ? `${CUOTA_DEL_PROVEEDOR}: ${ex} ítem${ex === 1 ? "" : "s"} con 429 por cuota o límite de tasa (en A o en B), excluidos de los dos brazos; quedan ${m.n} comparables (mínimo ${min})`
      : m.fallosDeLaCapa > 0
        ? "0 ítems comparables: el brazo con la capa falló en todos los que A respondió"
        : sinNada;
  return { ...m, estado: "no-medible", motivo };
}

// ── GSM8K ───────────────────────────────────────────────────────────────────

interface EnsayoGsm8k {
  pos: number;
  brazo: string;
  coste: number;
  llamadas: number;
  /** Peticiones al proveedor, respondidas o no; los artefactos de antes de la cuota no lo traen. */
  peticiones?: number;
  realCapa?: number;
  error?: string;
}

export function extraerGsm8k(art: unknown, modelo: ModeloDelBanco): Medicion {
  const modelos = campo<J[]>(art, "modelos");
  const m = modelos.find((x) => x["modelo"] === modelo.id);
  if (!m) throw new Error(`GSM8K: el artefacto no trae ${modelo.id}`);
  const gastoUsd = campo<number>(m, "gasto.totalUsd");
  const estado = campo<string>(m, "estado");
  const sinRed = ((art as J)["sinRed"] as { resultados: { config: string; erroneas: number }[] } | undefined)?.resultados ?? [];
  const base = { bateria: "gsm8k" as const, modelo: modelo.id, gastoUsd, ejemplosDeFallos: [], exactitud: [], informeVsFactura: [] };
  if (estado === "no-medible") {
    return { ...base, estado: "no-medible", motivo: String(m["motivo"] ?? "no medible"), n: 0, cortadaPorTope: false, fallosDeLaCapa: 0 };
  }
  const brazosCapa = ["B", "S", "E"].filter((b) => campo<J>(m, "resumen.brazos")[b] !== undefined);
  const variantes = campo<Record<string, { deOtra: number }>>(m, "resumen.variantesPorBrazo");
  const deOtraEnVivo = suma(brazosCapa.map((b) => variantes[b]?.deOtra ?? 0));
  const deOtraSinRed = suma(sinRed.map((r) => r.erroneas));

  const ensayos = campo<EnsayoGsm8k[]>(m, "ensayos");
  const errorDeA = new Map<number, boolean>();
  for (const e of ensayos) if (e.brazo === "A") errorDeA.set(e.pos, !!e.error);
  // Cuota: posiciones con un 429 en cualquier brazo, si ningún brazo con capa mandó más peticiones que A.
  const peticiones = (b: string) => suma(ensayos.filter((e) => e.brazo === b).map((e) => e.peticiones ?? e.llamadas));
  const conCuota = new Set(ensayos.filter((e) => esErrorDeCuota(e.error)).map((e) => e.pos));
  const peorB = brazosCapa.map((b) => peticiones(b)).reduce((x, y) => Math.max(x, y), 0);
  const atribuible = cuotaAtribuible(peticiones("A"), peorB);
  const excluidas = atribuible ? conCuota : new Set<number>();
  const fallos = ensayos.filter((e) => e.brazo !== "A" && e.error && !esPresupuesto(e.error) && errorDeA.get(e.pos) === false && !excluidas.has(e.pos));

  const comparaciones = campo<{ brazo: string; diferenciaExactitud: IntervaloDeConfianza | null }[]>(m, "resumen.comparaciones");
  const exactitud: Exactitud[] = comparaciones.map((c) => ({
    brazo: c.brazo,
    metrica: "exactitud (brazo − A)",
    valor: c.diferenciaExactitud?.point ?? null,
    ic95: c.diferenciaExactitud,
    peorSignificativo: !!c.diferenciaExactitud && c.diferenciaExactitud.upper < 0,
  }));

  const informeVsFactura: InformeVsFactura[] = brazosCapa.map((b) => {
    const es = ensayos.filter((e) => e.brazo === b && typeof e.realCapa === "number" && !e.error);
    return { brazo: b, informeUsd: suma(es.map((e) => e.realCapa!)), facturaUsd: suma(es.map((e) => e.coste)), llamadas: es.length };
  });

  const notas = !atribuible && conCuota.size > 0 ? [notaDeCuotaNoAtribuible(peticiones("A"), peorB)] : [];
  return cerrar({
    ...base,
    estado: "medido",
    n: ensayos.filter((e) => e.brazo === "A" && !e.error && !excluidas.has(e.pos)).length,
    cortadaPorTope: estado === "abortado-presupuesto",
    respuestasDeOtraPregunta: deOtraEnVivo + deOtraSinRed,
    fallosDeLaCapa: fallos.length,
    ...(excluidas.size ? { excluidosPorCuota: excluidas.size } : {}),
    ejemplosDeFallos: ejemplos([...notas, ...fallos.map((e) => `${e.brazo} pos ${e.pos}: ${e.error}`)]),
    exactitud,
    informeVsFactura,
  });
}

// ── BFCL ────────────────────────────────────────────────────────────────────

interface EntradaAstBfcl {
  id: string;
  A: { ok: boolean; error?: string; llamadasAlProveedor?: number };
  B: { ok: boolean; error?: string; coste: number; llamadasAlProveedor?: number; informe?: { actual: number } };
}

/** Lo que `sinIntervencionBfcl` lee de cada entrada AST (arnes.ts, `RegistroAst`). */
interface EntradaAstBfclCable {
  A: { ok: boolean; llamadasAlProveedor?: number; modelosServidos?: string[] };
  B: {
    ok: boolean;
    llamadasAlProveedor?: number;
    modelosServidos?: string[];
    fiel?: boolean | null;
    diferenciasDelCable?: string[];
    marcasDeCache?: number;
    informe?: { cache?: string; avoidedLlm?: number };
  };
}

/**
 * ¿La capa dejó INTACTA la generación de B en la exactitud AST de esta celda de
 * BFCL? Hallazgo de los runs 36634001923, 36748284158 y 36771607171:
 * gpt-5.4-mini dio B − A −0,030, −0,010 y −0,040 [−0,080, −0,010] con el cable
 * de B idéntico al de A en las 300 entradas (diferenciasDelCable vacía, los
 * mismos tokens de entrada, caché todo `miss`), y en vivo el cuerpo de B salió
 * byte a byte igual que el de A: era el muestreo de un modelo de razonamiento
 * al que ningún brazo puede fijar temperatura ni semilla, no la capa.
 *
 * Solo si el artefacto lo demuestra en TODAS las entradas que cuentan en la
 * exactitud (las que el brazo A respondió):
 *   · B respondió, con las llamadas tal cual las trajo el proveedor (`fiel`);
 *   · ninguna llamada evitada: caché `miss`, `avoidedLlm` 0, y tantas llamadas
 *     al proveedor en B como en A;
 *   · el mismo modelo servido en A y B (y alguno);
 *   · el cable de B igual al de A salvo campos de CAMPOS_NEUTROS_PARA_LA_GENERACION
 *     (las marcas `cache_control` ya las quita la comparación del arnés; se
 *     cuentan como `cuerpo:cache_control`).
 * Si falta cualquier dato (un artefacto de antes de `modelosServidos`), `null`:
 * se asume que intervino y la regla actúa. El multi-turn no entra: no puntúa
 * exactitud, y sus diferencias van a su propia sección del informe.
 */
export function sinIntervencionBfcl(ast: EntradaAstBfclCable[]): { camposNeutros: Record<string, number> } | null {
  const cuentan = ast.filter((e) => e.A.ok);
  if (cuentan.length === 0) return null;
  const campos: Record<string, number> = {};
  const servidosA = new Set<string>();
  const servidosB = new Set<string>();
  for (const { A, B } of cuentan) {
    if (!B.ok || B.fiel !== true) return null;
    if (B.informe?.cache !== "miss" || B.informe.avoidedLlm !== 0) return null;
    if (!A.llamadasAlProveedor || B.llamadasAlProveedor !== A.llamadasAlProveedor) return null;
    if (!A.modelosServidos?.length || !B.modelosServidos?.length) return null;
    for (const m of A.modelosServidos) servidosA.add(m);
    for (const m of B.modelosServidos) servidosB.add(m);
    if (!Array.isArray(B.diferenciasDelCable)) return null;
    // «<clave>: A=… B=…» es una clave de primer nivel; `tools…` y `messages…` nunca son neutras.
    for (const d of B.diferenciasDelCable) {
      const clave = /^([a-z_]+): A=/.exec(d)?.[1];
      if (!clave || !esNeutro(clave)) return null;
      campos[clave] = (campos[clave] ?? 0) + 1;
    }
    if ((B.marcasDeCache ?? 0) > 0) campos["cuerpo:cache_control"] = (campos["cuerpo:cache_control"] ?? 0) + 1;
  }
  if ([...servidosA].sort().join() !== [...servidosB].sort().join()) return null;
  return { camposNeutros: campos };
}

export function extraerBfcl(art: unknown, modelo: ModeloDelBanco): Medicion {
  const base = { bateria: "bfcl" as const, modelo: modelo.id, ejemplosDeFallos: [], exactitud: [], informeVsFactura: [] };
  const noMedible = ((art as J)["noMedibles"] as { modelo: string; motivo: string }[] | undefined)?.find((x) => x.modelo === modelo.id);
  if (noMedible) return { ...base, estado: "no-medible", motivo: noMedible.motivo, gastoUsd: 0, n: 0, cortadaPorTope: false, fallosDeLaCapa: 0 };
  const tiradas = campo<J[]>(art, "modelos");
  const i = tiradas.findIndex((t) => t["modelo"] === modelo.id);
  if (i < 0) throw new Error(`BFCL: el artefacto no trae ${modelo.id}`);
  const t = tiradas[i]!;
  const r = campo<J[]>(art, "resumen")[i]!;
  const gastoUsd = campo<number>(r, "gasto.total");
  const n = campo<number>(r, "n");
  const ast = campo<EntradaAstBfcl[]>(t, "ast");
  // Cuota: entradas con un 429 en A o en B, si B no mandó más peticiones al proveedor que A.
  const peticionesA = suma(ast.map((e) => e.A.llamadasAlProveedor ?? 0));
  const peticionesB = suma(ast.map((e) => e.B.llamadasAlProveedor ?? 0));
  const conCuota = new Set(ast.filter((e) => esErrorDeCuota(e.A.error) || esErrorDeCuota(e.B.error)).map((e) => e.id));
  const atribuible = cuotaAtribuible(peticionesA, peticionesB);
  const excluidas = atribuible ? conCuota : new Set<string>();
  if (ast.length > 0 && ast.every((e) => !e.A.ok)) {
    const motivo =
      excluidas.size > 0 && ast.every((e) => excluidas.has(e.id))
        ? `${CUOTA_DEL_PROVEEDOR}: las ${ast.length} entradas con 429 por cuota o límite de tasa; ninguna respuesta válida del proveedor en el brazo A`
        : "ninguna respuesta válida del proveedor en el brazo A";
    return { ...base, estado: "no-medible", motivo, gastoUsd, n: 0, cortadaPorTope: false, fallosDeLaCapa: 0, ...(excluidas.size ? { excluidosPorCuota: excluidas.size } : {}) };
  }
  if (ast.length === 0) {
    return { ...base, estado: "no-medible", motivo: NINGUNO, gastoUsd, n: 0, cortadaPorTope: campo<boolean>(r, "gasto.abortado"), fallosDeLaCapa: 0 };
  }
  const infieles = campo<string[]>(r, "infieles");
  const multi = (r["multiTurno"] as { herramientasOmitidasPorB?: number; violaciones?: string[] } | undefined) ?? {};
  const erroresA = new Set(campo<{ id: string }[]>(r, "erroresA").map((e) => e.id));
  const soloB = campo<{ id: string; error: string }[]>(r, "erroresB").filter((e) => !erroresA.has(e.id) && !esPresupuesto(e.error) && !excluidas.has(e.id));
  const notas = !atribuible && conCuota.size > 0 ? [notaDeCuotaNoAtribuible(peticionesA, peticionesB)] : [];
  const violaciones = multi.violaciones ?? [];
  const dif = campo<IntervaloDeConfianza | null>(r, "diferenciaExactitud");
  const conInforme = ast.filter((e) => e.B.ok && e.B.informe && typeof e.B.coste === "number");
  const sinIntervencion = sinIntervencionBfcl(ast as unknown as EntradaAstBfclCable[]);
  return cerrar({
    ...base,
    ...(sinIntervencion ? { sinIntervencion } : {}),
    estado: "medido",
    gastoUsd,
    n,
    cortadaPorTope: campo<boolean>(r, "gasto.abortado"),
    llamadasCambiadas: infieles.length + (multi.herramientasOmitidasPorB ?? 0),
    fallosDeLaCapa: soloB.length + violaciones.length,
    ...(excluidas.size ? { excluidosPorCuota: excluidas.size } : {}),
    ejemplosDeFallos: ejemplos([...notas, ...soloB.map((e) => `${e.id}: ${e.error}`), ...violaciones.map((v) => `aislamiento de caché: ${v}`)]),
    exactitud: [{ brazo: "B", metrica: "exactitud AST (B − A)", valor: dif?.point ?? null, ic95: dif, peorSignificativo: !!dif && dif.upper < 0 }],
    informeVsFactura: [
      { brazo: "B", informeUsd: suma(conInforme.map((e) => e.B.informe!.actual)), facturaUsd: suma(conInforme.map((e) => e.B.coste)), llamadas: conInforme.length },
    ],
  });
}

// ── XSTest ──────────────────────────────────────────────────────────────────

interface PorLabelXstest {
  pares: number;
  A: { tasa: number | null };
  B: { tasa: number | null };
  soloA: number[];
  soloB: number[];
  mcnemarP: number;
}

export function extraerXstest(art: unknown, modelo: ModeloDelBanco): Medicion {
  const base = { bateria: "xstest" as const, modelo: modelo.id, ejemplosDeFallos: [], exactitud: [], informeVsFactura: [] };
  const pm = campo<Record<string, J>>(art, "porModelo")[modelo.corto];
  if (!pm) throw new Error(`XSTest: el artefacto no trae ${modelo.corto}`);
  const gastoUsd = campo<number>(pm, "gastadoUsd");
  if (pm["noMedible"]) return { ...base, estado: "no-medible", motivo: String(pm["noMedible"]), gastoUsd, n: 0, cortadaPorTope: false, fallosDeLaCapa: 0 };
  const r = campo<J[]>(art, "informe.resumen").find((x) => x["modelo"] === modelo.corto);
  if (!r) throw new Error(`XSTest: el informe no resume ${modelo.corto}`);
  if (campo<number>(r, "medidos") === 0) {
    return { ...base, estado: "no-medible", motivo: NINGUNO, gastoUsd, n: 0, cortadaPorTope: campo<boolean>(pm, "cortadoPorPresupuesto"), fallosDeLaCapa: 0 };
  }

  const api = campo<{ items: number; rep1AlProveedor: number; rep2AlProveedor: number; conAhorroAcreditado: number }>(r, "repeticiones.negativasDelApi");
  const texto = campo<{ repsServidasSinLlamar: number; repsConReferencia: number; ahorroAcreditadoUsd: number }>(r, "repeticiones.negativasDeTexto");
  const enB = Object.values(campo<Record<string, { aLaCache: number; conReferencia: number }>>(r, "negativasEnB"));
  const cacheadas = api.items - api.rep1AlProveedor + (api.items - api.rep2AlProveedor) + texto.repsServidasSinLlamar + suma(enB.map((x) => x.aLaCache));
  const acreditadas =
    api.conAhorroAcreditado +
    texto.repsConReferencia +
    suma(enB.map((x) => x.conReferencia)) +
    (texto.ahorroAcreditadoUsd > 0 && texto.repsConReferencia === 0 ? 1 : 0);

  type BrazoXstest = { error?: string; llamadasAlProveedor?: number; proveedor?: { status?: number } | null };
  const registros = campo<{ modelo: string; id: number; A?: BrazoXstest; B?: BrazoXstest; repeticiones?: { error?: string }[] }[]>(art, "registros").filter(
    (x) => x.modelo === modelo.corto,
  );
  // Cuota: prompts con un 429 en A o en B (fase principal; las repeticiones son
  // solo de B y no entran). A hace una petición por prompt; B, las que cuente.
  const cuotaEn = (b?: BrazoXstest) => !!b && esErrorDeCuota(b.error, b.proveedor?.status);
  const peticionesA = registros.filter((x) => x.A).length;
  const peticionesB = suma(registros.map((x) => x.B?.llamadasAlProveedor ?? 0));
  const conCuota = new Set(registros.filter((x) => cuotaEn(x.A) || cuotaEn(x.B)).map((x) => x.id));
  const atribuible = cuotaAtribuible(peticionesA, peticionesB);
  const excluidos = atribuible ? conCuota : new Set<number>();
  const soloB = registros.filter((x) => x.B?.error && !x.A?.error && !esPresupuesto(x.B.error) && !excluidos.has(x.id));
  const notas = !atribuible && conCuota.size > 0 ? [notaDeCuotaNoAtribuible(peticionesA, peticionesB)] : [];
  const alterados = campo<number>(r, "textoFiel.alterados");

  const porLabel = campo<Partial<Record<"safe" | "unsafe", PorLabelXstest>>>(r, "porLabel");
  const exactitud: Exactitud[] = [];
  const seguro = porLabel.safe;
  if (seguro) {
    exactitud.push({
      brazo: "B",
      metrica: "negativas en prompts seguros (B − A; más es peor)",
      valor: seguro.A.tasa !== null && seguro.B.tasa !== null ? seguro.B.tasa - seguro.A.tasa : null,
      p: seguro.mcnemarP,
      peorSignificativo: seguro.mcnemarP < 0.05 && seguro.soloB.length > seguro.soloA.length,
    });
  }
  const inseguro = porLabel.unsafe;
  if (inseguro) {
    exactitud.push({
      brazo: "B",
      metrica: "negativas en prompts inseguros (B − A; menos es peor)",
      valor: inseguro.A.tasa !== null && inseguro.B.tasa !== null ? inseguro.B.tasa - inseguro.A.tasa : null,
      p: inseguro.mcnemarP,
      peorSignificativo: inseguro.mcnemarP < 0.05 && inseguro.soloA.length > inseguro.soloB.length,
    });
  }
  // n: los pares con respuesta válida en los dos brazos (los de McNemar), no los
  // prompts lanzados: 40 prompts con 429 en los dos brazos son 0 pares, no 40.
  const pares = suma(Object.values(porLabel).map((x) => x?.pares ?? 0));
  return cerrar({
    ...base,
    estado: "medido",
    gastoUsd,
    n: pares,
    cortadaPorTope: campo<boolean>(pm, "cortadoPorPresupuesto"),
    // Opcional: los artefactos de antes del `--plazo-min` no lo traen.
    ...((pm as Record<string, unknown>)["cortadoPorPlazo"] === true ? { cortadaPorPlazo: true } : {}),
    negativasCacheadas: cacheadas,
    negativasAcreditadas: acreditadas,
    fallosDeLaCapa: soloB.length + alterados,
    ...(excluidos.size ? { excluidosPorCuota: excluidos.size } : {}),
    ejemplosDeFallos: ejemplos([
      ...notas,
      ...soloB.map((x) => `prompt ${x.id}: ${x.B!.error}`),
      ...(alterados ? [`${alterados} respuestas cuyo texto entregado no es el que mandó el proveedor`] : []),
    ]),
    exactitud,
    informeVsFactura: [
      {
        brazo: "B",
        informeUsd: campo<number>(r, "coste.B.segunElInformeUsd"),
        facturaUsd: campo<number>(r, "coste.B.facturadoUsd"),
        llamadas: campo<number>(r, "medidos"),
      },
    ],
  }, "0 pares con respuesta válida en los dos brazos");
}

// ── MT-Bench ────────────────────────────────────────────────────────────────

/**
 * CAMPOS NEUTROS PARA LA GENERACIÓN: en los que el cable de B puede diferir del
 * de A sin que la respuesta del modelo pueda cambiar por ellos. Lista explícita
 * y corta a propósito; cualquier otra diferencia cuenta como intervención.
 *
 *   prompt_cache_key   OpenAI, Chat Completions: «Used by OpenAI to cache
 *                      responses for similar requests to optimize your cache
 *                      hit rates». Enruta la petición hacia una máquina con el
 *                      prefijo en caché; no es un parámetro de muestreo ni entra
 *                      en el contexto del modelo. La capa lo añade en el turno 2
 *                      (src/providers/openai-compatible.ts).
 *   <clave>:cache_control
 *                      Anthropic, Prompt caching: el prefijo cacheado da la misma
 *                      salida que sin caché («Prompt caching has no effect on
 *                      output token generation»). El arnés lo emite como
 *                      `messages:cache_control` cuando lo ÚNICO que cambia en esa
 *                      clave son las marcas (diferenciasDeCuerpo, mt-bench/nucleo.ts).
 *
 * No están `metadata`, `user`, `store` ni `safety_identifier` (también neutros
 * según la doc de OpenAI) porque la capa no los manda: si un día aparecen en
 * `cable.diferencias`, la celda contará como intervenida hasta que alguien los
 * añada aquí con su justificación. Tampoco `seed`, `service_tier` ni
 * `reasoning_effort`, que la capa sí puede mandar: los dos primeros cambian el
 * muestreo o el despliegue que responde, y el tercero la generación.
 */
export const CAMPOS_NEUTROS_PARA_LA_GENERACION: readonly string[] = ["prompt_cache_key"];

const esNeutro = (campo: string) => CAMPOS_NEUTROS_PARA_LA_GENERACION.includes(campo) || /^[a-z_]+:cache_control$/.test(campo);

/**
 * ¿La capa dejó INTACTA la generación de B en esta celda de MT-Bench? Solo si
 * el artefacto lo demuestra, las tres cosas a la vez:
 *   · ninguna llamada evitada: `capa.cacheResult` todo `miss`, sin llamadas
 *     extra al proveedor, y el cable comparó los dos turnos de cada pregunta
 *     completa (un turno de B servido sin llamar no aparecería en el cable);
 *   · el mismo modelo servido en A y B (y alguno);
 *   · el cable de B igual al de A salvo campos de CAMPOS_NEUTROS_PARA_LA_GENERACION.
 * Si falta cualquier dato, `null`: se asume que intervino y la regla actúa.
 */
export function sinIntervencionMtBench(fila: unknown): { camposNeutros: Record<string, number> } | null {
  const r = fila as J;
  const cable = r["cable"] as
    | { turnos?: number; diferencias?: Record<string, number>; modelosServidosA?: string[]; modelosServidosB?: string[] }
    | undefined;
  const capa = r["capa"] as { cacheResult?: Record<string, number>; llamadasExtraAlProveedor?: number } | undefined;
  const completas = (r["preguntas"] as { completas?: number } | undefined)?.completas;
  if (!cable || !capa || typeof completas !== "number" || completas === 0) return null;
  const cache = capa.cacheResult;
  if (!cache || Object.keys(cache).length === 0 || Object.entries(cache).some(([k, v]) => k !== "miss" && v > 0)) return null;
  if (capa.llamadasExtraAlProveedor !== 0) return null;
  if (cable.turnos !== completas * 2) return null;
  const a = [...new Set(cable.modelosServidosA ?? [])].sort();
  const b = [...new Set(cable.modelosServidosB ?? [])].sort();
  if (a.length === 0 || JSON.stringify(a) !== JSON.stringify(b)) return null;
  const difs = cable.diferencias;
  if (!difs || Object.keys(difs).some((k) => !esNeutro(k))) return null;
  return { camposNeutros: { ...difs } };
}

export interface PreguntaCrudaMtBench {
  id: number;
  error?: string;
  /** Cada petición que salió al proveedor en esta pregunta, con su brazo y su status (mt-bench.ts, `LlamadaMedida`). */
  llamadas?: { brazo: string; turno: number; status: number; error?: string }[];
}

/**
 * La cuota en MT-Bench, de las respuestas crudas. Una pregunta se excluye si
 * su error, o el de cualquier petición de cualquiera de los dos brazos, es un
 * 429 de cuota. Las peticiones de A se cuentan como los turnos lanzados: A y B
 * salen a la vez (Promise.all) y A hace exactamente una petición por turno,
 * pero si la de A seguía en vuelo (reintentando su propio 429) cuando la de B
 * falló, no llega al registro (pregunta 101 del run 36786990486). Sin
 * `llamadas` (respuestas crudas de antes) no hay con qué comparar: no se excluye.
 */
function cuotaMtBench(preguntas: PreguntaCrudaMtBench[]): { excluidas: Set<number>; nota: string | null } {
  const conCuota = new Set(
    preguntas.filter((p) => esErrorDeCuota(p.error) || (p.llamadas ?? []).some((l) => esErrorDeCuota(l.error, l.status))).map((p) => p.id),
  );
  if (conCuota.size === 0) return { excluidas: conCuota, nota: null };
  if (preguntas.some((p) => p.error && !p.llamadas)) return { excluidas: new Set(), nota: null };
  const llamadas = preguntas.flatMap((p) => (p.llamadas ?? []).map((l) => ({ ...l, id: p.id })));
  const turnos = new Set(llamadas.map((l) => `${l.id}/${l.turno}`)).size;
  const a = Math.max(turnos, llamadas.filter((l) => l.brazo === "A").length);
  const b = llamadas.filter((l) => l.brazo === "B").length;
  return cuotaAtribuible(a, b) ? { excluidas: conCuota, nota: null } : { excluidas: new Set(), nota: notaDeCuotaNoAtribuible(a, b) };
}

/**
 * `crudo`: las líneas de `<nombre>-respuestas.jsonl` de ESTA tirada (el arnés
 * escribe una por modelo). Sin él, los fallos se leen de `errores` del informe,
 * que está recortado a 20 y deduplicado: se dice en el ejemplo.
 */
export function extraerMtBench(art: unknown, modelo: ModeloDelBanco, crudo?: { modelo: string; preguntas: PreguntaCrudaMtBench[] }[]): Medicion {
  const base = { bateria: "mt-bench" as const, modelo: modelo.id, ejemplosDeFallos: [], exactitud: [], informeVsFactura: [] };
  const r = campo<J[]>(art, "modelos").find((x) => x["modelo"] === modelo.corto);
  const fallido = campo<{ modelo: string; error: string }[]>(art, "modelosFallidos").find((x) => x.modelo === modelo.corto);
  if (!r) {
    if (!fallido) throw new Error(`MT-Bench: el artefacto no trae ${modelo.corto}`);
    return { ...base, estado: "no-medible", motivo: fallido.error, gastoUsd: 0, n: 0, cortadaPorTope: false, fallosDeLaCapa: 0 };
  }
  const gastoJuezUsd = campo<number>(r, "gasto.juez");
  const gastoUsd = campo<number>(r, "gasto.total") + gastoJuezUsd;
  const preguntas = crudo?.find((x) => x.modelo === modelo.corto)?.preguntas;
  let fallos: string[];
  let excluidas = new Set<number>();
  let notaDeCuota: string | null = null;
  if (preguntas) {
    const cuota = cuotaMtBench(preguntas);
    excluidas = cuota.excluidas;
    // Promise.all de A y B: un error de A llega como «brazo A …»; cualquier otro salió de la capa.
    fallos = preguntas
      .filter((p) => p.error && !/^brazo A\b/.test(p.error) && !esPresupuesto(p.error) && !excluidas.has(p.id))
      .map((p) => `pregunta ${p.id}: ${p.error}`);
    notaDeCuota = cuota.nota;
  } else {
    fallos = campo<string[]>(r, "errores")
      .filter((e) => /^B t\d/.test(e))
      .map((e) => `${e} (del informe: lista recortada)`);
  }
  if (campo<number>(r, "preguntas.completas") === 0 && fallos.length === 0) {
    return cerrar({
      ...base,
      estado: "medido",
      gastoUsd,
      gastoJuezUsd,
      n: 0,
      cortadaPorTope: campo<boolean>(r, "preguntas.cortePorPresupuesto"),
      fallosDeLaCapa: 0,
      ...(excluidas.size ? { excluidosPorCuota: excluidas.size } : {}),
    });
  }
  const juzgada = campo<boolean>(r, "calidad.juzgada");
  const turnos = juzgada ? campo<number>(r, "calidad.turnosJuzgados") : 0;
  const suficiente = juzgada && turnos >= MINIMO_DE_TURNOS_JUZGADOS;
  const tasa = suficiente ? campo<IntervaloDeConfianza | null>(r, "calidad.tasaDeVictoriaB") : null;
  const calidadSinMedir = !juzgada
    ? "el arnés corrió sin juez: no hay tasa de victoria"
    : !suficiente
      ? `el juez solo juzgó ${turnos} turno${turnos === 1 ? "" : "s"} (mínimo ${MINIMO_DE_TURNOS_JUZGADOS})` +
        `${campo<boolean>(r, "calidad.cortePorPresupuesto") ? ", cortado por su tope" : ""}: sin tasa de victoria`
      : undefined;
  const sinIntervencion = sinIntervencionMtBench(r);
  return cerrar({
    ...base,
    ...(calidadSinMedir ? { calidadSinMedir } : {}),
    ...(sinIntervencion ? { sinIntervencion } : {}),
    estado: "medido",
    gastoUsd,
    gastoJuezUsd,
    n: campo<number>(r, "preguntas.completas"),
    cortadaPorTope: campo<boolean>(r, "preguntas.cortePorPresupuesto"),
    fallosDeLaCapa: fallos.length,
    ...(excluidas.size ? { excluidosPorCuota: excluidas.size } : {}),
    ejemplosDeFallos: ejemplos([...(notaDeCuota && fallos.length ? [notaDeCuota] : []), ...fallos]),
    exactitud: tasa
      ? [{ brazo: "B", metrica: "tasa de victoria de B ante el juez (0,5 = empate)", valor: tasa.point, ic95: tasa, peorSignificativo: tasa.upper < 0.5 }]
      : [],
    informeVsFactura: [
      {
        brazo: "B",
        informeUsd: campo<number>(r, "capa.costeDeclaradoUsd"),
        facturaUsd: campo<number>(r, "capa.costeMedidoB"),
        llamadas: campo<number>(r, "preguntas.completas") * 2,
      },
    ],
  });
}

export function extraer(bateria: Bateria, art: unknown, modelo: ModeloDelBanco, crudoMtBench?: Parameters<typeof extraerMtBench>[2]): Medicion {
  switch (bateria) {
    case "gsm8k":
      return extraerGsm8k(art, modelo);
    case "bfcl":
      return extraerBfcl(art, modelo);
    case "xstest":
      return extraerXstest(art, modelo);
    case "mt-bench":
      return extraerMtBench(art, modelo, crudoMtBench);
  }
}
