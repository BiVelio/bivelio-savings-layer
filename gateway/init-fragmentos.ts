/**
 * LOS FRAGMENTOS DE `bvsala init`: el código exacto que se le da al cliente para
 * cada pila (capa × proveedor × anfitrión).
 *
 * Son la ÚNICA fuente. Los ejemplos de `examples/` son su salida, byte a byte, y
 * `test/init-ejemplos.test.ts` lo exige: si un fragmento cambia sin su ejemplo, o al
 * revés, la verja se pone roja. Y los ejemplos se typechequean (tsconfig incluye
 * `examples/`) y se EJECUTAN en la suite contra los frameworks de verdad, sin red.
 *
 * Tres reglas que explican la forma de todo lo de abajo:
 *
 * 1. Sin anotaciones de tipo. El mismo texto tiene que valer como `.ts`, `.js` y
 *    `.mjs`, porque el proyecto del cliente puede ser cualquiera de los tres. La
 *    única excepción es la ruta de uso de Next.js con TypeScript (`req: Request`
 *    y el cast del cuerpo), y el test comprueba que es lo único que cambia.
 * 2. La comprobación es AUTOCONTENIDA: no importa el cableado, así que no depende
 *    de alias de rutas, extensiones ni de dónde viva `savings.ts`.
 * 3. La pregunta de la comprobación (2 + 2 * 3) la contesta el resolver aritmético
 *    de la capa sin llamar al modelo. Con la capa en su sitio, el proveedor no
 *    factura nada; el ahorro sale `estimated`, que nunca se cobra.
 */

/** La capa por la que el proyecto llama al LLM, que decide el adaptador. */
export type Capa = "ai-sdk" | "mastra" | "langchain" | "anthropic-sdk" | "sdk";
/** El proveedor del modelo del ejemplo. */
export type Proveedor = "openai" | "anthropic";

export const CAPAS: readonly Capa[] = ["ai-sdk", "mastra", "langchain", "anthropic-sdk", "sdk"];

/** Los proveedores que tiene sentido combinar con cada capa. */
export const PROVEEDORES_DE: Readonly<Record<Capa, readonly Proveedor[]>> = {
  "ai-sdk": ["openai", "anthropic"],
  mastra: ["openai", "anthropic"],
  langchain: ["openai", "anthropic"],
  "anthropic-sdk": ["anthropic"],
  sdk: ["openai", "anthropic"],
};

/** El nombre legible de cada capa, para la salida. */
export const NOMBRE_DE_CAPA: Readonly<Record<Capa, string>> = {
  "ai-sdk": "Vercel AI SDK",
  mastra: "Mastra",
  langchain: "LangChain.js",
  "anthropic-sdk": "Anthropic TypeScript SDK",
  sdk: "the SDK directly (no framework)",
};

/** El subpath del paquete que usa cada capa. */
export const MODULO_DE_CAPA: Readonly<Record<Capa, string>> = {
  "ai-sdk": "@bivelio/savings-layer/ai-sdk",
  mastra: "@bivelio/savings-layer/mastra",
  langchain: "@bivelio/savings-layer/langchain",
  "anthropic-sdk": "@bivelio/savings-layer/anthropic-sdk",
  sdk: "@bivelio/savings-layer",
};

// Los modelos de los ejemplos: dos con fila vigente en el catálogo (la verja
// modelos-que-servimos barre este fichero). El cliente pone el suyo.
const MODELO: Readonly<Record<Proveedor, string>> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
};

const PREGUNTA = "What is 2 + 2 * 3?";

/** Las tres opciones de licencia y medición, idénticas en todos los fragmentos (README incluido). */
const OPCIONES = [
  "licenseKey: process.env.BIVELIO_LICENSE_KEY,",
  'licenseServerUrl: "https://savings.bivelio.com",',
  "serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,",
];

/** Lo que la comprobación añade a las opciones de un adaptador para ver su informe. */
const AL_INFORMAR = [
  "onReport: (report) => {",
  "  seen.calls += 1;",
  "  seen.avoidedLlm = report.calls.avoidedLlm;",
  "  seen.basis = report.cost.basis;",
  "},",
];

/**
 * Los paquetes que importan los fragmentos de una pila, además de
 * `@bivelio/savings-layer`: lo que la línea de instalación tiene que garantizar.
 */
export function paquetesDeLaPila(capa: Capa, proveedor: Proveedor): string[] {
  switch (capa) {
    case "ai-sdk":
      return ["ai", proveedor === "openai" ? "@ai-sdk/openai" : "@ai-sdk/anthropic"];
    case "mastra":
      return ["@mastra/core"];
    case "langchain":
      // El modelo en cadena ("openai:…") lo carga LangChain con su paquete de
      // integración. Sin él, `invoke` falla ANTES de llegar al middleware:
      // «Unable to import @langchain/openai» (medido con langchain 1.5.14).
      return ["langchain", "@langchain/core", proveedor === "openai" ? "@langchain/openai" : "@langchain/anthropic"];
    case "anthropic-sdk":
      return ["@anthropic-ai/sdk"];
    case "sdk":
      return [];
  }
}

function sangrar(lineas: readonly string[], n: number): string[] {
  const pre = " ".repeat(n);
  return lineas.map((l) => (l === "" ? "" : pre + l));
}

/** Las piezas de una capa: imports, construcción y la llamada de ejemplo. */
interface Receta {
  /** Imports del cableado (framework y adaptador). */
  imports: string[];
  /** Nombre de la variable del adaptador (lo que se cierra con `close()`). */
  adaptador: string;
  /** Construcción: el adaptador con sus opciones y lo que lo envuelve. `extra` va dentro de las opciones. */
  construir: (extra: readonly string[], exportar: boolean) => string[];
  /** Lo que exporta el cableado y usa la ruta de ejemplo. */
  exporta: string[];
  /** Imports extra que necesita la llamada de ejemplo. */
  importsDeUso: string[];
  /** La llamada: deja `text` y, si la capa lo da por llamada, `basis`. */
  llamar: (prompt: string) => string[];
  /** ¿`llamar` deja `basis`? */
  daBasis: boolean;
  /** Imports extra de la comprobación. */
  importsDeComprobacion: string[];
  /** La llamada de la comprobación: deja `text` (y, en el SDK, `report`). */
  preguntar: (pregunta: string) => string[];
}

function exp(exportar: boolean): string {
  return exportar ? "export " : "";
}

function receta(capa: Capa, proveedor: Proveedor): Receta {
  const modelo = MODELO[proveedor];
  switch (capa) {
    case "ai-sdk": {
      const fabrica = proveedor === "openai" ? "openai" : "anthropic";
      return {
        imports: [
          'import { wrapLanguageModel } from "ai";',
          `import { ${fabrica} } from "@ai-sdk/${fabrica}";`,
          'import { savingsMiddleware } from "@bivelio/savings-layer/ai-sdk";',
        ],
        adaptador: "savings",
        construir: (extra, exportar) => [
          `${exp(exportar)}const savings = savingsMiddleware({`,
          ...sangrar([...OPCIONES, ...extra], 2),
          "});",
          ...(exportar
            ? ["", "// Pass `model` wherever you pass a model today (generateText, streamText…).", "// `savings` goes LAST in the middleware list: nothing between it and the model."]
            : []),
          `${exp(exportar)}const model = wrapLanguageModel({ model: ${fabrica}("${modelo}"), middleware: savings });`,
        ],
        exporta: ["model"],
        importsDeUso: ['import { generateText } from "ai";', 'import { getSavingsReport } from "@bivelio/savings-layer/ai-sdk";'],
        llamar: (prompt) => [
          `const result = await generateText({ model, ${prompt === "prompt" ? "prompt" : `prompt: ${prompt}`} });`,
          "const text = result.text;",
          "const basis = getSavingsReport(result)?.cost.basis;",
        ],
        daBasis: true,
        importsDeComprobacion: ['import { generateText } from "ai";'],
        preguntar: (pregunta) => [`const { text } = await generateText({ model, prompt: ${pregunta} });`],
      };
    }
    case "mastra":
      return {
        imports: ['import { Agent } from "@mastra/core/agent";', 'import { savingsProcessor } from "@bivelio/savings-layer/mastra";'],
        adaptador: "bivelio",
        construir: (extra, exportar) => [
          `${exp(exportar)}const bivelio = savingsProcessor({`,
          ...sangrar([...OPCIONES, ...extra], 2),
          "});",
          ...(exportar
            ? [
                "",
                "// Add `bivelio` LAST to the inputProcessors of each agent you already have;",
                "// this one shows where. Its reports go to `onReport` if you pass one above.",
              ]
            : []),
          `${exp(exportar)}const agent = new Agent({`,
          '  id: "assistant",',
          '  name: "Assistant",',
          '  instructions: "Answer briefly.",',
          `  model: "${proveedor}/${modelo}",`,
          "  inputProcessors: [bivelio],",
          "});",
        ],
        exporta: ["agent"],
        importsDeUso: [],
        llamar: (prompt) => [`const result = await agent.generate(${prompt});`, "const text = result.text;"],
        daBasis: false,
        importsDeComprobacion: [],
        preguntar: (pregunta) => [`const { text } = await agent.generate(${pregunta});`],
      };
    case "langchain":
      return {
        imports: [
          'import { createAgent } from "langchain";',
          'import { savingsAgentMiddleware } from "@bivelio/savings-layer/langchain";',
        ],
        adaptador: "savings",
        construir: (extra, exportar) => [
          `${exp(exportar)}const savings = savingsAgentMiddleware({`,
          ...sangrar([...OPCIONES, ...extra], 2),
          "});",
          ...(exportar
            ? ["", "// Add `savings` LAST to the middleware of each agent you already have; this one shows where."]
            : []),
          `${exp(exportar)}const agent = createAgent({ model: "${proveedor}:${modelo}", tools: [], middleware: [savings] });`,
        ],
        exporta: ["agent"],
        importsDeUso: ['import { getSavingsReportFromMessage } from "@bivelio/savings-layer/langchain";'],
        llamar: (prompt) => [
          `const state = await agent.invoke({ messages: [{ role: "user", content: ${prompt} }] });`,
          "const last = state.messages.at(-1);",
          'const text = last?.text ?? "";',
          "const basis = getSavingsReportFromMessage(last)?.cost.basis;",
        ],
        daBasis: true,
        importsDeComprobacion: [],
        preguntar: (pregunta) => [
          `const state = await agent.invoke({ messages: [{ role: "user", content: ${pregunta} }] });`,
          'const text = state.messages.at(-1)?.text ?? "";',
        ],
      };
    case "anthropic-sdk": {
      const crear = (prompt: string) =>
        `const message = await client.messages.create({ model: "${modelo}", max_tokens: 1024, messages: [{ role: "user", content: ${prompt} }] });`;
      const texto = 'const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");';
      return {
        imports: ['import Anthropic from "@anthropic-ai/sdk";', 'import { anthropicSavings } from "@bivelio/savings-layer/anthropic-sdk";'],
        adaptador: "claudeSavings",
        construir: (extra, exportar) => [
          `${exp(exportar)}const claudeSavings = anthropicSavings({`,
          ...sangrar([...OPCIONES, ...extra], 2),
          "});",
          ...(exportar
            ? ["", "// Use `client` for messages.create(); `claudeSavings.middleware` goes LAST in the list."]
            : []),
          `${exp(exportar)}const client = new Anthropic({ middleware: [claudeSavings.middleware] });`,
        ],
        exporta: ["client", "claudeSavings"],
        importsDeUso: [],
        llamar: (prompt) => [crear(prompt), texto, "const basis = claudeSavings.reportFor(message)?.cost.basis;"],
        daBasis: true,
        importsDeComprobacion: [],
        preguntar: (pregunta) => [crear(pregunta), texto],
      };
    }
    case "sdk": {
      const qualificado = `${proveedor}/${modelo}`;
      const proveedorNuevo =
        proveedor === "openai"
          ? 'provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),'
          : "provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),";
      const clase = proveedor === "openai" ? "OpenAICompatibleProvider" : "AnthropicProvider";
      const importe =
        proveedor === "openai"
          ? `import { createSavingsLayer, ${clase} } from "@bivelio/savings-layer";`
          : `import { ${clase}, createSavingsLayer } from "@bivelio/savings-layer";`;
      return {
        imports: [importe],
        adaptador: "layer",
        construir: (extra, exportar) => [
          ...(exportar ? ["// Your provider. LLM traffic goes straight to it: the layer is not a proxy."] : []),
          `${exp(exportar)}const layer = createSavingsLayer({`,
          ...sangrar([proveedorNuevo, ...OPCIONES, ...extra], 2),
          "});",
        ],
        exporta: ["layer"],
        importsDeUso: [],
        llamar: (prompt) => [
          `const { text, report } = await layer.generate({ model: "${qualificado}", messages: [{ role: "user", content: ${prompt} }] });`,
          "const basis = report.cost.basis;",
        ],
        daBasis: true,
        importsDeComprobacion: [],
        preguntar: (pregunta) => [
          `const { text, report } = await layer.generate({ model: "${qualificado}", messages: [{ role: "user", content: ${pregunta} }] });`,
        ],
      };
    }
  }
}

/**
 * EL CABLEADO: un módulo nuevo que crea la capa UNA vez y exporta lo que el
 * proyecto usa. Una vez por proceso, no por petición: la caché exacta de la capa
 * vive en esa instancia, y crearla por petición la dejaría siempre vacía.
 */
export function cableado(capa: Capa, proveedor: Proveedor): string {
  const r = receta(capa, proveedor);
  return [
    "// BiVelio Savings Layer: created once, when this module loads, and reused by every",
    "// request. The exact cache lives in this instance, so do not create one per request.",
    ...r.imports,
    "",
    ...r.construir([], true),
    "",
  ].join("\n");
}

/** La cabecera común de las dos comprobaciones. */
const CABECERA_COMPROBACION = [
  "// BiVelio Savings Layer: a free wiring check, generated by `bvsala init`.",
  "// It asks a question the layer answers on this machine (2 + 2 * 3), so with the",
  "// layer in place the model is not called and your provider bills nothing for it.",
  "// The saving is `estimated`, and estimated savings are never billed. It needs",
  "// BIVELIO_LICENSE_KEY: the layer is fail-closed. Delete this file once it says ok.",
];

/**
 * El veredicto de la comprobación: `ok` y `line`. No se llama `message`: en la
 * pila de Anthropic ese nombre ya es el mensaje que devuelve el SDK.
 */
function veredicto(capa: Capa): string[] {
  if (capa === "sdk") {
    return [
      'const ok = text.trim() === "8" && report.calls.avoidedLlm === 1;',
      "const line = ok",
      '  ? `ok: the layer answered "8" on this machine without calling the model (basis: ${report.cost.basis}).`',
      "  : `not ok: the layer did not answer it (got ${JSON.stringify(text)}). Send this output to support@bivelio.com.`;",
    ];
  }
  return [
    'const ok = text.trim() === "8" && seen.avoidedLlm === 1;',
    "const line = ok",
    '  ? `ok: the layer answered "8" on this machine without calling the model (basis: ${seen.basis}).`',
    "  : seen.calls === 0",
    '    ? "not ok: the layer did not see the call. It has to go LAST in the list, next to the model."',
    "    : `not ok: the layer saw the call but did not answer it (got ${JSON.stringify(text)}). Send this output to support@bivelio.com.`;",
  ];
}

function preambuloDeComprobacion(capa: Capa, proveedor: Proveedor): { imports: string[]; cuerpo: string[] } {
  const r = receta(capa, proveedor);
  const unidos = unirImports([...r.importsDeComprobacion, ...r.imports]);
  const cuerpo =
    capa === "sdk"
      ? r.construir([], false)
      : ['const seen = { calls: 0, avoidedLlm: 0, basis: "" };', ...r.construir(AL_INFORMAR, false)];
  return { imports: unidos, cuerpo };
}

/**
 * Une los imports con nombre del mismo módulo en una sola línea (`generateText` y
 * `wrapLanguageModel` de "ai"; el adaptador y su lector de informes), en el orden
 * en que aparece cada módulo. Un import por defecto se deja como está.
 */
function unirImports(imports: readonly string[]): string[] {
  const porModulo = new Map<string, Set<string>>();
  const salida: Array<string | { modulo: string }> = [];
  for (const linea of imports) {
    const m = /^import \{ ([^}]+) \} from "([^"]+)";$/.exec(linea);
    if (!m) {
      if (!salida.includes(linea)) salida.push(linea);
      continue;
    }
    const [, nombres = "", modulo = ""] = m;
    let conjunto = porModulo.get(modulo);
    if (!conjunto) {
      conjunto = new Set();
      porModulo.set(modulo, conjunto);
      salida.push({ modulo });
    }
    for (const n of nombres.split(", ")) conjunto.add(n);
  }
  return salida.map((e) =>
    typeof e === "string" ? e : `import { ${[...(porModulo.get(e.modulo) ?? [])].sort().join(", ")} } from "${e.modulo}";`,
  );
}

/**
 * LA COMPROBACIÓN COMO SCRIPT (`bivelio-check.mjs`): `node bivelio-check.mjs`.
 * Imprime `ok: …` o `not ok: …` y sale con 0 o 1, para que también sirva en CI.
 */
export function comprobacionScript(capa: Capa, proveedor: Proveedor): string {
  const r = receta(capa, proveedor);
  const { imports, cuerpo } = preambuloDeComprobacion(capa, proveedor);
  return [
    ...CABECERA_COMPROBACION,
    ...imports,
    "",
    ...cuerpo,
    "",
    "try {",
    ...sangrar([...r.preguntar(JSON.stringify(PREGUNTA)), ...veredicto(capa), "console.log(line);", "if (!ok) process.exitCode = 1;"], 2),
    "} catch (err) {",
    "  console.log(`not ok: ${err instanceof Error ? err.message : String(err)}`);",
    "  process.exitCode = 1;",
    "} finally {",
    `  ${r.adaptador}.close();`,
    "}",
    "",
  ].join("\n");
}

/**
 * LA COMPROBACIÓN COMO RUTA de Next.js (App Router): GET en desarrollo.
 *
 * `dynamic = "force-dynamic"` no es decorativo: hasta Next.js 14 un GET sin nada
 * dinámico se prerenderizaba EN EL BUILD (cambió a dinámico en la 15.0), así que
 * sin él `next build` ejecutaría la comprobación, y sin licencia en el entorno
 * del build, el build fallaría. En producción responde 404: es de un solo uso.
 */
export function comprobacionRuta(capa: Capa, proveedor: Proveedor): string {
  const r = receta(capa, proveedor);
  const { imports, cuerpo } = preambuloDeComprobacion(capa, proveedor);
  return [
    ...CABECERA_COMPROBACION,
    "// It answers only in development: in production it is a 404.",
    ...imports,
    "",
    "// Run on each request, never at build time.",
    'export const dynamic = "force-dynamic";',
    "",
    "export async function GET() {",
    '  if (process.env.NODE_ENV === "production") {',
    '    return new Response("Not found", { status: 404 });',
    "  }",
    ...sangrar(cuerpo, 2),
    "  try {",
    ...sangrar([...r.preguntar(JSON.stringify(PREGUNTA)), ...veredicto(capa), "return Response.json({ ok, message: line }, { status: ok ? 200 : 500 });"], 4),
    "  } catch (err) {",
    "    return Response.json({ ok: false, message: `not ok: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });",
    "  } finally {",
    `    ${r.adaptador}.close();`,
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * EL USO en una ruta de Next.js (`app/api/chat/route.ts`), importando el cableado
 * por ruta relativa y sin extensión, que es como resuelve Next.js.
 */
export function usoNext(capa: Capa, proveedor: Proveedor, opciones: { ts: boolean; importeDelCableado: string }): string {
  const r = receta(capa, proveedor);
  const campos = r.daBasis ? "{ text, basis }" : "{ text }";
  return [
    ...unirImports(r.importsDeUso),
    `import { ${r.exporta.slice().sort().join(", ")} } from "${opciones.importeDelCableado}";`,
    "",
    `export async function POST(req${opciones.ts ? ": Request" : ""}) {`,
    // `req.json()` es `Promise<any>` con la lib DOM de un proyecto Next.js y
    // `Promise<unknown>` sin ella: con el cast, el TS compila en los dos.
    `  const { prompt } = ${opciones.ts ? "(await req.json()) as { prompt: string }" : "await req.json()"};`,
    ...sangrar(r.llamar("prompt"), 2),
    `  return Response.json(${campos});`,
    "}",
    "",
  ].join("\n");
}

/**
 * EL USO en Express: autocontenido, con la capa creada al arrancar (nunca dentro
 * del handler) y el error al `next`, que vale en Express 4 y 5.
 */
export function usoExpress(capa: Capa, proveedor: Proveedor): string {
  const r = receta(capa, proveedor);
  const campos = r.daBasis ? "{ text, basis }" : "{ text }";
  return [
    'import express from "express";',
    ...unirImports([...r.imports, ...r.importsDeUso]),
    "",
    "// Created once, at startup, not inside the handler: the exact cache lives in this instance.",
    ...r.construir([], false),
    "",
    "const app = express();",
    "app.use(express.json());",
    "",
    'app.post("/api/chat", async (req, res, next) => {',
    "  try {",
    ...sangrar(r.llamar('String(req.body?.prompt ?? "")'), 4),
    `    res.json(${campos});`,
    "  } catch (err) {",
    "    next(err);",
    "  }",
    "});",
    "",
    "app.listen(Number(process.env.PORT ?? 3000));",
    "",
  ].join("\n");
}
