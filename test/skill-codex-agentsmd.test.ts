import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import {
  bloqueAgentsMd,
  instalarAgentsMd,
  MARCA_INICIO,
  MARCA_FIN,
  NOMBRE_SKILL,
  type FsDeSkill,
} from "../gateway/skill.js";

/**
 * La puerta Codex del skill: la disciplina viaja como BLOQUE MARCADO dentro
 * del AGENTS.md (Codex no tiene skills, y AGENTS.md va siempre activo). Los
 * invariantes que importan: una sola fuente (el bloque se genera del propio
 * SKILL.md), y NI UN BYTE del AGENTS.md del usuario fuera de las marcas se
 * toca jamás — ni al añadir, ni al actualizar, ni con --forzar.
 */

const RAIZ = join(new URL(".", import.meta.url).pathname, "..");
const SKILL = readFileSync(join(RAIZ, "skills", NOMBRE_SKILL, "SKILL.md"), "utf8");

describe("bloqueAgentsMd — generado del SKILL.md, una sola fuente", () => {
  const bloque = bloqueAgentsMd(SKILL);

  it("quita el frontmatter (AGENTS.md no lo entiende) y conserva el cuerpo", () => {
    expect(bloque).not.toContain("description:");
    expect(bloque).toContain("# Savings Mode");
    expect(bloque).toContain("## Never trade away");
  });

  it("abre y cierra con las marcas, y declara que va siempre activo", () => {
    expect(bloque.startsWith(MARCA_INICIO)).toBe(true);
    expect(bloque.endsWith(MARCA_FIN)).toBe(true);
    expect(bloque).toContain("Always on");
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
const DESTINO = join("/home/u", ".codex", "AGENTS.md");
const base = { origenes: ["/paquete"], home: "/home/u", cwd: "/repo", proyecto: false, forzar: false };

describe("instalarAgentsMd — el AGENTS.md del usuario es sagrado", () => {
  it("sin AGENTS.md previo: lo crea con el bloque", () => {
    const fs = fsFalso({ [ORIGEN]: SKILL });
    const r = instalarAgentsMd({ ...base, fs });
    expect(r.ok).toBe(true);
    expect(fs.disco[DESTINO]!.trim().startsWith(MARCA_INICIO)).toBe(true);
  });

  it("con --proyecto escribe ./AGENTS.md del directorio actual", () => {
    const fs = fsFalso({ [ORIGEN]: SKILL });
    const r = instalarAgentsMd({ ...base, proyecto: true, fs });
    expect(r.destino).toBe(join("/repo", "AGENTS.md"));
  });

  it("⛔ con AGENTS.md ajeno: AÑADE el bloque y no toca ni un byte de lo existente", () => {
    const previo = "# Mis reglas\n\nUsa siempre pnpm.\n";
    const fs = fsFalso({ [ORIGEN]: SKILL, [DESTINO]: previo });
    const r = instalarAgentsMd({ ...base, fs });
    expect(r.ok).toBe(true);
    expect(fs.disco[DESTINO]!.startsWith("# Mis reglas\n\nUsa siempre pnpm.")).toBe(true);
    expect(fs.disco[DESTINO]).toContain(MARCA_INICIO);
  });

  it("reinstalar es idempotente: el bloque al día no duplica ni reescribe", () => {
    const fs = fsFalso({ [ORIGEN]: SKILL });
    instalarAgentsMd({ ...base, fs });
    const tras1 = fs.disco[DESTINO];
    const r2 = instalarAgentsMd({ ...base, fs });
    expect(r2.ok).toBe(true);
    expect(r2.mensaje).toContain("al día");
    expect(fs.disco[DESTINO]).toBe(tras1);
  });

  it("⛔ un bloque EDITADO no se pisa sin --forzar; con --forzar se actualiza SOLO el bloque", () => {
    const previo = `# Mis reglas\n\n${MARCA_INICIO}\neditado a mano\n${MARCA_FIN}\n\n# Más reglas mías\n`;
    const fs = fsFalso({ [ORIGEN]: SKILL, [DESTINO]: previo });
    const r = instalarAgentsMd({ ...base, fs });
    expect(r.ok).toBe(false);
    expect(fs.disco[DESTINO]).toBe(previo);
    const r2 = instalarAgentsMd({ ...base, forzar: true, fs });
    expect(r2.ok).toBe(true);
    expect(fs.disco[DESTINO]!.startsWith("# Mis reglas\n\n")).toBe(true);
    expect(fs.disco[DESTINO]!.endsWith("\n\n# Más reglas mías\n")).toBe(true);
    expect(fs.disco[DESTINO]).toContain("# Savings Mode");
    expect(fs.disco[DESTINO]).not.toContain("editado a mano");
  });

  it("sin SKILL.md empaquetado: error claro, nada se escribe", () => {
    const fs = fsFalso();
    const r = instalarAgentsMd({ ...base, fs });
    expect(r.ok).toBe(false);
    expect(Object.keys(fs.disco)).toEqual([]);
  });
});
