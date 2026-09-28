/**
 * LAS CANTIDADES ESCRITAS EN LETRA, como hechos que la verja semántica compara.
 *
 * `numericTokens` solo ve dígitos. Medido sin red sobre el split de test de
 * GSM8K con la 0.4.30 (docs/benchmarks/2026-09-28/gsm8k.md, PR #378): de 564
 * variantes que solo cambian un número en letra o un multiplicador —«three
 * baskets»→«four baskets», «twice»→«three times», «half»→«a third»—, 477
 * recibieron la respuesta de su original. Para la verja, «three» y «four» eran
 * dos palabras de contenido entre veinte: el Jaccard seguía por encima de 0,75 y
 * el multiconjunto numérico, vacío en los dos lados, coincidía.
 *
 * Esta función saca de un texto las cantidades en letra como tokens canónicos, y
 * la verja los exige iguales como multiconjunto, igual que los dígitos:
 *
 *   · `n:<valor>`  cardinal, con compuestos: «twenty-five» → n:25, «one hundred
 *                  and five» → n:105, «treinta y cinco» → n:35, «vint-i-cinc» →
 *                  n:25, «dos mil» → n:2000. Componer importa: con tokens
 *                  sueltos, «one hundred and five» y «five hundred and one» dan
 *                  el mismo multiconjunto {1, 100, 5}.
 *   · `o:<n>`      ordinal O fraccionario de denominador n («third», «thirds»,
 *                  «tercio», «terç»): «third» es las dos cosas en inglés, así que
 *                  se trata igual en los dos usos. Lo que importa es que «third»
 *                  ≠ «fourth» ≠ «half».
 *   · `f:1/2`      mitad («half», «halves», «mitad», «medio», «meitat», «mig»);
 *     `f:1/4`      «quarter(s)» (≠ «fourth», a propósito: ver abajo).
 *   · `m:<n>`      multiplicador: «once», «twice», «thrice», «double», «triple»,
 *                  «quadruple», «single», y un cardinal en letra seguido de
 *                  «times»/«time»/«veces»/«vez»/«vegades»/«vegada»: «three
 *                  times» → m:3, así que «twice» ≡ «two times».
 *   · `c:<n>`      colectivo: «dozen» (12), «pair» (2); «docena», «par»;
 *                  «dotzena», «parell».
 *
 * EL PREFIJO SEPARA ESTOS TOKENS DE LOS DE DÍGITO, y es lo que hace el cambio
 * MONÓTONO: la verja compara `numericTokens(a) ++ cantidadesEnLetra(a)` y los dos
 * trozos no comparten ningún valor posible, así que el multiconjunto unido solo
 * coincide si coinciden los dos por separado. Todo lo que antes se cortaba se
 * sigue cortando; esto solo AÑADE cortes. Por eso «two apples» y «2 apples»
 * siguen sin casar (n:2 contra 2), igual que antes del cambio: se pierde ese
 * acierto a sabiendas, y a cambio nadie tiene que demostrar que este código no
 * abre ninguna puerta que antes estaba cerrada.
 *
 * FALSOS POSITIVOS («one of them», «the first time», «second opinion», «set» en
 * inglés que es 7 en catalán, «media» que es «promedio»). Se DEJAN DENTRO, y es
 * una decisión de coste asimétrico, la misma que la de las negaciones: un token
 * de más solo corta cuando un lado lo tiene y el otro no, y eso ya es una
 * paráfrasis que ha cambiado de palabra; lo peor que hace es negar un acierto
 * (se hace la llamada real). Quitar «first» o «one» de la lista, en cambio,
 * vuelve a dejar pasar «the first day» → «the second day». Y como esas palabras
 * ya eran tokens de CONTENIDO para el Jaccard, su ausencia en un lado ya costaba
 * solapamiento: el corte que se añade es marginal. `test/cantidades-en-letra.test.ts`
 * fija los dos lados: que «one of them» ↔ «one of them» sigue casando, y qué
 * paráfrasis se pierden.
 *
 * Tampoco se pliegan equivalencias que harían falta para acertar más:
 * «quarter» ≠ «fourth», «a third» ≠ «one third», «two times» ≠ «2 times». Cada
 * una es un acierto perdido, ninguna una respuesta equivocada.
 *
 * NO ENTRAN los artículos («a», «an», «un», «una», «u»): son la mitad de las
 * frases y no distinguen cantidades que no distinga ya el resto; y «u» o «un»
 * son palabras vacías en la lista de la verja.
 *
 * Idiomas: inglés, castellano y catalán — los mismos que la lista de palabras
 * vacías y la de negaciones de `semantic.ts`. Los demás locales siguen con solo
 * dígitos. El diccionario es único (sin mirar el locale): «once» es 11 en
 * castellano y «una vez» en inglés, y se canoniza como m:1 en los dos; lo único
 * que eso cambia es con qué otra palabra casa, nunca que dos cantidades
 * distintas en el mismo idioma den el mismo token.
 */

type Clase =
  | { k: "unidad"; v: number } // 0..19 (y las «veinti-»: 21..29, que ya vienen compuestas)
  | { k: "decena"; v: number } // 20, 30 … 90
  | { k: "centena"; v: number } // «ciento», «doscientos», «cent»: centenas ADITIVAS (100..900)
  | { k: "cien" } // «hundred», «cents» (dos-cents): MULTIPLICA lo que va delante
  | { k: "escala"; v: number } // thousand, million, billion, mil, millón…
  | { k: "ordinal"; v: number }
  | { k: "token"; t: string } // fracción, multiplicador o colectivo: token ya canónico
  | { k: "veces" } // times / veces / vegades: convierte el cardinal previo en multiplicador
  | { k: "conector" }; // and / y / i

const DICCIONARIO = new Map<string, Clase>();
function pon(palabras: string, c: Clase): void {
  for (const p of palabras.split(/\s+/).filter(Boolean)) DICCIONARIO.set(p, c);
}

// ── Inglés ──────────────────────────────────────────────────────────────────
const UNIDADES_EN = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
UNIDADES_EN.forEach((p, v) => pon(p, { k: "unidad", v }));
["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"].forEach((p, i) =>
  pon(p, { k: "decena", v: 20 + 10 * i }),
);
pon("hundred hundreds", { k: "cien" });
pon("thousand thousands", { k: "escala", v: 1e3 });
pon("million millions", { k: "escala", v: 1e6 });
pon("billion billions", { k: "escala", v: 1e9 });
const ORDINALES_EN = [
  "", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth",
  "eighteenth", "nineteenth",
];
ORDINALES_EN.forEach((p, v) => {
  if (!p) return;
  pon(p, { k: "ordinal", v });
  // el plural es el fraccionario: «two thirds», «three fifths». «firsts»/«seconds»
  // no: «seconds» es sobre todo la unidad de tiempo, y ya queda «second» dentro.
  if (v >= 3) pon(`${p}s`, { k: "ordinal", v });
});
["twentieth", "thirtieth", "fortieth", "fiftieth", "sixtieth", "seventieth", "eightieth", "ninetieth"].forEach((p, i) => {
  pon(p, { k: "ordinal", v: 20 + 10 * i });
  pon(`${p}s`, { k: "ordinal", v: 20 + 10 * i });
});
pon("hundredth hundredths", { k: "ordinal", v: 100 });
pon("thousandth thousandths", { k: "ordinal", v: 1000 });
pon("millionth millionths", { k: "ordinal", v: 1e6 });
pon("half halves", { k: "token", t: "f:1/2" });
pon("quarter quarters", { k: "token", t: "f:1/4" });
pon("once single", { k: "token", t: "m:1" });
pon("twice double doubled doubles doubling", { k: "token", t: "m:2" });
pon("thrice triple tripled triples tripling", { k: "token", t: "m:3" });
pon("quadruple quadrupled quadruples quadrupling", { k: "token", t: "m:4" });
pon("dozen dozens", { k: "token", t: "c:12" });
pon("pair pairs", { k: "token", t: "c:2" });
pon("times time", { k: "veces" });
pon("and", { k: "conector" });

// ── Castellano (ya sin tildes: la verja pliega los diacríticos antes) ───────
const UNIDADES_ES = [
  "cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
  // «once» (11) NO: choca con el inglés «once» (una vez) y se queda como m:1.
  "", "doce", "trece", "catorce", "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve",
];
UNIDADES_ES.forEach((p, v) => p && pon(p, { k: "unidad", v }));
pon("veinte", { k: "decena", v: 20 });
[
  "veintiuno", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis",
  "veintisiete", "veintiocho", "veintinueve",
].forEach((p, i) => pon(p, { k: "unidad", v: 21 + i }));
["treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"].forEach((p, i) =>
  pon(p, { k: "decena", v: 30 + 10 * i }),
);
pon("cien ciento", { k: "centena", v: 100 });
[
  ["doscientos doscientas", 200], ["trescientos trescientas", 300], ["cuatrocientos cuatrocientas", 400],
  ["quinientos quinientas", 500], ["seiscientos seiscientas", 600], ["setecientos setecientas", 700],
  ["ochocientos ochocientas", 800], ["novecientos novecientas", 900],
].forEach(([p, v]) => pon(p as string, { k: "centena", v: v as number }));
pon("mil miles", { k: "escala", v: 1e3 });
pon("millon millones", { k: "escala", v: 1e6 });
pon("billon billones", { k: "escala", v: 1e12 });
[
  ["primero primera primer primeros primeras", 1], ["segundo segunda segundos segundas", 2],
  ["tercero tercera tercer terceros terceras tercio tercios", 3], ["cuarto cuarta cuartos cuartas", 4],
  ["quinto quinta quintos quintas", 5], ["sexto sexta sextos sextas", 6],
  ["septimo septima septimos septimas", 7], ["octavo octava octavos octavas", 8],
  ["noveno novena novenos novenas", 9], ["decimo decima decimos decimas", 10],
].forEach(([p, v]) => pon(p as string, { k: "ordinal", v: v as number }));
pon("mitad mitades medio media medios medias", { k: "token", t: "f:1/2" });
pon("doble dobles", { k: "token", t: "m:2" });
pon("cuadruple", { k: "token", t: "m:4" });
pon("docena docenas", { k: "token", t: "c:12" });
pon("par pares", { k: "token", t: "c:2" });
pon("veces vez", { k: "veces" });
pon("y", { k: "conector" });

// ── Catalán ─────────────────────────────────────────────────────────────────
[
  ["zero", 0], ["dues", 2], ["quatre", 4], ["cinc", 5], ["sis", 6], ["set", 7], ["vuit", 8], ["nou", 9],
  ["deu", 10], ["onze", 11], ["dotze", 12], ["tretze", 13], ["catorze", 14], ["quinze", 15], ["setze", 16],
  ["disset", 17], ["divuit", 18], ["dinou", 19],
].forEach(([p, v]) => pon(p as string, { k: "unidad", v: v as number }));
["vint", "trenta", "quaranta", "cinquanta", "seixanta", "setanta", "vuitanta", "noranta"].forEach((p, i) =>
  pon(p, { k: "decena", v: 20 + 10 * i }),
);
pon("cent", { k: "centena", v: 100 });
pon("cents centes", { k: "cien" }); // «dos-cents», «tres-centes»
pon("milio milions", { k: "escala", v: 1e6 });
[
  ["segon segona segons segones", 2], ["terc tercos", 3], ["quart quarta quarts quartes", 4],
  ["cinque cinquena", 5], ["sise sisena", 6], ["sete setena", 7], ["vuite vuitena", 8],
  ["nove novena", 9], ["dese desena", 10],
].forEach(([p, v]) => pon(p as string, { k: "ordinal", v: v as number }));
pon("meitat meitats mig mitja", { k: "token", t: "f:1/2" });
pon("dotzena dotzenes", { k: "token", t: "c:12" });
pon("parell parells", { k: "token", t: "c:2" });
pon("vegades vegada", { k: "veces" });
pon("i", { k: "conector" });
// «primer»/«primera», «tercer»/«tercera», «doble», «triple», «mil» ya están (es).

const MARCAS = /\p{M}+/gu;

/** Palabras del texto en minúscula y sin diacríticos; el guion separa («twenty-five»). */
function palabras(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(MARCAS, "")
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
}

/**
 * Las cantidades en letra de `s`, como tokens canónicos (ver el comentario de
 * arriba). Pensada para texto ya normalizado, pero no lo necesita: pliega caja y
 * diacríticos por su cuenta.
 */
export function cantidadesEnLetra(s: string): string[] {
  const out: string[] = [];
  const ps = palabras(s);
  // El número en curso: `total` acumula lo ya cerrado por una escala («dos mil»),
  // `actual` lo que va por debajo de ella. `ultima` es la clase de la palabra
  // anterior del número, que decide si la siguiente compone o empieza otro.
  let activo = false;
  let total = 0;
  let actual = 0;
  let ultima: Clase["k"] | null = null;
  let escalaMin = Infinity; // «thousand million» no compone: las escalas bajan

  const cerrar = (tipo: "n" | "m" = "n") => {
    if (activo) out.push(`${tipo}:${total + actual}`);
    activo = false;
    total = 0;
    actual = 0;
    ultima = null;
    escalaMin = Infinity;
  };
  const empezar = (v: number, k: Clase["k"]) => {
    cerrar();
    activo = true;
    actual = v;
    ultima = k;
  };

  for (let i = 0; i < ps.length; i++) {
    const c = DICCIONARIO.get(ps[i]!);
    if (!c) {
      cerrar();
      continue;
    }
    switch (c.k) {
      case "unidad": {
        // compone tras una decena («twenty five», «treinta y cinco»), tras una
        // centena («one hundred and five», «ciento cinco») o tras una escala
        // («two thousand three»). Dos unidades seguidas son DOS números: «two
        // three-bedroom houses», o «three, four» con la coma ya quitada.
        const compone =
          activo &&
          ((ultima === "decena" && c.v < 10 && actual % 10 === 0) ||
            ((ultima === "cien" || ultima === "centena") && actual % 100 === 0) ||
            ultima === "escala");
        if (compone) {
          actual += c.v;
          ultima = "unidad";
        } else empezar(c.v, "unidad");
        break;
      }
      case "decena": {
        const compone = activo && ((ultima === "cien" || ultima === "centena") && actual % 100 === 0 || ultima === "escala");
        if (compone) {
          actual += c.v;
          ultima = "decena";
        } else empezar(c.v, "decena");
        break;
      }
      case "centena": {
        if (activo && ultima === "escala") {
          actual += c.v;
          ultima = "centena";
        } else empezar(c.v, "centena");
        break;
      }
      case "cien": {
        if (activo && (ultima === "unidad" || ultima === "decena") && actual > 0 && actual < 100) {
          actual *= 100;
          ultima = "cien";
        } else empezar(100, "cien");
        break;
      }
      case "escala": {
        if (activo && ultima !== "escala" && c.v < escalaMin) {
          total += (actual || 1) * c.v;
          actual = 0;
          ultima = "escala";
          escalaMin = c.v;
        } else {
          empezar(0, "escala");
          total = c.v;
          escalaMin = c.v;
        }
        break;
      }
      case "ordinal": {
        // «twenty-first» → o:21; si no, un ordinal suelto cierra lo anterior.
        if (activo && ultima === "decena" && c.v < 10 && actual % 10 === 0) {
          const v = total + actual + c.v;
          activo = false; // el cardinal en curso se consume en el ordinal
          cerrar();
          out.push(`o:${v}`);
        } else {
          cerrar();
          out.push(`o:${c.v}`);
        }
        break;
      }
      case "veces": {
        if (activo) cerrar("m");
        break;
      }
      case "conector": {
        // Solo une si viene detrás de algo que admite continuación y delante de
        // una unidad o decena; si no, es la conjunción de siempre y corta.
        const sig = DICCIONARIO.get(ps[i + 1] ?? "");
        const une =
          activo &&
          (ultima === "decena" || ultima === "cien" || ultima === "centena" || ultima === "escala") &&
          sig != null &&
          (sig.k === "unidad" || sig.k === "decena");
        if (!une) cerrar();
        break;
      }
      case "token": {
        cerrar();
        out.push(c.t);
        break;
      }
    }
  }
  cerrar();
  return out;
}
