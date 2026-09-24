import { describe, it, expect, vi } from "vitest";

import { SseParser, sseMessages, type SseMessage } from "../src/providers/sse.js";

/**
 * EL PARSER SSE que leen los adaptadores del SDK (y el gateway). Un parser que
 * pierde o parte un mensaje según por dónde corte la red el TCP no es un
 * detalle: el mensaje perdido puede ser el del usage final, y sin él la
 * petición sale `unmeasured` —o peor, la respuesta se da por cortada—.
 */

function todos(chunks: (string | Uint8Array)[]): SseMessage[] {
  const p = new SseParser();
  const out: SseMessage[] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.end());
  return out;
}

function flujo(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      controller.close();
    },
  });
}

async function recoger(it: AsyncIterable<SseMessage>): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const m of it) out.push(m);
  return out;
}

const CUERPO =
  'event: message_start\ndata: {"type":"message_start","n":1}\n\n' +
  ": un comentario del servidor\n\n" +
  'data: {"choices":[{"delta":{"content":"hola ñandú 🦙"}}]}\n\n' +
  "id: 7\nevent: ping\ndata: {}\n\n" +
  "data: [DONE]\n\n";

describe("SseParser", () => {
  it("un mensaje partido en cada byte posible produce los mismos mensajes", () => {
    const esperado = todos([CUERPO]);
    expect(esperado).toHaveLength(4);
    const bytes = new TextEncoder().encode(CUERPO);
    for (let corte = 1; corte < bytes.length; corte++) {
      const partidos = todos([bytes.slice(0, corte), bytes.slice(corte)]);
      expect(partidos, `corte=${corte}`).toEqual(esperado);
    }
    // Y también troceado byte a byte.
    const aTrozos: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i++) aTrozos.push(bytes.slice(i, i + 1));
    expect(todos(aTrozos)).toEqual(esperado);
  });

  it("CRLF, CR solo y un \\r al final de un chunk con \\n al principio del siguiente son UNA ruptura", () => {
    const crlf = todos(["data: a\r\n\r\ndata: b\r\n\r\n"]);
    const cr = todos(["data: a\r\rdata: b\r\r"]);
    const partido = todos(["data: a\r", "\n\r", "\ndata: b\r\n\r\n"]);
    const esperado = [
      { event: "message", data: "a" },
      { event: "message", data: "b" },
    ];
    expect(crlf).toEqual(esperado);
    expect(cr).toEqual(esperado);
    expect(partido).toEqual(esperado);
  });

  it("varias líneas `data:` se unen con \\n", () => {
    expect(todos(["data: uno\ndata: dos\ndata:tres\n\n"])).toEqual([
      { event: "message", data: "uno\ndos\ntres" },
    ]);
  });

  it("`: comentario` se ignora", () => {
    expect(todos([": hola\n: otro\n\n"])).toEqual([]);
    expect(todos([": hola\ndata: x\n\n"])).toEqual([{ event: "message", data: "x" }]);
  });

  it("`event:` fija el tipo, y sin él el tipo es \"message\"", () => {
    expect(todos(["event: error\ndata: {}\n\ndata: {}\n\n"])).toEqual([
      { event: "error", data: "{}" },
      { event: "message", data: "{}" },
    ]);
  });

  it("end() despacha un mensaje sin línea en blanco final", () => {
    expect(todos(["data: [DONE]"])).toEqual([{ event: "message", data: "[DONE]" }]);
    expect(todos(["data: [DONE]\n"])).toEqual([{ event: "message", data: "[DONE]" }]);
  });

  it("un carácter UTF-8 de 4 bytes partido entre chunks se decodifica bien", () => {
    const bytes = new TextEncoder().encode("data: 🦙\n\n");
    // El emoji ocupa los bytes 6..9: se parte en cada punto intermedio.
    for (const corte of [7, 8, 9]) {
      expect(todos([bytes.slice(0, corte), bytes.slice(corte)]), `corte=${corte}`).toEqual([
        { event: "message", data: "🦙" },
      ]);
    }
  });

  it("guarda el id, ignora `retry` y los campos desconocidos, y una línea sin `:` es un campo vacío", () => {
    expect(todos(["retry: 10\nfoo: bar\nid: 3\ndata\n\n"])).toEqual([
      { event: "message", data: "", id: "3" },
    ]);
  });
});

describe("sseMessages", () => {
  it("sobre un string y sobre un ReadableStream produce el mismo resultado", async () => {
    const deString = await recoger(sseMessages(CUERPO));
    const bytes = new TextEncoder().encode(CUERPO);
    const trozos: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 5) trozos.push(bytes.slice(i, i + 5));
    const deStream = await recoger(sseMessages(flujo(trozos)));
    expect(deStream).toEqual(deString);
    expect(deString).toEqual(todos([CUERPO]));
  });

  it("salir del for-await llama a reader.cancel() (libera la conexión)", async () => {
    const enc = new TextEncoder();
    const cancel = vi.fn(async () => {});
    let n = 0;
    const falso = {
      getReader() {
        return {
          read: async () => {
            n += 1;
            return { done: false, value: enc.encode(`data: ${n}\n\n`) };
          },
          cancel,
          releaseLock() {},
        };
      },
    } as unknown as ReadableStream<Uint8Array>;
    const vistos: string[] = [];
    for await (const m of sseMessages(falso)) {
      vistos.push(m.data);
      if (vistos.length === 2) break;
    }
    expect(vistos).toEqual(["1", "2"]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
