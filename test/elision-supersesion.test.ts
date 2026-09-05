import { describe, expect, it } from "vitest";

import {
  seleccionarSupersesion,
  aplicarElision,
  identidadRecurso,
  MINIMO_BYTES_CANDIDATO,
  MUNON_ELISION,
} from "../src/pipeline/elision.js";
import type { ChatMessage } from "../src/contracts/types.js";

/**
 * SUPERSESIÓN. Un tool_result se elide SOLO cuando un tool_result estrictamente
 * más nuevo vuelve a pedir el MISMO recurso (misma herramienta + mismos
 * argumentos). Es la política que corre EN VIVO. Estos tests fijan su contrato:
 * elide lo probablemente redundante, DECLINA todo lo demás (recursos distintos,
 * argumentos sin identidad), y jamás toca el último resultado.
 */

const GORDO = "x".repeat(MINIMO_BYTES_CANDIDATO + 100); // ASCII → > 1 KB, candidato por tamaño

/** Una ronda: assistant con tool_call (nombre + args JSON) + su tool_result. */
function ronda(id: string, tool: string, args: Record<string, unknown>, cuerpo: string): ChatMessage[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id, name: tool, arguments: JSON.stringify(args) }] },
    { role: "tool", content: cuerpo, toolCallId: id, name: tool },
  ];
}

function transcripcion(...rondas: ChatMessage[][]): ChatMessage[] {
  const m: ChatMessage[] = [{ role: "user", content: "tarea" }];
  for (const r of rondas) m.push(...r);
  m.push({ role: "user", content: "pregunta final" });
  return m;
}

describe("identidadRecurso", () => {
  it("es null sin nombre o con argumentos triviales (no hay identidad demostrable)", () => {
    expect(identidadRecurso(undefined, '{"path":"a"}')).toBeNull();
    expect(identidadRecurso("read_file", undefined)).toBeNull();
    expect(identidadRecurso("read_file", "")).toBeNull();
    expect(identidadRecurso("read_file", "{}")).toBeNull();
    expect(identidadRecurso("read_file", "  {}  ")).toBeNull();
    expect(identidadRecurso("read_file", "[]")).toBeNull();
  });

  it("no depende del orden de las claves del JSON", () => {
    expect(identidadRecurso("read_file", '{"a":1,"b":2}')).toBe(identidadRecurso("read_file", '{"b":2,"a":1}'));
  });

  it("distingue herramienta y recurso", () => {
    expect(identidadRecurso("read_file", '{"path":"a.ts"}')).not.toBe(identidadRecurso("read_file", '{"path":"b.ts"}'));
    expect(identidadRecurso("read_file", '{"path":"a.ts"}')).not.toBe(identidadRecurso("grep", '{"path":"a.ts"}'));
  });

  it("un argumento no-JSON sigue siendo una identidad estable", () => {
    expect(identidadRecurso("sh", "ls -la")).toBe("sh ls -la");
  });
});

describe("seleccionarSupersesion", () => {
  it("elide la lectura vieja cuando el mismo path se relee (mismo recurso)", () => {
    const messages = transcripcion(
      ronda("c0", "read_file", { path: "config.ts" }, `// config v1\n${GORDO}`),
      ronda("c1", "read_file", { path: "otro.ts" }, `// otro\n${GORDO}`),
      ronda("c2", "read_file", { path: "config.ts" }, `// config v2\n${GORDO}`),
      ronda("c3", "read_file", { path: "final.ts" }, `// final\n${GORDO}`),
    );
    const { indices } = seleccionarSupersesion(messages);
    expect(indices).toHaveLength(1);
    expect(messages[indices[0]!]!.content).toContain("config v1");
  });

  it("declina recursos distintos: nada re-pedido → no elide nada (síntesis intacta)", () => {
    const messages = transcripcion(
      ...Array.from({ length: 10 }, (_, i) => ronda(`c${i}`, "read_file", { path: `s${i}.json` }, `// s${i}\n${GORDO}`)),
    );
    expect(seleccionarSupersesion(messages).indices).toHaveLength(0);
  });

  it("declina cuando los argumentos no dan identidad (todo con {})", () => {
    const messages = transcripcion(
      ...Array.from({ length: 6 }, (_, i) => ronda(`c${i}`, "read_file", {}, `// x${i}\n${GORDO}`)),
    );
    expect(seleccionarSupersesion(messages).indices).toHaveLength(0);
  });

  it("elide DOS lecturas viejas cuando dos recursos distintos se releen", () => {
    const messages = transcripcion(
      ronda("c0", "read_file", { path: "a.ts" }, `// a v1\n${GORDO}`),
      ronda("c1", "read_file", { path: "b.ts" }, `// b v1\n${GORDO}`),
      ronda("c2", "read_file", { path: "ruido.ts" }, `// ruido\n${GORDO}`),
      ronda("c3", "read_file", { path: "a.ts" }, `// a v2\n${GORDO}`),
      ronda("c4", "read_file", { path: "b.ts" }, `// b v2\n${GORDO}`),
    );
    const { indices } = seleccionarSupersesion(messages);
    const cuerpos = indices.map((i) => messages[i]!.content.split("\n")[0]);
    expect(cuerpos.sort()).toEqual(["// a v1", "// b v1"]);
  });

  it("jamás elide el último tool_result aunque esté superado", () => {
    // Mismo recurso releído, pero la relectura vigente ES el último → el viejo
    // sí cae; si en cambio el propio último fuera el candidato, no debe caer.
    const messages = transcripcion(
      ronda("c0", "read_file", { path: "a.ts" }, `// a v1\n${GORDO}`),
      ronda("c1", "read_file", { path: "a.ts" }, `// a v2\n${GORDO}`),
    );
    const { indices } = seleccionarSupersesion(messages);
    expect(indices).toHaveLength(1);
    expect(messages[indices[0]!]!.content).toContain("a v1");
  });

  it("no elide bloques por debajo del mínimo de bytes (no paga la reescritura)", () => {
    const messages = transcripcion(
      ronda("c0", "read_file", { path: "a.ts" }, "chico v1"),
      ronda("c1", "read_file", { path: "z.ts" }, `// z\n${GORDO}`),
      ronda("c2", "read_file", { path: "a.ts" }, `// a v2\n${GORDO}`),
    );
    expect(seleccionarSupersesion(messages).indices).toHaveLength(0);
  });

  it("un error superado por una relectura con éxito SÍ se elide (no se protege por ser error)", () => {
    const messages = transcripcion(
      ronda("c0", "read_file", { path: "a.ts" }, `// ERROR: ENOENT\n${GORDO}`),
      ronda("c1", "read_file", { path: "otro.ts" }, `// otro\n${GORDO}`),
      ronda("c2", "read_file", { path: "a.ts" }, `// a leído bien\n${GORDO}`),
      ronda("c3", "read_file", { path: "final.ts" }, `// final\n${GORDO}`),
    );
    const { indices } = seleccionarSupersesion(messages);
    expect(indices).toHaveLength(1);
    expect(messages[indices[0]!]!.content).toContain("ERROR");
  });

  it("grep con la misma consulta re-ejecutado se supersede; consultas distintas NO", () => {
    const iguales = transcripcion(
      ronda("c0", "grep", { pattern: "TODO" }, `// grep viejo\n${GORDO}`),
      ronda("c1", "read_file", { path: "x.ts" }, `// x\n${GORDO}`),
      ronda("c2", "grep", { pattern: "TODO" }, `// grep nuevo\n${GORDO}`),
      ronda("c3", "read_file", { path: "y.ts" }, `// y\n${GORDO}`),
    );
    expect(seleccionarSupersesion(iguales).indices).toHaveLength(1);

    const distintas = transcripcion(
      ronda("c0", "grep", { pattern: "error" }, `// grep error\n${GORDO}`),
      ronda("c1", "grep", { pattern: "catch" }, `// grep catch\n${GORDO}`),
      ronda("c2", "grep", { pattern: "handleNetworkError" }, `// grep def\n${GORDO}`),
    );
    expect(seleccionarSupersesion(distintas).indices).toHaveLength(0);
  });
});

describe("aplicarElision", () => {
  it("sustituye solo el cuerpo elegido por el muñón y conserva role/toolCallId/name/orden", () => {
    const messages = transcripcion(
      ronda("c0", "read_file", { path: "a.ts" }, `// a v1\n${GORDO}`),
      ronda("c1", "read_file", { path: "z.ts" }, `// z\n${GORDO}`),
      ronda("c2", "read_file", { path: "a.ts" }, `// a v2\n${GORDO}`),
    );
    const { indices } = seleccionarSupersesion(messages);
    const tratado = aplicarElision(messages, indices);
    expect(tratado).not.toBe(messages); // array nuevo
    const i = indices[0]!;
    expect(tratado[i]!.content).toBe(MUNON_ELISION);
    expect(tratado[i]!.role).toBe("tool");
    expect(tratado[i]!.toolCallId).toBe(messages[i]!.toolCallId);
    expect(tratado[i]!.name).toBe("read_file");
    // el resto intacto
    expect(tratado.filter((m) => m.content === MUNON_ELISION)).toHaveLength(1);
  });

  it("sin índices devuelve el MISMO array (identidad)", () => {
    const messages = transcripcion(ronda("c0", "read_file", { path: "a.ts" }, `// a\n${GORDO}`));
    expect(aplicarElision(messages, [])).toBe(messages);
  });
});
