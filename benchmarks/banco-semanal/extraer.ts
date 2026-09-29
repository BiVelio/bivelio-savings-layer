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
 * Todo es puro: recibe el JSON ya leído.
 */
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
  /** Ítems con los dos brazos válidos (pares, preguntas o prompts). */
  n: number;
  /** El arnés paró antes de terminar la submuestra por su tope: la medición vale, pero es menor. */
  cortadaPorTope: boolean;
  /** GSM8K: respuestas servidas de otra pregunta (brazos con capa en vivo + repetición sin red). */
  respuestasDeOtraPregunta?: number;
  /** BFCL: llamadas a herramienta que la capa devolvió distintas de las que recibió del proveedor, o herramientas omitidas. */
  llamadasCambiadas?: number;
  /** XSTest: negativas servidas desde la caché (o escritas en ella). */
  negativasCacheadas?: number;
  /** XSTest: negativas con ahorro acreditado o con registro de referencia. */
  negativasAcreditadas?: number;
  fallosDeLaCapa: number;
  /** Hasta 5 ejemplos de fallos de la capa (ya pasados por el `sinSecretos` de cada arnés). */
  ejemplosDeFallos: string[];
  exactitud: Exactitud[];
  informeVsFactura: InformeVsFactura[];
}

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

// ── GSM8K ───────────────────────────────────────────────────────────────────

interface EnsayoGsm8k {
  pos: number;
  brazo: string;
  coste: number;
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
  const fallos = ensayos.filter((e) => e.brazo !== "A" && e.error && !esPresupuesto(e.error) && errorDeA.get(e.pos) === false);

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

  return {
    ...base,
    estado: "medido",
    n: ensayos.filter((e) => e.brazo === "A" && !e.error).length,
    cortadaPorTope: estado === "abortado-presupuesto",
    respuestasDeOtraPregunta: deOtraEnVivo + deOtraSinRed,
    fallosDeLaCapa: fallos.length,
    ejemplosDeFallos: ejemplos(fallos.map((e) => `${e.brazo} pos ${e.pos}: ${e.error}`)),
    exactitud,
    informeVsFactura,
  };
}

// ── BFCL ────────────────────────────────────────────────────────────────────

interface EntradaAstBfcl {
  id: string;
  B: { ok: boolean; coste: number; informe?: { actual: number } };
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
  const ast = campo<(EntradaAstBfcl & { A: { ok: boolean } })[]>(t, "ast");
  if (ast.length > 0 && ast.every((e) => !e.A.ok)) {
    return { ...base, estado: "no-medible", motivo: "ninguna respuesta válida del proveedor en el brazo A", gastoUsd, n: 0, cortadaPorTope: false, fallosDeLaCapa: 0 };
  }
  if (ast.length === 0) {
    return { ...base, estado: "no-medible", motivo: NINGUNO, gastoUsd, n: 0, cortadaPorTope: campo<boolean>(r, "gasto.abortado"), fallosDeLaCapa: 0 };
  }
  const infieles = campo<string[]>(r, "infieles");
  const multi = (r["multiTurno"] as { herramientasOmitidasPorB?: number; violaciones?: string[] } | undefined) ?? {};
  const erroresA = new Set(campo<{ id: string }[]>(r, "erroresA").map((e) => e.id));
  const soloB = campo<{ id: string; error: string }[]>(r, "erroresB").filter((e) => !erroresA.has(e.id) && !esPresupuesto(e.error));
  const violaciones = multi.violaciones ?? [];
  const dif = campo<IntervaloDeConfianza | null>(r, "diferenciaExactitud");
  const conInforme = ast.filter((e) => e.B.ok && e.B.informe && typeof e.B.coste === "number");
  return {
    ...base,
    estado: "medido",
    gastoUsd,
    n,
    cortadaPorTope: campo<boolean>(r, "gasto.abortado"),
    llamadasCambiadas: infieles.length + (multi.herramientasOmitidasPorB ?? 0),
    fallosDeLaCapa: soloB.length + violaciones.length,
    ejemplosDeFallos: ejemplos([...soloB.map((e) => `${e.id}: ${e.error}`), ...violaciones.map((v) => `aislamiento de caché: ${v}`)]),
    exactitud: [{ brazo: "B", metrica: "exactitud AST (B − A)", valor: dif?.point ?? null, ic95: dif, peorSignificativo: !!dif && dif.upper < 0 }],
    informeVsFactura: [
      { brazo: "B", informeUsd: suma(conInforme.map((e) => e.B.informe!.actual)), facturaUsd: suma(conInforme.map((e) => e.B.coste)), llamadas: conInforme.length },
    ],
  };
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

  const registros = campo<{ modelo: string; id: number; A?: { error?: string }; B?: { error?: string }; repeticiones?: { error?: string }[] }[]>(art, "registros").filter(
    (x) => x.modelo === modelo.corto,
  );
  const soloB = registros.filter((x) => x.B?.error && !x.A?.error && !esPresupuesto(x.B.error));
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
  return {
    ...base,
    estado: "medido",
    gastoUsd,
    n: campo<number>(r, "medidos"),
    cortadaPorTope: campo<boolean>(pm, "cortadoPorPresupuesto"),
    negativasCacheadas: cacheadas,
    negativasAcreditadas: acreditadas,
    fallosDeLaCapa: soloB.length + alterados,
    ejemplosDeFallos: ejemplos([
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
  };
}

// ── MT-Bench ────────────────────────────────────────────────────────────────

export interface PreguntaCrudaMtBench {
  id: number;
  error?: string;
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
  const gastoUsd = campo<number>(r, "gasto.total") + campo<number>(r, "gasto.juez");
  const preguntas = crudo?.find((x) => x.modelo === modelo.corto)?.preguntas;
  let fallos: string[];
  if (preguntas) {
    // Promise.all de A y B: un error de A llega como «brazo A …»; cualquier otro salió de la capa.
    fallos = preguntas.filter((p) => p.error && !/^brazo A\b/.test(p.error) && !esPresupuesto(p.error)).map((p) => `pregunta ${p.id}: ${p.error}`);
  } else {
    fallos = campo<string[]>(r, "errores")
      .filter((e) => /^B t\d/.test(e))
      .map((e) => `${e} (del informe: lista recortada)`);
  }
  if (campo<number>(r, "preguntas.completas") === 0 && fallos.length === 0) {
    return { ...base, estado: "no-medible", motivo: NINGUNO, gastoUsd, n: 0, cortadaPorTope: campo<boolean>(r, "preguntas.cortePorPresupuesto"), fallosDeLaCapa: 0 };
  }
  const juzgada = campo<boolean>(r, "calidad.juzgada");
  const tasa = juzgada ? campo<IntervaloDeConfianza | null>(r, "calidad.tasaDeVictoriaB") : null;
  return {
    ...base,
    estado: "medido",
    gastoUsd,
    n: campo<number>(r, "preguntas.completas"),
    cortadaPorTope: campo<boolean>(r, "preguntas.cortePorPresupuesto"),
    fallosDeLaCapa: fallos.length,
    ejemplosDeFallos: ejemplos(fallos),
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
  };
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
