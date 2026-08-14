/**
 * EL VALIDADOR DEL CORPUS. Función pura, sin disco y sin red: se puede correr
 * desde un test, desde un script o desde el propio evaluador.
 *
 * POR QUÉ EXISTE. Un golden set escrito a mano tiene un modo de fallo peor que
 * el de un algoritmo: se equivoca en silencio y luego arbitra. Una cita que
 * apunta a una unidad que no existe, un caso donde caben todas las unidades (y
 * por tanto no hay nada que elegir), una contradicción sin regla de desempate
 * cuya respuesta no es abstenerse — nada de eso rompe nada al cargarlo, y todo
 * eso convierte el corpus en un juez que aprueba lo que no debería.
 *
 * Las comprobaciones que importan de verdad son cuatro, y ninguna es de tipos:
 *
 *   · TIENE QUE HABER PRESIÓN: `necesarias <= unidades_max < total`. Si caben
 *     todas, el caso no mide un knapsack, mide un `map`.
 *   · UNA DISTRACTORA NO SE CITA NUNCA. Si una unidad marcada prescindible
 *     sostiene un campo crítico, o la marca está mal o el campo está mal.
 *   · UNA NECESARIA SE CITA SIEMPRE. «Necesaria» que nadie cita no es
 *     necesaria: es relleno que infla la presión del caso y falsea el resultado.
 *   · UNA CONTRADICCIÓN SIN REGLA OBLIGA A ABSTENERSE. Es la única salida
 *     honesta, y el caso tiene que declararla.
 */

import {
  VERSION_DE_LA_FORMA,
  camposCriticos,
  citasObligatorias,
  type CampoRespuesta,
  type CasoDelCorpus,
  type Dificultad,
  type FicheroDeCasos,
  type Idioma,
  type Papel,
  type Trampa,
  type ValorCampo,
} from "./tipos.js";

const IDIOMAS: readonly Idioma[] = ["es", "ca"];
const DIFICULTADES: readonly Dificultad[] = ["facil", "media", "dificil"];
const PAPELES: readonly Papel[] = ["necesaria", "distractora", "contradictoria"];
const TRAMPAS: readonly Trampa[] = [
  "negacion",
  "excepcion",
  "condicion",
  "importes-parecidos",
  "fechas-parecidas",
  "con-iva-sin-iva",
  "referencia-cruzada",
  "verbo-modal",
  "identificadores-parecidos",
  "derogacion",
  "unidades",
  "abstencion",
  "diacritico",
  "ela-geminada",
  "apostrof",
  "numero-gramatical",
];
const REGLAS = [
  "fecha-posterior",
  "version-posterior",
  "rectificativa",
  "clausula-especial",
  "jerarquia-documental",
  "ninguna",
] as const;
const MOTIVOS = [
  "evidencia-insuficiente",
  "contradiccion-sin-regla-de-desempate",
  "identificador-ambiguo",
  "formato-de-fecha-ambiguo",
  "evidencia-caducada",
  "fuera-del-alcance-de-la-evidencia",
] as const;
const BASES = ["sin-iva", "con-iva", "solo-cuota", "neto-a-percibir", "no-aplica"] as const;

const ID_CASO = /^[a-z]{3}-(es|ca)-\d{3}$/;
const ID_UNIDAD = /^u\d+$/;
const NOMBRE_CAMPO = /^[a-z][a-z0-9_]*$/;
const DECIMAL = /^-?\d+\.\d{2}$/;
const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function esFechaReal(iso: string): boolean {
  if (!FECHA_ISO.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

function esTextoConAlgo(v: unknown, min = 1): v is string {
  return typeof v === "string" && v.trim().length >= min;
}

function valorInvalido(valor: ValorCampo, ids: Set<string>): string | null {
  switch (valor.clase) {
    case "importe":
      if (!DECIMAL.test(valor.cantidad)) {
        return `importe "${valor.cantidad}" no es decimal con dos cifras (usa "1234.50", nunca 1.234,50 ni un number)`;
      }
      if (valor.moneda !== "EUR") return `moneda "${valor.moneda}" no soportada`;
      if (!BASES.includes(valor.base)) return `base "${valor.base}" desconocida`;
      return null;
    case "fecha":
      return esFechaReal(valor.iso) ? null : `fecha "${valor.iso}" no es una fecha ISO real`;
    case "identificador":
      return esTextoConAlgo(valor.valor) ? null : "identificador vacío";
    case "booleano":
      return typeof valor.valor === "boolean" ? null : "booleano que no es booleano";
    case "porcentaje":
      return DECIMAL.test(valor.valor) ? null : `porcentaje "${valor.valor}" sin dos decimales`;
    case "entero":
      return Number.isInteger(valor.valor) ? null : "entero que no es entero";
    case "opcion":
      if (!Array.isArray(valor.opciones) || valor.opciones.length < 2) {
        return "opción con menos de dos alternativas: no es una elección";
      }
      return valor.opciones.includes(valor.valor)
        ? null
        : `opción "${valor.valor}" fuera del conjunto declarado`;
    case "referencia":
      return ids.has(valor.unidad) ? null : `referencia a la unidad inexistente "${valor.unidad}"`;
    default: {
      const nunca: never = valor;
      return `clase de valor desconocida: ${JSON.stringify(nunca)}`;
    }
  }
}

/**
 * Comprueba UN caso. Devuelve la lista de problemas; vacía significa válido.
 * No lanza: un corpus se revisa entero de una vez, no error a error.
 */
export function validarCaso(caso: CasoDelCorpus): string[] {
  const e: string[] = [];
  const donde = (m: string) => e.push(`${caso.id ?? "«sin id»"}: ${m}`);

  if (!ID_CASO.test(caso.id ?? "")) donde(`id "${caso.id}" no casa con dominio-idioma-nnn`);
  if (!IDIOMAS.includes(caso.idioma)) donde(`idioma "${caso.idioma}" desconocido`);
  if (caso.id && caso.idioma && !caso.id.includes(`-${caso.idioma}-`)) {
    donde("el id y el campo idioma no dicen lo mismo");
  }
  if (!DIFICULTADES.includes(caso.dificultad)) donde(`dificultad "${caso.dificultad}" desconocida`);
  if (!esTextoConAlgo(caso.dominio)) donde("dominio vacío");
  if (!esTextoConAlgo(caso.consulta, 10)) donde("consulta vacía o demasiado corta para ser una consulta");

  if (!Array.isArray(caso.trampas)) donde("trampas no es una lista");
  else {
    for (const t of caso.trampas) if (!TRAMPAS.includes(t)) donde(`trampa "${t}" desconocida`);
    if (caso.dificultad !== "facil" && caso.trampas.length === 0) {
      donde("sin trampa declarada: un caso que no es fácil tiene que decir qué caza");
    }
    if (new Set(caso.trampas).size !== caso.trampas.length) donde("trampas repetidas");
  }

  // La etiqueta y el tipo de respuesta tienen que decir lo mismo, en las dos
  // direcciones: una abstención sin etiqueta desaparece del informe por trampa,
  // y una etiqueta sin abstención infla el recuento de la trampa más difícil.
  if (Array.isArray(caso.trampas) && caso.respuesta) {
    const etiquetada = caso.trampas.includes("abstencion");
    const abstiene = caso.respuesta.tipo === "abstencion";
    if (etiquetada && !abstiene) donde("trampa `abstencion` en un caso que sí responde");
    if (abstiene && !etiquetada) donde("caso de abstención sin la trampa `abstencion` declarada");
  }

  if (caso.dificultad === "dificil" && !esTextoConAlgo(caso.nota, 30)) {
    donde("caso difícil sin `nota`: los JSON no llevan comentarios y sin ella nadie sabe por qué es difícil");
  }

  // ── Evidencia ──────────────────────────────────────────────────────────────
  const ids = new Set<string>();
  if (!Array.isArray(caso.evidencia) || caso.evidencia.length < 3) {
    donde("menos de tres unidades de evidencia: no hay nada que seleccionar");
  } else {
    for (const u of caso.evidencia) {
      if (!ID_UNIDAD.test(u.id ?? "")) donde(`unidad con id inválido "${u.id}"`);
      if (ids.has(u.id)) donde(`unidad repetida "${u.id}"`);
      ids.add(u.id);
      if (!PAPELES.includes(u.papel)) donde(`unidad ${u.id}: papel "${u.papel}" desconocido`);
      if (!esTextoConAlgo(u.texto, 20)) donde(`unidad ${u.id}: texto vacío o de adorno`);
      if (!esTextoConAlgo(u.fuente)) donde(`unidad ${u.id}: sin fuente`);
      if (u.fecha !== undefined && !esFechaReal(u.fecha)) {
        donde(`unidad ${u.id}: fecha "${u.fecha}" no es ISO real`);
      }
    }
    if (!caso.evidencia.some((u) => u.papel === "distractora")) {
      donde("ninguna distractora: sin nada prescindible, el caso no prueba que se tire lo correcto");
    }
  }

  // ── Respuesta ──────────────────────────────────────────────────────────────
  const r = caso.respuesta;
  if (!r || (r.tipo !== "valor" && r.tipo !== "abstencion")) {
    donde("respuesta sin tipo `valor` ni `abstencion`");
    return e;
  }

  const citar = (campo: string, citas: string[]) => {
    if (!Array.isArray(citas) || citas.length === 0) donde(`${campo}: sin citas`);
    else {
      for (const c of citas) if (!ids.has(c)) donde(`${campo}: cita "${c}" no existe en la evidencia`);
      if (new Set(citas).size !== citas.length) donde(`${campo}: citas repetidas`);
    }
  };

  if (r.tipo === "valor") {
    if (!Array.isArray(r.campos) || r.campos.length === 0) donde("respuesta sin campos");
    else {
      const nombres = new Set<string>();
      for (const campo of r.campos as CampoRespuesta[]) {
        if (!NOMBRE_CAMPO.test(campo.nombre ?? "")) donde(`campo "${campo.nombre}" no es snake_case`);
        if (nombres.has(campo.nombre)) donde(`campo "${campo.nombre}" repetido`);
        nombres.add(campo.nombre);
        if (typeof campo.critico !== "boolean") donde(`campo ${campo.nombre}: \`critico\` no es booleano`);
        const problema = campo.valor ? valorInvalido(campo.valor, ids) : "sin valor";
        if (problema) donde(`campo ${campo.nombre}: ${problema}`);
        citar(`campo ${campo.nombre}`, campo.citas);
      }
      if (camposCriticos(caso).length === 0) {
        donde("ningún campo crítico: entonces no hay nada que el knapsack pueda romper");
      }
    }
  } else {
    if (!MOTIVOS.includes(r.motivo)) donde(`motivo de abstención "${r.motivo}" desconocido`);
    if (!esTextoConAlgo(r.que_falta, 15)) donde("abstención sin decir qué falta exactamente");
    citar("abstención", r.citas);
  }

  // ── Papeles contra citas ───────────────────────────────────────────────────
  const obligatorias = new Set(citasObligatorias(caso));
  for (const u of caso.evidencia ?? []) {
    if (u.papel === "necesaria" && !obligatorias.has(u.id)) {
      donde(`unidad ${u.id} se declara necesaria pero no la cita ningún campo crítico`);
    }
    if (u.papel === "distractora" && obligatorias.has(u.id)) {
      donde(`unidad ${u.id} se declara distractora y sostiene un campo crítico`);
    }
  }

  // ── Contradicciones ────────────────────────────────────────────────────────
  const contradictorias = (caso.evidencia ?? []).filter((u) => u.papel === "contradictoria");
  const d = caso.desempate;
  if (contradictorias.length > 0) {
    if (contradictorias.length < 2) {
      donde("una sola unidad contradictoria: una contradicción necesita dos partes");
    }
    if (!d) donde("hay unidades contradictorias y el caso no declara `desempate`");
  }
  if (d) {
    if (!REGLAS.includes(d.regla)) donde(`regla de desempate "${d.regla}" desconocida`);
    if (!esTextoConAlgo(d.porque, 20)) donde("desempate sin explicar por qué manda la que manda");
    if (contradictorias.length === 0) donde("`desempate` sin unidades contradictorias que desempatar");
    if (d.regla === "ninguna") {
      if (d.ganadora !== null) donde("regla `ninguna` con unidad ganadora: o hay regla o no la hay");
      if (r.tipo !== "abstencion") {
        donde("contradicción sin regla de desempate y la respuesta no es abstenerse");
      }
    } else {
      if (!d.ganadora || !ids.has(d.ganadora)) donde(`desempate: ganadora "${d.ganadora}" no existe`);
      else if (!obligatorias.has(d.ganadora)) {
        donde(`desempate: la ganadora ${d.ganadora} no la cita ningún campo crítico`);
      }
      if (!Array.isArray(d.desplazadas) || d.desplazadas.length === 0) {
        donde("desempate sin unidades desplazadas");
      } else {
        for (const x of d.desplazadas) {
          if (!ids.has(x)) donde(`desempate: desplazada "${x}" no existe`);
          if (x === d.ganadora) donde("desempate: la ganadora se desplaza a sí misma");
        }
      }
    }
  }

  // ── Presión ────────────────────────────────────────────────────────────────
  const total = Array.isArray(caso.evidencia) ? caso.evidencia.length : 0;
  const max = caso.presupuesto?.unidades_max;
  if (!Number.isInteger(max) || (max as number) < 1) {
    donde("presupuesto sin `unidades_max` entero y positivo");
  } else {
    const m = max as number;
    if (m >= total) {
      donde(`presupuesto de ${m} sobre ${total} unidades: caben todas, el caso no mide una selección`);
    }
    if (obligatorias.size > m) {
      donde(`presupuesto de ${m} y ${obligatorias.size} unidades obligatorias: el caso es irresoluble`);
    }
  }

  return e;
}

/** Comprueba el fichero entero: cabecera, unicidad de ids y cada caso. */
export function validarFichero(fichero: FicheroDeCasos): string[] {
  const e: string[] = [];

  if (fichero.version_de_la_forma !== VERSION_DE_LA_FORMA) {
    e.push(
      `versión de la forma "${fichero.version_de_la_forma}" ≠ "${VERSION_DE_LA_FORMA}": los casos se escribieron contra otra forma`,
    );
  }
  if (fichero.sintetico !== true) {
    e.push("`sintetico` tiene que ser true: no hay ningún caso que venga de tráfico real");
  }
  if (!/sintétic/i.test(fichero.advertencia ?? "") || !/no demuestra/i.test(fichero.advertencia ?? "")) {
    e.push(
      "la `advertencia` del fichero tiene que decir que el conjunto es SINTÉTICO y qué NO demuestra, con esas palabras",
    );
  }
  if (!IDIOMAS.includes(fichero.idioma)) e.push(`idioma de fichero "${fichero.idioma}" desconocido`);
  if (!esTextoConAlgo(fichero.dominio)) e.push("fichero sin dominio");
  if (!Array.isArray(fichero.casos) || fichero.casos.length === 0) {
    e.push("fichero sin casos");
    return e;
  }

  const vistos = new Set<string>();
  for (const caso of fichero.casos) {
    if (vistos.has(caso.id)) e.push(`id de caso repetido: ${caso.id}`);
    vistos.add(caso.id);
    if (caso.idioma !== fichero.idioma) e.push(`${caso.id}: idioma distinto del fichero`);
    if (caso.dominio !== fichero.dominio) e.push(`${caso.id}: dominio distinto del fichero`);
    e.push(...validarCaso(caso));
  }
  return e;
}

export interface ResumenDelCorpus {
  total: number;
  porIdioma: Record<string, number>;
  porDificultad: Record<string, number>;
  porTrampa: Record<string, number>;
  abstenciones: number;
  conContradiccion: number;
  /** Unidades que hay que tirar, sumadas: la presión total que ejerce el corpus. */
  unidadesDescartables: number;
}

/** El reparto real del corpus. Es lo que hay que enseñar antes de creerse una cifra. */
export function resumen(casos: CasoDelCorpus[]): ResumenDelCorpus {
  const r: ResumenDelCorpus = {
    total: casos.length,
    porIdioma: {},
    porDificultad: {},
    porTrampa: {},
    abstenciones: 0,
    conContradiccion: 0,
    unidadesDescartables: 0,
  };
  for (const c of casos) {
    r.porIdioma[c.idioma] = (r.porIdioma[c.idioma] ?? 0) + 1;
    r.porDificultad[c.dificultad] = (r.porDificultad[c.dificultad] ?? 0) + 1;
    for (const t of c.trampas) r.porTrampa[t] = (r.porTrampa[t] ?? 0) + 1;
    if (c.respuesta.tipo === "abstencion") r.abstenciones += 1;
    if (c.evidencia.some((u) => u.papel === "contradictoria")) r.conContradiccion += 1;
    r.unidadesDescartables += c.evidencia.length - c.presupuesto.unidades_max;
  }
  return r;
}
