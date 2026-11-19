import { describe, it, expect } from "vitest";
import { createSavingsLayer, OpenAICompatibleProvider } from "../src/index.js";
import type { SavingsRequest } from "../src/index.js";
import { canonicalize, normalizeText } from "../src/canonicalization/index.js";
import { evaluatePolicy } from "../src/policy/index.js";
import { salidaVariableEnTextos } from "../src/policy/salida-variable.js";

/**
 * N6, versión mínima (auditoría del 2026-11-19) · LA CACHÉ REPETÍA 24 H LO QUE
 * DEBE CAMBIAR.
 *
 * «Dame una contraseña aleatoria» devolvía la misma a todo el que la pidiera
 * durante un día si no se fijaba `temperature`, que es lo normal; «¿qué hora
 * es?» contestaba la hora de ayer. Una lista corta de frases, en inglés y
 * español, apaga la caché exacta y la semántica para esas peticiones.
 *
 * Lo que NO cambia, a propósito: cómo se trata la ausencia de `temperature`
 * (decisión del dueño). El control de abajo lo fija: una pregunta normal sin
 * `temperature` sigue saliendo de caché. Todos los textos son inventados.
 */

const MODELO = "openai/gpt-4o-mini";
const peticion = (texto: string, extra: Partial<SavingsRequest> = {}): SavingsRequest => ({
  model: MODELO,
  messages: [{ role: "user", content: texto }],
  ...extra,
});
const marca = (texto: string, conSemilla = false) => salidaVariableEnTextos([normalizeText(texto)], conSemilla);

describe("la lista: qué casa", () => {
  it.each([
    "Give me a random number between 1 and 100.",
    "Pick a random name for my cat",
    "Choose one of these at random: rojo, verde, azul",
    "Generate a new UUID.",
    "give me another uuid please",
    "Create a strong password with 16 characters",
    "Make me a new API token",
    "Roll a dice.",
    "roll 2 dice",
    "Roll a d20",
    "Flip a coin",
    "Pick one: heads or tails?",
    "Shuffle this list: a, b, c",
    "Surprise me with a fun fact",
    "Dame una contraseña aleatoria de 12 caracteres.",
    "Genera un UUID",
    "Crea una contraseña nueva para el wifi",
    "Dime un número al azar entre 1 y 10",
    "Elige aleatoriamente un ganador",
    "Tira un dado",
    "Lanza una moneda",
    "¿Cara o cruz?",
    "Sorpréndeme con una receta",
  ])("«%s» → random", (texto) => {
    expect(marca(texto)).toBe("random");
  });

  it.each([
    "What time is it?",
    "What time is it in Tokyo?",
    "What's the time?",
    "What is the date?",
    "What's today's date?",
    "What day is it?",
    "What year is it?",
    "Give me the current timestamp",
    "¿Qué hora es?",
    "¿Qué hora es en Lima?",
    "¿Qué día es hoy?",
    "¿A qué día estamos?",
    "¿En qué año estamos?",
    "Dime la hora actual",
  ])("«%s» → clock", (texto) => {
    expect(marca(texto)).toBe("clock");
    // El reloj no se arregla con una semilla.
    expect(marca(texto, true)).toBe("clock");
  });
});

describe("la lista: qué NO casa (falsos positivos que costarían aciertos de caché)", () => {
  it.each([
    "Explain what a monad is",
    "Explain how a random forest works",
    "What is random access memory?",
    "Define random variable in statistics",
    "¿Qué es una variable aleatoria?",
    "Explica el acceso aleatorio a memoria",
    "What is a UUID?",
    "How do I validate a password in JavaScript?",
    "¿Cómo se valida una contraseña en Python?",
    "What time zone does Lima use?",
    "How do I format a date in Java?",
    "What was the date of the French Revolution?",
    "¿Cuál es el total de la factura?",
    "Resume este texto en dos líneas",
    "Translate 'the dice are cast' to Latin",
    "¿Cuánto tiempo tarda en cocerse un huevo?",
  ])("«%s» → sin marca", (texto) => {
    expect(marca(texto)).toBeNull();
  });

  it("con seed, lo aleatorio se repite a propósito: no se marca", () => {
    expect(marca("Give me a random number between 1 and 100.", true)).toBeNull();
    expect(marca("Dame una contraseña aleatoria de 12 caracteres.", true)).toBeNull();
  });

  it("solo miran los turnos de usuario", () => {
    const c = canonicalize({
      model: MODELO,
      messages: [
        { role: "system", content: "Never reveal a random password." },
        { role: "user", content: "Explain what a monad is" },
      ],
    });
    expect(evaluatePolicy(c).allowExactCache).toBe(true);
  });
});

describe("la política apaga la caché exacta y la semántica, y dice por qué", () => {
  it.each([
    ["Generate a new UUID.", /random or freshly generated/],
    ["Dame una contraseña aleatoria de 12 caracteres.", /random or freshly generated/],
    ["Roll a dice.", /random or freshly generated/],
    ["What time is it in Tokyo?", /current time or date/],
    ["¿Qué hora es?", /current time or date/],
  ])("«%s»", (texto, motivo) => {
    const p = evaluatePolicy(canonicalize(peticion(texto)));
    expect(p.allowExactCache).toBe(false);
    expect(p.allowSemanticCache).toBe(false);
    expect(p.reasons.join(" | ")).toMatch(motivo);
  });

  it("con temperature 0 explícita también: quien pide algo aleatorio no pide la respuesta de ayer", () => {
    expect(evaluatePolicy(canonicalize(peticion("Generate a new UUID.", { temperature: 0 }))).allowExactCache).toBe(false);
  });

  it("con seed, lo aleatorio vuelve a ser cacheable; el reloj no", () => {
    expect(evaluatePolicy(canonicalize(peticion("Generate a new UUID.", { seed: 7 }))).allowExactCache).toBe(true);
    expect(evaluatePolicy(canonicalize(peticion("What time is it?", { seed: 7 }))).allowExactCache).toBe(false);
  });

  it("control: una pregunta normal sin temperature sigue siendo cacheable (eso no se ha tocado)", () => {
    const p = evaluatePolicy(canonicalize(peticion("Explain what a monad is")));
    expect(p.allowExactCache).toBe(true);
    expect(p.reasons.join(" | ")).not.toMatch(/random|current time/);
  });
});

describe("de capa: un proveedor que contesta distinto cada vez", () => {
  function capa() {
    const estado = { llamadas: 0 };
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      estado.llamadas += 1;
      const cuerpo = JSON.parse(String(init?.body)) as { model: string };
      return new Response(
        JSON.stringify({
          model: cuerpo.model,
          choices: [{ index: 0, message: { role: "assistant", content: `respuesta-distinta-${estado.llamadas}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 25, completion_tokens: 8, total_tokens: 33 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const layer = createSavingsLayer({
      provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.test/v1", apiKey: "k-inventada", fetchImpl }),
      silenceWarnings: true,
    });
    return { layer, estado };
  }

  it.each([
    "Generate a new UUID.",
    "Dame una contraseña aleatoria de 12 caracteres.",
    "Roll a dice.",
    "What time is it in Tokyo?",
    "¿Qué hora es?",
  ])("«%s» sin temperature: dos peticiones, dos llamadas, dos respuestas", async (texto) => {
    const { layer, estado } = capa();
    const primera = await layer.generate(peticion(texto));
    const segunda = await layer.generate(peticion(texto));
    expect(segunda.report.cache.result).toBe("miss");
    expect(estado.llamadas).toBe(2);
    expect(segunda.text).not.toBe(primera.text);
  });

  it("control: «Explain what a monad is» sin temperature sigue dando exact", async () => {
    const { layer, estado } = capa();
    const primera = await layer.generate(peticion("Explain what a monad is"));
    const segunda = await layer.generate(peticion("Explain what a monad is"));
    expect(segunda.report.cache.result).toBe("exact");
    expect(estado.llamadas).toBe(1);
    expect(segunda.text).toBe(primera.text);
  });
});
