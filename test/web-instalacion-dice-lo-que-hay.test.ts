import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { decidirArranque } from "../gateway/argumentos.js";
import { doctor } from "../gateway/doctor.js";
import { TERMINALES_CON_ENVOLTORIO } from "../gateway/envoltorios.js";

/**
 * LA WEB DE INSTALACIÓN ANUNCIA SOLO LO QUE EL PAQUETE PUBLICADO HACE.
 *
 * Desde la 0.4.26 el panel de instalación (y la portada) recomiendan
 * `npx @bivelio/savings-layer@latest init`, listan los agentes de código con
 * envoltorio, dicen qué no se puede medir (Cursor) o todavía no (Gemini CLI) y
 * dan una nota para el cliente de Python. Cada una de esas frases depende de
 * algo que vive FUERA de la web —el binario, el doctor, el README de
 * packages/python— y ahí deriva en silencio: un envoltorio que se renombra, una
 * receta que desaparece del doctor o un `pip install` que cambia dejan la web
 * prometiendo en 12 idiomas un comando que sale con exit 1.
 *
 * Esta verja ata cada frase a su fuente. No compara traducciones (eso es
 * `apps/web/messages/parity.test.ts`): solo lo que no se traduce —comandos,
 * nombres de producto, versiones— y que por eso tiene que estar igual en todos.
 */

const RAIZ = new URL("..", import.meta.url).pathname;
const MENSAJES = join(RAIZ, "apps/web/messages");
const PANEL = readFileSync(
  join(RAIZ, "apps/web/app/[locale]/dashboard/components/InstallLicensePanel.tsx"),
  "utf8",
);

type Mensajes = {
  dashboard: {
    installLicensePanel: Record<string, string>;
  };
  landing: { integrate: { initNote: string }; gateway: { note: string } };
};

const LOCALES = readdirSync(MENSAJES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();

const cargar = (loc: string): Mensajes =>
  JSON.parse(readFileSync(join(MENSAJES, `${loc}.json`), "utf8")) as Mensajes;

describe("panel de instalación: los comandos existen en el binario", () => {
  it("vigila los 12 idiomas (si falta uno, esta verja no protege nada)", () => {
    expect(LOCALES).toEqual(["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"]);
  });

  it("la vía recomendada es `init` con @latest, y `init` es un comando del binario", () => {
    expect(PANEL).toContain('const INIT = "npx @bivelio/savings-layer@latest init";');
    expect(decidirArranque(["init"])).toEqual({ tipo: "arrancar", comando: "init", resto: [] });
    // `npx <paquete> init` ejecuta el ÚNICO bin del paquete: con dos, npx
    // buscaría uno llamado como el paquete sin scope y fallaría.
    const pkg = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as { bin: Record<string, string> };
    expect(Object.keys(pkg.bin)).toEqual(["bvsala"]);
  });

  it("la lista de agentes del panel es exactamente la de envoltorios del binario, en su orden", () => {
    const bloque = PANEL.match(/const AGENTES[^=]*=\s*\[([\s\S]*?)\n\];/);
    expect(bloque?.[1]).toBeDefined();
    const comandos = [...bloque![1]!.matchAll(/\["([a-z]+)",\s*"[^"]+"\]/g)].map((m) => m[1]);
    expect(comandos).toEqual([...TERMINALES_CON_ENVOLTORIO]);
  });

  it("la lista del panel no ofrece Cursor como envoltorio (va por la UI)", () => {
    const bloque = PANEL.match(/const AGENTES[^=]*=\s*\[([\s\S]*?)\n\];/)![1]!;
    expect(bloque).not.toMatch(/cursor/i);
  });
});

describe("panel de instalación: lo que dicen los textos, en los 12 idiomas", () => {
  const readmePython = readFileSync(join(RAIZ, "packages/python/README.md"), "utf8");
  const gatewayPython = readFileSync(join(RAIZ, "packages/python/src/bvsala/_gateway.py"), "utf8");

  it("la instalación de Python que se cita es la de PyPI que documenta packages/python", () => {
    // Esta nota se fusionó con el paquete ya servido por PyPI
    // (docs/PUBLICAR-PYPI.md): el nombre es el de pyproject y el README lo da.
    const pyproject = readFileSync(join(RAIZ, "packages/python/pyproject.toml"), "utf8");
    expect(/^name = "([^"]+)"$/m.exec(pyproject)?.[1]).toBe("bivelio-savings-layer");
    expect(readmePython).toContain("pip install bivelio-savings-layer");
    expect(readmePython).toContain("import bvsala");
    expect(readmePython).not.toMatch(/Until the first release on PyPI/);
  });

  it("el mínimo de gateway que cita la nota de Python es el que exige el cliente", () => {
    expect(gatewayPython).toContain("0.4.26 or later");
  });

  for (const loc of LOCALES) {
    describe(loc, () => {
      const m = cargar(loc);
      const p = m.dashboard.installLicensePanel;

      it("initNote: lee package.json y solo escribe con --write", () => {
        expect(p.initNote).toContain("<code>package.json</code>");
        expect(p.initNote).toContain("<code>--write</code>");
      });

      it("agentsNote: Copilot con clave propia, el doctor para el resto, y Cursor y Gemini CLI dichos", () => {
        for (const nombre of [
          "<code>bvsala copilot</code>",
          "BYOK",
          "<code>bvsala doctor</code>",
          "Crush",
          "Droid",
          "Cline",
          "Continue",
          "VS Code",
          "Cursor",
          "Gemini CLI",
        ]) {
          expect(p.agentsNote, nombre).toContain(nombre);
        }
      });

      it("pythonNote: el comando exacto del README, el import y la versión mínima", () => {
        expect(p.pythonNote).toContain("<code>pip install bivelio-savings-layer</code>");
        expect(p.pythonNote).toContain("<code>import bvsala</code>");
        expect(p.pythonNote).toContain("0.4.26");
        expect(p.pythonNote).toContain("PyPI");
        // Ni la instalación desde un repositorio privado ni un nombre que no es el publicado.
        expect(p.pythonNote).not.toMatch(/packages\/python|pip install bvsala/);
      });

      it("portada: `init` en la sección de instalación y los agentes medibles en la nota del gateway", () => {
        expect(m.landing.integrate.initNote).toContain("<code>init</code>");
        for (const nombre of [
          "Codex CLI",
          "Goose",
          "Qwen Code",
          "opencode",
          "Kilo",
          "Aider",
          "GitHub Copilot CLI",
          "bvsala doctor",
          "Cursor",
          "Gemini CLI",
        ]) {
          expect(m.landing.gateway.note, nombre).toContain(nombre);
        }
      });
    });
  }
});

describe("lo que los textos atribuyen al doctor, el doctor lo hace", () => {
  it("Crush, Droid, Cline, Continue y Copilot en VS Code tienen receta; Cursor y Gemini CLI también la tienen ya", async () => {
    const { texto } = await doctor(8402, { home: "/casa/prueba", path: "", existe: () => false, enPath: () => false });
    const seccion = (id: string): string => {
      const s = texto.split(/^» /m).find((t) => t.startsWith(`${id}:`));
      if (!s) throw new Error(`el doctor no tiene sección para ${id}`);
      return s;
    };
    for (const id of ["crush", "droid", "cline", "continue", "vscode-copilot"]) {
      expect(seccion(id), id).toContain("http://127.0.0.1:8402");
    }
    expect(seccion("cursor")).toContain("OpenAI API Base URL");
    expect(seccion("gemini")).toContain("bvsala gemini");
  });
});
