import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { URL_DEL_CODIGO } from "@/app/components/sitio";
import { absolute } from "@/i18n/site";

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
 * de `main` puede ir por delante de la versión publicada en npm (p. ej. el
 * comportamiento de la licencia Measure de la 1.2.4), y esos párrafos se
 * reconocen porque nombran la versión. Las secciones elegidas describen lo que
 * hace el motor abierto sin clave, que no depende de esa diferencia.
 */

const NPM = "https://www.npmjs.com/package/@bivelio/savings-layer";
const PYPI = "https://pypi.org/project/bivelio-savings-layer/";

/** El resumen de una frase, el mismo en los dos ficheros. Cada afirmación está en el README. */
export const RESUMEN =
  "BiVelio Savings Layer (BV-SALA, npm package `@bivelio/savings-layer`) is an open-source, Apache-2.0 SDK " +
  "and local gateway that cut LLM API spend — exact cache, deduplication and prompt-cache placement, with " +
  "more levers you switch on — on OpenAI, Anthropic, Gemini, DeepSeek, Qwen, GLM, Moonshot, any " +
  "OpenAI-compatible endpoint and local servers. Every saving is reported request by request, valued with " +
  "your provider's own usage counter. Free with no key, no signup and no telemetry; the optional Savings " +
  "Cloud adds a team dashboard, shared measurement, seats and license management.";

export function llmsTxt(): string {
  return `# BiVelio Savings Layer

> ${RESUMEN}

How much it saves depends on your traffic: identical requests are not paid twice, and a long, stable system prompt on Anthropic is billed at the cached rate; traffic that never repeats saves about 0 % by default. The SDK runs inside your TypeScript/JavaScript app (\`npm i @bivelio/savings-layer\`); the local gateway sits in front of any SDK that lets you set a base URL, whatever the language, and in front of coding agents (\`npx @bivelio/savings-layer claude\`, also codex, gemini, qwen, aider). Your LLM traffic goes straight to your provider (the gateway is a local proxy on your own machine); with no key, nothing is sent to BiVelio.

## Get started

- [Install anywhere, in 60 seconds](${URL_DEL_CODIGO}#install-anywhere-in-60-seconds): the SDK, the local gateway for any OpenAI SDK, and one command per coding agent
- [npm: @bivelio/savings-layer](${NPM}): the SDK, the \`bvsala\` CLI and the local gateway (Apache-2.0, zero runtime dependencies)
- [PyPI: bivelio-savings-layer](${PYPI}): the Python client for the local gateway
- [GitHub repository](${URL_DEL_CODIGO}): source code, README, CHANGELOG and the benchmark artifacts

## Docs

- [How it works](${absolute("/en/how-it-works")}): where the layer runs (inside your app or as a local gateway), what it saves, its limits and how it is measured
- [Benchmarks](${absolute("/en/benchmarks")}): the public A/B bench, metered with the provider's own usage counter, every run with its raw JSON report
- [Pricing](${absolute("/en/pricing")}): the open-source engine is free; the optional Savings Cloud has a free plan (Measure) and flat-fee plans with no commission on your savings
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
    // El párrafo de entrada, el primer bloque de instalación y la nota de
    // --legacy-peer-deps; de las tres viñetas, las dos que no dependen de la
    // versión publicada (la de la nube describe la licencia Measure de la 1.2.4).
    lineas: (l) => {
      const i = l.findIndex((x) => x.startsWith("`@bivelio/savings-layer`"));
      if (i < 0) return [];
      const cuerpo = hastaElCorte(l, i);
      const vinetas = ["**Free, with no key.**", "**The evidence is public.**"];
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
    // Solo la tabla: los párrafos de debajo detallan la licencia Measure por versión.
    lineas: (l) => {
      const seccion = porEncabezado(l, "Community vs Cloud");
      const i = seccion.findIndex((x) => x.startsWith("|"));
      if (i < 0) return [];
      const fin = seccion.findIndex((x, j) => j > i && !x.startsWith("|"));
      return seccion.slice(i, fin < 0 ? undefined : fin);
    },
  },
  { titulo: "Pricing", lineas: (l) => porParrafo(l, "**Pricing.**") },
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
