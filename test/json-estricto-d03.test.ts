import { describe, it, expect } from "vitest";

import { compactToolOutput, seleccionarCompactables } from "../src/compression/cola.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { recorrerJsonEstricto, lexemasJsonEstricto } from "../src/util/json-estricto.js";
import { reserializacionFiel } from "../gateway/reserializacion.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { ChatMessage, SavingsRequest } from "../src/contracts/types.js";

/**
 * D03 · JSON SIN OMISIONES. El perfil `lossless-data` de la compactación de la
 * cola sólo quita el espacio insignificante de un tool_result que sea JSON
 * ESTRICTO, y cada tool_result sale con su decisión explicada. Los oráculos son
 * textos escritos a mano, no la salida del código pasada por otra función.
 */

const PERFIL = { profile: "lossless-data" as const };

/** Un JSON con tanta sangría como haga falta para pasar el mínimo de 256 caracteres. */
const conRelleno = (cuerpo: string, filas = 40): string =>
  "{\n" +
  Array.from({ length: filas }, (_, i) => `    "relleno_${i}" :   ${i}  ,\n`).join("") +
  `    "dato" : ${cuerpo}\n}\n`;
const rellenoCompacto = (cuerpo: string, filas = 40): string =>
  "{" + Array.from({ length: filas }, (_, i) => `"relleno_${i}":${i},`).join("") + `"dato":${cuerpo}}`;

describe("lo que se conserva byte a byte", () => {
  it("2^63+1, 1.10, 1e400, -0, 1E+2 y -0.0 salen escritos igual", () => {
    const original = conRelleno("[ 9223372036854775809 , 1.10 , 1e400 , -0 , 1E+2 , -0.0 ]");
    const r = compactToolOutput(original, PERFIL);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(rellenoCompacto("[9223372036854775809,1.10,1e400,-0,1E+2,-0.0]"));
    expect(r.decision).toMatchObject({ status: "applied", reason: "applied", transformId: "json-lossless", version: "1" });
  });

  it("los escapes unicode y los demás escapes salen tal cual, también un \\ud800 escapado", () => {
    const cadena = String.raw`"café 😀 \u0000 \/ \" \\ \t \ud800"`;
    const original = conRelleno(`{ "s" : ${cadena} ,  "crudo" : "é 😀" }`);
    const r = compactToolOutput(original, PERFIL);
    expect(r.text).toBe(rellenoCompacto(`{"s":${cadena},"crudo":"é 😀"}`));
  });

  it("el espacio DENTRO de una cadena no se toca", () => {
    const original = conRelleno(`"  a   b \\n  c  "`);
    expect(compactToolOutput(original, PERFIL).text).toBe(rellenoCompacto(`"  a   b \\n  c  "`));
  });

  it("aplicado: el compacto vuelve al mismo valor y el orden de las claves es el original", () => {
    const original = conRelleno(`{ "z" : 1 , "a" : [ true , false , null ] , "10" : "x" , "2" : {} }`);
    const r = compactToolOutput(original, PERFIL);
    expect(r.changed).toBe(true);
    expect(JSON.parse(r.text)).toEqual(JSON.parse(original));
    // El orden textual: "z" antes que "a", y "10" antes que "2" (JSON.stringify los reordenaría).
    expect(r.text.endsWith(`"dato":{"z":1,"a":[true,false,null],"10":"x","2":{}}}`)).toBe(true);
    expect(r.decision!.tokensAfter).toBeLessThan(r.decision!.tokensBefore);
    expect(r.decision!.tokensAfter).toBe(r.decision!.candidateTokens);
  });
});

describe("lo que se desvía, con su código", () => {
  it("claves duplicadas a cualquier profundidad → duplicate_keys, también si una va escapada", () => {
    for (const dato of [
      `{ "a" : { "b" : [ { "c" : 1 , "c" : 2 } ] } }`,
      `{ "a" : 1 , "\\u0061" : 2 }`,
    ]) {
      const original = conRelleno(dato);
      const r = compactToolOutput(original, PERFIL);
      expect(r.changed, dato).toBe(false);
      expect(r.text).toBe(original);
      expect(r.decision).toMatchObject({ status: "bypassed", reason: "duplicate_keys" });
      expect(r.decision!.tokensAfter).toBe(r.decision!.tokensBefore);
    }
    // La misma clave en objetos DISTINTOS, o dentro de una cadena, no es duplicada.
    const hermanos = compactToolOutput(conRelleno(`[ { "c" : 1 } , { "c" : 2 } , "{\\"c\\":1,\\"c\\":2}" ]`), PERFIL);
    expect(hermanos.decision?.reason).toBe("applied");
  });

  it("JSON no estricto → invalid_json; texto que no es objeto ni array → not_json", () => {
    const casos: [string, string][] = [
      [conRelleno("[ 1 , 2 , ]"), "invalid_json"], // coma final
      [conRelleno("'x'"), "invalid_json"], // comillas simples
      [conRelleno("NaN"), "invalid_json"],
      [conRelleno("012"), "invalid_json"], // cero a la izquierda
      [conRelleno('"a\tb"'), "invalid_json"], // control sin escapar
      [conRelleno('"\\x41"'), "invalid_json"], // escape desconocido
      [conRelleno("1") + "// fin", "invalid_json"], // comentario detrás
      [conRelleno("1") + "{}", "invalid_json"], // dos valores
      [conRelleno("1").slice(0, -3), "invalid_json"], // truncado
      ["﻿" + conRelleno("1"), "not_json"], // BOM: no es espacio JSON
      [" " + conRelleno("1"), "not_json"], // NBSP tampoco
      ["PASS checkout.spec.ts\n".repeat(30), "not_json"],
    ];
    for (const [texto, motivo] of casos) {
      const r = compactToolOutput(texto, PERFIL);
      expect(r.changed, JSON.stringify(texto.slice(-20))).toBe(false);
      expect(r.text).toBe(texto);
      expect(r.decision?.reason, JSON.stringify(texto.slice(-20))).toBe(motivo);
    }
  });

  it("un sustituto suelto EN CRUDO → invalid_unicode", () => {
    const r = compactToolOutput(conRelleno('"a\ud800b"'), PERFIL);
    expect(r.decision?.reason).toBe("invalid_unicode");
    expect(compactToolOutput(conRelleno('"a\udc00"'), PERFIL).decision?.reason).toBe("invalid_unicode");
  });

  it("ya compacto → not_smaller, con el candidato contado", () => {
    const yaCompacto = rellenoCompacto("[1,2,3]");
    const r = compactToolOutput(yaCompacto, PERFIL);
    expect(r).toMatchObject({ changed: false, text: yaCompacto });
    expect(r.decision).toMatchObject({ status: "bypassed", reason: "not_smaller" });
    expect(r.decision!.candidateTokens).toBe(r.decision!.tokensBefore);
  });

  it("la verja es en TOKENS: menos caracteres pero los mismos tokens → not_smaller", () => {
    const original = conRelleno("[1]");
    // Un estimador que cuenta lexemas, no caracteres: quitar espacio no ahorra nada.
    const porLexemas = (t: string) => {
      const l = lexemasJsonEstricto(t);
      return l.ok ? l.lexemas.length : t.length;
    };
    const r = compactToolOutput(original, PERFIL, porLexemas);
    expect(r.changed).toBe(false);
    expect(r.decision).toMatchObject({ reason: "not_smaller", tokensBefore: porLexemas(original), tokensAfter: porLexemas(original) });
  });

  it("menos de minSavedChars quitados → below_threshold; bajando el mínimo, se aplica", () => {
    const original = conRelleno("1", 4); // unos 70 caracteres de espacio, menos de 256
    const d = compactToolOutput(original, PERFIL).decision!;
    expect(d.reason).toBe("below_threshold");
    expect(d.candidateTokens).toBeLessThan(d.tokensBefore); // sí ahorraba tokens: lo para el mínimo
    const r = compactToolOutput(original, { ...PERFIL, minSavedChars: 1 });
    expect(r.text).toBe(rellenoCompacto("1", 4));
  });

  it("el perfil sólo hace JSON: el ANSI y las repeticiones se quedan aunque `transforms` las pida", () => {
    const texto = "\u001b[31mFAIL\u001b[39m\n" + "same line\n".repeat(60);
    const r = compactToolOutput(texto, { ...PERFIL, transforms: ["ansi", "repeated-lines"] });
    expect(r.text).toBe(texto);
    expect(r.decision?.reason).toBe("not_json");
  });
});

describe("el perfil por defecto no cambia", () => {
  it("sin perfil, un JSON con duplicadas se sigue compactando como antes y no hay `decision`", () => {
    const original = conRelleno(`{ "c" : 1 , "c" : 2 }`);
    const r = compactToolOutput(original);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(rellenoCompacto(`{"c":1,"c":2}`));
    expect(r.decision).toBeUndefined();
    expect(seleccionarCompactables([{ role: "tool", toolCallId: "t", content: original }]).decisiones).toBeUndefined();
  });
});

describe("determinismo: función pura del texto", () => {
  it("compactar dos veces da los mismos bytes, y compactar lo compactado no lo mueve", () => {
    const original = conRelleno(`{ "n" : 9223372036854775809 }`);
    const a = compactToolOutput(original, PERFIL);
    const b = compactToolOutput(original, PERFIL);
    expect(b).toEqual(a);
    const otraVez = compactToolOutput(a.text, PERFIL);
    expect(otraVez.text).toBe(a.text);
    expect(otraVez.decision?.reason).toBe("not_smaller");
  });
});

describe("un solo analizador para el SDK y el gateway", () => {
  it("el gateway rechaza las mismas duplicadas que la cola", () => {
    expect(reserializacionFiel('{"a":{"b":[{"c":1,"c":2}]}}')).toBe(false);
    expect(recorrerJsonEstricto('{"a":{"b":[{"c":1,"c":2}]}}')).toMatchObject({ ok: false, fallo: "duplicate_keys" });
    expect(reserializacionFiel('{"a":{"b":[{"c":1},{"c":2}]}}')).toBe(true);
  });

  it("100 000 niveles de anidación no revientan la pila", () => {
    const hondo = "[".repeat(100_000) + "]".repeat(100_000);
    expect(recorrerJsonEstricto(hondo).ok).toBe(true);
    expect(recorrerJsonEstricto(hondo + "]")).toMatchObject({ ok: false, fallo: "invalid_json" });
  });
});

// --- en el pipeline ----------------------------------------------------------

class ProveedorEspia implements Provider {
  readonly id = "espia";
  recibidas: ProviderRequest[] = [];
  async generate(r: ProviderRequest): Promise<ProviderResponse> {
    this.recibidas.push(r);
    return { text: "ok", usage: { inputTokens: 1000, outputTokens: 10 } };
  }
  get ultima(): ChatMessage[] {
    return this.recibidas[this.recibidas.length - 1]!.messages;
  }
}

const SALIDAS = [
  conRelleno(`{ "id" : 9223372036854775809 , "precio" : 1.10 }`), // aplica
  conRelleno(`{ "a" : 1 , "a" : 2 }`), // duplicadas
  conRelleno(`{ "nombre" : "x" }`), // vista de fichero: protegida
  "plain text output\n".repeat(20), // no es JSON
];

function historial(turnos: number): ChatMessage[] {
  const m: ChatMessage[] = [
    { role: "system", content: "You are an agent." },
    { role: "user", content: "Go." },
  ];
  for (let t = 0; t < turnos; t++) {
    const args = t % 4 === 2 ? `{"file_path":"pkg.json"}` : `{"q":${t}}`;
    m.push({ role: "assistant", content: "", toolCalls: [{ id: `toolu_${t}`, name: t % 4 === 2 ? "read" : "query", arguments: args }] });
    m.push({ role: "tool", toolCallId: `toolu_${t}`, name: "query", content: SALIDAS[t % 4]! });
  }
  return m;
}

const peticion = (turnos: number): SavingsRequest => ({
  model: "anthropic/claude-sonnet-5",
  messages: historial(turnos),
  savings: { exactCache: false },
});
const capa = (p: Provider, ajustes: boolean | { profile?: "lossless-data" } = { profile: "lossless-data" }) =>
  createSavingsLayer({ exactTokenizer: false, provider: p, toolOutputCompaction: ajustes });

describe("en el pipeline", () => {
  it("cada tool_result sale con su decisión explicada, en orden y con su toolCallId", async () => {
    const p = new ProveedorEspia();
    const r = await capa(p).generate(peticion(4));
    const informe = r.report.toolOutputCompaction!;
    expect(informe.profile).toBe("lossless-data");
    expect(informe.tokenBasis).toBe("estimated");
    expect(informe.estimator).toEqual({ id: "heuristic", exact: false });
    expect(informe.decisions.map((d) => [d.toolCallId, d.status, d.reason])).toEqual([
      ["toolu_0", "applied", "applied"],
      ["toolu_1", "bypassed", "duplicate_keys"],
      ["toolu_2", "bypassed", "protected"],
      ["toolu_3", "bypassed", "not_json"],
    ]);
    for (const d of informe.decisions) expect(d).toMatchObject({ transformId: "json-lossless", version: "1" });

    // Lo que recibe el proveedor: sólo el primero cambia, y en el texto esperado.
    const tools = p.ultima.filter((m) => m.role === "tool");
    expect(tools.map((m) => m.toolCallId)).toEqual(["toolu_0", "toolu_1", "toolu_2", "toolu_3"]);
    expect(tools.map((m) => m.content)).toEqual([
      rellenoCompacto(`{"id":9223372036854775809,"precio":1.10}`),
      SALIDAS[1],
      SALIDAS[2],
      SALIDAS[3],
    ]);
    // Lo quitado entra en el libro 3 y en nada más.
    const aplicada = informe.decisions[0]!;
    expect(r.report.tokens.compressedInput).toBe(aplicada.tokensBefore - aplicada.tokensAfter);
  });

  it("el historial del cliente no se toca", async () => {
    const req = peticion(4);
    const copia = structuredClone(req.messages);
    await capa(new ProveedorEspia()).generate(req);
    expect(req.messages).toEqual(copia);
  });

  it("un turno después, con una capa nueva, el prefijo enviado es byte a byte el mismo", async () => {
    const p1 = new ProveedorEspia();
    const p2 = new ProveedorEspia();
    await capa(p1).generate(peticion(4));
    await capa(p2).generate(peticion(5));
    expect(p2.ultima.slice(0, p1.ultima.length)).toEqual(p1.ultima);
  });

  it("sin el perfil, el informe no lleva `toolOutputCompaction`", async () => {
    const r = await capa(new ProveedorEspia(), true).generate(peticion(4));
    expect(r.report.toolOutputCompaction).toBeUndefined();
  });
});
