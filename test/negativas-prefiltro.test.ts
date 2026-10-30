import { describe, expect, it } from "vitest";
import { negativaEnTexto } from "../src/providers/negativa-en-texto.js";

describe("prefiltro de negativas", () => {
  it("no ejecuta las reglas completas sin un candidato y sí ante una negativa", () => {
    const fuentes: string[] = [];
    const original = RegExp.prototype.test;
    RegExp.prototype.test = function (texto: string): boolean {
      fuentes.push(this.source);
      return original.call(this, texto);
    };
    try {
      expect(negativaEnTexto("The measured response explains the cache configuration and its limits.")).toBeNull();
      expect(fuentes.some((source) => source.includes("determine"))).toBe(false);

      expect(negativaEnTexto("I can't help with that.")).toBe("opens-with-refusal");
      expect(fuentes.some((source) => source.includes("determine"))).toBe(true);
    } finally {
      RegExp.prototype.test = original;
    }
  });
});
