import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { URL_DEL_CODIGO } from "@/app/components/sitio";

import { AVISO_MEASURE, RESUMEN, leerReadme, llmsFull, llmsTxt } from "./llms";

/**
 * /llms.txt y /llms-full.txt dicen lo mismo que el README, y llms-full.txt SE
 * GENERA de él. Aquí se vigila el generador (que no se coma ni invente nada),
 * el formato de llmstxt.org y la regla de negocio: ahorrar no pide clave.
 */
const RAIZ = fileURLToPath(new URL("../../../../", import.meta.url));
const readme = readFileSync(`${RAIZ}README.md`, "utf8");
const indice = llmsTxt();
const completo = llmsFull(readme);

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
    expect(RESUMEN).toMatch(/a local gateway that meters coding agents/);
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

  it("⚠ Measure en sombra (npm latest = 1.2.3): el aviso va en el índice y tras la tabla Community vs Cloud", () => {
    // QUITAR JUNTO CON `AVISO_MEASURE` cuando la 1.2.5 llegue a npm: desde la
    // 1.2.4 una clave Measure aplica las mismas palancas que sin clave.
    expect(AVISO_MEASURE).toMatch(/Measure key currently runs the SDK and the gateway in shadow mode/);
    expect(AVISO_MEASURE).toMatch(/no lever is applied\. To save, leave the key out\.$/);
    expect(indice).toContain(AVISO_MEASURE);
    const tabla = completo.slice(completo.indexOf("## Community vs Cloud"), completo.indexOf("## Pricing"));
    expect(tabla.trim().endsWith(AVISO_MEASURE)).toBe(true);
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
      // La única línea escrita aquí y no en el README: el aviso de Measure.
      if (l === "" || l.startsWith("## ") || l === AVISO_MEASURE) continue;
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

  it("⛔ ningún párrafo atado a una versión 1.x: esos son los que pueden ir por delante de npm", () => {
    // El README de main describe ya cosas de la 1.2.4/1.2.5 (la licencia Measure,
    // el modo observe-only) y npm puede seguir en una versión anterior. Esos
    // párrafos nombran la versión; la lista blanca (PIEZAS) los deja fuera. Lo
    // que dice hoy llms-full.txt de Measure es AVISO_MEASURE (la 1.2.3), y se
    // cambia a mano cuando la 1.2.5 llegue a npm (ver su test de arriba).
    expect(completo).not.toMatch(/\b1\.\d+\.\d+\b/);
    expect(completo).not.toMatch(/observeOnly|observe-only|BVSALA_GATEWAY_OBSERVE_ONLY/);
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
