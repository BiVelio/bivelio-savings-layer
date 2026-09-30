import { describe, it, expect } from "vitest";

import { vectorLocal, localEmbedding, LOCAL_EMBEDDING_THRESHOLD } from "../src/cache/embedder-local.js";
import { cosine, keyTokensMatch, InMemorySemanticCache } from "../src/cache/semantic.js";

/**
 * El embebedor local, y sobre todo LO QUE NO PUEDE HACER SOLO.
 *
 * La caché semántica venía con `embed` OBLIGATORIO y sin ninguna implementación
 * en el paquete, así que no se podía construir sin traerse un proveedor de
 * embeddings. Por eso el banco la declaraba «no medible» tirada tras tirada: no
 * es que ahorrase poco, es que nunca llegó a ejecutarse.
 *
 * Un vector léxico es débil A PROPÓSITO, y aquí se fija dónde está el reparto de
 * responsabilidades — que es lo único que hace seguro enchufarlo:
 *
 *   · el EMBEDDING separa lo que se dice con otras palabras;
 *   · la VERJA determinista separa lo que el embedding no puede ver (números,
 *     negación, entidad cambiada) y corre por debajo, siempre.
 *
 * Medido: `pedido 4471` contra `pedido 9912` da cos = 0,778, POR ENCIMA del
 * umbral. El embedding solo no basta, y este fichero lo demuestra en vez de
 * suponerlo.
 */

const sim = (a: string, b: string) => cosine(vectorLocal(a), vectorLocal(b));
/** El guard recibe texto ya normalizado; se replica aquí lo que hace el pipeline. */
const norm = (s: string) =>
  s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const guard = (a: string, b: string) => keyTokensMatch(norm(a), norm(b));

describe("embebedor local — propiedades del vector", () => {
  it("es determinista y está normalizado", () => {
    const v = vectorLocal("cuántos administradores activos hay");
    expect(v).toEqual(vectorLocal("cuántos administradores activos hay"));
    expect(Math.sqrt(v.reduce((n, x) => n + x * x, 0))).toBeCloseTo(1, 10);
  });

  it("un texto vacío no revienta ni finge similitud", () => {
    expect(vectorLocal("").every((x) => x === 0)).toBe(true);
    expect(cosine(vectorLocal(""), vectorLocal("hola"))).toBe(0);
  });

  it("es síncrono y de ancho fijo: no añade await al camino de la petición", () => {
    const r = localEmbedding("hola");
    expect(Array.isArray(r)).toBe(true);
    expect(r).toHaveLength(256);
  });

  it("tokeniza no-latino en vez de colapsarlo en un solo bloque", () => {
    // Sin tokenizar unicode, estos dos serían el mismo vector de un solo rasgo y
    // cualquier texto japonés casaría con cualquier otro.
    expect(sim("配送状況を教えて", "返品したい")).toBeLessThan(0.5);
  });

  it("los bigramas impiden que el ORDEN de las palabras salga gratis", () => {
    expect(sim("¿A causa B?", "¿B causa A?")).toBeLessThan(1);
  });

  it("LIMITACIÓN FIJADA: los acentos NO se pliegan", () => {
    // `cuántos` y `cuantos` son rasgos distintos. Se deja anotado porque es una
    // propiedad real del vector, no un descuido: quien escriba sin acentos
    // pierde el acierto (coste: una llamada), nunca gana una respuesta ajena.
    expect(sim("cuántos administradores hay", "cuantos administradores hay")).toBeLessThan(0.9);
  });
});

describe("embebedor local — el umbral separa lo que SÍ puede separar", () => {
  it("una entidad cambiada cae por debajo del umbral", () => {
    expect(sim("cuántos administradores activos hay", "cuántos usuarios activos hay")).toBeLessThan(
      LOCAL_EMBEDDING_THRESHOLD,
    );
  });

  it("una paráfrasis con relleno se queda por encima", () => {
    expect(
      sim("resume este informe trimestral", "por favor resume este informe trimestral"),
    ).toBeGreaterThanOrEqual(LOCAL_EMBEDDING_THRESHOLD);
  });

  it("EL EMBEDDING SOLO NO BASTA: dos números distintos quedan por ENCIMA del umbral", () => {
    // 0,778 medido. Este es el fallo que un embedding no puede ver, y la razón de
    // que la verja determinista no sea opcional.
    const s = sim("dame el estado del pedido 4471", "dame el estado del pedido 9912");
    expect(s).toBeGreaterThan(LOCAL_EMBEDDING_THRESHOLD);
    // Y por eso la verja lo corta.
    expect(guard("dame el estado del pedido 4471", "dame el estado del pedido 9912")).toBe(false);
  });
});

describe("la verja determinista trata igual a los idiomas que el producto vende", () => {
  // ERA ASIMÉTRICA, y no de forma cosmética: la MISMA paráfrasis pasaba en inglés
  // y se cortaba en castellano, solo porque la lista de stopwords era inglesa.
  // En castellano la cortesía y los artículos contaban como CONTENIDO, así que
  // dos palabras de relleno hundían el Jaccard por debajo del 0,75.
  it("la cortesía no cambia la pregunta, en ninguno de los tres", () => {
    expect(guard("summarize this report", "please summarize this report")).toBe(true);
    expect(guard("resume este informe", "por favor resume este informe")).toBe(true);
    expect(guard("resumeix aquest informe", "sisplau resumeix aquest informe")).toBe(true);
  });

  it("reordenar tampoco", () => {
    expect(guard("capital of france", "france capital")).toBe(true);
  });

  // Y AQUÍ ESTÁ LO QUE NO SE HA AFLOJADO. Añadir stopwords no toca los números ni
  // la negación —se comprueban antes y por separado—, y los temporales,
  // comparativos y aditivos se dejaron FUERA de la lista a propósito.
  it("un número distinto se corta", () => {
    expect(guard("estado del pedido 4471", "estado del pedido 9912")).toBe(false);
  });

  it("una negación se corta", () => {
    expect(guard("el pago se completó", "el pago no se completó")).toBe(false);
  });

  it("una entidad cambiada se corta", () => {
    expect(guard("cuántos administradores activos", "cuántos usuarios activos")).toBe(false);
  });

  it("un COMPARATIVO se corta: «más de 100» no es «menos de 100»", () => {
    expect(guard("pedidos de más de 100", "pedidos de menos de 100")).toBe(false);
  });

  it("un TEMPORAL se corta, y en los dos idiomas por igual", () => {
    // Preguntar «ahora» pide dato fresco. El castellano no puede ser más
    // permisivo que el inglés aquí, que es justo lo que se evitó al podar la lista.
    expect(guard("cuántos admins hay", "cuántos admins hay ahora")).toBe(false);
    expect(guard("how many admins", "how many admins now")).toBe(false);
  });
});

describe("la caché semántica ya se puede construir sin traer nada", () => {
  it("`embed` es opcional y el umbral sigue al embebedor", () => {
    // Sin esto la caché se construiría, no fallaría nada, y no acertaría jamás:
    // un vector léxico no llega al 0,9 que le corresponde a un sentence-transformer.
    expect(() => new InMemorySemanticCache()).not.toThrow();
    expect(LOCAL_EMBEDDING_THRESHOLD).toBeLessThan(0.9);
  });

  it("quien trae el suyo no ve ningún cambio", () => {
    expect(() => new InMemorySemanticCache({ embed: (t) => vectorLocal(t) })).not.toThrow();
  });
});
