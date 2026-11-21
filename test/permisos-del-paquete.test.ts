import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * EL TARBALL SALE CON 644/755 AUNQUE QUIEN EMPAQUETA TENGA UMASK 077.
 *
 * La verificación final de la 1.2.4 empaquetó una copia de la release hecha con
 * umask 077: 36 ficheros -rw------- y bin.js -rwx------, que `npm install` deja
 * igual en node_modules (otro usuario no podría leer dist/index.js ni ejecutar
 * `bvsala`). publish.yml empaqueta desde un checkout de CI (umask 022) y no le
 * pasaba; una publicación a mano desde un árbol así, sí. El `prepack` de
 * package.json (scripts/permisos-del-paquete.mjs) añade la lectura para todos
 * antes de empaquetar, y en CI no cambia nada.
 */

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(RAIZ, "scripts", "permisos-del-paquete.mjs");
const modo = (ruta: string): number => statSync(ruta).mode & 0o777;

describe.skipIf(process.platform === "win32")("prepack · permisos del paquete", () => {
  it("package.json lo ejecuta como prepack, con node a secas (sin dependencias)", () => {
    const pkg = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.prepack).toBe("node scripts/permisos-del-paquete.mjs");
  });

  it("añade lectura (y ejecución donde ya la había) a lo que lista `files`, y no toca lo demás", () => {
    const dir = mkdtempSync(join(tmpdir(), "bv-permisos-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", files: ["dist", "README.md", "no-existe"] }));
      mkdirSync(join(dir, "dist", "gateway"), { recursive: true });
      writeFileSync(join(dir, "dist", "index.js"), "export {};\n");
      writeFileSync(join(dir, "dist", "gateway", "bin.js"), "#!/usr/bin/env node\n");
      writeFileSync(join(dir, "README.md"), "# x\n");
      writeFileSync(join(dir, "fuera.txt"), "no va en el paquete\n");
      chmodSync(join(dir, "package.json"), 0o600);
      chmodSync(join(dir, "dist", "index.js"), 0o600);
      chmodSync(join(dir, "dist", "gateway", "bin.js"), 0o700);
      chmodSync(join(dir, "dist", "gateway"), 0o700);
      chmodSync(join(dir, "dist"), 0o700);
      chmodSync(join(dir, "README.md"), 0o600);
      chmodSync(join(dir, "fuera.txt"), 0o600);

      const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      // Nada por stdout: los tests leen el nombre del tarball de `npm pack --silent`.
      expect(r.stdout).toBe("");

      expect(modo(join(dir, "package.json"))).toBe(0o644);
      expect(modo(join(dir, "dist"))).toBe(0o755);
      expect(modo(join(dir, "dist", "gateway"))).toBe(0o755);
      expect(modo(join(dir, "dist", "index.js"))).toBe(0o644);
      expect(modo(join(dir, "dist", "gateway", "bin.js"))).toBe(0o755);
      expect(modo(join(dir, "README.md"))).toBe(0o644);
      expect(modo(join(dir, "fuera.txt")), "lo que no se publica no se toca").toBe(0o600);

      // Solo añade bits: un fichero que ya era 664 sigue 664.
      chmodSync(join(dir, "README.md"), 0o664);
      expect(spawnSync(process.execPath, [SCRIPT, dir]).status).toBe(0);
      expect(modo(join(dir, "README.md"))).toBe(0o664);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("el tarball de `npm pack` de este árbol sale legible para todos (-rw-r--r-- / -rwxr-xr-x)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bv-pack-permisos-"));
    try {
      const tgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: RAIZ, encoding: "utf8" }).trim();
      const lista = execFileSync("tar", ["tvzf", join(dir, tgz)], { encoding: "utf8" }).trim().split("\n");
      expect(lista.length).toBeGreaterThan(10);
      const raros = lista.filter((l) => !/^-rw-r--r--|^-rwxr-xr-x/.test(l));
      expect(raros).toEqual([]);
      expect(lista.some((l) => l.startsWith("-rwxr-xr-x") && l.endsWith("package/dist/gateway/bin.js"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
