import { describe, it, expect } from "vitest";

import {
  CODIGO_CAVEMAN,
  aToon,
  aplicarCapa,
  comprimirProsa,
  detectarForma,
  opcionesDeEntorno,
  toonSiEsJson,
} from "../gateway/caveman.js";

/**
 * LAS PRUEBAS DE LA CAPA INTERMEDIA.
 *
 * Esta capa reescribe la petición de un cliente antes de que salga hacia el
 * modelo, así que su primer deber no es ahorrar: es **no romper nada**. La mayor
 * parte de lo que sigue comprueba que se mantiene quieta — ante un cuerpo que no
 * entiende, ante un JSON que no parsea, ante un bloque de código, ante una ruta
 * o un número.
 *
 * El segundo deber es ser AUDITABLE: cada cambio declara dónde se hizo y cuántos
 * caracteres movió, contados de verdad. Sin eso no hay dato empírico, solo fe.
 */

/** Una tabla de verdad: 40 filas homogéneas, que es donde TOON gana de verdad. */
const TABLA_GORDA = JSON.stringify(
  Array.from({ length: 40 }, (_, i) => ({ linea: i + 1, concepto: `servicio ${i}`, importe: 100 + i, base: "sin-iva" })),
);

const ANTHROPIC = {
  model: "claude-opus-5",
  system: [{ type: "text", text: "Eres un asistente." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Hola" }] },
    { role: "assistant", content: [{ type: "text", text: "Qué tal" }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: TABLA_GORDA },
        { type: "text", text: "Por favor, ten en cuenta que   esto   es  prosa.\n\n\n\nY más." },
      ],
    },
  ],
};

const OPENAI = {
  model: "gpt-5",
  messages: [
    { role: "system", content: "Eres un asistente." },
    { role: "user", content: "Hola" },
    { role: "assistant", content: "Qué tal" },
    { role: "tool", tool_call_id: "c1", content: TABLA_GORDA },
  ],
};

const clona = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const TODO = { caveman: true, toon: true } as const;

describe("detectar la forma del cuerpo · compatibilidad con cualquier cliente", () => {
  it("reconoce la forma de Anthropic por su `system` fuera de los mensajes", () => {
    expect(detectarForma(ANTHROPIC)).toBe("anthropic");
  });

  it("reconoce la forma de OpenAI por su `messages` plano con rol `tool`", () => {
    expect(detectarForma(OPENAI)).toBe("openai");
  });

  it("reconoce Anthropic también sin `system`, por los bloques con `type`", () => {
    expect(detectarForma({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] })).toBe("anthropic");
  });

  it("lo que no tiene `messages` es desconocido, y desconocido significa NO TOCAR", () => {
    expect(detectarForma({ prompt: "estilo viejo" })).toBe("desconocida");
    expect(detectarForma(null)).toBe("desconocida");
    const { cuerpo, informe } = aplicarCapa(JSON.stringify({ prompt: "x" }), TODO);
    expect(cuerpo).toBe(JSON.stringify({ prompt: "x" }));
    expect(informe.intacto).toContain("no reconocida");
  });
});

describe("la capa se mantiene quieta cuando debe", () => {
  it("apagada no toca ni un byte", () => {
    const antes = JSON.stringify(ANTHROPIC);
    const { cuerpo, informe } = aplicarCapa(antes, {});
    expect(cuerpo).toBe(antes);
    expect(informe.intacto).toBe("capa apagada");
  });

  it("un cuerpo que no es JSON (comprimido por el cliente) se deja pasar", () => {
    const { cuerpo, informe } = aplicarCapa(" binario", TODO);
    expect(cuerpo).toBe(" binario");
    expect(informe.intacto).toContain("no es JSON");
  });

  it("NO toca los mensajes anteriores: reescribir historia invalida el prefijo cacheado", () => {
    const { cuerpo } = aplicarCapa(JSON.stringify(clona(ANTHROPIC)), TODO);
    const json = JSON.parse(cuerpo);
    // El primer `user` y el `assistant` salen idénticos.
    expect(json.messages[0]).toEqual(ANTHROPIC.messages[0]);
    expect(json.messages[1]).toEqual(ANTHROPIC.messages[1]);
  });

  it("con el dial `alcanceToon: todo` SÍ reescribe historia — está ahí para poder refutarlo", () => {
    const conHistoria = clona(ANTHROPIC);
    conHistoria.messages[0] = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t0", content: TABLA_GORDA }],
    } as never;
    const { informe } = aplicarCapa(JSON.stringify(conHistoria), { toon: true, alcanceToon: "todo" });
    expect(informe.cambios.filter((c) => c.cual === "toon").length).toBeGreaterThan(1);
  });
});

describe("caveman · el código va al PREFIJO, que es lo que lo hacía perder", () => {
  it("en Anthropic el convenio entra al `system` y no a los mensajes", () => {
    const { cuerpo, informe } = aplicarCapa(JSON.stringify(clona(ANTHROPIC)), { caveman: true });
    const json = JSON.parse(cuerpo);
    expect(JSON.stringify(json.system)).toContain("CONVENIO DE ENTRADA COMPRIMIDA");
    expect(JSON.stringify(json.messages)).not.toContain("CONVENIO DE ENTRADA COMPRIMIDA");
    expect(informe.cambios.find((c) => c.cual === "caveman-codigo")?.donde).toContain("system");
  });

  it("en OpenAI entra al mensaje `system` existente", () => {
    const { cuerpo } = aplicarCapa(JSON.stringify(clona(OPENAI)), { caveman: true });
    const json = JSON.parse(cuerpo);
    expect(json.messages[0].role).toBe("system");
    expect(json.messages[0].content).toContain("CONVENIO DE ENTRADA COMPRIMIDA");
  });

  it("y crea un `system` si el cliente no manda ninguno", () => {
    const { cuerpo } = aplicarCapa(JSON.stringify({ messages: [{ role: "user", content: "hola" }] }), { caveman: true });
    const json = JSON.parse(cuerpo);
    expect(json.messages[0]).toEqual({ role: "system", content: CODIGO_CAVEMAN });
  });

  it("★ NO lo añade dos veces: un convenio duplicado por turno es exactamente el fallo que mató a caveman", () => {
    const uno = aplicarCapa(JSON.stringify(clona(ANTHROPIC)), { caveman: true }).cuerpo;
    const dos = aplicarCapa(uno, { caveman: true });
    expect(dos.informe.cambios.some((c) => c.cual === "caveman-codigo")).toBe(false);
    expect((dos.cuerpo.match(/CONVENIO DE ENTRADA COMPRIMIDA/g) ?? []).length).toBe(1);
  });

  it("con el dial `dondeCodigo: turno` lo pega al turno — la variante medida y perdedora, reproducible", () => {
    const { cuerpo, informe } = aplicarCapa(JSON.stringify(clona(ANTHROPIC)), { caveman: true, dondeCodigo: "turno" });
    const json = JSON.parse(cuerpo);
    expect(JSON.stringify(json.system)).not.toContain("CONVENIO");
    expect(JSON.stringify(json.messages)).toContain("CONVENIO");
    expect(informe.cambios.find((c) => c.cual === "caveman-codigo")?.donde).toContain("por turno");
  });
});

describe("caveman · comprimir prosa sin corromper datos", () => {
  it("quita muletillas y colapsa espacios", () => {
    const s = comprimirProsa("Por favor,   ten en cuenta que  esto    es prosa.");
    expect(s).not.toContain("Por favor");
    expect(s).not.toContain("ten en cuenta que");
    expect(s).not.toMatch(/ {2}/);
  });

  it("★ NO toca un bloque de código, que es donde viven los datos", () => {
    const original = "mira esto:\n```ts\nconst a =   1; // por favor\n```\ny ya";
    const s = comprimirProsa(original);
    expect(s).toContain("const a =   1; // por favor");
  });

  it("★ NO toca números, rutas ni identificadores ni en modo telegráfico", () => {
    const original = "el importe es 12.480,55 en src/gateway/tarifa.ts con id F-2024-118";
    const s = comprimirProsa(original, "telegrafico");
    expect(s).toContain("12.480,55");
    expect(s).toContain("src/gateway/tarifa.ts");
    expect(s).toContain("F-2024-118");
  });

  it("el modo telegráfico comprime más que el prudente, y eso se puede comparar", () => {
    const t = "el resultado es la suma de los valores y la media de las filas";
    expect(comprimirProsa(t, "telegrafico").length).toBeLessThan(comprimirProsa(t, "prudente").length);
  });
});

describe("toon · solo gana donde de verdad gana", () => {
  it("un array de objetos homogéneos se vuelve tabla y escribe las claves UNA vez", () => {
    const toon = aToon([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
    expect(toon).toContain("tabla a,b:");
    expect((toon.match(/a,b/g) ?? []).length).toBe(1);
  });

  it("y es más corto que el JSON equivalente cuando la tabla es de verdad", () => {
    const filas = Array.from({ length: 40 }, (_, i) => ({ importe: 100 + i, base: "sin-iva", linea: `concepto ${i}` }));
    const json = JSON.stringify(filas);
    const toon = toonSiEsJson(json);
    expect(toon.length).toBeLessThan(json.length);
    expect(json.length - toon.length).toBeGreaterThan(200);
  });

  it("★ DOS umbrales: un objeto diminuto no se transforma aunque gane el 57 %", () => {
    // Ganar 4 caracteres no paga el coste de que el modelo aplique un convenio.
    const json = '{"a":1}';
    expect(toonSiEsJson(json)).toBe(json);
  });

  it("★ ni una tabla corta: gana en porcentaje pero no en bytes", () => {
    const json = JSON.stringify([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
    expect(toonSiEsJson(json)).toBe(json);
  });

  it("lo que no es JSON se devuelve intacto", () => {
    expect(toonSiEsJson("esto es texto normal")).toBe("esto es texto normal");
    expect(toonSiEsJson("{roto")).toBe("{roto");
  });

  it("un array heterogéneo no se tabula: tabular lo que no es tabla corrompe", () => {
    expect(aToon([{ a: 1 }, { b: 2 }])).not.toContain("tabla");
  });
});

describe("el patrón de context-mode · externalizar lo gigante", () => {
  it("por debajo del tope no dispara", () => {
    const { informe } = aplicarCapa(JSON.stringify(clona(ANTHROPIC)), { toon: true, externalizarDesde: 100_000 });
    expect(informe.cambios.some((c) => c.cual === "externalizado")).toBe(false);
  });

  it("por encima deja un puntero con su identificador y dice cuánto retuvo", () => {
    const gordo = clona(ANTHROPIC);
    (gordo.messages[2]!.content as { type: string; text?: string }[])[1]!.text = "x".repeat(5_000);
    const { cuerpo, informe } = aplicarCapa(JSON.stringify(gordo), { externalizarDesde: 1_000 });
    expect(cuerpo).toMatch(/⟦ref:ext-[a-z0-9]+⟧/);
    const c = informe.cambios.find((x) => x.cual === "externalizado");
    expect(c?.antes).toBeGreaterThan(c!.despues);
  });
});

describe("el informe es auditable, que es lo que lo hace un dato y no una promesa", () => {
  it("cuenta los caracteres del cuerpo antes y después, de verdad", () => {
    const antes = JSON.stringify(clona(ANTHROPIC));
    const { cuerpo, informe } = aplicarCapa(antes, TODO);
    expect(informe.cuerpoAntes).toBe(antes.length);
    expect(informe.cuerpoDespues).toBe(cuerpo.length);
  });

  it("cada cambio dice DÓNDE se hizo, para poder ir a mirarlo", () => {
    const { informe } = aplicarCapa(JSON.stringify(clona(ANTHROPIC)), TODO);
    expect(informe.cambios.length).toBeGreaterThan(0);
    for (const c of informe.cambios) expect(c.donde).toBeTruthy();
  });

  it("la petición sigue siendo JSON válido y conserva el modelo y las herramientas", () => {
    const conHerramientas = { ...clona(ANTHROPIC), tools: [{ name: "Bash", description: "corre" }] };
    const { cuerpo } = aplicarCapa(JSON.stringify(conHerramientas), TODO);
    const json = JSON.parse(cuerpo);
    expect(json.model).toBe("claude-opus-5");
    expect(json.tools).toEqual(conHerramientas.tools);
  });
});

describe("las banderas nacen APAGADAS", () => {
  it("sin entorno, todo apagado", () => {
    const o = opcionesDeEntorno({});
    expect(o.caveman).toBe(false);
    expect(o.toon).toBe(false);
    expect(o.externalizarDesde).toBe(0);
  });

  it("y los diales tienen por defecto la variante que NO perdió", () => {
    const o = opcionesDeEntorno({});
    expect(o.dondeCodigo).toBe("prefijo");
    expect(o.alcanceToon).toBe("turno");
    expect(o.agresividad).toBe("prudente");
  });

  it("el entorno puede pedir explícitamente la variante perdedora", () => {
    const o = opcionesDeEntorno({ BVSALA_GATEWAY_CAVEMAN_DONDE: "turno", BVSALA_GATEWAY_TOON_ALCANCE: "todo" });
    expect(o.dondeCodigo).toBe("turno");
    expect(o.alcanceToon).toBe("todo");
  });
});
