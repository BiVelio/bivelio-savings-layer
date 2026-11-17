import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CABECERA } from "@/app/[locale]/paper/contenido";

import { EDICION_PAPER } from "./edicion";

/**
 * La edición que el sitio ENLAZA tiene que ser la que el sitio PINTA: el PDF
 * existe, su versión y su DOI son los del contenido generado de docs/PAPER.md,
 * y ningún fichero fuente vuelve a enlazar el PDF de la edición anterior.
 */
const WEB = join(new URL(".", import.meta.url).pathname, "..", "..");

function fuentes(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === "public" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) fuentes(p, acc);
    else if (/\.(?:tsx?|mjs|json|css|md|txt)$/.test(e) && !/\.(?:test|spec)\./.test(e)) acc.push(p);
  }
  return acc;
}

describe("artículo de investigación: una sola edición vigente", () => {
  it("el PDF de la constante existe en public/ y es un PDF", () => {
    expect(EDICION_PAPER.pdf).toMatch(/^\/papers\/[\w.-]+\.pdf$/);
    const ruta = join(WEB, "public", EDICION_PAPER.pdf);
    expect(existsSync(ruta), ruta).toBe(true);
    expect(readFileSync(ruta).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // El nombre del fichero lleva la versión: una edición nueva no pisa la anterior.
    expect(EDICION_PAPER.pdf).toContain(EDICION_PAPER.version);
  });

  it("ningún fichero fuente (fuera de las pruebas) enlaza el PDF de la edición anterior", () => {
    const con = fuentes(WEB).filter((f) => readFileSync(f, "utf8").includes("2026-10.pdf"));
    expect(con.map((f) => f.replace(WEB, "apps/web"))).toEqual([]);
  });

  it("la versión es la de la cabecera del artículo que pinta /paper", () => {
    const enCabecera = /\bv\d+(?:\.\d+)*(?:-r\d+)?/.exec(CABECERA.version)?.[0];
    expect(enCabecera).toBe(EDICION_PAPER.version);
  });

  it("el DOI es el del registro de Zenodo que cita el artículo, y las URL salen de él", () => {
    const contenido = readFileSync(join(WEB, "app/[locale]/paper/contenido.ts"), "utf8");
    const linea = contenido.split("\n").find((l) => l.includes("Zenodo record (this version)"));
    expect(linea, "línea del registro de Zenodo en contenido.ts").toBeTruthy();
    expect(linea).toContain(EDICION_PAPER.urlDoi);
    expect(linea).toContain(EDICION_PAPER.licencia);
    expect(EDICION_PAPER.urlDoi).toBe(`https://doi.org/${EDICION_PAPER.doi}`);
    expect(EDICION_PAPER.urlZenodo).toBe(`https://zenodo.org/records/${EDICION_PAPER.doi.split(".").pop()}`);
    expect(EDICION_PAPER.urlTodasLasVersiones).toBe(`https://doi.org/${EDICION_PAPER.doiConcepto}`);
    expect(EDICION_PAPER.doiConcepto).not.toBe(EDICION_PAPER.doi);
  });

  it("la fecha es una fecha ISO válida y las páginas, un entero positivo", () => {
    expect(EDICION_PAPER.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(new Date(`${EDICION_PAPER.fecha}T00:00:00Z`).getTime())).toBe(false);
    expect(Number.isInteger(EDICION_PAPER.paginas) && EDICION_PAPER.paginas > 0).toBe(true);
  });

  it("la tarjeta y /paper toman los enlaces de la constante, no de una URL escrita a mano", () => {
    for (const f of ["app/components/campana/TarjetaPaper.tsx", "app/[locale]/paper/page.tsx", "app/components/BancoPublico.tsx"]) {
      const src = readFileSync(join(WEB, f), "utf8");
      expect(src, f).toContain('from "@/lib/paper/edicion"');
      expect(src, f).not.toMatch(/zenodo\.org|doi\.org|\/papers\/[\w.-]+\.pdf/);
    }
  });
});
