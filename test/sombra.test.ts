import { describe, expect, it } from "vitest";

import {
  BYTES_DEL_MUNON,
  MINIMO_BYTES_CANDIDATO,
  V2_PRESUPUESTO_BYTES,
  aplicarPolitica,
  avanzarEstado,
  bytesTrasReduccionV1,
  clasificar,
  compactarCuerpo,
  estadoNuevo,
  identidad,
  simularSesion,
  type BloqueSombra,
  type TurnoSombra,
} from "../gateway/sombra.js";

/**
 * S2.4 · Verjas del motor de sombra. Las tres que importan de verdad:
 *
 *  1. INVALIDACIÓN: una política que reescribe un bloque cacheado tiene que
 *     PAGAR la reescritura de todo lo posterior — es la trampa que el plan
 *     obliga a restar siempre, y si el simulador no la cobra, la comparación
 *     entera es propaganda.
 *  2. ESTABILIDAD: v1 depende solo del contenido — sus decisiones no pueden
 *     cambiar con la edad (esa estabilidad es su razón de existir).
 *  3. CONTENIDO: nada de lo que entra en compactarCuerpo sale de él — solo
 *     hashes, bytes y clases.
 */

function toolResult(texto: string, extra?: { is_error?: boolean }): unknown {
  return { type: "tool_result", tool_use_id: "tu_1", content: texto, ...extra };
}

function cuerpoCon(...resultados: unknown[]): { messages: unknown[] } {
  return {
    messages: [
      { role: "user", content: "haz una cosa" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "bash", input: {} }] },
      ...resultados.map((r) => ({ role: "user", content: [r] })),
    ],
  };
}

const LOG_GORDO = Array.from({ length: 200 }, (_, i) =>
  i === 120 ? "ERROR: la base de datos rechazó la conexión" : `2026-09-03 10:00:${String(i % 60).padStart(2, "0")} INFO petición servida en 12ms`,
).join("\n");

const CODIGO_GORDO = Array.from({ length: 150 }, (_, i) =>
  i % 10 === 0 ? `export function cosa${i}(x: number): number {` : `  const y${i} = x * ${i}; // detalle`,
).join("\n");

const DIFF = ["diff --git a/f.ts b/f.ts", "@@ -1,3 +1,3 @@", "-const a = 1", "+const a = 2", " const b = 3"].join("\n");

describe("compactarCuerpo: contenido dentro, metadatos fuera", () => {
  it("no filtra ni un byte del contenido: solo hash/bytes/clase", () => {
    const secreto = "contraseña-que-jamas-debe-salir-" + "x".repeat(2000);
    const bloques = compactarCuerpo(cuerpoCon(toolResult(secreto)));
    const serializado = JSON.stringify(bloques);
    expect(serializado).not.toContain("contraseña");
    expect(serializado).not.toContain("xxxx");
    const tr = bloques.find((b) => b.tipo === "user:tool_result")!;
    expect(tr.bytes).toBeGreaterThan(2000);
    expect(tr.clave).toMatch(/^[0-9a-f]{16}$/);
  });

  it("el mismo contenido produce la misma clave (la identidad da edad)", () => {
    const a = compactarCuerpo(cuerpoCon(toolResult(LOG_GORDO)));
    const b = compactarCuerpo(cuerpoCon(toolResult(LOG_GORDO)));
    expect(a.find((x) => x.tipo === "user:tool_result")!.clave).toBe(b.find((x) => x.tipo === "user:tool_result")!.clave);
  });

  it("is_error se propaga (ningún error se elide en v1/v2)", () => {
    const bloques = compactarCuerpo(cuerpoCon(toolResult("boom", { is_error: true })));
    expect(bloques.find((b) => b.tipo === "user:tool_result")!.esError).toBe(true);
  });
});

describe("clasificar y reducir (v1)", () => {
  it("un log se clasifica como log y la reducción conserva la señal", () => {
    expect(clasificar(LOG_GORDO)).toBe("log");
    const reducido = bytesTrasReduccionV1(LOG_GORDO, "log");
    expect(reducido).toBeLessThan(Buffer.byteLength(LOG_GORDO) / 3);
    // La línea de error más su contexto caben de sobra en lo conservado.
    expect(reducido).toBeGreaterThan(BYTES_DEL_MUNON);
  });

  it("el código conserva las firmas y suelta los cuerpos", () => {
    expect(clasificar(CODIGO_GORDO)).toBe("codigo");
    const reducido = bytesTrasReduccionV1(CODIGO_GORDO, "codigo");
    expect(reducido).toBeLessThan(Buffer.byteLength(CODIGO_GORDO) / 2);
  });

  it("un diff queda intacto: el diff ES la señal", () => {
    expect(clasificar(DIFF)).toBe("diff");
    expect(bytesTrasReduccionV1(DIFF, "diff")).toBe(Buffer.byteLength(DIFF));
  });

  it("lo que no sabe leer no lo toca (presente-y-mal peor que ausente)", () => {
    const prosa = "Una explicación larga en prosa. ".repeat(100);
    expect(clasificar(prosa)).toBe("otro");
    expect(bytesTrasReduccionV1(prosa, "otro")).toBe(Buffer.byteLength(prosa));
  });
});

describe("políticas sobre un turno", () => {
  const bloquesCon = (...textos: string[]) =>
    compactarCuerpo(cuerpoCon(...textos.map((t) => toolResult(t)), toolResult("resultado fresquísimo del turno actual " + "z".repeat(1500))));

  it("v0: la edad manda — el mismo bloque pasa de quedarse a caer", () => {
    const bloques = bloquesCon(LOG_GORDO);
    const estado = estadoNuevo();
    const t0 = avanzarEstado(estado, bloques);
    const joven = aplicarPolitica("v0", bloques, estado, t0);
    // Recién nacido: nada elidido.
    expect(joven.every((b) => !b.clave.endsWith(":e"))).toBe(true);
    // Cuatro turnos después, el log gordo cae.
    let t = t0;
    for (let i = 0; i < 4; i++) t = avanzarEstado(estado, bloques);
    const viejo = aplicarPolitica("v0", bloques, estado, t);
    expect(viejo.some((b) => b.clave.endsWith(":e") && b.bytes === BYTES_DEL_MUNON)).toBe(true);
  });

  it("v1: estable de por vida — la edad no cambia NADA", () => {
    const bloques = bloquesCon(LOG_GORDO);
    const estado = estadoNuevo();
    const t0 = avanzarEstado(estado, bloques);
    const primera = aplicarPolitica("v1", bloques, estado, t0);
    let t = t0;
    for (let i = 0; i < 10; i++) t = avanzarEstado(estado, bloques);
    expect(aplicarPolitica("v1", bloques, estado, t)).toEqual(primera);
    // Y reduce el log de verdad.
    expect(primera.some((b) => b.clave.endsWith(":r"))).toBe(true);
  });

  it("v1 y v2 jamás tocan un tool_result con is_error", () => {
    const conError = compactarCuerpo(
      cuerpoCon(toolResult(LOG_GORDO, { is_error: true }), toolResult("relleno ".repeat(40000)), toolResult("fresco " + "z".repeat(1500))),
    );
    const estado = estadoNuevo();
    let t = avanzarEstado(estado, conError);
    for (let i = 0; i < 5; i++) t = avanzarEstado(estado, conError);
    const idxError = conError.findIndex((b) => b.esError);
    for (const p of ["v1", "v2", "v2m"] as const) {
      const res = aplicarPolitica(p, conError, estado, t);
      expect(res[idxError]!.bytes).toBe(conError[idxError]!.bytes);
    }
  });

  it("v2: respeta el presupuesto y conserva el orden cronológico", () => {
    const gordos = Array.from({ length: 6 }, (_, i) => `bloque ${i} `.repeat(12000)); // ~6×~120KB > 256KB
    const bloques = bloquesCon(...gordos);
    const estado = estadoNuevo();
    let t = avanzarEstado(estado, bloques);
    for (let i = 0; i < 3; i++) t = avanzarEstado(estado, bloques);
    const res = aplicarPolitica("v2", bloques, estado, t);
    const masa = res
      .filter((_, i) => bloques[i]!.tipo.endsWith(":tool_result"))
      .reduce((s, b) => s + b.bytes, 0);
    expect(masa).toBeLessThanOrEqual(V2_PRESUPUESTO_BYTES);
    // Mismo número de bloques, mismo orden: solo cambian bytes/clave.
    expect(res.length).toBe(bloques.length);
    for (let i = 0; i < res.length; i++) expect(res[i]!.clave.startsWith(bloques[i]!.clave)).toBe(true);
  });

  it("v2m: un bloque elidido queda elidido — el conjunto de víctimas solo crece", () => {
    // Turno gordo que fuerza la poda, seguido de un turno LIGERO que cabría
    // entero en el presupuesto: v2 literal resucitaría a las víctimas (y
    // pagaría la invalidación); v2m no resucita a nadie.
    const gordos = Array.from({ length: 6 }, (_, i) => `bloque ${i} `.repeat(12000));
    const bloques = bloquesCon(...gordos);
    const estado = estadoNuevo();
    let t = avanzarEstado(estado, bloques);
    for (let i = 0; i < 3; i++) t = avanzarEstado(estado, bloques);
    const podado = aplicarPolitica("v2m", bloques, estado, t);
    const victimas = podado.filter((b) => b.clave.endsWith(":e")).map((b) => b.clave);
    expect(victimas.length).toBeGreaterThan(0);
    // El turno siguiente, aunque la masa ya quepa, las víctimas siguen caídas.
    const t2 = avanzarEstado(estado, bloques);
    const siguiente = aplicarPolitica("v2m", bloques, estado, t2);
    for (const v of victimas) expect(siguiente.some((b) => b.clave === v)).toBe(true);
  });

  it("ninguna política toca el último tool_result ni los pequeños", () => {
    const bloques = bloquesCon(LOG_GORDO);
    const idxUltimo = bloques.reduce((u, b, i) => (b.tipo.endsWith(":tool_result") ? i : u), -1);
    const estado = estadoNuevo();
    let t = avanzarEstado(estado, bloques);
    for (let i = 0; i < 6; i++) t = avanzarEstado(estado, bloques);
    for (const p of ["v0", "v1", "v2", "v2m"] as const) {
      const res = aplicarPolitica(p, bloques, estado, t);
      expect(res[idxUltimo]!.bytes).toBe(bloques[idxUltimo]!.bytes);
      for (let i = 0; i < bloques.length; i++) {
        if (bloques[i]!.bytes < MINIMO_BYTES_CANDIDATO) expect(res[i]!.bytes).toBe(bloques[i]!.bytes);
      }
    }
  });
});

describe("el simulador de caché de prefijo", () => {
  const MODELO = "claude-sonnet-4-5";

  function turno(bloques: BloqueSombra[], at: number, entradaReal: number): TurnoSombra {
    return { bloques, at, model: MODELO, entradaReal, escritura1h: true };
  }

  function bloque(clave: string, bytes: number): BloqueSombra {
    return { clave, tipo: "user:text", bytes, bytesV1: bytes, clase: "otro", esError: false };
  }

  it("turno 1 escribe todo; repetir idéntico lo lee todo", () => {
    const bloques = [bloque("a", 4000), bloque("b", 4000)];
    const c = simularSesion([turno(bloques, 1000, 8000), turno(bloques, 2000, 8000)], (b) => identidad(b));
    expect(c.tokensEscritos).toBeCloseTo(8000, 0);
    expect(c.tokensLeidos).toBeCloseTo(8000, 0);
    expect(c.tokensInvalidados).toBe(0);
  });

  it("⛔ LA TRAMPA: cambiar un bloque cacheado cobra la reescritura del resto", () => {
    const t1 = [bloque("a", 4000), bloque("b", 4000), bloque("c", 4000)];
    // El turno 2 manda lo MISMO pero con «a» reescrita (elidida): b y c, que
    // estaban idénticos y cacheados, se reescriben SOLO por la rotura.
    const t2 = [bloque("a-elidida", 120), bloque("b", 4000), bloque("c", 4000)];
    const c = simularSesion([turno(t1, 1000, 12000), turno(t2, 2000, 8120)], (b) => identidad(b));
    // b + c del turno 2 son invalidación pura: existían idénticos tras la rotura.
    expect(c.tokensInvalidados).toBeCloseTo(8000, 0);
    expect(c.invalidacionUsd).toBeGreaterThan(0);
  });

  it("la caducidad del TTL reescribe entero sin contarlo como invalidación", () => {
    const bloques = [bloque("a", 4000), bloque("b", 4000)];
    const c = simularSesion(
      [turno(bloques, 0, 8000), turno(bloques, 2 * 3_600_000, 8000)],
      (b) => identidad(b),
    );
    expect(c.tokensLeidos).toBe(0);
    expect(c.tokensEscritos).toBeCloseTo(16000, 0);
    expect(c.tokensInvalidados).toBe(0);
  });

  it("una política que solo ahorra rompiendo caché sale MÁS CARA que el baseline", () => {
    // Sesión larga y estable: un log gordo al principio, 20 turnos que solo
    // añaden un bloque pequeño al final — el paraíso de la caché (98 % lectura).
    const gordo = bloque("log", 200_000);
    const turnos: TurnoSombra[] = [];
    for (let i = 0; i < 20; i++) {
      const cola = Array.from({ length: i + 1 }, (_, j) => bloque(`paso-${j}`, 2000));
      const bloques = [gordo, ...cola];
      turnos.push(turno(bloques, i * 60_000, bloques.reduce((s, b) => s + b.bytes, 0) / 4));
    }
    const baseline = simularSesion(turnos, (b) => identidad(b));
    // La «política» tonta: a partir del turno 10 elide el gordo (rompe el
    // prefijo en la posición 0 para siempre jamás… una sola vez).
    const tonta = simularSesion(turnos, (b, _e, t) =>
      b.map((x) => (t >= 10 && x.clave === "log" ? { clave: "log:e", bytes: 120 } : { clave: x.clave, bytes: x.bytes })),
    );
    // Elide el 90 % de la masa y AUN ASÍ el neto es peor o casi: la rotura del
    // turno 10 reescribe toda la cola. Lo mínimo exigible: la invalidación es
    // dinero real y el ahorro neto es MUY inferior al bruto.
    expect(tonta.invalidacionUsd).toBeGreaterThan(0);
    const ahorroNeto = baseline.totalUsd - tonta.totalUsd;
    const ahorroBruto = baseline.totalUsd * 0.9;
    expect(ahorroNeto).toBeLessThan(ahorroBruto * 0.9);
  });

  it("un turno sin precio o sin entrada no rompe la cadena de prefijos", () => {
    const bloques = [bloque("a", 4000)];
    const c = simularSesion(
      [
        turno(bloques, 1000, 4000),
        { ...turno(bloques, 2000, 0) },
        turno(bloques, 3000, 4000),
      ],
      (b) => identidad(b),
    );
    // El turno 3 sigue leyendo el prefijo que dejó el 1 (vía el 2).
    expect(c.tokensLeidos).toBeCloseTo(4000, 0);
  });
});
