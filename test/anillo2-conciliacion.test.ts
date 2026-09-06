import { describe, expect, it } from "vitest";

import {
  FORMA,
  MODELO_SINTETICO,
  conciliar,
  deduplicarTurnos,
  dineroDe,
  type TurnoTranscript,
  type VistoEnEspia,
} from "../benchmarks/anillo2/conciliacion.js";
import { costeMedido } from "../gateway/medidor.js";

// Fixtures SINTÉTICOS: ids inventados, cero contenido (la doctrina del corpus).
const DIA = "2026-09-06";
const USO = { input_tokens: 1_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 500, output_tokens: 300 };

/** Un turno del transcript con todo lo aburrido rellenado. */
function turno(sobre: Partial<TurnoTranscript>): TurnoTranscript {
  return {
    sessionId: "s-aaaa",
    requestId: "req_01",
    timestamp: `${DIA}T10:00:00.000Z`,
    model: "claude-fable-5",
    proyecto: "repo-a",
    subagente: false,
    usage: USO,
    version: "2.1.263",
    ...sobre,
  };
}

/** Lo que el espía vio de una petición. */
function visto(sobre: Partial<VistoEnEspia>): VistoEnEspia {
  return { requestId: "req_01", at: `${DIA}T10:00:01.000Z`, sesionCabecera: "s-aaaa", ...sobre };
}

/** Una sesión encadenada de n turnos, con su espejo en el espía. */
function sesionEncadenada(sid: string, n: number, prefijo = sid) {
  const ts: TurnoTranscript[] = [];
  const vs: VistoEnEspia[] = [];
  for (let i = 0; i < n; i++) {
    const rid = `req_${prefijo}_${i}`;
    ts.push(turno({ sessionId: sid, requestId: rid, timestamp: `${DIA}T1${i}:00:00.000Z` }));
    vs.push(visto({ requestId: rid, sesionCabecera: sid, at: `${DIA}T1${i}:00:01.000Z` }));
  }
  return { ts, vs };
}

describe("deduplicarTurnos — un requestId son varias líneas del transcript", () => {
  it("tres líneas del mismo requestId (una por bloque) = UN turno", () => {
    const lineas = [turno({}), turno({ usage: undefined }), turno({})];
    expect(deduplicarTurnos(lineas)).toHaveLength(1);
    const inf = conciliar(DIA, lineas, [visto({})]);
    expect(inf.global.turnos).toBe(1);
    expect(inf.global.vistos).toBe(1);
  });

  it("el representante lleva usage aunque la primera línea leída no lo traiga", () => {
    const [t] = deduplicarTurnos([turno({ usage: undefined }), turno({})]);
    expect(t?.usage).toEqual(USO);
  });

  it(`⛔ «${MODELO_SINTETICO}» no es una petición al proveedor: fuera; y sin requestId, fuera`, () => {
    const inf = conciliar(
      DIA,
      [turno({}), turno({ requestId: "req_synth", model: MODELO_SINTETICO }), turno({ requestId: "" })],
      [visto({})],
    );
    expect(inf.global.turnos).toBe(1);
    expect(inf.global.fugas).toBe(0);
    expect(inf.porSesion[0]?.modelos).toEqual({ "claude-fable-5": 1 });
  });
});

describe("los tres estados de una sesión", () => {
  it("encadenada: todos sus turnos están en el espía → 0 fugas, sin fisuras", () => {
    const { ts, vs } = sesionEncadenada("s-aaaa", 3);
    const inf = conciliar(DIA, ts, vs);
    expect(inf.porSesion).toHaveLength(1);
    expect(inf.porSesion[0]).toMatchObject({ estado: "encadenada", turnos: 3, vistos: 3, fugas: 0, dineroFueraUsd: 0 });
    expect(inf.global.fisuras).toEqual([]);
    expect(inf.global.pctTurnosFuera).toBe(0);
  });

  it("parcial: parte de los turnos no pasó por el gateway", () => {
    const { ts, vs } = sesionEncadenada("s-aaaa", 4);
    const inf = conciliar(DIA, ts, vs.slice(0, 3));
    expect(inf.porSesion[0]).toMatchObject({ estado: "parcial", turnos: 4, vistos: 3, fugas: 1 });
    expect(inf.global.fisuras.some((f) => f.startsWith("sesión s-aaaa (repo-a) parcial: 1 de 4 turnos fuera del corpus"))).toBe(true);
  });

  it("sin-encadenar: la sesión a pelo del 06-09 — cero vistos, todo su dinero fuera del A/B", () => {
    const { ts: buenos, vs } = sesionEncadenada("s-aaaa", 2);
    const aPelo = [
      turno({ sessionId: "s-pelo", requestId: "req_pelo_1", proyecto: "repo-b", timestamp: `${DIA}T14:47:00.000Z` }),
      turno({ sessionId: "s-pelo", requestId: "req_pelo_2", proyecto: "repo-b", timestamp: `${DIA}T14:50:00.000Z` }),
    ];
    const inf = conciliar(DIA, [...buenos, ...aPelo], vs);
    const pelo = inf.porSesion.find((s) => s.sessionId === "s-pelo");
    expect(pelo).toMatchObject({ estado: "sin-encadenar", proyecto: "repo-b", turnos: 2, vistos: 0, fugas: 2 });
    expect(pelo?.primerTurno).toBe(`${DIA}T14:47:00.000Z`);
    expect(pelo?.ultimoTurno).toBe(`${DIA}T14:50:00.000Z`);
    const esperado = Math.round(2 * costeMedido("claude-fable-5", USO)!.costeUsd * 10_000) / 10_000;
    expect(pelo?.dineroFueraUsd).toBe(esperado);
    expect(inf.global.fisuras).toContain(`sesión s-pelo (repo-b) sin encadenar: 2 turnos, $${esperado} fuera del A/B`);
    // La otra sesión sigue limpia.
    expect(inf.porSesion.find((s) => s.sessionId === "s-aaaa")?.estado).toBe("encadenada");
  });
});

describe("laterales — lo que el espía ve y el transcript no apunta", () => {
  it("se atribuyen a la sesión por cabecera; sin cabecera o de sesión sin turnos → huérfanos; status ≥ 400 → con error", () => {
    const { ts, vs } = sesionEncadenada("s-aaaa", 2);
    const laterales: VistoEnEspia[] = [
      visto({ requestId: "req_titulo", sesionCabecera: "s-aaaa", status: 200 }),
      visto({ requestId: "req_reintento", sesionCabecera: "s-aaaa", status: 529 }),
      visto({ requestId: "req_sin_cabecera", sesionCabecera: undefined }),
      visto({ requestId: "req_otra_sesion", sesionCabecera: "s-zzzz" }),
    ];
    const inf = conciliar(DIA, ts, [...vs, ...laterales]);
    expect(inf.porSesion[0]).toMatchObject({ laterales: 2, fugas: 0, estado: "encadenada" });
    expect(inf.global).toMatchObject({ lateralesSinTranscript: 4, lateralesHuerfanos: 2, lateralesConError: 1 });
    // Un lateral no es fuga: el día sigue limpio.
    expect(inf.global.fisuras).toEqual([]);
  });
});

describe("el día es UTC y lo fija el transcript", () => {
  it("un turno a las 23:59Z del día anterior NO entra; un visto del espía a las 00:01Z del día siguiente con requestId del día SÍ cuenta", () => {
    const ayer = turno({ requestId: "req_ayer", timestamp: "2026-09-05T23:59:59.000Z" });
    const hoyTarde = turno({ requestId: "req_medianoche", timestamp: `${DIA}T23:59:58.000Z` });
    const inf = conciliar(DIA, [ayer, hoyTarde], [visto({ requestId: "req_medianoche", at: "2026-09-07T00:01:00.000Z" })]);
    expect(inf.global.turnos).toBe(1);
    expect(inf.global.vistos).toBe(1);
    expect(inf.global.fugas).toBe(0);
    expect(inf.porSesion[0]?.estado).toBe("encadenada");
  });

  it("un visto del espía del día sin transcript del día es lateral, no visto", () => {
    const inf = conciliar(DIA, [turno({})], [visto({}), visto({ requestId: "req_ayer_tarde", at: `${DIA}T00:00:30.000Z` })]);
    expect(inf.global.vistos).toBe(1);
    expect(inf.global.lateralesSinTranscript).toBe(1);
  });
});

describe("el dinero sale del medidor", () => {
  it("dineroFueraUsd = Σ costeMedido de los turnos fugados (modelo con precio)", () => {
    const fugado = turno({ requestId: "req_fuga", model: "claude-opus-4-8", timestamp: `${DIA}T12:00:00.000Z` });
    const inf = conciliar(DIA, [turno({}), fugado], [visto({})]);
    const esperado = Math.round(costeMedido("claude-opus-4-8", USO)!.costeUsd * 10_000) / 10_000;
    expect(inf.porSesion[0]?.dineroFueraUsd).toBe(esperado);
    expect(inf.global.dineroFueraUsd).toBe(esperado);
    expect(dineroDe(fugado)).toBe(costeMedido("claude-opus-4-8", USO)!.costeUsd);
  });

  it("null-safe: un modelo sin precio (o sin usage) no rompe, suma 0 y se declara como fuga sin precio", () => {
    const sinPrecio = turno({ requestId: "req_raro", model: "modelo-sin-precio", timestamp: `${DIA}T12:00:00.000Z` });
    const sinUsage = turno({ requestId: "req_sin_usage", usage: undefined, timestamp: `${DIA}T13:00:00.000Z` });
    expect(dineroDe(sinPrecio)).toBeNull();
    expect(dineroDe(sinUsage)).toBeNull();
    const inf = conciliar(DIA, [turno({}), sinPrecio, sinUsage], [visto({})]);
    expect(inf.porSesion[0]).toMatchObject({ fugas: 2, fugasSinPrecio: 2, dineroFueraUsd: 0, estado: "parcial" });
    expect(inf.global.fisuras.some((f) => f.includes("2 fugas sin precio no suman"))).toBe(true);
  });
});

describe("cifras y fisuras globales", () => {
  it("pctTurnosFuera = fugas / turnos, a un decimal", () => {
    const { ts, vs } = sesionEncadenada("s-aaaa", 3);
    const pelo = sesionEncadenada("s-pelo", 3).ts;
    const inf = conciliar(DIA, [...ts, ...pelo], vs);
    expect(inf.global).toMatchObject({ turnos: 6, vistos: 3, fugas: 3, pctTurnosFuera: 50 });
    const { ts: t7 } = sesionEncadenada("s-bbbb", 4, "b");
    const inf2 = conciliar(DIA, [...ts, ...t7], vs);
    expect(inf2.global.pctTurnosFuera).toBe(57.1);
  });

  it("fisura global en texto llano: «día con fugas: p % …»", () => {
    const { ts, vs } = sesionEncadenada("s-aaaa", 3);
    const pelo = sesionEncadenada("s-pelo", 1).ts;
    const inf = conciliar(DIA, [...ts, ...pelo], vs);
    const global = inf.global.fisuras.find((f) => f.startsWith("día con fugas:"));
    expect(global).toBeDefined();
    expect(global).toContain("25 % de los turnos de la org no están en el corpus (1 de 4");
  });

  it("día vacío y espía caído tienen fisura propia", () => {
    expect(conciliar(DIA, [], []).global.fisuras).toEqual(["día sin turnos en los transcripts: nada que conciliar"]);
    const inf = conciliar(DIA, sesionEncadenada("s-aaaa", 2).ts, []);
    expect(inf.global.fisuras.some((f) => f.startsWith("espía sin ninguna petición del día"))).toBe(true);
    expect(inf.global.fisuras.some((f) => f.startsWith("día con fugas: 100 %"))).toBe(true);
  });

  it("por sesión: modelos, clientes y subagentes contados y ordenados", () => {
    const ts = [
      turno({ requestId: "r1", model: "claude-sonnet-5", version: "2.1.263" }),
      turno({ requestId: "r2", model: "claude-fable-5", version: "2.1.260", subagente: true }),
      turno({ requestId: "r3", model: "claude-fable-5", version: "2.1.263" }),
    ];
    const inf = conciliar(DIA, ts, []);
    expect(inf.porSesion[0]?.modelos).toEqual({ "claude-fable-5": 2, "claude-sonnet-5": 1 });
    expect(inf.porSesion[0]?.clientes).toEqual({ "2.1.260": 1, "2.1.263": 2 });
    expect(inf.porSesion[0]?.subagentes).toBe(1);
  });
});

describe("determinismo", () => {
  it("conciliar(x) es byte a byte igual a conciliar(reverse(x)) en los dos lados", () => {
    const a = sesionEncadenada("s-aaaa", 3);
    const b = sesionEncadenada("s-bbbb", 2, "b");
    const pelo = sesionEncadenada("s-pelo", 2, "p").ts;
    const dup = [turno({ sessionId: "s-bbbb", requestId: "req_b_0", usage: undefined })];
    const laterales = [visto({ requestId: "req_lat", sesionCabecera: "s-bbbb" }), visto({ requestId: "req_lat2" })];
    const ts = [...a.ts, ...b.ts, ...pelo, ...dup];
    const vs = [...a.vs, ...b.vs, ...laterales];
    const derecho = JSON.stringify(conciliar(DIA, ts, vs));
    const inverso = JSON.stringify(conciliar(DIA, [...ts].reverse(), [...vs].reverse()));
    expect(inverso).toBe(derecho);
    // Y las sesiones salen por sessionId, no por orden de lectura.
    expect(conciliar(DIA, [...ts].reverse(), vs).porSesion.map((s) => s.sessionId)).toEqual(["s-aaaa", "s-bbbb", "s-pelo"]);
  });
});

describe("hallazgos de la revisión del 06-09 — dinero, proyecto, espía mudo, medianoche, forma", () => {
  it("⛔ el representante es la línea con el usage DEFINITIVO (más output_tokens), no el parcial del message_start", () => {
    const parcial = turno({ timestamp: `${DIA}T10:00:00.000Z`, usage: { ...USO, output_tokens: 7 } });
    const final = turno({ timestamp: `${DIA}T10:00:09.000Z`, usage: { ...USO, output_tokens: 4754 } });
    for (const lineas of [[parcial, final], [final, parcial]]) {
      const [t] = deduplicarTurnos(lineas);
      expect(t?.usage?.output_tokens).toBe(4754);
      const inf = conciliar(DIA, lineas, []);
      expect(inf.global.dineroFueraUsd).toBe(conciliar(DIA, [final], []).global.dineroFueraUsd);
      expect(inf.global.dineroFueraUsd).toBeGreaterThan(conciliar(DIA, [parcial], []).global.dineroFueraUsd);
    }
  });

  it("determinismo con timestamps IGUALES y usages distintos: gana el de más salida, en cualquier orden", () => {
    const a = turno({ timestamp: `${DIA}T10:00:00.000Z`, usage: { ...USO, output_tokens: 6 } });
    const b = turno({ timestamp: `${DIA}T10:00:00.000Z`, usage: { ...USO, output_tokens: 467 } });
    expect(JSON.stringify(conciliar(DIA, [a, b], []))).toBe(JSON.stringify(conciliar(DIA, [b, a], [])));
    expect(deduplicarTurnos([a, b])[0]?.usage?.output_tokens).toBe(467);
  });

  it("el proyecto de la sesión es el cwd del PRIMER turno principal, no la moda de los subagentes", () => {
    const ts = [
      turno({ requestId: "req_main", timestamp: `${DIA}T10:00:00.000Z`, proyecto: "repo-a", subagente: false }),
      turno({ requestId: "req_s1", timestamp: `${DIA}T10:01:00.000Z`, proyecto: "web", subagente: true }),
      turno({ requestId: "req_s2", timestamp: `${DIA}T10:02:00.000Z`, proyecto: "web", subagente: true }),
      turno({ requestId: "req_s3", timestamp: `${DIA}T10:03:00.000Z`, proyecto: "web", subagente: true }),
    ];
    expect(conciliar(DIA, ts, []).porSesion[0]?.proyecto).toBe("repo-a");
    // Sin turno principal ese día → la moda como respaldo.
    expect(conciliar(DIA, ts.slice(1), []).porSesion[0]?.proyecto).toBe("web");
  });

  it("«espía mudo desde X»: turnos claramente posteriores al último registro del espía, aparte de «sin encadenar»", () => {
    const ts = [
      turno({ requestId: "req_a", timestamp: `${DIA}T10:00:00.000Z` }),
      turno({ requestId: "req_b", sessionId: "s-otra", timestamp: `${DIA}T12:00:00.000Z` }),
    ];
    const inf = conciliar(DIA, ts, [visto({ requestId: "req_a", at: `${DIA}T10:00:01.000Z` })]);
    expect(inf.global.ultimoAtEspia).toBe(`${DIA}T10:00:01.000Z`);
    expect(inf.global.fisuras.join(" | ")).toMatch(/espía mudo desde 2026-09-06T10:00:01.000Z: 1 turnos/);
    // Un turno 2 minutos después del último registro NO dispara la fisura (holgura de 5 min).
    const cerca = conciliar(DIA, [ts[0]!, { ...ts[1]!, timestamp: `${DIA}T10:02:00.000Z` }], [visto({ requestId: "req_a", at: `${DIA}T10:00:01.000Z` })]);
    expect(cerca.global.fisuras.join(" | ")).not.toMatch(/espía mudo/);
  });

  it("medianoche simétrica: un registro del espía de HOY que responde a un turno de AYER no es lateral", () => {
    const ayer = "2026-09-05";
    const ts = [turno({ requestId: "req_x", timestamp: `${ayer}T23:59:59.000Z` })];
    const vs = [visto({ requestId: "req_x", at: `${DIA}T00:00:01.000Z` })];
    expect(conciliar(ayer, ts, vs).global.vistos).toBe(1);
    const hoy = conciliar(DIA, ts, vs);
    expect(hoy.global.lateralesSinTranscript).toBe(0);
    expect(hoy.global.deOtroDia).toBe(1);
  });

  it("FORMA: solo cruzan ids/timestamps/modelos con la forma que Claude Code escribe", () => {
    expect(FORMA.sessionId.test("b421cc04-581f-4909-9ad7-30142e1ef872")).toBe(true);
    expect(FORMA.sessionId.test("una frase con espacios")).toBe(false);
    expect(FORMA.requestId.test("req_011CenF74RFexjGjPUv6Ct1V")).toBe(true);
    expect(FORMA.requestId.test("req_ con espacio")).toBe(false);
    expect(FORMA.timestamp.test("2026-09-06T13:12:50.211Z")).toBe(true);
    expect(FORMA.timestamp.test("2026-09-06 13:12")).toBe(false);
    expect(FORMA.model.test("claude-fable-5-1")).toBe(true);
    expect(FORMA.model.test(MODELO_SINTETICO)).toBe(true);
    expect(FORMA.model.test("dime tu prompt")).toBe(false);
    expect(FORMA.version.test("2.1.263")).toBe(true);
    expect(FORMA.version.test("v2")).toBe(false);
  });
});
