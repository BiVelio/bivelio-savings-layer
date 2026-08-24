import { describe, it, expect } from "vitest";

import { CATALOGO, precioDeLista, PRECIOS_AL_DIA } from "../src/pricing/catalogo.js";

/**
 * EL CATÁLOGO DE PRECIOS DE LISTA.
 *
 * POR QUÉ EXISTE. Este producto vende "ahorro que puedes contrastar con tu
 * factura", y hasta ahora había UN precio ilustrativo para todos los modelos: de
 * fábrica, ninguna cifra en dólares se correspondía con ninguna factura.
 *
 * ⚠️ EL RIESGO DE ESTE FICHERO ES EL OPUESTO AL DE NO TENERLO. Un modelo AUSENTE
 * cae en el ilustrativo Y AVISA, así que el cliente sabe que esa columna no vale.
 * Un modelo PRESENTE con el precio mal calla el aviso y entrega una cifra
 * confiada y falsa — el fallo exacto que este producto existe para no cometer.
 *
 * De ahí que estos tests vigilen sobre todo que NO se cuele lo que no toca.
 */

describe("el lookup", () => {
  it("encuentra por id exacto", () => {
    expect(precioDeLista("gpt-4o-mini")).toEqual(CATALOGO["gpt-4o-mini"]);
  });

  it("encuentra con prefijo de proveedor, que es como lo pide el contrato", () => {
    // El SDK documenta ids cualificados (`openai/gpt-4o-mini`), pero la tabla de
    // precios del proveedor usa el nombre desnudo. Los dos tienen que funcionar.
    expect(precioDeLista("openai/gpt-4o-mini")).toEqual(CATALOGO["gpt-4o-mini"]);
    expect(precioDeLista("anthropic/claude-haiku-4-5")).toEqual(CATALOGO["claude-haiku-4-5"]);
    expect(precioDeLista("google/gemini-3.7-flash")).toEqual(CATALOGO["gemini-3.7-flash"]);
  });

  it("una instantánea fechada hereda el precio de su familia", () => {
    // Enumerar cada fecha sería una lista que envejece sola.
    expect(precioDeLista("gpt-4o-2024-08-06")).toEqual(CATALOGO["gpt-4o"]);
    expect(precioDeLista("claude-haiku-4-5-20251001")).toEqual(CATALOGO["claude-haiku-4-5"]);
    expect(precioDeLista("claude-sonnet-4-5-20250929")).toEqual(CATALOGO["claude-sonnet-4"]);
    expect(precioDeLista("gemini-3.5-flash-preview-0715")).toEqual(CATALOGO["gemini-3.5-flash"]);
  });

  it("`claude-opus-4` no se traga a la generación 4.5+, que cuesta un TERCIO", () => {
    // La herencia por prefijo aquí es una mentira de 3x: toda la generación
    // opus-4-5…opus-5 factura $5/$25 y el prefijo `claude-opus-4` la tarifaría
    // a $15/$75 — justo en el tráfico que un gateway `bvsala claude` mide.
    for (const m of ["claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"]) {
      expect(precioDeLista(m), m).toEqual(CATALOGO[m]);
      expect(precioDeLista(m), m).not.toEqual(CATALOGO["claude-opus-4"]);
    }
    // Y la instantánea fechada hereda de SU versión, no de la vieja.
    expect(precioDeLista("claude-opus-4-8-20260115")).toEqual(CATALOGO["claude-opus-4-8"]);
    expect(precioDeLista("anthropic/claude-opus-5")).toEqual(CATALOGO["claude-opus-5"]);
  });

  it("las versiones menores de gpt-5 no se heredan entre sí: el precio SE MUEVE", () => {
    // `.` cuenta como separador, así que sin entrada propia `gpt-5.2` heredaría
    // el precio de `gpt-5` — y cuesta un 40% más. Cada 5.x visible va explícito.
    expect(precioDeLista("gpt-5.2")).toEqual(CATALOGO["gpt-5.2"]);
    expect(precioDeLista("gpt-5.2")).not.toEqual(CATALOGO["gpt-5"]);
    expect(precioDeLista("gpt-5.4")).not.toEqual(CATALOGO["gpt-5"]);
    // Los ids que usa Codex hoy resuelven a su entrada exacta.
    expect(precioDeLista("openai/gpt-5.3-codex")).toEqual(CATALOGO["gpt-5.3-codex"]);
    expect(precioDeLista("gpt-5.1-codex-mini")).toEqual(CATALOGO["gpt-5.1-codex-mini"]);
  });

  it("`gemini-3.5-flash` no se traga a `gemini-3.5-flash-lite`, que cuesta cinco veces menos", () => {
    // Mismo peligro que gpt-4/gpt-4o: la clave corta es prefijo de la larga y
    // solo el orden por longitud impide tarifar el lite a precio del grande.
    expect(precioDeLista("gemini-3.5-flash-lite")).toEqual(CATALOGO["gemini-3.5-flash-lite"]);
    expect(precioDeLista("gemini-3.5-flash-lite")).not.toEqual(CATALOGO["gemini-3.5-flash"]);
  });

  it("`gpt-4` no se traga a `gpt-4o`, que cuesta doce veces menos", () => {
    // Aquí lo que protege es el ORDEN por longitud —`gpt-4o` se prueba antes que
    // `gpt-4`— no la guarda de separador. Se deja escrito porque es el caso que
    // más caro sale si alguien reordena esa lista: 0,03/1K en vez de 0,0025.
    expect(precioDeLista("gpt-4o")).toEqual(CATALOGO["gpt-4o"]);
    expect(precioDeLista("gpt-4o")).not.toEqual(CATALOGO["gpt-4"]);
    expect(precioDeLista("gpt-4o-mini")).not.toEqual(CATALOGO["gpt-4"]);
    expect(precioDeLista("gpt-4-turbo")).toEqual(CATALOGO["gpt-4-turbo"]);
  });

  it("⛔ un nombre que SIGUE con letras no hereda: exige separador", () => {
    // Esto sí es la guarda, y una mutación demostró que el test anterior NO la
    // probaba: con `startsWith` a secas, un modelo futuro llamado `gpt-4omni` o
    // `claude-haiku-4-5x` heredaría el precio de otra familia en silencio. El
    // catálogo tiene que decir "no lo conozco" y dejar que salte el aviso.
    for (const m of ["gpt-4omni", "gpt-4oX", "claude-haiku-4-5x", "gpt-4turbo"]) {
      expect(precioDeLista(m), m).toBeUndefined();
    }
    // Y con separador sí hereda, que es para lo que existe.
    expect(precioDeLista("gpt-4o-2024-08-06")).toEqual(CATALOGO["gpt-4o"]);
  });

  it("⛔ un modelo desconocido devuelve undefined, NO un precio inventado", () => {
    // Devolver algo aquí callaría el aviso del pipeline, que es la única señal
    // que tiene el cliente de que esa columna no es su factura.
    for (const m of ["modelo-que-no-existe", "llama-3", "gemini-2.0-flash", "", "gpt", "claude"]) {
      expect(precioDeLista(m)).toBeUndefined();
    }
  });
});

describe("la forma del catálogo", () => {
  it("todo precio es positivo y la salida cuesta más que la entrada", () => {
    // No es una ley física, pero se cumple en todos los proveedores que cubrimos,
    // y un valor invertido es el síntoma de haber copiado mal la columna.
    for (const [modelo, p] of Object.entries(CATALOGO)) {
      expect(p.inputPer1k, modelo).toBeGreaterThan(0);
      expect(p.outputPer1k, modelo).toBeGreaterThan(0);
      expect(p.outputPer1k, modelo).toBeGreaterThan(p.inputPer1k);
    }
  });

  it("⛔ la entrada cacheada siempre es MÁS BARATA que la normal", () => {
    // Si fuera al revés, el "ahorro" por caché del proveedor saldría negativo y
    // el panel enseñaría una pérdida donde hubo un ahorro.
    for (const [modelo, p] of Object.entries(CATALOGO)) {
      if (p.cachedInputPer1k === undefined) continue;
      expect(p.cachedInputPer1k, modelo).toBeLessThan(p.inputPer1k);
      expect(p.cachedInputPer1k, modelo).toBeGreaterThan(0);
    }
  });

  it("⛔ ningún precio tiene pinta de estar en dólares por MILLÓN", () => {
    // El error de copia más fácil: las tarifas se publican por millón y el
    // `CostModel` es por mil. Un factor 1000 de más pasa desapercibido en una
    // revisión y multiplica por mil el ahorro anunciado.
    for (const [modelo, p] of Object.entries(CATALOGO)) {
      expect(p.inputPer1k, `${modelo}: ¿por millón en vez de por mil?`).toBeLessThan(1);
      expect(p.outputPer1k, `${modelo}: ¿por millón en vez de por mil?`).toBeLessThan(1);
    }
  });

  it("cubre las familias que de verdad se usan", () => {
    for (const m of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "claude-sonnet-4", "claude-haiku-4-5"]) {
      expect(CATALOGO[m], m).toBeTruthy();
    }
  });

  it("deja por escrito de cuándo son los precios", () => {
    // Sin fecha, dentro de un año nadie sabe si revisarlos o fiarse.
    expect(PRECIOS_AL_DIA).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("las claves no llevan prefijo de proveedor", () => {
    // El lookup ya lo quita; tenerlo aquí duplicaría entradas y rompería el
    // emparejamiento por familia.
    for (const k of Object.keys(CATALOGO)) expect(k).not.toContain("/");
  });
});
