import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { BancoPublico, CONTACTO, LIMITES_TTL, UMBRAL_P, type Traductor } from "@/app/components/BancoPublico";
import { locales } from "@/i18n/config";
import { PALANCA_TTL, type PalancaTtl } from "@/lib/portada/palanca-ttl";

import { carpetaDelBanco, cuerpoServido, informesServidos, leerInformes } from "./cargar";
import { compararVersion, esBancoSemanal, resumirBanco, type Banco, type InformeFuente, type RegistroGsm8k } from "./extraer";
import { PREFIJO_DATOS, contarSensibles, limpiarInforme, rutaServida } from "./publicar";

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
 *      cifra en los mensajes;
 *   5. el repositorio es privado (decisión del dueño, 2026-09-29): ningún
 *      enlace a github.com, y los informes se sirven desde la web
 *      (/benchmarks/data/…), completos y sin datos del entorno de quien midió.
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

/** La página como la pinta /benchmarks: el banco y, en su sección, el informe del banco de TTL. */
function pagina(banco: Banco, loc = "es", palancaTtl: PalancaTtl | null = PALANCA_TTL): string {
  return renderToStaticMarkup(
    React.createElement(BancoPublico, { banco, t: traductor(loc), locale: loc, palancaTtl: palancaTtl ?? undefined }),
  );
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
      // Las sondas en vivo (#415) no son una batería A/B: no tienen fila en la tabla.
      if (Array.isArray(j.sondas)) continue;
      // El banco semanal tampoco: entra en su propia sección (si es en vivo).
      if (esBancoSemanal(j)) {
        if (String(j.modo).toLowerCase() === "vivo") expect([...BANCO.semanales, ...BANCO.parciales].some((s) => s.ruta === r), r).toBe(true);
        else expect(j.modo, r).toMatch(/seco/i);
        continue;
      }
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

  it("cada tirada enlaza su informe SERVIDO por la web, que existe y se construye", () => {
    const rutas = [...html.matchAll(/data-ruta="([^"]+)"/g)].map((m) => m[1]!);
    expect(rutas.length).toBeGreaterThan(0);
    const servidos = new Set(informesServidos(CARPETA).map((x) => `${PREFIJO_DATOS}/${x.fecha}/${x.fichero}`));
    for (const r of new Set(rutas)) {
      expect(r, r).toMatch(/^\/benchmarks\/data\/\d{4}-\d{2}-\d{2}\/[a-z0-9.-]+\.json$/);
      expect(html).toContain(`href="${r}"`);
      expect(servidos.has(r), r).toBe(true);
      const [, , , fecha, fichero] = r.split("/");
      expect(existsSync(join(CARPETA, fecha!, fichero!)), r).toBe(true);
    }
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
    // La gama alta real ya está en la carpeta (#396, #397): el nuevo SUMA a lo que ella cuenta.
    const antes = BANCO.fallos.find((f) => f.id === "gemini-prompt-cache-key")?.antes ?? { ocurrencias: 0, sobre: 0 };
    expect(fallo.antes).toMatchObject({ ocurrencias: antes.ocurrencias + 2, sobre: antes.sobre + 2 });
    expect(fallo.despues).toBeNull();
    const otra = pagina(banco, "es");
    expect(otra).toContain("google/gemini-prueba");
    expect(otra).toContain(esc(traductor("es")("bugs.items.gemini-prompt-cache-key.title")));
    // Ningún informe A/B lo midió tras el arreglo; el banco semanal más reciente
    // lo re-mide en los modelos de Gemini que pudo medir, y dice cuáles no.
    expect(fallo.sinMedirSemanal).toBeUndefined();
    expect(fallo.despuesFamilia).toMatchObject({ tipo: "capa-falla", ocurrencias: 0, medidos: ["google/gemini-3.8-flash"] });
    expect(fallo.despuesFamilia!.sinMedir).toEqual([{ modelo: "google/gemini-3.1-pro-preview", estado: "no-medible", motivo: "cuota" }]);
    expect(otra).toContain(esc(traductor("es")("weekly.reason.cuota")));
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

  it("cómo reproducirlo: cada dataset con su repositorio, su commit y su sha256 enteros (como texto, sin enlace)", () => {
    for (const d of BANCO.datasets) {
      expect(d.repo, d.bateria).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(html).toContain(`<code>${d.repo}</code>`);
      expect(html).toContain(`data-commit="${d.commit}">${d.commit}</code>`);
      for (const x of d.ficheros) expect(html).toContain(`data-sha256="${x.sha256}">${x.sha256}</code>`);
    }
    // Los datasets que fijan fichero lo hacen por sha256, tal como el informe.
    const gsm = BANCO.datasets.find((d) => d.bateria === "gsm8k")!;
    const crudoGsm = crudo(BANCO.fuentes.find((f) => f.bateria === "gsm8k")!.ruta).dataset;
    expect(gsm.commit).toBe(crudoGsm.commit);
    expect(gsm.ficheros.map((x) => x.sha256)).toEqual(crudoGsm.ficheros.map((x: J) => x.sha256));
  });

  it("la invitación: el contacto como texto seleccionable, además del mailto", () => {
    expect(html).toContain(`<span class="banco-email">${CONTACTO}</span>`);
    expect(html).toContain(`mailto:${CONTACTO}`);
  });
});

// ---------------------------------------------------------------------------

describe("banco público: el banco semanal en vivo (su propia sección)", () => {
  const semanales = INFORMES.filter((f) => esBancoSemanal(f.json));
  const html = pagina(BANCO, "es");

  it("reconoce cada resultado del banco semanal de la carpeta, y la sección enseña el más reciente", () => {
    expect(semanales.length).toBeGreaterThan(0);
    expect([...BANCO.semanales, ...BANCO.parciales].map((s) => s.ruta).sort()).toEqual(semanales.filter((f) => f.json.modo === "vivo").map((f) => f.ruta).sort());
    const ultima = BANCO.semanales[0]!;
    for (const s of BANCO.semanales) expect(s.inicio <= ultima.inicio).toBe(true);
    expect(html).toContain('id="weekly"');
    expect(html).toContain(`data-run="${ultima.runId}"`);
    expect(html).toContain(ultima.commit);
    // Ninguna celda semanal se cuela en las tablas A/B por versión.
    expect(BANCO.fuentes.some((f) => semanales.some((x) => x.ruta === f.ruta))).toBe(false);
  });

  it("cada celda sale con su estado y sus recuentos, tal como los trae el JSON crudo", () => {
    for (const s of BANCO.semanales) {
      const j = crudo(s.ruta);
      expect(s.commit).toBe(j.commit);
      expect(s.version).toBe(j.version);
      expect(s.gastoUsd).toBe(j.gastoUsd);
      expect(s.ok).toBe(j.veredicto.ok);
      expect(s.infracciones).toBe(j.veredicto.infracciones.length);
      // Las celdas aplazadas por la cuota diaria no se lanzaron: no son celdas de la tirada.
      const lanzadas = (j.resultados as J[]).filter((x) => x.estado !== "aplazada-por-cuota");
      expect(s.celdas.length).toBe(lanzadas.length);
      for (const [i, c] of s.celdas.entries()) {
        const x = lanzadas[i];
        expect(c.modelo).toBe(x.modelo);
        const medida = x.estado === "medida" && x.medicion.estado === "medido";
        expect(c.estado === "medida", `${c.bateria} ${c.modelo}`).toBe(medida);
        if (x.estado === "sin-soporte") expect(c.estado).toBe("sin-soporte");
        if (x.estado === "sin-clave") expect(c).toMatchObject({ estado: "no-medible", motivo: "sin-clave" });
        if (!medida) continue;
        expect(c.n).toBe(x.medicion.n);
        expect(c.fallosDeLaCapa).toBe(x.medicion.fallosDeLaCapa);
        expect(c.negativasCacheadas).toBe(x.medicion.negativasCacheadas);
        expect(c.negativasAcreditadas).toBe(x.medicion.negativasAcreditadas);
        expect(c.llamadasCambiadas).toBe(x.medicion.llamadasCambiadas);
        expect(c.respuestasDeOtraPregunta).toBe(x.medicion.respuestasDeOtraPregunta);
        expect(c.cortadaPorTope).toBe(x.medicion.cortadaPorTope);
      }
    }
    const ultima = BANCO.semanales[0]!;
    for (const c of ultima.celdas) expect(html).toContain(`data-modelo="${c.modelo}" data-bateria="${c.bateria}" data-estado="${c.estado}"`);
  });

  it("las negativas de XSTest quedan re-medidas por la tirada con el arreglo", () => {
    const t = traductor("es");
    const texto = BANCO.fallos.find((f) => f.id === "negativas-de-texto")!;
    const parciales = BANCO.fallos.find((f) => f.id === "negativas-parciales")!;
    expect(texto.despuesSemanal).toMatchObject({ cacheadas: 0, acreditadas: 0 });
    expect(texto.despuesSemanal!.modelos).toBeGreaterThan(0);
    // Las parciales las encontró el semanal ANTES de #422 y las re-mide a cero después.
    expect(parciales.antesSemanal!.cacheadas + parciales.antesSemanal!.acreditadas).toBeGreaterThan(0);
    expect(parciales.despuesSemanal).toMatchObject({ cacheadas: 0, acreditadas: 0 });
    expect(parciales.antesSemanal!.ruta).not.toBe(parciales.despuesSemanal!.ruta);
    expect(parciales).toMatchObject({ encontradoEn: "0.4.32", arregladoEn: "0.4.33", prs: [422] });
    // La frase vieja («pendiente de re-medir en la 0.4.32») ya no sale para ninguno de estos.
    expect(html).not.toContain(esc(t("bugs.pending", { version: "0.4.32" })));
    expect(html).toContain('data-fallo="negativas-parciales"');
    expect(html).toContain('data-semanal="re-medido"');
  });

  it("un banco PARCIAL (la jornada de Gemini 3.1 Pro) sale aparte: no es «la última tirada semanal», y dice qué midió", () => {
    expect(BANCO.parciales.length).toBeGreaterThan(0);
    for (const p of BANCO.parciales) {
      const j = crudo(p.ruta);
      expect(j.modo).toBe("vivo");
      expect(j.resultados.length).toBeLessThan(j.plan.length);
      expect(BANCO.semanales.some((s) => s.ruta === p.ruta)).toBe(false);
      // Solo las celdas lanzadas; las aplazadas por cuota, fuera.
      const lanzadas = (j.resultados as J[]).filter((x) => x.estado !== "aplazada-por-cuota");
      expect(p.celdas.length).toBe(lanzadas.length);
      expect(p.parcial!.modelos).toEqual([...new Set(lanzadas.map((x) => x.modelo))]);
      expect(p.parcial!.baterias.length).toBeGreaterThan(0);
      expect(p.ok).toBe(j.veredicto.ok);
      expect(html).toContain(`data-parcial="${p.parcial!.modelos.join(",")}"`);
      expect(html).toContain(`data-run="${p.runId}"`);
    }
    const t = traductor("es");
    expect(html).toContain(esc(t("weekly.partialTitle")));
    // Un banco completo nunca es parcial.
    for (const s of BANCO.semanales) expect(s.parcial).toBeUndefined();
  });

  it("Gemini: el primer semanal con Gemini nativo re-mide en Flash lo que su resumen cuenta; Pro, sin medir por cuota", () => {
    const t = traductor("es");
    const ultima = BANCO.semanales[0]!;
    expect(ultima.ruta).toBe("docs/benchmarks/2026-10-01/banco-semanal-5bec174.json");
    const j = crudo(ultima.ruta);
    const celda = (b: string, m: string) => j.resultados.find((x: J) => x.bateria === b && x.modelo === m);
    const FLASH = "google/gemini-3.8-flash";
    const PRO = "google/gemini-3.1-pro-preview";
    const pro = [{ modelo: PRO, estado: "no-medible", motivo: "cuota" }];
    // El filtro de contenido (XSTest): negativas cacheadas + acreditadas en Flash.
    const filtro = BANCO.fallos.find((f) => f.id === "gemini-filtro-cacheado");
    if (filtro) {
      const xs = celda("xstest", FLASH).medicion;
      expect(filtro.despuesFamilia).toMatchObject({ ruta: ultima.ruta, tipo: "negativas", medidos: [FLASH], sobre: xs.n, ocurrencias: xs.negativasCacheadas + xs.negativasAcreditadas });
      expect(filtro.despuesFamilia!.ocurrencias).toBe(0);
      expect(filtro.despuesFamilia!.sinMedir).toEqual(pro);
      expect(filtro.sinMedirSemanal).toBeUndefined();
    }
    // El 400 por prompt_cache_key (GSM8K): errores solo con la capa en Flash.
    const pck = BANCO.fallos.find((f) => f.id === "gemini-prompt-cache-key");
    if (pck) {
      const gs = celda("gsm8k", FLASH).medicion;
      expect(pck.despuesFamilia).toMatchObject({ tipo: "capa-falla", medidos: [FLASH], sobre: gs.n, ocurrencias: gs.fallosDeLaCapa });
      expect(pck.despuesFamilia!.ocurrencias).toBe(0);
      expect(pck.despuesFamilia!.sinMedir).toEqual(pro);
    }
    // La firma de pensamiento (BFCL multi-turno): el resumen del semanal no
    // cuenta las continuaciones, así que NO se da por re-medida.
    const firma = BANCO.fallos.find((f) => f.id === "gemini-thought-signature");
    if (firma) {
      expect(firma.despuesFamilia).toBeUndefined();
      expect(firma.sinContarSemanal).toMatchObject({ ruta: ultima.ruta, medidos: [FLASH], sinMedir: pro });
      expect(html).toContain('data-semanal="sin-contar"');
    }
    for (const f of [filtro, pck, firma]) if (f) expect(f.despues, f.id).toBeNull();
    expect([filtro, pck, firma].some(Boolean)).toBe(true);
    expect(html).toContain('data-sin-medir="cuota"');
    expect(html).toContain(esc(t("weekly.reason.cuota")));
    // Las celdas de Pro salen «no medible» por la cuota en la tabla semanal.
    for (const c of ultima.celdas.filter((x) => x.modelo === PRO)) expect(c).toMatchObject({ estado: "no-medible", motivo: "cuota" });
  });

  it("Gemini: la carrera del nivel de pensamiento (#442) — la encontró el semanal, y el siguiente la re-mide a cero", () => {
    const f = BANCO.fallos.find((x) => x.id === "gemini-nivel-de-pensamiento")!;
    expect(f).toMatchObject({ bateria: "xstest", encontradoEn: "0.4.35", arregladoEn: "0.4.36", prs: [442] });
    // Antes: la tirada del 2026-09-30 (ca621e2), que empezó antes de que #442 entrara en main.
    const antes = crudo(f.antesFamilia!.ruta);
    expect(f.antesFamilia!.ruta).toBe("docs/benchmarks/2026-09-30/banco-semanal-ca621e2.json");
    expect(Date.parse(antes.inicio)).toBeLessThan(Date.parse("2026-09-30T22:40:59Z"));
    const xsAntes = antes.resultados.find((x: J) => x.bateria === "xstest" && x.modelo === "google/gemini-3.8-flash").medicion;
    expect(f.antesFamilia).toMatchObject({ tipo: "capa-falla", ocurrencias: xsAntes.fallosDeLaCapa, sobre: xsAntes.n, medidos: ["google/gemini-3.8-flash"] });
    expect(f.antesFamilia!.ocurrencias).toBeGreaterThan(0);
    expect(xsAntes.ejemplosDeFallos.join(" ")).toMatch(/400/);
    // Después: la tirada del 2026-10-01 (5bec174), con el arreglo en main.
    const despues = crudo(f.despuesFamilia!.ruta);
    expect(Date.parse(despues.inicio)).toBeGreaterThan(Date.parse("2026-09-30T22:40:59Z"));
    expect(f.despuesFamilia).toMatchObject({ ruta: "docs/benchmarks/2026-10-01/banco-semanal-5bec174.json", ocurrencias: 0 });
    expect(html).toContain('data-fallo="gemini-nivel-de-pensamiento"');
    expect(html).toContain("0.4.35 → 0.4.36");
  });

  it("una tirada semanal nueva entra sola; si vuelve a ver negativas, la página lo dice", () => {
    const base = semanales.find((f) => f.ruta.endsWith("/banco-semanal.json"))!;
    const json = structuredClone(base.json);
    json.runId = "prueba";
    json.inicio = "2099-01-01T00:00:00.000Z";
    json.fin = "2099-01-01T01:00:00.000Z";
    const xs = json.resultados.find((x: J) => x.bateria === "xstest" && x.estado === "medida" && x.medicion.estado === "medido");
    xs.medicion.negativasCacheadas = 2;
    const banco = resumirBanco([...INFORMES, { ruta: "docs/benchmarks/2099-01-01/banco-semanal.json", json }]);
    expect(banco.semanales[0]!.runId).toBe("prueba");
    expect(banco.fallos.find((f) => f.id === "negativas-parciales")!.despuesSemanal!.cacheadas).toBe(2);
    const otra = pagina(banco, "es");
    expect(otra).toContain('data-run="prueba"');
    expect(otra).toContain('data-semanal="aun-visto"');
    // El modo seco no mide nada: no entra.
    const seco = { ...structuredClone(base.json), modo: "seco", runId: "seco" };
    expect(resumirBanco([...INFORMES, { ruta: "docs/benchmarks/2099-01-02/banco-semanal.json", json: seco }]).semanales.some((s) => s.runId === "seco")).toBe(false);
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

// ---------------------------------------------------------------------------

/**
 * LA REBAJA DE CACHÉ DEL GATEWAY (#gateway-ttl): EL INFORME DEL BANCO DE TTL.
 *
 * La tarjeta del gateway de la portada publica una cifra y enlaza aquí. La
 * sección no es una batería A/B: es un replay a precio de lista sobre una sola
 * organización, y tiene que decirlo. Sus números no salen de `docs/benchmarks`
 * al construir sino de lib/portada/palanca-ttl.ts, cuya verja
 * (palanca-ttl.test.ts) los cuadra uno a uno con el informe; aquí se comprueba
 * que la página pinta ESOS números, y que nada privado del informe se cuela.
 */
describe("banco público: la rebaja de caché del gateway, en su sección (#gateway-ttl)", () => {
  const P = PALANCA_TTL;
  /** El trozo de la página que es la sección, sin el resto. */
  function seccionTtl(loc: string, p: PalancaTtl = P): string {
    const html = pagina(BANCO, loc, p);
    const ini = html.indexOf('<section class="terms-sec" aria-labelledby="gateway-ttl-h" id="gateway-ttl"');
    expect(ini, `${loc}: la sección`).toBeGreaterThan(-1);
    return html.slice(ini, html.indexOf("</section>", ini));
  }
  const fmt = (loc: string) => {
    const n = (o: Intl.NumberFormatOptions) => new Intl.NumberFormat(loc, o);
    const pct2 = n({ style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });
    const usd2 = n({ style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ent = n({ maximumFractionDigits: 0 });
    const pct0 = n({ style: "percent", maximumFractionDigits: 0 });
    return {
      pct2: (x: number) => esc(pct2.format(x)),
      usd2: (x: number) => esc(usd2.format(x)),
      ent: (x: number) => esc(ent.format(x)),
      pct0: (x: number) => esc(pct0.format(x)),
      pct1: (x: number) => esc(pct(loc, x)),
    };
  };

  it("la sección existe, con su ancla, entre el ahorro medido y las garantías, y es aparte de las baterías A/B", () => {
    const html = pagina(BANCO, "es");
    const pos = ['id="savings"', 'id="gateway-ttl"', 'id="guarantees"'].map((x) => html.indexOf(x));
    for (const p of pos) expect(p).toBeGreaterThan(-1);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(html.match(/id="gateway-ttl"/g)).toHaveLength(1);
    // Aparte: no es una fila de batería ni una tirada con informe enlazado.
    const s = seccionTtl("es");
    expect(s).not.toMatch(/data-bateria=|data-ruta=|href=/);
    expect(s).toContain(`data-informe="${P.fecha}"`);
  });

  it("sin el informe no hay sección: no se pinta con números de ningún otro sitio", () => {
    expect(pagina(BANCO, "es", null)).not.toContain("gateway-ttl");
  });

  for (const loc of locales) {
    it(`${loc}: el veredicto, los dos intervalos y la muestra salen del módulo, formateados en el idioma`, () => {
      const s = seccionTtl(loc);
      const f = fmt(loc);
      // Veredicto: el neto, y los únicos dólares de la sección.
      expect(s).toContain(f.pct2(P.neto.point));
      expect(s).toContain(f.usd2(P.netoUsd));
      expect(s).toContain(f.usd2(P.facturaUsd));
      // Los dos intervalos, cota a cota.
      expect(s).toContain(`${f.pct2(P.neto.lower)} – ${f.pct2(P.neto.upper)}`);
      expect(s).toContain(`${f.pct2(P.netoPorDia.lower)} – ${f.pct2(P.netoPorDia.upper)}`);
      expect(s).toContain(f.pct0(P.confianza));
      expect(s).toContain(f.ent(P.remuestreos));
      // Sobre qué se midió.
      for (const n of [P.sesiones, P.peticiones, P.dias]) expect(s).toContain(`<dd>${f.ent(n)}</dd>`);
    });

    it(`${loc}: el resultado (rebajas, bruto, fallos y su coste, neto, techo) y la fila de cada modelo`, () => {
      const s = seccionTtl(loc);
      const f = fmt(loc);
      const fila = (clave: string) => {
        const ini = s.indexOf(`data-ttl-fila="${clave}"`);
        expect(ini, clave).toBeGreaterThan(-1);
        return s.slice(ini, s.indexOf("</tr>", ini));
      };
      expect(fila("rebajas")).toContain(`>${f.ent(P.rebajas)}<`);
      expect(fila("bruto")).toContain(f.pct2(P.brutoUsd / P.facturaUsd));
      expect(fila("fallos")).toContain(`>${f.ent(P.fallos)}<`);
      expect(fila("coste-fallos")).toContain(f.pct2(-P.costeFallosUsd / P.facturaUsd));
      expect(fila("neto")).toContain(f.pct2(P.neto.point));
      expect(fila("neto")).toContain(f.usd2(P.netoUsd));
      expect(fila("techo")).toContain(f.pct1(P.techo));
      for (const m of P.porModelo) {
        const ini = s.indexOf(`data-ttl-modelo="${m.modelo}"`);
        expect(ini, m.modelo).toBeGreaterThan(-1);
        const tr = s.slice(ini, s.indexOf("</tr>", ini));
        expect(tr).toContain(`<td>${f.ent(m.peticiones)}</td><td>${f.ent(m.rebajas)}</td><td>${f.ent(m.fallos)}</td>`);
        // Donde el informe no da porcentaje (n = 5), la página tampoco lo inventa.
        if (m.neto === null) expect(tr, m.modelo).not.toContain("%");
        else expect(tr, m.modelo).toContain(`>${f.pct2(m.neto)}<`);
      }
    });

    it(`${loc}: el caso feo se enseña, con su pérdida; la regla, la variante conservadora, los límites y la versión`, () => {
      const s = seccionTtl(loc);
      const f = fmt(loc);
      const F = P.casoFeo;
      expect(s).toContain(`<b>${F.modelo}`);
      expect(s).toContain(f.pct0(F.cuotaRebajas));
      expect(s).toContain(f.pct0(F.cuotaFallos));
      // La pérdida, en valor absoluto y con el decimal del informe: el texto dice «perdió».
      expect(F.netoPrimerPeriodo).toBeLessThan(0);
      expect(s).toContain(f.pct1(Math.abs(F.netoPrimerPeriodo)));
      // Los límites que llevan números: la línea base reconstruida es la MAYORÍA
      // (con el intervalo del primer tramo, solo) y el techo cambia con el cliente.
      expect(s).toContain(f.pct0(P.reconstruidas.peticiones / P.peticiones));
      expect(s).toContain(f.pct2(P.primerPeriodo.lower));
      expect(s).toContain(f.pct2(P.primerPeriodo.upper));
      expect(s).toContain(f.ent(P.sinMarcaDeHora));
      expect(s).toContain(f.pct0(P.umbralNuevo));
      expect(s).toContain(f.pct2(P.conservadora.neto));
      for (const k of LIMITES_TTL) expect(s, k).toContain(`data-ttl-limite="${k}"`);
      expect(s).toContain(P.netoEnProduccionDesde);
    });

    it(`${loc}: nada privado del informe llega a la página, y no hay más dólares que los del veredicto`, () => {
      const s = seccionTtl(loc);
      // Lo que la verja de los informes servidos consideraría fuga: rutas, worktrees, claves, correos.
      const fugas = contarSensibles(s);
      expect(Object.values(fugas).reduce((a, b) => a + b, 0), JSON.stringify(fugas)).toBe(0);
      // El contraste con producción, los comandos y la jerga interna del informe.
      expect(s).not.toMatch(/supabase|usage_daily|measured_|shadow_|bvsala|\/tmp|~\/|ttl:replay|sobrecosteEvitado|medidor\.ts/i);
      // Dólares: solo el neto y la factura del veredicto (ni el bruto, ni el coste de los fallos, ni por modelo).
      const f = fmt(loc);
      const sinVeredicto = s.split(f.usd2(P.netoUsd)).join("").split(f.usd2(P.facturaUsd)).join("");
      expect(sinVeredicto).not.toMatch(/\$|USD/);
      for (const x of [P.brutoUsd, P.costeFallosUsd]) expect(s).not.toContain(f.usd2(x));
    });
  }

  it("la sinceridad, en español y en inglés: replay, no medido en vivo, una sola organización (la nuestra), precio de lista", () => {
    const es = (mensajes("es") as { benchmarksPage: { gatewayTtl: { kind: string; title: string; limits: Record<string, string> } } }).benchmarksPage.gatewayTtl;
    const en = (mensajes("en") as { benchmarksPage: { gatewayTtl: { kind: string; title: string; limits: Record<string, string> } } }).benchmarksPage.gatewayTtl;
    expect(es.kind).toMatch(/no está medida en vivo/);
    expect(es.kind).toMatch(/replay/);
    expect(es.kind).toMatch(/una sola organización, la nuestra/);
    expect(es.kind).toMatch(/precio de lista/);
    expect(es.title).toMatch(/simulación, no un A\/B/);
    expect(en.kind).toMatch(/not measured live/);
    expect(en.kind).toMatch(/replay/);
    expect(en.kind).toMatch(/a single organization, our own/);
    expect(en.kind).toMatch(/list prices/);
    // Y nunca al revés: ningún idioma dice que esto se midió en vivo sin negarlo.
    expect(JSON.stringify(es)).not.toMatch(/(?<!no está )medid[oa] en vivo/);
    expect(JSON.stringify(en)).not.toMatch(/(?<!not )measured live/);
    expect(Object.keys(es.limits).sort()).toEqual([...LIMITES_TTL].sort());
  });

  it("cambiar un número del módulo cambia la sección (no hay cifras escritas en el componente)", () => {
    const otro = { ...P, neto: { ...P.neto, point: 0.0311 }, rebajas: 2584 } as unknown as PalancaTtl;
    const s = seccionTtl("es", otro);
    const f = fmt("es");
    expect(s).toContain(f.pct2(0.0311));
    expect(s).not.toContain(f.pct2(P.neto.point));
    expect(seccionTtl("es")).toContain(f.pct2(P.neto.point));
    expect(s).toContain(`>${f.ent(2584)}<`);
    const fuente = readFileSync(join(WEB, "app/components/BancoPublico.tsx"), "utf8");
    const fn = fuente.slice(fuente.indexOf("function PalancaDeTtl"), fuente.indexOf("function Negativa"));
    expect(fn.length).toBeGreaterThan(500);
    // Ningún literal numérico (los dígitos de `h2`, `pct2` o `usd2` son nombres).
    expect(fn).not.toMatch(/(?<![\w-])\d/);
  });

  it("la página pasa el informe a la sección", () => {
    const src = readFileSync(join(WEB, "app/[locale]/benchmarks/page.tsx"), "utf8");
    expect(src).toContain("palancaTtl={PALANCA_TTL}");
    expect(src).toContain('import { PALANCA_TTL } from "@/lib/portada/palanca-ttl";');
  });
});

// ---------------------------------------------------------------------------

describe("banco público: sin enlaces al código (el repositorio es privado)", () => {
  for (const loc of locales) {
    it(`${loc}: la página renderizada no enlaza ni nombra github.com, ni cita comandos o arneses del repo`, () => {
      const html = pagina(BANCO, loc);
      expect(html).not.toMatch(/github\.com/i);
      expect(html).not.toMatch(/githubusercontent/i);
      expect(html).not.toMatch(/bivelio-savings-layer\/(?:blob|tree)/i);
      expect(html).not.toMatch(/pnpm bench|benchmarks\/publicados|\.env\.bench/);
      // Todo enlace es interno (los informes servidos) o el correo de contacto.
      for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
        expect(href!, href).toMatch(/^(?:\/benchmarks\/data\/|mailto:)/);
      }
    });

    it(`${loc}: los mensajes de la página no hablan de GitHub, del repositorio ni de comandos`, () => {
      const texto = valores((mensajes(loc) as { benchmarksPage: unknown }).benchmarksPage).join("\n");
      expect(texto).not.toMatch(/github|pnpm|\.env|https?:\/\//i);
    });
  }

  it("el pie de /benchmarks va sin el icono de GitHub (el resto de páginas no cambia)", () => {
    const src = readFileSync(join(WEB, "app/[locale]/benchmarks/page.tsx"), "utf8");
    expect(src).toContain("<Footer sinGitHub />");
    const pie = readFileSync(join(WEB, "app/components/Footer.tsx"), "utf8");
    expect(pie).toContain("<SocialDock sinGitHub={sinGitHub} />");
  });

  it("el componente ya no guarda la URL del repositorio", () => {
    const src = readFileSync(join(WEB, "app/components/BancoPublico.tsx"), "utf8");
    expect(src).not.toMatch(/github\.com/i);
    expect(src).not.toMatch(/export const REPO\b/);
  });
});

describe("banco público: los informes servidos desde la web (/benchmarks/data/…)", () => {
  const servidos = informesServidos(CARPETA);

  it("se sirve cada informe JSON de la carpeta, uno por fichero, y la ruta coincide con la del enlace", () => {
    expect(servidos.length).toBe(INFORMES.length);
    for (const f of INFORMES) {
      const url = rutaServida(f.ruta);
      expect(servidos.some((x) => `${PREFIJO_DATOS}/${x.fecha}/${x.fichero}` === url), url).toBe(true);
    }
  });

  it("incluye los informes que entraron en main: gama alta y Claude (GSM8K, BFCL, XSTest, MT-Bench)", () => {
    // La gama alta de GSM8K trae el fallo de Gemini (prompt_cache_key → 400) contado en su informe.
    expect(BANCO.fallos.find((f) => f.id === "gemini-prompt-cache-key")?.antes.ocurrencias ?? 0).toBeGreaterThan(0);
    expect(BANCO.modelos.some((m) => m.startsWith("google/"))).toBe(true);
    const nombres = servidos.map((x) => x.fichero);
    for (const f of [
      "gsm8k-0431-gama-alta.json",
      "gsm8k-0431-claude.json",
      "xstest-0431-gama-alta.json",
      "xstest-0431-claude.json",
      "bfcl-0431-claude.json",
      "bfcl-0431-gama-alta.json",
      "mt-bench-0431-claude.json",
    ]) {
      expect(nombres, f).toContain(f);
      expect(BANCO.fuentes.some((x) => x.ruta.endsWith(`/${f}`)), f).toBe(true);
    }
  });

  it("los JSON servidos existen y cuadran: la página que sale de ellos es la misma", () => {
    const desdeServidos: InformeFuente[] = INFORMES.map((f) => {
      const { fecha, fichero } = servidos.find((x) => rutaServida(f.ruta) === `${PREFIJO_DATOS}/${x.fecha}/${x.fichero}`)!;
      const cuerpo = cuerpoServido(fecha, fichero, CARPETA);
      expect(cuerpo, f.ruta).not.toBeNull();
      const json = JSON.parse(cuerpo!);
      // Lo único que cambia es lo que la limpieza cuenta; si no cuenta nada, es el informe entero.
      const l = limpiarInforme(f.json);
      const tocados = l.textosXSTest + Object.values(l.hallazgos).reduce((a, b) => a + b, 0);
      if (tocados === 0) expect(json, f.ruta).toEqual(f.json);
      return { ruta: f.ruta, json };
    });
    expect(resumirBanco(desdeServidos)).toEqual(BANCO);
  }, 20_000);

  it("la copia servida no lleva claves, rutas de disco, worktrees, correos ni texto de XSTest", () => {
    for (const { fecha, fichero } of servidos) {
      const cuerpo = cuerpoServido(fecha, fichero, CARPETA)!;
      expect(contarSensibles(cuerpo), fichero).toEqual({ claves: 0, rutasLocales: 0, worktrees: 0, correos: 0 });
      expect(cuerpo, fichero).not.toMatch(/fisagol|\/Users\/|\.claude\/worktrees/);
      if (fichero.startsWith("xstest")) {
        const j = JSON.parse(cuerpo);
        expect(j.registros.length, fichero).toBeGreaterThan(0);
        const textos: string[] = [];
        (function w(v: unknown, k: string) {
          if (Array.isArray(v)) v.forEach((x) => w(x, k));
          else if (v && typeof v === "object") for (const [kk, x] of Object.entries(v)) w(x, kk);
          else if (typeof v === "string" && /^(?:texto|text|respuesta|response|output|contenido|content|completion|prompt)/.test(k)) textos.push(k);
        })(j.registros, "");
        expect(textos, fichero).toEqual([]);
      }
    }
  });

  it("a una ruta que no existe o que intenta salir de la carpeta no se le sirve nada", () => {
    expect(cuerpoServido("2026-09-28", "no-existe.json", CARPETA)).toBeNull();
    expect(cuerpoServido("..", "package.json", CARPETA)).toBeNull();
    expect(cuerpoServido("2026-09-28", "../../../package.json", CARPETA)).toBeNull();
    expect(cuerpoServido("2026-09-28", "gsm8k.md", CARPETA)).toBeNull();
  });

  it("la limpieza quita lo del entorno y deja los datos de los datasets públicos", () => {
    // Valores inventados con forma de secreto (se construyen aquí: no son claves de nadie).
    const falsaAnthropic = "sk-ant-" + "x".repeat(40);
    const falsaOpenAI = "sk-proj-" + "Y".repeat(40);
    const falsaGoogle = "AIza" + "Z".repeat(35);
    const sucio = {
      dataset: { fuente: "paul-rottger/exaggerated-safety" },
      nota: `clave ${falsaAnthropic} y Bearer ${falsaOpenAI}`,
      entorno: { cwd: "/Users/alguien/bsl-d-publico/benchmarks", tmp: "/private/var/folders/ab/cd/T/x", wt: ".claude/worktrees/agente-7" },
      [`/home/alguien/${"k"}`]: falsaGoogle,
      contacto: "alguien@gmail.com, support@bivelio.com",
      registros: [{ texto: "una respuesta a un prompt inseguro", textoLen: 34, respuestaServida: "otra", clase: "full_compliance" }],
      // Datos del dataset BFCL: se quedan.
      prompt: { to: "john.doe@example.com", file: "/user/home/datasets/finance.csv" },
    };
    const { json, hallazgos, textosXSTest } = limpiarInforme(sucio);
    const s = JSON.stringify(json);
    expect(hallazgos.claves).toBe(3);
    expect(hallazgos.rutasLocales).toBeGreaterThanOrEqual(3);
    expect(hallazgos.worktrees).toBeGreaterThanOrEqual(1);
    expect(hallazgos.correos).toBe(1);
    expect(textosXSTest).toBe(2);
    for (const x of [falsaAnthropic, falsaOpenAI, falsaGoogle, "/Users/", "/private/var", "bsl-d-publico", ".claude/worktrees", "alguien@gmail.com", "prompt inseguro"]) {
      expect(s).not.toContain(x);
    }
    expect(contarSensibles(s)).toEqual({ claves: 0, rutasLocales: 0, worktrees: 0, correos: 0 });
    expect(s).toContain("support@bivelio.com");
    expect(s).toContain("john.doe@example.com");
    expect(s).toContain("/user/home/datasets/finance.csv");
    expect(s).toContain('"textoLen":34');
  });

  it("la ruta se prerenderiza al construir, desde la misma carpeta, y da 404 a lo demás", () => {
    const src = readFileSync(join(WEB, "app/benchmarks/data/[fecha]/[fichero]/route.ts"), "utf8");
    expect(src).toContain('export const dynamic = "force-static"');
    expect(src).toContain("export const dynamicParams = false");
    expect(src).toContain("generateStaticParams");
    expect(src).toContain("cuerpoServido(");
    // El middleware de idiomas no toca la ruta de los informes (si la tocara,
    // next-intl la mandaría a /<idioma>/benchmarks/data/… y daría 404).
    // middleware-matcher.test.ts lo comprueba contra el patrón compilado.
    expect(readFileSync(join(WEB, "middleware.ts"), "utf8")).toContain("benchmarks/data|");
  });
});
