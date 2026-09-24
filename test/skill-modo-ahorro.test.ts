import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { instalarSkill, origenDelSkill, NOMBRE_SKILL, type FsDeSkill } from "../gateway/skill.js";

/**
 * El skill «savings-mode»: instrucciones para usuarios de SUSCRIPCIÓN (sin
 * factura, con topes). Verjas: el fichero empaquetado es válido y MAGRO (un
 * skill que ahorra tokens no puede costar mil por turno), viaja en el paquete
 * npm, y el instalador jamás pisa una instalación local modificada sin
 * --forzar.
 */

const RAIZ = join(new URL(".", import.meta.url).pathname, "..");
const SKILL = readFileSync(join(RAIZ, "skills", NOMBRE_SKILL, "SKILL.md"), "utf8");

describe("el SKILL.md empaquetado", () => {
  it("lleva frontmatter con name y description (lo que Claude Code usa para activar)", () => {
    const fm = SKILL.match(/^---\n([\s\S]*?)\n---/);
    expect(fm, "frontmatter YAML").toBeTruthy();
    expect(fm![1]).toMatch(/^name: savings-mode$/m);
    expect(fm![1]).toMatch(/^description: .{40,}/m);
    // La descripción decide la activación: tiene que hablar de límites/cuota.
    expect(fm![1]).toMatch(/limit|quota/i);
    // claude.ai rechaza descripciones de más de 200 caracteres al subir el
    // zip (Claude Code no protesta, y por eso este límite necesita verja: el
    // mismo SKILL.md sirve a las dos superficies).
    const desc = fm![1]!.match(/^description: (.*)$/m)![1]!;
    expect(desc.length).toBeLessThanOrEqual(200);
  });

  it("es MAGRO: el cuerpo entero cabe en poco más de dos mil caracteres", () => {
    // Un skill se inyecta en el contexto cada vez que se usa. El argumento de
    // venta es que ahorra: su propio peso es parte del producto.
    expect(SKILL.length).toBeLessThan(2600);
  });

  it("jamás vende cifras sin medir: la única cifra del cuerpo es la del corpus medido", () => {
    // ~12 % (salida como fracción del dinero) sale del corpus real del
    // medidor. Ninguna promesa de «ahorra X %» del propio skill: eso se mide.
    expect(SKILL).toMatch(/measured/i);
    expect(SKILL).not.toMatch(/save[sd]? (up to )?\d+\s*%/i);
  });

  it("la calidad no se negocia: la sección existe y cierra el fichero", () => {
    expect(SKILL).toMatch(/## Never trade away/);
    expect(SKILL).toMatch(/Correctness, tests, and safety checks are never skipped/);
  });

  it("viaja en el paquete npm (files incluye skills/)", () => {
    const pkg = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("skills");
  });
});

function fsFalso(inicial: Record<string, string> = {}): FsDeSkill & { disco: Record<string, string> } {
  const disco: Record<string, string> = { ...inicial };
  return {
    disco,
    existe: (r) => r in disco,
    leer: (r) => {
      const v = disco[r];
      if (v === undefined) throw new Error(`ENOENT: ${r}`);
      return v;
    },
    escribir: (r, c) => {
      disco[r] = c;
    },
    crearDir: () => {},
  };
}

const ORIGEN = join("/paquete", "skills", NOMBRE_SKILL, "SKILL.md");

describe("instalarSkill — pura sobre un FS inyectado", () => {
  it("instala en ~/.claude/skills por defecto y en .claude/skills con --proyecto", () => {
    for (const [proyecto, esperado] of [
      [false, join("/home/u", ".claude", "skills", NOMBRE_SKILL, "SKILL.md")],
      [true, join("/repo", ".claude", "skills", NOMBRE_SKILL, "SKILL.md")],
    ] as const) {
      const fs = fsFalso({ [ORIGEN]: "contenido" });
      const r = instalarSkill({ origenes: ["/paquete"], home: "/home/u", cwd: "/repo", proyecto, forzar: false, fs });
      expect(r.ok).toBe(true);
      expect(r.destino).toBe(esperado);
      expect(fs.disco[esperado]).toBe("contenido");
    }
  });

  it("prueba las raíces en orden (dist/npm y repo difieren)", () => {
    const enSegunda = join("/b", "skills", NOMBRE_SKILL, "SKILL.md");
    const fs = fsFalso({ [enSegunda]: "x" });
    expect(origenDelSkill(["/a", "/b"], fs)).toBe(enSegunda);
    expect(origenDelSkill(["/a"], fs)).toBeNull();
  });

  it("⛔ una instalación local MODIFICADA no se pisa sin --forzar", () => {
    const destino = join("/home/u", ".claude", "skills", NOMBRE_SKILL, "SKILL.md");
    const fs = fsFalso({ [ORIGEN]: "nuevo", [destino]: "editado a mano" });
    const r = instalarSkill({ origenes: ["/paquete"], home: "/home/u", cwd: "/repo", proyecto: false, forzar: false, fs });
    expect(r.ok).toBe(false);
    expect(fs.disco[destino]).toBe("editado a mano");
    expect(r.mensaje).toContain("--force");
    // Con --forzar sí.
    const r2 = instalarSkill({ origenes: ["/paquete"], home: "/home/u", cwd: "/repo", proyecto: false, forzar: true, fs });
    expect(r2.ok).toBe(true);
    expect(fs.disco[destino]).toBe("nuevo");
  });

  it("reinstalar sin cambios es idempotente y ok", () => {
    const destino = join("/home/u", ".claude", "skills", NOMBRE_SKILL, "SKILL.md");
    const fs = fsFalso({ [ORIGEN]: "igual", [destino]: "igual" });
    const r = instalarSkill({ origenes: ["/paquete"], home: "/home/u", cwd: "/repo", proyecto: false, forzar: false, fs });
    expect(r.ok).toBe(true);
    expect(r.mensaje).toContain("up to date");
  });

  it("sin SKILL.md empaquetado: error claro, nunca un skill vacío", () => {
    const fs = fsFalso();
    const r = instalarSkill({ origenes: ["/paquete"], home: "/home/u", cwd: "/repo", proyecto: false, forzar: false, fs });
    expect(r.ok).toBe(false);
    expect(Object.keys(fs.disco)).toEqual([]);
  });
});
