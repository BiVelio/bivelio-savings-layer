import { describe, it, expect } from "vitest";

import { MockProvider } from "../src/index.js";
import type { ProviderRequest, ProviderStreamEvent } from "../src/index.js";

/** El proveedor de mentira también streamea, y de forma determinista. */

const REQ: ProviderRequest = { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hola" }] };

async function recoger(it: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("MockProvider.generateStream", () => {
  it("trocea la respuesta en eventos de streamChunkChars caracteres", async () => {
    const p = new MockProvider({ answer: "abcdefghij", streamChunkChars: 4 });
    const evs = await recoger(p.generateStream(REQ));
    expect(evs.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta)).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);
    expect(evs[evs.length - 1]!.type).toBe("done");
  });

  it("done.response es igual en profundidad a lo que devuelve generate()", async () => {
    const p = new MockProvider({ answer: "una respuesta algo más larga que ocho caracteres" });
    const evs = await recoger(p.generateStream(REQ));
    const d = evs[evs.length - 1]!;
    expect(d.type).toBe("done");
    expect((d as { response: unknown }).response).toEqual(await p.generate(REQ));
    // Por defecto, 8 caracteres por evento.
    expect((evs[0] as { delta: string }).delta).toHaveLength(8);
  });

  it("es determinista entre ejecuciones", async () => {
    const p = new MockProvider({ answer: "determinista" });
    expect(await recoger(p.generateStream(REQ))).toEqual(await recoger(p.generateStream(REQ)));
  });
});
