import { describe, it, expect } from "vitest";

import { CATALOGO, claveDeCatalogo, precioDeLista } from "../src/pricing/catalogo.js";
import { esModeloDeRazonamiento, filasSinClasificar, RAZONA_POR_FILA } from "../src/pricing/razonamiento.js";
import { SavingsLedger, REFERENCE_MESSAGE_ALLOWANCE } from "../src/tokenizer/accounting.js";
import {
  evaluarReferencia,
  precioDeListaPropio,
  type RegistroDeReferencia,
} from "../src/pipeline/referencia.js";

/**
 * LA REFERENCIA ES UN SUELO, PARA TODO EL CATÁLOGO.
 *
 * Propiedad, no ejemplos: 500 semillas por fila del catálogo, con contadores,
 * topes, muestreo, tiers, piezas de la capa y razonamiento declarado al azar.
 * Para cada una, el crédito que sale de `evaluarReferencia` y el
 * `baselineEstimate` que sale del libro (el mismo camino que publica el
 * informe) tienen que quedar por debajo de:
 *
 *   · lo que la regla declara: tier · ((entrada − 8·m)·cacheada + min(salida, tope)·salida) / 1000;
 *   · lo que la poblada costó a precio de lista.
 *
 * Y la GUARDA DE RAZONAMIENTO (regla v2): ni un token de salida si el modelo
 * razona según su fila, si el contador declaró razonamiento o si no dijo nada.
 *
 * Si un precio nuevo del catálogo rompiera la regla (una tarifa cacheada por
 * encima de la de entrada, por ejemplo), esto se pone rojo antes que la factura.
 *
 * Y el suelo solo vale con el precio del modelo que corrió: el segundo bloque
 * recorre los ids que NO son una fila (sufijos de letra que `precioDeLista` deja
 * heredar, números que no son fecha) y exige que la referencia no los valore.
 */

/** mulberry32: determinista, para que un fallo se reproduzca con su semilla. */
function azar(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const entero = (r: () => number, min: number, max: number): number =>
  min + Math.floor(r() * (max - min + 1));

const SEMILLAS = 500;
/** El redondeo de `roundUsd` (1e-10) puede subir medio cuanto. */
const CUANTO = 5e-11;

function registro(r: () => number, modelo: string): RegistroDeReferencia {
  // Razonamiento declarado: 0 la mitad de las veces, positivo o callado el resto.
  const dado = r();
  const razonamiento = dado < 0.5 ? 0 : dado < 0.75 ? entero(r, 1, 3_000) : undefined;
  return {
    v: 2,
    requestId: "req-poblada",
    at: 1_000_000,
    model: modelo,
    inputTokens: entero(r, 1, 20_000),
    outputTokens: entero(r, 0, 4_000),
    ...(r() < 0.5 ? { tierFactor: 0.5 } : {}),
    // Mensaje de datos, turno del adaptador, envoltorio del esquema: 0 a 3.
    layerInsertions: entero(r, 0, 3),
    ...(razonamiento !== undefined ? { reasoningTokens: razonamiento } : {}),
    requestFingerprint: "huella",
    textSha256: "testigo",
  };
}

describe("la referencia es un suelo (propiedad sobre el catálogo)", () => {
  it("toda tarifa cacheada documentada está en (0, entrada]", () => {
    for (const [modelo, precio] of Object.entries(CATALOGO)) {
      if (precio.cachedInputPer1k === undefined) continue;
      expect(precio.cachedInputPer1k, modelo).toBeGreaterThan(0);
      expect(precio.cachedInputPer1k, modelo).toBeLessThanOrEqual(precio.inputPer1k);
    }
  });

  for (const [modelo, precio] of Object.entries(CATALOGO)) {
    const conCacheada = precio.cachedInputPer1k !== undefined;
    it(`${modelo}: ${conCacheada ? "el crédito nunca pasa del suelo" : "sin tarifa cacheada, no-cached-price"}`, () => {
      for (let semilla = 1; semilla <= SEMILLAS; semilla++) {
        const r = azar(semilla * 7919 + modelo.length);
        const reg = registro(r, modelo);
        const tope = r() < 0.3 ? undefined : entero(r, 1, 5_000);
        const determinista = r() < 0.5;
        const diferible = r() < 0.3;

        const modeloRazona = esModeloDeRazonamiento(modelo);
        const ev = evaluarReferencia(reg, {
          ahoraMs: 2_000_000,
          modeloPedido: modelo,
          modeloServido: modelo,
          huella: "huella",
          textoServidoSha256: "testigo",
          calidadOk: true,
          precio,
          determinista,
          modeloRazona,
          topeDeSalida: tope,
          diferible,
        });

        if (!conCacheada) {
          expect(ev).toEqual({ ok: false, reason: "no-cached-price" });
          continue;
        }
        const entradaNeta = reg.inputTokens - REFERENCE_MESSAGE_ALLOWANCE * reg.layerInsertions;
        if (entradaNeta <= 0) {
          expect(ev).toEqual({ ok: false, reason: "no-credit" });
          continue;
        }
        if (!ev.ok) throw new Error(`semilla ${semilla}: ${ev.reason}`);
        const c = ev.credit;
        const salidaTope = Math.min(reg.outputTokens, tope ?? Number.POSITIVE_INFINITY);

        expect(c.creditedInputTokens).toBeLessThanOrEqual(reg.inputTokens);
        expect(c.creditedInputTokens).toBe(entradaNeta);
        expect(c.creditedOutputTokens).toBeLessThanOrEqual(salidaTope);
        if (!determinista) expect(c.creditedOutputTokens).toBe(0);
        // LA GUARDA DE RAZONAMIENTO: el contador de salida de un modelo que
        // razona, o de una llamada que no declaró exactamente 0, no vale nada.
        if (modeloRazona || reg.reasoningTokens !== 0) {
          expect(c.creditedOutputTokens, `semilla ${semilla}`).toBe(0);
          if (determinista) expect(ev.outputNotCredited, `semilla ${semilla}`).toBeDefined();
        }
        expect(c.tierFactor).toBeGreaterThan(0);
        expect(c.tierFactor).toBeLessThanOrEqual(1);

        // El baseline por el MISMO camino que el informe: el libro.
        const libro = new SavingsLedger();
        libro.avoidCallByReference(c);
        const coste = libro.estimateCost(precio);
        expect(coste.basis).toBe("reference");
        expect(coste.actual).toBe(0);

        const salidaAcreditable = determinista && !modeloRazona && reg.reasoningTokens === 0;
        const suelo =
          (c.tierFactor *
            (entradaNeta * precio.cachedInputPer1k! +
              (salidaAcreditable ? salidaTope : 0) * precio.outputPer1k)) /
          1000;
        const aLista = (reg.inputTokens * precio.inputPer1k + reg.outputTokens * precio.outputPer1k) / 1000;
        expect(coste.baselineEstimate, `semilla ${semilla}`).toBeLessThanOrEqual(suelo + CUANTO);
        expect(coste.baselineEstimate, `semilla ${semilla}`).toBeLessThanOrEqual(aLista + CUANTO);
      }
    });
  }
});

describe("el precio de la referencia es la fila PROPIA del modelo, nunca la de un pariente", () => {
  const CLAVES = Object.keys(CATALOGO);
  /** Sufijos de letra: unos son alias del mismo modelo (`latest`), otros son OTRO
   *  modelo más barato (`lite`, `mini`). Desde fuera no se distinguen. */
  const SUFIJOS_DE_LETRA = ["lite", "mini", "nano", "pro", "turbo", "flash", "latest", "preview", "exp"];
  const FECHAS = ["2024-07-18", "20250929"];

  it("cada fila se encuentra a sí misma, con y sin prefijo de proveedor", () => {
    for (const k of CLAVES) {
      expect(precioDeListaPropio(k), k).toBe(CATALOGO[k]);
      expect(precioDeListaPropio(`vendor/${k}`), k).toBe(CATALOGO[k]);
    }
  });

  it("un id con sufijo de letra que no es una fila no tiene precio de referencia, aunque herede para tarifar", () => {
    let heredados = 0;
    for (const k of CLAVES) {
      for (const sufijo of SUFIJOS_DE_LETRA) {
        const id = `${k}-${sufijo}`;
        if (id in CATALOGO) continue;
        if (precioDeLista(id) !== undefined) heredados++;
        expect(precioDeListaPropio(id), id).toBeUndefined();
        expect(precioDeListaPropio(`vendor/${id}`), id).toBeUndefined();

        const r = azar(id.length * 104729);
        const ev = evaluarReferencia(registro(r, id), {
          ahoraMs: 2_000_000,
          modeloPedido: id,
          modeloServido: id,
          huella: "huella",
          textoServidoSha256: "testigo",
          calidadOk: true,
          precio: precioDeListaPropio(id),
          determinista: true,
          modeloRazona: esModeloDeRazonamiento(id),
          diferible: false,
        });
        expect(ev, id).toEqual({ ok: false, reason: "no-cached-price" });
      }
    }
    // El bloque tiene que ejercitar la herencia peligrosa, no solo ids sin precio.
    expect(heredados).toBeGreaterThan(0);
    expect(precioDeLista("gemini-2.5-flash-lite")).toBe(CATALOGO["gemini-2.5-flash"]);
    expect(precioDeListaPropio("gemini-2.5-flash-lite")).toBeUndefined();
  });

  it("una instantánea con fecha es el mismo modelo y conserva su fila", () => {
    for (const k of CLAVES) {
      for (const fecha of FECHAS) {
        const id = `${k}-${fecha}`;
        expect(claveDeCatalogo(id), id).toBe(k);
        expect(precioDeListaPropio(id), id).toBe(CATALOGO[k]);
        expect(precioDeListaPropio(`vendor/${id}`), id).toBe(CATALOGO[k]);
      }
    }
  });

  it("un número tras la clave que no es una fecha completa no hereda", () => {
    for (const k of CLAVES) {
      for (const cola of ["0125", "0613", "32k", "2024", "2024-07-18-preview"]) {
        const id = `${k}-${cola}`;
        if (id in CATALOGO) continue;
        expect(precioDeListaPropio(id), id).toBeUndefined();
      }
    }
  });
});

describe("la guarda de razonamiento: cada fila del catálogo declara si razona", () => {
  it("ninguna fila del catálogo queda sin clasificar, y la tabla no clasifica filas que no existen", () => {
    // Quien añada un precio tiene que decidir también esto: una fila sin
    // clasificar pondría en duda la salida acreditada de sus repeticiones.
    expect(filasSinClasificar()).toEqual([]);
    expect(Object.keys(RAZONA_POR_FILA).sort()).toEqual(Object.keys(CATALOGO).sort());
  });

  it("la fila manda para sus instantáneas y sus alias; el nombre suma, nunca resta", () => {
    for (const k of Object.keys(CATALOGO)) {
      // Lo que dice la fila es lo que sale, también con prefijo y con fecha: el
      // patrón de nombres no contradice a ninguna fila de la tabla.
      for (const id of [k, `vendor/${k}`, `${k}-2025-08-07`]) {
        expect(esModeloDeRazonamiento(id), id).toBe(RAZONA_POR_FILA[k]);
      }
    }
    // Familias enteras: gpt-5 y Gemini 2.5/3.x razonan; gpt-4o y Claude no.
    expect(esModeloDeRazonamiento("openai/gpt-5-mini")).toBe(true);
    expect(esModeloDeRazonamiento("gpt-5.6-sol")).toBe(true);
    expect(esModeloDeRazonamiento("google/gemini-2.5-flash-lite")).toBe(true);
    expect(esModeloDeRazonamiento("openai/gpt-4o-mini")).toBe(false);
    expect(esModeloDeRazonamiento("anthropic/claude-sonnet-4-5")).toBe(false);
    // Fuera del catálogo (con precio en costModels), el nombre lo delata.
    for (const id of ["o1", "o3-mini", "openai/o4-mini", "deepseek/deepseek-r1", "deepseek-reasoner", "qwq-32b", "magistral-medium", "grok-4-fast-reasoning", "qwen3-235b-a22b-thinking-2507"]) {
      expect(esModeloDeRazonamiento(id), id).toBe(true);
    }
    // Una variante «thinking» de una fila que no razona: el nombre suma.
    expect(esModeloDeRazonamiento("claude-sonnet-4-5-thinking")).toBe(true);
  });

  it("para un modelo que razona, ni temperature 0 ni un contador que diga 0 acreditan salida", () => {
    for (const [modelo, precio] of Object.entries(CATALOGO)) {
      if (!RAZONA_POR_FILA[modelo] || precio.cachedInputPer1k === undefined) continue;
      const ev = evaluarReferencia(
        {
          v: 2,
          requestId: "req-poblada",
          at: 1_000_000,
          model: modelo,
          inputTokens: 1_000,
          outputTokens: 500,
          layerInsertions: 0,
          reasoningTokens: 0,
          requestFingerprint: "huella",
          textSha256: "testigo",
        },
        {
          ahoraMs: 2_000_000,
          modeloPedido: modelo,
          modeloServido: modelo,
          huella: "huella",
          textoServidoSha256: "testigo",
          calidadOk: true,
          precio,
          determinista: true,
          modeloRazona: esModeloDeRazonamiento(modelo),
          diferible: false,
        },
      );
      if (!ev.ok) throw new Error(`${modelo}: ${ev.reason}`);
      expect(ev.credit.creditedInputTokens, modelo).toBe(1_000);
      expect(ev.credit.creditedOutputTokens, modelo).toBe(0);
      expect(ev.outputNotCredited, modelo).toBe("reasoning-model");
    }
  });
});
