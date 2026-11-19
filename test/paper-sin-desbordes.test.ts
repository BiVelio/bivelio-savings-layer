import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * NINGUNA LÍNEA DEL PAPER SE SALE DE LA PÁGINA. En «Data and code
 * availability» las rutas iban en \texttt{}, que no se puede partir: la de
 * `gsm8k-0431-claude.json` pasaba 257 pt del margen y en el PDF solo se leía
 * «docs/benchmarks/2» (y otra 58 pt; y 18,6 pt la línea de usageMetadata).
 *
 * Dos verjas: aquí, que main.tex lleve las rutas en \path{} y el
 * \emergencystretch; en compilar-paper.yml, que el log de la compilación de
 * verdad no traiga ningún «Overfull \hbox» de más de 10 pt. Este test ejecuta
 * el script de ese paso contra logs de ejemplo.
 */

const raiz = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const tex = readFileSync(raiz("docs/paper/main.tex"), "utf8");
const sinComentariosTex = tex
  .split("\n")
  .map((l) => l.replace(/(^|[^\\])%.*$/, "$1"))
  .join("\n");

describe("paper: las rutas no se salen del margen", () => {
  it("ninguna ruta va en \\texttt{} (no se parte): van en \\path{}", () => {
    const rutasEnTexttt = [...sinComentariosTex.matchAll(/\\texttt\{([^}]*\/[^}]*)\}/g)].map((m) => m[1]);
    expect(rutasEnTexttt).toEqual([]);
    expect(sinComentariosTex).toContain("\\path{docs/benchmarks/2026-09-28/gsm8k-0431-claude.json}");
  });

  it("declara \\emergencystretch en el preámbulo (solo actúa donde habría una línea desbordada)", () => {
    const preambulo = sinComentariosTex.slice(0, sinComentariosTex.indexOf("\\begin{document}"));
    expect(preambulo).toMatch(/^\\emergencystretch=\d+(?:\.\d+)?em$/m);
    // \path lo trae el paquete url, que carga hyperref.
    expect(preambulo).toContain("\\usepackage{hyperref}");
  });
});

describe("compilar-paper.yml falla si el log trae un Overfull de más de 10 pt", () => {
  const workflow = readFileSync(raiz(".github/workflows/compilar-paper.yml"), "utf8");

  function script(): string {
    const i = workflow.indexOf("- name: Ninguna línea se sale del margen");
    if (i < 0) throw new Error("compilar-paper.yml no tiene el paso que mira los desbordes");
    const paso = workflow.slice(i, workflow.indexOf("\n      - ", i + 1));
    expect(paso).toMatch(/working-directory: docs\/paper/);
    const j = paso.indexOf("run: |\n");
    const lineas = paso.slice(j + "run: |\n".length).split("\n");
    const sangria = /^ */.exec(lineas[0]!)![0].length;
    return lineas.map((l) => l.slice(sangria)).join("\n");
  }

  /** Ejecuta el paso con `bash -eo pipefail`, como GitHub con `shell: bash`, sobre un main.log dado. */
  function ejecutar(log: string | null): { ok: boolean; salida: string } {
    const dir = mkdtempSync(join(tmpdir(), "paper-log-"));
    try {
      if (log !== null) writeFileSync(join(dir, "main.log"), log);
      const r = spawnSync("bash", ["-eo", "pipefail", "-c", script()], { cwd: dir, encoding: "utf8" });
      return { ok: r.status === 0, salida: `${r.stdout}${r.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Logs inventados con el formato de LaTeX (las cifras, las de la auditoría).
  const LIMPIO = "This is XeTeX, Version 3.141592653\n(./main.aux)\nOutput written on main.pdf (15 pages).\n";
  const DESBORDADO = [
    "Overfull \\hbox (256.7131pt too wide) in paragraph at lines 626--632",
    "[]\\T1/lmr/m/n/10.95 Historical pri-mary ar-ti-facts are \\T1/lmtt/m/n/10.95 docs",
    "",
  ].join("\n");
  const MENOR = "Overfull \\hbox (2.59949pt too wide) in paragraph at lines 627--633\n";

  it("pasa con un log limpio o con desbordes de 10 pt o menos", () => {
    expect(ejecutar(LIMPIO).ok).toBe(true);
    expect(ejecutar(LIMPIO + MENOR).ok).toBe(true);
    expect(ejecutar("Overfull \\hbox (10.0pt too wide) in paragraph at lines 1--2\n").ok).toBe(true);
  });

  it("falla con un desborde de más de 10 pt y dice cuál", () => {
    const r = ejecutar(LIMPIO + MENOR + DESBORDADO);
    expect(r.ok).toBe(false);
    expect(r.salida).toContain("256.7131pt too wide");
    expect(r.salida).not.toContain("2.59949pt");
    expect(ejecutar("Overfull \\hbox (18.55971pt too wide) in paragraph at lines 260--269\n").ok).toBe(false);
  });

  it("falla si no hay log: un paso que no mira nada no puede salir verde", () => {
    const r = ejecutar(null);
    expect(r.ok).toBe(false);
    expect(r.salida).toContain("main.log");
  });

  it("va después de compilar y antes de subir el PDF", () => {
    const compilar = workflow.indexOf("xu-cheng/latex-action@");
    const puerta = workflow.indexOf("- name: Ninguna línea se sale del margen");
    const subir = workflow.indexOf("actions/upload-artifact@");
    expect(compilar).toBeGreaterThan(0);
    expect(puerta).toBeGreaterThan(compilar);
    expect(subir).toBeGreaterThan(puerta);
  });
});
