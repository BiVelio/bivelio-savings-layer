import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AbArtifact } from "@/app/[locale]/dashboard/data";
import { PALANCAS_QUE_NPM_NO_TRAE as PALANCAS_DEL_BANCO } from "../../../../benchmarks/titular-como-se-instala";

import {
  PALANCAS_QUE_NPM_NO_TRAE,
  escenariosConPiezaDelBanco,
  librosConPiezaDelBanco,
  midioElSdkInstalado,
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
 *   1. la regla (`midioElSdkInstalado` y compañía) sobre el artefacto
 *      publicado y sobre uno que sí midió lo instalado. Desde el 2026-09-29 ni
 *      la portada ni el panel presentan un «≥ 10 %» en lugar de su suelo: sin
 *      `asShipped` la banda del panel no pinta cifra (NetSavingsCIBand);
 *   2. (hasta el 2026-09-29) el recibo del héroe renderizado. La portada ya no
 *      enseña este artefacto — ni recibo, ni «al menos un 10 %», ni libros —:
 *      lo vigila apps/web/lib/portada/portada-dice-lo-medido.test.ts;
 *   3. el código: todo fichero de la web que lee una cifra del artefacto pasa
 *      por `lib/bench/sdk-instalado.ts`, o está en la lista con su motivo.
 */

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

  it("ninguna web publica ya el titular de esta tirada: ni `hero.proofs` ni la leyenda de la banda", () => {
    for (const f of readdirSync(MENSAJES).filter((f) => f.endsWith(".json"))) {
      const d = JSON.parse(readFileSync(join(MENSAJES, f), "utf8")) as {
        landing: { hero: Record<string, unknown> };
        dashboard: { netSavingsCIBand: Record<string, unknown> };
      };
      expect(d.landing.hero.proofs, f).toBeUndefined();
      expect(d.dashboard.netSavingsCIBand.captionSdkPendiente, f).toBeUndefined();
    }
  });

  it("sin sello, la tirada no midió lo instalado — nunca se supone", () => {
    expect(midioElSdkInstalado({})).toBe(false);
    expect(midioElSdkInstalado({ sdk: {} })).toBe(false);
    expect(midioElSdkInstalado({ sdk: { asShipped: false } })).toBe(false);
    expect(midioElSdkInstalado({ sdk: { asShipped: true } })).toBe(true);
  });

  if (!midioElSdkInstalado(artefacto)) {
    it("⛔ el artefacto publicado no midió lo instalado: la banda del panel no pinta ninguna cifra suya", () => {
      const src = readFileSync(join(WEB, "app/[locale]/dashboard/components/NetSavingsCIBand.tsx"), "utf8");
      // Lo primero que hace el componente es salir sin pintar nada.
      const cuerpo = src.slice(src.indexOf("export async function NetSavingsCIBand"));
      expect(cuerpo.split("\n")[1]).toContain("if (!midioElSdkInstalado(ab)) return null;");
      expect(src).not.toMatch(/sueloPublicable|PROMESA_DEL_TITULAR|captionSdkPendiente/);
    });

    it("⛔ y el escenario y el libro que salen del compresor del banco quedan marcados", () => {
      const escenarios = escenariosConPiezaDelBanco(artefacto);
      expect([...escenarios]).toContain("Forwarded support thread (compression)");
      expect([...librosConPiezaDelBanco(artefacto)]).toContain("compressed_tokens");
    });
  }

  it("con `asShipped: true` la regla se apaga: mandan las cifras medidas", () => {
    expect(midioElSdkInstalado(instalado)).toBe(true);
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
    // Desde el 2026-09-29 la portada, «cómo funciona» y las baldosas del panel ya
    // no leen el artefacto: quedan la banda, las tarjetas por libro y la tabla
    // de escenarios de /dashboard/proof.
    expect(lectores.length).toBeGreaterThanOrEqual(3);
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

  it("⛔ la factura de ejemplo y su tarjeta social no leen el artefacto: «depende», sin cifra", () => {
    for (const rel of ["app/components/HowItWorks.tsx", "app/[locale]/how-it-works/opengraph-image.tsx"]) {
      const src = readFileSync(join(WEB, rel), "utf8");
      expect(src, rel).not.toMatch(ES_DEL_ARTEFACTO);
      expect(src, rel).not.toMatch(/sueloPublicable\(/);
      expect(src, rel).toMatch(/t\("billWith"\)/);
    }
  });
});
