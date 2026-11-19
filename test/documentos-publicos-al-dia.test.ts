import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A2-25 · LOS DOCUMENTOS PÚBLICOS DEL REPOSITORIO DICEN LA VERDAD DE HOY.
 *
 * El repositorio es público y desde la 1.0.0 cada versión lleva provenance
 * (`npm view @bivelio/savings-layer@1.0.0 dist.attestations`), el SBOM va
 * adjunto a cada Release del workflow, y el paquete es open core: sin clave
 * funciona entero (COMMUNITY) y la licencia solo gobierna Savings Cloud.
 *
 * SECURITY.md, docs/PUBLISHING.md y la cabecera de publish.yml seguían diciendo
 * que «mientras nuestro repositorio sea privado» no hay provenance, que el SBOM
 * se pide por correo y que el paquete es «public-inert» y «se niega a funcionar
 * sin una licencia firmada válida». Quien llega desde Product Hunt y abre la
 * pestaña de seguridad de GitHub lee eso, y contradice el «No key. No signup».
 *
 * Se vigila la CABECERA de publish.yml (lo que va antes de `on:`), no su lógica:
 * el paso de publicar conserva a propósito la rama de repositorio privado.
 */

const leer = (ruta: string) => readFileSync(fileURLToPath(new URL(`../${ruta}`, import.meta.url)), "utf8");
const plano = (t: string) => t.replace(/\s+/g, " ");

const seguridad = plano(leer("SECURITY.md"));
const publicar = plano(leer("docs/PUBLISHING.md"));
const workflow = leer(".github/workflows/publish.yml");
const cabecera = plano(workflow.slice(0, workflow.search(/^on:/m)));

const DOCUMENTOS: Record<string, string> = {
  "SECURITY.md": seguridad,
  "docs/PUBLISHING.md": publicar,
  "cabecera de .github/workflows/publish.yml": cabecera,
};

/** Frases que ya no son verdad: el repo es público y sin clave el paquete funciona. */
const VETADAS = [
  /public-inert/i,
  /refuses to run without/i,
  /\b(?:repository|repo) is private\b/i,
  /while (?:our|the) (?:repository|repo) is private/i,
  /only credential is the \*\*license key\*\*/i,
  /\blicense is the gate\b/i,
  /\bLICENSE \(not the registry\) is the gate\b/,
  /mientras (?:el|nuestro) (?:repo|repositorio) sea privado/i,
  /se niega a funcionar sin/i,
];

describe("A2-25 · SECURITY.md, PUBLISHING.md y la cabecera de publish.yml dicen la verdad de hoy", () => {
  for (const [nombre, texto] of Object.entries(DOCUMENTOS)) {
    it(`${nombre}: ninguna frase de cuando el repo era privado o el paquete no arrancaba sin licencia`, () => {
      expect(texto.length, `${nombre} está vacío`).toBeGreaterThan(200);
      const culpables = VETADAS.filter((r) => r.test(texto)).map(String);
      expect(culpables, nombre).toEqual([]);
    });
  }

  it("SECURITY.md: el repositorio es público, la provenance va desde la 1.0.0 y el SBOM está en cada Release", () => {
    expect(seguridad).toContain("The repository is public");
    expect(seguridad).toMatch(/From 1\.0\.0 on[^.]*provenance attestation/);
    expect(seguridad).toContain("attached to every GitHub Release");
    expect(seguridad).not.toMatch(/write to privacy@bivelio\.com to get it/);
  });

  it("SECURITY.md: open core — sin clave no se llama a nuestros servidores; la licencia gobierna Savings Cloud", () => {
    expect(seguridad).toContain("With no key (the open-core default)");
    expect(seguridad).toContain("Savings Cloud");
    expect(seguridad).toMatch(/configured but invalid[^.]*fails closed/);
  });

  it("docs/PUBLISHING.md y publish.yml: open core, y la clave inválida sigue cerrando", () => {
    for (const texto of [publicar, cabecera]) {
      expect(texto).toMatch(/open core/i);
      expect(texto).toMatch(/configured but invalid[^.]*fails? closed/i);
    }
    expect(publicar).toContain("Savings Cloud");
  });

  it("el código sigue siendo open core (si esto cambia, hay que reescribir los tres textos)", () => {
    const crear = leer("src/pipeline/create.ts");
    expect(crear).toMatch(/if \(!config\.licenseKey && !config\.licenseGate\) \{\s*resolved\.licenseGate = communityGate\(\);/);
    expect(leer("gateway/entitlements.ts")).toMatch(/class CanalComunitario[\s\S]*?tiene\(\): boolean \{\s*return true;/);
  });
});
