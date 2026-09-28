import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cantidadesEnLetra } from "../src/cache/cantidades-en-letra.js";
import { InMemorySemanticCache, keyTokensMatch } from "../src/cache/semantic.js";
import { normalizeText } from "../src/canonicalization/canonicalize.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

/**
 * LA VERJA SEMÁNTICA LEÍA LOS NÚMEROS SOLO EN DÍGITOS.
 *
 * Batería GSM8K sobre la 0.4.30 (PR #378): con la caché semántica tal como se
 * envía, «Amy had two eyeshadow palettes…» y «Amy had three eyeshadow
 * palettes…» eran la misma pregunta para la verja, y la segunda recibió 19 —la
 * respuesta de la primera— cuando la suya es 23. En vivo, 15 de 37 variantes
 * así recibieron la respuesta de otra pregunta; sin red, sobre el split de test
 * entero, 477 de 564.
 *
 * Los pares de abajo son TODAS las evidencias distintas de esa batería, literales.
 * Cada uno pasaba `keyTokensMatch` antes del arreglo (comprobado ejecutando este
 * fichero contra `main`: 26 fallos en el primer bloque).
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/gsm8k-variantes-en-letra.json", import.meta.url), "utf8"),
) as { pares: { original: string; variante: string }[] };

/** Como llega a la verja en producción: mensaje de usuario, normalizado, con su rol. */
const turno = (pregunta: string) => `user:${normalizeText(`Question: ${pregunta}`)}`;

/** La paráfrasis «léxica» del arnés de GSM8K: preámbulo y sinónimos que no tocan cifras. */
function lexica(t: string): string {
  return (
    "Here is a word problem. " +
    t
      .replace(/\bbought\b/g, "purchased")
      .replace(/\bbuys\b/g, "purchases")
      .replace(/\beach\b/g, "every")
      .replace(/\bgets\b/g, "receives")
      .replace(/\bin total\b/g, "altogether")
  );
}

describe("GSM8K: una cantidad en letra distinta es OTRA pregunta", () => {
  it("la batería trae los 26 pares", () => {
    expect(FIXTURE.pares).toHaveLength(26);
  });

  it.each(FIXTURE.pares.map((p) => [p.variante.slice(0, 60), p] as const))(
    "corta: %s…",
    (_n, p) => {
      expect(keyTokensMatch(turno(p.original), turno(p.variante))).toBe(false);
    },
  );

  // El control: la paráfrasis de verdad del MISMO original sigue pasando la verja.
  // Si el arreglo cortara también estas, la caché semántica habría dejado de
  // servir para nada en texto con números en letra.
  //
  // Menos UNO: «A robe takes 2 bolts…» tiene seis palabras de contenido, y las
  // tres del preámbulo («here», «word», «problem») hunden el Jaccard por debajo
  // de 0,75. Lo cortaba igual antes del arreglo; no es cosa de los números.
  const CORTA_POR_JACCARD = "A robe takes 2 bolts";
  it.each(
    FIXTURE.pares.filter((p) => !p.original.startsWith(CORTA_POR_JACCARD)).map((p) => [p.original.slice(0, 60), p] as const),
  )("deja pasar su paráfrasis léxica: %s…", (_n, p) => {
    expect(keyTokensMatch(turno(p.original), turno(lexica(p.original)))).toBe(true);
  });
});

describe("la verja, caso a caso", () => {
  const debeCortar: [string, string][] = [
    ["three baskets of apples", "four baskets of apples"],
    ["he sold twice as many goats", "he sold three times as many goats"],
    ["it takes half as many days by car", "it takes a third as many days by car"],
    ["the recipe needs a dozen eggs", "the recipe needs two dozen eggs"],
    ["one hundred and five tickets were sold", "five hundred and one tickets were sold"],
    ["twenty-five students passed the exam", "twenty-six students passed the exam"],
    ["on the first day of the trip", "on the second day of the trip"],
    ["the twenty-first floor of the building", "the twenty-second floor of the building"],
    ["two thirds of the budget went to salaries", "three fifths of the budget went to salaries"],
    ["a single room for the night", "a double room for the night"],
    ["he bought a pair of shoes", "he bought a dozen shoes"],
    ["the price doubled last year", "the price tripled last year"],
    // castellano
    ["compra tres cajas de manzanas", "compra cuatro cajas de manzanas"],
    ["treinta y cinco alumnos aprobaron", "treinta y seis alumnos aprobaron"],
    ["cuesta el doble que el año pasado", "cuesta el triple que el año pasado"],
    ["la mitad del presupuesto se fue en sueldos", "un tercio del presupuesto se fue en sueldos"],
    ["llamó dos veces al cliente", "llamó tres veces al cliente"],
    ["el tercer piso del edificio", "el cuarto piso del edificio"],
    // catalán
    ["compra tres caixes de pomes", "compra quatre caixes de pomes"],
    ["vint-i-cinc alumnes han aprovat", "vint-i-sis alumnes han aprovat"],
    ["la meitat del pressupost", "un terç del pressupost"],
    ["ha trucat dues vegades al client", "ha trucat tres vegades al client"],
  ];
  it.each(debeCortar)("corta «%s» ↔ «%s»", (a, b) => {
    expect(keyTokensMatch(normalizeText(a), normalizeText(b))).toBe(false);
  });

  // FALSOS POSITIVOS: palabras que son cantidades sin querer serlo («one of
  // them», «the first time», «second opinion»). Se quedan dentro a propósito
  // (ver `cantidades-en-letra.ts`): mientras las dos preguntas las conserven, la
  // verja las ve iguales y no cuesta nada.
  const debePasar: [string, string][] = [
    ["which one of them is cheaper", "which one of them is cheaper please"],
    ["is this the first time the error appears", "is this the first time that the error appears"],
    ["should i get a second opinion on the diagnosis", "please tell me should i get a second opinion on the diagnosis"],
    ["explain the difference between once and twice", "please explain the difference between once and twice"],
    ["por favor dime la mitad de la factura", "dime la mitad de la factura"],
  ];
  it.each(debePasar)("deja pasar «%s» ↔ «%s»", (a, b) => {
    expect(keyTokensMatch(normalizeText(a), normalizeText(b))).toBe(true);
  });

  // LO QUE SE PIERDE A SABIENDAS. Cada línea es un acierto de caché que no se
  // da; ninguna es una respuesta equivocada. Si algún día se quiere ganar
  // alguno, que sea con un test que diga por qué no abre otra puerta.
  const coste: [string, string, string][] = [
    ["la paráfrasis cambia «second» por «another»", "should i get a second opinion", "should i get another opinion"],
    ["«two» y «2» no se igualan: el cambio es monótono", "i have two apples", "i have 2 apples"],
    ["«a quarter» y «a fourth» se leen distinto", "a quarter of the cake", "a fourth of the cake"],
    // aquí el canónico SÍ coincide (m:2 los dos), pero «two» y «times» son dos
    // palabras de contenido más y el Jaccard corta, antes y ahora
    ["«twice» ↔ «two times» en frase corta", "he read the book twice last summer", "he read the book two times last summer"],
  ];
  it.each(coste)("se pierde: %s", (_n, a, b) => {
    expect(keyTokensMatch(normalizeText(a), normalizeText(b))).toBe(false);
  });
});

describe("cantidadesEnLetra — el canónico", () => {
  const casos: [string, string[]][] = [
    ["one hundred and five", ["n:105"]],
    ["five hundred and one", ["n:501"]],
    ["twenty-five apples", ["n:25"]],
    ["two thousand and three", ["n:2003"]],
    // dos unidades seguidas son dos números, no una suma
    ["two three-bedroom houses", ["n:2", "n:3"]],
    ["three times as many", ["m:3"]],
    ["twice as many", ["m:2"]],
    ["half as many", ["f:1/2"]],
    ["a third as many", ["o:3"]],
    ["the twenty-first day", ["o:21"]],
    ["the cat and the dog", []],
    ["treinta y cinco", ["n:35"]],
    ["dos mil trescientos", ["n:2300"]],
    ["ciento cinco", ["n:105"]],
    ["vint-i-cinc", ["n:25"]],
    ["dos-cents", ["n:200"]],
    ["dues vegades", ["m:2"]],
    ["dieciséis", ["n:16"]],
  ];
  it.each(casos)("«%s» → %j", (s, esperado) => {
    expect(cantidadesEnLetra(s)).toEqual(esperado);
  });

  it("no comparte ningún token con los de dígito (por eso el cambio solo añade cortes)", () => {
    for (const s of ["two", "twice", "half", "third", "dozen", "treinta y cinco"]) {
      for (const t of cantidadesEnLetra(s)) expect(t).toMatch(/^[nomfc]:/);
    }
  });
});

describe("de punta a punta: la capa con la caché semántica tal como se envía", () => {
  class ProveedorQueCuenta implements Provider {
    readonly id = "cuenta";
    llamadas = 0;
    async generate(r: ProviderRequest): Promise<ProviderResponse> {
      this.llamadas++;
      const u = [...r.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      return { text: `#### ${String(u).length}`, usage: { inputTokens: 100, outputTokens: 10 }, finishReason: "stop" };
    }
  }
  const PRECIOS = { "openai/gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 } };
  const pedir = (texto: string) => ({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user" as const, content: `Question: ${texto}` }],
    savings: { semanticCache: true as const },
    context: { tenantId: "acme" },
  });

  it("la variante va al proveedor y la paráfrasis sale de la caché", async () => {
    // El par de la petición 175 de gpt-4o-mini: servida 19, la suya era 23.
    const par = FIXTURE.pares.find((p) => p.original.startsWith("Amy had two eyeshadow"))!;
    const proveedor = new ProveedorQueCuenta();
    const capa = createSavingsLayer({
      provider: proveedor,
      costModels: PRECIOS,
      silenceWarnings: true,
      semanticCache: new InMemorySemanticCache(),
    });
    try {
      await capa.generate(pedir(par.original));
      const variante = await capa.generate(pedir(par.variante));
      expect(variante.report.cache.result).not.toBe("semantic");
      expect(proveedor.llamadas).toBe(2);

      const parafrasis = await capa.generate(pedir(lexica(par.original)));
      expect(parafrasis.report.cache.result).toBe("semantic");
      expect(proveedor.llamadas).toBe(2);
    } finally {
      capa.close();
    }
  });
});
