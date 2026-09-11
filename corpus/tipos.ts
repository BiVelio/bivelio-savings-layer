/**
 * LA FORMA DE UN CASO DEL GOLDEN SET.  Fase F6 — knapsack de evidencia.
 *
 * Este fichero es el CONTRATO entre los tres corpus de dominio. Lo fija el
 * corpus de facturación y cobros y lo importan los demás sin modificarlo: un
 * caso de seguros y uno de facturación tienen que poder puntuarse con el MISMO
 * evaluador, o el informe por idioma y tipo documental que pide la aceptación de
 * F6 no se puede construir.
 *
 * QUÉ PRUEBA UN CASO. El knapsack elige QUÉ trozos de contexto recuperado se
 * mandan al modelo bajo un presupuesto. Un caso es una situación donde NO caben
 * todos, y donde se sabe de antemano cuáles no se pueden tirar. La pregunta que
 * responde el corpus es siempre la misma: *¿el selector tiró una unidad que
 * parecía prescindible y no lo era?*
 *
 * TRES REGLAS QUE LA FORMA IMPONE, y que son las que la hacen comprobable:
 *
 *   1. UN CASO ESTÁ CERRADO SOBRE SU EVIDENCIA. La respuesta correcta se deriva
 *      SOLO de las unidades del propio caso. Ningún caso exige saber el tipo de
 *      IVA vigente, ni el tipo del BCE, ni un plazo legal: si hace falta, está
 *      escrito dentro de una unidad. Un caso que necesita conocimiento de fuera
 *      no mide el selector, mide al modelo.
 *
 *   2. LA RESPUESTA ES ESTRUCTURADA, NUNCA PROSA. Importes, fechas,
 *      identificadores, booleanos y referencias. Nada que haya que juzgar a ojo,
 *      porque un juez a ojo convierte la aceptación de F6 en una opinión.
 *
 *   3. CADA CITA CUELGA DEL CAMPO QUE SOSTIENE, no de una lista suelta al final
 *      del caso. Es a propósito: el criterio de aceptación de F6 es «100 % de
 *      conservación de campos críticos y citas válidas y accesibles», y eso se
 *      comprueba campo a campo. Una lista global de citas, además, es una lista
 *      que se desincroniza en cuanto alguien edita un campo. Los agregados que
 *      alguien quiera se derivan: `camposCriticos()` y `citasObligatorias()`.
 *
 * EL DINERO NO ES UN `number`. Los importes van como cadena decimal
 * (`"12480.55"`), con punto y dos decimales SIEMPRE, porque 0,1 + 0,2 en coma
 * flotante no es 0,3 y un corpus de facturación que se equivoque en el céntimo
 * no sirve para arbitrar nada. El texto de la evidencia, en cambio, escribe el
 * importe como lo escribiría el documento real («12.480,55 €»): esa distancia
 * entre lo que se lee y lo que se compara es deliberada — impide que el
 * comprobador acierte por coincidencia de cadenas.
 */

/** Versión de ESTA forma. Sube si un cambio rompe a quien ya escribió casos. */
export const VERSION_DE_LA_FORMA = "1.0.0";

export type Idioma = "es" | "ca";

export type Dificultad = "facil" | "media" | "dificil";

/**
 * Abierto a propósito: cada corpus de dominio declara el suyo sin tocar este
 * fichero (y sin provocar un conflicto de fusión entre tres ramas paralelas).
 */
export type Dominio = "facturacion-y-cobros" | (string & {});

/**
 * La clase de trampa que un caso ejercita. No es decoración: es lo que permite
 * decir «el selector falla el 40 % de las derogaciones» en vez de «el selector
 * falla a veces», y es lo único que convierte un fallo en un arreglo.
 *
 * Las once primeras son transversales a los tres dominios. Las cuatro últimas
 * son de IDIOMA, y existen por un incidente real de este repositorio: el
 * 2026-08-14 se descubrió que plegar diacríticos dejaba muda una herramienta
 * cuyo `intent` iba acentuado. `normalizeText()` en
 * `src/canonicalization/canonicalize.ts` pliega toda marca sobre base latina y
 * borra el punto volado entre letras; `keyTokensMatch()` en
 * `src/cache/semantic.ts` protege cifras y negaciones, pero NO protege un
 * acento que cambie el verbo. Un caso marcado `diacritico` es un caso donde eso
 * cuesta dinero de verdad.
 */
export type Trampa =
  /** «no cubre» contra «cubre». */
  | "negacion"
  /** Regla general en una unidad y su excepción en otra, lejos. */
  | "excepcion"
  /** «siempre que se comunique en 7 días». */
  | "condicion"
  /** 12.480,55 contra 12.408,55. */
  | "importes-parecidos"
  /** Emisión contra vencimiento; 30/06 contra 06/30. */
  | "fechas-parecidas"
  /** El número correcto sobre la base equivocada: con IVA, sin IVA, solo cuota. */
  | "con-iva-sin-iva"
  /** «según lo previsto en la cláusula 4.2», y la 4.2 está en otra unidad. */
  | "referencia-cruzada"
  /** «deberá» contra «podrá». */
  | "verbo-modal"
  /** F-2024-118 contra F-2024-1118. */
  | "identificadores-parecidos"
  /** Una cláusula posterior anula a una anterior. */
  | "derogacion"
  /** EUR contra euros por unidad; importe de línea contra precio unitario. */
  | "unidades"
  /**
   * La respuesta correcta es ABSTENERSE. Va etiquetada además de estar en
   * `respuesta.tipo` porque el informe se lee por trampa, y esta es la que más
   * cuesta: contestar algo razonable es siempre más fácil que no contestar. El
   * validador exige que la etiqueta y el tipo de respuesta digan lo mismo.
   */
  | "abstencion"
  /** Acento que cambia el hecho: «abono»/«abonó», «prorroga»/«pròrroga». */
  | "diacritico"
  /** La ela geminada del catalán, que la normalización borra entre letras. */
  | "ela-geminada"
  /** L'apòstrof: «l'import», «s'ha», «d'aquest». */
  | "apostrof"
  /** Singular contra plural cuando cambia el hecho: «despesa»/«despeses». */
  | "numero-gramatical";

/**
 * Qué papel juega una unidad recuperada.
 *
 * `necesaria`   — sin ella la respuesta correcta es imposible.
 * `distractora` — plausible, del mismo tema, y NO hace falta. Es lo que el
 *                 selector debería tirar primero.
 * `contradictoria` — dice lo contrario que otra. El caso declara en `desempate`
 *                 cuál manda y por qué; si no hay regla, la respuesta correcta
 *                 es abstenerse.
 */
export type Papel = "necesaria" | "distractora" | "contradictoria";

/** Un trozo de contexto recuperado, tal y como llegaría del recuperador. */
export interface UnidadDeEvidencia {
  /** Único dentro del caso. Convención: `u1`, `u2`, … */
  id: string;
  papel: Papel;
  /**
   * El texto, sin marcas ni pistas. Escrito como lo escribiría el documento:
   * separador de miles con punto, decimal con coma, fechas dd/mm/aaaa.
   */
  texto: string;
  /** De dónde sale: documento, cláusula, línea de factura. */
  fuente: string;
  /** Fecha del documento en ISO. Es lo que decide un desempate «lo posterior manda». */
  fecha?: string;
  /** Versión del documento, cuando el desempate es por versión y no por fecha. */
  version?: string;
  /** Por qué esta unidad está aquí, si no es evidente. */
  nota?: string;
}

/**
 * La regla que decide entre dos unidades que se contradicen. Sin una de estas,
 * dos unidades en conflicto obligan a ABSTENERSE — y eso también es una
 * respuesta correcta que hay que saber dar.
 */
export type ReglaDeDesempate =
  /** Lo posterior en el tiempo manda. */
  | "fecha-posterior"
  /** La versión más reciente del mismo documento manda. */
  | "version-posterior"
  /** Una rectificativa manda sobre la factura que rectifica. */
  | "rectificativa"
  /** La excepción concreta gana a la regla general. */
  | "clausula-especial"
  /** Contrato marco > pedido > condiciones generales; norma imperativa > pacto. */
  | "jerarquia-documental"
  /** No hay regla. La respuesta correcta es abstenerse. */
  | "ninguna";

export interface Desempate {
  regla: ReglaDeDesempate;
  /** La unidad que MANDA. `null` cuando `regla` es `"ninguna"`. */
  ganadora: string | null;
  /** Las que quedan desplazadas por la ganadora. */
  desplazadas: string[];
  /** Por qué, en una frase comprobable contra el texto de las unidades. */
  porque: string;
}

/**
 * Sobre qué base está expresado un importe. Es un campo obligatorio y no un
 * detalle: en facturación, el número correcto sobre la base equivocada es una
 * respuesta EQUIVOCADA, y es el error que más dinero mueve del dominio.
 */
export type BaseDelImporte =
  /** Base imponible. */
  | "sin-iva"
  /** Base + cuotas repercutidas. */
  | "con-iva"
  /** Solo la cuota del impuesto (IVA, recargo de equivalencia…). */
  | "solo-cuota"
  /** Lo que el emisor cobra de verdad: total menos retención. */
  | "neto-a-percibir"
  /** El importe no está sujeto a impuesto (comisiones bancarias, indemnizaciones). */
  | "no-aplica";

/**
 * El valor de un campo de la respuesta. Cada clase se compara de una manera y
 * ninguna se compara «leyendo».
 */
export type ValorCampo =
  /** `cantidad`: decimal con punto y DOS decimales exactos. `"-1815.00"` vale. */
  | { clase: "importe"; cantidad: string; moneda: "EUR"; base: BaseDelImporte }
  /** ISO `aaaa-mm-dd`. El texto de la evidencia la escribe como quiera. */
  | { clase: "fecha"; iso: string }
  /** Un identificador literal: número de factura, IBAN parcial, referencia. */
  | { clase: "identificador"; valor: string }
  | { clase: "booleano"; valor: boolean }
  /** Porcentaje con dos decimales: `"21.00"`, `"5.20"`. */
  | { clase: "porcentaje"; valor: string }
  /** Recuentos: días, meses de retraso, número de recibos. */
  | { clase: "entero"; valor: number }
  /** Una opción de un conjunto CERRADO y declarado. */
  | { clase: "opcion"; valor: string; opciones: string[] }
  /** «La cláusula que aplica»: apunta a una unidad de evidencia del caso. */
  | { clase: "referencia"; unidad: string };

/**
 * LA OPERACIÓN DECLARADA. Qué cuenta hizo quien respondió para llegar a un valor
 * que NO está escrito en ninguna unidad.
 *
 * POR QUÉ EXISTE, Y POR QUÉ ES UN CAMPO DEL CONTRATO Y NO UNA HEURÍSTICA DE LA
 * VERJA. La verja de extracción (`verja-de-extraccion.ts`) tenía que decidir si
 * «968,00» está sostenido por una evidencia que solo escribe «800,00» y
 * «168,00». Mientras la respuesta no declaraba nada, la única salida era que la
 * verja BUSCARA la cuenta, y eso está medido y es mal negocio: con dos términos
 * recupera derivaciones legítimas pero deja escapar un importe inventado; con
 * tres, el falso rechazo baja 6,6 puntos y los escapes del modo estrella se
 * TRIPLICAN. Cada término nuevo amplía el espacio de forma combinatoria, y la
 * probabilidad de que un número inventado resulte derivable por casualidad crece
 * más rápido que la recuperación de derivaciones buenas.
 *
 * Declarar le da la vuelta al problema: quien responde ya sabe qué cuenta hizo,
 * así que decirlo no le cuesta nada; y la verja pasa de buscar entre cientos de
 * fórmulas a comprobar UNA. La asimetría es lo que lo hace valer: una cuenta
 * declarada que no cuadra es un rechazo inmediato.
 *
 * Es el campo `operation` del contrato de resultado del plan del CTO.
 */
export type OperacionDeclarada =
  /** Σ de todos los operandos. Un operando escrito en negativo («-450,00») resta. */
  | "suma"
  /** `operandos[0]` menos la suma de los demás. */
  | "resta"
  /** Π de todos los operandos: unidades × precio unitario. */
  | "producto"
  /** `operandos[0] × operandos[1] / 100`: la cuota de un tipo sobre una base. */
  | "porcentaje"
  /**
   * `operandos[0] × (1 + Σ resto/100)`: la base con sus tipos encadenados —IVA y
   * recargo de equivalencia sobre la misma base, que es el caso real que lo trae.
   */
  | "base-mas-porcentajes"
  /**
   * `principal × tipo/100 × dias / base_dias`, en ese orden y con los cuatro
   * operandos. Es la única operación específica del dominio, y está aquí porque
   * el interés de demora es un campo de verdad de dos casos del corpus; sin ella
   * habría que admitir un producto de cuatro términos, que es mucha más puerta.
   */
  | "interes-por-dias"
  /** `operandos[0]` (fecha) más la suma de los días que siguen. */
  | "fecha-mas-dias"
  /** Igual, pero los operandos que siguen son semanas: «8 semanas» de un SEPA CORE. */
  | "fecha-mas-semanas"
  /** Días naturales entre `operandos[0]` y `operandos[1]`, las dos fechas. */
  | "dias-entre-fechas";

/**
 * De dónde sale UN operando. Las dos formas son excluyentes, y las dos son
 * comprobables sin saber cuál era la respuesta correcta:
 *
 *   · `{ unidad, literal }` — el operando está COPIADO de una unidad citada. La
 *     verja exige que `literal` aparezca en el texto de esa unidad tal y como se
 *     escribe ahí («2.000,00», «30/06/2024», «21»). Copiar es comprobable;
 *     «sale de la u3» no lo es.
 *   · `{ campo }` — el operando es OTRO CAMPO de la misma respuesta, que a su
 *     vez tiene que estar sostenido. Es lo que permite encadenar sin ensanchar:
 *     los intereses de demora se calculan sobre unos días de mora que son, a su
 *     vez, una resta de fechas. La verja resuelve las dependencias por pasadas y
 *     un ciclo queda sin resolver, o sea RECHAZADO.
 */
export type OperandoDeclarado =
  | { unidad: string; literal: string; campo?: never }
  | { campo: string; unidad?: never; literal?: never };

export interface DerivacionDeclarada {
  operacion: OperacionDeclarada;
  /**
   * En ORDEN: para `resta`, `porcentaje`, `base-mas-porcentajes`,
   * `interes-por-dias`, `fecha-mas-*` y `dias-entre-fechas` el orden es parte de
   * la cuenta. Para `suma` y `producto` da igual.
   */
  operandos: OperandoDeclarado[];
}

export interface CampoRespuesta {
  /** Nombre estable en `snake_case`: `importe_total`, `fecha_vencimiento`. */
  nombre: string;
  valor: ValorCampo;
  /**
   * CRÍTICO: si falta o cambia, la respuesta es incorrecta. Es el campo que la
   * aceptación de F6 exige conservar al 100 %.
   */
  critico: boolean;
  /**
   * Las unidades que SOSTIENEN este campo. Si el selector las tira, el campo no
   * se puede afirmar — aunque el modelo acierte por casualidad.
   */
  citas: string[];
  /**
   * LA CUENTA, cuando el valor no está escrito en ninguna unidad. Opcional y
   * aditiva: un caso que no la trae se comporta exactamente como antes. Los
   * casos del golden set NO la llevan —son la respuesta correcta escrita a
   * mano—; la declara quien RESPONDE, y la verja la comprueba.
   */
  derivacion?: DerivacionDeclarada;
}

export type MotivoDeAbstencion =
  /** Falta un dato que ninguna unidad aporta. */
  | "evidencia-insuficiente"
  /** Dos unidades chocan y no hay regla que decida. */
  | "contradiccion-sin-regla-de-desempate"
  /** La consulta puede referirse a dos documentos distintos. */
  | "identificador-ambiguo"
  /** «04/07/2025» sin saber si es dd/mm o mm/dd. */
  | "formato-de-fecha-ambiguo"
  /** La única unidad que lo diría dejó de estar vigente antes del hecho. */
  | "evidencia-caducada"
  /** La pregunta cae fuera de lo que la evidencia cubre. */
  | "fuera-del-alcance-de-la-evidencia";

export interface RespuestaConValor {
  tipo: "valor";
  campos: CampoRespuesta[];
}

export interface RespuestaAbstencion {
  tipo: "abstencion";
  motivo: MotivoDeAbstencion;
  /**
   * Qué faltaría EXACTAMENTE para poder responder. Es lo que separa una
   * abstención correcta de un «no lo sé» que también sirve para no saber nada.
   */
  que_falta: string;
  /**
   * Las unidades que hay que citar AL ABSTENERSE: las que enseñan el hueco o el
   * choque. Abstenerse sin poder enseñar por qué no es abstenerse, es callarse.
   */
  citas: string[];
}

export type Respuesta = RespuestaConValor | RespuestaAbstencion;

/**
 * El presupuesto del caso, en unidades de evidencia.
 *
 * Se cuenta en unidades y no en tokens a propósito: el corpus tiene que seguir
 * valiendo cuando cambie el tokenizador, el modelo o la forma de contar. Lo que
 * el caso afirma es que CABEN `unidades_max` y hay más, así que hay que elegir.
 *
 * El validador exige `necesarias <= unidades_max < total`: por debajo, el caso
 * es irresoluble y no mide nada; por encima, caben todas y tampoco.
 */
export interface Presupuesto {
  unidades_max: number;
}

export interface CasoDelCorpus {
  /** `^[a-z]{3}-(es|ca)-\d{3}$`. El prefijo identifica el dominio: `fac`, … */
  id: string;
  idioma: Idioma;
  dominio: Dominio;
  dificultad: Dificultad;
  /** Al menos una en cuanto la dificultad no es `facil`. */
  trampas: Trampa[];
  /** Lo que pregunta el usuario, en su idioma. */
  consulta: string;
  evidencia: UnidadDeEvidencia[];
  presupuesto: Presupuesto;
  /** Obligatorio si hay unidades `contradictoria`. */
  desempate?: Desempate;
  respuesta: Respuesta;
  /**
   * POR QUÉ este caso es difícil, con todas las letras. Los JSON no llevan
   * comentarios y sin esto un caso duro es indistinguible de una errata.
   * Obligatorio en dificultad `dificil`.
   */
  nota?: string;
}

/**
 * Un fichero de casos. La advertencia viaja DENTRO de los datos, no solo en el
 * README: quien cargue el JSON en un cuaderno dentro de seis meses no va a
 * abrir el README.
 */
export interface FicheroDeCasos {
  version_de_la_forma: string;
  dominio: Dominio;
  idioma: Idioma;
  /** Siempre `true`. Ningún caso viene de tráfico de cliente. */
  sintetico: true;
  /** Qué demuestra y qué NO demuestra este fichero. El validador exige que lo diga. */
  advertencia: string;
  casos: CasoDelCorpus[];
}

// ─── Derivaciones ────────────────────────────────────────────────────────────
//
// Todo lo que se puede calcular NO se escribe a mano en 180 casos. Una lista
// duplicada es una lista que un día dirá lo contrario que los datos.

export function esAbstencion(caso: CasoDelCorpus): boolean {
  return caso.respuesta.tipo === "abstencion";
}

/** Los campos que la respuesta DEBE contener. Vacío si el caso es de abstención. */
export function camposCriticos(caso: CasoDelCorpus): CampoRespuesta[] {
  if (caso.respuesta.tipo !== "valor") return [];
  return caso.respuesta.campos.filter((c) => c.critico);
}

/**
 * Las unidades sin las cuales el caso no se puede responder: la unión de las
 * citas de los campos críticos, o las citas de la abstención.
 *
 * Esto es exactamente lo que el knapsack no puede tirar.
 */
export function citasObligatorias(caso: CasoDelCorpus): string[] {
  const ids =
    caso.respuesta.tipo === "abstencion"
      ? caso.respuesta.citas
      : camposCriticos(caso).flatMap((c) => c.citas);
  return [...new Set(ids)].sort();
}

export function unidadesPorId(caso: CasoDelCorpus): Map<string, UnidadDeEvidencia> {
  return new Map(caso.evidencia.map((u) => [u.id, u]));
}

/** Cuántas unidades sobran: la presión real del caso. */
export function holguraDelPresupuesto(caso: CasoDelCorpus): number {
  return caso.evidencia.length - caso.presupuesto.unidades_max;
}
