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

/** Las opciones del fragmento, idénticas en todos (README incluido): open core sin claves; la nube, optativa. */
const OPCIONES = [
  "// OPEN CORE: no license needed — the layer runs with every local saving lever on, zero telemetry.",
  "// A license key that IS set but invalid still fails closed. For the cloud dashboard,",
  "// team metering and license auto-renewal, add these lines (all optional):",
  "licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,",
  '// licenseServerUrl: "https://savings.bivelio.com",',
  "// serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,",
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

// ── La compactación sin pérdida de tool outputs (D11, opt-in) ───────────────
//
// `bvsala init --compaction on|measure`. Dónde se puede ENCENDER lo decide
// `admiteCompactacion`, y la regla es la del piloto (decisión provisional,
// revisable por el dueño): la API de Mensajes de Anthropic, sin stream, a través
// del SDK (`createSavingsLayer` con `AnthropicProvider`). Los adaptadores de
// framework reenvían al modelo la petición que construyó el framework TAL CUAL
// (el cuerpo no se reserializa), así que la capa no tiene copia que compactar; y
// OpenAI queda fuera del piloto. `measure` no toca la inferencia: vale en
// cualquier pila de JavaScript.

/** Lo que `init` hace con la compactación de tool outputs. `off`: nada (por defecto). */
export type ModoDeCompactacion = "off" | "measure" | "on";
export const MODOS_DE_COMPACTACION: readonly ModoDeCompactacion[] = ["off", "measure", "on"];

/** Si `--compaction on` puede encenderse en esta pila, y si no, por qué (en inglés: va a la terminal). */
export function admiteCompactacion(capa: Capa, proveedor: Proveedor): { admite: true } | { admite: false; motivo: string } {
  if (capa !== "sdk") {
    return {
      admite: false,
      motivo:
        `the ${NOMBRE_DE_CAPA[capa]} adapter forwards the request your framework built to the model as it is, ` +
        "and refuses a rewritten one, so the layer has no copy of its own to compact. Only a request the layer " +
        "sends itself (createSavingsLayer with AnthropicProvider, without streaming in this pilot) can be compacted",
    };
  }
  if (proveedor !== "anthropic") {
    return {
      admite: false,
      motivo:
        "this pilot covers Anthropic Messages without streaming, through the SDK; OpenAI requests stay as they are",
    };
  }
  return { admite: true };
}

/** Las líneas que `--compaction on` añade a las opciones de `createSavingsLayer`. */
export const LINEAS_DE_COMPACTACION: readonly string[] = [
  "// Opt-in and lossless: removes only the whitespace between JSON tokens of tool outputs",
  "// that are strict JSON, in the copy sent to the model (your history is not touched).",
  "// Every tool output gets an explained decision in report.toolOutputCompaction.",
  "// Verified for layer.generate() (no streaming). It also runs in generateStream(): pass",
  "// savings: { toolOutputCompaction: false } on a request to leave it as it is. Delete these lines to revert.",
  'toolOutputCompaction: { profile: "lossless-data" },',
];

/**
 * `--compaction measure`: un módulo que MIDE sin cambiar nada. Devuelve el tool
 * output tal cual llegó y apunta lo que el perfil `lossless-data` HARÍA con él.
 */
export function medicionDeCompactacion(): string {
  return [
    "// BiVelio Savings Layer: MEASURE ONLY, generated by `bvsala init --compaction measure`.",
    "// Nothing sent to the model changes: measureToolOutput returns the tool output exactly as",
    "// it came, and records what the lossless-data profile WOULD do with it (applied, or",
    "// bypassed and why). Token counts are local estimates, not your provider's count and not",
    "// a saving. Delete this file to stop measuring.",
    'import { compactToolOutput } from "@bivelio/savings-layer";',
    "",
    "export const measured = { outputs: 0, applied: 0, tokensBefore: 0, tokensAfter: 0, reasons: new Map() };",
    "",
    "// Call it where a tool result is produced, before it goes into your history.",
    'export function measureToolOutput(output = "") {',
    '  const { decision } = compactToolOutput(output, { profile: "lossless-data" });',
    "  if (decision) {",
    "    measured.outputs += 1;",
    '    if (decision.status === "applied") measured.applied += 1;',
    "    measured.tokensBefore += decision.tokensBefore;",
    "    measured.tokensAfter += decision.tokensAfter;",
    "    measured.reasons.set(decision.reason, (measured.reasons.get(decision.reason) ?? 0) + 1);",
    "  }",
    "  return output;",
    "}",
    "",
    "// Coverage first: with few outputs applied, there is nothing to turn on.",
    "export function measuredSummary() {",
    "  const coverage = measured.outputs === 0 ? 0 : measured.applied / measured.outputs;",
    "  return `${measured.applied} of ${measured.outputs} tool outputs would be compacted (${Math.round(coverage * 100)}%), ` +",
    "    `${measured.tokensBefore} -> ${measured.tokensAfter} estimated tokens. Reasons: ${JSON.stringify(Object.fromEntries(measured.reasons))}`;",
    "}",
    "",
  ].join("\n");
}

// La MUESTRA de la verificación: tres tool outputs con los tres desenlaces que
// más se ven. JSON sangrado (se compacta), JSON con una clave repetida (se
// desvía: `JSON.parse` ya se queda con una de las dos) y un log (no es JSON).
const FILAS_DE_MUESTRA = Array.from({ length: 12 }, (_, i) => ({ id: i, sku: `SKU-${1000 + i}`, stock: i * 7, price: 1.1 + i }));
export const MUESTRA_DE_VERIFICACION: ReadonlyArray<{ id: string; name: string; output: string }> = [
  { id: "toolu_verify_1", name: "query_inventory", output: JSON.stringify({ items: FILAS_DE_MUESTRA }, null, 2) },
  {
    id: "toolu_verify_2",
    name: "query_prices",
    output: `{\n  "currency": "USD",\n  "currency": "EUR",\n  "items": ${JSON.stringify(FILAS_DE_MUESTRA, null, 2)}\n}`,
  },
  { id: "toolu_verify_3", name: "sync_log", output: "sync started\nfetched 12 rows\nsync finished in 0.4s\n".repeat(8) },
];

/**
 * LA VERIFICACIÓN (`bivelio-verify-compaction.mjs`): UNA llamada local y acotada
 * a un modelo falso que vive en el propio script, y el recibo.
 *
 * Es un script que se ejecuta con `node`, como la comprobación, y no algo que
 * init corra: init no ejecuta nada del proyecto, y el gateway no construye la
 * capa del SDK (test/no-solape-gateway-pipeline.test.ts). Sin red: la capa se
 * crea sin `licenseServerUrl` ni `serviceAccountKey`, así que la licencia se
 * verifica fuera de línea y no se emite uso; el modelo es un objeto del script.
 * La licencia, del ENTORNO: un fallo de licencia se dice por nombre, sin eco de
 * su valor. Imprime la COBERTURA de la muestra y dice que no es la del tráfico.
 *
 * `on`: la capa lleva la opción y se comprueba lo que el modelo RECIBIÓ.
 * `measure`: la capa NO la lleva; lo recibido tiene que ser el original byte a
 * byte, y la decisión se calcula aparte con `compactToolOutput`.
 */
const NOMBRES_DE_MUESTRA = ["inventory", "prices", "syncLog"] as const;

export function verificacionDeCompactacion(modo: "measure" | "on"): string {
  const on = modo === "on";
  return [
    `// BiVelio Savings Layer: tool-output compaction check (${modo}), generated by \`bvsala init\`.`,
    "// ONE call to a fake model that lives in this file: no network, nothing billed. The",
    "// layer runs in COMMUNITY mode (open core): no license, no licenseServerUrl, no usage",
    "// sent anywhere. It prints the receipt (applied, or bypassed and why) and the",
    "// coverage of a built-in SAMPLE, which is not your traffic: no saving is promised.",
    "// Delete this file once it says ok.",
    `import { ${on ? "LicenseError, createSavingsLayer" : "LicenseError, compactToolOutput, createSavingsLayer"} } from "@bivelio/savings-layer";`,
    "",
    ...MUESTRA_DE_VERIFICACION.map(
      (t, i) => `const ${NOMBRES_DE_MUESTRA[i]} = { id: ${JSON.stringify(t.id)}, name: ${JSON.stringify(t.name)}, output: ${JSON.stringify(t.output)} };`,
    ),
    `const outputs = [${NOMBRES_DE_MUESTRA.join(", ")}];`,
    "",
    "// What the fake model received: the checks compare it with the outputs above.",
    "let calls = 0;",
    'let receivedIds = "";',
    "const received = new Map();",
    "const layer = createSavingsLayer({",
    "  provider: {",
    '    id: "bivelio-verify",',
    "    async generate(request) {",
    "      calls += 1;",
    '      const tools = request.messages.filter((m) => m.role === "tool");',
    "      receivedIds = tools.map((m) => m.toolCallId).join();",
    "      for (const m of tools) received.set(m.toolCallId, m.content);",
    '      return { text: "Two SKUs are low on stock.", usage: { inputTokens: 1000, outputTokens: 8 } };',
    "    },",
    "  },",
    "  licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,",
    ...(on ? ['  toolOutputCompaction: { profile: "lossless-data" },'] : []),
    "});",
    "",
    'const pad = (s = "", n = 0) => s.padEnd(n);',
    "// Bounded: one call, and 10 s at most.",
    "const timer = setTimeout(() => {",
    '  console.log("not ok: the local call took more than 10 s");',
    "  process.exit(1);",
    "}, 10_000);",
    "timer.unref();",
    "let ok = false;",
    "try {",
    "  const { report } = await layer.generate({",
    '    model: "anthropic/claude-haiku-4-5",',
    "    messages: [",
    '      { role: "system", content: "You are an inventory assistant." },',
    '      { role: "user", content: "Check stock for the spring catalog and tell me what is low." },',
    '      { role: "assistant", content: "", toolCalls: outputs.map((t) => ({ id: t.id, name: t.name, arguments: "{}" })) },',
    ...NOMBRES_DE_MUESTRA.map((n) => `      { role: "tool", toolCallId: ${n}.id, name: ${n}.name, content: ${n}.output },`),
    "    ],",
    "    savings: { exactCache: false },",
    "  });",
    "  clearTimeout(timer);",
    ...(on
      ? [
          "  const receipt = report.toolOutputCompaction;",
          "  if (!receipt) {",
          '    throw new Error("the layer did not run tool-output compaction: is it included in your license (long_context_compression)?");',
          "  }",
          "  const decisions = receipt.decisions;",
          "  console.log(`receipt: report.toolOutputCompaction, profile ${receipt.profile}, tokens ${receipt.tokenBasis} (${receipt.estimator.id})`);",
        ]
      : [
          '  const decisions = outputs.map((t) => ({ toolCallId: t.id, ...compactToolOutput(t.output, { profile: "lossless-data" }).decision }));',
          '  console.log("receipt: what lossless-data WOULD do (measure only), tokens estimated");',
        ]),
    "  for (const d of decisions) {",
    "    console.log(`  ${pad(d.toolCallId, 16)} ${pad(d.status, 9)} ${pad(d.reason, 16)} ${d.tokensBefore} -> ${d.tokensAfter} tokens`);",
    "  }",
    "  // Each check against what the model RECEIVED, not against the receipt.",
    '  const failed = [""].slice(1);',
    "  if (calls !== 1) failed.push(`expected one call to the model, saw ${calls}`);",
    '  if (receivedIds !== outputs.map((t) => t.id).join()) failed.push("tool ids changed");',
    ...(on ? [] : ['  if (report.toolOutputCompaction) failed.push("the layer compacted tool outputs: measure must change nothing");']),
    "  for (const t of outputs) {",
    "    const got = received.get(t.id);",
    "    const d = decisions.find((x) => x.toolCallId === t.id);",
    ...(on
      ? [
          '    if (d?.status !== "applied") {',
          "      if (got !== t.output) failed.push(`${t.id} was not sent byte for byte`);",
          '    } else if (!(typeof got === "string" && got.length < t.output.length && JSON.stringify(JSON.parse(got)) === JSON.stringify(JSON.parse(t.output)))) {',
          "      failed.push(`${t.id} was compacted into something that does not read as the same JSON`);",
          "    }",
        ]
      : ["    if (got !== t.output) failed.push(`${t.id} was not sent byte for byte`);", "    if (!d) failed.push(`${t.id} has no decision`);"]),
    "  }",
    '  const applied = decisions.filter((d) => d.status === "applied").length;',
    "  console.log(`coverage: ${applied} of ${outputs.length} tool outputs (${Math.round((applied / outputs.length) * 100)}%) on this built-in SAMPLE.`);",
    '  console.log("That is not your traffic, so no saving is promised: measure your own tool outputs (bvsala init --compaction measure).");',
    "  ok = failed.length === 0;",
    '  console.log(ok ? "ok: the receipt matches what the model received." : `not ok: ${failed.join("; ")}`);',
    "} catch (err) {",
    "  clearTimeout(timer);",
    "  // Never echo a license error as it is: say which variable to look at, by name.",
    "  console.log(",
    "    err instanceof LicenseError",
    '      ? "not ok: BIVELIO_LICENSE_KEY is set but does not verify. Fix it or unset it (without a key the layer runs in COMMUNITY mode). Copy a valid key from https://savings.bivelio.com/dashboard/install."',
    "      : `not ok: ${err instanceof Error ? err.message : String(err)}`,",
    "  );",
    "} finally {",
    "  layer.close();",
    "}",
    "if (!ok) process.exitCode = 1;",
    "",
  ].join("\n");
}

/**
 * EL CABLEADO: un módulo nuevo que crea la capa UNA vez y exporta lo que el
 * proyecto usa. Una vez por proceso, no por petición: la caché exacta de la capa
 * vive en esa instancia, y crearla por petición la dejaría siempre vacía.
 *
 * `extra` va dentro de las opciones de la capa (p. ej. {@link LINEAS_DE_COMPACTACION}).
 */
export function cableado(capa: Capa, proveedor: Proveedor, extra: readonly string[] = []): string {
  const r = receta(capa, proveedor);
  return [
    "// BiVelio Savings Layer: created once, when this module loads, and reused by every",
    "// request. The exact cache lives in this instance, so do not create one per request.",
    ...r.imports,
    "",
    ...r.construir(extra, true),
    "",
  ].join("\n");
}

/** La cabecera común de las dos comprobaciones. */
const CABECERA_COMPROBACION = [
  "// BiVelio Savings Layer: a free wiring check, generated by `bvsala init`.",
  "// It asks a question the layer answers on this machine (2 + 2 * 3), so with the",
  "// layer in place the model is not called and your provider bills nothing for it.",
  "// The saving is `estimated`, and estimated savings are never billed. Open core:",
  "// no keys are needed — the layer runs in COMMUNITY mode with zero telemetry.",
  "// Delete this file once it says ok.",
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
export function usoExpress(capa: Capa, proveedor: Proveedor, extra: readonly string[] = []): string {
  const r = receta(capa, proveedor);
  const campos = r.daBasis ? "{ text, basis }" : "{ text }";
  return [
    'import express from "express";',
    ...unirImports([...r.imports, ...r.importsDeUso]),
    "",
    "// Created once, at startup, not inside the handler: the exact cache lives in this instance.",
    ...r.construir(extra, false),
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
