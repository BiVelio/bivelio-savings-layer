import { describe, expect, it } from "vitest";

import {
  EspejoDeCache,
  VENTANAS,
  decidirColocacion,
  decidirExplicitaOpenAI,
  equilibrioDeTramo,
  huellasDePrefijos,
  intervaloDeWilson,
  type EstadisticaDeClase,
  type TasaDeReutilizacion,
} from "../src/economics/colocador-de-cache.js";
import { ANTHROPIC_CACHE_TIER } from "../src/economics/cache-tier.js";
import type { ChatMessage } from "../src/contracts/types.js";

/**
 * EL COLOCADOR DE PUNTOS DE RUPTURA, por piezas: las huellas encadenadas, el
 * espejo que mide la reutilización del tráfico sin marcar nada, y la decisión
 * con los equilibrios de la página oficial de Anthropic (1,25× / 2× / 0,10×).
 */

const MIN = 60_000;
const sys: ChatMessage = { role: "system", content: "Eres el agente de soporte. ".repeat(40) };
const u = (t: string): ChatMessage => ({ role: "user", content: t });
const a = (t: string): ChatMessage => ({ role: "assistant", content: t });

describe("huellas encadenadas de los prefijos", () => {
  it("h[k] solo depende de los k primeros mensajes: una continuación comparte todas las anteriores", () => {
    const corto = huellasDePrefijos("raiz", [sys, u("hola")]);
    const largo = huellasDePrefijos("raiz", [sys, u("hola"), a("¿qué tal?"), u("bien")]);
    expect(largo.slice(0, 3)).toEqual(corto);
    expect(largo).toHaveLength(5);
    expect(new Set(largo).size).toBe(5);
  });

  it("cambia con el contenido, el rol, las llamadas a herramienta y la raíz", () => {
    const base = huellasDePrefijos("raiz", [sys, u("x")])[2];
    expect(huellasDePrefijos("raiz", [sys, u("y")])[2]).not.toBe(base);
    expect(huellasDePrefijos("raiz", [sys, a("x")])[2]).not.toBe(base);
    expect(huellasDePrefijos("otra", [sys, u("x")])[2]).not.toBe(base);
    const conLlamada: ChatMessage = { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "f", arguments: "{}" }] };
    const otraLlamada: ChatMessage = { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "f", arguments: '{"a":1}' }] };
    expect(huellasDePrefijos("r", [conLlamada])[1]).not.toBe(huellasDePrefijos("r", [otraLlamada])[1]);
  });

  it("`metadata` no viaja al proveedor y no mueve la huella", () => {
    const con: ChatMessage = { ...u("x"), metadata: { traza: 1 } };
    expect(huellasDePrefijos("r", [con])).toEqual(huellasDePrefijos("r", [u("x")]));
  });
});

/** Una conversación de `turnos` turnos en la que cada turno llega `huecoMs` después del anterior. */
function conversar(espejo: EspejoDeCache, clase: string, id: string, turnos: number, huecoMs: number, t0: number): number {
  let t = t0;
  const mensajes: ChatMessage[] = [sys];
  for (let i = 0; i < turnos; i++) {
    mensajes.push(u(`${id} pregunta ${i}`));
    const h = huellasDePrefijos("raiz", mensajes);
    espejo.observar(clase, h, t);
    espejo.registrar({
      clase,
      huellas: h,
      tramos: { S: 1, H: mensajes.length - 1, T: mensajes.length },
      enviada: t,
    });
    mensajes.push(a(`${id} respuesta ${i}`));
    t += huecoMs;
  }
  return t;
}

describe("el espejo mide la reutilización sin marcar nada", () => {
  it("una conversación que sigue cada 30 s: todas las colas se extienden dentro de 5 min", () => {
    const e = new EspejoDeCache();
    const fin = conversar(e, "c", "A", 25, 30_000, 0);
    const est = e.estadistica("c", fin + 2 * VENTANAS["1h"]);
    // 25 colas: 24 extendidas en 30 s y la última nunca (la conversación acabó).
    expect(est.T.muestras5m).toBe(25);
    expect(est.T.en5m).toBeCloseTo(24 / 25, 6);
    // La cabecera la reutiliza cada turno.
    expect(est.S.en5m).toBeGreaterThan(0.9);
  });

  it("tráfico de un solo uso con contexto propio: ni la cola ni el historial se reutilizan", () => {
    const e = new EspejoDeCache();
    for (let i = 0; i < 30; i++) {
      const mensajes = [sys, u(`documento único ${i} `.repeat(30)), a("recibido"), u(`pregunta ${i}`)];
      const h = huellasDePrefijos("raiz", mensajes);
      e.observar("c", h, i * 1000);
      e.registrar({ clase: "c", huellas: h, tramos: { S: 1, H: 3, T: 4 }, enviada: i * 1000 });
    }
    const est = e.estadistica("c", 30_000 + VENTANAS["5m"] + 1);
    expect(est.T.muestras5m).toBe(30);
    expect(est.T.en5m).toBe(0);
    expect(est.H.en5m).toBe(0);
    // La cabecera sí: la comparten todas.
    expect(est.S.en5m).toBeGreaterThan(0.9);
  });

  it("⛔ la censura: una entrada sin reutilizar cuenta como NO reutilizada en 5 min en cuanto pasan 5 min, no a la hora", () => {
    // Si solo se resolviera al vencer la hora, las reutilizaciones rápidas
    // entrarían antes que los fracasos y la tasa saldría inflada la primera hora.
    const e = new EspejoDeCache();
    const h = huellasDePrefijos("raiz", [sys, u("q")]);
    e.registrar({ clase: "c", huellas: h, tramos: { T: 2 }, enviada: 0 });
    const a6 = e.estadistica("c", 6 * MIN);
    expect(a6.T.muestras5m).toBe(1);
    expect(a6.T.en5m).toBe(0);
    expect(a6.T.muestras1h).toBe(0); // en la hora todavía puede reutilizarse
  });

  it("un hueco de 10 min cuenta en 30 min y en 1 h, no en 5 min", () => {
    const e = new EspejoDeCache();
    conversar(e, "c", "B", 2, 10 * MIN, 0);
    const est = e.estadistica("c", 10 * MIN + 1);
    expect(est.T["en5m"]).toBe(0);
    expect(est.T.muestras5m).toBe(1);
    expect(est.T.en30m).toBe(1);
    expect(est.T.en1h).toBe(1);
  });

  it("devuelve la coincidencia MÁS LARGA viva, con su hueco", () => {
    const e = new EspejoDeCache();
    const m1 = [sys, u("uno")];
    e.registrar({ clase: "c", huellas: huellasDePrefijos("raiz", m1), tramos: { S: 1, T: 2 }, enviada: 0 });
    const c = e.observar("c", huellasDePrefijos("raiz", [...m1, a("r"), u("dos")]), 40_000);
    expect(c).toMatchObject({ tipo: "T", indice: 2, huecoMs: 40_000 });
  });

  it("no mezcla clases y no ve entradas de más de una hora", () => {
    const e = new EspejoDeCache();
    const h = huellasDePrefijos("raiz", [sys, u("uno")]);
    e.registrar({ clase: "c1", huellas: h, tramos: { T: 2 }, enviada: 0 });
    expect(e.observar("c2", h, 1000)).toBeNull();
    expect(e.observar("c1", h, VENTANAS["1h"] + 1)).toBeNull();
  });

  it("memoria acotada: tope por clase y clases LRU", () => {
    const e = new EspejoDeCache({ maxPorClase: 16, maxClases: 2 });
    for (let i = 0; i < 40; i++) {
      const h = huellasDePrefijos("raiz", [sys, u(`q${i}`)]);
      e.registrar({ clase: "c1", huellas: h, tramos: { T: 2 }, enviada: i });
    }
    expect(e.vivas).toBeLessThanOrEqual(16);
    for (const c of ["c2", "c3"]) {
      e.registrar({ clase: c, huellas: huellasDePrefijos(c, [sys, u("x")]), tramos: { T: 2 }, enviada: 50 });
    }
    // c1 era la menos usada: se olvidó, con sus entradas.
    expect(e.vivas).toBe(2);
  });
});

describe("el contador del proveedor juzga al espejo", () => {
  it("si el proveedor no confirma la mitad de las lecturas predichas, la clase se apaga", () => {
    const e = new EspejoDeCache({ prediccionesMinimas: 8 });
    for (let i = 0; i < 8; i++) {
      e.verificar("c", { tipo: "T", indice: 2, huecoMs: 1000, posicionDelProveedor: 5000, ttl: "5m" }, i < 3 ? 5000 : 0);
    }
    const est = e.estadistica("c", 0);
    expect(est.predichas).toBe(8);
    expect(est.confirmadas).toBe(3);
    expect(est.apagada).toBe(true);
  });

  it("una entrada ya caducada en su TTL no es una predicción fallida", () => {
    const e = new EspejoDeCache({ prediccionesMinimas: 1 });
    e.verificar("c", { tipo: "T", indice: 2, huecoMs: 6 * MIN, posicionDelProveedor: 5000, ttl: "5m" }, 0);
    expect(e.estadistica("c", 0).predichas).toBe(0);
  });

  it("confirmadas de sobra: sigue encendida", () => {
    const e = new EspejoDeCache({ prediccionesMinimas: 8 });
    for (let i = 0; i < 10; i++) {
      e.verificar("c", { tipo: "T", indice: 2, huecoMs: 1000, posicionDelProveedor: 5000, ttl: "5m" }, 5200);
    }
    expect(e.estadistica("c", 0).apagada).toBe(false);
  });
});

function tasa(en5m: number, en1h = en5m, muestras = 40, en30m = en1h): TasaDeReutilizacion {
  const k = (p: number): number => Math.round(p * muestras);
  return {
    muestras5m: muestras,
    muestras30m: muestras,
    muestras1h: muestras,
    k5m: k(en5m),
    k30m: k(en30m),
    k1h: k(en1h),
    kTardias: k(Math.max(0, en1h - en5m)),
    pendientes5m: 0,
    pendientes30m: 0,
    pendientes1h: 0,
    en5m,
    en30m,
    en1h,
  };
}

function estadistica(p: Partial<EstadisticaDeClase> = {}): EstadisticaDeClase {
  const vacia = tasa(0, 0, 0);
  return { S: vacia, H: vacia, T: vacia, predichas: 0, confirmadas: 0, apagada: false, ...p };
}

const base = {
  tramo: ANTHROPIC_CACHE_TIER,
  primaDeUnaHora: 2,
  tokens: { S: 2000, H: 30_000, T: 31_000 },
  hayHistorial: true,
  lecturaPrevista: () => 29_000,
};

describe("Wilson decide cuándo hay certeza", () => {
  it("5 de 5 ya basta para encender la cola; 0 de n necesita n ≥ 14 para quitar un punto", () => {
    const eq = equilibrioDeTramo(1.25, 0.1);
    expect(intervaloDeWilson(5, 5)[0]).toBeGreaterThan(eq);
    expect(intervaloDeWilson(0, 13)[1]).toBeGreaterThan(eq);
    expect(intervaloDeWilson(0, 14)[1]).toBeLessThan(eq);
    expect(intervaloDeWilson(0, 0)).toEqual([0, 1]);
  });

  it("⛔ «después de 5 min» se mide sobre el mismo denominador: un agente de pasos cada 4 s no tiene reutilizaciones tardías", () => {
    // Restar la tasa de 5 min a la de 1 h mezclaba denominadores: la última cola
    // de cada tarea (nunca continuada) se resolvía a los 5 min en una y seguía
    // pendiente en la otra, y salía un 1,8 % «tardío» que no existía.
    const e = new EspejoDeCache();
    let t = 0;
    for (let tarea = 0; tarea < 3; tarea++) t = conversar(e, "c", `T${tarea}`, 12, 4000, t) + 30_000;
    const est = e.estadistica("c", t + 6 * MIN);
    expect(est.T.kTardias).toBe(0);
    expect(est.T.k1h).toBe(est.T.k5m);
  });
});

describe("⛔ la censura por la derecha no empuja ninguna decisión", () => {
  it("chats de 2 turnos con 8 min de hueco: en la primera hora solo se han resuelto los que SÍ siguieron", () => {
    // Una reutilización se sabe al llegar; un fracaso, cuando vence la hora.
    // Sin contar las pendientes como fracasos, a los 54 min la tasa en 1 h
    // sería 6/6 y la cola se marcaría a 1 h (2×) para conversaciones que
    // siguen justo la mitad de las veces: 0,5 < 0,526, pierde.
    const e = new EspejoDeCache();
    for (let c = 0; c < 6; c++) {
      const t0 = c * 9 * MIN;
      const m = [sys, u(`c${c} hola`)];
      const h1 = huellasDePrefijos("raiz", m);
      e.observar("c", h1, t0);
      e.registrar({ clase: "c", huellas: h1, tramos: { S: 1, T: 2 }, enviada: t0 });
      const m2 = [...m, a(`c${c} respuesta`), u(`c${c} adiós`)];
      const h2 = huellasDePrefijos("raiz", m2);
      e.observar("c", h2, t0 + 8 * MIN);
      e.registrar({ clase: "c", huellas: h2, tramos: { S: 1, H: 3, T: 4 }, enviada: t0 + 8 * MIN });
    }
    const est = e.estadistica("c", 54 * MIN);
    expect(est.T.k1h).toBe(6);
    expect(est.T.muestras1h).toBe(6);
    expect(est.T.pendientes1h).toBeGreaterThanOrEqual(5);
    const c = decidirColocacion({ ...base, estadistica: est });
    expect(c.cola).toBe(false);
    expect(c.ttl).toBe("5m");
  });
});

describe("la decisión, con los equilibrios oficiales", () => {
  it("equilibrios: 0,25/1,15 con 5 min (1,25×/0,10×), 1/1,9 con 1 h (2×) y 0,25/1,20 en Opus 5.5 (0,05×)", () => {
    expect(equilibrioDeTramo(1.25, 0.1)).toBeCloseTo(0.25 / 1.15, 10);
    expect(equilibrioDeTramo(2, 0.1)).toBeCloseTo(1 / 1.9, 10);
    expect(equilibrioDeTramo(1.25, 0.05)).toBeCloseTo(0.25 / 1.2, 10);
  });

  it("sin muestras es EXACTAMENTE la colocación fija: cabecera + historial, sin cola, 5 min", () => {
    const c = decidirColocacion({ ...base, estadistica: estadistica() });
    expect(c).toMatchObject({ historial: true, cola: false, ttl: "5m" });
  });

  it("conversación o agente (continuaciones del 90 %): marca la cola", () => {
    const c = decidirColocacion({ ...base, estadistica: estadistica({ H: tasa(0.9), T: tasa(0.9) }) });
    expect(c).toMatchObject({ historial: true, cola: true, ttl: "5m" });
    expect(c.razon).toMatch(/tail marked/);
  });

  it("un solo uso con contexto propio: baja el punto a la cabecera y no marca cola", () => {
    const c = decidirColocacion({ ...base, estadistica: estadistica({ H: tasa(0.02), T: tasa(0) }) });
    expect(c).toMatchObject({ historial: false, cola: false, ttl: "5m" });
    expect(c.razon).toMatch(/moved back to the system header/);
  });

  it("⛔ justo en el equilibrio no se concluye nada: ni cola, y el historial se queda como en la fija", () => {
    const eq = equilibrioDeTramo(1.25, 0.1);
    const c = decidirColocacion({ ...base, estadistica: estadistica({ H: tasa(eq), T: tasa(eq) }) });
    expect(c.cola).toBe(false);
    expect(c.historial).toBe(true);
    expect(c.razon).toMatch(/not conclusive/);
  });

  it("chat lento (huecos de 8 min): con 5 min no paga, con 1 h sí → cola a 1 h", () => {
    const c = decidirColocacion({ ...base, estadistica: estadistica({ H: tasa(0.05, 0.9), T: tasa(0.05, 0.9) }) });
    expect(c).toMatchObject({ historial: true, cola: true, ttl: "1h" });
    expect(c.razon).toMatch(/5 min does not pay/);
  });

  it("1 h: huecos de 5 a 60 min y poco que escribir → compensa releer el prefijo entero", () => {
    // El 30 % de las continuaciones llega entre 5 min y 1 h, y esta petición
    // escribe 2.000 de 31.000: gana 0,30·1,15·31.000 ≈ 10.695, cuesta 0,75·2.000 = 1.500.
    const c = decidirColocacion({
      ...base,
      estadistica: estadistica({ H: tasa(0.6, 0.9), T: tasa(0.6, 0.9) }),
    });
    expect(c).toMatchObject({ cola: true, ttl: "1h" });
  });

  it("⛔ 1 h NO cuando lo que se escribe es casi todo lo que se leería (arranque de sesión)", () => {
    // La regla que midió el corpus del gateway: el acierto se gana sobre lo
    // escrito y el fallo se paga sobre lo leído. Con D ≈ P y solo un 5 % de
    // huecos en medio, la hora pierde.
    const c = decidirColocacion({
      ...base,
      lecturaPrevista: () => 0,
      estadistica: estadistica({ H: tasa(0.9, 0.95), T: tasa(0.9, 0.95) }),
    });
    expect(c.ttl).toBe("5m");
  });

  it("sin TTL de 1 h en el proveedor (`primaDeUnaHora: null`) nunca pide 1 h", () => {
    const c = decidirColocacion({
      ...base,
      primaDeUnaHora: null,
      estadistica: estadistica({ H: tasa(0.1, 0.99), T: tasa(0.1, 0.99) }),
    });
    expect(c.ttl).toBe("5m");
  });

  it("con la clase apagada por el contador del proveedor, vuelve a la fija y dice por qué", () => {
    const c = decidirColocacion({
      ...base,
      estadistica: estadistica({ T: tasa(0.99), H: tasa(0.99), predichas: 10, confirmadas: 2, apagada: true }),
    });
    expect(c).toMatchObject({ historial: true, cola: false, ttl: "5m" });
    expect(c.razon).toMatch(/confirmed only 2 of 10/);
  });
});

describe("OpenAI GPT-5.6+: el modo explícito por medición", () => {
  const tramo = { minimumCacheTokens: 1024, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 };

  it("sin muestras deja el modo del proveedor", () => {
    expect(decidirExplicitaOpenAI({ estadistica: estadistica(), tramo, hayHistorial: true }).explicita).toBe(false);
  });

  it("continuaciones por encima del equilibrio: el modo del proveedor (escribir la pregunta compensa)", () => {
    const d = decidirExplicitaOpenAI({ estadistica: estadistica({ T: tasa(0.9), H: tasa(0.9) }), tramo, hayHistorial: true });
    expect(d.explicita).toBe(false);
  });

  it("un solo uso: explícito, y con el historial sin reutilizar el punto va a la cabecera", () => {
    const d = decidirExplicitaOpenAI({ estadistica: estadistica({ T: tasa(0), H: tasa(0) }), tramo, hayHistorial: true });
    expect(d).toMatchObject({ explicita: true, historial: false });
  });

  it("plantilla fija con preguntas distintas: explícito con el punto al final del historial", () => {
    const d = decidirExplicitaOpenAI({ estadistica: estadistica({ T: tasa(0), H: tasa(0.95) }), tramo, hayHistorial: true });
    expect(d).toMatchObject({ explicita: true, historial: true });
  });
});
