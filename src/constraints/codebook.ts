import type { JsonSchema } from "../contracts/types.js";
import type { CostModel } from "../tokenizer/accounting.js";
import type { EvidenciaDelCodebook } from "./codebook-evidencia.js";
import { validateAgainstSchema } from "./validate.js";

/**
 * Codebook de salida.
 *
 * ⚠️ MEDIDO EN VIVO: EL SIGNO DE ESTA PALANCA DEPENDE DEL MODELO. Gana un 8 % en
 * `gpt-4o` y pierde un 8 % en `gpt-4o-mini`, con el mismo contrato y el mismo
 * prompt. Lee la sección «LA CUARTA VERJA» antes de tocar nada.
 *
 * POR QUÉ EXISTE. La salida es la parte cara de la factura y la palanca obvia
 * —bajar `maxOutputTokens`— está medida como NETO NEGATIVO: un techo no es una
 * instrucción, así que solo ahorra TRUNCANDO, y un truncado es una llamada
 * entera pagada que no sirve (por eso el pipeline se niega a reintentarlo, ver
 * la etapa 11). El único ahorro de salida que no compra calidad es que lo que
 * el modelo genere OCUPE MENOS TOKENS SIN PERDER UN BIT:
 *
 *     genera hoy      {"decision":"human_review","confidence":0.87}
 *     con codebook    {"d":"H","confidence":0.87}
 *     devuelve la capa   idéntico a lo primero
 *
 * Es la misma idea que el torneo de serializadores aplicada al otro eje: mismo
 * contenido, menos símbolos. La diferencia es que aquí la reversión tiene que
 * ser DEMOSTRABLE, porque el valor que se expande es el que se le devuelve al
 * llamante y el que se guarda en caché. Y la otra diferencia, la que costó el
 * dinero: en el torneo de serializadores el texto que se acorta ya está escrito,
 * y aquí lo tiene que escribir el modelo DESPUÉS de leer el contrato compacto.
 *
 * LAS CUATRO VERJAS, todas apply-or-drop (nunca a medias):
 *
 *  1. REVERSIBILIDAD. Se sintetizan testigos a partir del esquema ORIGINAL que
 *     tocan cada clave renombrada y cada valor de enum codificado, y se exige
 *     `expand(compact(t)) === t` sobre todos. Si alguno falla, no hay codebook.
 *  2. ADMISIBILIDAD. El testigo compactado tiene que validar contra el esquema
 *     COMPACTO, que es el que viaja al proveedor. Sin esto, un `required` mal
 *     reescrito viaja como contrato y el proveedor rechaza la petición entera.
 *  3. DINERO, PONDERADO POR PRECIO. Se cuenta con el tokenizador de destino, por
 *     los DOS lados y con la TARIFA de cada lado: el esquema compacto viaja en la
 *     ENTRADA (`response_format`) y la respuesta se factura como SALIDA, que en
 *     la familia 4o cuesta 4x. Comparar los dos lados en tokens pelados —como se
 *     hacía— es comparar dólares con céntimos.
 *  4. EVIDENCIA. El signo del efecto sobre la SALIDA no está en el esquema: es
 *     una propiedad DEL MODELO y hay que haberla medido. Sin dato para ese
 *     modelo no hay codebook. Es la verja que faltaba, y la que sigue.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA CUARTA VERJA: EL SIGNO DEPENDE DEL MODELO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Escenario «Triage decision», misma capa, mismo contrato, 8 repeticiones
 * pareadas, dos modelos de la MISMA familia y con la MISMA tarifa relativa
 * (salida = 4x entrada):
 *
 *     modelo         A (sin capa)   B (codebook)   Δ salida   neto
 *     gpt-4o-mini      184 / 72      158 / 88        −16      −8,2 %
 *     gpt-4o           184 / 75      158 / 72         +3      +8,0 %  (95 %lo 4,8 %)
 *
 * LA ENTRADA BAJA IGUAL EN LOS DOS: 184 → 158, −26 tokens. Eso es determinista
 * —es el esquema compacto— y se calcula aquí sin llamar a nadie. LO QUE CAMBIA DE
 * SIGNO ES LA SALIDA: el modelo pequeño parece perder guía semántica con nombres
 * de campo cortos (`"d"` en vez de `"decision"`) y rellena más; el grande no.
 *
 * Y ESA ES LA LECCIÓN QUE COSTÓ LA JORNADA: con SOLO la tirada de `gpt-4o-mini`
 * la conclusión fue «la palanca pierde dinero, hay que retirarla», y la segunda
 * tirada la invirtió. Una tirada contra un solo modelo no es un resultado.
 * Ninguna afirmación sobre el codebook vale sin el modelo pegado — ni en un
 * comentario, ni en el README, ni en el informe del banco.
 *
 * POR QUÉ NO SE VIO ANTES NINGUNO DE LOS DOS: en MOCK no puede verse.
 * `providers/mock.ts` fabrica la respuesta A PARTIR DEL ESQUEMA que recibe, así
 * que con un esquema compacto fabrica una respuesta compacta y la palanca
 * «ahorra» siempre, contra cualquier modelo simulado. Es un artefacto del
 * simulador, no una propiedad del mundo, y el banco lo publicaba como +24,8 %.
 *
 * Y EL RAZONAMIENTO DE LA VERJA VIEJA ERA FALSO, no solo incompleto. Decía que
 * comparar sin ponderar por precio «hace la regla más estricta de lo necesario,
 * que es el lado correcto en el que equivocarse». Eso solo es cierto si el ahorro
 * de salida es POSITIVO. Cuando es NEGATIVO, no ponderar INFRAVALORA una pérdida
 * que pesa 4x y la regla sale DEMASIADO PERMISIVA. Una aproximación «conservadora»
 * que cambia de lado con el signo del dato no es conservadora: es una suposición
 * sin comprobar. Por eso la verja 3 pondera ahora por precio, y por eso pide el
 * `CostModel` en vez de aceptar decidir sin él.
 *
 * EL MARGEN, EN NÚMEROS, que es lo que explica que aquí no se pueda adivinar. Con
 * el suelo de prudencia de 8 tokens de entrada, la tarifa de la familia 4o y el
 * contrato de triaje del banco, que ahorra 29 tokens de entrada en su
 * `response_format`:
 *
 *     paga mientras el delta de salida se mantenga por encima de −5,25 tokens
 *
 * Sobre una respuesta de ~72 tokens eso es una banda del ±7 %. Los dos efectos
 * medidos son +4 % y −22 %: uno a cada lado, y el malo tres veces más grande que
 * todo el margen. No hay función del esquema que separe esos dos casos, porque
 * el esquema es EL MISMO en los dos.
 *
 * LO QUE SE PROBÓ Y NO VALE, para que nadie lo reintente:
 *
 *  · UNA PENALIZACIÓN FIJA POR DEFECTO («supongamos que la salida crece un X %»).
 *    Con X del lado de `gpt-4o-mini` se apaga la palanca en `gpt-4o`, donde gana
 *    un 8 % probado; con X del lado de `gpt-4o` se deja encendida donde pierde.
 *    No hay X que acierte en los dos, porque el parámetro que decide no es X, es
 *    el modelo.
 *  · MODELAR LA INFLACIÓN SOBRE EL TESTIGO SINTÉTICO. Aplicar el −22 % medido al
 *    testigo da 7,5 tokens de riesgo sobre el contrato de triaje, y la verja
 *    SEGUIRÍA aplicando en `gpt-4o-mini` (neto +27 en equivalentes de entrada):
 *    seguiría perdiendo. El testigo es un SUELO de la respuesta real (34 tokens
 *    contra los 72 medidos), así que como base de un RIESGO infravalora por 2x.
 *    Equivocarse a la baja está bien para un ahorro y está mal para una pérdida.
 *  · MODELARLA SOBRE `maxOutputTokens`. Es un techo, no una expectativa: con el
 *    256 por defecto el riesgo sale 56 tokens (3,5x el medido) y la verja no
 *    dispararía jamás, ni siquiera donde gana. Eso no es prudencia, es apagarla
 *    con un número inventado.
 *  · APRENDERLO EN EL CAMINO CALIENTE, como hacen las otras tres verjas con
 *    memoria de la capa. No se puede, y el motivo está desarrollado en
 *    `codebook-evidencia.ts`: las tres aprenden de algo que UNA petición revela
 *    por sí sola, y el delta del codebook es un CONTRAFACTUAL que la petición
 *    enviada no contesta. El instrumento con potencia para medirlo es el A/B
 *    PAREADO sobre el mismo prompt (`benchmarks/ab-live.ts`), que lo resuelve en
 *    8 pares; estimarlo por medias en producción necesita cientos de peticiones
 *    y pierde dinero en la mitad mientras tanto.
 *
 * DE AHÍ LA VERJA 4: el delta de salida ENTRA, no se deduce. Lo trae el llamante
 * medido sobre su tráfico, o sale del catálogo de lo que BiVelio ha medido por
 * modelo (`codebook-evidencia.ts`), y sin ninguno de los dos la palanca no se
 * aplica. El motivo del rechazo publica el delta de equilibrio exacto, para que
 * lo que hay que medir no haya que adivinarlo.
 *
 * Y UN DELTA NEGATIVO APAGA LA PALANCA SIN MÁS ARITMÉTICA, aunque el esquema
 * ahorre mucho. Con un delta medido de −16 la verja de dinero volvería a aplicar
 * en cuanto un contrato ahorrara 72 tokens de entrada… que es justo un contrato
 * GRANDE, con respuestas más largas, donde la pérdida de salida sería mayor que
 * los −16 medidos sobre respuestas de 72 tokens. El ahorro de entrada está
 * ACOTADO por el tamaño del esquema; la pérdida de salida ESCALA con la longitud
 * de la respuesta y se factura 4x. Dejar que la primera compre a la segunda es
 * extrapolar una medición justo hacia donde deja de valer.
 *
 * QUÉ DEMUESTRA HOY CADA VERJA, medido por mutación y no por intuición. Las
 * verjas 1 y 2 son INALCANZABLES desde `planOutputCodebook` con la derivación
 * correcta, porque los guardias por nodo cortan antes todos los caminos que las
 * harían morder (`usados` impide dos claves con el mismo código, el guardia de
 * ambigüedad tumba el nodo cuando un código choca con otro nombre, y el de
 * `minLength` impide el único caso conocido de esquema compacto inadmisible).
 * Eso es buena ingeniería, pero dejaba la red SIN VERIFICAR: desactivar la 1 o
 * la 2 —una a una, dejándolas pasar siempre— dejaba la suite ENTERA en verde
 * (1077/1077), y de la 1 cuelga entera la afirmación de que esto es lossless.
 * Por eso las dos viven ahora en `verificarTestigos`, una función suelta a la
 * que los tests le pasan un `node` ROTO a mano —un mapa inverso que no es el
 * inverso, un `required` compacto sin reescribir— y le ejercitan el camino de
 * RECHAZO, que era el que nadie recorría. Mutar hoy cualquiera de las dos a
 * `if (false)` tumba 2 tests cada una. Lo que prueba que la reversión es
 * correcta en el camino REAL siguen siendo esos guardias y los tests de
 * round-trip; las verjas 1 y 2 son la red para cuando se afloje un guardia —que
 * es trabajo pendiente y declarado (`pattern`, `additionalProperties` abierto)—,
 * y ahora consta que la red existe. Quien afloje un guardia sigue debiendo el
 * caso que la hace morder a través de `planOutputCodebook`.
 *
 * LO QUE NO SE PUEDE PROBAR AQUÍ, y por eso esta palanca es opt-in: que el
 * modelo razone IGUAL de bien rellenando `{"d":"H"}` que `{"decision":
 * "human_review"}`. La reversión es lossless en DATOS; la calidad de lo que el
 * modelo decide poner ahí solo la puede demostrar un A/B, exactamente igual que
 * pasó con el techo de salida.
 */

/** Profundidad máxima del esquema. Un esquema cíclico (construido por
 *  referencia) colgaría el recorrido; pasado el tope se descarta el codebook. */
const PROFUNDIDAD_MAXIMA = 16;

/** Enums más largos que esto no se codifican: los códigos dejan de ser cortos
 *  y el número de testigos que hay que verificar crece con ellos. */
const ENUM_MAXIMO = 64;

/**
 * Ahorro NETO mínimo para aplicar, expresado en TOKENS DE ENTRADA equivalentes.
 *
 * La unidad importa desde que la verja pondera por precio: el suelo se convierte
 * a dinero con la tarifa de ENTRADA del modelo de destino, así que «8» significa
 * lo mismo en un modelo caro que en uno barato —lo que cuesta enviar 8 tokens de
 * prompt— y no lo que valga un token de salida, que es entre 2x y 5x según el
 * modelo. Ver `planOutputCodebook`.
 */
const SUELO_POR_DEFECTO_EN_TOKENS_DE_ENTRADA = 8;

/**
 * Las dos mediciones en vivo, en una frase, para citarlas en el motivo del
 * rechazo sin repetirlas a mano. Van LAS DOS: media frase («la salida crece»)
 * es la que produjo la conclusión equivocada.
 */
const LO_QUE_SE_MIDIO =
  "measured live on the same triage contract, 8 paired reps each: gpt-4o-mini wrote 16 tokens MORE " +
  "(-8.2% net) and gpt-4o wrote 3 tokens FEWER (+8.0% net)";

/**
 * Lo que hay que deshacer al expandir una respuesta. Un subárbol sin renombres
 * ni códigos no produce nodo: expandir es entonces la identidad y se evita
 * recorrer datos que nadie tocó.
 *
 * Exportado solo para que los tests puedan CONSTRUIR uno roto y ver morder las
 * verjas; ver `verificarTestigos`. No cuesta superficie pública: este fichero no
 * se reexporta desde `constraints/index.ts`.
 */
export interface CodebookNode {
  /** clave compacta → clave original. */
  keysBack?: Map<string, string>;
  /** clave original → clave compacta. */
  keysFwd?: Map<string, string>;
  /** clave ORIGINAL → nodo del hijo. */
  props?: Map<string, CodebookNode>;
  /** nodo de los elementos, para arrays. */
  items?: CodebookNode;
  /** código → valor original. */
  enumBack?: Map<string, string>;
  /** valor original → código. */
  enumFwd?: Map<string, string>;
}

export interface CodebookPlan {
  /** El esquema que viaja al proveedor en lugar del original. */
  compactSchema: JsonSchema;
  /** Respuesta compacta → forma del llamante. Total: nunca lanza. */
  expand(value: unknown): unknown;
  /** Forma del llamante → respuesta compacta. Existe para la verja y los tests. */
  compact(value: unknown): unknown;
  renamedKeys: number;
  codedEnumValues: number;
  /** Tokens del esquema original y del compacto, con el tokenizador de destino. */
  schemaTokensOriginal: number;
  schemaTokensCompact: number;
  /**
   * Ahorro de FORMA modelado sobre el peor testigo sintético: cuántos tokens
   * menos ocupan LOS MISMOS DATOS escritos en compacto.
   *
   * SE PUBLICA COMO DIAGNÓSTICO, NO DECIDE NADA, y el cambio de nombre es
   * deliberado: antes se llamaba `modelledOutputSavingTokens` y sí decidía, que
   * es exactamente el error. Un testigo sintético no dice cuánto CONTENIDO va a
   * escribir el modelo, que es la mitad que pesa; medido en vivo, esos 7 tokens
   * de forma quedaron sepultados por 16 de contenido extra.
   */
  modelledShapeSavingTokens: number;
  /**
   * El delta de salida MEDIDO con el que se decidió, en tokens. Positivo = con
   * el codebook el modelo escribe MENOS. Es la única cifra que decide el lado de
   * la salida, y entra: no se deduce de nada de aquí.
   */
  measuredOutputDeltaTokens: number;
  /**
   * De dónde salió ese delta. Viaja hasta la traza porque un delta sin
   * procedencia es la forma exacta en que este repo se equivocó: «−16» sin el
   * modelo pegado parecía una propiedad del codebook y era una del modelo.
   */
  outputDeltaProvenance: string;
  /**
   * Delta de salida en el que este contrato deja de pagar, con estos precios.
   * Negativo = la respuesta puede crecer hasta ahí y seguir saliendo a cuenta.
   */
  breakEvenOutputDeltaTokens: number;
  /** Ahorro neto en DINERO por petición, con la tarifa del modelo de destino. */
  netSavingUsd: number;
}

export type CodebookDecision =
  | { applied: true; plan: CodebookPlan; reason: string }
  | { applied: false; reason: string };

/**
 * Deriva un codebook para el esquema del llamante y decide si merece la pena.
 *
 * `countTokens` tiene que ser el tokenizador REAL del modelo de destino (el
 * mismo `tokensFor` que usa el torneo de formatos): la verja de dinero cuenta
 * tokens, y con un contador distinto al que factura el proveedor la cuenta no
 * significa nada.
 *
 * `precio` ES OBLIGATORIO, y esa es media reparación. La decisión es en DINERO:
 * los tokens de esquema que se ahorran son de ENTRADA y los de la respuesta son
 * de SALIDA, y la razón entre las dos tarifas no es 1 ni es la misma en todos los
 * modelos —4,0x en la familia 4o, 5,0x en `claude-opus-4`, 2,0x en `gpt-4`, ver
 * `pricing/catalogo.ts`—. Con la firma vieja se podía decidir sin precio, y sin
 * precio la decisión sale mal por construcción. Se pide el del modelo que VA A
 * CONTESTAR, no el que se pidió: con la cascada enrutando son distintos.
 *
 * `opts.evidencia` es la verja 4: el delta de salida MEDIDO para ESTE modelo,
 * con su procedencia pegada, tal y como lo resuelve `MemoriaDelCodebook`.
 * Positivo = el codebook hace que el modelo escriba menos. Sin evidencia no se
 * aplica jamás, y el motivo del rechazo dice qué número habría que medir y cuál
 * es el umbral. Ver la cabecera del módulo para por qué esa cifra no se puede
 * derivar del esquema ni aprender en el camino caliente.
 *
 * El mínimo por defecto (8 tokens de ENTRADA equivalentes) no es un umbral de
 * precisión, es un umbral de PRUDENCIA: cambiar el `response_format` que ve el
 * proveedor tiene un riesgo de calidad que ninguna verja de aquí puede medir,
 * así que no se corre por ganancias triviales.
 */
export function planOutputCodebook(
  schema: JsonSchema,
  countTokens: (text: string) => number,
  precio: CostModel,
  opts: { minimumSavingsTokens?: number; evidencia?: EvidenciaDelCodebook | null } = {},
): CodebookDecision {
  const minimo = opts.minimumSavingsTokens ?? SUELO_POR_DEFECTO_EN_TOKENS_DE_ENTRADA;

  let derivado: Derivado;
  try {
    // Un `pattern` en cualquier parte deja el esquema fuera. No es que el codebook
    // rompa un regex —no toca esa restricción— sino que no se puede SINTETIZAR un
    // testigo que lo cumpla, y sin testigo válido no hay nada que demostrar. Sin
    // prueba, no hay palanca.
    //
    // EL RECORRIDO VA DENTRO DEL `try`, y ese detalle es el arreglo. Antes
    // `contienePattern` devolvía `true` al pasarse de profundidad, así que un
    // esquema de 18 niveles o uno cíclico —sin un solo regex— se descartaba con el
    // motivo «schema has a pattern» y la rama `RangeError` de aquí abajo no se
    // ejecutaba NUNCA: código muerto publicando un diagnóstico falso. Quien leyera
    // esa traza se iría a buscar en su contrato un `pattern` que no existe, que es
    // peor que no decirle nada. Ahora el corte por profundidad lanza y se reporta
    // por lo que es.
    if (contienePattern(schema, 0)) {
      return { applied: false, reason: "schema has a pattern; no witness can be synthesised to prove the round trip" };
    }
    derivado = derivar(schema, 0);
  } catch (err) {
    return { applied: false, reason: err instanceof RangeError ? "schema too deep or cyclic" : "schema could not be compacted" };
  }
  if (derivado.renamed === 0 && derivado.coded === 0) {
    return { applied: false, reason: "nothing to compact (no renameable keys, no codeable enums)" };
  }

  const nodo = derivado.node;
  if (!nodo) return { applied: false, reason: "nothing to compact" };

  const compactar = (v: unknown): unknown => transformar(v, nodo, true);
  const expandir = (v: unknown): unknown => transformar(v, nodo, false);

  // --- Verjas 1 y 2: reversibilidad y admisibilidad -------------------------
  const witnesses = testigosDe(schema);
  const veredicto = verificarTestigos(schema, derivado.compact, nodo, witnesses);
  if (!veredicto.ok) return { applied: false, reason: veredicto.reason };

  // --- Verjas 3 y 4: dinero ponderado por precio, y evidencia ---------------
  const schemaTokensOriginal = countTokens(JSON.stringify(schema));
  const schemaTokensCompact = countTokens(JSON.stringify(derivado.compact));
  // Lo que adelgaza el bloque `response_format`, que viaja en la ENTRADA.
  // Positivo = el esquema compacto ahorra tokens de entrada. Se tarifa a la
  // tarifa de entrada, y ahí esta cuenta se equivoca por ARRIBA en un caso que
  // conviene tener presente: si el contrato cae dentro del prefijo que el
  // proveedor sirve de su caché, esos tokens se facturan al 50 % (OpenAI) o al
  // 10 % (Anthropic), así que el ahorro real es menor. Se deja sin corregir
  // porque aquí no se sabe si habrá acierto —eso lo decide la verja de prefijo,
  // más tarde y con su propia medición—, pero consta que este lado es el
  // permisivo: si aun así la verja se niega, se niega de sobra.
  const ahorroEsquema = schemaTokensOriginal - schemaTokensCompact;

  // El ahorro de FORMA, sobre el peor testigo: los mismos datos con menos
  // símbolos. Con un array el testigo lleva un solo elemento, así que queda por
  // debajo de lo que ahorraría una respuesta con la lista llena.
  //
  // YA NO DECIDE. Es la mitad que se puede modelar de una resta cuyas dos
  // mitades importan, y la que falta —cuánto CONTENIDO de más escribe el modelo
  // al ver nombres cortos— tiene el signo contrario y, medida, el doble de
  // tamaño. Se publica para que un rechazo se pueda leer: «la forma ahorraba 7 y
  // el contenido costó 16» explica el rechazo; «ahorro modelado 7» lo escondía.
  let ahorroDeForma = Number.POSITIVE_INFINITY;
  for (const t of witnesses) {
    const delta = countTokens(JSON.stringify(t)) - countTokens(JSON.stringify(compactar(t)));
    if (delta < ahorroDeForma) ahorroDeForma = delta;
  }
  if (!Number.isFinite(ahorroDeForma)) ahorroDeForma = 0;

  const dolaresDeEntrada = (t: number): number => (t / 1000) * precio.inputPer1k;
  const dolaresDeSalida = (t: number): number => (t / 1000) * precio.outputPer1k;
  const suelo = dolaresDeEntrada(minimo);

  // EL DELTA DE EQUILIBRIO: a partir de cuántos tokens de salida deja de pagar.
  //     ahorroEsquema·pEntrada + delta·pSalida  ≥  minimo·pEntrada
  //     delta ≥ (minimo − ahorroEsquema) · pEntrada / pSalida
  // Sale casi siempre NEGATIVO, y leído en voz alta es la frase que resume la
  // palanca: «paga mientras el delta de salida no baje de N». Sobre el contrato
  // de triaje del banco y la tarifa de la familia 4o, N = −5,25: el +3 medido en
  // `gpt-4o` lo supera de sobra y el −16 de `gpt-4o-mini` se queda a 3x. Ahí se
  // ve que el margen es más estrecho que la variación que hay que predecir, y de
  // ahí sale la verja 4. Con una tarifa de salida de 0 (no existe hoy, pero un catálogo de
  // cliente puede traerla) la división no significa nada y el equilibrio es que
  // no hay riesgo de salida que valga: −Infinity.
  const equilibrio =
    precio.outputPer1k > 0
      ? ((minimo - ahorroEsquema) * precio.inputPer1k) / precio.outputPer1k
      : Number.NEGATIVE_INFINITY;
  const equilibrioLegible = Number.isFinite(equilibrio) ? equilibrio.toFixed(1) : "any";
  const razonDePrecio =
    precio.inputPer1k > 0 ? `${(precio.outputPer1k / precio.inputPer1k).toFixed(1)}x` : "more than";

  const evidencia = opts.evidencia;
  if (evidencia == null) {
    // LA VERJA 4. No es prudencia excesiva ni miedo: es que la cantidad que
    // decide no está en el esquema, está en el modelo. El motivo lleva el número
    // que hay que medir y el umbral que tiene que batir, para que quien lo lea
    // sepa exactamente qué hacer para encenderla.
    return {
      applied: false,
      reason:
        `no measured output delta for this model, so the codebook is not applied. Short field names ` +
        `change how much the model WRITES, and that is a property of the model, not of the schema: ` +
        `${LO_QUE_SE_MIDIO}. Here the compact contract saves ${ahorroEsquema} input tokens and output ` +
        `is billed ${razonDePrecio} input, so it only pays while the output delta stays above ` +
        `${equilibrioLegible} tokens. Measure yours (benchmarks/ab-live.ts) and pass it in`,
    };
  }
  const medido = evidencia.deltaTokens;

  // UN DELTA NEGATIVO APAGA, y no se le deja comprar con el ahorro de esquema.
  // La aritmética sola volvería a aplicar en cuanto un contrato ahorrara
  // 8 + |delta|·(salida/entrada) tokens de entrada —72 con el −16 medido—, y ese
  // contrato es justamente uno grande, con respuestas más largas, donde la
  // pérdida de salida sería MAYOR que la medida. El ahorro de entrada está
  // acotado por el esquema; la pérdida de salida escala con la respuesta.
  if (medido < 0) {
    return {
      applied: false,
      reason:
        `the measured output delta is ${medido} tokens: this model writes MORE from a compact ` +
        `contract (${evidencia.procedencia}). The input win is capped by the size of the schema ` +
        `while the output loss grows with the answer and is billed ${razonDePrecio} input, so no ` +
        `schema is big enough to buy it back`,
    };
  }

  const neto = dolaresDeEntrada(ahorroEsquema) + dolaresDeSalida(medido);
  const netoEnTokensDeEntrada =
    precio.inputPer1k > 0 ? (neto * 1000) / precio.inputPer1k : ahorroEsquema;
  // El signo del delta se explica EN EL PROPIO MOTIVO. Es la cifra que decide y
  // se lee en un panel sin el JSDoc al lado; un signo que hay que ir a buscar a
  // la documentación es un signo que alguien va a interpretar al revés.
  const deltaLegible =
    `+${medido} tokens (${medido > 0 ? "the model wrote LESS" : "no measured change"}), ` +
    `${evidencia.procedencia}`;
  if (neto < suelo) {
    return {
      applied: false,
      reason:
        `net saving $${neto.toFixed(9)}/request is below the floor of ${minimo} input tokens ` +
        `($${suelo.toFixed(9)}): the compact contract saves ${ahorroEsquema} input tokens and the ` +
        `measured output delta is ${deltaLegible}; break-even at ${equilibrioLegible}`,
    };
  }

  return {
    applied: true,
    reason:
      `net saving $${neto.toFixed(9)}/request (${netoEnTokensDeEntrada.toFixed(1)} input tokens ` +
      `equivalent): the compact contract saves ${ahorroEsquema} input tokens and the measured ` +
      `output delta is ${deltaLegible}; break-even at ${equilibrioLegible}`,
    plan: {
      compactSchema: derivado.compact,
      expand: expandir,
      compact: compactar,
      renamedKeys: derivado.renamed,
      codedEnumValues: derivado.coded,
      schemaTokensOriginal,
      schemaTokensCompact,
      modelledShapeSavingTokens: ahorroDeForma,
      measuredOutputDeltaTokens: medido,
      outputDeltaProvenance: evidencia.procedencia,
      breakEvenOutputDeltaTokens: equilibrio,
      netSavingUsd: neto,
    },
  };
}

// --- verjas 1 y 2 -----------------------------------------------------------

/** Veredicto de `verificarTestigos`: el motivo solo existe cuando hay rechazo. */
export type VeredictoTestigos = { ok: true } | { ok: false; reason: string };

/**
 * Las verjas de REVERSIBILIDAD y ADMISIBILIDAD, sobre los testigos sintéticos.
 *
 * POR QUÉ ES UNA FUNCIÓN SUELTA Y EXPORTADA, que es lo único que la hace
 * comprobable. Con la derivación correcta estas dos verjas NO SE ALCANZAN desde
 * `planOutputCodebook`: los guardias por nodo (`usados`, el de ambigüedad, el de
 * `minLength`) cortan antes todos los caminos que las harían morder. Medido: con
 * la comprobación incrustada en el bucle de `planOutputCodebook`, sustituir
 * cualquiera de las dos condiciones por `if (false)` dejaba la suite ENTERA en
 * verde (1077/1077). Es decir, la red de la que cuelga la afirmación de que el
 * codebook es lossless no estaba comprobada, y un cambio futuro en `transformar`
 * o en `derivar` que rompiera el round-trip se publicaría en silencio: el cliente
 * recibiría —y cachearía 24 h— datos distintos de los que generó el modelo, sin
 * que nada pareciera un error. Como función pura se le puede pasar un `node`
 * ROTO a mano (un mapa inverso que no es el inverso, un esquema compacto cuyo
 * `required` no case) y ejercitar el camino de RECHAZO. Ver
 * `test/codebook-de-salida.test.ts`.
 *
 * EL ORDEN ES PARTE DEL CONTRATO, y por testigo: primero que el testigo cumpla
 * el esquema del PROPIO llamante —si no, compararlo contra el compacto no
 * demuestra nada y el fallo puede estar en su contrato y no aquí—, luego la
 * admisibilidad del compactado, y por último el round-trip.
 *
 * `node` y `compactSchema` tienen que ser los que produjo `derivar` PARA
 * `schema`: la función no los deriva, los AUDITA.
 */
export function verificarTestigos(
  schema: JsonSchema,
  compactSchema: JsonSchema,
  node: CodebookNode,
  witnesses: readonly unknown[],
): VeredictoTestigos {
  for (const t of witnesses) {
    if (!validateAgainstSchema(t, schema).valid) {
      return { ok: false, reason: "synthesised witness does not satisfy the caller's own schema; nothing can be proven" };
    }
    const c = transformar(t, node, true);
    // ADMISIBILIDAD: el compactado tiene que validar contra el esquema que viaja
    // al proveedor. Sin esto, un `required` o un `enum` mal reescritos viajan
    // como contrato y el proveedor rechaza la petición entera.
    if (!validateAgainstSchema(c, compactSchema).valid) {
      return { ok: false, reason: "compact witness does not validate against the compact schema" };
    }
    // REVERSIBILIDAD: `expand(compact(t)) === t`. Aquí es donde se cae un mapa
    // inverso que no es el inverso, que es el fallo que devuelve datos plausibles
    // y equivocados en vez de un error.
    if (!igualEnProfundidad(transformar(c, node, false), t)) {
      return { ok: false, reason: "round trip is not the identity" };
    }
  }
  return { ok: true };
}

// --- derivación ------------------------------------------------------------

interface Derivado {
  compact: JsonSchema;
  node?: CodebookNode;
  renamed: number;
  coded: number;
}

function esObjeto(schema: JsonSchema): boolean {
  return schema.type === "object" || (schema.type == null && schema.properties != null);
}

function esArray(schema: JsonSchema): boolean {
  return schema.type === "array" || (schema.type == null && schema.items != null);
}

function enumDeCadenas(schema: JsonSchema): string[] | null {
  const e = schema.enum;
  if (!e || e.length === 0 || e.length > ENUM_MAXIMO) return null;
  if (!e.every((v) => typeof v === "string")) return null;
  return e as string[];
}

function derivar(schema: JsonSchema, prof: number): Derivado {
  if (prof > PROFUNDIDAD_MAXIMA) throw new RangeError("schema too deep");

  const valores = enumDeCadenas(schema);
  if (valores) {
    // `minLength` sobre un enum codificado es la trampa: los códigos son más
    // CORTOS que los valores, así que un mínimo de longitud que el original
    // cumplía deja de cumplirse y el esquema compacto describe algo imposible.
    // Ese enum se queda como está en vez de tumbar el codebook entero.
    if (schema.minLength != null) return { compact: schema, renamed: 0, coded: 0 };
    const fwd = asignarCodigos(valores, true);
    if (!fwd) return { compact: schema, renamed: 0, coded: 0 };
    // Un mapa que resulta ser la identidad entera (valores ya de un carácter) no
    // codifica nada: dejarlo pasar contaría como palanca aplicada algo que no
    // cambia un solo token.
    const cambiados = [...fwd].filter(([orig, code]) => orig !== code).length;
    if (cambiados === 0) return { compact: schema, renamed: 0, coded: 0 };
    const back = new Map<string, string>();
    for (const [orig, code] of fwd) back.set(code, orig);
    return {
      compact: { ...schema, enum: valores.map((v) => fwd.get(v)!) },
      node: { enumFwd: fwd, enumBack: back },
      renamed: 0,
      coded: cambiados,
    };
  }

  if (esObjeto(schema)) return derivarObjeto(schema, prof);
  if (esArray(schema)) return derivarArray(schema, prof);
  return { compact: schema, renamed: 0, coded: 0 };
}

function derivarObjeto(schema: JsonSchema, prof: number): Derivado {
  const entradas = Object.entries(schema.properties ?? {});
  if (entradas.length === 0) return { compact: schema, renamed: 0, coded: 0 };

  let renamed = 0;
  let coded = 0;
  const hijos = new Map<string, CodebookNode>();
  const compactadas = new Map<string, JsonSchema>();
  for (const [clave, sub] of entradas) {
    const d = derivar(sub, prof + 1);
    compactadas.set(clave, d.compact);
    if (d.node) hijos.set(clave, d.node);
    renamed += d.renamed;
    coded += d.coded;
  }

  // Renombrar SOLO con el objeto cerrado. Con `additionalProperties` abierto el
  // modelo puede devolver claves que el esquema no declara, y entonces expandir
  // es adivinar: una clave desconocida podría ser un código nuestro o una clave
  // literal del modelo, y no hay forma de distinguirlas. Sin esa certeza la
  // reversión deja de ser demostrable, así que ese nodo conserva sus claves.
  // (El lint del registro de esquemas ya empuja a cerrar los objetos; aquí eso
  // además compra compresión de salida.)
  let fwd: Map<string, string> | null = null;
  if (schema.additionalProperties === false) {
    fwd = asignarCodigos(entradas.map(([k]) => k), false);
  }

  const propsCompactas: Record<string, JsonSchema> = {};
  for (const [clave] of entradas) {
    propsCompactas[fwd?.get(clave) ?? clave] = compactadas.get(clave)!;
  }

  const compact: JsonSchema = { ...schema, properties: propsCompactas };
  if (schema.required) compact.required = schema.required.map((r) => fwd?.get(r) ?? r);

  const nodo: CodebookNode = {};
  if (fwd) {
    const back = new Map<string, string>();
    for (const [orig, code] of fwd) back.set(code, orig);
    // Un mapa que resulta ser la identidad entera (todas las claves ya eran de
    // un carácter) no es un renombre: no se cuenta ni se guarda.
    let algunoCambia = false;
    for (const [orig, code] of fwd) if (orig !== code) algunoCambia = true;
    if (algunoCambia) {
      nodo.keysFwd = fwd;
      nodo.keysBack = back;
      for (const [orig, code] of fwd) if (orig !== code) renamed += 1;
    }
  }
  if (hijos.size > 0) nodo.props = hijos;

  const vacio = !nodo.keysFwd && !nodo.props;
  return { compact, ...(vacio ? {} : { node: nodo }), renamed, coded };
}

function derivarArray(schema: JsonSchema, prof: number): Derivado {
  if (!schema.items) return { compact: schema, renamed: 0, coded: 0 };
  const d = derivar(schema.items, prof + 1);
  return {
    compact: { ...schema, items: d.compact },
    ...(d.node ? { node: { items: d.node } } : {}),
    renamed: d.renamed,
    coded: d.coded,
  };
}

/**
 * Asigna un código corto a cada nombre. Devuelve `null` cuando el resultado no
 * sería reversible.
 *
 * DETERMINISMO. Se recorre en orden LEXICOGRÁFICO, no en el orden en que estén
 * escritas las propiedades: dos esquemas con el mismo contenido escrito en
 * distinto orden tienen que producir los mismos códigos, o el prefijo estable
 * que la caché del proveedor necesita se rompe en cada despliegue.
 *
 * AMBIGÜEDAD. Si un código coincide con el nombre ORIGINAL de OTRO miembro, el
 * mapa deja de ser interpretable: al recibir ese texto no se sabe si el modelo
 * quiso decir el código o el nombre literal. Ahí se devuelve `null` y ese nodo
 * se queda sin comprimir, que es lo único honesto que se puede hacer.
 */
function asignarCodigos(nombres: string[], mayusculas: boolean): Map<string, string> | null {
  const ordenados = [...nombres].sort();
  const usados = new Set<string>();
  const mapa = new Map<string, string>();
  ordenados.forEach((nombre, i) => {
    const base = mayusculas ? nombre.toUpperCase() : nombre;
    let codigo = nombre;
    for (let n = 1; n < nombre.length; n++) {
      const c = base.slice(0, n);
      if (!usados.has(c)) {
        codigo = c;
        break;
      }
    }
    if (codigo === nombre) {
      const posicional = i.toString(36);
      if (posicional.length < nombre.length && !usados.has(posicional)) codigo = posicional;
    }
    usados.add(codigo);
    mapa.set(nombre, codigo);
  });

  const originales = new Set(nombres);
  for (const [orig, code] of mapa) {
    if (code !== orig && originales.has(code)) return null;
  }
  return mapa;
}

// --- transformación de valores ---------------------------------------------

/**
 * Aplica el mapa a un valor. `haciaCompacto` elige la dirección.
 *
 * TOTAL A PROPÓSITO: lo que llega por aquí en producción es lo que devolvió el
 * modelo, que puede no tener la forma prometida. Cualquier cosa que no encaje se
 * devuelve tal cual — nunca se lanza — para que el fallo lo diagnostique el
 * validador de la etapa 11 con su mensaje, y no una excepción sin contexto que
 * acabaría en el fail-open abriendo una segunda llamada pagada.
 */
function transformar(value: unknown, node: CodebookNode, haciaCompacto: boolean): unknown {
  const enumMapa = haciaCompacto ? node.enumFwd : node.enumBack;
  if (enumMapa && typeof value === "string") {
    // Un valor que no está en el mapa se deja pasar: si el modelo devolvió el
    // nombre largo en vez del código, esa respuesta sigue siendo la correcta y
    // reescribirla a ciegas sí la rompería.
    return enumMapa.get(value) ?? value;
  }

  if (node.items && Array.isArray(value)) {
    return value.map((v) => transformar(v, node.items!, haciaCompacto));
  }

  const claves = haciaCompacto ? node.keysFwd : node.keysBack;
  if ((claves || node.props) && esObjetoLlano(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const destino = claves?.get(k) ?? k;
      // Los hijos se indexan por la clave ORIGINAL, sea cual sea la dirección.
      const original = haciaCompacto ? k : destino;
      const hijo = node.props?.get(original);
      out[destino] = hijo ? transformar(v, hijo, haciaCompacto) : v;
    }
    return out;
  }

  return value;
}

function esObjetoLlano(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- testigos --------------------------------------------------------------

/**
 * Instancias sintéticas del esquema ORIGINAL con las que se prueba la reversión.
 *
 * Una sola no basta: con un solo testigo cada enum se ejercitaría con un único
 * valor y un código mal asignado a los demás pasaría la verja sin que nadie lo
 * tocara. Se genera una ronda por posición de enum, de modo que TODO valor de
 * TODO enum aparece en algún testigo.
 *
 * Exportada para que los tests de `verificarTestigos` usen los testigos DE
 * VERDAD y no unos escritos a mano: si esta síntesis dejara de cubrir todos los
 * valores de un enum, esos tests tienen que enterarse.
 */
export function testigosDe(schema: JsonSchema): unknown[] {
  const rondas = Math.min(ENUM_MAXIMO, Math.max(1, mayorEnum(schema, 0)));
  const out: unknown[] = [];
  for (let i = 0; i < rondas; i++) out.push(testigo(schema, i, 0));
  return out;
}

function mayorEnum(schema: JsonSchema, prof: number): number {
  if (prof > PROFUNDIDAD_MAXIMA) return 0;
  let mayor = schema.enum?.length ?? 0;
  for (const sub of Object.values(schema.properties ?? {})) {
    mayor = Math.max(mayor, mayorEnum(sub, prof + 1));
  }
  if (schema.items) mayor = Math.max(mayor, mayorEnum(schema.items, prof + 1));
  return mayor;
}

function testigo(schema: JsonSchema, indiceEnum: number, prof: number): unknown {
  if (prof > PROFUNDIDAD_MAXIMA) return null;
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[Math.min(indiceEnum, schema.enum.length - 1)];
  }
  if (esObjeto(schema)) {
    const obj: Record<string, unknown> = {};
    // TODAS las propiedades declaradas, no solo las `required`: una clave
    // opcional también se renombra, así que también hay que demostrarla.
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      obj[k] = testigo(sub, indiceEnum, prof + 1);
    }
    return obj;
  }
  if (esArray(schema)) {
    if (schema.maxItems === 0) return [];
    const n = Math.max(1, schema.minItems ?? 1);
    const total = schema.maxItems != null ? Math.min(n, schema.maxItems) : n;
    const item = schema.items;
    return Array.from({ length: total }, () => (item ? testigo(item, indiceEnum, prof + 1) : null));
  }
  switch (schema.type) {
    case "string": {
      if (schema.maxLength === 0) return "";
      const minimo = Math.max(1, schema.minLength ?? 1);
      const largo = schema.maxLength != null ? Math.min(minimo, schema.maxLength) : minimo;
      return "x".repeat(largo);
    }
    case "number":
    case "integer": {
      let v = schema.minimum ?? 1;
      if (schema.maximum != null && v > schema.maximum) v = schema.maximum;
      return schema.type === "integer" ? Math.round(v) : v;
    }
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      // Un nodo sin tipo ni palabras clave no restringe nada, así que cualquier
      // valor sirve de testigo.
      return null;
  }
}

/**
 * ¿Hay un `pattern` en algún sitio? Lanza `RangeError` al pasarse de profundidad,
 * que es lo que corta un esquema cíclico. Devolver `true` ahí —como hacía antes—
 * también cortaba, pero mentía sobre el motivo: ver la nota de `planOutputCodebook`.
 */
function contienePattern(schema: JsonSchema, prof: number): boolean {
  if (prof > PROFUNDIDAD_MAXIMA) throw new RangeError("schema too deep");
  if (schema.pattern != null) return true;
  for (const sub of Object.values(schema.properties ?? {})) {
    if (contienePattern(sub, prof + 1)) return true;
  }
  if (schema.items && contienePattern(schema.items, prof + 1)) return true;
  return false;
}

/** Igualdad estructural sobre el modelo de datos de JSON. */
function igualEnProfundidad(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!igualEnProfundidad(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!igualEnProfundidad((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}
