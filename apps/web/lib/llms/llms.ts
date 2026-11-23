import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { URL_DEL_CODIGO } from "@/app/components/sitio";
import { absolute } from "@/i18n/site";
import { VERSION_MEDIR_AHORRA } from "@/lib/license/medir-publico";

/**
 * /llms.txt y /llms-full.txt (formato de llmstxt.org): lo que lee un asistente
 * cuando alguien le pregunta cómo bajar la factura de su API de LLM.
 *
 * - `llms.txt` es el ÍNDICE: un H1, un resumen en cita y secciones cortas de
 *   enlaces (instalar, cómo funciona, banco, precios, paper, GitHub, npm, PyPI).
 * - `llms-full.txt` es la SUSTANCIA DEL README del repositorio, copiada al pie
 *   de la letra AL CONSTRUIR (las dos rutas son `force-static`): instalación,
 *   los dos modos (SDK y gateway local), proveedores, y qué es gratis y qué
 *   añade la nube. No hay una segunda copia que pueda desviarse: si el README
 *   cambia, el siguiente build publica el cambio; si deja de tener una de las
 *   secciones de abajo, `llmsFull()` lanza y el build (y llms.test.ts) fallan.
 *
 * QUÉ SECCIONES Y POR QUÉ ESAS. Una lista blanca, no el README entero: el README
 * de `main` puede ir por delante de la versión publicada en npm, y esos párrafos
 * se reconocen porque nombran la versión. Con la 1.2.5 en npm, lo que el README
 * dice de la licencia Measure (las mismas palancas que sin clave) es lo que hace
 * la versión publicada, y entra: la viñeta de la nube, los párrafos de Community
 * vs Cloud y «Licensing & privacy». Lo único escrito aquí y no en el README es
 * el resumen. `VERSION_EN_NPM` vigila que ninguna pieza nombre una versión que
 * npm todavía no tiene (llms.test.ts).
 */

const NPM = "https://www.npmjs.com/package/@bivelio/savings-layer";
const PYPI = "https://pypi.org/project/bivelio-savings-layer/";

/**
 * LA VERSIÓN DE `@bivelio/savings-layer` QUE ES `latest` EN NPM (y en PyPI), la
 * que describe lo publicado aquí. llms-full.txt copia el README de `main`, y
 * `main` puede llevar ya la versión siguiente: si una pieza nombra una versión
 * mayor que esta, llms.test.ts falla, porque ese párrafo describe algo que quien
 * instala hoy no tiene. Se sube A MANO cuando la versión nueva llega a npm, no
 * antes (este cambio se fusiona cuando la 1.2.5 es `latest`).
 */
export const VERSION_EN_NPM = "1.2.5";

/**
 * El resumen, el mismo en los dos ficheros. Cada parte con lo que de verdad hace
 * en la versión publicada en npm (`VERSION_EN_NPM`): el SDK de TypeScript es el que ahorra;
 * el gateway local MIDE (no tiene caché exacta, la coalescencia va apagada salvo
 * `BVSALA_GATEWAY_COALESCE=1` y su única palanca por defecto, el TTL de
 * Anthropic, solo ahorra si el cliente pide la caché de una hora); el paquete de
 * Python solo mide, a través de ese gateway. Proveedores, los de cada parte:
 * el gateway solo mide modelos con precio de lista en su catálogo, así que un
 * servidor local (Ollama, vLLM, LM Studio) se reenvía pero no se mide en
 * dólares (lo dice `bvsala doctor`). Y el informe no siempre sale del contador
 * del proveedor: cada cifra lleva su etiqueta, y solo `measured` y `reference`
 * salen de él.
 */
export const RESUMEN =
  "BiVelio Savings Layer (BV-SALA, npm package `@bivelio/savings-layer`) is open source (Apache-2.0) and free " +
  "with no key, no signup and no telemetry. Its TypeScript SDK cuts LLM API spend inside your app where your " +
  "traffic repeats: an exact cache and deduplication of identical requests on OpenAI, Anthropic, Gemini and " +
  "any OpenAI-compatible endpoint (DeepSeek, Qwen, GLM, Moonshot, a local server), plus prompt-cache placement " +
  "on Anthropic. Its per-request report labels every figure `measured`, `reference` or `estimated`; only " +
  "measured and reference figures come from the provider's own usage counter. The same package ships a local " +
  "gateway that meters coding agents (Claude Code, Codex, Gemini CLI, Qwen Code, Aider) and any SDK that lets " +
  "you set a base URL, in any language, in front of Anthropic, OpenAI, Gemini, DeepSeek, Qwen, GLM, Moonshot, " +
  "MiniMax or OpenRouter, for models with a list price in its catalog; it also forwards to a local server " +
  "(Ollama, vLLM, LM Studio), whose models have no list price and are not metered in dollars. The Python " +
  "package (`bivelio-savings-layer` on PyPI) is a measurement client for that gateway. The optional Savings " +
  "Cloud adds a team dashboard, shared measurement, seats and license management.";

/**
 * El plan gratuito, en la línea de precios del índice. Desde la 1.2.5 (la
 * primera publicada en npm con la licencia Measure de la 1.2.4) una clave
 * Measure aplica exactamente las mismas palancas que sin clave; las versiones
 * anteriores, desde la 0.4.33, solo observan con ella. La versión llega de
 * `VERSION_MEDIR_AHORRA`, la misma que leen /pricing, el alta y el panel.
 */
export const MEASURE_EN_EL_INDICE =
  `With @bivelio/savings-layer ${VERSION_MEDIR_AHORRA} or later a Measure key applies exactly the same levers ` +
  `as no key and adds the dashboard; older versions only observe with it.`;

export function llmsTxt(): string {
  return `# BiVelio Savings Layer

> ${RESUMEN}

How much the SDK saves depends on your traffic. Identical requests are not paid twice, and neither are simultaneous ones unless the first is streamed; on Anthropic, a long, stable system prompt is billed at the cached rate. Traffic that never repeats saves about 0 % by default, with one exception that costs more: on Anthropic, a long system prompt that changes on every request (a timestamp, a user id), or is reused only after its 5-minute cache expired, costs about 20 % more than no layer. Put what changes in the user message, or pass \`maxCacheBreakpoints: 0\` to \`AnthropicProvider\`.

The local gateway measures by default. It has no exact cache, coalescing of identical requests is off unless you set \`BVSALA_GATEWAY_COALESCE=1\`, and its one default lever (the Anthropic cache-write TTL) saves only when your client pays per token and asks for the one-hour cache. Install: \`npm i @bivelio/savings-layer\` (the SDK, in your TypeScript/JavaScript app) or \`npx @bivelio/savings-layer claude\` (the gateway for Claude Code; also codex, gemini, qwen, aider). Your LLM traffic goes straight to your provider (the gateway is a local proxy on your own machine); with no key, nothing is sent to BiVelio.

## Get started

- [Install anywhere, in 60 seconds](${URL_DEL_CODIGO}#install-anywhere-in-60-seconds): the SDK, the local gateway for any OpenAI SDK, and one command per coding agent
- [npm: @bivelio/savings-layer](${NPM}): the SDK, the \`bvsala\` CLI and the local gateway (Apache-2.0, zero runtime dependencies)
- [PyPI: bivelio-savings-layer](${PYPI}): a Python measurement client: it routes the official OpenAI and Anthropic SDKs through the local gateway and returns each request's report; it saves nothing by itself
- [GitHub repository](${URL_DEL_CODIGO}): source code, README, CHANGELOG and the benchmark artifacts

## Docs

- [How it works](${absolute("/en/how-it-works")}): where the layer runs (inside your app or as a local gateway), what it saves, its limits and how it is measured
- [Benchmarks](${absolute("/en/benchmarks")}): the public A/B bench, metered with the provider's own usage counter, every run with its raw JSON report
- [Pricing](${absolute("/en/pricing")}): the open-source engine is free; the optional Savings Cloud has a free plan (Measure) and flat-fee plans with no commission on your savings. ${MEASURE_EN_EL_INDICE}
- [Paper](${absolute("/en/paper")}): Verifiable Measurement of Cost Savings in LLM Applications — the method, the results and every limitation
- [README as plain text](${absolute("/llms-full.txt")}): install, both modes, providers, and what is free and what the Cloud adds

## Optional

- [What leaves your infrastructure](${absolute("/en/privacy")}): the exact fields a Savings Cloud key sends, and what is never sent
- [CHANGELOG](${URL_DEL_CODIGO}/blob/main/CHANGELOG.md): what changed in each release
`;
}

/* ───────────────────────────── el README ───────────────────────────── */

/**
 * El README del repositorio (el de npm y GitHub), NO el de apps/web. El build
 * corre en `apps/web` (Vercel construye con el repositorio entero, igual que
 * /benchmarks y la guía de migración, que leen `docs/`), y vitest en la raíz:
 * se prueba en los dos sitios y se reconoce por su contenido.
 */
export function leerReadme(desde: string = process.cwd()): string {
  const candidatos = [join(desde, "..", "..", "README.md"), join(desde, "README.md")];
  for (const c of candidatos) {
    if (!existsSync(c)) continue;
    const texto = readFileSync(c, "utf8");
    if (texto.includes("@bivelio/savings-layer") && texto.includes("### Community vs Cloud")) return texto;
  }
  throw new Error(
    `llms-full.txt: no encuentro el README del repositorio (buscado en ${candidatos.join(", ")}). ` +
      "La ruta se construye a partir de ese fichero; el build necesita el repositorio entero.",
  );
}

const ES_VALLA = /^(`{3,}|~{3,})/;
const ES_ENCABEZADO = /^#{1,6} /;
const ES_DETALLES = /^<\/?details>\s*$/;

/**
 * Desde la línea `i` hasta el siguiente encabezado, `<details>`/`</details>` o
 * `---`, sin cortar dentro de un bloque de código (sus `# comentarios` de shell
 * no son encabezados).
 */
function hastaElCorte(lineas: string[], i: number): string[] {
  const fuera: string[] = [];
  let enCodigo = false;
  for (const l of lineas.slice(i)) {
    if (!enCodigo && (ES_ENCABEZADO.test(l) || ES_DETALLES.test(l.trim()) || l.trim() === "---")) break;
    if (ES_VALLA.test(l)) enCodigo = !enCodigo;
    fuera.push(l);
  }
  return fuera;
}

/** Las líneas de la sección cuyo encabezado es exactamente `titulo`. */
function porEncabezado(lineas: string[], titulo: string): string[] {
  let enCodigo = false;
  for (const [i, l] of lineas.entries()) {
    if (ES_VALLA.test(l)) enCodigo = !enCodigo;
    else if (!enCodigo && ES_ENCABEZADO.test(l) && l.replace(/^#+ /, "").trim() === titulo) return hastaElCorte(lineas, i + 1);
  }
  return [];
}

/** Las líneas del bloque plegado `<details>` cuyo `<summary>` es `titulo`. */
function porResumen(lineas: string[], titulo: string): string[] {
  const i = lineas.findIndex((l) => l.trim() === `<summary><b>${titulo}</b></summary>`);
  if (i < 0) return [];
  const fin = lineas.findIndex((l, j) => j > i && l.trim() === "</details>");
  return lineas.slice(i + 1, fin < 0 ? undefined : fin);
}

/** El párrafo que empieza por `inicio` (hasta la primera línea en blanco). */
function porParrafo(lineas: string[], inicio: string): string[] {
  const i = lineas.findIndex((l) => l.startsWith(inicio));
  if (i < 0) return [];
  const fin = lineas.findIndex((l, j) => j > i && l.trim() === "");
  return lineas.slice(i, fin < 0 ? undefined : fin);
}

/** Separa una lista de viñetas en bloques (la viñeta y sus líneas sangradas). */
function sinVinetasSalvo(lineas: string[], permitidas: readonly string[]): string[] {
  const fuera: string[] = [];
  let quedarse = true;
  for (const l of lineas) {
    if (l.startsWith("- ")) quedarse = permitidas.some((p) => l.startsWith(`- ${p}`));
    else if (!l.startsWith("  ")) quedarse = true;
    if (quedarse) fuera.push(l);
  }
  return fuera;
}

/** Enlaces relativos del README (`#ancla`, `./FICHERO`) → URL absolutas de GitHub. */
function enlacesAbsolutos(texto: string): string {
  return texto.replace(/\]\((?!https?:|mailto:)([^)\s]+)\)/g, (_, destino: string) =>
    destino.startsWith("#") ? `](${URL_DEL_CODIGO}${destino})` : `](${URL_DEL_CODIGO}/blob/main/${destino.replace(/^\.\//, "")})`,
  );
}

function limpiar(lineas: string[]): string {
  return enlacesAbsolutos(lineas.join("\n"))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Pieza = { titulo: string; lineas: (l: string[]) => string[] };

/**
 * LA LISTA BLANCA. Cada pieza tiene que existir en el README y no estar vacía:
 * si un día se renombra o se borra una, `llmsFull` lanza con su nombre.
 */
const PIEZAS: readonly Pieza[] = [
  {
    titulo: "Overview",
    // El primer bloque de instalación, la nota de --legacy-peer-deps y las tres
    // viñetas (gratis sin clave, la nube opcional y la evidencia). La de la nube
    // describe la licencia Measure de la 1.2.4, que llegó a npm con la 1.2.5. El
    // párrafo de entrada del README NO va: dice que la capa «deja pasar solo lo
    // que hay que pagar» también delante del agente de código, y el gateway, por
    // defecto, mide. Lo que hace cada parte lo dice el resumen de arriba.
    lineas: (l) => {
      const entrada = l.findIndex((x) => x.startsWith("`@bivelio/savings-layer`"));
      if (entrada < 0) return [];
      const i = l.findIndex((x, j) => j > entrada && x.trim() === "");
      if (i < 0) return [];
      const cuerpo = hastaElCorte(l, i);
      const vinetas = ["**Free, with no key.**", "**The cloud is the optional part.**", "**The evidence is public.**"];
      const filtrado = sinVinetasSalvo(cuerpo, vinetas);
      return vinetas.every((v) => filtrado.some((x) => x.startsWith(`- ${v}`))) ? filtrado : [];
    },
  },
  { titulo: "How it saves", lineas: (l) => porEncabezado(l, "How it saves") },
  { titulo: "Install anywhere, in 60 seconds", lineas: (l) => porEncabezado(l, "Install anywhere, in 60 seconds") },
  {
    titulo: "Python and any other language: the local gateway",
    lineas: (l) => porEncabezado(l, "Python and any other language: the local gateway"),
  },
  { titulo: "Inside your framework", lineas: (l) => porEncabezado(l, "Inside your framework") },
  {
    titulo: "Community vs Cloud",
    // La tabla y los párrafos de debajo, hasta el de precios (que es su propia
    // pieza): la licencia Measure aplica las mismas palancas que sin clave, las
    // dos excepciones de las licencias de pago, lo que ata una clave (72 h con
    // `licenseServerUrl`) y la caché compartida en un almacén propio. Con la
    // 1.2.5 en npm es lo que hace la versión publicada.
    lineas: (l) => {
      const seccion = porEncabezado(l, "Community vs Cloud");
      const i = seccion.findIndex((x) => x.startsWith("|"));
      if (i < 0) return [];
      const precios = seccion.findIndex((x, j) => j > i && x.startsWith("**Pricing.**"));
      return seccion.slice(i, precios < 0 ? undefined : precios);
    },
  },
  { titulo: "Pricing", lineas: (l) => porParrafo(l, "**Pricing.**") },
  // Los planes y la licencia Measure (topes, las mismas palancas que sin clave),
  // el modo solo-observar, el plan antiguo con comisión, la licencia firmada que
  // se verifica sin red y lo que cubre la Apache-2.0.
  { titulo: "Licensing & privacy", lineas: (l) => porEncabezado(l, "Licensing & privacy") },
  { titulo: "Requirements", lineas: (l) => porResumen(l, "Requirements") },
];

/** `llms-full.txt`, generado desde el texto del README. Lanza si falta alguna pieza. */
export function llmsFull(readme: string): string {
  const lineas = readme.replace(/\r\n/g, "\n").split("\n");
  const secciones = PIEZAS.map((p) => {
    const cuerpo = limpiar(p.lineas(lineas));
    if (!cuerpo) throw new Error(`llms-full.txt: el README ya no tiene la sección «${p.titulo}» (lib/llms/llms.ts, PIEZAS).`);
    return `## ${p.titulo}\n\n${cuerpo}`;
  });
  return `# BiVelio Savings Layer

> ${RESUMEN}

This file carries the substance of the repository README (${URL_DEL_CODIGO}), copied when this site was built: install, the SDK and the local gateway, providers, and what is free and what the Cloud adds. The README is the reference; the index of this site is at ${absolute("/llms.txt")}.

${secciones.join("\n\n")}

## Links

- [npm: @bivelio/savings-layer](${NPM})
- [PyPI: bivelio-savings-layer](${PYPI})
- [GitHub repository](${URL_DEL_CODIGO})
- [How it works](${absolute("/en/how-it-works")})
- [Benchmarks](${absolute("/en/benchmarks")})
- [Pricing](${absolute("/en/pricing")})
- [Paper](${absolute("/en/paper")})
`;
}
