import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { BancoPublico, CONTACTO, REPRODUCIR, UMBRAL_P, type Traductor } from "@/app/components/BancoPublico";
import { locales } from "@/i18n/config";

import { carpetaDelBanco, leerInformes } from "./cargar";
import { compararVersion, resumirBanco, type Banco, type InformeFuente, type RegistroGsm8k } from "./extraer";

/**
 * EL BANCO PÚBLICO (/benchmarks): LOS NÚMEROS SALEN DE LOS INFORMES.
 *
 * La página no puede llevar una cifra escrita a mano. Aquí se comprueba:
 *   1. la extracción, cifra a cifra, contra los JSON de docs/benchmarks
 *      (leídos por separado, sin pasar por el extractor);
 *   2. que cambiar un número en un informe cambia la página, y que un informe
 *      NUEVO en la carpeta (la gama alta cuando se fusione) entra solo;
 *   3. el render en los 12 idiomas, sin claves que falten;
 *   4. las reglas de la copia: ningún competidor, ningún «hasta X %», ninguna
 *      cifra en los mensajes, y los comandos y arneses que cita existen.
 */

(globalThis as { React?: typeof React }).React = React;

const AQUI = fileURLToPath(new URL(".", import.meta.url));
const WEB = join(AQUI, "..", "..");
const RAIZ = join(WEB, "..", "..");
const CARPETA = carpetaDelBanco(RAIZ);
const INFORMES = leerInformes(CARPETA);
const BANCO = resumirBanco(INFORMES);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const crudo = (ruta: string): J => JSON.parse(readFileSync(join(RAIZ, ruta), "utf8"));

function mensajes(loc: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(WEB, "messages", `${loc}.json`), "utf8"));
}

function traductor(loc: string): Traductor {
  const t = createTranslator({
    locale: loc,
    messages: mensajes(loc) as never,
    namespace: "benchmarksPage" as never,
    onError: (e) => {
      throw e;
    },
  });
  return t as unknown as Traductor;
}

function pagina(banco: Banco, loc = "es"): string {
  return renderToStaticMarkup(React.createElement(BancoPublico, { banco, t: traductor(loc), locale: loc }));
}

const pct = (loc: string, x: number) => new Intl.NumberFormat(loc, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(x);
/** renderToStaticMarkup escapa el texto; se compara con el mismo escape. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------------------

describe("banco público: la extracción, contra los informes publicados", () => {
  it("lee docs/benchmarks del repositorio y encuentra informes de las cuatro baterías", () => {
    expect(INFORMES.length).toBeGreaterThan(0);
    expect(new Set(BANCO.fuentes.map((f) => f.bateria))).toEqual(new Set(["gsm8k", "bfcl", "xstest", "mt-bench"]));
  });

  it("no hay lista de ficheros: todo informe en vivo de la carpeta entra (y solo los bloqueados se quedan fuera)", () => {
    const enCarpeta = readdirSync(CARPETA).flatMap((d) =>
      readdirSync(join(CARPETA, d))
        .filter((f) => f.endsWith(".json"))
        .map((f) => `docs/benchmarks/${d}/${f}`),
    );
    const fuera = enCarpeta.filter((r) => !BANCO.fuentes.some((f) => f.ruta === r));
    for (const r of fuera) {
      const j = crudo(r);
      expect(j.estado ?? j.modo, r).toMatch(/bloqueado|MOCK|SIM/i);
    }
  });

  it("cada (batería, modelo) enseña la tirada de la versión más alta que existe", () => {
    for (const r of BANCO.registros) {
      const otras = BANCO.fuentes.filter((f) => f.bateria === r.bateria);
      const max = otras.map((f) => f.version).sort(compararVersion).pop()!;
      if (r.estado === "medido") expect(compararVersion(r.version, max), `${r.bateria} ${r.modelo}`).toBeLessThanOrEqual(0);
      expect(existsSync(join(RAIZ, r.ruta)), r.ruta).toBe(true);
    }
  });

  it("GSM8K: el ahorro, su intervalo, el coste y la exactitud son los del informe; el origen suma el ahorro total", () => {
    const filas = BANCO.registros.filter((r): r is RegistroGsm8k => r.bateria === "gsm8k" && r.estado === "medido");
    expect(filas.length).toBeGreaterThan(0);
    for (const r of filas) {
      const m = crudo(r.ruta).modelos.find((x: J) => x.modelo === r.modelo);
      const b = m.resumen.comparaciones.find((c: J) => c.brazo === "B");
      expect(r.ahorro).toEqual({ punto: b.ahorroMedido.point, inf: b.ahorroMedido.lower, sup: b.ahorroMedido.upper });
      expect(r.n).toBe(m.peticionesCompletadas);
      expect(r.exactitudB).toEqual({ aciertos: m.resumen.brazos.B.exactitud.aciertos, n: m.resumen.brazos.B.exactitud.n });
      expect(r.origenCacheCapaUsd! + r.origenLlamadasUsd!).toBeCloseTo(b.costeA - b.costeBrazo, 9);
      // Si el informe trae su propio desglose, el origen coincide con él.
      const d = (m.desglose ?? []).find((x: J) => x.brazo === "B");
      if (d) expect(r.origenCacheCapaUsd!).toBeCloseTo(d.ahorroPorNoLlamarUsd, 6);
    }
  });

  it("BFCL, MT-Bench y XSTest: cada cifra es la del informe", () => {
    for (const r of BANCO.registros) {
      if (r.estado !== "medido") continue;
      const j = crudo(r.ruta);
      if (r.bateria === "bfcl") {
        const x = j.resumen.find((y: J) => y.modelo === r.modelo);
        expect(r.ahorro).toEqual({ punto: x.coste.ahorro.point, inf: x.coste.ahorro.lower, sup: x.coste.ahorro.upper });
        expect(r.n).toBe(x.n);
        expect(r.infieles).toBe(x.infieles.length);
      } else if (r.bateria === "mt-bench") {
        const x = j.modelos.find((y: J) => (y.idCualificado ?? y.modelo) === r.modelo);
        expect(r.ahorro).toEqual({ punto: x.coste.ahorroPooled.point, inf: x.coste.ahorroPooled.lower, sup: x.coste.ahorroPooled.upper });
        expect(r.clase).toBe(x.coste.clase);
        expect(r.atribuible).toBe(x.coste.atribucion.atribuible);
      } else if (r.bateria === "xstest") {
        const x = j.informe.resumen.find((y: J) => r.modelo.endsWith(`/${y.modelo}`));
        expect(r.n).toBe(x.medidos);
        if (r.seguros) {
          expect(r.seguros.A.negativas).toBe(x.porLabel.safe.A.negativas);
          expect(r.seguros.B.negativas).toBe(x.porLabel.safe.B.negativas);
          expect(r.seguros.p).toBe(x.porLabel.safe.mcnemarP);
        }
      }
    }
  });

  it("las garantías se recuentan igual directamente en los JSON", () => {
    let infieles = 0;
    let comparaciones = 0;
    let deOtra = 0;
    for (const f of INFORMES) {
      const j = f.json;
      const v = j.paquete?.version ?? j.procedencia?.version;
      if (!v || compararVersion(v, "0.4.31") < 0 || String(j.modo).toUpperCase() !== "LIVE") continue;
      if (j.bateria === "BFCL") {
        for (const r of j.resumen) if (r.n > 0) (infieles += r.infieles.length), (comparaciones += r.n);
      }
      if (j.bateria === "gsm8k") {
        for (const m of j.modelos) {
          if (m.estado !== "medido") continue;
          for (const x of Object.values<J>(m.resumen.variantesPorBrazo)) deOtra += x.deOtra;
        }
      }
    }
    expect(BANCO.garantias.herramientas).toMatchObject({ alteradas: infieles, comparaciones });
    expect(BANCO.garantias.otraPregunta.deOtra).toBe(deOtra);
  });
});

// ---------------------------------------------------------------------------

describe("banco público: la página pinta lo que dicen los informes", () => {
  const html = pagina(BANCO, "es");

  it("cada ahorro medido aparece con su intervalo, formateado desde el JSON crudo", () => {
    for (const r of BANCO.registros) {
      if (r.estado !== "medido" || r.bateria === "xstest") continue;
      const j = crudo(r.ruta);
      const a =
        r.bateria === "gsm8k"
          ? j.modelos.find((x: J) => x.modelo === r.modelo).resumen.comparaciones.find((c: J) => c.brazo === "B").ahorroMedido
          : r.bateria === "bfcl"
            ? j.resumen.find((x: J) => x.modelo === r.modelo).coste.ahorro
            : j.modelos.find((x: J) => (x.idCualificado ?? x.modelo) === r.modelo).coste.ahorroPooled;
      const texto = `${pct("es", a.point)} [${pct("es", a.lower)} – ${pct("es", a.upper)}]`;
      expect(html, `${r.bateria} ${r.modelo}`).toContain(esc(texto));
    }
  });

  it("cada tirada enlaza su informe, que existe en el repositorio", () => {
    const rutas = [...html.matchAll(/data-ruta="([^"]+)"/g)].map((m) => m[1]!);
    expect(rutas.length).toBeGreaterThan(0);
    for (const r of new Set(rutas)) expect(existsSync(join(RAIZ, r)), r).toBe(true);
  });

  it("cambiar una cifra en un informe cambia la página (no hay números escritos a mano)", () => {
    const ruta = BANCO.registros.find((r) => r.bateria === "gsm8k" && r.estado === "medido")!.ruta;
    const modelo = BANCO.registros.find((r) => r.bateria === "gsm8k" && r.estado === "medido" && r.ruta === ruta)!.modelo;
    const alterados: InformeFuente[] = INFORMES.map((f) => {
      if (f.ruta !== ruta) return f;
      const json = structuredClone(f.json);
      const b = json.modelos.find((m: J) => m.modelo === modelo).resumen.comparaciones.find((c: J) => c.brazo === "B");
      b.ahorroMedido = { point: 0.4242, lower: 0.4111, upper: 0.4333 };
      return { ...f, json };
    });
    const otra = pagina(resumirBanco(alterados), "es");
    expect(otra).toContain(esc(`${pct("es", 0.4242)} [${pct("es", 0.4111)} – ${pct("es", 0.4333)}]`));
    expect(html).not.toContain(esc(pct("es", 0.4242)));
  });

  it("un informe NUEVO en la carpeta entra solo: modelo, estado y fallo (la gama alta, cuando se fusione)", () => {
    const nuevo: InformeFuente = {
      ruta: "docs/benchmarks/2099-01-01/gsm8k-prueba.json",
      json: {
        bateria: "gsm8k",
        fecha: "2099-01-01",
        modo: "LIVE",
        procedencia: { version: "0.4.31" },
        modelos: [
          {
            modelo: "google/gemini-prueba",
            estado: "capa-falla",
            motivo: "every request of arms B, E, S failed through the layer",
            peticionesCompletadas: 4,
            ensayos: [
              { pos: 0, brazo: "A", coste: 0.01, fuente: "provider" },
              { pos: 0, brazo: "B", coste: 0, error: 'provider 400: Unknown name "prompt_cache_key"' },
              { pos: 1, brazo: "B", coste: 0, error: 'provider 400: Unknown name "prompt_cache_key"' },
            ],
          },
        ],
      },
    };
    const banco = resumirBanco([...INFORMES, nuevo]);
    expect(banco.modelos).toContain("google/gemini-prueba");
    const r = banco.registros.find((x) => x.modelo === "google/gemini-prueba")!;
    expect(r).toMatchObject({ estado: "capa-falla", motivo: "capa", version: "0.4.31" });
    const fallo = banco.fallos.find((f) => f.id === "gemini-prompt-cache-key")!;
    expect(fallo.antes).toMatchObject({ ocurrencias: 2, sobre: 2 });
    expect(fallo.despues).toBeNull();
    const otra = pagina(banco, "es");
    expect(otra).toContain("google/gemini-prueba");
    expect(otra).toContain(esc(traductor("es")("bugs.items.gemini-prompt-cache-key.title")));
    expect(otra).toContain(esc(traductor("es")("bugs.pending", { version: "0.4.32" })));
  });

  it("las garantías salen con sus cuentas; si una se rompe, el título dice el número y no la frase", () => {
    const t = traductor("es");
    expect(html).toContain(esc(t("guarantees.tools.title")));
    const roto = structuredClone(BANCO);
    roto.garantias.herramientas.alteradas = 3;
    const otra = pagina(roto, "es");
    expect(otra).not.toContain(esc(t("guarantees.tools.title")));
    expect(otra).toContain(esc(t("guarantees.tools.titleBroken", { n: "3" })));
    // La de negativas se decide con la p de cada modelo, no con una frase fija.
    for (const m of BANCO.garantias.negativas.modelos) {
      for (const par of [m.seguros, m.inseguros]) if (par) expect(par.p).toBeGreaterThanOrEqual(UMBRAL_P);
    }
  });

  it("lo que NO ahorra está dicho: MT-Bench sale con su lectura, y la frase de ≈ 0 va arriba", () => {
    const t = traductor("es");
    expect(html).toContain('id="no-savings"');
    expect(html).toContain("≈ " + new Intl.NumberFormat("es", { style: "percent", maximumFractionDigits: 0 }).format(0));
    const mt = BANCO.registros.filter((r) => r.bateria === "mt-bench" && r.estado === "medido");
    expect(mt.length).toBeGreaterThan(0);
    for (const r of mt) expect(html).toContain(`data-modelo="${r.modelo}" data-bateria="mt-bench"`);
    expect(html).toContain(esc(t("noSavings.notAttributable")));
  });

  it("los fallos que el banco encontró salen con su versión y su arreglo (0.4.30 → 0.4.31 y 0.4.31 → 0.4.32)", () => {
    const ids = BANCO.fallos.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["otra-pregunta", "herramientas-multiturno", "negativas-de-texto"]));
    for (const f of BANCO.fallos) {
      expect(html).toContain(`data-fallo="${f.id}"`);
      expect(html).toContain(`${f.encontradoEn} → ${f.arregladoEn}`);
    }
    const otra = BANCO.fallos.find((f) => f.id === "otra-pregunta")!;
    expect(otra.antes.ocurrencias).toBeGreaterThan(0);
    expect(otra.despues).toMatchObject({ ocurrencias: 0 });
  });

  it("cómo reproducirlo: los comandos existen en package.json y los arneses en el repo", () => {
    const scripts = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")).scripts as Record<string, string>;
    for (const { comando, arnes } of Object.values(REPRODUCIR)) {
      const nombre = comando.replace(/^pnpm /, "");
      expect(scripts[nombre], nombre).toContain(arnes);
      expect(existsSync(join(RAIZ, arnes)), arnes).toBe(true);
      expect(html).toContain(comando);
    }
    expect(html).toContain(`mailto:${CONTACTO}`);
  });
});

// ---------------------------------------------------------------------------

/** Los textos de un árbol de mensajes (sin las claves, que pueden llevar «gsm8k»). */
function valores(o: unknown): string[] {
  if (typeof o === "string") return [o];
  if (o && typeof o === "object") return Object.values(o).flatMap(valores);
  return [];
}

const COMPETIDORES = /bifrost|portkey|litellm|helicone|openrouter|vercel|kong|cloudflare|martian|not ?diamond|tensorzero|unify\.ai|langfuse/i;

describe("banco público: 12 idiomas y las reglas de la copia", () => {
  for (const loc of locales) {
    it(`${loc}: renderiza sin claves que falten y sin nombrar a ningún competidor`, () => {
      const html = pagina(BANCO, loc);
      expect(html).toContain('id="savings"');
      expect(html).not.toMatch(COMPETIDORES);
    });

    it(`${loc}: los mensajes de la página no llevan cifras propias ni «hasta X %»`, () => {
      const b = (mensajes(loc) as { benchmarksPage: unknown }).benchmarksPage;
      const texto = valores(b).join("\n");
      expect(texto).not.toMatch(COMPETIDORES);
      // Lo único numérico permitido son nombres propios y la fórmula del ahorro.
      const limpio = texto.replace(/GSM8K|Gemini 3|sha256|dist\/index|1 − /g, "");
      expect(limpio).not.toMatch(/\d/);
      expect(texto).not.toMatch(/%/);
    });
  }

  it("es/en: ningún «hasta …» / «up to …»", () => {
    expect(JSON.stringify((mensajes("es") as { benchmarksPage: unknown }).benchmarksPage)).not.toMatch(/\bhasta\b/i);
    expect(JSON.stringify((mensajes("en") as { benchmarksPage: unknown }).benchmarksPage)).not.toMatch(/\bup to\b/i);
  });

  it("la página se enlaza desde el pie y entra en el sitemap, sin tocar /pricing", () => {
    const pie = readFileSync(join(WEB, "app/components/Footer.tsx"), "utf8");
    expect(pie).toContain('[t("footer.benchmarks"), "/benchmarks"]');
    expect(readFileSync(join(WEB, "app/sitemap.ts"), "utf8")).toContain("/benchmarks");
    for (const loc of locales) {
      const f = (mensajes(loc) as { landing: { footer: Record<string, string> } }).landing.footer;
      expect(f.benchmarks, loc).toBeTruthy();
    }
  });

  it("la página se prerenderiza al construir (lee el disco en el build, nunca en ejecución)", () => {
    const src = readFileSync(join(WEB, "app/[locale]/benchmarks/page.tsx"), "utf8");
    expect(src).toContain('export const dynamic = "force-static"');
    expect(src).toContain("export const dynamicParams = false");
    expect(src).toContain("cargarBanco()");
  });
});
