import { describe, it, expect } from "vitest";

import { CATALOGO, claveDeCatalogo, precioDeLista } from "../src/pricing/catalogo.js";
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
 * topes, muestreo, tiers y mensajes de la capa al azar. Para cada una, el crédito
 * que sale de `evaluarReferencia` y el `baselineEstimate` que sale del libro
 * (el mismo camino que publica el informe) tienen que quedar por debajo de:
 *
 *   · lo que la regla declara: tier · ((entrada − 8·m)·cacheada + min(salida, tope)·salida) / 1000;
 *   · lo que la poblada costó a precio de lista.
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
  return {
    v: 1,
    requestId: "req-poblada",
    at: 1_000_000,
    model: modelo,
    inputTokens: entero(r, 1, 20_000),
    outputTokens: entero(r, 0, 4_000),
    ...(r() < 0.5 ? { tierFactor: 0.5 } : {}),
    layerMessages: r() < 0.5 ? 0 : 1,
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

        const ev = evaluarReferencia(reg, {
          ahoraMs: 2_000_000,
          modeloPedido: modelo,
          modeloServido: modelo,
          huella: "huella",
          textoServidoSha256: "testigo",
          calidadOk: true,
          precio,
          determinista,
          topeDeSalida: tope,
          diferible,
        });

        if (!conCacheada) {
          expect(ev).toEqual({ ok: false, reason: "no-cached-price" });
          continue;
        }
        const entradaNeta = reg.inputTokens - REFERENCE_MESSAGE_ALLOWANCE * reg.layerMessages;
        if (entradaNeta <= 0) {
          expect(ev).toEqual({ ok: false, reason: "no-credit" });
          continue;
        }
        if (!ev.ok) throw new Error(`semilla ${semilla}: ${ev.reason}`);
        const c = ev.credit;
        const salidaTope = Math.min(reg.outputTokens, tope ?? Number.POSITIVE_INFINITY);

        expect(c.creditedInputTokens).toBeLessThanOrEqual(reg.inputTokens);
        expect(c.creditedOutputTokens).toBeLessThanOrEqual(salidaTope);
        if (!determinista) expect(c.creditedOutputTokens).toBe(0);
        expect(c.tierFactor).toBeGreaterThan(0);
        expect(c.tierFactor).toBeLessThanOrEqual(1);

        // El baseline por el MISMO camino que el informe: el libro.
        const libro = new SavingsLedger();
        libro.avoidCallByReference(c);
        const coste = libro.estimateCost(precio);
        expect(coste.basis).toBe("reference");
        expect(coste.actual).toBe(0);

        const suelo =
          (c.tierFactor *
            (entradaNeta * precio.cachedInputPer1k! + salidaTope * precio.outputPer1k)) /
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
