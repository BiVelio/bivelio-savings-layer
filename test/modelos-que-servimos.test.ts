import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { PRECIOS_AL_DIA, precioDeListaPropio } from "../src/pricing/catalogo.js";
import { salidaNoRepetible } from "../src/pricing/razonamiento.js";

/**
 * LOS MODELOS QUE SERVIMOS TIENEN FILA VIGENTE. Si no, esto se pone rojo.
 *
 * Un modelo sin fila no rompe nada en tiempo de ejecución: cae al precio
 * ilustrativo y avisa. Justo por eso hay que pararlo aquí. El informe de
 * competencia del 2026-09-26 (§5.2) encontró los modelos insignia del momento
 * —`claude-opus-5-5` y la familia `gpt-6-*`— sin fila: se medían con el
 * respaldo, no con el precio oficial, y nada se había puesto rojo.
 *
 * La lista es DECLARADA, con el sitio que nombra cada modelo, y el segundo test
 * barre esos sitios (README, doctor y la ayuda del gateway, ejemplos y banco)
 * para que ninguno nombre un modelo que la lista no conozca. Un modelo nuevo en
 * un ejemplo obliga a declararlo aquí, y declararlo obliga a darle fila.
 *
 * «Vigente» se comprueba dos veces: el día del catálogo (determinista) y HOY.
 * La segunda es una alarma a propósito: si el precio de un modelo servido tiene
 * fecha de fin y nadie ha puesto el tramo siguiente, el día que acaba este test
 * falla en todas las ramas. Es lo que se quiere: tarifar al respaldo en silencio
 * sería peor.
 */
const MODELOS_QUE_SERVIMOS: Readonly<Record<string, string>> = {
  // Lo que nombran el README, los ejemplos y el banco.
  "gpt-4o-mini": "README, examples/*, gateway/init-fragmentos.ts (bvsala init), benchmarks (scenarios, ab-live, fidelidad-elision)",
  "gpt-4o": "benchmarks (README, scenarios, ab-live)",
  "gpt-4.1": "benchmarks/ab-live.ts",
  "gpt-4.1-mini": "benchmarks/ab-live.ts",
  "claude-sonnet-4-5": "benchmarks (README, scenarios, ab-live, arneses, verja-de-calidad)",
  "gemini-3.7-flash": "benchmarks (scenarios, ab-live, transporte)",
  "gemini-3.5-flash": "benchmarks/sdk/sonda.ts",
  "gpt-5-mini": "benchmarks/latencia-gateways (la prueba de fidelidad con Flex: modelo con fila Flex oficial)",
  // Lo que nombra la ayuda del gateway (`bvsala gateway --help`): el hermano y el esfuerzo por turno.
  "claude-fable-5": "gateway/bin.ts (palanca C, el modelo que se pide)",
  "claude-fable-5-1": "gateway/bin.ts (palanca C y esfuerzo por turno)",
  "claude-mythos-5-1": "gateway/bin.ts (esfuerzo por turno)",
  "claude-opus-5": "gateway/bin.ts (esfuerzo por turno)",
  // Los modelos vigentes que el banco 2026 tiene que poder tarifar (informe de
  // competencia, §8 n.º 3: gpt-6-luna, Sonnet 5 o Haiku 4.5, Gemini 3.x Flash)
  // y los insignia que un cliente manda hoy por el SDK o el gateway.
  "claude-opus-5-5": "insignia de Anthropic a 2026-09-27",
  "claude-sonnet-5": "banco 2026",
  "claude-sonnet-5-5": "Sonnet vigente de Anthropic desde el 2026-09-28; benchmarks/nativo.ts (tablas de effort y de búsqueda)",
  "claude-haiku-4-5": "banco 2026; gateway/init-fragmentos.ts (bvsala init, pilas de Anthropic)",
  "gpt-6-astra": "insignia de OpenAI a 2026-09-27",
  "gpt-6-sol": "familia gpt-6",
  "gpt-6-luna": "banco 2026",
  "gpt-5.6-sol": "familia gpt-5.6",
  "gpt-5.6-terra": "familia gpt-5.6",
  "gpt-5.6-luna": "familia gpt-5.6",
  "gemini-3.8-flash": "banco 2026 (Gemini 3.x Flash)",
  "gpt-5.4-mini": "benchmarks/publicados/bfcl (batería pública BFCL, 2026-09-28)",
  "gpt-5.5": "benchmarks/publicados/* (baterías públicas de gama alta, 2026-09-29)",
  "gemini-3.1-pro-preview": "benchmarks/publicados/* (baterías públicas de gama alta, 2026-09-29; el único Pro 3.x con fila)",
};

/** Lo que el barrido encuentra y NO es un id de modelo, con el porqué. */
const NO_SON_MODELOS: Readonly<Record<string, string>> = {
  "gpt-4o-mini-class": "etiqueta de clase de precio en benchmarks/run.ts, no un id que se mande a nadie",
};

/**
 * Ids que el barrido encuentra, que SÍ son modelos o familias, pero que nadie
 * sirve ni tarifica desde aquí: prefijos de familia que el código usa para
 * decidir (startsWith) y las tablas de compatibilidad del banco, copiadas de la
 * documentación oficial de Anthropic (qué modelos admiten `effort` o la búsqueda
 * de herramientas). Si alguno pasa a servirse, sale de aquí y entra arriba, con fila.
 */
const MENCIONADOS_NO_SERVIDOS: Readonly<Record<string, string>> = {
  "gpt-5": "prefijo de familia (startsWith) en el banco y el README",
  "gpt-6": "prefijo de familia (startsWith) en el banco",
  "gpt-5.6": "prefijo de familia (startsWith) en el simulador de benchmarks/sondas/seco.ts",
  "gpt-4": "nombre de fichero del dataset MT-Bench de FastChat (reference_answer/gpt-4.jsonl), no un modelo que se llame",
  "gemini-2": "prefijo de familia en benchmarks/nativo.ts",
  "claude-mythos-5": "tabla de compatibilidad de Anthropic en benchmarks/nativo.ts",
  "claude-opus-4-8": "tabla de compatibilidad de Anthropic en benchmarks/nativo.ts",
  "claude-opus-4-7": "tabla de compatibilidad de Anthropic en benchmarks/nativo.ts",
  "claude-opus-4-6": "tabla de compatibilidad de Anthropic en benchmarks/nativo.ts",
  "claude-opus-4-5": "tabla de compatibilidad de Anthropic en benchmarks/nativo.ts",
  "claude-sonnet-4-6": "tabla de compatibilidad de Anthropic en benchmarks/nativo.ts",
};

const RAIZ = fileURLToPath(new URL("../", import.meta.url));

/** Los sitios que «nombran» modelos: README, doctor, init, ayuda del gateway, ejemplos y banco. */
function sitios(): string[] {
  const out = ["README.md", "gateway/doctor.ts", "gateway/bin.ts", "gateway/init-fragmentos.ts"];
  const recorrer = (dir: string): void => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) recorrer(rel);
      // Código y prosa; los .json son evidencia de tiradas pasadas, no algo que se sirva.
      else if (/\.(ts|mts|mjs|md|sh)$/.test(e.name)) out.push(rel);
    }
  };
  recorrer("examples");
  recorrer("benchmarks");
  return out;
}

/** Ids de modelo en un texto, sin la fecha de instantánea (`-20250929`, `-2024-07-18`). */
function idsDeModelo(texto: string): string[] {
  const rx =
    /\b(?:gpt-\d+(?:\.\d+)?[a-z]?(?:-[a-z0-9]+)*|claude-(?:[a-z]+-)?\d+(?:-\d+)*(?:-[a-z]+)?|gemini-\d+(?:\.\d+)?(?:-[a-z0-9]+)*|deepseek-[a-z0-9]+(?:-[a-z0-9]+)*)/g;
  return [...texto.matchAll(rx)].map((m) => m[0].replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, ""));
}

describe("los modelos que servimos tienen fila vigente", () => {
  const diaDelCatalogo = Date.parse(`${PRECIOS_AL_DIA}T12:00:00Z`);

  it("el día del catálogo, cada modelo servido tiene SU fila (no la de un pariente)", () => {
    const sinFila = Object.keys(MODELOS_QUE_SERVIMOS).filter((m) => precioDeListaPropio(m, diaDelCatalogo) === undefined);
    expect(sinFila, "modelos servidos sin fila propia en el catálogo").toEqual([]);
  });

  it("⏰ HOY, cada modelo servido sigue teniendo un precio en vigor", () => {
    const sinPrecioHoy = Object.keys(MODELOS_QUE_SERVIMOS).filter((m) => precioDeListaPropio(m, Date.now()) === undefined);
    expect(
      sinPrecioHoy,
      "el precio de estos modelos ha dejado de estar en vigor: verifica la página oficial y añade su tramo nuevo en src/pricing/catalogo.ts",
    ).toEqual([]);
  });

  it("y cada uno tiene decidido si su salida se puede repetir (su fila está clasificada)", () => {
    for (const m of Object.keys(MODELOS_QUE_SERVIMOS)) expect(salidaNoRepetible(m), m).not.toBe("unclassified-model");
  });

  it("⛔ ningún sitio nombra un modelo que la lista no declare", () => {
    const sinDeclarar: string[] = [];
    for (const f of sitios()) {
      for (const id of new Set(idsDeModelo(readFileSync(join(RAIZ, f), "utf8")))) {
        if (!(id in MODELOS_QUE_SERVIMOS) && !(id in NO_SON_MODELOS) && !(id in MENCIONADOS_NO_SERVIDOS)) sinDeclarar.push(`${f}: ${id}`);
      }
    }
    expect(sinDeclarar, "declara estos modelos en MODELOS_QUE_SERVIMOS (y dales fila en el catálogo)").toEqual([]);
  });

  it("el barrido de verdad ve algo: el README y los ejemplos nombran gpt-4o-mini y el gateway a Fable 5.1", () => {
    const vistos = new Set(sitios().flatMap((f) => idsDeModelo(readFileSync(join(RAIZ, f), "utf8"))));
    for (const m of ["gpt-4o-mini", "claude-sonnet-4-5", "claude-fable-5-1", "gemini-3.7-flash"]) expect(vistos.has(m), m).toBe(true);
    // Y el regex corta bien las instantáneas y no se come otras familias.
    expect(idsDeModelo("usa claude-sonnet-4-5-20250929, gpt-4o-2024-08-06 o gemini-3.8-flash.")).toEqual([
      "claude-sonnet-4-5",
      "gpt-4o",
      "gemini-3.8-flash",
    ]);
  });
});
