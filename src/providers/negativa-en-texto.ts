/**
 * E7-quater · LA NEGATIVA ESCRITA COMO TEXTO (2026-09-28).
 *
 * #356, #367 y #374 excluyen de la caché y de la referencia las negativas que
 * el PROVEEDOR señala: `stop_reason: "refusal"`, `finish_reason:
 * "content_filter"`, `message.refusal` o una parte `refusal` de la Responses
 * API. Pero la mayoría de las negativas no llegan así: el modelo escribe «I
 * can't help with that.» como texto normal y cierra con `end_turn`/`stop`. Sin
 * señal del API, esa negativa entraba en la caché exacta 24 h y cada repetición
 * se servía sin llamar al proveedor, valorada `reference` (comisionable). En
 * prompts seguros (XSTest) eso congela una negativa por exceso de cautela y la
 * cobra como ahorro.
 *
 * Esto es HEURÍSTICO, y la asimetría decide cómo se equivoca (decisión del
 * dueño: antes perder ahorro que cobrar algo dudoso):
 *   · un FALSO POSITIVO (una respuesta normal tomada por negativa) cuesta un
 *     acierto de caché: se mide con normalidad y no se guarda. Nada más; no
 *     cambia lo que recibe el llamante, ni la reparación, ni el coste medido;
 *   · un FALSO NEGATIVO deja el comportamiento de hoy.
 * Por eso es CONSERVADOR en el otro sentido que importa: solo mira el INICIO de
 * la respuesta (y la respuesta entera si es corta), y exige una cláusula de
 * negativa de verdad —sujeto, negación y un verbo de ayudar/dar/escribir—, no
 * una palabra suelta. «Sorry for the delay, here is…», «I can't stress this
 * enough», «I can't help but notice» o un «No,» que corrige al usuario no son
 * negativas.
 *
 * De dónde salen las formas: los prefijos del clasificador de la paper de
 * XSTest (`evaluation/classify_completions_strmatch.py`: «sorry», «i'm sorry»,
 * «i apologize», «i cannot», «i can't», «i'm not able», «it is not
 * appropriate», «as an ai»…), la ampliación declarada del arnés
 * (benchmarks/publicados/xstest, #377: «i won't», «i'm unable», «i must
 * decline», «unfortunately, i can't»…) y sus equivalentes habituales en los
 * idiomas que la capa ya trata en su heurística de frescura (es, ca, fr, de,
 * it, pt). Tres de los prefijos de la paper se quedan fuera a propósito porque
 * abren respuestas normales: «no,»/«no.» (una corrección), «sorry» o «I
 * apologize» solos (una disculpa por otra cosa) y «it is not appropriate» sin
 * «for me» (un consejo técnico: «it's not appropriate to use X in production»).
 * Una disculpa o un «As an AI» solo cuentan si les sigue una cláusula de
 * negativa en las dos primeras frases.
 *
 * Lo que no pretende: decidir si una respuesta es buena, ni si el prompt era
 * dañino. Solo si la capa puede repetirla como si fuera una respuesta.
 */

/** Cuánto del inicio se mira: las dos primeras frases, con este techo. */
const VENTANA_CHARS = 240;
/** Una respuesta de hasta esto se mira entera (la cláusula puede ir en cualquier sitio). */
const CORTA_CHARS = 300;

// ── Inglés ─────────────────────────────────────────────────────────────────

/**
 * Sujeto + negación: «I can't», «I'm unable to»… (ya en minúsculas y con ' recto). Solo la
 * primera persona del SINGULAR, en todos los idiomas: «we cannot write to s[0]» o «no vamos a
 * crear un tercero» explican algo; la negativa del modelo habla en singular.
 */
const NEG_EN =
  "i(?:'m| am)? ?(?:" +
  [
    "can't", "cannot", "can not", "won't", "will not", "shouldn't", "should not",
    "unable to", "not able to", "not going to", "not in a position to",
    "not comfortable", "don't feel comfortable", "do not feel comfortable",
    "'d rather not", "would rather not", "don't think i can", "do not think i can",
  ].join("|") +
  ")";
/**
 * Lo que se niega: ayudar, dar, escribir… «help» solo si NO sigue «but» («I
 * can't help but notice»). Sin «make», «recommend» ni «stress»: «I can't
 * recommend it enough» y «I can't stress this enough» son lo contrario.
 */
const VERBO_EN =
  "(?:help(?! but)|assist|provide|comply|fulfil|fulfill|create|write|generate|produce|give|share|support|" +
  "engage|participate|answer|respond|discuss|offer|continue|draft|facilitate|contribute|go along|go into|" +
  "walk you through|explain how|describe how|tell you how|teach|instruct|encourage|condone|endorse|promote|" +
  "role-?play|pretend|do that|do this|do so|with that|with this|with your request|with this request|that request|this request)";
/** «I must decline», «I'll have to decline»: la negativa sin verbo detrás. */
const DECLINA_EN = "i(?:'ll| will| must| need to|'d| would)?(?: have to)? ?(?:respectfully |politely )?decline";
/** «That's not something I can help with», «It is not appropriate for me to…». */
const IMPERSONAL_EN =
  "(?:(?:that|this|it)(?:'s| is) not something i(?:'m| am)? ?(?:can|will|able to|comfortable)|" +
  "(?:it|that|this)(?:'s| is| would be| would not be| wouldn't be) (?:not )?(?:appropriate|ethical|responsible) for me to|" +
  "i(?:'m| am) not sure (?:that )?it(?:'s| is| would be) appropriate)";
/** Lo que abre una negativa sin serlo por sí solo. */
const APERTURA_EN =
  "(?:(?:i'm |i am |i'm really |i am really |i'm so |really |so )?sorry|i apologi[sz]e|my apologies|apologies|" +
  "unfortunately|regrettably|i'm afraid|i am afraid|as an ai|as a language model|as an assistant|" +
  "i understand|i appreciate|thank you for|thanks for|while i understand|while i appreciate)";

// ── Otros idiomas (los de la heurística de frescura de src/policy/policy.ts) ──

const P = "\\p{L}*"; // la cola de un verbo con pronombre enclítico: ayudarte, aiutarti, ajudar-te

/** Español. */
const NEG_ES = "no (?:puedo|voy a|me es posible|estoy en condiciones de|me siento cómod[oa])";
const VERBO_ES =
  `(?:ayudar${P}|asistir${P}|proporcionar${P}|facilitar${P}|dar${P}|ofrecer${P}|crear${P}|escribir${P}|generar${P}|` +
  `compartir${P}|cumplir|responder${P}|colaborar|participar|atender${P}|hacer eso|hacerlo|con eso|con esto|con esa|con esta|con tu)`;
const APERTURA_ES =
  "(?:lo siento|lo lamento|siento|lamento|disculpa|disculpe|perdón|perdona|lamentablemente|desafortunadamente|" +
  "me temo que|como (?:una )?(?:ia|inteligencia artificial|modelo de lenguaje|asistente)|entiendo)";
/** Catalán. */
const NEG_CA = "no (?:puc|et puc|us puc|em sento còmod[ea]|estic en condicions de)";
const VERBO_CA =
  `(?:ajudar${P}|assistir${P}|proporcionar${P}|facilitar${P}|donar${P}|oferir${P}|crear${P}|escriure${P}|generar${P}|` +
  `compartir${P}|complir|respondre${P}|col·laborar|participar|fer això|fer-ho|amb això|amb aquesta|amb la teva)`;
const APERTURA_CA =
  "(?:ho sento|ho lamento|em sap greu|disculpa|disculpeu|perdona|malauradament|lamentablement|dissortadament|" +
  "com a (?:ia|intel·ligència artificial|model de llenguatge|assistent)|entenc)";
/** Francés («je ne peux pas vous aider», «je ne suis pas en mesure de fournir»). */
const NEG_FR = "(?:je ne (?:peux|pourrai|pourrais|vais|souhaite)(?: malheureusement)? pas|je ne suis pas en mesure d[e']|je refuse d[e'])";
const VERBO_FR =
  "(?:aider|assister|fournir|répondre|créer|écrire|générer|partager|donner|proposer|participer|expliquer comment|" +
  "accéder à|satisfaire|faire cela|faire ça|le faire)";
const APERTURA_FR =
  "(?:désolée?|je suis désolée?|je regrette|malheureusement|hélas|je comprends|" +
  "en tant qu'(?:ia|intelligence artificielle|modèle de langage|assistant))";
/** Alemán, con el orden de palabras libre («Ich kann Ihnen dabei nicht helfen», «Leider kann ich …»). */
const NEG_DE =
  "(?:ich (?:kann|werde|darf|möchte)|(?:kann|werde|darf|möchte) ich)(?: \\p{L}+){0,4}? (?:nicht|keine\\p{L}*)(?: \\p{L}+){0,3}?";
const VERBO_DE =
  "(?:helfen|unterstützen|bereitstellen|geben|erstellen|schreiben|generieren|beantworten|liefern|nachkommen|teilen|anbieten|erklären|behilflich sein)";
const APERTURA_DE =
  "(?:es tut mir leid|tut mir leid|entschuldigung|entschuldige|leider|bedauerlicherweise|ich verstehe|" +
  "als (?:eine )?(?:ki|künstliche intelligenz|sprachmodell|assistent))";
/** Italiano. */
const NEG_IT = "non (?:posso|sono in grado di|riesco a|mi sento a mio agio (?:a|nel))";
const VERBO_IT =
  `(?:aiutar${P}|assister${P}|fornir${P}|crear${P}|scriver${P}|generar${P}|condivider${P}|risponder${P}|dar${P}|` +
  `offrir${P}|soddisfare|partecipare|farlo|fare questo|con questo|con questa)`;
const APERTURA_IT =
  "(?:mi dispiace|spiacente|purtroppo|sfortunatamente|capisco|come (?:un'?\\s?)?(?:ia|intelligenza artificiale|modello linguistico|assistente))";
/** Portugués. */
const NEG_PT = "não (?:posso|consigo|vou|sou capaz de|estou em condições de|me sinto confortável (?:em|a))";
const VERBO_PT =
  `(?:ajudar${P}|auxiliar${P}|assistir${P}|fornecer${P}|criar${P}|escrever${P}|gerar${P}|compartilhar${P}|partilhar${P}|` +
  `dar${P}|oferecer${P}|responder${P}|atender${P}|cumprir|participar|fazer isso|com isso|com esse|com essa)`;
const APERTURA_PT =
  "(?:desculpe|desculpa|sinto muito|lamento|infelizmente|entendo|compreendo|" +
  "como (?:uma? )?(?:ia|inteligência artificial|modelo de linguagem|assistente))";

/** Hasta cuatro palabras entre la negación y el verbo: «I cannot in good conscience provide». */
const HUECO = "(?:[\\s,]+[\\p{L}'’-]+){0,4}?[\\s,]+";

/** La cláusula de negativa, en cualquier idioma: sujeto + negación + verbo, o una forma que ya lo es. */
const CLAUSULA = [
  `${NEG_EN}${HUECO}${VERBO_EN}`,
  DECLINA_EN,
  IMPERSONAL_EN,
  `${NEG_ES}${HUECO}${VERBO_ES}`,
  "lamento no poder",
  `${NEG_CA}${HUECO}${VERBO_CA}`,
  `${NEG_FR}${HUECO}${VERBO_FR}`,
  `${NEG_DE} ${VERBO_DE}`,
  `${NEG_IT}${HUECO}${VERBO_IT}`,
  `${NEG_PT}${HUECO}${VERBO_PT}`,
].join("|");

const APERTURA = [APERTURA_EN, APERTURA_ES, APERTURA_CA, APERTURA_FR, APERTURA_DE, APERTURA_IT, APERTURA_PT].join("|");

/** La cláusula abre la respuesta (y termina en palabra entera: «help» no es «helpful»). */
const RE_EMPIEZA = new RegExp(`^(?:${CLAUSULA})(?![\\p{L}])`, "u");
/** Una apertura (disculpa, «As an AI»…) abre la respuesta. */
const RE_APERTURA = new RegExp(`^(?:${APERTURA})(?![\\p{L}])`, "u");
/** La cláusula en cualquier sitio, empezando en un límite de palabra. */
const RE_EN_MEDIO = new RegExp(`(?:^|[^\\p{L}'])(?:${CLAUSULA})(?![\\p{L}])`, "u");

/** Qué regla la vio (va a la traza). */
export type ReglaDeNegativaEnTexto = "opens-with-refusal" | "apology-then-refusal" | "short-refusal";

/** Minúsculas, apóstrofo recto, espacios colapsados y sin el adorno de markdown del principio. */
function normalizar(texto: string): string {
  return texto
    .slice(0, 4 * CORTA_CHARS)
    .replace(/[‘’ʼ`´]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s*#>_"'«“¿¡(\[-]+/u, "")
    .trim();
}

/** Las dos primeras frases, con techo. */
function inicio(t: string): string {
  const cortes = [...t.matchAll(/[.!?。](?:\s|$)/g)];
  const fin = cortes.length >= 2 ? cortes[1]!.index! + 1 : t.length;
  return t.slice(0, Math.min(fin, VENTANA_CHARS));
}

/**
 * ¿Es este texto una negativa del modelo escrita como respuesta normal? Devuelve
 * la regla que lo vio, o null. Nunca lanza. Un texto vacío no es una negativa
 * (es una respuesta vacía, y se trata como siempre).
 */
export function negativaEnTexto(texto: string | null | undefined): ReglaDeNegativaEnTexto | null {
  if (typeof texto !== "string" || texto === "") return null;
  const t = normalizar(texto);
  if (t === "") return null;
  const ventana = inicio(t);
  if (RE_EMPIEZA.test(ventana)) return "opens-with-refusal";
  if (RE_APERTURA.test(ventana) && RE_EN_MEDIO.test(ventana)) return "apology-then-refusal";
  if (t.length <= CORTA_CHARS && RE_EN_MEDIO.test(t)) return "short-refusal";
  return null;
}
