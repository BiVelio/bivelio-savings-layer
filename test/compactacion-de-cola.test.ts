import { describe, it, expect } from "vitest";

import {
  compactToolOutput,
  esVistaDeFichero,
  expandirRepeticiones,
  seleccionarCompactables,
} from "../src/compression/cola.js";
import type { ChatMessage } from "../src/contracts/types.js";

/**
 * LA VERJA DE FIDELIDAD DE LA COMPACTACIÓN DE LA COLA.
 *
 * La evidencia de 2026 es unánime en una cosa: comprimir la salida de las
 * herramientas de un agente AHORRA TOKENS Y ENCARECE LA FACTURA cuando lo que
 * se quita obliga al agente a volver a mirar (JetBrains/RTK: +13,8 % de turnos;
 * Quesma/RTK: +18 % de turnos en DeepSeek; «Token Reduction Is Not Cost
 * Reduction»: −38,4 % de tokens, +6,8 % de coste). Por eso aquí NO se resume ni
 * se poda: cada transformación o es REVERSIBLE (JSON, repeticiones) o conserva
 * exactamente lo que un terminal enseña (ANSI, retornos de carro). Esta verja lo
 * comprueba caso a caso y con un fuzz sembrado que cruza cada transformación
 * contra una implementación de referencia independiente.
 */

const bonito = (v: unknown) => JSON.stringify(v, null, 2);

describe("json: solo espacio entre tokens, nada más", () => {
  it("un JSON indentado sale sin espacio y significa lo mismo", () => {
    const valor = { items: Array.from({ length: 30 }, (_, i) => ({ id: i, title: `issue number ${i}`, open: i % 2 === 0 })) };
    const r = compactToolOutput(bonito(valor));
    expect(r.changed).toBe(true);
    expect(r.applied).toEqual(["json"]);
    expect(r.text).toBe(JSON.stringify(valor));
    expect(JSON.parse(r.text)).toEqual(valor);
  });

  it("las CADENAS salen byte a byte: espacios, saltos escapados y comillas dentro", () => {
    const valor = { rows: Array.from({ length: 20 }, () => ({ note: '  dos  espacios, "comillas" y \\n\n salto  ', t: "\t" })) };
    const r = compactToolOutput(bonito(valor));
    expect(r.changed).toBe(true);
    expect(JSON.parse(r.text)).toEqual(valor);
    expect(r.text).toContain('"  dos  espacios, \\"comillas\\" y \\\\n\\n salto  "');
  });

  it("NO reserializa números: un id de 23 dígitos y `1.0`/`1e3` llegan tal cual", () => {
    // JSON.parse + JSON.stringify convertiría 12345678901234567890123 en
    // 1.2345678901234568e+22 y `1.0` en `1`: cifra distinta en el cable.
    const cuerpo = `{\n  "id": 12345678901234567890123,\n  "ratio": 1.0,\n  "big": 1e3,\n  "pad": "${"x".repeat(300)}"\n}`;
    const lineas = Array.from({ length: 40 }, (_, i) => `    "k${i}": ${i}`).join(",\n");
    const texto = cuerpo.replace("\n}", `,\n  "more": {\n${lineas}\n  }\n}`);
    const r = compactToolOutput(texto, { minSavedChars: 1 });
    expect(r.changed).toBe(true);
    expect(r.text).toContain('"id":12345678901234567890123');
    expect(r.text).toContain('"ratio":1.0');
    expect(r.text).toContain('"big":1e3');
  });

  it("no toca lo que no es entero JSON: texto delante o detrás, o JSON inválido", () => {
    const pretty = bonito({ a: Array.from({ length: 100 }, (_, i) => i) });
    for (const t of [`Result:\n${pretty}`, `${pretty}\nexit code 0`, pretty.replace("]", "")]) {
      const r = compactToolOutput(t, { transforms: ["json"] });
      expect(r.changed).toBe(false);
      expect(r.text).toBe(t);
    }
  });
});

describe("repeated-lines: plegado reversible de líneas IDÉNTICAS consecutivas", () => {
  const racha = "Waiting for the database to accept connections on port 5432...";

  it("una racha se pliega en la primera línea más la cuenta, y se deshace exacta", () => {
    const texto = ["starting", ...Array(40).fill(racha), "ready"].join("\n");
    const r = compactToolOutput(texto);
    expect(r.changed).toBe(true);
    expect(r.applied).toEqual(["repeated-lines"]);
    expect(r.text).toBe(`starting\n${racha}\n[previous line repeated 39 more times]\nready`);
    expect(expandirRepeticiones(r.text)).toBe(texto);
  });

  it("líneas repetidas NO consecutivas no se tocan: su posición es información", () => {
    const texto = Array.from({ length: 60 }, (_, i) => (i % 2 ? racha : `step ${i} done`)).join("\n");
    expect(compactToolOutput(texto, { minSavedChars: 1 }).changed).toBe(false);
  });

  it("si el texto YA trae una línea con forma de marcador, no se pliega nada (sería ambiguo)", () => {
    const texto = [...Array(40).fill(racha), "[previous line repeated 3 more times]"].join("\n");
    const r = compactToolOutput(texto, { transforms: ["repeated-lines"] });
    expect(r.changed).toBe(false);
  });

  it("con finales CRLF la ida y vuelta sigue siendo exacta", () => {
    const texto = Array(30).fill(`${racha}\r`).join("\n");
    const r = compactToolOutput(texto, { transforms: ["repeated-lines"] });
    expect(r.changed).toBe(true);
    expect(expandirRepeticiones(r.text)).toBe(texto);
  });

  it("una racha corta cuyo marcador cuesta más que las copias se queda como está", () => {
    const texto = ["---", "---", "---", "x".repeat(400)].join("\n");
    expect(compactToolOutput(texto, { transforms: ["repeated-lines"], minSavedChars: 1 }).changed).toBe(false);
  });
});

describe("ansi y retornos de carro: lo que un terminal ENSEÑA", () => {
  it("quita color y estilo sin tocar una letra visible", () => {
    const lineas = Array.from({ length: 30 }, (_, i) =>
      i % 3 === 0
        ? `\u001b[32m✓\u001b[39m test/suite-${i}.test.ts \u001b[2m(12 tests)\u001b[22m \u001b[33m${i}ms\u001b[39m`
        : `\u001b[31m\u001b[1mFAIL\u001b[22m\u001b[39m test/other-${i}.test.ts > case ${i}`,
    );
    const texto = lineas.join("\n");
    const r = compactToolOutput(texto);
    expect(r.changed).toBe(true);
    expect(r.applied).toEqual(["ansi"]);
    expect(r.text).not.toContain("\u001b");
    expect(r.text).toBe(quitarAnsiReferencia(texto));
    expect(r.text).toContain("FAIL test/other-1.test.ts > case 1");
  });

  it("una barra de progreso con \\r queda en su estado final", () => {
    const barra = Array.from({ length: 50 }, (_, i) => `Downloading model.bin ${String(i * 2).padStart(3)}%`).join("\r");
    const texto = `fetching\n${barra}\rDownloading model.bin 100% done\nok`;
    const r = compactToolOutput(texto);
    expect(r.changed).toBe(true);
    expect(r.applied).toEqual(["carriage-return"]);
    expect(r.text).toBe("fetching\nDownloading model.bin 100% done\nok");
  });

  it("un segmento más corto no borra la cola del anterior: igual que el terminal", () => {
    const texto = `${"x".repeat(300)}\nProgress 100%\rDone\n`;
    const r = compactToolOutput(texto, { minSavedChars: 1 });
    expect(r.text).toContain("Doneress 100%");
  });

  it("un texto con finales CRLF (un fichero de Windows) no se toca", () => {
    const texto = Array.from({ length: 200 }, (_, i) => `line ${i}\r\n`).join("");
    expect(compactToolOutput(texto, { transforms: ["carriage-return"], minSavedChars: 1 }).changed).toBe(false);
  });
});

describe("la verja económica que no cambia de opinión", () => {
  it("por debajo del mínimo de caracteres no se cambia NADA, y lo dice", () => {
    const texto = bonito({ a: 1, b: [1, 2, 3] });
    const r = compactToolOutput(texto);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(texto);
    expect(r.reason).toMatch(/below the 256 minimum/);
  });

  it("determinista e idempotente: la misma entrada da los mismos bytes, y compactar lo compactado no cambia nada", () => {
    const texto = ["\u001b[33mwarn\u001b[39m", ...Array(50).fill("npm WARN deprecated inflight@1.0.6: This module leaks memory")].join("\n");
    const a = compactToolOutput(texto);
    const b = compactToolOutput(texto);
    expect(a).toEqual(b);
    expect(compactToolOutput(a.text).changed).toBe(false);
  });

  it("sin transformaciones permitidas no hace nada", () => {
    const texto = bonito({ a: Array.from({ length: 200 }, (_, i) => i) });
    expect(compactToolOutput(texto, { transforms: [] }).changed).toBe(false);
  });
});

describe("fuzz sembrado: cada salida se deshace o se explica contra una referencia independiente", () => {
  it("600 textos aleatorios: ANSI/\\r contra la referencia, JSON por valor, repeticiones por expansión", () => {
    const azar = generador(20260927);
    let compactados = 0;
    const porTransformacion: Record<string, number> = {};
    for (let n = 0; n < 600; n++) {
      const texto = textoAleatorio(azar);
      const r = compactToolOutput(texto, { minSavedChars: 1 });
      if (!r.changed) {
        expect(r.text).toBe(texto);
        continue;
      }
      compactados += 1;
      for (const t of r.applied) porTransformacion[t] = (porTransformacion[t] ?? 0) + 1;
      // Referencia: lo que un terminal enseña, calculado con otra implementación.
      let esperado = texto;
      if (r.applied.includes("ansi")) esperado = quitarAnsiReferencia(esperado);
      if (r.applied.includes("carriage-return")) esperado = superponerReferencia(esperado);
      let obtenido = r.text;
      if (r.applied.includes("repeated-lines")) obtenido = expandirRepeticiones(obtenido);
      if (r.applied.includes("json")) {
        expect(JSON.parse(obtenido)).toEqual(JSON.parse(esperado));
      } else {
        expect(obtenido).toBe(esperado);
      }
      expect(r.text.length).toBeLessThan(texto.length);
    }
    // El fuzz tiene que ejercitar la verja, no pasar por no tocar nada.
    expect(compactados).toBeGreaterThan(200);
    for (const t of ["ansi", "carriage-return", "json", "repeated-lines"]) {
      expect(porTransformacion[t] ?? 0, t).toBeGreaterThan(20);
    }
  });
});

describe("qué mensajes se tocan", () => {
  const json = bonito({ results: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `row ${i}` })) });
  const conversacion = (): ChatMessage[] => [
    { role: "system", content: json },
    { role: "user", content: json },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "search_api", arguments: '{"query":"open issues"}' }] },
    { role: "tool", toolCallId: "c1", name: "search_api", content: json },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c2", name: "read_file", arguments: '{"file_path":"package.json"}' },
        { id: "c3", name: "search_api", arguments: '{"query":"closed issues"}' },
      ],
    },
    { role: "tool", toolCallId: "c2", name: "read_file", content: json },
    { role: "tool", toolCallId: "c3", name: "search_api", content: json },
  ];

  it("solo `role: \"tool\"`, y nunca la vista de un fichero", () => {
    const e = seleccionarCompactables(conversacion());
    expect(e.compactados.map((c) => c.indice)).toEqual([3, 6]);
    expect(e.vistasDeFichero).toBe(1);
    // El 3 nació en un turno anterior (se reenvía igual); el 6 es la cola.
    expect(e.compactados.map((c) => c.enLaCola)).toEqual([false, true]);
  });

  it("`compactFileViews` y `exceptTools` hacen lo que dicen", () => {
    expect(seleccionarCompactables(conversacion(), { compactFileViews: true }).compactados.map((c) => c.indice)).toEqual([3, 5, 6]);
    const e = seleccionarCompactables(conversacion(), { exceptTools: ["search_api"] });
    expect(e.compactados).toEqual([]);
    expect(e.exceptuados).toBe(2);
  });

  it("qué cuenta como vista de un fichero", () => {
    for (const a of ['{"path":"a.ts"}', '{"file_path":"a"}', '{"filePath":"a"}', '{"target_file":"a"}', '{"paths":["a"]}']) {
      expect(esVistaDeFichero(a), a).toBe(true);
    }
    for (const a of ['{"query":"x"}', '{"url":"https://x"}', "not json", "[]", undefined]) {
      expect(esVistaDeFichero(a), String(a)).toBe(false);
    }
  });
});

// --- referencias independientes y generador -----------------------------------

/** Máquina de estados carácter a carácter: otra implementación del mismo contrato. */
function quitarAnsiReferencia(t: string): string {
  let out = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "\u001b" || i + 1 >= t.length) {
      out += t[i];
      continue;
    }
    const s = t.charCodeAt(i + 1);
    if (s === 0x5b) {
      // CSI: parámetros 0x30-0x3F, intermedios 0x20-0x2F, final 0x40-0x7E
      let j = i + 2;
      while (j < t.length && t.charCodeAt(j) >= 0x30 && t.charCodeAt(j) <= 0x3f) j++;
      while (j < t.length && t.charCodeAt(j) >= 0x20 && t.charCodeAt(j) <= 0x2f) j++;
      if (j < t.length && t.charCodeAt(j) >= 0x40 && t.charCodeAt(j) <= 0x7e) {
        i = j;
        continue;
      }
    } else if (s === 0x5d) {
      // OSC hasta BEL o ESC \
      let j = i + 2;
      while (j < t.length && t[j] !== "\u0007" && t[j] !== "\u001b") j++;
      if (j < t.length && t[j] === "\u0007") {
        i = j;
        continue;
      }
      if (j + 1 < t.length && t[j] === "\u001b" && t[j + 1] === "\\") {
        i = j + 1;
        continue;
      }
    }
    if (s >= 0x20 && s <= 0x2f) {
      let j = i + 1;
      while (j < t.length && t.charCodeAt(j) >= 0x20 && t.charCodeAt(j) <= 0x2f) j++;
      if (j < t.length && t.charCodeAt(j) >= 0x30 && t.charCodeAt(j) <= 0x7e) {
        i = j;
        continue;
      }
    }
    if (s >= 0x40 && s <= 0x5f) {
      i += 1;
      continue;
    }
    out += t[i];
  }
  return out;
}

/** Terminal de juguete: una columna por carácter, `\r` vuelve a la columna 0. */
function superponerReferencia(t: string): string {
  return t
    .split("\n")
    .map((linea) => {
      const celdas: string[] = [];
      let col = 0;
      for (const ch of linea) {
        if (ch === "\r") {
          col = 0;
          continue;
        }
        celdas[col] = ch;
        col += 1;
      }
      return celdas.join("");
    })
    .join("\n");
}

function generador(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const ESCAPES = ["\u001b[31m", "\u001b[0m", "\u001b[1;32m", "\u001b[2K", "\u001b]0;title\u0007", "\u001b(B", "\u001bM", "\u001b[?25l"];
const PALABRAS = ["error", "ok", "no", "never", "12", "3.5", "path/to/file.ts", "  ", "\t", "value", '"q"', "{", "}", "[", "]"];

function textoAleatorio(azar: () => number): string {
  const tipo = azar();
  const elegir = <T>(xs: readonly T[]): T => xs[Math.floor(azar() * xs.length)]!;
  if (tipo < 0.3) {
    // JSON, a veces con color alrededor (como `jq -C`) o sin indentar.
    const valor = valorAleatorio(azar, 0);
    const texto = azar() < 0.8 ? JSON.stringify(valor, null, 1 + Math.floor(azar() * 4)) : JSON.stringify(valor);
    return azar() < 0.2 ? `\u001b[1m${texto}\u001b[0m` : texto;
  }
  const lineas: string[] = [];
  const n = 5 + Math.floor(azar() * 60);
  for (let i = 0; i < n; i++) {
    let linea = Array.from({ length: 1 + Math.floor(azar() * 8) }, () => elegir(PALABRAS)).join(" ");
    if (azar() < 0.3) linea = `${elegir(ESCAPES)}${linea}${elegir(ESCAPES)}`;
    if (tipo > 0.85 && azar() < 0.4) linea = `${linea}\r${"#".repeat(Math.floor(azar() * 30))}\r${linea.slice(0, 5)}`;
    const copias = azar() < 0.25 ? 1 + Math.floor(azar() * 30) : 1;
    for (let k = 0; k < copias; k++) lineas.push(linea);
  }
  return lineas.join("\n");
}

function valorAleatorio(azar: () => number, prof: number): unknown {
  const r = azar();
  if (prof > 3 || r < 0.3) {
    const hojas: unknown[] = [null, true, false, 0, -1.5, 1e21, "a b  c", 'com"illa', "line\nbreak", "\u00e9\u00f1", 12345678901234];
    return hojas[Math.floor(azar() * hojas.length)];
  }
  if (r < 0.65) return Array.from({ length: Math.floor(azar() * 6) }, () => valorAleatorio(azar, prof + 1));
  const o: Record<string, unknown> = {};
  for (let i = 0; i < Math.floor(azar() * 6); i++) o[`k ${i}`] = valorAleatorio(azar, prof + 1);
  return o;
}
