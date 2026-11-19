import { describe, expect, it } from "vitest";
import { ExactTokenizer, registerExactTokenizer } from "../src/tokenizer/exact.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";

/**
 * A2-4 (segunda auditoría, 2026-11-19) · UNA TIRADA LARGA PARABA EL PROCESO.
 *
 * Con `gpt-tokenizer` instalado (lo que recomienda el README) y un modelo de
 * OpenAI, un mensaje con 100 KB de espacios, saltos de línea, «=» o «a»
 * tardaba 3 s en contarse y uno de 400 KB, 70 s, con el hilo parado: el BPE
 * funde cada pieza en tiempo cuadrático y esas tiradas son UNA pieza. El
 * recuento corta ahora las tiradas largas y cuenta cada trozo por separado.
 *
 * Tres cosas se fijan aquí, con el gpt-tokenizer de verdad:
 *   1. 400.000 caracteres de cualquier tirada se cuentan en tiempo lineal.
 *   2. Un texto sin tiradas largas da EXACTAMENTE el mismo número que antes.
 *   3. Donde sí se corta, la diferencia está acotada: nunca de menos, y como
 *      mucho dos tokens de más por cada 512 caracteres de tirada.
 * Todos los textos son inventados.
 */

type Encode = (texto: string) => number[];
const o200k = ((await import("gpt-tokenizer/encoding/o200k_base")) as { encode: Encode }).encode;
const cl100k = ((await import("gpt-tokenizer/encoding/cl100k_base")) as { encode: Encode }).encode;
const exacto = new ExactTokenizer("o200k_base", { encode: o200k });
const exactoCl = new ExactTokenizer("cl100k_base", { encode: cl100k });

// Holgado a propósito: no mide velocidad, distingue lineal (decenas de ms) de
// cuadrático (70 s con 400 KB de espacios).
const TOPE_MS = 3_000;
const N = 400_000;

const TIRADAS: ReadonlyArray<readonly [string, string]> = [
  ["espacios", " ".repeat(N)],
  ["saltos de línea", "\n".repeat(N)],
  ["signos «=»", "=".repeat(N)],
  ["guiones", "-".repeat(N)],
  ["una letra", "a".repeat(N)],
  ["hexadecimal sin separadores", "deadbeef".repeat(N / 8)],
  ["espacio y tabulador alternados", " \t".repeat(N / 2)],
  ["espacio normal y de no separación alternados", "  ".repeat(N / 2)],
  ["dos signos alternados", "-=".repeat(N / 2)],
  ["signo y marca combinante alternados", "=́".repeat(N / 2)],
  ["letra y marca combinante", "á".repeat(N / 2)],
  ["ideogramas sin puntuación", "这是一个测试文本我们正在检查".repeat(Math.floor(N / 14))],
  ["emojis", "😀".repeat(N / 2)],
  ["dentro de un texto normal", `Summarize this log:\n${" ".repeat(N)}\nfin del registro 42.`],
];

describe("⛔ A2-4 · contar tokens no para el hilo con una tirada larga", () => {
  it.each(TIRADAS)("o200k_base · 400.000 caracteres de %s en tiempo lineal", (_nombre, texto) => {
    const t0 = performance.now();
    const n = exacto.count(texto);
    expect(performance.now() - t0).toBeLessThan(TOPE_MS);
    expect(n).toBeGreaterThan(0);
  });

  it.each(TIRADAS.slice(0, 6))("cl100k_base · 400.000 caracteres de %s en tiempo lineal", (_nombre, texto) => {
    const t0 = performance.now();
    exactoCl.count(texto);
    expect(performance.now() - t0).toBeLessThan(TOPE_MS);
  });

  it("de capa: un mensaje con 400.000 espacios se atiende sin parar el proceso", async () => {
    const registro = new TokenizerRegistry();
    expect(await registerExactTokenizer(registro)).toBe(true);
    const proveedor = {
      id: "mock",
      async generate(req: ProviderRequest): Promise<ProviderResponse> {
        return { text: "ok", usage: { inputTokens: 10, outputTokens: 1 }, model: req.model, finishReason: "stop" } as ProviderResponse;
      },
    } as Provider;
    const capa = createSavingsLayer({ provider: proveedor, tokenizer: registro, silenceWarnings: true });
    const t0 = performance.now();
    const r = await capa.generate({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: `Summarize this log:\n${" ".repeat(N)}` }],
    });
    expect(performance.now() - t0).toBeLessThan(TOPE_MS);
    expect(r.text).toBe("ok");
    capa.close();
  });
});

describe("A2-4 · el recuento de un texto normal no cambia ni en un token", () => {
  const prosa = "El pedido 4411 salió el martes; llegará en 3-5 días laborables (¿seguro?). ";
  const NORMALES: ReadonlyArray<readonly [string, string]> = [
    ["prosa de 100 KB", prosa.repeat(1_400)],
    ["prosa en inglés de 100 KB", "The quick brown fox jumps over the lazy dog, twice a day. ".repeat(1_750)],
    ["1.000 líneas con sangría de 100 espacios", `${" ".repeat(100)}valor: 12\n`.repeat(1_000)],
    ["JSON", JSON.stringify(Array.from({ length: 2_000 }, (_, i) => ({ id: i, nombre: `cliente-${i}`, activo: i % 2 === 0 })))],
    ["100 KB de cifras", "1234567890".repeat(10_000)],
    ["base64", Buffer.from(Array.from({ length: 60_000 }, (_, i) => (i * 131 + 7) % 256)).toString("base64")],
    ["tabla en Markdown con reglas de 120 guiones", `| a | b |\n|${"-".repeat(120)}|${"-".repeat(120)}|\n| 1 | 2 |\n`.repeat(300)],
    ["chino con su puntuación", "我们今天检查订单的状态，然后把结果发给客户。如果有问题，请马上告诉我！".repeat(1_500)],
    ["japonés con su puntuación", "注文の状況を確認して、結果をお客様に送ります。問題があれば、すぐに知らせてください。".repeat(1_200)],
    ["código", "export function suma(a: number, b: number): number {\n  return a + b; // 2 + 2 = 4\n}\n".repeat(1_000)],
  ];

  it.each(NORMALES)("%s", (_nombre, texto) => {
    expect(exacto.count(texto)).toBe(o200k(texto).length);
    expect(exactoCl.count(texto)).toBe(cl100k(texto).length);
  });

  it("y un texto corto, tampoco", () => {
    for (const texto of ["", "hola", " ".repeat(512), "=".repeat(512), "a".repeat(300)]) {
      expect(exacto.count(texto)).toBe(texto === "" ? 0 : o200k(texto).length);
    }
  });
});

describe("A2-4 · donde se corta, la diferencia está acotada", () => {
  // 16.000 caracteres: lo bastante largo para cortar 31 veces y lo bastante
  // corto para que el recuento sin cortes (el cuadrático) acabe en décimas.
  const M = 16_000;
  const CORTADAS: ReadonlyArray<readonly [string, string]> = [
    ["espacios", " ".repeat(M)],
    ["saltos de línea", "\n".repeat(M)],
    ["signos «=»", "=".repeat(M)],
    ["guiones", "-".repeat(M)],
    ["una letra", "a".repeat(M)],
    ["hexadecimal sin separadores", "deadbeef".repeat(M / 8)],
    ["dos letras", "ab".repeat(M / 2)],
    ["ideogramas sin puntuación", "这是一个测试文本我们正在检查".repeat(Math.floor(M / 14))],
    ["una URL larguísima", `https://example.test/${"segmento/".repeat(M / 9)}`],
    ["dentro de un texto normal", `Summarize this log:\n${" ".repeat(M)}\nfin del registro 42.`],
  ];

  it.each(CORTADAS)("%s: nunca de menos, y como mucho 2 tokens de más por cada 512 caracteres", (_nombre, texto) => {
    for (const [tok, encode] of [[exacto, o200k], [exactoCl, cl100k]] as const) {
      const sinCortar = encode(texto).length;
      const cortado = tok.count(texto);
      expect(cortado).toBeGreaterThanOrEqual(sinCortar);
      expect(cortado - sinCortar).toBeLessThanOrEqual(2 * Math.ceil(texto.length / 512));
    }
  });
});
