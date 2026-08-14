/**
 * LA FORMA de un caso del golden set del knapsack de evidencia (F6).
 *
 * F6 es la primera palanca *task-preserving* del plan: no reconstruye el
 * original, conserva lo necesario para producir EL MISMO RESULTADO
 * VERIFICABLE. Eso no se puede garantizar matemáticamente para un prompt
 * arbitrario, así que hay que demostrarlo por función, por segmento documental
 * y por IDIOMA — y para demostrarlo hace falta un conjunto de casos con
 * respuesta correcta conocida. Esto es el molde de esos casos.
 *
 * ─── QUÉ TIENE QUE PODER MEDIR UN ARNÉS CON ESTO ────────────────────────────
 *
 * Dado un caso, un selector recibe `consulta` + `unidades` y un presupuesto
 * (`presupuesto.maxUnidades`), y devuelve un SUBCONJUNTO de unidades. Con eso
 * se pueden calcular las tres cifras que decide la aceptación de F6:
 *
 *   1. CONSERVACIÓN DE CAMPOS CRÍTICOS: ¿el subconjunto elegido contiene todas
 *      las unidades con `papel: "necesaria"`? Si falta una, la respuesta
 *      correcta es imposible por construcción — da igual lo bien que redacte el
 *      modelo. Se mide sin llamar a ningún proveedor.
 *   2. CITAS VÁLIDAS Y ACCESIBLES: ¿`citasObligatorias` está dentro del
 *      subconjunto? Una cita a una unidad que no se mandó es una cita muerta.
 *   3. AHORRO: cuántas unidades (y cuántos tokens) se dejaron fuera.
 *
 * `campoTrampa` añade la cuarta, que es la que hace diagnóstico y no solo
 * semáforo: cuando el selector falla, ¿cayó en la trampa DECLARADA del caso o
 * falló por otra cosa? Un corpus que solo dice «bien/mal» no dice dónde tocar.
 *
 * ─── POR QUÉ EL PRESUPUESTO ES PARTE DEL CASO ───────────────────────────────
 *
 * Si el presupuesto da para mandarlo todo, no hay knapsack: mandarlo todo es
 * óptimo y el caso no prueba nada. `presupuesto.maxUnidades` es siempre
 * `>= nº de necesarias` y `< nº total de unidades`, así que SIEMPRE hay que
 * tirar algo y SIEMPRE existe una elección correcta. La verja de
 * `test/corpus-contratos.test.ts` lo comprueba caso a caso.
 *
 * ─── ESTADO DE ESTA FORMA ───────────────────────────────────────────────────
 *
 * Propuesta MÍNIMA, escrita porque el corpus de contratos no podía esperar. El
 * dominio de facturación publica la suya; si difieren, esta cede y se unifica.
 * Los campos que hay aquí son el suelo, no el techo: `dominio` es un `string`
 * abierto justamente para que otro dominio no tenga que tocar este fichero.
 */

/** Idiomas del golden set. El reparto es real, no decorativo (ver README). */
export type Idioma = "es" | "ca";

/**
 * `facil` existe como CONTROL, no como relleno: sin casos fáciles no se
 * distingue un selector que elige bien de uno que se lo manda todo por miedo.
 */
export type Dificultad = "facil" | "media" | "dificil";

/**
 * La clase de trampa que el caso ejercita. No es decoración: la verja exige
 * cobertura mínima por clase, porque un corpus con cincuenta casos de la misma
 * trampa demuestra una cosa, no diez.
 */
export type Trampa =
  /** «el seguro NO cubre daños por agua» vs «cubre daños por agua». */
  | "negacion"
  /** Una regla general y su excepción en otro párrafo, lejos. */
  | "excepcion"
  /** «siempre que se comunique en 7 días». */
  | "condicion"
  /** 12.480,55 y 12.408,55 conviviendo en el mismo contexto. */
  | "importes-parecidos"
  /** 30/06 y 06/07; fecha de envío y fecha de recepción. */
  | "fechas-parecidas"
  /** «según lo previsto en la cláusula 4.2», y la 4.2 es otra unidad. */
  | "referencia-cruzada"
  /** «deberá» vs «podrá». */
  | "verbo-modal"
  /** F-2024-118 vs F-2024-1118. */
  | "identificadores-parecidos"
  /** Una cláusula posterior que anula a otra anterior. */
  | "derogacion"
  /** EUR/m² vs EUR, con IVA vs sin IVA, horas vs días. */
  | "unidades"
  /** La respuesta correcta es no responder. */
  | "abstencion"
  /** Palabras que solo se distinguen por la tilde (més/mes, sí/si). */
  | "diacriticos"
  /** col·legi, instal·lació: el punt volat. */
  | "ela-geminada"
  /** l'import, s'ha, d'aquest. */
  | "apostrofo";

/**
 * El papel de una unidad DENTRO DEL CASO. Es la única regla de la que se deriva
 * todo lo demás (qué se puede tirar, qué hay que citar): no hay una segunda
 * lista de «necesarias» que pueda contradecir a esta.
 */
export type PapelUnidad =
  /** Sin ella la respuesta correcta es imposible. Tirarla es el fallo que caza el corpus. */
  | "necesaria"
  /** Plausible, del mismo tema, y prescindible. Es lo que el knapsack DEBE tirar. */
  | "distractora"
  /** Dice lo contrario que otra. Con regla de desempate manda una; sin ella, se abstiene. */
  | "contradictoria"
  /**
   * Anulada por una cláusula posterior. Es la trampa invertida: responde a la
   * consulta MEJOR que la que manda —por eso la elige un selector por
   * parecido— y es exactamente la que hay que tirar.
   */
  | "derogada";

export interface Procedencia {
  /** «contrato marco», «Adenda nº 2», «Anexo VI bis», «registro de comunicaciones». */
  documento: string;
  /** «12.1», «4.2», «§7». */
  clausula?: string;
  /** Fecha del documento, ISO. Es lo que permite ordenar una derogación. */
  fecha?: string;
}

export interface UnidadDeEvidencia {
  /** Único dentro del caso: «u1», «u2», … */
  id: string;
  texto: string;
  papel: PapelUnidad;
  procedencia?: Procedencia;
  /** Por qué esta unidad concreta es peligrosa. Los JSON no llevan comentarios. */
  nota?: string;
}

/**
 * Valor comprobable POR MÁQUINA. Nunca prosa libre: si para saber si la
 * respuesta es correcta hay que leerla y opinar, el corpus no mide, sugiere.
 */
export type ValorCampo = string | number | boolean | null | string[] | number[];

export type MotivoAbstencion =
  /** Falta un documento al que la propia evidencia remite. */
  | "evidencia-insuficiente"
  /** Dos unidades se contradicen y no hay nada que permita ordenarlas. */
  | "contradiccion-sin-regla-de-desempate";

export interface RespuestaEsperada {
  /** `true` cuando la respuesta correcta es NO responder. */
  abstenerse: boolean;
  motivoAbstencion?: MotivoAbstencion;
  /**
   * Los hechos que la respuesta debe contener, en forma comparable. En un caso
   * de abstención lleva lo que describe el conflicto (`valores_en_conflicto`,
   * `documento_que_falta`), no una respuesta.
   */
  campos: Record<string, ValorCampo>;
}

/**
 * El fallo CONCRETO en el que cae un selector que tira las unidades de
 * `siSeCae`. No es adorno: separa «falló como esperábamos» de «falló por otra
 * cosa», y una respuesta trampa siempre está bien redactada y es plausible —
 * ese es justamente el peligro de una palanca task-preserving.
 */
export interface CampoTrampa {
  campo: string;
  valorErroneo: ValorCampo;
  /** Ids de unidades cuya pérdida produce ese valor erróneo. */
  siSeCae: string[];
}

export interface Presupuesto {
  /**
   * Cuántas unidades como mucho puede mandar el selector. Siempre
   * `>= necesarias` y `< unidades.length`: hay presión real y hay solución.
   */
  maxUnidades: number;
}

export interface CasoDeEvidencia {
  /** `ct-es-001`, `ct-ca-014`. El prefijo es del dominio, el idioma va dentro. */
  id: string;
  idioma: Idioma;
  /** Abierto a propósito: «contratos», «facturas», … */
  dominio: string;
  /** «arrendamiento», «proteccion-de-datos», … */
  subdominio: string;
  dificultad: Dificultad;
  trampas: Trampa[];
  consulta: string;
  presupuesto: Presupuesto;
  unidades: UnidadDeEvidencia[];
  respuesta: RespuestaEsperada;
  /** Subconjunto de `respuesta.campos` que NO se puede perder. */
  camposCriticos: string[];
  /** Ids de unidades que sostienen la respuesta. Toda necesaria está aquí. */
  citasObligatorias: string[];
  campoTrampa?: CampoTrampa;
  /**
   * Id del caso GEMELO. Un gemelo comparte estructura y cambia una sola cosa:
   * el idioma (mide la degradación por idioma que prohíbe la aceptación de F6),
   * o un dato que invierte la respuesta (mide que el selector razona en vez de
   * reconocer la forma del caso). La relación es simétrica y la verja lo exige:
   * si A apunta a B, B apunta a A.
   */
  par?: string;
  /**
   * Por qué este caso es difícil, en prosa. Va aquí y no en un comentario
   * porque los JSON no llevan comentarios y el porqué es la mitad del valor.
   */
  nota: string;
}

/** Las unidades sin las que la respuesta correcta es imposible. */
export function unidadesNecesarias(caso: CasoDeEvidencia): UnidadDeEvidencia[] {
  return caso.unidades.filter((u) => u.papel === "necesaria");
}

/** Las que el knapsack debería tirar sin coste: distractoras y derogadas. */
export function unidadesPrescindibles(caso: CasoDeEvidencia): UnidadDeEvidencia[] {
  return caso.unidades.filter((u) => u.papel === "distractora" || u.papel === "derogada");
}

/**
 * ¿Una selección conserva lo que hace falta? Es la medida de aceptación de F6
 * («100 % de conservación de campos críticos») calculada sin llamar a ningún
 * proveedor: si falta una necesaria o una cita, ninguna respuesta puede ser
 * correcta, y eso se sabe antes de generar nada.
 */
export function evaluaSeleccion(
  caso: CasoDeEvidencia,
  seleccionadas: readonly string[],
): {
  conservaNecesarias: boolean;
  citasAccesibles: boolean;
  dentroDePresupuesto: boolean;
  necesariasPerdidas: string[];
  citasMuertas: string[];
  cayoEnLaTrampa: boolean;
} {
  const elegidas = new Set(seleccionadas);
  const necesariasPerdidas = unidadesNecesarias(caso)
    .map((u) => u.id)
    .filter((id) => !elegidas.has(id));
  const citasMuertas = caso.citasObligatorias.filter((id) => !elegidas.has(id));
  const trampa = caso.campoTrampa;
  return {
    conservaNecesarias: necesariasPerdidas.length === 0,
    citasAccesibles: citasMuertas.length === 0,
    dentroDePresupuesto: seleccionadas.length <= caso.presupuesto.maxUnidades,
    necesariasPerdidas,
    citasMuertas,
    cayoEnLaTrampa: trampa ? trampa.siSeCae.every((id) => !elegidas.has(id)) : false,
  };
}
