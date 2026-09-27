import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LOS TIPOS PUBLICADOS DE LOS ADAPTADORES, COMPILADOS CONTRA CADA FRAMEWORK.
 *
 * `dist/adapters/*.d.ts` importa los tipos del framework por su nombre (`ai`,
 * `@mastra/core/processors`, `langchain`, `@anthropic-ai/sdk`), así que resuelven
 * contra la versión que tenga instalada el CLIENTE. Aquí se compila el uso real
 * de cada adaptador —pasarlo donde el framework lo espera— contra el `.d.ts`
 * publicado, no contra el fuente. Y el del AI SDK, dos veces: con `ai` 7 y con
 * `ai` 6, las dos líneas soportadas (el mismo objeto sirve a las dos).
 */

const RAIZ = new URL("../..", import.meta.url).pathname;

function compila(fragmento: string, extraPaths: Record<string, string[]> = {}): string {
  const cache = join(RAIZ, "node_modules/.cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "bvsala-tipos-"));
  try {
    writeFileSync(join(dir, "uso.ts"), fragmento);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
          typeRoots: [join(RAIZ, "node_modules/@types")],
          baseUrl: dir,
          paths: {
            "@bivelio/savings-layer": [join(RAIZ, "dist/index.d.ts")],
            "@bivelio/savings-layer/*": [join(RAIZ, "dist/adapters/*.d.ts")],
            ...extraPaths,
          },
        },
        include: ["uso.ts"],
      }),
    );
    try {
      execFileSync(join(RAIZ, "node_modules/.bin/tsc"), ["-p", dir], { cwd: RAIZ, stdio: ["ignore", "pipe", "pipe"] });
      return "";
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      return `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const AI_SDK = `
import { wrapLanguageModel } from "ai";
import { getSavingsReport, savingsMiddleware, type SavingsMiddleware } from "@bivelio/savings-layer/ai-sdk";
declare const base: Parameters<typeof wrapLanguageModel>[0]["model"];
const mw: SavingsMiddleware = savingsMiddleware({ licenseKey: "k", readOnlyTools: ["a"], onReport: (r) => void r.cost.basis });
const uno = wrapLanguageModel({ model: base, middleware: mw });
const varios = wrapLanguageModel({ model: base, middleware: [mw] });
const basis: string | undefined = getSavingsReport({ providerMetadata: {} })?.cost.basis;
void uno; void varios; void basis;
mw.close();
`;

describe("los tipos publicados de los adaptadores", () => {
  it("hay tipos publicados que compilar (el build tiene que haber corrido)", () => {
    for (const a of ["ai-sdk", "mastra", "langchain", "anthropic-sdk"]) {
      expect(existsSync(join(RAIZ, `dist/adapters/${a}.d.ts`)), a).toBe(true);
    }
  });

  it("AI SDK 7: el middleware entra en wrapLanguageModel, solo o en lista", () => {
    expect(compila(AI_SDK)).toBe("");
  }, 60_000);

  it("AI SDK 6: el MISMO .d.ts, resuelto contra ai 6, también", () => {
    expect(compila(AI_SDK, { ai: [join(RAIZ, "node_modules/ai-v6/dist/index.d.ts")] })).toBe("");
  }, 60_000);

  it("Mastra: el procesador entra en inputProcessors y en errorProcessors", () => {
    const uso = `
import { Agent } from "@mastra/core/agent";
import { savingsProcessor } from "@bivelio/savings-layer/mastra";
const p = savingsProcessor({ licenseKey: "k", emitReportPart: true, providerTimeoutMs: 1000 });
const a = new Agent({ id: "a", name: "a", instructions: "x", model: "openai/gpt-4o-mini", inputProcessors: [p], errorProcessors: [p] });
void a; p.close();
`;
    expect(compila(uso)).toBe("");
  }, 60_000);

  it("LangChain: el middleware entra en createAgent", () => {
    const uso = `
import { createAgent } from "langchain";
import { getSavingsReportFromMessage, savingsAgentMiddleware } from "@bivelio/savings-layer/langchain";
const mw = savingsAgentMiddleware({ licenseKey: "k" });
const agente = createAgent({ model: "openai:gpt-4o-mini", tools: [], middleware: [mw] });
void agente; void getSavingsReportFromMessage(undefined)?.cost.basis; mw.close();
`;
    expect(compila(uso)).toBe("");
  }, 60_000);

  it("Anthropic: el middleware entra en el cliente, y reportFor acepta un Message", () => {
    const uso = `
import Anthropic from "@anthropic-ai/sdk";
import { anthropicSavings } from "@bivelio/savings-layer/anthropic-sdk";
const s = anthropicSavings({ licenseKey: "k", reportCacheSize: 10 });
const client = new Anthropic({ apiKey: "x", middleware: [s.middleware] });
declare const m: Anthropic.Message;
void client; void s.reportFor(m)?.cost.basis; s.close();
`;
    expect(compila(uso)).toBe("");
  }, 60_000);
});
