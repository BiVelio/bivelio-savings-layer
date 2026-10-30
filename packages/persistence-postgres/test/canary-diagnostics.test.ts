import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ScriptTarget, transpileModule } from "typescript";

async function canarySource(): Promise<{ source: string; worker: string }> {
  const source = await readFile(fileURLToPath(new URL("../benchmark/live-canary.ts", import.meta.url)), "utf8");
  const worker = /const worker = String\.raw`([\s\S]*?)`;/.exec(source)?.[1];
  if (!worker) throw new Error("canary worker source is missing");
  return { source, worker };
}

describe("live canary failure diagnostics", () => {
  it("preserves a DOMException timeout name without leaking its message", async () => {
    const { worker } = await canarySource();
    const start = worker.lastIndexOf("} catch (error) {");
    const end = worker.indexOf("\n}\n\nasync function closePool", start);
    if (start < 0 || end < 0) throw new Error("worker error handler is missing");
    const body = worker.slice(start + "} catch (error) {".length, end);
    const execute = new Function(
      "error", "resultPath", "layers", "closePool", "writeFile", "process", "providerCalls", "phase", "records",
      `return (async () => {
        try { throw error; } catch (error) {
${body}
        }
      })()`,
    );
    let report = "";
    let closed = 0;
    const childProcess = { exitCode: 0 };
    await execute(
      new DOMException("canary-secret", "TimeoutError"),
      "unused.json",
      new Map([["tenant", { close: async () => { closed++; } }]]),
      async () => { closed++; },
      async (_path: string, text: string) => { report = text; },
      childProcess,
      14,
      "cold",
      [],
    );

    expect(JSON.parse(report)).toMatchObject({ ok: false, errorName: "TimeoutError", providerCalls: 14 });
    expect(report).not.toContain("canary-secret");
    expect(childProcess.exitCode).toBe(1);
    expect(closed).toBe(2);
  });

  it("retains the redacted failed worker report before deleting temporary files", async () => {
    const { source } = await canarySource();
    const start = source.indexOf("      } catch (caught) {");
    const end = source.indexOf("      const result = JSON.parse", start);
    if (start < 0 || end < 0) throw new Error("parent error handler is missing");
    const body = transpileModule(`try { throw caught; ${source.slice(start, end)}`, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    const execute = new Function(
      "caught", "resultPath", "output", "phase", "readFile", "writeFile", "mkdir", "dirname", "redact", "process",
      `return (async () => {${body}})()`,
    );
    let retained = "";
    await expect(execute(
      new Error("worker failed"),
      "cold.json",
      "results/live-canary.json",
      "cold",
      async () => JSON.stringify({
        ok: false,
        phase: "cold",
        errorName: "TimeoutError",
        diagnostic: "canary-secret",
        records: [],
        providerCalls: 14,
      }),
      async (_path: string, text: string) => { retained = text; },
      async () => undefined,
      (path: string) => path.split("/").slice(0, -1).join("/"),
      (text: string) => text.replaceAll("canary-secret", "[redacted]"),
      { env: {} },
    )).rejects.toThrow(/cold packaged worker failed.*TimeoutError/);

    expect(retained).not.toBe("");
    expect(JSON.parse(retained)).toMatchObject({ ok: false, phase: "cold", errorName: "TimeoutError", providerCalls: 14 });
    expect(retained).not.toContain("canary-secret");
  });
});
