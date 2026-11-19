import { describe, it, expect } from "vitest";
import {
  createDefaultResolvers,
  createSavingsLayer,
  OpenAICompatibleProvider,
  ToolSelector,
} from "../src/index.js";
import { canonicalize, buildExactKey, buildInflightKey, normalizeText } from "../src/canonicalization/index.js";
import { keyTokensMatch } from "../src/cache/index.js";
import { evaluatePolicy } from "../src/policy/index.js";
import type {
  SavingsRequest,
  ToolDescriptor,
} from "../src/index.js";

/**
 * LA CLAVE DE CACHÉ FALLABA POR UN SIGNO DE INTERROGACIÓN.
 *
 * En la medición del 2026-08-13 (51 peticiones, A/B contra el contador del
 * proveedor) la caché exacta aportó CERO llamadas evitadas. Una de las causas es
 * la normalización del texto: «¿Cuál es el total?» y «cual es el total» daban dos
 * hashes distintos, así que en español y en catalán —donde la tilde y la
 * interrogación de apertura las pone quien escribe despacio y las omite quien
 * escribe rápido— la caché no acertaba nunca.
 *
 * Este fichero tiene DOS mitades y la segunda es la que importa. La primera
 * comprueba que los casi-duplicados triviales por fin colisionan. La segunda
 * comprueba que los que NO deben colisionar siguen sin hacerlo: una caché que
 * normaliza de más no ahorra, contesta OTRA pregunta, y lo hace con una respuesta
 * bien formada que el cliente no tiene forma de ver venir. Por cada par que se
 * junta hay aquí un par vecino que no puede juntarse.
 */

const MODELO = "openai/gpt-4o-mini";
const CONTEXTO = { tenantId: "acme", sessionId: "u-1" } as const;

function peticion(texto: string, extra: Partial<SavingsRequest> = {}): SavingsRequest {
  return {
    model: MODELO,
    messages: [{ role: "user", content: texto }],
    context: { ...CONTEXTO },
    ...extra,
  };
}

function clave(texto: string, extra: Partial<SavingsRequest> = {}): string {
  return buildExactKey(canonicalize(peticion(texto, extra)));
}

// Pares que ANTES eran dos claves y ahora son una. Cada uno es una variación que
// el autor del texto no eligió (caja, espaciado, tipografía del teclado) o que no
// cambia lo que se pregunta.
const CASI_DUPLICADOS: ReadonlyArray<readonly [string, string, string]> = [
  ["¿Cuál es el total de la factura?", "cual es el total de la factura", "es: tilde + ¿?"],
  // A2-3 (2026-11-19): la CLAVE ya solo pliega la inicial del turno. Estas dos
  // filas decían «IVA ≡ iva» y «¡Traduce esto…! ≡ traduce esto…»; la primera
  // unía siglas con palabras («5 MW» con «5 mW» por la misma regla) y la segunda
  // es una petición de traducción, que ahora va tal cual (A2-31). Lo que se
  // pierde está escrito más abajo, en «el coste que la clave acepta».
  ["  El   IVA   está   incluido.  ", "el IVA esta incluido", "es: espacios, inicial, punto final"],
  ["¡Dime el total, por favor!", "dime el total por favor", "es: ¡! y coma"],
  ["¿Cómo estás?", "como estas", "es: solo tildes y signos"],
  ["Quin és l'import d'aquest mes?", "quin es l'import d'aquest mes", "ca: accents"],
  ["Com s'escriu «col·legi»?", 'com s\'escriu "col.legi"', "ca: ela geminada i cometes baixes"],
  ["L’import de la factura", "l'import de la factura", "ca: apòstrof tipogràfic del mòbil"],
  ["coŀlegi major", "col·legi major", "ca: la ŀ de un solo carácter (NFKC)"],
  ["Ｃｕáｎｔｏ ｅｓ ｅｌ ｔｏｔａｌ", "cuanto es el total", "NFKC: ancho completo"],
  ["dime el «total»", 'dime el "total"', "comillas de dos familias"],
  ["¿Es un buen precio — o no?", "es un buen precio - o no", "raya tipográfica"],
  ["cafe´ con leche", "café con leche", "es: la tilde suelta que deja el teclado"],
  ["¿cuánto es ½ de 10?", "cuanto es 1/2 de 10", "NFKC destapa la barra de fracción"],
];

// Pares VECINOS que no pueden compartir clave jamás. Son los cuatro ejes en los
// que un cuasi-duplicado deja de serlo: cifras, fechas, negación y entidades, más
// los tres sitios donde una normalización descuidada rompe un dato.
const PARES_PELIGROSOS: ReadonlyArray<readonly [string, string, string]> = [
  ["el total de la factura 118", "el total de la factura 119", "cifra: un dígito"],
  ["el precio es 3.14 euros", "el precio es 314 euros", "cifra: el punto decimal NO es adorno"],
  ["el precio es 1.234,56 euros", "el precio es 1.23456 euros", "cifra: separador de miles"],
  ["el tren de las 12:30", "el tren de las 1230", "hora: los dos puntos separan"],
  // El «;» es Shift+«,» y el «:» es Shift+«.» en el teclado español: son teclas
  // vecinas, así que «12;30» es la hora escrita deprisa. Se iba sin mirar a los
  // vecinos y fusionaba las cifras igual que lo habría hecho el «:».
  ["el tren de las 12;30", "el tren de las 1230", "hora: el punto y coma del teclado"],
  // El decimal sin entero. Sin la guarda, «.5» se queda en «5» y la clave
  // promete medio euro donde el texto decía cinco.
  ["el precio es .5 euros", "el precio es 5 euros", "cifra: el decimal sin entero"],
  // Las pulgadas escritas con el signo tipográfico correcto (prima doble, «″»),
  // que NFKC parte en dos primas simples antes de que la tabla lo vea.
  ["una pantalla de 5″", "una pantalla de 5'", "unidad: el prima doble son pulgadas"],
  ["cuanto es 2·3", "cuanto es 23", "cifra: el punto volado multiplica"],
  ["la reunión del 20/07/2026", "la reunion del 21/07/2026", "fecha: un día"],
  ["el precio incluye IVA", "el precio no incluye IVA", "es: negación"],
  ["el preu inclou IVA?", "el preu no inclou IVA?", "ca: negació"],
  ["la capital de Dakota del Norte", "la capital de dakota del sur", "entidad"],
  ["quina és la capital del Rosselló", "quina es la capital del Valles", "ca: entitat"],
  ['una pantalla de 5"', "una pantalla de 5'", "unidad: pulgadas contra pies"],
  ["cuanto es 3! + 2", "cuanto es 3 + 2", "el factorial es una operación"],
  ["cuanto es (2+3)*4", "cuanto es 2+3*4", "los paréntesis agrupan"],
];

// De los peligrosos, los cuatro ejes que la caché semántica también tiene que
// rechazar por su cuenta. `keyTokensMatch` es la guarda determinista que ya vive
// bajo el embedding; el criterio de esta normalización es el suyo, así que las
// dos puertas tienen que cerrarse ante el mismo par.
const PELIGROSOS_TAMBIEN_PARA_LA_SEMANTICA = [
  "cifra: un dígito",
  "cifra: el punto decimal NO es adorno",
  "cifra: el punto volado multiplica",
  "hora: los dos puntos separan",
  "hora: el punto y coma del teclado",
  "fecha: un día",
  "es: negación",
  "ca: negació",
  "entidad",
  "ca: entitat",
];

describe("la clave de caché deja de fallar por un signo de interrogación", () => {
  it.each(CASI_DUPLICADOS)("«%s» ≡ «%s» (%s)", (a, b) => {
    expect(normalizeText(a)).toBe(normalizeText(b));
    expect(clave(a)).toBe(clave(b));
  });

  it("y el mismo texto normalizado también coalesce en vuelo (misma puerta, mismo criterio)", () => {
    const a = buildInflightKey(canonicalize(peticion("¿Cuál es el total de la factura?")));
    const b = buildInflightKey(canonicalize(peticion("cual es el total de la factura")));
    expect(a).toBe(b);
  });
});

describe("⛔ lo que NO puede colisionar", () => {
  it.each(PARES_PELIGROSOS)("«%s» ≠ «%s» (%s)", (a, b) => {
    expect(normalizeText(a)).not.toBe(normalizeText(b));
    expect(clave(a)).not.toBe(clave(b));
  });

  it.each(
    PARES_PELIGROSOS.filter(([, , motivo]) => PELIGROSOS_TAMBIEN_PARA_LA_SEMANTICA.includes(motivo)),
  )("la guarda semántica también los separa: «%s» / «%s» (%s)", (a, b) => {
    expect(keyTokensMatch(normalizeText(a), normalizeText(b))).toBe(false);
  });

  it("una marca que no es un adorno no se toca: fuera del alfabeto latino se conserva", () => {
    // En devanagari la matra no decora la letra, es la vocal. Plegar toda marca
    // combinante —en vez de solo la que va sobre base a-z— convertiría «मैं» en
    // «म» y juntaría palabras distintas de un idioma que no sabemos leer.
    expect(normalizeText("मैं")).not.toBe(normalizeText("मै"));
    expect(normalizeText("मैं")).toBe("मैं");
  });

  it("el resolver aritmético sigue declinando lo que no sabe calcular", () => {
    // Si la normalización se comiera el «!», el resolver leería «3! + 2» como
    // «3 + 2» y contestaría 5 sin llamar a nadie: una respuesta inventada
    // apuntada como ahorro.
    const resolvers = createDefaultResolvers();
    expect(resolvers.try(canonicalize(peticion("cuanto es 3! + 2")))).toBeNull();
    expect(resolvers.try(canonicalize(peticion("¿Cuánto es 2 + 2?")))?.text).toBe("4");
    expect(resolvers.try(canonicalize(peticion("cuanto es (2+3)*4")))?.text).toBe("20");
  });

  it("tampoco calcula nada cuando el separador de una lista desaparece", () => {
    // El «;» separa listas en las hojas de cálculo en español. Si la
    // normalización se lo come, «cuánto es 1;2;3» le llega al resolver como
    // «cuánto es 123» y contesta «123» sin llamar a nadie: una respuesta
    // fabricada aquí y apuntada como llamada evitada. Es el mismo fallo que
    // evita la guarda del «!», por otra tecla.
    const resolvers = createDefaultResolvers();
    expect(resolvers.try(canonicalize(peticion("cuanto es 1;2;3")))).toBeNull();
    expect(resolvers.try(canonicalize(peticion("cuanto es 2;3")))).toBeNull();
  });
});

describe("⛔ el aislamiento no depende del texto", () => {
  it("dos inquilinos con la MISMA pregunta siguen en claves distintas", () => {
    const a = clave("¿Cuál es el total?", { context: { tenantId: "acme", sessionId: "u-1" } });
    const b = clave("cual es el total", { context: { tenantId: "otra", sessionId: "u-1" } });
    expect(normalizeText("¿Cuál es el total?")).toBe(normalizeText("cual es el total"));
    expect(a).not.toBe(b);
  });

  it("dos personas del mismo inquilino tampoco se juntan por escribir igual", () => {
    const a = clave("¿Cuál es el total?", { context: { tenantId: "acme", sessionId: "u-1" } });
    const b = clave("cual es el total", { context: { tenantId: "acme", sessionId: "u-2" } });
    expect(a).not.toBe(b);
  });
});

describe("los guardarraíles de política sobreviven a la normalización", () => {
  /**
   * Los marcadores de `policy.ts` son lo único que apaga la caché para una
   * pregunta personalizada o sensible al tiempo cuando el integrador no pasa
   * `sessionId`. Están escritos como pares «acentuado|sin acentuar», así que
   * plegar tildes los deja intactos —pero borrar apóstrofos mataría
   * «aujourd'hui», y plegar solo las vocales dejaría «dostępność» en un
   * «dostepnośc» que no casa con ninguna de las dos ramas—. Cada línea de aquí
   * abajo es uno de esos filos.
   */
  const PERSONALES: ReadonlyArray<readonly [string, string]> = [
    ["es", "¿Cuál es el saldo de mi cuenta?"],
    ["ca", "Quin és el meu compte?"],
    ["de", "Wie hoch ist mein Kontostand?"],
    ["pl", "Jakie jest moje zamówienie?"],
    ["tr", "Faturam nerede? Hesabım kapandı mı?"],
    ["vi", "Số dư của tôi là bao nhiêu?"],
  ];
  const FRESCOS: ReadonlyArray<readonly [string, string]> = [
    ["es", "¿Cuál es la cotización actual?"],
    ["ca", "Quin és el preu d'avui?"],
    ["fr", "Quel temps fait-il aujourd'hui ?"],
    ["pl", "Jaka jest dostępność?"],
    ["tr", "Güncel fiyat nedir?"],
    ["vi", "Giá hôm nay là bao nhiêu?"],
  ];

  it.each(PERSONALES)("[%s] sigue viéndose como personalizada", (_idioma, texto) => {
    expect(evaluatePolicy(canonicalize(peticion(texto))).isPersonalized).toBe(true);
  });

  it.each(FRESCOS)("[%s] sigue viéndose como sensible al tiempo", (_idioma, texto) => {
    expect(evaluatePolicy(canonicalize(peticion(texto))).requiresFreshData).toBe(true);
  });
});

describe("⛔ lo que lee el texto normalizado no se queda mudo", () => {
  /**
   * `normalizedText` no alimenta solo la clave: el selector de herramientas
   * compara contra él los `intents` que escribe el CLIENTE, sin normalizar. En
   * cuanto el texto se pliega y el intent no, un intent con tilde deja de casar y
   * la herramienta se descarta. Eso no cuesta un acierto de caché: el proveedor
   * no ve la capacidad, el modelo contesta «claro, lo envío», no se envía nada y
   * el libro lo apunta como ahorro (`actualTools: 0`). Es el fallo que el
   * comentario de `router.ts` ya documenta reproducido por otra vía.
   */
  // El intent es de UNA palabra a propósito. Con «envío de factura» el test pasa
  // igual sin arreglar nada: al fallar la coincidencia completa, el selector cae
  // al reparto por palabras y «factura» —sin tilde— rescata la herramienta con
  // media puntuación. Una sola palabra acentuada no tiene quién la rescate, que
  // es el caso que de verdad deja la palanca muda.
  const ENVIAR: ToolDescriptor = { id: "enviar", intents: ["envío"], risk: "write" };
  const TEXTO = "envía el envío de hoy";

  it("una herramienta con el intent acentuado sigue seleccionándose", () => {
    const c = canonicalize(peticion(TEXTO, { tools: [ENVIAR] }));
    const seleccion = new ToolSelector().select(c.normalizedText, [ENVIAR], "TOOL_ACTION");
    expect(seleccion.tools.map((t) => t.id)).toEqual(["enviar"]);
    expect(seleccion.droppedIds).toEqual([]);
  });

  it("y también cuando el llamante pasa el texto en crudo", () => {
    // `select` es superficie pública: nada obliga a que el texto llegue ya
    // normalizado. Si solo se pliega el intent, un llamante que pase el texto tal
    // cual se queda con el mismo agujero al revés.
    const seleccion = new ToolSelector().select(TEXTO, [ENVIAR], "TOOL_ACTION");
    expect(seleccion.tools.map((t) => t.id)).toEqual(["enviar"]);
  });

  it("un intent que al plegarse se queda vacío no casa con todo", () => {
    // La guarda vive en la PODA POR RELEVANCIA, que ahora solo aplica a las de
    // LECTURA: una write en TOOL_ACTION se conserva incondicionalmente, porque es
    // la acción que pide la petición y su intent casa pocas veces (ver
    // tool-selector-no-poda-escrituras.test.ts). Así que «un intent vacío no casa
    // con todo» se prueba donde la puntuación sigue decidiendo: una READ cuyo
    // intent se pliega a vacío no debe casar vía `includes("")` y colarse en cada
    // petición, sino quedar podada.
    const vacio: ToolDescriptor = { id: "comodin", intents: ["¿?"], risk: "read" };
    // Con `maxTools`: sin él (0.4.33) no hay poda por relevancia que probar.
    const seleccion = new ToolSelector({ maxTools: 8 }).select(
      normalizeText("¿cuál es el total?"),
      [vacio],
      "TOOL_ACTION",
    );
    expect(seleccion.tools).toEqual([]);
  });
});

describe("la clave declara la generación de su normalización", () => {
  /**
   * El hash no dice cómo se normalizó el texto que lleva dentro. Al cambiar la
   * normalización, las entradas escritas por una versión anterior dejan de poder
   * recalcularse: en una caché viva no se leen nunca más y ocupan sitio hasta que
   * expira su TTL. No es un problema de corrección —dos materiales distintos no
   * dan el mismo sha256— pero sin marca no hay forma de acotarlas ni de vaciarlas
   * por prefijo, ni de que dos versiones del SDK contra el mismo Redis escriban
   * en espacios separados durante un despliegue escalonado.
   */
  it("el prefijo lleva generación, y el resto es el sha256 de siempre", () => {
    expect(clave("hola")).toMatch(/^bvsala:exact:n\d+:[0-9a-f]{64}$/);
    expect(buildInflightKey(canonicalize(peticion("hola")))).toMatch(
      /^bvsala:inflight:n\d+:[0-9a-f]{64}$/,
    );
  });
});

describe("el coste que esta normalización acepta, escrito para que nadie lo descubra en producción", () => {
  /**
   * Plegar los diacríticos incluye ñ y ç. «año» y «ano» comparten clave, y
   * «força» y «forca» también. Se acepta porque para que eso sirva una respuesta
   * equivocada hacen falta dos textos IGUALES salvo la tilde, los dos preguntas
   * plausibles y del MISMO principal; el par realista no es ese, es «pregunta
   * bien escrita» contra «la misma sin tildes». Y porque plegar solo las vocales
   * deja marcadores de política muertos en polaco.
   *
   * Si algún día se decide lo contrario, este test cae y obliga a decirlo en voz
   * alta en vez de cambiarlo de refilón.
   */
  it("«el año pasado» y «el ano pasado» comparten clave — es deliberado", () => {
    expect(clave("el año pasado")).toBe(clave("el ano pasado"));
  });

  it("«la força» y «la forca» también", () => {
    expect(clave("quina és la força")).toBe(clave("quina es la forca"));
  });
});

describe("⛔ N1 · la caché no contesta OTRA pregunta de código", () => {
  /**
   * Auditoría del 2026-11-19. La normalización de prosa, aplicada a código,
   * unía preguntas distintas: borraba `!`, `?.` y el `.` de un identificador o
   * de una regex, y bajaba a minúsculas lo entrecomillado. Quien preguntaba por
   * `if (ok)` recibía la respuesta de `if (!ok)`, apuntada como llamada evitada.
   * Todos los textos son inventados.
   */
  const PARES_DE_CODIGO: ReadonlyArray<readonly [string, string, string]> = [
    ["What does `if (!ok) return;` do in JavaScript?", "What does `if (ok) return;` do in JavaScript?", "negación entre backticks"],
    ["Is the expression a != b true when a is 1 and b is 2?", "Is the expression a = b true when a is 1 and b is 2?", "!= frente a ="],
    ["should I write if (!listo) here", "should I write if (listo) here", "negación sin backticks"],
    ["Explain the regex ^a.b$ briefly", "Explain the regex ^ab$ briefly", "el punto de una regex"],
    ["What does obj?.name return when obj is null?", "What does obj.name return when obj is null?", "encadenamiento opcional"],
    ["what is user.id here", "what is userid here", "el punto de un identificador"],
    ["Is the string 'ABC' equal to the string 'abc' in Python?", "Is the string 'abc' equal to the string 'abc' in Python?", "caja entre comillas simples"],
    ['does grep "Error" match the same lines as grep "error"', 'does grep "error" match the same lines as grep "error"', "caja entre comillas dobles"],
    ["what does `SELECT Nombre FROM t` return", "what does `select nombre from t` return", "caja entre backticks"],
    ["explain `a.b`", "explain `ab`", "punto entre backticks"],
    ["what prints print('abc')", "what prints print(abc)", "cadena frente a variable"],
    ["call f(a,b) or not", "call f(ab) or not", "la coma de una lista de argumentos"],
    ["explica:\n```py\nif x:\n    y = 1\n```", "explica:\n```py\nif x:\ny = 1\n```", "la sangría dentro de un bloque"],
    ["explica:\n```js\nif (!A) b()\n```", "explica:\n```js\nif (a) b()\n```", "un bloque de código"],
    ["what is !!x in js", "what is x in js", "doble negación"],
  ];

  it.each(PARES_DE_CODIGO)("«%s» ≠ «%s»  (%s)", (a, b) => {
    expect(normalizeText(a)).not.toBe(normalizeText(b));
    expect(clave(a)).not.toBe(clave(b));
  });

  // La otra mitad: lo que es prosa sigue colisionando aunque lleve los mismos signos.
  const PROSA_QUE_SIGUE_JUNTA: ReadonlyArray<readonly [string, string]> = [
    ["¿Cuál es el total?", "cual es el total"],
    // A2-3: la mayúscula que no abre el turno ya no se pliega en la clave
    // («Really», «World», «Bye» antes sí): estas filas la llevan igual a los dos lados.
    ["Wait, what?! Really...", "wait what Really"],
    ["Hello, World. Bye;", "hello World Bye"],
    ["¿Qué hace `ls -la`?", "que hace `ls -la`"],
    ["Nota: revisa el pedido (¿seguro?).", "nota revisa el pedido (seguro)"],
    ["l`import de la factura", "l'import de la factura"],
  ];

  it.each(PROSA_QUE_SIGUE_JUNTA)("«%s» ≡ «%s»", (a, b) => {
    expect(clave(a)).toBe(clave(b));
  });

  it("lo que va entre backticks o en un bloque sale tal cual", () => {
    expect(normalizeText("¿Qué hace `If (!Ok) Return;`?")).toBe("que hace `If (!Ok) Return;`");
    expect(normalizeText("Mira:\n```js\nconst A = 1;\n```\n¡Gracias!")).toBe("mira ```js\nconst A = 1;\n``` gracias");
    // Un bloque sin cerrar protege hasta el final.
    expect(normalizeText("Mira:\n```js\nconst A = !B;")).toBe("mira ```js\nconst A = !B;");
  });

  it("los guardarraíles de política siguen viendo el texto entrecomillado", () => {
    // La caja se conserva dentro de las comillas; los marcadores no distinguen caja.
    expect(evaluatePolicy(canonicalize(peticion('¿Qué significa "HOY" aquí?'))).requiresFreshData).toBe(
      evaluatePolicy(canonicalize(peticion('¿Qué significa "hoy" aquí?'))).requiresFreshData,
    );
  });

  it("de capa: la pregunta sin la negación vuelve al proveedor", async () => {
    let llamadas = 0;
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      llamadas += 1;
      const cuerpo = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
      return new Response(
        JSON.stringify({
          model: cuerpo.model,
          choices: [
            { index: 0, message: { role: "assistant", content: `respuesta a: ${cuerpo.messages.at(-1)!.content}` }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const capa = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.test/v1", apiKey: "k-inventada", fetchImpl }),
      silenceWarnings: true,
    });
    const pregunta = (texto: string) => capa.generate({ model: MODELO, messages: [{ role: "user", content: texto }] });

    const conNegacion = await pregunta("What does `if (!ok) return;` do in JavaScript?");
    const sinNegacion = await pregunta("What does `if (ok) return;` do in JavaScript?");
    expect(sinNegacion.report.cache.result).toBe("miss");
    expect(llamadas).toBe(2);
    expect(sinNegacion.text).not.toBe(conNegacion.text);

    // Y la repetición EXACTA sigue acertando: no se ha apagado la caché.
    const repetida = await pregunta("What does `if (ok) return;` do in JavaScript?");
    expect(repetida.report.cache.result).toBe("exact");
    expect(llamadas).toBe(2);
  });

  it("la generación de la clave sube a n3: las entradas viejas no se vuelven a leer", () => {
    expect(clave("hola")).toMatch(/^bvsala:exact:n3:/);
  });
});

describe("⛔ A2-3 · una mayúscula que cambia la pregunta cambia la clave", () => {
  /**
   * Segunda auditoría del 2026-11-19. N1 conservó la caja dentro de comillas y
   * backticks; fuera, todo se pasaba a minúsculas y «What does curl -O do?»
   * servía su respuesta a «What does curl -o do?» durante 24 h, apuntada como
   * llamada evitada. La clave ya solo pliega la inicial del turno. Todos los
   * textos son inventados.
   */
  const PARES: ReadonlyArray<readonly [string, string, string]> = [
    ["What does curl -O do?", "What does curl -o do?", "opción de CLI"],
    ["what does curl -O do", "what does curl -o do", "opción de CLI, sin adornos"],
    ["What does git branch -D do?", "What does git branch -d do?", "opción de CLI: borrado forzado"],
    ["what does tar --Exclude do", "what does tar --exclude do", "opción larga"],
    ["Convert 5 MW to watts", "Convert 5 mW to watts", "unidad: mega frente a mili"],
    ["how many watts are 5 MW", "how many watts are 5 mW", "unidad, sin verbo de conversión"],
    ["How many bytes are 3 Mb?", "How many bytes are 3 MB?", "unidad: bits frente a bytes"],
    ["how long does 5MW take", "how long does 5mW take", "unidad pegada a la cifra"],
    ["Write a regex that matches [A-Z]+ only", "Write a regex that matches [a-z]+ only", "corchetes"],
    ["In Go, is the field Name exported?", "In Go, is the field name exported?", "identificador"],
    ["is NULL the same as null here", "is null the same as null here", "identificador en mayúsculas"],
    ["what is the type of userId", "what is the type of userid", "camelCase"],
    ["what does this do\nName = name.upper()", "what does this do\nname = name.upper()", "código pegado en otra línea"],
    ["I love Polish food", "I love polish food", "nombre propio frente a adjetivo"],
    ["what does `ls` do with -A", "what does `ls` do with -a", "prosa después de un backtick"],
    ["explain `ls` Name", "explain `ls` name", "la palabra tras un backtick no abre el turno"],
  ];

  it.each(PARES)("«%s» ≠ «%s»  (%s)", (a, b) => {
    expect(clave(a)).not.toBe(clave(b));
    expect(buildInflightKey(canonicalize(peticion(a)))).not.toBe(buildInflightKey(canonicalize(peticion(b))));
  });

  it("en una conversación, la mayúscula de un turno anterior también cuenta", () => {
    const con = (texto: string) =>
      buildExactKey(
        canonicalize({
          model: MODELO,
          context: { ...CONTEXTO },
          messages: [
            { role: "user", content: texto },
            { role: "assistant", content: "De acuerdo." },
            { role: "user", content: "y eso qué hace" },
          ],
        }),
      );
    expect(con("hablemos de curl -O")).not.toBe(con("hablemos de curl -o"));
  });

  // Lo que SÍ sigue junto: la inicial del turno, las tildes, los signos de
  // frase y los espacios. Es el acierto que se quería conservar.
  const SIGUEN_JUNTAS: ReadonlyArray<readonly [string, string]> = [
    ["¿Cuál es el total?", "cual es el total"],
    ["What does curl -O do?", "what does curl -O do"],
    ["How many watts are 5 MW?", "how many   watts are 5 MW"],
    ["¡Hola! ¿qué tal?", "hola que tal"],
    ["Él no viene", "el no viene"],
    ["  Dime el total  ", "dime el total"],
  ];

  it.each(SIGUEN_JUNTAS)("«%s» ≡ «%s»", (a, b) => {
    expect(clave(a)).toBe(clave(b));
  });

  it("`normalizedText` no cambia: política, router y selector siguen leyendo minúsculas", () => {
    const c = canonicalize(peticion("What does curl -O do with MW?"));
    expect(c.normalizedText).toBe("user:what does curl -o do with mw");
    expect(c.exactText).toBe("user:what does curl -O do with MW");
  });

  it("una petición canónica hecha a mano, sin `exactText`, sigue teniendo clave", () => {
    const { exactText: _fuera, ...sin } = canonicalize(peticion("hola"));
    expect(buildExactKey(sin)).toBe(clave("hola"));
  });

  it("de capa: «curl -o» no recibe la respuesta de «curl -O», y la repetición exacta acierta", async () => {
    let llamadas = 0;
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      llamadas += 1;
      const cuerpo = JSON.parse(String(init?.body)) as { model: string };
      return new Response(
        JSON.stringify({
          model: cuerpo.model,
          choices: [{ index: 0, message: { role: "assistant", content: `respuesta #${llamadas}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const capa = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.test/v1", apiKey: "k-inventada", fetchImpl }),
      silenceWarnings: true,
    });
    const pregunta = (texto: string) =>
      capa.generate({ model: MODELO, temperature: 0, messages: [{ role: "user", content: texto }] });

    for (const [a, b] of [
      ["What does curl -O do?", "What does curl -o do?"],
      ["Convert 5 MW to watts", "Convert 5 mW to watts"],
      ["Translate to French: I love Polish food", "Translate to French: I love polish food"],
      ["Rewrite formally: Can you help me?", "Rewrite formally: Can you help me!"],
    ] as const) {
      const antes = llamadas;
      const primera = await pregunta(a);
      const segunda = await pregunta(b);
      expect(segunda.report.cache.result, b).toBe("miss");
      expect(segunda.text, b).not.toBe(primera.text);
      expect(llamadas - antes, b).toBe(2);
      const repetida = await pregunta(b);
      expect(repetida.report.cache.result, b).toBe("exact");
      expect(repetida.text, b).toBe(segunda.text);
      expect(llamadas - antes, b).toBe(2);
    }
  });
});

describe("⛔ A2-31 · cuando el texto es el encargo, la clave lo lleva tal cual", () => {
  /**
   * En una traducción o una reescritura la forma del texto es lo que se pide
   * transformar: no hay adorno que plegar. Todos los textos son inventados.
   */
  const PARES: ReadonlyArray<readonly [string, string, string]> = [
    ["Translate to French: I love Polish food", "Translate to French: I love polish food", "traducir: caja"],
    ["Translate to French: Polish food is great", "Translate to French: polish food is great", "traducir: la inicial"],
    ["Rewrite formally: Can you help me?", "Rewrite formally: Can you help me!", "reescribir: el signo final"],
    ["Summarize: The meeting is NOT cancelled", "Summarize: The meeting is not cancelled", "resumir: énfasis"],
    ["Fix the punctuation: hello, world", "Fix the punctuation: hello world", "corregir: la coma"],
    ["Corrige las tildes: el camion esta aqui", "Corrige las tildes: el camión está aquí", "corregir: las tildes"],
    ["Tradúcelo al inglés: ¿Qué tal?", "Tradúcelo al inglés: Qué tal", "traducir en español"],
    ["Fix this python:\nif a:\n  b()\nc()", "Fix this python:\nif a:\n  b()\n  c()", "la sangría sin backticks"],
  ];

  it.each(PARES)("«%s» ≠ «%s»  (%s)", (a, b) => {
    expect(clave(a)).not.toBe(clave(b));
    expect(buildInflightKey(canonicalize(peticion(a)))).not.toBe(buildInflightKey(canonicalize(peticion(b))));
  });

  it("también cuando el encargo está en el system o en un turno anterior", () => {
    const conSystem = (texto: string) =>
      clave(texto, {
        messages: [
          { role: "system", content: "You translate the user's message into French." },
          { role: "user", content: texto },
        ],
      });
    expect(conSystem("Can you help me?")).not.toBe(conSystem("Can you help me!"));
    expect(conSystem("Polish food is great")).not.toBe(conSystem("polish food is great"));

    const conHistorial = (texto: string) =>
      clave(texto, {
        messages: [
          { role: "user", content: "Rewrite formally whatever I send next." },
          { role: "assistant", content: "Understood." },
          { role: "user", content: texto },
        ],
      });
    expect(conHistorial("Can you help me?")).not.toBe(conHistorial("Can you help me!"));
  });

  it("la repetición exacta comparte clave, con los espacios de alrededor recortados", () => {
    expect(clave("Translate to French: I love Polish food")).toBe(clave("  Translate to French: I love Polish food\n"));
  });
});

describe("el coste que la clave acepta desde A2-3 y A2-31, escrito para que nadie lo descubra en producción", () => {
  /**
   * Plegar menos pierde aciertos de casi-duplicado. Se acepta: un acierto
   * perdido cuesta una llamada; un acierto de más contesta otra pregunta. Si
   * algún día se decide volver a juntar alguno de estos, este test cae y obliga
   * a decirlo en voz alta.
   */
  it.each([
    ["el IVA esta incluido", "el iva esta incluido", "siglas"],
    ["HOLA QUE TAL", "hola que tal", "todo en mayúsculas"],
    ["la capital de Francia", "la capital de francia", "nombre propio en minúsculas"],
    ["¡Traduce esto, por favor!", "traduce esto por favor", "una traducción ya no pliega signos"],
    ["Convert 10 km to miles", "Convert 10 km to miles.", "una conversión ya no pliega el punto final"],
  ])("«%s» y «%s» ya no comparten clave (%s)", (a, b) => {
    expect(clave(a)).not.toBe(clave(b));
  });
});

describe("⛔ N1 · normalizar no para el hilo con un texto raro", () => {
  /**
   * Revisión del arreglo N1 (2026-11-19). Buscar las citas con una sola regex
   * `abre…cierra` y medir cada racha de signos desde cada uno de sus signos era
   * cuadrático: 20.000 comillas sin pareja en una línea tardaban 2,3 s, 50.000
   * puntos seguidos 1,4 s, y 200.000 de cualquiera de los dos más de veinte
   * segundos, con el hilo parado. El texto lo escribe el usuario final del
   * cliente, y `normalizeText` corre en cada petición antes de mirar la caché.
   *
   * El tope es holgado a propósito (la versión lineal tarda milisegundos): no
   * mide velocidad, distingue lineal de cuadrático.
   */
  const TOPE_MS = 3_000;
  const TEXTOS_RAROS: ReadonlyArray<readonly [string, string]> = [
    ["comillas dobles que abren y ninguna cierra", '"a '.repeat(70_000)],
    ["comillas simples que abren y ninguna cierra", "'a ".repeat(70_000)],
    ["backticks sueltos (el apóstrofo mal tecleado)", "`a ".repeat(70_000)],
    ["una racha larga de puntos", `a${".".repeat(200_000)}b`],
    ["una racha larga de exclamaciones", "!".repeat(200_000)],
    ["una racha larga de dos puntos pegada a una letra", `${":".repeat(200_000)}x`],
  ];

  it.each(TEXTOS_RAROS)("%s: 200.000 caracteres en tiempo lineal", (_nombre, texto) => {
    const t0 = performance.now();
    normalizeText(texto);
    expect(performance.now() - t0).toBeLessThan(TOPE_MS);
  });

  // A2-3 y A2-31: el texto de la CLAVE (la inicial del turno y la detección de
  // «transforma su texto») corre en cada petición por el mismo camino.
  it.each([
    ...TEXTOS_RAROS,
    ["espacios y saltos antes de la primera palabra", `${" \n¿¡".repeat(50_000)}Hola`],
    ["una palabra larguísima en mayúscula inicial", `A${"a".repeat(200_000)}`],
    ["casi-verbos de transformación repetidos", "translat_ fix_ resum_ ".repeat(10_000)],
  ] as ReadonlyArray<readonly [string, string]>)("la clave entera · %s", (_nombre, texto) => {
    const t0 = performance.now();
    buildExactKey(canonicalize(peticion(texto)));
    expect(performance.now() - t0).toBeLessThan(TOPE_MS);
  });

  // Y las citas siguen siendo las mismas: qué abre, qué cierra y qué no cruza.
  const CITAS: ReadonlyArray<readonly [string, string]> = [
    ['say "Hola Mundo" twice', 'say Hola Mundo twice'],
    ["say 'Hola Mundo' twice", "say Hola Mundo twice"],
    ['"A" and "B"', "A and B"],
    ['x="ABC"', 'x="ABC"'],
    ["print('ABC')", "print('ABC')"],
    ["Don't SHOUT 'Now'", "don't shout Now"],
    ['"ABIERTA y sin cerrar', "abierta y sin cerrar"],
    ['"NO CRUZA\nDE LINEA"', "no cruza de linea"],
    ['"ACABA EN ESPACIO " aqui', "acaba en espacio aqui"],
    ["'UNA' \"DOS\" 'tres", "UNA DOS tres"],
    ["\"UNA 'DENTRO' de otra\"", "UNA DENTRO de otra"],
    ['"" VACIA', "vacia"],
  ];

  it.each(CITAS)("«%s» → «%s»", (texto, esperado) => {
    expect(normalizeText(texto)).toBe(esperado);
  });
});

describe("⛔ N1 · el selector de herramientas no se queda mudo con código marcado", () => {
  /**
   * Revisión del arreglo N1 (2026-11-19). Desde que `normalizeText` copia tal
   * cual lo que va entre backticks, «Look up the `Invoice` for Bob» conserva la
   * mayúscula y un intent `invoice` dejaba de casar: con `maxTools`, la
   * herramienta de lectura se podaba y el modelo no la veía. La clave de caché
   * necesita esa exactitud; puntuar la relevancia de una herramienta, no.
   */
  const FACTURA: ToolDescriptor = { id: "factura", intents: ["Invoice"], risk: "read" };
  const ENVIO: ToolDescriptor = { id: "envio", intents: ["envío"], risk: "read" };
  const RELLENO: ToolDescriptor[] = [0, 1, 2].map((i) => ({ id: `otra-${i}`, intents: [`zzz${i}`], risk: "read" as const }));

  it.each([
    ["Look up the `Invoice` for Bob", FACTURA],
    ['Look up the "INVOICE" for Bob', FACTURA],
    ["Look up the invoice for Bob", FACTURA],
    ["Busca el `Envío` de hoy", ENVIO],
    ["Busca el `ENVIO` de hoy", ENVIO],
  ] as const)("«%s» conserva su herramienta", (texto, herramienta) => {
    for (const entrada of [texto, normalizeText(texto)]) {
      const seleccion = new ToolSelector({ maxTools: 2 }).select(entrada, [herramienta, ...RELLENO], "SINGLE_RETRIEVAL");
      expect(seleccion.tools.map((t) => t.id)).toEqual([herramienta.id]);
    }
  });
});
