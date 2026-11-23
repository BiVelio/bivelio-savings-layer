import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { URL_DEL_CODIGO } from "@/app/components/sitio";
import { VERSION_MEDIR_AHORRA } from "@/lib/license/medir-publico";
import { compararVersiones } from "@/lib/version/semver";

import { MEASURE_EN_EL_INDICE, RESUMEN, VERSION_EN_NPM, leerReadme, llmsFull, llmsTxt } from "./llms";

/**
 * /llms.txt y /llms-full.txt dicen lo mismo que el README, y llms-full.txt SE
 * GENERA de él. Aquí se vigila el generador (que no se coma ni invente nada),
 * el formato de llmstxt.org y la regla de negocio: ahorrar no pide clave.
 */
const RAIZ = fileURLToPath(new URL("../../../../", import.meta.url));
const readme = readFileSync(`${RAIZ}README.md`, "utf8");
const indice = llmsTxt();
const completo = llmsFull(readme);

/** Las versiones x.y.z de un texto (no las IP: ni detrás de un punto ni delante de «.dígito»). */
const versiones = (t: string) => [...t.matchAll(/(?<![\d.])\d+\.\d+\.\d+(?!\.?\d)/g)].map((m) => m[0]);
const mayor = (a: string, b: string) => compararVersiones(a, b) > 0;

describe("llms.txt (formato de llmstxt.org)", () => {
  it("H1 con el nombre, un resumen en cita y secciones de enlaces", () => {
    expect(indice.startsWith("# BiVelio Savings Layer\n\n> ")).toBe(true);
    expect(indice).toContain(`> ${RESUMEN}\n`);
    for (const s of ["## Get started", "## Docs", "## Optional"]) expect(indice).toContain(`\n${s}\n`);
  });

  it("enlaza instalar, cómo funciona, banco, precios, paper, GitHub, npm, PyPI y llms-full.txt", () => {
    for (const url of [
      `${URL_DEL_CODIGO}#install-anywhere-in-60-seconds`,
      "https://savings.bivelio.com/en/how-it-works",
      "https://savings.bivelio.com/en/benchmarks",
      "https://savings.bivelio.com/en/pricing",
      "https://savings.bivelio.com/en/paper",
      URL_DEL_CODIGO,
      "https://www.npmjs.com/package/@bivelio/savings-layer",
      "https://pypi.org/project/bivelio-savings-layer/",
      "https://savings.bivelio.com/llms-full.txt",
    ]) {
      expect(indice, url).toContain(`](${url})`);
    }
  });

  it("los nombres de npm y PyPI son los de los paquetes de verdad", () => {
    const npm = JSON.parse(readFileSync(`${RAIZ}package.json`, "utf8")) as { name: string };
    const pypi = /^name = "([^"]+)"/m.exec(readFileSync(`${RAIZ}packages/python/pyproject.toml`, "utf8"))?.[1];
    expect(indice).toContain(`https://www.npmjs.com/package/${npm.name})`);
    expect(indice).toContain(`https://pypi.org/project/${pypi}/)`);
  });

  it("cada entrada de lista es `- [nombre](url absoluta)` con su nota opcional", () => {
    const entradas = indice.split("\n").filter((l) => l.startsWith("- "));
    expect(entradas.length).toBeGreaterThanOrEqual(10);
    for (const l of entradas) expect(l).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)\s]+\)(: .+)?$/);
  });

  it("las cifras del índice son las del README: el «about 0 %» sin repeticiones Y su excepción de Anthropic (+20 %), con el arreglo", () => {
    expect(readme).toMatch(/traffic that never repeats saves about 0 % by default/);
    expect(indice).toContain("Traffic that never repeats saves about 0 % by default");
    // La excepción que cuesta más, con su remedio: el README la dice, el índice también.
    expect(readme).toMatch(/costs about 20 % more than no layer/);
    expect(readme).toContain("`maxCacheBreakpoints: 0`");
    expect(indice).toContain("costs about 20 % more than no layer");
    expect(indice).toContain("`maxCacheBreakpoints: 0` to `AnthropicProvider`");
  });

  it("⛔ el ahorro es del SDK de TypeScript; el gateway MIDE; el paquete de Python solo mide", () => {
    for (const t of [RESUMEN, indice]) {
      // Nada de «SDK y gateway que recortan»: el gateway no tiene caché exacta.
      expect(t).not.toMatch(/SDK\s+and\s+(?:a\s+|the\s+)?(?:local\s+)?gateway\s+that\s+cut/i);
    }
    expect(RESUMEN).toMatch(/Its TypeScript SDK cuts LLM API spend/);
    expect(RESUMEN).toMatch(/prompt-cache placement on Anthropic/);
    expect(RESUMEN).toMatch(/a local\s+gateway that meters coding agents/);
    // 1.2.3: un modelo local no tiene precio de lista; el gateway lo reenvía y
    // no lo mide en dólares (`bvsala doctor` lo dice). No entra en «meters».
    expect(RESUMEN).toMatch(/MiniMax or OpenRouter, for models with a list price in its catalog;/);
    expect(RESUMEN).toMatch(/forwards to a local server \(Ollama, vLLM, LM Studio\), whose models have no list price and are not metered in dollars/);
    expect(RESUMEN).not.toMatch(/OpenRouter or a local server/);
    // Cada cifra con su etiqueta: solo measured y reference salen del contador del proveedor.
    expect(RESUMEN).not.toMatch(/each request's report is valued with the provider's own usage counter/);
    expect(RESUMEN).toMatch(/labels every figure `measured`, `reference` or `estimated`; only measured and reference figures come from the provider's own usage counter/);
    expect(readme).toMatch(/Only `measured` and `reference` figures are credited/);
    expect(RESUMEN).toMatch(/Python package \(`bivelio-savings-layer` on PyPI\) is a measurement client/);
    expect(indice).toMatch(/The local gateway measures by default\. It has no exact cache/);
    expect(indice).toContain("`BVSALA_GATEWAY_COALESCE=1`");
    expect(indice).toMatch(/saves only when your client pays per token and asks for the one-hour cache/);
    expect(indice).toMatch(/PyPI[^\n]*measurement client[^\n]*saves nothing by itself/);
    // La entrada del README («lets through only what has to be paid for», también
    // delante del agente de código) no se copia: el gateway, por defecto, mide.
    expect(completo).not.toContain("lets through only what has to be paid for");
    expect(completo).toContain("# or meter Claude Code through the local gateway");
    // Lo que el índice nombra existe: la variable del gateway y el remedio del SDK.
    const gateway = readFileSync(`${RAIZ}gateway/bin.ts`, "utf8");
    expect(gateway).toContain("BVSALA_GATEWAY_COALESCE");
    expect(readFileSync(`${RAIZ}src/providers/anthropic.ts`, "utf8")).toContain("maxCacheBreakpoints");
  });

  it("Measure (1.2.5 en npm): las mismas palancas que sin clave, desde la versión que lee /pricing; ningún aviso de modo sombra", () => {
    // Hasta la 1.2.3 una clave Measure ponía el SDK y el gateway en modo sombra,
    // y el índice y llms-full.txt llevaban un aviso («To save, leave the key
    // out»). Desde la 1.2.5 (la 1.2.4 no llegó a npm) Measure aplica las mismas
    // palancas que sin clave: el aviso se fue, y el índice dice desde qué versión.
    expect(MEASURE_EN_EL_INDICE).toBe(
      `With @bivelio/savings-layer ${VERSION_MEDIR_AHORRA} or later a Measure key applies exactly the same levers as no key and adds the dashboard; older versions only observe with it.`,
    );
    expect(indice).toContain(`with no commission on your savings. ${MEASURE_EN_EL_INDICE}\n`);
    for (const t of [indice, completo]) {
      expect(t).not.toMatch(/currently runs the SDK and the gateway in shadow mode|leave the key out/i);
    }
    // llms-full.txt lo dice con las palabras del README: la viñeta de la nube, los
    // párrafos bajo la tabla y la sección de licencias.
    expect(readme).toContain("the free Measure license applies exactly the same levers as no key");
    const nube = completo.slice(completo.indexOf("## Overview"), completo.indexOf("## How it saves"));
    expect(nube).toContain("- **The cloud is the optional part.**");
    const tabla = completo.slice(completo.indexOf("## Community vs Cloud"), completo.indexOf("## Pricing"));
    expect(tabla).toContain("Both columns have the same levers.");
    expect(tabla).toContain("the free Measure license applies exactly the same levers as no key");
    expect(tabla).toMatch(/with `licenseServerUrl` set[^\n]*72 hours/);
    expect(tabla).not.toContain("**Pricing.**");
    const licencias = completo.slice(completo.indexOf("## Licensing & privacy"), completo.indexOf("## Requirements"));
    expect(licencias).toContain("up to 5 seats and 20,000\nrequests a day: the layer applies exactly the same levers as with no key");
    expect(licencias).toContain("**observe-only mode**");
  });
});

describe("llms-full.txt sale del README", () => {
  it("lleva instalación, los dos modos, proveedores y qué es gratis y qué añade la nube", () => {
    for (const trozo of [
      "npm i @bivelio/savings-layer",
      "npx @bivelio/savings-layer claude",
      "npx @bivelio/savings-layer gateway --upstream openai --port 8403",
      "DeepSeek, Qwen, GLM, Moonshot",
      "Ollama, vLLM, LM Studio",
      "| Community (default, no keys) | Cloud (optional `BIVELIO_*` keys) |",
      "| Team dashboard, shared measurement, seats and license management | — | ✅ |",
      "**Pricing.** The cloud subscription is a fixed fee",
      "**Free, with no key.**",
    ]) {
      expect(completo, trozo).toContain(trozo);
    }
  });

  it("cada línea copiada está en el README tal cual (salvo los enlaces relativos, hechos absolutos)", () => {
    const desde = completo.indexOf("## Overview");
    const hasta = completo.indexOf("\n## Links\n");
    const copiado = completo.slice(desde, hasta).split("\n");
    for (const l of copiado) {
      // Nada escrito aquí: todo lo que va entre los encabezados sale del README.
      if (l === "" || l.startsWith("## ")) continue;
      const original = l.replaceAll(`](${URL_DEL_CODIGO}#`, "](#");
      expect(readme.includes(l) || readme.includes(original), l).toBe(true);
    }
  });

  it("sin HTML del README ni enlaces relativos", () => {
    expect(completo).not.toMatch(/<\/?(details|summary|p|img|h1)\b/);
    expect(completo).not.toMatch(/\]\((?!https?:|mailto:)/);
  });

  it("⛔ no ata el ahorro a una clave o licencia (solo se cobra la nube)", () => {
    for (const t of [indice, completo]) {
      expect(t).not.toMatch(/with a PRO license|PRO-license|levers need a paid plan|requires? a (?:key|licen[cs]e) to save/i);
      expect(t).toMatch(/no key/);
    }
  });

  it("⛔ ninguna versión por delante de npm: lo que llms-full.txt nombra es VERSION_EN_NPM o anterior", () => {
    // El README de main puede ir por delante de npm (hoy lleva ya la 1.2.5
    // mientras npm sirve la 1.2.3): un párrafo que nombra una versión que npm no
    // tiene describe algo que quien instala no recibe. VERSION_EN_NPM se sube a
    // mano cuando la versión nueva es `latest`; hasta entonces, este test falla.
    const encima = (t: string) => versiones(t).filter((v) => mayor(v, VERSION_EN_NPM));
    expect(versiones(completo).length).toBeGreaterThan(0); // el README nombra versiones (la 1.2.3, al menos)
    expect(encima(completo)).toEqual([]);
    expect(encima(indice)).toEqual([]);
    // Y el guardián funciona: un README que nombra una versión futura no pasa.
    // Se ancla en «**Pricing.** », que no nombra versión: así no depende de cómo
    // cuente el README la 1.2.4 o la 1.2.5 (#627 reescribe esa frase).
    const futuro = readme.replace("**Pricing.** ", "**Pricing.** From 9.9.9: ");
    expect(futuro).not.toBe(readme);
    expect(encima(llmsFull(futuro))).toEqual(["9.9.9"]);
    // Una IP no es una versión.
    expect(versiones("http://127.0.0.1:8403 and 1.2.3.")).toEqual(["1.2.3"]);
  });

  it("VERSION_EN_NPM: no por delante del paquete del repositorio, y Measure ya ahorra en ella", () => {
    const npm = JSON.parse(readFileSync(`${RAIZ}package.json`, "utf8")) as { version: string };
    expect(mayor(VERSION_EN_NPM, npm.version), `${VERSION_EN_NPM} > ${npm.version}`).toBe(false);
    expect(mayor(VERSION_MEDIR_AHORRA, VERSION_EN_NPM)).toBe(false);
  });

  it("si el README pierde una sección publicada, falla con su nombre (y el build también)", () => {
    expect(() => llmsFull(readme.replace("### How it saves", "### Cómo ahorra"))).toThrow(/How it saves/);
    expect(() => llmsFull(readme.replace("- **Free, with no key.**", "- **Gratis.**"))).toThrow(/Overview/);
    expect(() => llmsFull(readme.replace("<summary><b>Requirements</b></summary>", ""))).toThrow(/Requirements/);
  });
});

describe("leerReadme encuentra el README del repositorio, no el de apps/web", () => {
  it("desde apps/web (donde corre `next build`) y desde la raíz (donde corre vitest)", () => {
    expect(leerReadme(`${RAIZ}apps/web`)).toBe(readme);
    expect(leerReadme(RAIZ)).toBe(readme);
  });

  it("sin el README, falla en vez de publicar un fichero vacío", () => {
    expect(() => leerReadme(`${RAIZ}apps/web/lib/llms`)).toThrow(/README/);
  });
});
