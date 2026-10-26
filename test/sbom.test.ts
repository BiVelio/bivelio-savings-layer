import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { construirSbom, generarSbom } from "../scripts/sbom.js";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));

interface ComponenteCdx {
  group?: string;
  name: string;
  scope: string;
  properties: { name: string; value: string }[];
}

const nombreCompleto = (c: ComponenteCdx): string => `${c.group ? `${c.group}/` : ""}${c.name}`;

const entrada = {
  paquete: { name: "paquete", version: "1.0.0" },
  tarball: { sha512Hex: "a".repeat(128), sha256Hex: "b".repeat(64) },
  timestamp: "2026-01-01T00:00:00.000Z",
  serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000000",
};

describe("SBOM CycloneDX", () => {
  it("marca required los bundles y peers obligatorios, y optional solo los peers opcionales", () => {
    const sbom = construirSbom({
      ...entrada,
      componentes: [
        { name: "bundled", version: "1.2.3", inclusion: "bundled" },
        { name: "required", range: "^2", inclusion: "required-peer" },
        { name: "optional", range: "^3", inclusion: "optional-peer" },
      ],
    });
    const componentes = (sbom.components as ComponenteCdx[]).map((c) => ({
      name: c.name,
      scope: c.scope,
      inclusion: c.properties.find((p) => p.name === "bivelio:inclusion")?.value,
    }));

    expect(componentes).toEqual([
      { name: "bundled", scope: "required", inclusion: "bundled" },
      { name: "optional", scope: "optional", inclusion: "optional-peer" },
      { name: "required", scope: "required", inclusion: "required-peer" },
    ]);
  });

  it("genera el SBOM real de persistence-postgres desde su propia raíz", async () => {
    const packageRoot = join(RAIZ, "packages", "persistence-postgres");
    const tmp = mkdtempSync(join(tmpdir(), "bvsala-sbom-test-"));
    try {
      execFileSync("pnpm", ["--dir", packageRoot, "build"], { cwd: RAIZ, stdio: "pipe" });
      const salidaPack = execFileSync("pnpm", ["--dir", packageRoot, "pack", "--pack-destination", tmp], {
        cwd: RAIZ,
        encoding: "utf8",
      });
      const tarball = resolve(tmp, salidaPack.trim().split("\n").at(-1)!);
      const manifiestoEmpaquetado = execFileSync("tar", ["xOf", tarball, "package/package.json"], {
        encoding: "utf8",
      });
      expect(manifiestoEmpaquetado).not.toContain("workspace:");

      const sbom = await generarSbom(tarball, {
        packageRoot,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        serialNumber: entrada.serialNumber,
      });
      const componentes = (sbom as { components: ComponenteCdx[] }).components;
      const porNombre = new Map(componentes.map((c) => [nombreCompleto(c), c]));
      const manifiesto = JSON.parse(manifiestoEmpaquetado) as {
        peerDependencies?: Record<string, string>;
        peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      };
      for (const [name, range] of Object.entries(manifiesto.peerDependencies ?? {})) {
        const peer = porNombre.get(name);
        const inclusion = manifiesto.peerDependenciesMeta?.[name]?.optional === true ? "optional-peer" : "required-peer";
        expect(peer?.scope).toBe(inclusion === "optional-peer" ? "optional" : "required");
        expect(peer?.properties).toContainEqual({ name: "bivelio:inclusion", value: inclusion });
        expect(peer?.properties).toContainEqual({ name: "bivelio:versionRange", value: range });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
