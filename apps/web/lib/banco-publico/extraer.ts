/**
 * EL BANCO PÚBLICO, LEÍDO DE SUS INFORMES.
 * ---------------------------------------------------------------------------
 * La página /benchmarks no escribe ni un número a mano: todo sale de los
 * informes JSON que las baterías publican en `docs/benchmarks/<fecha>/*.json`
 * (GSM8K, BFCL, XSTest y MT-Bench). Este módulo es PURO — recibe los informes
 * ya parseados y devuelve el resumen que pinta la página —, así que el test lo
 * alimenta con los mismos ficheros y comprueba cada cifra contra su origen.
 *
 * Reglas:
 *   · Cada (batería, modelo) enseña UNA tirada: la de la versión más alta de la
 *     capa; a igualdad, la medida antes que la no medida, luego la de más n y
 *     luego la más reciente. Un informe nuevo (p. ej. la gama alta) entra solo
 *     al aparecer en la carpeta: no hay lista de ficheros que mantener.
 *   · Toda cifra viaja con su n, su intervalo (cuando el informe lo da), su
 *     versión y su fecha.
 *   · Las garantías se CALCULAN sobre todas las tiradas desde la versión que
 *     cerró el fallo correspondiente; si una tirada las rompe, la página enseña
 *     el número que salga, no la frase.
 *   · Los fallos que el banco encontró llevan su evidencia contada en los
 *     informes; la versión que los arregla es un dato del historial (PR), y la
 *     página solo dice «verificado» si una tirada de esa versión o posterior lo
 *     midió y dio cero.
 *   · El BANCO SEMANAL (benchmarks/banco-semanal, `banco-semanal*.json`) es otro
 *     formato: una tirada de TODAS las baterías contra cada modelo, desde el
 *     fuente de `main` en ese momento (no una versión publicada). No entra en
 *     las tablas A/B por versión: tiene su propia sección, y sirve de evidencia
 *     a los fallos que declaran cómo leerlo (`semanal` en su definición).
 */

// Los informes son JSON de arneses distintos, sin un esquema común: se leen
// con accesores defensivos en vez de fingir un tipo que no existe.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

export const BATERIAS = ["gsm8k", "bfcl", "xstest", "mt-bench"] as const;
export type Bateria = (typeof BATERIAS)[number];

export interface Intervalo {
  punto: number;
  inf: number;
  sup: number;
}

export interface InformeFuente {
  /** Ruta relativa a la raíz del repo, p. ej. `docs/benchmarks/2026-09-28/gsm8k-0431.json`. */
  ruta: string;
  json: J;
}

export type Estado = "medido" | "no-medible" | "capa-falla";
/** Motivo de una tirada no medida, en categorías que la página traduce. */
export type Motivo = "credencial" | "presupuesto" | "cuota" | "capa" | "proveedor" | "otro";

interface RegistroBase {
  bateria: Bateria;
  modelo: string;
  estado: Estado;
  motivo?: Motivo;
  ruta: string;
  version: string;
  fecha: string;
  /** Tamaño de la muestra medida (peticiones, ítems, preguntas o prompts según la batería). */
  n: number;
}

export interface RegistroGsm8k extends RegistroBase {
  bateria: "gsm8k";
  ahorro?: Intervalo;
  costeA?: number;
  costeB?: number;
  /** Ahorro en posiciones que la capa sirvió de su caché (A pagó, B no llamó). */
  origenCacheCapaUsd?: number;
  /** Resto: ahorro en llamadas que sí llegaron al proveedor (caché de prefijo y ruido de salida). */
  origenLlamadasUsd?: number;
  /** Tokens de entrada leídos de la caché de prefijo del proveedor, A y B. */
  prefijoLeidoA?: number;
  prefijoLeidoB?: number;
  exactitudA?: { aciertos: number; n: number };
  exactitudB?: { aciertos: number; n: number };
  difExactitud?: Intervalo;
  /** Variantes (otra respuesta) comprobadas y servidas con la respuesta de OTRA pregunta, sumadas B+S+E. */
  variantes: number;
  deOtra: number;
  unicos?: number;
}

export interface RegistroBfcl extends RegistroBase {
  bateria: "bfcl";
  ahorro?: Intervalo;
  costeA?: number;
  costeB?: number;
  infieles: number;
  mismasLlamadas: number;
  difExactitud?: Intervalo;
  herramientasOmitidasPorB: number;
  multiTurnoEntradas: number;
}

export interface TasaNegativa {
  negativas: number;
  pares: number;
  tasa: number;
  inf: number;
  sup: number;
}

/** Tasa de negativa sin la capa (A) y con ella (B) sobre los mismos prompts, y la p de McNemar. */
export interface ParNegativas {
  A: TasaNegativa;
  B: TasaNegativa;
  p: number;
}

export interface RegistroXstest extends RegistroBase {
  bateria: "xstest";
  seguros?: ParNegativas;
  inseguros?: ParNegativas;
  textoComprobado: number;
  textoAlterado: number;
}

export interface RegistroMtBench extends RegistroBase {
  bateria: "mt-bench";
  ahorro?: Intervalo;
  /** «ahorro», «indistinguible de 0» o «sobrecoste», tal como lo clasifica el arnés. */
  clase?: string;
  /** ¿El arnés atribuye la diferencia de coste a la capa? */
  atribuible?: boolean;
  calidadTurnos?: number;
  calidadB?: Intervalo;
}

export type Registro = RegistroGsm8k | RegistroBfcl | RegistroXstest | RegistroMtBench;

export interface Dataset {
  bateria: Bateria;
  nombre: string;
  /** `propietario/nombre` del repositorio público del dataset, sin host (no se enlaza). */
  repo: string;
  commit: string;
  licencia: string;
  /** Ficheros fijados por sha256 (vacío si el arnés fija solo el commit). */
  ficheros: { nombre: string; sha256: string }[];
}

/** Lo que UNA tirada del banco semanal contó de las negativas de XSTest (celdas medidas). */
export interface EvidenciaSemanal {
  ruta: string;
  fecha: string;
  commit: string;
  /** Negativas servidas desde la caché de la capa o escritas en ella. */
  cacheadas: number;
  /** Negativas con ahorro acreditado o registro de referencia. */
  acreditadas: number;
  /** Prompts medidos, sumados en las celdas de XSTest. */
  sobre: number;
  modelos: number;
}

export interface Fallo {
  id: IdFallo;
  bateria: Bateria;
  encontradoEn: string;
  arregladoEn: string;
  prs: readonly number[];
  /** Ocurrencias en las tiradas anteriores al arreglo, y en cuántas unidades comprobadas. */
  antes: { ocurrencias: number; sobre: number; rutas: string[] };
  /** Lo mismo en las tiradas de la versión del arreglo o posteriores; null si ninguna lo midió aún. */
  despues: { ocurrencias: number; sobre: number; version: string; rutas: string[] } | null;
  /** La última tirada semanal ANTERIOR al arreglo que lo vio (solo los fallos que encontró el banco semanal). */
  antesSemanal?: EvidenciaSemanal;
  /** La última tirada semanal que ya medía `main` con el arreglo dentro. */
  despuesSemanal?: EvidenciaSemanal;
  /**
   * Sin re-medir: la última tirada semanal no pudo medir a los modelos del
   * fallo (p. ej. Gemini sin clave). Solo si nada lo ha medido tras el arreglo.
   */
  sinMedirSemanal?: { ruta: string; fecha: string; commit: string; estado: EstadoSemanal; motivo?: MotivoSemanal };
}

export interface Garantias {
  herramientas: { alteradas: number; comparaciones: number; modelos: number; desde: string };
  otraPregunta: {
    deOtra: number;
    variantes: number;
    modelos: number;
    desde: string;
    sinRed: { erroneas: number; peticiones: number; configuraciones: number; ruta: string } | null;
  };
  negativas: {
    modelos: { modelo: string; seguros?: ParNegativas; inseguros?: ParNegativas; n: number; ruta: string; version: string; fecha: string }[];
    textoAlterado: number;
    textoComprobado: number;
  };
}

// ---------------------------------------------------------------------------
// el banco semanal

/** Estado de una celda del banco semanal, en las categorías que la página traduce. */
export type EstadoSemanal = "medida" | "no-medible" | "sin-soporte" | "arnes-falla";
/** Por qué una celda no se midió. */
export type MotivoSemanal = "sin-clave" | "proveedor" | "tope-global" | "arnes-proveedor" | "arnes-modelo" | "arnes" | "otro";

/** La diferencia B − A de una celda, según la batería. */
export type DiferenciaSemanal =
  | { tipo: "exactitud"; valor: number; ic95?: Intervalo }
  | { tipo: "negativas"; seguros?: { valor: number; p?: number }; inseguros?: { valor: number; p?: number } }
  | { tipo: "victoria"; valor: number; ic95?: Intervalo };

export interface CeldaSemanal {
  bateria: Bateria;
  modelo: string;
  estado: EstadoSemanal;
  motivo?: MotivoSemanal;
  /** Medida pero cortada por su tope de gasto (intervalo más ancho). */
  cortadaPorTope: boolean;
  n: number;
  gastoUsd?: number;
  topeUsd?: number;
  /** Errores en B que A no tuvo. */
  fallosDeLaCapa?: number;
  respuestasDeOtraPregunta?: number;
  llamadasCambiadas?: number;
  negativasCacheadas?: number;
  negativasAcreditadas?: number;
  diferencia?: DiferenciaSemanal;
  /** (informe − factura) / factura del brazo B: cuánto se aparta el coste que informa la capa del que cobra el proveedor. */
  informeVsFactura?: number;
}

export interface TiradaSemanal {
  ruta: string;
  runId: string;
  /** Fecha (AAAA-MM-DD) e instantes de la tirada. */
  fecha: string;
  inicio: string;
  fin: string;
  /** Commit de `main` cuyo fuente se midió, y la versión que declaraba su package.json. */
  commit: string;
  version: string;
  gastoUsd: number;
  topeUsd?: number;
  ok: boolean;
  infracciones: number;
  celdas: CeldaSemanal[];
}

/** ¿Es un resultado del banco semanal (benchmarks/banco-semanal/orquestador.ts)? */
export function esBancoSemanal(json: J): boolean {
  return !!json && Array.isArray(json.resultados) && Array.isArray(json.plan) && typeof json.runId === "string" && !!json.veredicto;
}

function motivoSemanal(estado: string, texto: string | undefined): MotivoSemanal {
  const t = (texto ?? "").toLowerCase();
  if (estado === "sin-clave") return "sin-clave";
  if (estado === "omitida-por-tope-global") return "tope-global";
  if (estado === "sin-soporte") return /solo habla con|only talks to/.test(t) ? "arnes-proveedor" : /modelos_por_defecto|no tiene/.test(t) ? "arnes-modelo" : "otro";
  if (estado === "arnes-falla") return "arnes";
  if (/proveedor|provider|brazo a/.test(t)) return "proveedor";
  if (/tope|presupuesto|budget/.test(t)) return "tope-global";
  return "otro";
}

function celdaSemanal(x: J): CeldaSemanal {
  const base = { bateria: String(x.bateria) as Bateria, modelo: String(x.modelo), cortadaPorTope: false, n: 0 };
  if (x.estado === "sin-soporte") return { ...base, estado: "sin-soporte", motivo: motivoSemanal(x.estado, x.motivo) };
  if (x.estado !== "medida") {
    return { ...base, estado: x.estado === "arnes-falla" ? "arnes-falla" : "no-medible", motivo: motivoSemanal(x.estado, x.motivo), topeUsd: x.topeUsd };
  }
  const m = x.medicion ?? {};
  const comun = { ...base, gastoUsd: m.gastoUsd, topeUsd: x.topeUsd, fallosDeLaCapa: m.fallosDeLaCapa };
  if (m.estado !== "medido") return { ...comun, estado: "no-medible", motivo: motivoSemanal("medida", m.motivo), cortadaPorTope: !!m.cortadaPorTope };
  const deB = (m.exactitud ?? []).filter((e: J) => e.brazo === "B" && typeof e.valor === "number");
  let diferencia: DiferenciaSemanal | undefined;
  if (x.bateria === "xstest") {
    const de = (re: RegExp) => {
      const e = deB.find((y: J) => re.test(String(y.metrica)));
      return e ? { valor: e.valor, p: e.p } : undefined;
    };
    const seguros = de(/prompts seguros|safe prompts/);
    const inseguros = de(/prompts inseguros|unsafe prompts/);
    if (seguros || inseguros) diferencia = { tipo: "negativas", seguros, inseguros };
  } else if (deB[0]) {
    diferencia = { tipo: x.bateria === "mt-bench" ? "victoria" : "exactitud", valor: deB[0].valor, ic95: iv(deB[0].ic95) };
  }
  const f = (m.informeVsFactura ?? []).find((y: J) => y.brazo === "B");
  return {
    ...comun,
    estado: "medida",
    cortadaPorTope: !!m.cortadaPorTope,
    n: m.n ?? 0,
    respuestasDeOtraPregunta: m.respuestasDeOtraPregunta,
    llamadasCambiadas: m.llamadasCambiadas,
    negativasCacheadas: m.negativasCacheadas,
    negativasAcreditadas: m.negativasAcreditadas,
    diferencia,
    informeVsFactura: f && f.facturaUsd > 0 ? (f.informeUsd - f.facturaUsd) / f.facturaUsd : undefined,
  };
}

/** Una tirada del banco semanal; null si no es en vivo (el modo seco no mide nada). */
export function tiradaSemanal(f: InformeFuente): TiradaSemanal | null {
  const j = f.json;
  if (!esBancoSemanal(j) || !esVivo(j)) return null;
  const r = j.reparto ?? {};
  return {
    ruta: f.ruta,
    runId: String(j.runId),
    fecha: String(j.inicio ?? "").slice(0, 10),
    inicio: String(j.inicio ?? ""),
    fin: String(j.fin ?? ""),
    commit: String(j.commit ?? ""),
    version: String(j.version ?? ""),
    gastoUsd: j.gastoUsd ?? 0,
    // El tope global es lo asignado a las celdas más el margen (plan.ts).
    topeUsd: typeof r.asignadoUsd === "number" && typeof r.margenUsd === "number" ? r.asignadoUsd + r.margenUsd : undefined,
    ok: j.veredicto?.ok === true,
    infracciones: (j.veredicto?.infracciones ?? []).length,
    celdas: (j.resultados as J[]).map(celdaSemanal),
  };
}

/** Las negativas de XSTest que contó una tirada semanal, en sus celdas medidas. */
function negativasSemanales(t: TiradaSemanal): EvidenciaSemanal | null {
  const cs = t.celdas.filter((c) => c.bateria === "xstest" && c.estado === "medida");
  if (!cs.length) return null;
  return {
    ruta: t.ruta,
    fecha: t.fecha,
    commit: t.commit,
    cacheadas: cs.reduce((s, c) => s + (c.negativasCacheadas ?? 0), 0),
    acreditadas: cs.reduce((s, c) => s + (c.negativasAcreditadas ?? 0), 0),
    sobre: cs.reduce((s, c) => s + c.n, 0),
    modelos: new Set(cs.map((c) => c.modelo)).size,
  };
}

export interface Banco {
  fuentes: { ruta: string; bateria: Bateria; version: string; fecha: string }[];
  /** Las tiradas en vivo del banco semanal, de la más reciente a la más antigua. */
  semanales: TiradaSemanal[];
  datasets: Dataset[];
  registros: Registro[];
  modelos: string[];
  garantias: Garantias;
  fallos: Fallo[];
  /** Diseño del flujo de GSM8K (fracciones de repeticiones y paráfrasis), de la tirada más reciente. */
  flujoGsm8k: { repeticiones: number; parafrasis: number } | null;
  /** sha256 de `dist/index.js` del paquete medido, por versión (idéntico al tarball de npm según el informe). */
  distPorVersion: Record<string, string>;
  ultimaFecha: string;
}

// ---------------------------------------------------------------------------
// utilidades

/** Compara versiones `x.y.z` numéricamente. */
export function compararVersion(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function iv(x: J): Intervalo | undefined {
  if (!x || typeof x.point !== "number") return undefined;
  return { punto: x.point, inf: x.lower, sup: x.upper };
}

const FAMILIA_POR_PREFIJO: [RegExp, string][] = [
  [/^gpt-|^o\d/, "openai"],
  [/^claude-/, "anthropic"],
  [/^gemini-/, "google"],
];

/** `gpt-4o-mini` → `openai/gpt-4o-mini`; un id ya cualificado se deja igual. */
export function cualificar(nombre: string, familia?: string): string {
  if (nombre.includes("/")) return nombre;
  const f = familia ?? FAMILIA_POR_PREFIJO.find(([re]) => re.test(nombre))?.[1];
  return f ? `${f}/${nombre}` : nombre;
}

/** Categoriza el motivo de una tirada no medida. */
export function categorizarMotivo(texto: string | undefined, capaFalla = false): Motivo {
  if (capaFalla) return "capa";
  const t = (texto ?? "").toLowerCase();
  if (/401|credencial|clave inválida|invalid key|authentication/.test(t)) return "credencial";
  if (/429|quota|cuota|rate.?limit/.test(t)) return "cuota";
  if (/presupuesto|budget|abortad/.test(t)) return "presupuesto";
  if (/through the layer|por la capa|brazo b/.test(t)) return "capa";
  if (/\b4\d\d\b|provider|proveedor/.test(t)) return "proveedor";
  return "otro";
}

function bateriaDe(json: J): Bateria | null {
  const b = typeof json?.bateria === "string" ? json.bateria.toLowerCase() : null;
  if (b === "gsm8k" || b === "bfcl" || b === "mt-bench") return b;
  if (json?.porModelo && json?.informe) return "xstest";
  return null;
}

function versionDe(json: J, bateria: Bateria): string | null {
  const v =
    bateria === "gsm8k"
      ? json.procedencia?.version
      : bateria === "xstest"
        ? json.paquete?.versionEnEjecucion ?? json.paquete?.version
        : json.paquete?.version;
  return typeof v === "string" ? v : null;
}

function distDe(json: J, bateria: Bateria): string | undefined {
  if (bateria === "gsm8k") return json.procedencia?.distIndexSha256;
  if (bateria === "bfcl") return json.paquete?.sha256DistNpm;
  if (bateria === "xstest") return json.paquete?.distIndexSha256;
  return json.verificacionDelFuente?.npm?.sha256DistIndex;
}

/** Solo cuentan las tiradas EN VIVO: un informe bloqueado o simulado no entra en la página. */
function esVivo(json: J): boolean {
  const modo = String(json?.modo ?? "").toUpperCase();
  return (modo === "LIVE" || modo === "VIVO") && json?.estado !== "bloqueado-antes-de-gastar";
}

function fechaDe(json: J): string {
  return String(json.fecha ?? "").slice(0, 10);
}

// ---------------------------------------------------------------------------
// por batería

function registrosGsm8k(f: InformeFuente, version: string, fecha: string): RegistroGsm8k[] {
  const out: RegistroGsm8k[] = [];
  for (const m of f.json.modelos ?? []) {
    const base = { bateria: "gsm8k" as const, modelo: cualificar(m.modelo), ruta: f.ruta, version, fecha };
    const vpb = m.resumen?.variantesPorBrazo ?? {};
    const variantes = Object.values(vpb).reduce((s: number, v: J) => s + (v?.n ?? 0), 0) as number;
    const deOtra = Object.values(vpb).reduce((s: number, v: J) => s + (v?.deOtra ?? 0), 0) as number;
    if (m.estado !== "medido") {
      out.push({
        ...base,
        estado: m.estado === "capa-falla" ? "capa-falla" : "no-medible",
        motivo: categorizarMotivo(m.motivo, m.estado === "capa-falla"),
        n: m.peticionesCompletadas ?? 0,
        variantes,
        deOtra,
      });
      continue;
    }
    const cmpB = (m.resumen?.comparaciones ?? []).find((c: J) => c.brazo === "B");
    // Origen del ahorro, calculado posición a posición desde los ensayos: lo
    // que B no pagó porque la capa lo sirvió de su caché, y el resto.
    const porPos = new Map<number, { A?: J; B?: J }>();
    for (const e of m.ensayos ?? []) {
      if (e.brazo !== "A" && e.brazo !== "B") continue;
      const p = porPos.get(e.pos) ?? {};
      p[e.brazo as "A" | "B"] = e;
      porPos.set(e.pos, p);
    }
    let cacheCapa = 0;
    let llamadas = 0;
    for (const { A, B } of porPos.values()) {
      if (!A || !B) continue;
      const d = (A.coste ?? 0) - (B.coste ?? 0);
      if (B.fuente && B.fuente !== "provider") cacheCapa += d;
      else llamadas += d;
    }
    const bA = m.resumen?.brazos?.A;
    const bB = m.resumen?.brazos?.B;
    out.push({
      ...base,
      estado: "medido",
      n: m.peticionesCompletadas ?? 0,
      unicos: m.nUnicos,
      ahorro: iv(cmpB?.ahorroMedido),
      costeA: cmpB?.costeA,
      costeB: cmpB?.costeBrazo,
      origenCacheCapaUsd: porPos.size ? cacheCapa : undefined,
      origenLlamadasUsd: porPos.size ? llamadas : undefined,
      prefijoLeidoA: bA?.tokens?.cacheada,
      prefijoLeidoB: bB?.tokens?.cacheada,
      exactitudA: bA?.exactitud ? { aciertos: bA.exactitud.aciertos, n: bA.exactitud.n } : undefined,
      exactitudB: bB?.exactitud ? { aciertos: bB.exactitud.aciertos, n: bB.exactitud.n } : undefined,
      difExactitud: iv(cmpB?.diferenciaExactitud),
      variantes,
      deOtra,
    });
  }
  return out;
}

function registrosBfcl(f: InformeFuente, version: string, fecha: string): RegistroBfcl[] {
  const out: RegistroBfcl[] = [];
  const vistos = new Set<string>();
  const modelos = new Map<string, J>((f.json.modelos ?? []).map((m: J) => [m.modelo, m]));
  for (const r of f.json.resumen ?? []) {
    vistos.add(r.modelo);
    const m = modelos.get(r.modelo);
    const base = {
      bateria: "bfcl" as const,
      modelo: cualificar(r.modelo),
      ruta: f.ruta,
      version,
      fecha,
      infieles: (r.infieles ?? []).length,
      mismasLlamadas: r.mismasLlamadas ?? 0,
      herramientasOmitidasPorB: r.multiTurno?.herramientasOmitidasPorB ?? 0,
      multiTurnoEntradas: r.multiTurno?.entradas ?? 0,
    };
    if ((r.n ?? 0) > 0) {
      out.push({
        ...base,
        estado: "medido",
        n: r.n,
        ahorro: iv(r.coste?.ahorro),
        costeA: r.coste?.A,
        costeB: r.coste?.B,
        difExactitud: iv(r.diferenciaExactitud),
      });
      continue;
    }
    const errA = (r.erroresA ?? []).length;
    const errB = (r.erroresB ?? []).length;
    const motivo: Motivo =
      errB > 0 && errA === 0 ? "capa" : errB > 0 && errA > 0 ? "proveedor" : m?.abortadoPorPresupuesto ? "presupuesto" : categorizarMotivo((m?.errores ?? [])[0]);
    out.push({ ...base, estado: motivo === "capa" ? "capa-falla" : "no-medible", motivo, n: 0 });
  }
  for (const nm of f.json.noMedibles ?? []) {
    if (vistos.has(nm.modelo)) continue;
    out.push({
      bateria: "bfcl",
      modelo: cualificar(nm.modelo),
      ruta: f.ruta,
      version,
      fecha,
      estado: "no-medible",
      motivo: categorizarMotivo(nm.motivo),
      n: 0,
      infieles: 0,
      mismasLlamadas: 0,
      herramientasOmitidasPorB: 0,
      multiTurnoEntradas: 0,
    });
  }
  return out;
}

function tasa(x: J, pares: number): TasaNegativa {
  return { negativas: x.negativas, pares, tasa: x.tasa, inf: x.ic95?.lo, sup: x.ic95?.hi };
}

function registrosXstest(f: InformeFuente, version: string, fecha: string): RegistroXstest[] {
  const out: RegistroXstest[] = [];
  const resumen = new Map<string, J>((f.json.informe?.resumen ?? []).map((r: J) => [r.modelo, r]));
  for (const [nombre, pm] of Object.entries<J>(f.json.porModelo ?? {})) {
    const r = resumen.get(nombre);
    const base = { bateria: "xstest" as const, modelo: cualificar(nombre, pm.familia), ruta: f.ruta, version, fecha };
    const medidos = r?.medidos ?? pm.medidos ?? 0;
    // Un modelo puede medirse solo con los prompts inseguros (tope de gasto):
    // entonces lleva una de las dos tasas, no las dos.
    const par = (l: J) => (l && (l.pares ?? 0) > 0 ? { A: tasa(l.A, l.pares), B: tasa(l.B, l.pares), p: l.mcnemarP } : undefined);
    const seguros = par(r?.porLabel?.safe);
    const inseguros = par(r?.porLabel?.unsafe);
    if (medidos > 0 && (seguros || inseguros)) {
      out.push({
        ...base,
        estado: "medido",
        n: medidos,
        seguros,
        inseguros,
        textoComprobado: r.textoFiel?.comprobados ?? 0,
        textoAlterado: r.textoFiel?.alterados ?? 0,
      });
    } else {
      out.push({ ...base, estado: "no-medible", motivo: categorizarMotivo(pm.noMedible), n: 0, textoComprobado: 0, textoAlterado: 0 });
    }
  }
  return out;
}

function registrosMtBench(f: InformeFuente, version: string, fecha: string): RegistroMtBench[] {
  const out: RegistroMtBench[] = [];
  const fallidos = new Map<string, string>((f.json.modelosFallidos ?? []).map((x: J) => [x.modelo, String(x.error ?? "")]));
  for (const m of f.json.modelos ?? []) {
    const modelo = m.idCualificado ?? cualificar(m.modelo, m.familia);
    const base = { bateria: "mt-bench" as const, modelo, ruta: f.ruta, version, fecha };
    const error = fallidos.get(m.modelo);
    const completas = m.preguntas?.completas ?? 0;
    if (error !== undefined || completas === 0 || !m.coste?.ahorroPooled) {
      const motivo = categorizarMotivo(error ?? "");
      out.push({ ...base, estado: motivo === "capa" ? "capa-falla" : "no-medible", motivo, n: completas });
      continue;
    }
    out.push({
      ...base,
      estado: "medido",
      n: completas,
      ahorro: iv(m.coste.ahorroPooled),
      clase: m.coste.clase,
      atribuible: m.coste.atribucion?.atribuible,
      calidadTurnos: m.calidad?.turnosJuzgados,
      calidadB: iv(m.calidad?.tasaDeVictoriaB),
    });
  }
  // Un fallido que no llegó a la lista de modelos.
  const enLista = new Set((f.json.modelos ?? []).map((m: J) => m.modelo));
  for (const [nombre, error] of fallidos) {
    if (enLista.has(nombre)) continue;
    const motivo = categorizarMotivo(error);
    out.push({ bateria: "mt-bench", modelo: cualificar(nombre), ruta: f.ruta, version, fecha, estado: motivo === "capa" ? "capa-falla" : "no-medible", motivo, n: 0 });
  }
  return out;
}

/** `https://github.com/openai/grade-school-math` → `openai/grade-school-math` (la página no enlaza a GitHub). */
function sinHost(repo: unknown): string {
  return String(repo ?? "").replace(/^https?:\/\/(?:www\.)?github\.com\//i, "").replace(/\/+$/, "");
}

function datasetDe(json: J, bateria: Bateria): Dataset | null {
  const d = json.dataset;
  if (!d) return null;
  if (bateria === "gsm8k") {
    return {
      bateria,
      nombre: d.nombre,
      repo: sinHost(d.repo),
      commit: d.commit,
      licencia: d.licencia,
      ficheros: (d.ficheros ?? []).map((x: J) => ({ nombre: x.id, sha256: x.sha256 })),
    };
  }
  if (bateria === "bfcl") {
    return { bateria, nombre: "Berkeley Function Calling Leaderboard", repo: sinHost(d.repo), commit: d.commit, licencia: d.licencia, ficheros: [] };
  }
  if (bateria === "xstest") {
    return { bateria, nombre: "XSTest", repo: sinHost(d.fuente), commit: d.commit, licencia: d.licencia, ficheros: [{ nombre: "xstest_prompts.csv", sha256: d.sha256 }] };
  }
  if (d.repo && d.commit) {
    return {
      bateria,
      nombre: "MT-Bench",
      repo: sinHost(d.repo),
      commit: d.commit,
      licencia: d.license ?? d.licencia,
      ficheros: Object.entries<J>(d.ficheros ?? {}).map(([, x]) => ({ nombre: String(x.path).split("/").pop()!, sha256: x.sha256 })),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// fallos: lo que el banco encontró y en qué versión se arregló

export type IdFallo =
  | "otra-pregunta"
  | "herramientas-multiturno"
  | "negativas-de-texto"
  | "negativas-parciales"
  | "gemini-prompt-cache-key"
  | "gemini-filtro-cacheado"
  | "gemini-thought-signature";

interface DefinicionFallo {
  id: IdFallo;
  bateria: Bateria;
  encontradoEn: string;
  arregladoEn: string;
  prs: readonly number[];
  /** Ocurrencias y unidades comprobadas en UN informe; null si el informe no lo mide. */
  contar: (json: J) => { ocurrencias: number; sobre: number } | null;
  /**
   * Cómo lo lee el banco semanal (negativas de XSTest). El semanal mide el
   * fuente de `main`, no una versión publicada: una tirada lleva el arreglo si
   * EMPEZÓ después de que el PR entrara en `main` (`enMainDesde`, su mergedAt).
   * Con `encontrado`, las tiradas anteriores cuentan como la evidencia del fallo.
   */
  semanal?: { enMainDesde: string; encontrado: boolean };
  /** Modelos a los que se refiere (los de Gemini): si el semanal no pudo medirlos, se dice. */
  familia?: "google";
}

/**
 * #422 entró en `main` el 2026-09-29 a las 18:12:31 UTC (mergedAt del PR). El
 * contador del semanal no separa una negativa entera de una parcial: antes de
 * #422, lo que contó (tiradas 5e34ea y anteriores) eran negativas PARCIALES y
 * la carencia tras una disculpa (así las clasificó #422, caso a caso), y se
 * cuentan en ese fallo. Desde #422 una tirada a cero verifica las dos.
 */
const NEGATIVAS_PARCIALES_EN_MAIN = "2026-09-29T18:12:31Z";

const TIPOS_NEGATIVA_DE_TEXTO = new Set(["negativa-de-texto-servida-o-acreditada", "negativa-guardada-en-cache"]);
const TIPOS_FILTRO_DEL_API = new Set(["negativa-del-api-servida-sin-llamar", "negativa-del-api-no-reconocida-por-la-capa", "negativa-del-api-con-ahorro"]);

function promptsConHallazgo(json: J, tipos: Set<string>, delModelo: (modelo: string) => boolean = () => true): { ocurrencias: number; sobre: number } {
  const ids = new Set<string>();
  for (const h of json.informe?.hallazgos ?? []) {
    if (tipos.has(h.tipo) && delModelo(String(h.modelo))) ids.add(`${h.modelo}#${h.id}`);
  }
  const sobre = (json.informe?.resumen ?? []).filter((r: J) => delModelo(String(r.modelo))).reduce((s: number, r: J) => s + (r.medidos ?? 0), 0);
  return { ocurrencias: ids.size, sobre };
}

/**
 * El historial (versión y PR del arreglo) es un dato curado: sale de los
 * commits de `main` (#382, #383, #393, #401, #402). La EVIDENCIA, en cambio, se
 * cuenta en los informes; si un informe no la mide, el fallo no aparece.
 */
export const DEFINICIONES_DE_FALLOS: readonly DefinicionFallo[] = [
  {
    id: "otra-pregunta",
    bateria: "gsm8k",
    encontradoEn: "0.4.30",
    arregladoEn: "0.4.31",
    prs: [383],
    contar: (json) => {
      let ocurrencias = 0;
      let sobre = 0;
      let visto = false;
      for (const m of json.modelos ?? []) {
        if (m.estado !== "medido") continue;
        for (const v of Object.values<J>(m.resumen?.variantesPorBrazo ?? {})) {
          visto = true;
          ocurrencias += v?.deOtra ?? 0;
          sobre += v?.n ?? 0;
        }
      }
      return visto ? { ocurrencias, sobre } : null;
    },
  },
  {
    id: "herramientas-multiturno",
    bateria: "bfcl",
    encontradoEn: "0.4.30",
    arregladoEn: "0.4.31",
    prs: [382],
    contar: (json) => {
      const medidos = (json.resumen ?? []).filter((r: J) => (r.multiTurno?.entradas ?? 0) > 0);
      if (!medidos.length) return null;
      return {
        ocurrencias: medidos.reduce((s: number, r: J) => s + (r.multiTurno.herramientasOmitidasPorB ?? 0), 0),
        sobre: medidos.reduce((s: number, r: J) => s + (r.multiTurno.entradas ?? 0), 0),
      };
    },
  },
  {
    id: "negativas-de-texto",
    bateria: "xstest",
    encontradoEn: "0.4.31",
    arregladoEn: "0.4.32",
    prs: [393, 401],
    contar: (json) => (json.informe ? promptsConHallazgo(json, TIPOS_NEGATIVA_DE_TEXTO) : null),
    semanal: { enMainDesde: NEGATIVAS_PARCIALES_EN_MAIN, encontrado: false },
  },
  {
    // Lo encontró el banco semanal (tiradas del 2026-09-29 sobre main con la
    // 0.4.32): la negativa que empieza cumpliendo y se niega después, y «lo
    // siento, pero no tengo acceso…». Los informes A/B no lo cuentan aparte.
    id: "negativas-parciales",
    bateria: "xstest",
    encontradoEn: "0.4.32",
    arregladoEn: "0.4.33",
    prs: [422],
    contar: () => null,
    semanal: { enMainDesde: NEGATIVAS_PARCIALES_EN_MAIN, encontrado: true },
  },
  {
    id: "gemini-filtro-cacheado",
    familia: "google",
    bateria: "xstest",
    encontradoEn: "0.4.31",
    arregladoEn: "0.4.32",
    prs: [402],
    contar: (json) => {
      if (!json.informe || !Object.keys(json.porModelo ?? {}).some((k) => k.startsWith("gemini-"))) return null;
      return promptsConHallazgo(json, TIPOS_FILTRO_DEL_API, (m) => m.startsWith("gemini-"));
    },
  },
  {
    id: "gemini-prompt-cache-key",
    familia: "google",
    bateria: "gsm8k",
    encontradoEn: "0.4.31",
    arregladoEn: "0.4.32",
    prs: [402],
    contar: (json) => {
      let ocurrencias = 0;
      let sobre = 0;
      let visto = false;
      for (const m of json.modelos ?? []) {
        if (!String(m.modelo).startsWith("google/")) continue;
        visto = true;
        for (const e of m.ensayos ?? []) {
          if (e.brazo === "A") continue;
          sobre++;
          if (String(e.error ?? "").includes("prompt_cache_key")) ocurrencias++;
        }
      }
      return visto ? { ocurrencias, sobre } : null;
    },
  },
  {
    id: "gemini-thought-signature",
    familia: "google",
    bateria: "bfcl",
    encontradoEn: "0.4.31",
    arregladoEn: "0.4.32",
    prs: [402],
    contar: (json) => {
      let ocurrencias = 0;
      let sobre = 0;
      let visto = false;
      for (const m of json.modelos ?? []) {
        if (!String(m.modelo).startsWith("google/")) continue;
        for (const mt of m.multiTurno ?? []) {
          for (const v of mt.variantes ?? []) {
            visto = true;
            sobre++;
            if (String(v.error ?? "").includes("thought_signature")) ocurrencias++;
          }
        }
      }
      return visto ? { ocurrencias, sobre } : null;
    },
  },
];

// ---------------------------------------------------------------------------
// el resumen

function mejor(a: Registro, b: Registro): Registro {
  const v = compararVersion(a.version, b.version);
  if (v !== 0) return v > 0 ? a : b;
  const ma = a.estado === "medido" ? 1 : 0;
  const mb = b.estado === "medido" ? 1 : 0;
  if (ma !== mb) return ma > mb ? a : b;
  if (a.n !== b.n) return a.n > b.n ? a : b;
  return a.fecha >= b.fecha ? a : b;
}

const ORDEN_FAMILIA = ["openai", "anthropic", "google"];
function ordenModelo(a: string, b: string): number {
  const fa = ORDEN_FAMILIA.indexOf(a.split("/")[0]!);
  const fb = ORDEN_FAMILIA.indexOf(b.split("/")[0]!);
  if (fa !== fb) return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb);
  return a.localeCompare(b, "en", { numeric: true });
}

export function resumirBanco(informes: readonly InformeFuente[]): Banco {
  const fuentes: Banco["fuentes"] = [];
  const todos: Registro[] = [];
  const datasets = new Map<Bateria, Dataset>();
  const distPorVersion: Record<string, string> = {};
  const porFallo = new Map<IdFallo, { antes: Fallo["antes"]; despues: NonNullable<Fallo["despues"]> | null }>();
  let flujoGsm8k: Banco["flujoGsm8k"] = null;
  let flujoFecha = "";
  let sinRed: Garantias["otraPregunta"]["sinRed"] = null;
  let sinRedDe: { version: string; fecha: string } | null = null;

  const semanales: TiradaSemanal[] = [];

  const ordenados = [...informes].sort((a, b) => a.ruta.localeCompare(b.ruta));
  for (const f of ordenados) {
    if (esBancoSemanal(f.json)) {
      const t = tiradaSemanal(f);
      if (t) semanales.push(t);
      continue;
    }
    const bateria = bateriaDe(f.json);
    if (!bateria || !esVivo(f.json)) continue;
    const version = versionDe(f.json, bateria);
    if (!version) continue;
    const fecha = fechaDe(f.json);
    fuentes.push({ ruta: f.ruta, bateria, version, fecha });

    const dist = distDe(f.json, bateria);
    if (dist && !distPorVersion[version]) distPorVersion[version] = dist;

    const ds = datasetDe(f.json, bateria);
    if (ds && !datasets.has(bateria)) datasets.set(bateria, ds);

    if (bateria === "gsm8k") {
      todos.push(...registrosGsm8k(f, version, fecha));
      if (f.json.flujo && fecha >= flujoFecha) {
        flujoGsm8k = { repeticiones: f.json.flujo.fraccionRepeticiones, parafrasis: f.json.flujo.fraccionParafrasis };
        flujoFecha = fecha;
      }
      const res = f.json.sinRed?.resultados;
      const masNuevo = !sinRedDe || compararVersion(version, sinRedDe.version) > 0 || (compararVersion(version, sinRedDe.version) === 0 && fecha > sinRedDe.fecha);
      if (Array.isArray(res) && res.length && masNuevo) {
        sinRedDe = { version, fecha };
        sinRed = {
          erroneas: res.reduce((s: number, r: J) => s + (r.erroneas ?? 0), 0),
          peticiones: f.json.sinRed.preguntas ?? res[0].peticiones,
          configuraciones: res.length,
          ruta: f.ruta,
        };
      }
    } else if (bateria === "bfcl") todos.push(...registrosBfcl(f, version, fecha));
    else if (bateria === "xstest") todos.push(...registrosXstest(f, version, fecha));
    else todos.push(...registrosMtBench(f, version, fecha));

    for (const def of DEFINICIONES_DE_FALLOS) {
      if (def.bateria !== bateria) continue;
      const c = def.contar(f.json);
      if (!c) continue;
      const acc = porFallo.get(def.id) ?? { antes: { ocurrencias: 0, sobre: 0, rutas: [] }, despues: null };
      if (compararVersion(version, def.arregladoEn) < 0) {
        if (compararVersion(version, def.encontradoEn) >= 0) {
          acc.antes.ocurrencias += c.ocurrencias;
          acc.antes.sobre += c.sobre;
          acc.antes.rutas.push(f.ruta);
        }
      } else {
        const d = acc.despues ?? { ocurrencias: 0, sobre: 0, version, rutas: [] };
        d.ocurrencias += c.ocurrencias;
        d.sobre += c.sobre;
        d.rutas.push(f.ruta);
        if (compararVersion(version, d.version) < 0) d.version = version;
        acc.despues = d;
      }
      porFallo.set(def.id, acc);
    }
  }

  // Una tirada por (batería, modelo).
  const elegidos = new Map<string, Registro>();
  for (const r of todos) {
    const k = `${r.bateria}|${r.modelo}`;
    const prev = elegidos.get(k);
    elegidos.set(k, prev ? mejor(prev, r) : r);
  }
  const registros = [...elegidos.values()].sort(
    (a, b) => BATERIAS.indexOf(a.bateria) - BATERIAS.indexOf(b.bateria) || ordenModelo(a.modelo, b.modelo),
  );
  const modelos = [...new Set(registros.map((r) => r.modelo))].sort(ordenModelo);

  // Garantías, sobre TODAS las tiradas medidas desde la versión del arreglo.
  const desdeHerr = DEFINICIONES_DE_FALLOS.find((d) => d.id === "herramientas-multiturno")!.arregladoEn;
  const desdeOtra = DEFINICIONES_DE_FALLOS.find((d) => d.id === "otra-pregunta")!.arregladoEn;
  const bfclDesde = todos.filter((r): r is RegistroBfcl => r.bateria === "bfcl" && r.estado === "medido" && compararVersion(r.version, desdeHerr) >= 0);
  const gsmDesde = todos.filter((r): r is RegistroGsm8k => r.bateria === "gsm8k" && r.estado === "medido" && compararVersion(r.version, desdeOtra) >= 0);
  const xsElegidos = registros.filter((r): r is RegistroXstest => r.bateria === "xstest" && r.estado === "medido");

  const garantias: Garantias = {
    herramientas: {
      alteradas: bfclDesde.reduce((s, r) => s + r.infieles, 0),
      comparaciones: bfclDesde.reduce((s, r) => s + r.n, 0),
      modelos: new Set(bfclDesde.map((r) => r.modelo)).size,
      desde: desdeHerr,
    },
    otraPregunta: {
      deOtra: gsmDesde.reduce((s, r) => s + r.deOtra, 0),
      variantes: gsmDesde.reduce((s, r) => s + r.variantes, 0),
      modelos: new Set(gsmDesde.map((r) => r.modelo)).size,
      desde: desdeOtra,
      sinRed,
    },
    negativas: {
      modelos: xsElegidos.map((r) => ({ modelo: r.modelo, seguros: r.seguros, inseguros: r.inseguros, n: r.n, ruta: r.ruta, version: r.version, fecha: r.fecha })),
      textoAlterado: xsElegidos.reduce((s, r) => s + r.textoAlterado, 0),
      textoComprobado: xsElegidos.reduce((s, r) => s + r.textoComprobado, 0),
    },
  };

  semanales.sort((a, b) => b.inicio.localeCompare(a.inicio) || b.ruta.localeCompare(a.ruta));
  const ultimaSemanal = semanales[0];

  const fallos: Fallo[] = [];
  for (const def of DEFINICIONES_DE_FALLOS) {
    const acc = porFallo.get(def.id) ?? { antes: { ocurrencias: 0, sobre: 0, rutas: [] }, despues: null };
    const fallo: Fallo = { id: def.id, bateria: def.bateria, encontradoEn: def.encontradoEn, arregladoEn: def.arregladoEn, prs: def.prs, antes: acc.antes, despues: acc.despues };
    if (def.semanal) {
      const { enMainDesde, encontrado } = def.semanal;
      const conArreglo = (t: TiradaSemanal) => Date.parse(t.inicio) >= Date.parse(enMainDesde);
      // `semanales` va de la más reciente a la más antigua.
      const antes = encontrado
        ? semanales
            .filter((t) => !conArreglo(t))
            .map(negativasSemanales)
            .find((e): e is EvidenciaSemanal => !!e && e.cacheadas + e.acreditadas > 0)
        : undefined;
      const despues = semanales.filter(conArreglo).map(negativasSemanales).find((e): e is EvidenciaSemanal => !!e);
      if (antes) fallo.antesSemanal = antes;
      if (despues) fallo.despuesSemanal = despues;
    }
    if (def.familia && !fallo.despues && !fallo.despuesSemanal && ultimaSemanal) {
      const suyas = ultimaSemanal.celdas.filter((c) => c.bateria === def.bateria && c.modelo.startsWith(`${def.familia}/`));
      const sinMedir = suyas.find((c) => c.estado !== "medida");
      if (sinMedir && !suyas.some((c) => c.estado === "medida")) {
        fallo.sinMedirSemanal = { ruta: ultimaSemanal.ruta, fecha: ultimaSemanal.fecha, commit: ultimaSemanal.commit, estado: sinMedir.estado, motivo: sinMedir.motivo };
      }
    }
    // Sin evidencia antes del arreglo (en un informe A/B o en una tirada
    // semanal), el fallo no se enseña: la página no cuenta nada que los
    // informes publicados no muestren.
    if (acc.antes.ocurrencias === 0 && !fallo.antesSemanal) continue;
    fallos.push(fallo);
  }

  return {
    fuentes,
    semanales,
    datasets: BATERIAS.map((b) => datasets.get(b)).filter((d): d is Dataset => !!d),
    registros,
    modelos,
    garantias,
    fallos,
    flujoGsm8k,
    distPorVersion,
    ultimaFecha: [...fuentes, ...semanales].reduce((m, f) => (f.fecha > m ? f.fecha : m), ""),
  };
}
