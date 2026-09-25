/**
 * EL INFORME DE «TU PROPIO BANCO», en puro: de los recuentos, el resumen exacto
 * y los pares a las cifras que pinta el panel. Sin red, sin React.
 *
 * Reglas (especificación D9-D12, endurecidas tras la revisión adversaria):
 *   · TITULAR = el SUELO del IC 95 % de la fracción ahorrada, por bootstrap
 *     estratificado como el banco publicado — nunca la estimación puntual.
 *   · PESOS = la cuota de población de cada estrato (N_h), contada por el SDK.
 *     N_h = max(conteo del estrato, filas de muestra del estrato): toda fila de
 *     muestra es una petición elegible, así que un conteo perdido no la achica.
 *   · UN PAR SOLO CUENTA SI LOS DOS LADOS TERMINARON COMO SE EXIGE A LA PETICIÓN
 *     SERVIDA (D12 corregida). La servida ya se excluye si salió cortada por el
 *     tope, parada por otro motivo o sin cumplir el contrato (clasificar.ts); si
 *     la copia no pasara por la MISMA regla, la selección sería asimétrica y se
 *     inventaría ahorro: con el mismo tope en los dos brazos, una copia cortada
 *     es la salida MÁS CARA posible, y quedarse solo con las servidas no
 *     cortadas es quedarse con las baratas. Con una capa que no hace nada y la
 *     misma distribución en los dos brazos, la regla asimétrica daba un 15 % de
 *     «ahorro»; la simétrica da ruido alrededor de cero (lo fija
 *     test/verificacion-nulo-simetrico.test.ts). Esos pares se cuentan, se
 *     enseñan y van en el CSV, pero no entran en NINGUNA cifra.
 *   · NINGÚN ESTRATO CON DATOS SE QUEDA FUERA DEL TITULAR (D11 endurecida):
 *     todo estrato con ≥ 1 par comparable entra con su peso. Los ≥ 10 pares por
 *     estrato son el mínimo para enseñar el IC PROPIO del estrato y, además, una
 *     verja: mientras los estratos con menos de 10 pares sumen más del 5 % de
 *     las peticiones elegibles, no hay titular («reuniendo»). Antes, un estrato
 *     con 9 pares que perdía dinero desaparecía del cálculo y el panel podía
 *     pintar «≥ 100 %» sobre un tercio del tráfico sin medir.
 *   · MÍNIMO DE PARES = los pares QUE ENTRAN en el titular (≥ 30), no los leídos.
 *   · COBERTURA = cuota de elegibles en estratos con algún par comparable: lo
 *     que el titular abarca. Si no es el 100 %, el pie lo dice (y el resto ya
 *     está acotado por la verja: ≤ 5 %).
 *   · PEOR CASO PARA LA CAPA (D10): cada copia valorada como si TODA su entrada
 *     se hubiera leído de caché (a la tarifa cacheada, o gratis sin ella). Es una
 *     cota con nombre propio, no una medición.
 *   · Nada de esto se factura ni se suma a ninguna cifra del extracto.
 */
import {
  bootstrapEstratificadoPonderado,
  bootstrapMediaCI,
  media,
  type CI,
  type EstratoPonderado,
} from "./bootstrap";
import { ESTRATOS, EXCLUSIONES, RESULTADOS, type Estrato, type Exclusion, type Resultado } from "./wire";

export const NIVEL = 0.95;
/** Pares comparables que tienen que ENTRAR en el titular para enseñar intervalo. */
export const MIN_PARES = 30;
/** Pares comparables para enseñar el IC propio de un estrato (y la vara de la verja de abajo). */
export const MIN_PARES_POR_ESTRATO = 10;
/**
 * Cuota máxima de las peticiones elegibles que puede estar en estratos con menos
 * de `MIN_PARES_POR_ESTRATO` pares para que haya titular. Por encima, un titular
 * podría esconder justo el tráfico donde la capa cuesta dinero.
 */
export const CUOTA_CORTA_MAXIMA = 0.05;
export const MAX_PARES_EN_INFORME = 20_000;
export const POR_CADA = 1000;

/** Una fila de `bvsala.verification_summary`, ya en números. */
export interface FilaDeResumen {
  outcome: string;
  stratum: string;
  samples: number;
  naiveCost: number;
  /** Copias cortadas por el tope (`naive_finish_reason = 'length'`). */
  naiveTruncated: number;
  /** Copias paradas por otro motivo (ni `stop`, ni `tool_calls`, ni `length`). */
  naiveIncomplete: number;
  /** Copias que terminaron bien pero incumplieron el contrato. Disjunta de las dos anteriores. */
  naiveContractMissed: number;
}

/** Un par `paired`, en números. */
export interface Par {
  stratum: string;
  naiveCost: number;
  optimizedCost: number;
  naiveInputTokens: number;
  naiveOutputTokens: number;
  cachedInputPer1k: number | null;
  outputPer1k: number;
  naiveFinishReason: string | null;
  naiveContract: string | null;
}

export type MotivoDeNoComparable = "truncated" | "incomplete" | "contract_missed";

/**
 * Por qué un par NO entra en las cifras, o `null` si entra. La MISMA regla, en
 * el MISMO orden, que `clasificar()` (src/verification/clasificar.ts) aplica a
 * la petición servida — y la misma precedencia que `verification_summary`
 * (0030), para que los recuentos del panel sumen lo que aquí se aparta.
 */
export function motivoDeNoComparable(p: Pick<Par, "naiveFinishReason" | "naiveContract">): MotivoDeNoComparable | null {
  const fin = p.naiveFinishReason;
  if (fin === "length") return "truncated";
  if (fin !== null && fin !== undefined && fin !== "stop" && fin !== "tool_calls") return "incomplete";
  if (p.naiveContract === "missed") return "contract_missed";
  return null;
}

export interface EstratoDelInforme {
  estrato: Estrato;
  elegibles: number;
  /** Pares COMPARABLES del estrato (los que entran en las cifras). */
  pares: number;
  mediaSinCapa: number | null;
  mediaConCapa: number | null;
  /** ≥ `MIN_PARES_POR_ESTRATO` pares: tiene IC propio. */
  cubierto: boolean;
  /** ≥ 1 par y N_h > 0: entra en el titular con su peso. */
  enTitular: boolean;
  /** Diferencia media (sin capa − con capa) por petición, con su IC; solo si está cubierto. */
  diferencia?: CI;
}

export interface InformeDelBancoPropio {
  estado: "sin_datos" | "reuniendo" | "listo";
  /** Solo en «reuniendo»: faltan pares en el titular, o hay demasiado tráfico en grupos cortos. */
  falta?: "pares" | "grupos";
  /** Todas las filas `paired` de la ventana (comparables o no). */
  paresTotales: number;
  /** Los pares leídos (≤ `MAX_PARES_EN_INFORME`; menos que los totales si se submuestreó). */
  paresLeidos: number;
  /** Los pares que entran en el titular: comparables y en un estrato con peso. */
  paresEnTitular: number;
  submuestreado: boolean;
  elegibles: number;
  /** Cuota de elegibles en estratos con algún par comparable: lo que abarca el titular. */
  cobertura: number;
  /** Cuota de elegibles en estratos con menos de `MIN_PARES_POR_ESTRATO` pares comparables. */
  cuotaCorta: number;
  /** Cuota de elegibles cuya copia volvió como par (comparable o no). */
  tasaLograda: number;
  remuestreos: number;
  semilla: number;
  titular?: { fraccion: CI; diferencia: CI };
  /** `fraccion` acotada para no quedar nunca por encima del titular; `sinAcotar`, el bootstrap tal cual. */
  peorCaso?: { fraccion: CI; sinAcotar: CI };
  estratos: EstratoDelInforme[];
  exclusiones: Array<{ motivo: Exclusion; peticiones: number }>;
  resultados: Array<{ resultado: Exclude<Resultado, "paired">; muestras: number }>;
  /** Pares que no entran en ninguna cifra, por motivo (del resumen exacto: disjuntos). */
  noComparables: { truncadas: number; incompletas: number; incumplidas: number };
  coste: { usd: number; copias: number; sinCoste: number };
}

/** `min(10 000, max(1 000, ⌊4·10⁷ / n⌋))`: el trabajo del bootstrap acotado con muchos pares. */
export function remuestreosPara(n: number): number {
  if (n <= 0) return 1000;
  return Math.min(10_000, Math.max(1_000, Math.floor(4e7 / n)));
}

/** El coste de la copia en el peor caso para la capa: toda su entrada leída de caché. */
export function costePeorCaso(p: Par): number {
  const conCache = (p.naiveInputTokens / 1000) * (p.cachedInputPer1k ?? 0) + (p.naiveOutputTokens / 1000) * p.outputPer1k;
  return Math.min(p.naiveCost, conCache);
}

export function informeDelBancoPropio(e: {
  conteos: Partial<Record<string, number>>;
  resumen: readonly FilaDeResumen[];
  pares: readonly Par[];
  totalPares: number;
  semilla: number;
  /** Solo tests: fija los remuestreos en vez de la fórmula. */
  remuestreos?: number;
}): InformeDelBancoPropio {
  const conteo = (k: string) => Math.max(0, Number(e.conteos[k] ?? 0));
  const filasDelEstrato = (h: string) => e.resumen.filter((f) => f.stratum === h).reduce((n, f) => n + f.samples, 0);
  const filasTotales = e.resumen.reduce((n, f) => n + f.samples, 0);
  const pairedDelResumen = e.resumen.filter((f) => f.outcome === "paired").reduce((n, f) => n + f.samples, 0);
  const paresTotales = Math.max(e.totalPares, pairedDelResumen);

  const N: Record<string, number> = {};
  for (const h of ESTRATOS) N[h] = Math.max(conteo(h), filasDelEstrato(h));
  const elegibles = ESTRATOS.reduce((n, h) => n + N[h]!, 0);

  // Solo los pares comparables entran en las cifras (D12 corregida, arriba).
  const porEstrato = new Map<string, Par[]>();
  for (const p of e.pares) {
    if (motivoDeNoComparable(p) !== null) continue;
    if (!porEstrato.has(p.stratum)) porEstrato.set(p.stratum, []);
    porEstrato.get(p.stratum)!.push(p);
  }
  const paresDe = (h: string) => porEstrato.get(h) ?? [];
  const enTitular = ESTRATOS.filter((h) => paresDe(h).length >= 1 && N[h]! > 0);
  const cubiertos = ESTRATOS.filter((h) => paresDe(h).length >= MIN_PARES_POR_ESTRATO && N[h]! > 0);
  const paresEnTitular = enTitular.reduce((n, h) => n + paresDe(h).length, 0);
  const cobertura = elegibles > 0 ? enTitular.reduce((n, h) => n + N[h]!, 0) / elegibles : 0;
  const cortos = ESTRATOS.filter((h) => !cubiertos.includes(h)).reduce((n, h) => n + N[h]!, 0);
  const cuotaCorta = elegibles > 0 ? cortos / elegibles : 1;
  const remuestreos = e.remuestreos ?? remuestreosPara(paresEnTitular);
  // 0,05 exacto (1 − 0,95 en coma flotante no lo es).
  const alfa = Math.round((1 - NIVEL) * 1e6) / 1e6;

  const exclusiones = EXCLUSIONES.map((motivo) => ({ motivo, peticiones: conteo(motivo) })).filter((x) => x.peticiones > 0);
  const resultados = RESULTADOS.filter((r): r is Exclude<Resultado, "paired"> => r !== "paired")
    .map((resultado) => ({
      resultado,
      muestras: e.resumen.filter((f) => f.outcome === resultado).reduce((n, f) => n + f.samples, 0),
    }))
    .filter((x) => x.muestras > 0);
  const deResultado = (r: string) => e.resumen.filter((f) => f.outcome === r);
  const noComparables = {
    truncadas: deResultado("paired").reduce((n, f) => n + f.naiveTruncated, 0),
    incompletas: deResultado("paired").reduce((n, f) => n + f.naiveIncomplete, 0),
    incumplidas: deResultado("paired").reduce((n, f) => n + f.naiveContractMissed, 0),
  };
  // Lo que no se pudo medir y aun así pudo costar: sin contador, cerradas en
  // vuelo y las que fallaron o agotaron el plazo (un timeout aborta NUESTRA
  // espera, no necesariamente la factura del proveedor). Las `dropped` nunca
  // salieron y no cuentan.
  const coste = {
    usd: e.resumen.reduce((n, f) => n + f.naiveCost, 0),
    copias: pairedDelResumen,
    sinCoste: [...deResultado("check_unmeasured"), ...deResultado("abandoned"), ...deResultado("check_failed")].reduce(
      (n, f) => n + f.samples,
      0,
    ),
  };

  const estratos: EstratoDelInforme[] = ESTRATOS.map((h, i) => {
    const ps = paresDe(h);
    const cubierto = cubiertos.includes(h);
    return {
      estrato: h,
      elegibles: N[h]!,
      pares: ps.length,
      mediaSinCapa: ps.length ? media(ps.map((p) => p.naiveCost)) : null,
      mediaConCapa: ps.length ? media(ps.map((p) => p.optimizedCost)) : null,
      cubierto,
      enTitular: enTitular.includes(h),
      ...(cubierto
        ? {
            diferencia: bootstrapMediaCI(
              ps.map((p) => p.naiveCost - p.optimizedCost),
              { remuestreos, alfa, semilla: e.semilla + i + 1 },
            ),
          }
        : {}),
    };
  });

  const sumaConteos = [...ESTRATOS, ...EXCLUSIONES].reduce((n, k) => n + conteo(k), 0);
  let estado: InformeDelBancoPropio["estado"];
  let falta: InformeDelBancoPropio["falta"];
  if (sumaConteos === 0 && filasTotales === 0) estado = "sin_datos";
  else if (paresEnTitular < MIN_PARES) {
    estado = "reuniendo";
    falta = "pares";
  } else if (elegibles <= 0 || cortos > CUOTA_CORTA_MAXIMA * elegibles + 1e-9) {
    estado = "reuniendo";
    falta = "grupos";
  } else estado = "listo";

  const base: InformeDelBancoPropio = {
    estado,
    ...(falta ? { falta } : {}),
    paresTotales,
    paresLeidos: e.pares.length,
    paresEnTitular,
    submuestreado: e.totalPares > e.pares.length,
    elegibles,
    cobertura,
    cuotaCorta,
    tasaLograda: elegibles > 0 ? paresTotales / elegibles : 0,
    remuestreos,
    semilla: e.semilla,
    estratos,
    exclusiones,
    resultados,
    noComparables,
    coste,
  };
  if (estado !== "listo") return base;

  const tal: EstratoPonderado[] = enTitular.map((h) => ({
    peso: N[h]!,
    a: paresDe(h).map((p) => p.naiveCost),
    b: paresDe(h).map((p) => p.optimizedCost),
  }));
  const peor: EstratoPonderado[] = enTitular.map((h) => ({
    peso: N[h]!,
    a: paresDe(h).map(costePeorCaso),
    b: paresDe(h).map((p) => p.optimizedCost),
  }));
  const o = { remuestreos, alfa, semilla: e.semilla };
  const titular = bootstrapEstratificadoPonderado(tal, o);
  const sinAcotar = bootstrapEstratificadoPonderado(peor, o).fraccion;
  // El peor caso NUNCA por encima de lo medido. Por construcción ya lo está
  // (cada copia vale ≤ y los remuestreos son los mismos), salvo en un borde: si
  // la copia en el peor caso sale gratis entera (Σ = 0), la convención del banco
  // da fracción 0 y eso podría quedar por ENCIMA de un titular negativo. Se
  // acota: ante la duda, el suelo más bajo.
  const peorCaso = {
    fraccion: {
      point: Math.min(sinAcotar.point, titular.fraccion.point),
      lower: Math.min(sinAcotar.lower, titular.fraccion.lower),
      upper: Math.min(sinAcotar.upper, titular.fraccion.upper),
    },
    sinAcotar,
  };
  return { ...base, titular, peorCaso };
}
