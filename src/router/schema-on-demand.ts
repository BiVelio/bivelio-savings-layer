import type { ToolDescriptor, ToolRisk } from "../contracts/types.js";
import type { CostModel } from "../tokenizer/accounting.js";

// Schema-on-demand: primero se pregunta CUÁL, después se manda el esquema.
//
// Hoy el esquema JSON completo de cada herramienta candidata viaja en cada
// petición. Con un catálogo grande son decenas de miles de tokens de entrada por
// llamada para que el modelo use una o ninguna. El patrón parte la llamada en
// dos: un SONDEO con descriptores ligeros (nombre + una línea, sin `parameters`)
// y, con la respuesta, una INVOCACIÓN con los esquemas completos de las elegidas.
//
// LO QUE HACE QUE ESTO NO SEA UNA MALA IDEA ES ESTE FICHERO. La segunda llamada
// cuesta: se paga el prompt DOS veces y la salida del sondeo entera. Con un
// catálogo pequeño el patrón PIERDE dinero, y sin una verja delante sería un
// empeoramiento disfrazado de optimización — de los que se ven en la factura y
// no en el informe. Así que se decide por petición, en DINERO, con el
// tokenizador del modelo y su modelo de coste; nunca por ratio de tokens ni por
// "el catálogo parecía grande".
//
// La verja es aritmética pura sobre cuentas de tokens: no toca el pipeline, no
// llama al proveedor y no sabe ensamblar una herramienta. Eso último es
// deliberado — quien la llama cuenta las herramientas con el MISMO ensamblador
// que produce el baseline, que es la única forma de que las dos cuentas no
// diverjan (ver la nota de la regla de una sola regla en el pipeline).

/**
 * Techo DURO de salida del sondeo.
 *
 * El sondeo no responde: solo nombra herramientas, y eso cabe de sobra aquí. El
 * tope no es una estimación sino un límite que se le pasa al proveedor, así que
 * la verja puede usarlo como peor caso sin suponer nada. Y si el modelo se pone a
 * escribir prosa en vez de elegir, se corta pronto: esa respuesta no se sirve
 * jamás, así que truncarla no le quita nada a nadie y sí acota el gasto.
 */
export const SALIDA_DEL_SONDEO_TOKENS = 96;

/**
 * Cuántas herramientas de LECTURA como mucho viajan con esquema completo en la
 * segunda llamada.
 *
 * Es el mismo número con el que la verja calcula su peor caso, y por eso tiene
 * que aplicarse de verdad: si la segunda llamada pudiera llevar más de las que se
 * presupuestaron, la decisión se habría tomado con una cuenta que no se cumple.
 */
export const MAX_LECTURAS_DE_LA_SEGUNDA = 3;

/** Lo que hay que saber de ESTA petición para decidir. Todo en tokens. */
export interface EntradaDelDescubrimiento {
  /** Prompt ya montado, SIN herramientas. Es lo que se paga DOS veces. */
  promptTokens: number;
  /** Esquemas completos de TODAS las candidatas: lo que viaja hoy, en una sola llamada. */
  esquemasCompletos: number;
  /** Descriptores ligeros de todas las candidatas: lo que viaja en el sondeo. */
  descriptoresLigeros: number;
  /**
   * PEOR CASO de esquemas completos en la segunda llamada. No es una media ni una
   * apuesta: es la cota que {@link peorCasoDeEsquemas} calcula sobre el mismo
   * conjunto que después puede devolver {@link herramientasDeLaSegunda}, así que
   * la ganancia que sale de aquí es un suelo, no una esperanza.
   */
  esquemasDeLaSegunda: number;
  /** Salida esperada de la respuesta final. Se cancela en la resta; va para que la traza sea legible. */
  salidaFinal: number;
  /** Techo DURO de salida del sondeo. Al ser un tope, es también su peor caso. */
  salidaDelSondeo: number;
  precio: CostModel;
}

export interface DecisionDelDescubrimiento {
  aplicar: boolean;
  /** Coste de la ruta de hoy: una llamada con todos los esquemas. */
  costeDeUnaLlamada: number;
  /** Coste de la ruta de dos llamadas, con el peor caso de la segunda. */
  costeDeDosLlamadas: number;
  /** Ganancia en dinero. Negativa = el patrón pierde. */
  ganancia: number;
  /**
   * Lo que cuesta el sondeo cuando NO sirve de nada y hay que mandar la llamada
   * entera igual (el modelo no eligió, o la llamada falló). Es el precio de la
   * red de seguridad, y la verja exige que la ganancia lo cubra.
   */
  perdidaSiDegrada: number;
  razon: string;
}

/**
 * ¿Compensa partir esta petición en dos?
 *
 *     coste(una llamada)  = prompt + TODOS los esquemas          + salida
 *     coste(dos llamadas) = prompt + descriptores ligeros        + salida del sondeo
 *                         + prompt + esquemas de las elegidas    + salida
 *
 * Y una tercera cuenta que es la que de verdad decide: la ruta DEGRADADA, la de
 * cuando el sondeo no devuelve nada aprovechable y la petición sale igualmente
 * con todos los esquemas. Ahí el sondeo es coste puro.
 *
 * La regla es `ganancia >= perdidaSiDegrada`: el patrón se aplica solo si sigue
 * saliendo a cuenta con una degradación de cada dos peticiones. No hace falta
 * suponerle a nadie una tasa de acierto —suponerla es inventarse un número— y el
 * margen exigido queda atado al tamaño exacto del riesgo que se corre.
 *
 * `salidaFinal` aparece en los dos lados y se cancela: la capa no encoge la
 * respuesta final, así que no puede acreditarse nada por ella. Se pide igual para
 * que las dos cifras de la traza sean el coste de verdad y no un delta pelado.
 */
export function decidirDescubrimiento(e: EntradaDelDescubrimiento): DecisionDelDescubrimiento {
  const entrada = (t: number): number => (t / 1000) * e.precio.inputPer1k;
  const salida = (t: number): number => (t / 1000) * e.precio.outputPer1k;

  const costeDelSondeo =
    entrada(e.promptTokens + e.descriptoresLigeros) + salida(e.salidaDelSondeo);
  const costeDeUnaLlamada =
    entrada(e.promptTokens + e.esquemasCompletos) + salida(e.salidaFinal);
  const costeDeDosLlamadas =
    costeDelSondeo + entrada(e.promptTokens + e.esquemasDeLaSegunda) + salida(e.salidaFinal);

  const ganancia = costeDeUnaLlamada - costeDeDosLlamadas;
  // Degradar = el sondeo + la llamada de siempre. El sobrecoste es el sondeo entero.
  const perdidaSiDegrada = costeDelSondeo;

  const aplicar = ganancia > 0 && ganancia >= perdidaSiDegrada;

  let razon: string;
  if (ganancia <= 0) {
    razon =
      `descubrir cuesta más de lo que ahorra: el prompt (${e.promptTokens} tokens) se paga dos ` +
      `veces y los esquemas que se evitan (${e.esquemasCompletos - e.esquemasDeLaSegunda}) no lo cubren`;
  } else if (!aplicar) {
    razon =
      `la ganancia no cubre el coste de degradar: si el sondeo no elige, la petición sale igual ` +
      `con todos los esquemas y el sondeo es coste puro`;
  } else {
    razon =
      `se evitan ${e.esquemasCompletos - e.esquemasDeLaSegunda} tokens de esquema en el peor caso, ` +
      `bastante para pagar el prompt repetido y el sondeo`;
  }

  return { aplicar, costeDeUnaLlamada, costeDeDosLlamadas, ganancia, perdidaSiDegrada, razon };
}

/**
 * El descriptor LIGERO de una herramienta: lo justo para que el modelo sepa que
 * existe y para qué sirve.
 *
 * Se va `parameters`, que es donde está el volumen. Se queda una línea de
 * descripción, porque un sondeo sobre nombres pelados es adivinar: si el modelo
 * elige mal, la petición degrada (y se paga) o —peor— se queda sin la capacidad
 * que necesitaba.
 *
 * Cuando el llamante no puso `description` se usan sus `intents`. No es texto
 * inventado por la capa: es el mismo campo con el que el selector decide si la
 * herramienta es relevante, y aquí decide lo mismo un juez mejor. Cuesta tokens,
 * y esos tokens los cuenta la verja como cualquier otro — no se esconden.
 */
export function descriptorLigero(tool: ToolDescriptor): ToolDescriptor {
  const texto = (tool.description ?? tool.intents.join("; ")).trim();
  // Una línea: un `description` de tres párrafos con ejemplos vuelve a ser el
  // volumen que este patrón viene a quitar.
  const unaLinea = texto.split(/\r?\n/, 1)[0] ?? "";
  const recortada = unaLinea.length > MAX_CARACTERES_DE_DESCRIPCION
    ? unaLinea.slice(0, MAX_CARACTERES_DE_DESCRIPCION - 1).trimEnd() + "…"
    : unaLinea;
  return {
    id: tool.id,
    intents: tool.intents,
    risk: tool.risk,
    ...(recortada ? { description: recortada } : {}),
  };
}

/** Tope de la descripción de un descriptor ligero, en caracteres. */
const MAX_CARACTERES_DE_DESCRIPCION = 200;

/**
 * Las herramientas que viajan en la SEGUNDA llamada, con su esquema completo.
 *
 * LAS DE ESCRITURA VAN SIEMPRE, las eligiera el sondeo o no. Este repo ya se
 * quemó con esta forma exacta de fallo: cuando el proveedor no ve la capacidad,
 * el modelo contesta «claro, la reenvío» y la factura NO se reenvía — y el
 * informe lo presenta como éxito económico, porque efectivamente no se gastó
 * nada. Es el peor fallo posible de una capa de ahorro: silencioso, caro para el
 * cliente y contabilizado como victoria.
 *
 * Un sondeo que mira descriptores sin `parameters` decide con MENOS información
 * de la que declaró el llamante, y de esa decisión no puede depender que una
 * acción ocurra. Así que el ahorro se busca solo entre las de lectura: perder
 * una de esas degrada la respuesta y se nota; perder una de escritura no se nota
 * nunca. Las dos no empatan.
 *
 * De las de lectura se admiten como mucho `maxLecturas`, que es exactamente la
 * cota con la que {@link peorCasoDeEsquemas} decidió. El orden de salida es el
 * de las candidatas, no el del sondeo: estable entre peticiones, que es lo que
 * quiere la caché de prefijo del proveedor.
 */
export function herramientasDeLaSegunda(
  nombresElegidos: readonly string[],
  candidatas: readonly ToolDescriptor[],
  maxLecturas: number,
): { tools: ToolDescriptor[]; reconocidos: string[]; ignorados: string[] } {
  const porId = new Map(candidatas.map((t) => [t.id, t]));
  const reconocidos: string[] = [];
  const ignorados: string[] = [];
  const lecturasElegidas = new Set<string>();

  for (const nombre of nombresElegidos) {
    const tool = porId.get(nombre);
    // Un nombre que no está entre las candidatas es alucinación del modelo: no
    // abre ninguna capacidad nueva, así que se ignora sin más.
    if (!tool) {
      ignorados.push(nombre);
      continue;
    }
    if (reconocidos.includes(tool.id)) continue;
    reconocidos.push(tool.id);
    if (tool.risk === "read" && lecturasElegidas.size < Math.max(0, maxLecturas)) {
      lecturasElegidas.add(tool.id);
    }
  }

  const tools = candidatas.filter((t) => t.risk !== "read" || lecturasElegidas.has(t.id));
  return { tools, reconocidos, ignorados };
}

/**
 * Cota superior de lo que puede llegar a costar la segunda llamada en esquemas.
 *
 * Es la cifra con la que decide la verja, así que TIENE que ser una cota de
 * verdad: todas las de escritura (que van siempre) más las `maxLecturas`
 * lecturas más caras. Ninguna elección posible del modelo puede superarla, y hay
 * un test que lo fija sobre elecciones arbitrarias. Si esta cuenta se quedara
 * corta, la verja aprobaría peticiones que pierden dinero — que es justo el
 * fallo que este fichero existe para no cometer.
 */
export function peorCasoDeEsquemas(
  candidatas: readonly { risk: ToolRisk; tokens: number }[],
  maxLecturas: number,
): number {
  let total = 0;
  const lecturas: number[] = [];
  for (const c of candidatas) {
    if (c.risk === "read") lecturas.push(c.tokens);
    else total += c.tokens;
  }
  lecturas.sort((a, b) => b - a);
  for (const t of lecturas.slice(0, Math.max(0, maxLecturas))) total += t;
  return total;
}
