import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CATALOGO_DEL_BUCLE,
  correrSondas,
  escribir,
  mezclar,
  SONDAS,
  tocarUnByteDelSystem,
  type Tirada,
} from "../benchmarks/sondas/sondas.js";
import {
  costeDeUso,
  crearRed,
  hostPermitido,
  leerUso,
  limpiarSecretos,
  Presupuesto,
  PresupuestoAgotado,
  resumirCuerpo,
  TOPE_TOTAL_USD,
} from "../benchmarks/sondas/nucleo.js";

/**
 * LAS SONDAS EN VIVO, SIN RED: la guarda de hosts, el tope duro, la cuenta del
 * `usage` y la tirada entera contra los proveedores de mentira de seco.ts.
 */

describe("la red guardada", () => {
  it("solo los tres hosts oficiales, por https y en el puerto por defecto", () => {
    expect(hostPermitido("https://api.anthropic.com/v1/messages")).toBe(true);
    expect(hostPermitido("https://api.openai.com/v1/chat/completions")).toBe(true);
    expect(hostPermitido("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")).toBe(true);
    expect(hostPermitido("http://api.anthropic.com/v1/messages")).toBe(false);
    expect(hostPermitido("https://api.anthropic.com:8443/v1/messages")).toBe(false);
    expect(hostPermitido("https://api.anthropic.com.evil.example/v1")).toBe(false);
    expect(hostPermitido("https://savings.bivelio.com/api/metering/usage")).toBe(false);
  });

  it("un host fuera de la lista no sale: se apunta y lanza, sin tocar el fetch de verdad", async () => {
    let salio = 0;
    const red = crearRed((async () => {
      salio += 1;
      return new Response("{}");
    }) as unknown as typeof fetch, new Presupuesto(1));
    await expect(red.fetch("https://savings.bivelio.com/api/metering/usage", { method: "POST", body: "{}" })).rejects.toThrow(/no es uno de los hosts permitidos/);
    expect(salio).toBe(0);
    expect(red.hostsBloqueados).toEqual({ "savings.bivelio.com": 1 });
    expect(red.hostsVistos).toEqual({});
  });

  it("ninguna llamada empieza si su peor caso no cabe en el tope", async () => {
    let salio = 0;
    const p = new Presupuesto(0.0001);
    const red = crearRed((async () => {
      salio += 1;
      return new Response("{}");
    }) as unknown as typeof fetch, p);
    const cuerpo = JSON.stringify({ model: "claude-sonnet-5", max_tokens: 4096, messages: [{ role: "user", content: "hola" }] });
    await expect(red.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: cuerpo })).rejects.toBeInstanceOf(PresupuestoAgotado);
    expect(salio).toBe(0);
  });

  it("el tope nunca pasa de 5 $", () => {
    expect(TOPE_TOTAL_USD).toBe(5);
    expect(() => new Presupuesto(5.01)).toThrow();
    expect(() => new Presupuesto(0)).toThrow();
  });
});

describe("el coste según el usage", () => {
  const precio = { inputPer1k: 0.002, outputPer1k: 0.01, cachedInputPer1k: 0.0002 };

  it("Anthropic: lectura a la tarifa de caché, escritura de 5 min a 1,25× y de 1 h a 2×", () => {
    const u = leerUso("anthropic", {
      usage: {
        input_tokens: 1000,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 },
        output_tokens: 100,
      },
    })!;
    expect(u).toMatchObject({ entrada: 1000, lecturaCache: 2000, escrituraCache5m: 2000, escrituraCache1h: 1000, salida: 100 });
    expect(costeDeUso(u, precio)).toBeCloseTo(0.002 + 0.0004 + 0.005 + 0.004 + 0.001, 10);
  });

  it("OpenAI: los leídos y los escritos salen de prompt_tokens", () => {
    const u = leerUso("openai", {
      usage: { prompt_tokens: 5000, completion_tokens: 50, total_tokens: 5050, prompt_tokens_details: { cached_tokens: 3000, cache_write_tokens: 1000 } },
    })!;
    expect(u).toMatchObject({ entrada: 1000, lecturaCache: 3000, escrituraCache5m: 1000, salida: 50 });
  });

  it("Gemini: el pensamiento que solo está en total_tokens se factura como salida", () => {
    const u = leerUso("gemini", { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 170 } })!;
    expect(u).toMatchObject({ salida: 70, razonamiento: 50, salidaSinPensamiento: 20 });
  });
});

describe("el cable, resumido", () => {
  it("cuenta marcas de caché, tool_use, tool_result con is_error y pares de búsqueda reenviados", () => {
    const r = resumirCuerpo("anthropic", {
      model: "claude-haiku-4-5",
      tools: [{ name: "a" }, { name: "b", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: "hola" },
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_bm25", input: {} },
            { type: "tool_search_tool_result", tool_use_id: "srvtoolu_1", content: {} },
            { type: "tool_use", id: "toolu_1", name: "a", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x", is_error: true }] },
      ],
      diagnostics: { previous_message_id: null },
    });
    expect(r).toMatchObject({ herramientas: 2, marcasDeCache: 1, dondeMarcas: ["tools[1]"], toolUse: 1, toolResult: 1, isError: 1, paresDeBusquedaReenviados: 1 });
    expect(r.diagnostics).toEqual({ previous_message_id: null });
  });

  it("tocar un byte del system cambia exactamente un carácter", () => {
    const antes = { system: [{ type: "text", text: "Normas.", cache_control: { type: "ephemeral" } }] };
    const despues = tocarUnByteDelSystem(antes)!;
    const a = (antes.system[0] as { text: string }).text;
    const d = ((despues["system"] as { text: string }[])[0] as { text: string }).text;
    expect(d.length).toBe(a.length);
    expect([...a].filter((c, i) => c !== d[i]).length).toBe(1);
    expect(tocarUnByteDelSystem({ system: "abc" })).toEqual({ system: "ab." });
  });

  it("el catálogo del bucle pasa el mínimo cacheable de Haiku 4.5 (4.096) incluso contado por lo bajo", () => {
    const caracteres = JSON.stringify(CATALOGO_DEL_BUCLE.map(({ id, description, parameters }) => ({ id, description, parameters }))).length;
    expect(caracteres / 4).toBeGreaterThan(6000);
  });
});

describe("la tirada entera en seco", () => {
  it("las cinco sondas confirman contra los proveedores de mentira, sin salir de los tres hosts y sin claves en el informe", async () => {
    const t = await correrSondas({ vivo: false, solo: [...SONDAS], caducidad: false, salida: "", callado: true });
    expect(t.modo).toBe("seco");
    expect(t.hostsBloqueados).toEqual({});
    expect(Object.keys(t.hostsVistos).sort()).toEqual(["api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com"]);
    expect(t.gastoTotalUsd).toBeLessThan(TOPE_TOTAL_USD);
    for (const s of t.sondas) expect({ sonda: s.sonda, veredicto: s.veredicto, error: s.error }).toEqual({ sonda: s.sonda, veredicto: "confirma", error: undefined });

    const dir = mkdtempSync(join(tmpdir(), "bvsala-sondas-"));
    const secreto = "sk-ant-secreto-de-prueba-123456";
    const rutas = escribir({ ...t, avisosDeLaCapa: [...t.avisosDeLaCapa, `clave ${secreto}`] }, dir, [secreto]);
    const json = readFileSync(rutas.json, "utf8");
    expect(json).not.toContain(secreto);
    expect(readFileSync(rutas.md, "utf8")).toContain("| bucle |");
  }, 60_000);

  it("una tirada parcial sustituye solo sus sondas", () => {
    const base = (sondas: string[], gasto: number): Tirada => ({
      fecha: "2026-09-29T00:00:00Z",
      modo: "vivo",
      commit: null,
      paquete: { version: "x", como: "x" },
      topeUsd: 5,
      gastoTotalUsd: gasto,
      gastoPorSonda: {},
      hostsVistos: { "api.anthropic.com": 1 },
      hostsBloqueados: {},
      sondas: sondas.map((s) => ({ sonda: s as never, arreglos: [], veredicto: "confirma", resumen: s, hallazgos: [], datos: {}, gastoUsd: gasto, llamadas: 1 })),
      avisosDeLaCapa: [],
      llamadas: [],
    });
    const m = mezclar(base(["bucle", "gpt"], 0.5), base(["gpt"], 0.1));
    expect(m.sondas.map((s) => [s.sonda, s.gastoUsd])).toEqual([["bucle", 0.5], ["gpt", 0.1]]);
    expect(m.gastoTotalUsd).toBeCloseTo(0.6, 6);
    expect(m.hostsVistos["api.anthropic.com"]).toBe(2);
  });

  it("limpiarSecretos tapa las formas conocidas de clave", () => {
    expect(limpiarSecretos("x sk-proj-abcdefghijkl y AIzaSyA1234567890123456789012 z", [])).toBe("x [redacted] y [redacted] z");
  });
});
