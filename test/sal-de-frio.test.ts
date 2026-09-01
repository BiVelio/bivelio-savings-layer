import { describe, it, expect } from "vitest";

import { scenarios, conSalDeFrio } from "../benchmarks/scenarios.js";
import type { SavingsRequest } from "../src/index.js";

/**
 * LA SAL DE FRÍO: contra un endpoint que cachea prefijos automáticamente
 * (OpenAI, prompts ≥1024 tokens), repetir el prompt idéntico deja frías solo
 * las primeras llamadas y el titular «por llamada fría» mide una mezcla
 * caliente (2026-09-01, api.openai.com: 43,9 % la rep fría, 14,4 % las
 * calientes, 12,8 % publicado como agregado «frío»). Estas verjas fijan las
 * propiedades de las que depende el arreglo.
 */
describe("conSalDeFrio", () => {
  const req: SavingsRequest = {
    model: "openai/gpt-4o-mini",
    messages: [
      { role: "system", content: "política estable" },
      { role: "user", content: "what is 17*23?" },
    ],
  };

  it("inyecta la marca como PRIMER mensaje: la divergencia empieza en el byte 0 del prompt", () => {
    const salada = conSalDeFrio(req, "abc-3");
    expect(salada.messages[0]).toEqual({ role: "system", content: "[medicion-fria abc-3]" });
    expect(salada.messages).toHaveLength(req.messages.length + 1);
  });

  it("no toca el contenido original: el resolver y las palancas ven los mensajes intactos", () => {
    const salada = conSalDeFrio(req, "abc-3");
    expect(salada.messages.slice(1)).toEqual(req.messages);
    // Y es pura: la petición original queda como estaba.
    expect(req.messages).toHaveLength(2);
    expect(req.messages[0]!.content).toBe("política estable");
  });

  it("marcas distintas producen prefijos distintos: dos reps nunca pegan entre sí", () => {
    const a = conSalDeFrio(req, "n-0").messages[0]!.content;
    const b = conSalDeFrio(req, "n-1").messages[0]!.content;
    expect(a).not.toBe(b);
  });
});

describe("qué escenarios quedan exentos de la sal", () => {
  /** La regla del banco, replicada literalmente (ab-live.ts, runScenario). */
  const exento = (s: (typeof scenarios)[number]): boolean =>
    !!s.warm || s.prefijoEstable === true || s.palanca === "providerPrefixCache";

  it("exactamente los escenarios cuyo VALOR es el prefijo estable, y ninguno más", () => {
    const exentos = scenarios.filter(exento).map((s) => s.name).sort();
    expect(exentos).toEqual(
      [
        // Los dos FAQ comparten prompt byte a byte para que la caché exacta acierte.
        "FAQ (first ask)",
        "FAQ (repeat ask)",
        // Los tres miden la caché de prefijo del proveedor: salarlos la mataría.
        "Anthropic stable-prefix agent turn",
        "Gemini stable-prefix agent turn",
        "Stable-prefix agent turn",
      ].sort(),
    );
  });

  it("todo escenario salado puede recibir la sal sin perder su forma", () => {
    for (const s of scenarios.filter((s) => !exento(s))) {
      const salada = conSalDeFrio(s.request, "t-0");
      expect(salada.messages).toHaveLength(s.request.messages.length + 1);
      expect(salada.messages.slice(1)).toEqual(s.request.messages);
    }
  });
});
