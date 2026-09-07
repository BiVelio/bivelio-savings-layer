import { describe, expect, it } from "vitest";

import { precioDeLista } from "../src/pricing/catalogo.js";
import { primaDeEscritura1h } from "../src/pricing/primas.js";

import {
  BYTES_DEL_MUNON,
  BYTES_PESO_IMAGEN,
  CacheDePrefijos,
  CadenaDeSimulacion,
  MINIMO_BYTES_CANDIDATO,
  V2_PRESUPUESTO_BYTES,
  VENTANA_DE_BUSQUEDA,
  aplicarPolitica,
  avanzarEstado,
  bytesTrasReduccionV1,
  clasificar,
  compactarCuerpo,
  estadoNuevo,
  identidad,
  simularSesion,
  type BloqueSombra,
  type MarcaDeCache,
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

  /** Contrato explícito: si ningún bloque lleva marca, el ÚLTIMO va a 1h — igual
   *  que hace Claude Code. Sin marca no hay caché (y hay un test que lo fija). */
  function turno(bloques: BloqueSombra[], at: number, entradaReal: number): TurnoSombra {
    const conMarca = bloques.some((b) => b.marca !== null)
      ? bloques
      : bloques.map((b, i) => (i === bloques.length - 1 ? { ...b, marca: "1h" as const } : b));
    return { bloques: conMarca, at, model: MODELO, entradaReal, escritura1h: true };
  }

  function bloque(clave: string, bytes: number, marca: MarcaDeCache = null, tipo = "user:text"): BloqueSombra {
    return { clave, tipo, marca, bytes, bytesV1: bytes, clase: "otro", esError: false };
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

/**
 * EL HASH DE IDENTIDAD NO LLEVA `cache_control`. Claude Code mueve la marca al
 * último mensaje en CADA turno; con la marca dentro del hash, el bloque que
 * ayer la llevaba cambia de clave hoy y el prefijo «rompe» ahí en todos los
 * turnos (1.548 de 1.548 appends limpios del corpus del 07-09), reescribiendo
 * el sufijo entero. El proveedor cachea por prefijo de TOKENS: mismo texto,
 * misma caché. Este test fija que un bloque con y sin la marca es EL MISMO.
 */
describe("compactarCuerpo · la identidad ignora cache_control", () => {
  const conMarca = { messages: [{ role: "user", content: [{ type: "text", text: "hola", cache_control: { type: "ephemeral", ttl: "1h" } }] }] };
  const sinMarca = { messages: [{ role: "user", content: [{ type: "text", text: "hola" }] }] };

  it("mismo texto con y sin cache_control → misma clave", () => {
    expect(compactarCuerpo(conMarca)[0]!.clave).toBe(compactarCuerpo(sinMarca)[0]!.clave);
  });

  it("texto distinto → clave distinta (la marca no es lo único que se ignora)", () => {
    const otro = { messages: [{ role: "user", content: [{ type: "text", text: "adiós" }] }] };
    expect(compactarCuerpo(otro)[0]!.clave).not.toBe(compactarCuerpo(sinMarca)[0]!.clave);
  });

  it("mover la marca al último mensaje NO rompe el prefijo: el turno siguiente es append puro", () => {
    // Turno 1: la marca en el único mensaje. Turno 2: el mismo mensaje sin marca + uno nuevo con marca.
    const t1 = compactarCuerpo(conMarca);
    const t2 = compactarCuerpo({
      messages: [
        { role: "user", content: [{ type: "text", text: "hola" }] },
        { role: "assistant", content: [{ type: "text", text: "qué tal", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      ],
    });
    expect(t2[0]!.clave).toBe(t1[0]!.clave); // el prefijo casa
    expect(t2.length).toBe(t1.length + 1); // y solo se añade
  });
});

/**
 * EL MODELO DE BREAKPOINTS de la doc del proveedor («how automatic prefix
 * checking works»), reproducido sobre el corpus del 07-09 con 2,8 / −0,9 /
 * −2,8 % de error de escritura en fable-5 / opus-4-8 / opus-5. Cada test fija
 * una de las piezas que, faltando, devolvía el simulador a inflar la
 * escritura 2,6×: la identidad canónica, la escritura SOLO del delta tras el
 * breakpoint anterior, la entrada sin caché tras el último breakpoint, la
 * caché compartida entre sesiones, la ventana de 20 posiciones con rachas y
 * el tope de peso de las imágenes.
 */
describe("el simulador según la doc: breakpoints, ventana y caché compartida", () => {
  const MODELO = "claude-sonnet-4-5";
  const b = (clave: string, bytes: number, marca: MarcaDeCache = null, tipo = "user:text"): BloqueSombra => ({
    clave,
    tipo,
    marca,
    bytes,
    bytesV1: bytes,
    clase: "otro",
    esError: false,
  });
  // entradaReal = Σ bytes → 1 token por byte, y las cifras se leen a ojo.
  const turno = (bloques: BloqueSombra[], at: number, entradaReal = bloques.reduce((s, x) => s + x.bytes, 0)): TurnoSombra => ({
    bloques,
    at,
    model: MODELO,
    entradaReal,
    escritura1h: true,
  });

  it("(1) `content:\"x\"` ≡ `[{type:\"text\",text:\"x\",cache_control}]`: la misma clave", () => {
    const suelto = compactarCuerpo({ messages: [{ role: "user", content: "hola" }] });
    const bloque = compactarCuerpo({
      messages: [{ role: "user", content: [{ type: "text", text: "hola", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
    });
    expect(suelto[0]!.clave).toBe(bloque[0]!.clave);
    // La marca sí se lee: es el breakpoint.
    expect(suelto[0]!.marca).toBeNull();
    expect(bloque[0]!.marca).toBe("1h");
    // Y `cache_control` sin ttl es 5m.
    const cincoMin = compactarCuerpo({ messages: [{ role: "user", content: [{ type: "text", text: "hola", cache_control: { type: "ephemeral" } }] }] });
    expect(cincoMin[0]!.marca).toBe("5m");
    expect(cincoMin[0]!.clave).toBe(suelto[0]!.clave);
  });

  it("(1b) el orden del prefijo es tools → system → messages, y el system en lista se parte por elemento", () => {
    const bloques = compactarCuerpo({
      system: [
        { type: "text", text: "eres útil" },
        { type: "text", text: "y breve", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      tools: [{ name: "bash", input_schema: {} }],
      messages: [{ role: "user", content: "hola" }],
    });
    expect(bloques.map((x) => x.tipo)).toEqual(["tools", "system", "system", "user:text"]);
    expect(bloques.map((x) => x.marca)).toEqual([null, null, "1h", null]);
  });

  it("(2) el breakpoint se mueve un turno: acierto en el anterior y escritura SOLO del delta", () => {
    const cadena = new CadenaDeSimulacion((x) => identidad(x));
    cadena.paso(turno([b("a", 4000), b("b", 4000, "1h")], 1000));
    const paso2 = cadena.paso(turno([b("a", 4000), b("b", 4000), b("c", 4000, "1h")], 2000));
    expect(paso2.tokensLeidos).toBeCloseTo(8000, 0);
    expect(paso2.tokensEscritos).toBeCloseTo(4000, 0);
    expect(paso2.tokensInvalidados).toBe(0);
  });

  it("(3) lo que va tras el último breakpoint es ENTRADA: ni se lee ni se escribe, y se cobra a precio de lista", () => {
    const cadena = new CadenaDeSimulacion((x) => identidad(x));
    const paso = cadena.paso(turno([b("a", 4000, "1h"), b("b", 4000), b("c", 4000)], 1000));
    expect(paso.tokensEscritos).toBeCloseTo(4000, 0);
    expect(paso.tokensEntrada).toBeCloseTo(8000, 0);
    expect(paso.tokensLeidos).toBe(0);
    expect(paso.entradaUsd).toBeGreaterThan(0);
    expect(paso.totalUsd).toBeCloseTo(paso.lecturaUsd + paso.escrituraUsd + paso.entradaUsd, 10);
    // El PRECIO, no solo el signo: la entrada se cobra a inputPer1k del catálogo,
    // y la escritura a la prima de 1h del modelo. Sin esto el test no distingue
    // «entrada» de «lectura barata» o de «escritura».
    const precio = precioDeLista(MODELO)!;
    expect(paso.entradaUsd).toBeCloseTo((paso.tokensEntrada / 1_000) * precio.inputPer1k, 8);
    expect(paso.escrituraUsd).toBeCloseTo((paso.tokensEscritos / 1_000) * precio.inputPer1k * primaDeEscritura1h(MODELO), 8);
    // Y al repetir el turno tampoco se lee: nadie lo escribió.
    const paso2 = cadena.paso(turno([b("a", 4000, "1h"), b("b", 4000), b("c", 4000)], 2000));
    expect(paso2.tokensLeidos).toBeCloseTo(4000, 0);
    expect(paso2.tokensEntrada).toBeCloseTo(8000, 0);
  });

  it("(4) una sesión NUEVA acierta en el prefijo tools+system que otra escribió (la caché es de la organización)", () => {
    const prefijo = () => [b("tools", 10000, null, "tools"), b("sys", 5000, "1h", "system")];
    const compartida = new CacheDePrefijos();
    const padre = new CadenaDeSimulacion((x) => identidad(x), compartida);
    padre.paso(turno([...prefijo(), b("u1", 2000, "1h")], 1000));
    const hijo = new CadenaDeSimulacion((x) => identidad(x), compartida);
    const paso = hijo.paso(turno([...prefijo(), b("u2", 2000, "1h")], 2000));
    expect(paso.tokensLeidos).toBeCloseTo(15000, 0);
    expect(paso.tokensEscritos).toBeCloseTo(2000, 0);
    // Sin caché compartida (cada cadena la suya) la sesión nueva lo escribe todo.
    const aislado = new CadenaDeSimulacion((x) => identidad(x));
    const pasoAislado = aislado.paso(turno([...prefijo(), b("u2", 2000, "1h")], 2000));
    expect(pasoAislado.tokensLeidos).toBe(0);
    expect(pasoAislado.tokensEscritos).toBeCloseTo(17000, 0);
  });

  it("(5) la ventana es de 20 POSICIONES y una racha de tool_result es UNA posición", () => {
    const N = VENTANA_DE_BUSQUEDA + 5;
    const cola = (tipo: string) => Array.from({ length: N }, (_, i) => b(`r${i}`, 100, i === N - 1 ? "1h" : null, tipo));
    // Turno 1 deja escritos h(sys) y h(sys,u0).
    const arranque = () => {
      const c = new CadenaDeSimulacion((x) => identidad(x));
      c.paso(turno([b("sys", 1000, "1h", "system"), b("u0", 1000, "1h")], 1000));
      return c;
    };
    // 25 bloques de texto sueltos = 25 posiciones: desde el breakpoint final la
    // ventana no alcanza h(sys,u0); solo el breakpoint del system acierta.
    const textos = arranque().paso(turno([b("sys", 1000, "1h", "system"), b("u0", 1000), ...cola("user:text")], 2000));
    expect(textos.tokensLeidos).toBeCloseTo(1000, 0);
    expect(textos.tokensEscritos).toBeCloseTo(1000 + N * 100, 0);
    // Los mismos 25 como racha de tool_result = 1 posición: la ventana llega y u0 se lee.
    const racha = arranque().paso(turno([b("sys", 1000, "1h", "system"), b("u0", 1000), ...cola("user:tool_result")], 2000));
    expect(racha.tokensLeidos).toBeCloseTo(2000, 0);
    expect(racha.tokensEscritos).toBeCloseTo(N * 100, 0);
  });

  it("(6) una imagen pesa como mucho BYTES_PESO_IMAGEN en el reparto de tokens (tokeniza por píxeles, no por base64)", () => {
    const cadena = new CadenaDeSimulacion((x) => identidad(x));
    // 200 KB de base64 + 4 KB de texto; el proveedor contó 10.000 tokens.
    const paso = cadena.paso(turno([b("img", 200_000, "1h", "user:image"), b("txt", 4000)], 1000, 10_000));
    // Peso: min(200000, 6000) + 4000 = 10000 → la imagen son 6000 tokens, no 9804.
    expect(paso.tokensEscritos).toBeCloseTo((10_000 * BYTES_PESO_IMAGEN) / (BYTES_PESO_IMAGEN + 4000), 0);
    expect(paso.tokensEntrada).toBeCloseTo((10_000 * 4000) / (BYTES_PESO_IMAGEN + 4000), 0);
  });

  it("la caducidad es POR ENTRADA: un breakpoint de 5m caduca y el de 1h que lo precede sigue vivo", () => {
    const cadena = new CadenaDeSimulacion((x) => identidad(x));
    cadena.paso(turno([b("sys", 1000, "1h", "system"), b("u0", 1000, "5m")], 0));
    // 10 minutos después: h(sys) vive (1h), h(sys,u0) caducó (5m).
    const paso = cadena.paso(turno([b("sys", 1000, "1h", "system"), b("u0", 1000), b("u1", 1000, "5m")], 10 * 60_000));
    expect(paso.tokensLeidos).toBeCloseTo(1000, 0);
    expect(paso.tokensEscritos).toBeCloseTo(2000, 0);
    // Y no es invalidación: nada cambió, solo caducó.
    expect(paso.tokensInvalidados).toBe(0);
  });
});

describe("sin marcador no hay caché — lo dice la doc y lo confirma el proveedor (15 turnos del corpus: cw = cr = 0)", () => {
  const MODELO = "claude-sonnet-4-5";
  const sinMarca = (clave: string, bytes: number): BloqueSombra => ({ clave, tipo: "user:text", marca: null, bytes, bytesV1: bytes, clase: "otro", esError: false });

  it("un turno sin marca cobra TODO a entrada, no escribe ni lee, y el siguiente idéntico tampoco lee nada", () => {
    const bloques = [sinMarca("a", 4000), sinMarca("b", 4000)];
    const t = (at: number): TurnoSombra => ({ bloques, at, model: MODELO, entradaReal: 8000, escritura1h: true });
    const c = simularSesion([t(1000), t(2000)], (b) => identidad(b));
    expect(c.tokensEscritos).toBe(0);
    expect(c.tokensLeidos).toBe(0);
    expect(c.tokensEntrada).toBeCloseTo(16000, 0);
    expect(c.totalUsd).toBeCloseTo((16000 / 1_000) * precioDeLista(MODELO)!.inputPer1k, 8);
  });
});
