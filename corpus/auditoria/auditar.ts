/**
 * LA AUDITORÍA ADVERSARIA DEL CORPUS. Este fichero no mide un knapsack: mide el
 * corpus, y su pregunta es una sola —¿este conjunto de casos daría por bueno un
 * knapsack malo?—.
 *
 * Seis ejes, todos CONTADOS y ninguno a ojo:
 *
 *   1. LÍNEAS BASE TONTAS. Si «las k primeras» o «las k que más se parecen a la
 *      pregunta» aprueban, aprobar aquí no demuestra nada.
 *   2. SESGO DE POSICIÓN. Dónde caen las necesarias dentro de la lista.
 *   3. PLAUSIBILIDAD DE LAS DISTRACTORAS. Si la necesaria le saca cien puntos a
 *      la mejor distractora, la distractora no distrae.
 *   4. ADIVINABILIDAD SIN EVIDENCIA. Respuestas que se aciertan sabiendo que el
 *      IVA general es el 21 % o que la garantía legal son dos años.
 *   5. IDIOMA. Si el catalán es decorativo, «sin degradación por idioma» se
 *      cumple por construcción y no significa nada.
 *   6. PRESUPUESTO. Un caso sin presión no mide un knapsack, mide un `map`.
 *
 * Correr: `pnpm tsx corpus/auditoria/auditar.ts`
 */

import { normalizeText } from "../../src/canonicalization/canonicalize.js";
import { cargarClaseIncomoda, cargarCorpusEntero, type CasoIncomodo, type CasoVista } from "../vista.js";
import {
  azarK,
  correr,
  evaluar,
  masLargasK,
  oraculo,
  primerosK,
  solapeLexicoK,
  todo,
  ultimosK,
  type Informe,
} from "./lineas-base.js";

const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;

// ─── 1. Líneas base ──────────────────────────────────────────────────────────

export function lineasBase(casos: CasoVista[]): Informe[] {
  return [
    correr("mandarlo-todo", casos, todo),
    correr("primeros-k", casos, primerosK),
    correr("ultimos-k", casos, ultimosK),
    correr("mas-largas-k", casos, masLargasK),
    correr("solape-lexico-k", casos, solapeLexicoK),
    correr("oraculo", casos, oraculo),
  ];
}

/**
 * EL NÚCLEO DISCRIMINANTE. La tasa de cada línea base por separado engaña,
 * porque cada una regala casos distintos. Lo que de verdad mide el poder de
 * arbitraje del corpus es la ENVOLVENTE: un caso que resuelva CUALQUIERA de las
 * cuatro tontas es un caso que un knapsack aprobará sin haber demostrado nada.
 *
 * El núcleo son los que no resuelve ninguna. Es el número que hay que mirar
 * antes de gatear F6 con esto, y es mucho más pequeño que 150.
 */
export interface Nucleo {
  total: number;
  /** Casos que resuelve al menos una línea base tonta. */
  regalados: number;
  /** Casos que no resuelve ninguna. Aquí es donde un knapsack se gana el sueldo. */
  nucleo: string[];
  porOrigen: Record<string, number>;
  porIdioma: Record<string, number>;
  porDificultad: Record<string, number>;
}

export function nucleoDiscriminante(casos: CasoVista[]): Nucleo {
  const tontas = [primerosK, ultimosK, masLargasK, solapeLexicoK];
  const nucleo: string[] = [];
  const porOrigen: Record<string, number> = {};
  const porIdioma: Record<string, number> = {};
  const porDificultad: Record<string, number> = {};
  for (const c of casos) {
    if (tontas.some((s) => evaluar(c, s(c)).resuelto)) continue;
    nucleo.push(c.id);
    porOrigen[c.origen] = (porOrigen[c.origen] ?? 0) + 1;
    porIdioma[c.idioma] = (porIdioma[c.idioma] ?? 0) + 1;
    porDificultad[c.dificultad] = (porDificultad[c.dificultad] ?? 0) + 1;
  }
  return {
    total: casos.length,
    regalados: casos.length - nucleo.length,
    nucleo,
    porOrigen,
    porIdioma,
    porDificultad,
  };
}

// ─── 2. Sesgo de posición ────────────────────────────────────────────────────

export interface SesgoDePosicion {
  /** Media de la posición normalizada (0 = primera, 1 = última) de las necesarias. */
  posicionMediaNecesarias: number;
  /** Lo mismo para las prescindibles. Si difieren, hay sesgo. */
  posicionMediaPrescindibles: number;
  /** Casos donde TODAS las necesarias caen dentro de las k primeras. */
  necesariasEnCabeza: number;
  /** Casos donde TODAS las necesarias caen dentro de las k últimas. */
  necesariasEnCola: number;
  total: number;
}

export function sesgoDePosicion(casos: CasoVista[]): SesgoDePosicion {
  let sN = 0;
  let nN = 0;
  let sP = 0;
  let nP = 0;
  let cabeza = 0;
  let cola = 0;
  for (const c of casos) {
    const n = c.unidades.length;
    const nec = new Set(c.necesarias);
    for (const u of c.unidades) {
      const p = n === 1 ? 0.5 : u.orden / (n - 1);
      if (nec.has(u.id)) {
        sN += p;
        nN += 1;
      } else {
        sP += p;
        nP += 1;
      }
    }
    const k = c.presupuestoMax;
    const idsCabeza = new Set(c.unidades.slice(0, k).map((u) => u.id));
    const idsCola = new Set(c.unidades.slice(Math.max(0, n - k)).map((u) => u.id));
    if (c.necesarias.every((id) => idsCabeza.has(id))) cabeza += 1;
    if (c.necesarias.every((id) => idsCola.has(id))) cola += 1;
  }
  return {
    posicionMediaNecesarias: nN === 0 ? 0 : sN / nN,
    posicionMediaPrescindibles: nP === 0 ? 0 : sP / nP,
    necesariasEnCabeza: cabeza,
    necesariasEnCola: cola,
    total: casos.length,
  };
}

// ─── 3. Plausibilidad de las distractoras ────────────────────────────────────

const PARADAS = new Set(
  ("de la el los las un una unos unas y o a en que es se del al por para con sin " +
    "no si su sus lo le les mi me te ha he han hay como cuando donde cual cuales " +
    "dels als amb per qui quan on els les uns unes pel hi ho ja s l d n m t").split(/\s+/),
);

function tokens(texto: string): Set<string> {
  return new Set(
    normalizeText(texto)
      .split(/[^\p{L}\p{N}.,/-]+/u)
      .map((t) => t.replace(/^[.,/-]+|[.,/-]+$/g, ""))
      .filter((t) => t.length > 1 && !PARADAS.has(t)),
  );
}

/** Solape de Jaccard entre la consulta y una unidad, tras `normalizeText`. */
function solape(consulta: Set<string>, unidad: Set<string>): number {
  let inter = 0;
  for (const t of consulta) if (unidad.has(t)) inter += 1;
  return consulta.size === 0 ? 0 : inter / consulta.size;
}

export interface Plausibilidad {
  /**
   * Margen = (peor necesaria) − (mejor prescindible), en solape con la consulta.
   * Positivo ⇒ la necesaria se ve a la legua y la distractora no distrae.
   */
  margenMedio: number;
  /** Casos con margen > 0: los que un recuperador resuelve mirando la pregunta. */
  casosRegalados: number;
  /** Casos con margen ≤ 0: la distractora se parece a la pregunta tanto o más. */
  casosDuros: number;
  peores: Array<{ id: string; margen: number }>;
}

export function plausibilidad(casos: CasoVista[]): Plausibilidad {
  const filas: Array<{ id: string; margen: number }> = [];
  for (const c of casos) {
    const q = tokens(c.consulta);
    const nec = new Set(c.necesarias);
    const sNec = c.unidades.filter((u) => nec.has(u.id)).map((u) => solape(q, tokens(u.texto)));
    const sPre = c.unidades.filter((u) => !nec.has(u.id)).map((u) => solape(q, tokens(u.texto)));
    if (sNec.length === 0 || sPre.length === 0) continue;
    filas.push({ id: c.id, margen: Math.min(...sNec) - Math.max(...sPre) });
  }
  const margenMedio = filas.reduce((a, f) => a + f.margen, 0) / (filas.length || 1);
  return {
    margenMedio,
    casosRegalados: filas.filter((f) => f.margen > 0).length,
    casosDuros: filas.filter((f) => f.margen <= 0).length,
    peores: [...filas].sort((a, b) => b.margen - a.margen).slice(0, 12),
  };
}

// ─── 4. Adivinabilidad sin evidencia ─────────────────────────────────────────

/**
 * Constantes que un modelo entrenado con internet en español sabe de memoria.
 * Un caso cuya respuesta crítica es una de estas se puede acertar TIRANDO el
 * documento, así que no mide el selector: mide lo que el modelo ya sabía.
 */
const SABIDAS: ReadonlyArray<{ valores: string[]; campo: RegExp; que: string }> = [
  { valores: ["21", "21.00"], campo: /iva/i, que: "el IVA general español es el 21 %" },
  { valores: ["10", "10.00", "4", "4.00"], campo: /iva/i, que: "tipos reducidos de IVA (10 % / 4 %)" },
  { valores: ["7", "7.00"], campo: /igic/i, que: "el IGIC general canario es el 7 %" },
  { valores: ["14"], campo: /desistimiento|desistiment|devoluc|retorn/i, que: "los 14 días de desistimiento de la UE" },
  { valores: ["2", "3"], campo: /garantia|garantía/i, que: "la garantía legal española (2 años → 3 desde 2022)" },
  { valores: ["30"], campo: /devoluc|retorn|plazo_dias$|termini_dies$/i, que: "los 30 días de devolución que anuncia medio comercio electrónico" },
  { valores: ["60"], campo: /pago|pagament|aplazamiento|morosidad/i, que: "el tope legal de 60 días entre empresas" },
];

export interface Adivinable {
  /** El valor crítico aparece LITERAL en la propia consulta. */
  enLaConsulta: Array<{ id: string; campo: string; valor: string }>;
  /** El valor crítico es una constante de dominio público. */
  sabidaDeMemoria: Array<{ id: string; campo: string; valor: string; que: string }>;
  /**
   * El valor crítico aparece también en una unidad PRESCINDIBLE. Va separado
   * por papel porque no significan lo mismo: que el valor esté en la
   * contradictoria o en la derogada es la trampa (las dos dicen una cifra y solo
   * una manda); que esté en una DISTRACTORA es un defecto — el caso deja de
   * castigar el fallo que dice castigar, porque tirar la necesaria sigue
   * dejando el número a la vista.
   */
  enUnaPrescindible: Array<{
    id: string;
    campo: string;
    valor: string;
    unidad: string;
    papel: string;
  }>;
  /** Reparto de los campos booleanos: si uno domina, «di siempre eso» acierta. */
  baseRateBooleanos: Record<string, number>;
  /** Reparto de abstenciones: «no contestes nunca» acierta este porcentaje. */
  tasaDeAbstencion: number;
}

const NUM = /^-?\d+(?:\.\d+)?$/;

/**
 * Un importe se escribe «12.480,55 €» en el documento y "12480.55" en la
 * respuesta: hay que comparar CANTIDADES, no cadenas. Y hay que hacerlo bien:
 * una primera versión de esto comparaba los dígitos con los ceros finales
 * recortados, y daba 84.000 EUR y 8.400 EUR por el mismo número — o sea que
 * inventaba fugas donde la trampa de «un orden de magnitud» estaba bien puesta.
 */
function aCantidad(s: string): number | null {
  const t = s.replace(/[^\d.,]/g, "");
  if (t === "") return null;
  // «1.234,56» → 1234.56 ; «1,234.56» → 1234.56 ; «1234.56» → 1234.56
  const ultimaComa = t.lastIndexOf(",");
  const ultimoPunto = t.lastIndexOf(".");
  let limpio: string;
  if (ultimaComa > ultimoPunto) limpio = t.replace(/\./g, "").replace(",", ".");
  else if (ultimoPunto > ultimaComa) limpio = t.replace(/,/g, "");
  else limpio = t;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

function apareceEn(texto: string, valor: string): boolean {
  if (!NUM.test(valor)) {
    const v = normalizeText(valor);
    return v.length > 2 && normalizeText(texto).includes(v);
  }
  const objetivo = aCantidad(valor);
  if (objetivo === null) return false;
  const candidatos = texto.match(/\d[\d.,]*/g) ?? [];
  return candidatos.some((c) => {
    const n = aCantidad(c);
    return n !== null && Math.abs(n - objetivo) < 0.005;
  });
}

export function adivinabilidad(casos: CasoVista[]): Adivinable {
  const r: Adivinable = {
    enLaConsulta: [],
    sabidaDeMemoria: [],
    enUnaPrescindible: [],
    baseRateBooleanos: {},
    tasaDeAbstencion: 0,
  };
  let abst = 0;
  const booleanos: Record<string, number> = {};
  let totalBool = 0;

  for (const c of casos) {
    if (c.abstencion) abst += 1;
    const nec = new Set(c.necesarias);
    for (const v of c.valores) {
      if (!v.critico) continue;
      if (v.valor === "true" || v.valor === "false") {
        booleanos[v.valor] = (booleanos[v.valor] ?? 0) + 1;
        totalBool += 1;
      }
      if (apareceEn(c.consulta, v.valor)) {
        r.enLaConsulta.push({ id: c.id, campo: v.campo, valor: v.valor });
      }
      const sabida = SABIDAS.find((s) => s.valores.includes(v.valor) && s.campo.test(v.campo));
      if (sabida) {
        r.sabidaDeMemoria.push({ id: c.id, campo: v.campo, valor: v.valor, que: sabida.que });
      }
      const fuga = c.unidades.find((u) => !nec.has(u.id) && apareceEn(u.texto, v.valor));
      if (fuga) {
        r.enUnaPrescindible.push({
          id: c.id,
          campo: v.campo,
          valor: v.valor,
          unidad: fuga.id,
          papel: fuga.papelOriginal,
        });
      }
    }
  }
  for (const [k, v] of Object.entries(booleanos)) r.baseRateBooleanos[k] = v / (totalBool || 1);
  r.tasaDeAbstencion = abst / casos.length;
  return r;
}

// ─── 5. Idioma ───────────────────────────────────────────────────────────────

export interface Idiomas {
  porIdioma: Record<string, number>;
  /** Casos catalanes con ela geminada en alguna unidad NECESARIA. */
  elaGeminadaEnNecesaria: string[];
  /** Casos catalanes con apóstrofo en alguna unidad NECESARIA. */
  apostrofEnNecesaria: string[];
  /** Casos catalanes con vocal acentuada en alguna unidad NECESARIA. */
  acentoEnNecesaria: string[];
  /**
   * LA PRUEBA DE VERDAD, y la que separa una trampa declarada de una cableada:
   * pares de PALABRAS distintas —una en una unidad necesaria, otra en una
   * prescindible del mismo caso— que `normalizeText()` convierte en el MISMO
   * token. «més»/«mes», «pròrroga»/«prorroga», «cel·la»/«cella», «abonó»/«abono».
   *
   * Un caso etiquetado `diacritico` o `ela-geminada` que no aparezca aquí lleva
   * la etiqueta pero no la trampa: la distinción que dice explotar sobrevive
   * intacta al código contra el que dice probar.
   */
  colisionesTrasNormalizar: Array<{ caso: string; a: string; b: string; token: string }>;
  /**
   * Casos etiquetados con una trampa que se juega en la COLISIÓN
   * (`diacritico`, `ela-geminada`, `numero-gramatical`) y en los que no hay
   * ninguna. Llevan la etiqueta y no la trampa: la distinción que dicen
   * explotar sobrevive intacta al código contra el que dicen probar.
   */
  etiquetadosSinColision: string[];
  /**
   * El apóstrofo no colisiona con nada, y por eso se mide aparte: `normalizeText`
   * lo BORRA —está en la clase `PUNTUACION` de canonicalize.ts—, así que
   * «l'import» entra en la clave como `limport` y deja de casar con el `import`
   * de la consulta. Medir esa clase por colisiones daría cero siempre y haría
   * creer que no está ejercitada. Esto cuenta lo que de verdad pasa: tokens de
   * la CONSULTA que existen en una unidad necesaria pero solo pegados a su
   * artículo, o sea invisibles para cualquier casación por tokens —incluida la
   * de `keyTokensMatch`, que es la que protege la caché semántica.
   */
  tokensRotosPorApostrofo: Array<{ caso: string; token: string; pegado: string }>;
}

/** Las que se juegan en una colisión de normalización. El apóstrofo NO. */
const TRAMPAS_DE_COLISION = new Set([
  "diacritico",
  "diacriticos",
  "ela-geminada",
  "numero-gramatical",
]);

/** Palabras crudas de un texto, sin normalizar. */
function palabras(texto: string): string[] {
  return texto.split(/[^\p{L}·'’·]+/u).filter((p) => p.length > 2);
}

export function idiomas(casos: CasoVista[]): Idiomas {
  const r: Idiomas = {
    porIdioma: {},
    elaGeminadaEnNecesaria: [],
    apostrofEnNecesaria: [],
    acentoEnNecesaria: [],
    colisionesTrasNormalizar: [],
    etiquetadosSinColision: [],
    tokensRotosPorApostrofo: [],
  };
  for (const c of casos) {
    r.porIdioma[c.idioma] = (r.porIdioma[c.idioma] ?? 0) + 1;
    const nec = c.unidades.filter((u) => c.necesarias.includes(u.id));
    const t = nec.map((u) => u.texto).join(" ");
    if (c.idioma === "ca") {
      if (/[lL]·[lL]/.test(t)) r.elaGeminadaEnNecesaria.push(c.id);
      if (/\p{L}['’]\p{L}/u.test(t)) r.apostrofEnNecesaria.push(c.id);
      if (/[àèéíòóúïüÀÈÉÍÒÓÚ]/.test(t)) r.acentoEnNecesaria.push(c.id);
    }

    // La colisión que cuesta dinero: una palabra de una unidad NECESARIA y otra
    // palabra, distinta, de una PRESCINDIBLE, que caen en el mismo token tras
    // `normalizeText`. Ahí el selector no tiene con qué distinguirlas.
    const prescindibles = c.unidades.filter((u) => !c.necesarias.includes(u.id));
    let hayColision = false;
    for (const a of nec) {
      const pa = new Map<string, string>();
      for (const p of palabras(a.texto)) pa.set(normalizeText(p), p);
      for (const b of prescindibles) {
        for (const p of palabras(b.texto)) {
          const k = normalizeText(p);
          const original = pa.get(k);
          if (original && original.toLowerCase() !== p.toLowerCase()) {
            r.colisionesTrasNormalizar.push({ caso: c.id, a: original, b: p, token: k });
            hayColision = true;
          }
        }
      }
    }
    if (c.trampas.some((x) => TRAMPAS_DE_COLISION.has(x)) && !hayColision) {
      r.etiquetadosSinColision.push(c.id);
    }

    // El apóstrofo: un token de la consulta que en la unidad necesaria solo
    // existe pegado a su artículo. Tras `normalizeText` el pegado es una
    // palabra distinta, así que la casación por tokens no lo ve.
    if (c.idioma === "ca") {
      const sueltas = new Set<string>();
      const pegadas = new Map<string, string>();
      for (const u of nec) {
        for (const p of palabras(u.texto)) {
          const n = normalizeText(p);
          if (/['’]/.test(p)) pegadas.set(n, p);
          else sueltas.add(n);
        }
      }
      for (const q of palabras(c.consulta)) {
        const n = normalizeText(q);
        if (sueltas.has(n)) continue;
        for (const [k, original] of pegadas) {
          if (k !== n && k.endsWith(n)) {
            r.tokensRotosPorApostrofo.push({ caso: c.id, token: q, pegado: original });
            break;
          }
        }
      }
    }
  }
  return r;
}

// ─── 6. Presupuesto ──────────────────────────────────────────────────────────

export interface Presupuestos {
  sinPresion: string[];
  imputados: number;
  /** Mediana de `unidades_max / total` entre los casos con presupuesto propio. */
  medianaFraccion: number;
  /** Casos donde el presupuesto deja sitio para TODAS las necesarias y una más. */
  holguraMedia: number;
}

export function presupuestos(casos: CasoVista[]): Presupuestos {
  const propios = casos.filter((c) => !c.presupuestoImputado);
  const fr = propios.map((c) => c.presupuestoMax / c.unidades.length).sort((a, b) => a - b);
  const mid = Math.floor(fr.length / 2);
  return {
    sinPresion: casos.filter((c) => c.presupuestoMax >= c.unidades.length).map((c) => c.id),
    imputados: casos.filter((c) => c.presupuestoImputado).length,
    medianaFraccion: fr.length === 0 ? 0 : (fr[mid] ?? 0),
    holguraMedia:
      casos.reduce((a, c) => a + (c.presupuestoMax - c.necesarias.length), 0) / (casos.length || 1),
  };
}

// ─── Informe ─────────────────────────────────────────────────────────────────

function tabla(inf: Informe): string {
  const trozos = Object.entries(inf.porOrigen)
    .map(([k, v]) => `${k} ${v.resueltos}/${v.total}`)
    .join("  ");
  return [
    inf.nombre.padEnd(18),
    `resueltos ${String(inf.resueltos).padStart(3)}/${inf.total}`,
    `(${pct(inf.tasa).padStart(7)})`,
    `ahorro ${pct(inf.ahorroMedio).padStart(7)}`,
    `fuera-de-presupuesto ${String(inf.fueraDePresupuesto).padStart(3)}`,
    trozos,
  ].join("  ");
}

export function informe(casos: CasoVista[]): string {
  const l: string[] = [];
  l.push(`CORPUS: ${casos.length} casos`);
  const porOrigen: Record<string, number> = {};
  for (const c of casos) porOrigen[c.origen] = (porOrigen[c.origen] ?? 0) + 1;
  l.push(`  por origen: ${JSON.stringify(porOrigen)}`);

  l.push("\n1. LÍNEAS BASE TONTAS");
  for (const inf of lineasBase(casos)) l.push("   " + tabla(inf));
  l.push(`   ${"azar-k".padEnd(18)}  resueltos (media de 400 tiradas)  ${pct(azarK(casos))}`);

  const n = nucleoDiscriminante(casos);
  l.push("\n1b. NÚCLEO DISCRIMINANTE (casos que NO resuelve ninguna línea base tonta)");
  l.push(`   regalados por alguna tonta: ${n.regalados}/${n.total}  (${pct(n.regalados / n.total)})`);
  l.push(`   núcleo: ${n.nucleo.length}/${n.total}  (${pct(n.nucleo.length / n.total)})`);
  l.push(`   por origen ${JSON.stringify(n.porOrigen)}  por idioma ${JSON.stringify(n.porIdioma)}  por dificultad ${JSON.stringify(n.porDificultad)}`);

  l.push("\n2. SESGO DE POSICIÓN");
  const s = sesgoDePosicion(casos);
  l.push(`   posición media de las necesarias    ${s.posicionMediaNecesarias.toFixed(3)}`);
  l.push(`   posición media de las prescindibles ${s.posicionMediaPrescindibles.toFixed(3)}`);
  l.push(`   casos con TODAS las necesarias en las k primeras: ${s.necesariasEnCabeza}/${s.total}`);
  l.push(`   casos con TODAS las necesarias en las k últimas:  ${s.necesariasEnCola}/${s.total}`);

  l.push("\n3. PLAUSIBILIDAD DE LAS DISTRACTORAS");
  const p = plausibilidad(casos);
  l.push(`   margen medio (necesaria − mejor distractora): ${p.margenMedio.toFixed(3)}`);
  l.push(`   casos regalados (margen > 0): ${p.casosRegalados}   duros: ${p.casosDuros}`);
  l.push(`   peores: ${p.peores.map((x) => `${x.id}:${x.margen.toFixed(2)}`).join(" ")}`);

  l.push("\n4. ADIVINABILIDAD SIN EVIDENCIA");
  const a = adivinabilidad(casos);
  l.push(`   valor crítico literal en la consulta: ${a.enLaConsulta.length}`);
  for (const x of a.enLaConsulta) l.push(`      ${x.id}  ${x.campo}=${x.valor}`);
  l.push(`   valor crítico sabido de memoria: ${a.sabidaDeMemoria.length}`);
  for (const x of a.sabidaDeMemoria) l.push(`      ${x.id}  ${x.campo}=${x.valor}  (${x.que})`);
  const fugaDistractora = a.enUnaPrescindible.filter((x) => x.papel === "distractora");
  l.push(`   valor crítico también en una prescindible: ${a.enUnaPrescindible.length}`);
  l.push(`      de ellas en una DISTRACTORA (defecto): ${fugaDistractora.length}`);
  for (const x of fugaDistractora) l.push(`      ${x.id}  ${x.campo}=${x.valor}  fuga en ${x.unidad}`);
  l.push(`   base rate booleanos: ${JSON.stringify(a.baseRateBooleanos)}`);
  l.push(`   tasa de abstención: ${pct(a.tasaDeAbstencion)}`);

  l.push("\n5. IDIOMA");
  const i = idiomas(casos);
  l.push(`   reparto: ${JSON.stringify(i.porIdioma)}`);
  l.push(`   ca con ela geminada en necesaria: ${i.elaGeminadaEnNecesaria.length}`);
  l.push(`   ca con apóstrofo en necesaria:    ${i.apostrofEnNecesaria.length}`);
  l.push(`   ca con acento en necesaria:       ${i.acentoEnNecesaria.length}`);
  l.push(`   colisiones necesaria↔prescindible tras normalizar: ${i.colisionesTrasNormalizar.length}`);
  const muestra = i.colisionesTrasNormalizar.slice(0, 14);
  for (const x of muestra) l.push(`      ${x.caso}  «${x.a}» ≡ «${x.b}» → ${x.token}`);
  l.push(`   casos con trampa de COLISIÓN declarada y sin colisión: ${i.etiquetadosSinColision.length}`);
  l.push(`      ${i.etiquetadosSinColision.join(" ")}`);
  l.push(`   tokens de la consulta rotos por el apóstrofo: ${i.tokensRotosPorApostrofo.length}`);
  for (const x of i.tokensRotosPorApostrofo.slice(0, 10)) {
    l.push(`      ${x.caso}  «${x.token}» solo existe dentro de «${x.pegado}»`);
  }

  l.push("\n6. PRESUPUESTO");
  const b = presupuestos(casos);
  l.push(`   casos sin presión: ${b.sinPresion.length}  ${b.sinPresion.slice(0, 10).join(" ")}`);
  l.push(`   casos con presupuesto imputado: ${b.imputados}`);
  l.push(`   mediana de unidades_max/total (casos con presupuesto propio): ${b.medianaFraccion.toFixed(3)}`);
  l.push(`   holgura media (unidades_max − necesarias): ${b.holguraMedia.toFixed(2)}`);

  return l.join("\n");
}

/**
 * La clase incómoda se informa APARTE y con otra pregunta. Aquí no interesa la
 * tasa —la tasa va a ser mala, y ese es el punto— sino que cada caso caiga en el
 * núcleo: si una línea base tonta resolviera un caso incómodo, ese caso no
 * estaría enseñando ningún agujero, estaría enseñando una casualidad.
 */
export function informeIncomodo(casos: CasoIncomodo[]): string {
  const l: string[] = [];
  l.push(`\nCLASE INCÓMODA (aparte, nunca agregada): ${casos.length} casos`);
  const porClase: Record<string, number> = {};
  for (const c of casos) porClase[c.clase] = (porClase[c.clase] ?? 0) + 1;
  l.push(`   clases: ${JSON.stringify(porClase)}`);
  l.push(`   irresolubles por construcción (necesarias > presupuesto): ${casos.filter((c) => c.irresoluble).length}`);
  const n = nucleoDiscriminante(casos.filter((c) => !c.irresoluble));
  l.push(`   de los resolubles, en el núcleo discriminante: ${n.nucleo.length}/${n.total}`);
  if (n.regalados > 0) {
    const regalados = casos.filter((c) => !c.irresoluble && !n.nucleo.includes(c.id));
    l.push(`   ⚠️ regalados por una línea base tonta: ${regalados.map((c) => c.id).join(" ")}`);
  }
  for (const inf of lineasBase(casos.filter((c) => !c.irresoluble))) l.push("   " + tabla(inf));
  return l.join("\n");
}

const esteFichero = import.meta.url.endsWith("auditar.ts");
if (esteFichero && process.argv[1]?.endsWith("auditar.ts")) {
  console.log(informe(cargarCorpusEntero()));
  console.log(informeIncomodo(cargarClaseIncomoda()));
}
