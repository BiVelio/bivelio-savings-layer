import { describe, it, expect } from "vitest";
import {
  canonicalize,
  buildExactKey,
  buildInflightKey,
  normalizeText,
  keyTokensMatch,
  evaluatePolicy,
  createDefaultResolvers,
  ToolSelector,
} from "../src/index.js";
import type { SavingsRequest, ToolDescriptor } from "../src/index.js";

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
  ["  El   IVA   está   incluido.  ", "el iva esta incluido", "es: espacios, caja, punto final"],
  ["¡Traduce esto, por favor!", "traduce esto por favor", "es: ¡! y coma"],
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
    const seleccion = new ToolSelector().select(
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
