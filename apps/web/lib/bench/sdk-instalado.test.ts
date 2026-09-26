import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AbArtifact } from "@/app/[locale]/dashboard/data";
import { ReciboMedido } from "@/app/components/ReciboMedido";
import { PALANCAS_QUE_NPM_NO_TRAE as PALANCAS_DEL_BANCO } from "../../../../benchmarks/titular-como-se-instala";

import {
  PALANCAS_QUE_NPM_NO_TRAE,
  PROMESA_DEL_TITULAR,
  escenariosConPiezaDelBanco,
  librosConPiezaDelBanco,
  midioElSdkInstalado,
  numeroDeCifra,
  sueloPublicable,
} from "./sdk-instalado";

/**
 * NINGUNA SUPERFICIE PRESENTA COMO «LO QUE OBTIENES» EL SUELO DE UNA TIRADA QUE
 * NO MIDIÓ EL SDK TAL COMO SE INSTALA.
 *
 * El 2026-09-25 el titular se bajó a lo que sostiene el paquete de npm, y la
 * portada siguió abriendo con el recibo del artefacto del 12-09 (≥ 23,2 %,
 * medido con el compresor del banco), la factura de ejemplo «$100 → $77» junto
 * a «esa caja verde es un paquete de npm», la frase llana del paso 2 y la
 * banda del intervalo. Ninguna verja miraba esas superficies: solo
 * `hero.proofs`. Aquí se miran tres cosas:
 *   1. la regla (`sueloPublicable` y compañía) sobre el artefacto publicado y
 *      sobre uno que sí midió lo instalado;
 *   2. el recibo del héroe RENDERIZADO: la cifra grande no es la de la tirada;
 *   3. el código: todo fichero de la web que lee una cifra del artefacto pasa
 *      por `lib/bench/sdk-instalado.ts`, o está en la lista con su motivo.
 */

// Este fichero es .ts (el glob de vitest es `*.test.ts`), así que el recibo se
// monta con `React.createElement` en vez de JSX; y el componente, compilado por
// vitest, puede esperar un `React` global que Next sí inyecta.
(globalThis as { React?: typeof React }).React = React;

const AQUI = fileURLToPath(new URL(".", import.meta.url));
const WEB = join(AQUI, "..", "..");
const artefacto = JSON.parse(readFileSync(join(WEB, "public/data/ab-live.json"), "utf8")) as AbArtifact;
const MENSAJES = join(WEB, "messages");

/** El mismo artefacto, como si la tirada hubiera medido el SDK tal como se instala. */
const instalado: AbArtifact = { ...artefacto, sdk: { version: "0.4.23", asShipped: true } };

describe("la regla: sin `sdk.asShipped: true`, la web no presenta el suelo de la tirada como lo que el cliente obtiene", () => {
  it("la lista de palancas que npm no trae es la misma que usa el banco", () => {
    expect([...PALANCAS_QUE_NPM_NO_TRAE]).toEqual([...PALANCAS_DEL_BANCO]);
  });

  it("la promesa del titular es la cifra de los 12 idiomas, leída de UN solo sitio", () => {
    const ficheros = readdirSync(MENSAJES).filter((f) => f.endsWith(".json"));
    expect(ficheros).toHaveLength(12);
    for (const f of ficheros) {
      const d = JSON.parse(readFileSync(join(MENSAJES, f), "utf8")) as {
        landing: { hero: { proofs: { cifra: string }[] } };
      };
      expect(numeroDeCifra(d.landing.hero.proofs[0]!.cifra) / 100, f).toBeCloseTo(PROMESA_DEL_TITULAR, 12);
    }
    expect(numeroDeCifra("≥ %10,0")).toBe(10);
    expect(numeroDeCifra("≥ 10.0%")).toBe(10);
    expect(numeroDeCifra("≥ 10 %")).toBe(10);
  });

  it("sin sello, la tirada no midió lo instalado — nunca se supone", () => {
    expect(midioElSdkInstalado({})).toBe(false);
    expect(midioElSdkInstalado({ sdk: {} })).toBe(false);
    expect(midioElSdkInstalado({ sdk: { asShipped: false } })).toBe(false);
    expect(midioElSdkInstalado({ sdk: { asShipped: true } })).toBe(true);
  });

  if (!midioElSdkInstalado(artefacto)) {
    it("⛔ el artefacto publicado no midió lo instalado: lo publicable es el titular, nunca su suelo", () => {
      expect(sueloPublicable(artefacto)).toBeLessThanOrEqual(PROMESA_DEL_TITULAR);
      expect(sueloPublicable(artefacto)).toBeLessThanOrEqual(artefacto.aggregate.savings.lower);
      expect(sueloPublicable(artefacto)).toBeLessThan(artefacto.aggregate.savings.lower);
    });

    it("⛔ y el escenario y el libro que salen del compresor del banco quedan marcados", () => {
      const escenarios = escenariosConPiezaDelBanco(artefacto);
      expect([...escenarios]).toContain("Forwarded support thread (compression)");
      expect([...librosConPiezaDelBanco(artefacto)]).toContain("compressed_tokens");
    });
  }

  it("con `asShipped: true` la regla se apaga: mandan las cifras medidas", () => {
    expect(sueloPublicable(instalado)).toBe(instalado.aggregate.savings.lower);
    expect(escenariosConPiezaDelBanco(instalado).size).toBe(0);
    expect(librosConPiezaDelBanco(instalado).size).toBe(0);
  });

  it("una palanca del banco declarada pero NO ejercitada no marca nada", () => {
    const sinEjercitar: AbArtifact = {
      ...artefacto,
      levers: { exercised: [] },
      scenarios: artefacto.scenarios.map((s) =>
        s.palanca?.palanca === "compression" ? { ...s, palanca: { ...s.palanca, ejercitada: false } } : s,
      ),
    };
    expect(escenariosConPiezaDelBanco(sinEjercitar).size).toBe(0);
  });
});

describe("el recibo del héroe, renderizado", () => {
  const en = JSON.parse(readFileSync(join(MENSAJES, "en.json"), "utf8")) as {
    landing: { recibo: Record<string, string>; cascade: { steps: { ledger: string; title: string }[] } };
  };
  const labels = en.landing.recibo as unknown as Parameters<typeof ReciboMedido>[0]["labels"];
  const filas = en.landing.cascade.steps.map((s) => ({ ledger: s.ledger, title: s.title }));
  const pct = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 });
  const grande = (html: string): string => /class="recibo-big">(.*?)<\/div>/.exec(html)?.[1] ?? "";

  it("todas las etiquetas existen (si no, el test no protege nada)", () => {
    expect(labels.sdkPendiente).toBeTruthy();
    expect(labels.suelo).toBeTruthy();
  });

  if (!midioElSdkInstalado(artefacto)) {
    it("⛔ con el artefacto publicado, la cifra grande es el titular y no el suelo de la tirada", () => {
      const html = renderToStaticMarkup(React.createElement(ReciboMedido, { ab: artefacto, locale: "en", labels, filas }));
      expect(grande(html)).toContain(pct.format(PROMESA_DEL_TITULAR));
      expect(html).not.toContain(pct.format(artefacto.aggregate.savings.lower));
      // Ni el punto de esa tirada, ni «el titular es el suelo del intervalo»:
      // el número grande ya no es el suelo de ningún intervalo.
      expect(html).not.toContain(pct.format(artefacto.aggregate.savings.point));
      expect(html).not.toContain(labels.suelo);
      expect(html).toContain(labels.sdkPendiente.replace(/'/g, "&#x27;"));
      // Y el libro que mezcla el compresor del banco no sale.
      expect(html).not.toContain("<code>compressed_tokens</code>");
    });
  }

  it("con una tirada que midió lo instalado, el recibo enseña su suelo, su punto y todos sus libros probados", () => {
    const html = renderToStaticMarkup(React.createElement(ReciboMedido, { ab: instalado, locale: "en", labels, filas }));
    expect(grande(html)).toContain(pct.format(instalado.aggregate.savings.lower));
    expect(html).toContain(pct.format(instalado.aggregate.savings.point));
    expect(html).toContain(labels.suelo);
    const probado = instalado.ledgers.find((l) => l.ledger === "compressed_tokens")?.proven;
    if (probado) expect(html).toContain("<code>compressed_tokens</code>");
  });
});

describe("el código: toda cifra del artefacto pasa por lib/bench/sdk-instalado.ts", () => {
  /**
   * Ficheros que leen una cifra del artefacto SIN importar la regla, con su
   * motivo. Añadir uno exige escribir por qué aquí.
   */
  const EXCEPCIONES: Record<string, string> = {
    // Componente de cliente: la regla importa el catálogo inglés y no se manda
    // al navegador. Es la tabla de evidencia del panel; la página (servidor) le
    // pasa `piezaDelBanco` para marcar las filas, y abajo se exige que lo haga.
    "app/[locale]/dashboard/components/ScenarioTable.tsx": "evidencia por escenario, marcada con piezaDelBanco",
  };

  function fuentes(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === ".next") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) fuentes(p, acc);
      else if (/\.tsx?$/.test(e) && !e.includes(".test.")) acc.push(p);
    }
    return acc;
  }

  const LEE_CIFRA = /savings\??\.(lower|point|upper)\b|aggregate\??\.savings\b/;
  const ES_DEL_ARTEFACTO = /ab-live\.json|\bAb(Artifact|Scenario|Ledger)\b/;
  const USA_LA_REGLA = /from\s+["']@\/lib\/bench\/sdk-instalado["']/;
  const archivos = [...fuentes(join(WEB, "app")), ...fuentes(join(WEB, "lib"))];
  const lectores = archivos
    .map((f) => ({ f, rel: relative(WEB, f), src: readFileSync(f, "utf8") }))
    .filter(({ src }) => LEE_CIFRA.test(src) && ES_DEL_ARTEFACTO.test(src));

  it("hay lectores que revisar (si no, esta verja no protege nada)", () => {
    expect(lectores.length).toBeGreaterThanOrEqual(4);
  });

  it.each(lectores.map((l) => [l.rel, l] as const))("⛔ %s pasa por la regla", (rel, { src }) => {
    if (rel === "lib/bench/sdk-instalado.ts") return;
    if (EXCEPCIONES[rel]) return;
    expect(USA_LA_REGLA.test(src), `${rel} lee una cifra del artefacto sin pasar por lib/bench/sdk-instalado.ts`).toBe(true);
  });

  it("⛔ quien pinta la tabla de escenarios le pasa qué filas salen de una pieza del banco", () => {
    const usos = archivos
      .map((f) => readFileSync(f, "utf8"))
      .flatMap((src) => [...src.matchAll(/<ScenarioTable\b[^>]*>/g)].map((m) => m[0]));
    expect(usos.length).toBeGreaterThan(0);
    for (const u of usos) expect(u).toMatch(/piezaDelBanco=/);
  });

  it("⛔ la factura de ejemplo y su tarjeta social no leen el suelo del artefacto a pelo", () => {
    for (const rel of ["app/components/HowItWorks.tsx", "app/[locale]/how-it-works/opengraph-image.tsx"]) {
      const src = readFileSync(join(WEB, rel), "utf8");
      expect(src, rel).toMatch(/sueloPublicable\(/);
      expect(src, rel).not.toMatch(/aggregate\??\.savings/);
    }
  });
});
