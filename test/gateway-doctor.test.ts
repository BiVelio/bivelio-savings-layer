import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { doctor } from "../gateway/doctor.js";

const HOME = "/casa/prueba";
const PUERTO = 8402;

/** Un doctor sin sistema debajo: nada en PATH, ninguna config. */
function vacio(extra: Parameters<typeof doctor>[1] = {}) {
  return doctor(PUERTO, { home: HOME, path: "", existe: () => false, enPath: () => false, ...extra });
}

/** La sección del informe de un terminal (desde su cabecera `» id:` hasta la siguiente). */
function seccion(texto: string, id: string): string {
  const trozos = texto.split(/^» /m);
  const s = trozos.find((t) => t.startsWith(`${id}:`));
  if (!s) throw new Error(`sin sección para ${id}`);
  return s;
}

const IDS = ["claude", "codex", "opencode", "goose", "crush", "qwen", "droid", "cline", "kilo"];

describe("bvsala doctor — detección por existencia", () => {
  it("con nada instalado, nadie está detectado pero todos llevan receta", async () => {
    const { texto, detectados } = await vacio();
    expect(detectados).toEqual([]);
    for (const id of IDS) {
      const s = seccion(texto, id);
      expect(s).toMatch(/^(claude|codex|opencode|goose|crush|qwen|droid): not detected|^(cline|kilo): no automatic detection/);
    }
  });

  it("detecta por binario en PATH", async () => {
    const { texto, detectados } = await vacio({ enPath: (bin) => bin === "opencode" || bin === "goose" });
    expect(detectados).toEqual(["opencode", "goose"]);
    expect(seccion(texto, "opencode")).toContain("detected — binary `opencode` on PATH");
    expect(seccion(texto, "goose")).toContain("detected — binary `goose` on PATH");
    expect(seccion(texto, "crush")).toContain("not detected");
  });

  it("detecta por config de usuario, y solo imprime la ruta", async () => {
    const rutaQwen = join(HOME, ".qwen", "settings.json");
    const { texto, detectados } = await vacio({ existe: (r) => r === rutaQwen });
    expect(detectados).toEqual(["qwen"]);
    expect(seccion(texto, "qwen")).toContain(`config present: ${rutaQwen}`);
  });

  it("~/.codex/auth.json cuenta como detección de Codex y se declara como «solo existencia»", async () => {
    const rutaAuth = join(HOME, ".codex", "auth.json");
    const { texto, detectados } = await vacio({ existe: (r) => r === rutaAuth });
    expect(detectados).toEqual(["codex"]);
    const s = seccion(texto, "codex");
    expect(s).toContain(`config present: ${rutaAuth}`);
    expect(s).toContain(`${rutaAuth}: only checked for existence; never read.`);
  });

  it("el buscador por defecto recorre el PATH con `existe`, directorio a directorio, sin spawn", async () => {
    const sondeadas: string[] = [];
    const { detectados } = await doctor(PUERTO, {
      home: HOME,
      path: ["/usr/local/bin", "/opt/herramientas/bin"].join(process.platform === "win32" ? ";" : ":"),
      existe: (r) => {
        sondeadas.push(r);
        return r === join("/opt/herramientas/bin", "crush");
      },
    });
    expect(detectados).toEqual(["crush"]);
    expect(sondeadas).toContain(join("/usr/local/bin", "claude"));
    expect(sondeadas).toContain(join("/opt/herramientas/bin", "droid"));
    // Las extensiones de editor no tienen binario que buscar.
    expect(sondeadas.some((r) => r.endsWith("cline") || r.endsWith("kilo"))).toBe(false);
  });

  it("rechaza un puerto imposible", async () => {
    await expect(doctor(0, { home: HOME })).rejects.toThrow(RangeError);
    await expect(doctor(70000, { home: HOME })).rejects.toThrow(RangeError);
  });
});

describe("bvsala doctor — la forma exacta del base URL por terminal", () => {
  it("opencode, Crush, Cline y Kilo llevan /v1", async () => {
    const { texto } = await vacio();
    for (const id of ["opencode", "crush", "cline", "kilo"]) {
      expect(seccion(texto, id), id).toContain("http://127.0.0.1:8402/v1");
    }
  });

  it("Goose, Qwen Code y Droid van SIN /v1", async () => {
    const { texto } = await vacio();
    for (const id of ["goose", "qwen", "droid"]) {
      const s = seccion(texto, id);
      expect(s, id).toContain("http://127.0.0.1:8402");
      expect(s, id).not.toContain("8402/v1");
    }
  });

  it("cada terminal apunta al puerto que le pasan", async () => {
    const { texto } = await doctor(51234, { home: HOME, path: "", existe: () => false, enPath: () => false });
    expect(seccion(texto, "opencode")).toContain('"baseURL": "http://127.0.0.1:51234/v1"');
    expect(seccion(texto, "crush")).toContain("--base-url http://127.0.0.1:51234/v1 ");
    expect(seccion(texto, "goose")).toContain("ANTHROPIC_HOST=http://127.0.0.1:51234 ");
    expect(seccion(texto, "qwen")).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:51234 ");
    expect(seccion(texto, "droid")).toContain('"baseUrl": "http://127.0.0.1:51234"');
    expect(texto).not.toContain("8402");
  });

  it("ninguna URL del informe termina en barra ni encadena /v1/v1", async () => {
    const { texto } = await vacio();
    const urls = texto.match(/http:\/\/127\.0\.0\.1:8402[^\s"]*/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    // Solo tres formas legales, y ninguna acaba en barra.
    const legales = new Set([
      "http://127.0.0.1:8402",
      "http://127.0.0.1:8402/v1",
      "http://127.0.0.1:8402/backend-api/codex",
    ]);
    for (const u of urls) {
      expect(legales.has(u), u).toBe(true);
      expect(u.endsWith("/"), u).toBe(false);
    }
    expect(texto).not.toContain("http://127.0.0.1:8402/v1/v1");
  });

  it("Claude Code y Codex remiten a sus envoltorios", async () => {
    const { texto } = await vacio();
    expect(seccion(texto, "claude")).toContain("use `bvsala claude`");
    expect(seccion(texto, "codex")).toContain("use `bvsala codex`");
  });

  it("todas las secciones llevan la línea de comprobación contra el log del gateway", async () => {
    const { texto } = await vacio();
    for (const id of IDS) {
      const s = seccion(texto, id);
      expect(s, id).toContain("check: the gateway log must show `[gateway] POST /v1/messages …`");
      expect(s, id).toContain("if you see `/v1/v1/messages`, there is one /v1 too many");
    }
  });

  it("cierra con la regla BYOK y el puntero a docs/terminales/", async () => {
    const { texto } = await vacio();
    expect(texto).toContain("BYOK rule");
    expect(texto).toContain("API key");
    expect(texto).toMatch(/OAuth of a Claude Pro\/Max subscription/);
    expect(texto).toContain("docs/terminales/");
  });
});

describe("bvsala doctor — jamás contenido, solo rutas", () => {
  it("aunque todo exista, el informe no lleva nada que no sea una ruta", async () => {
    // `existe` responde que sí a todo: el doctor debe listar rutas y nada más.
    const { texto, detectados } = await doctor(PUERTO, {
      home: HOME,
      path: "/bin",
      existe: () => true,
    });
    expect(detectados).toEqual(["claude", "codex", "opencode", "goose", "crush", "qwen", "droid"]);
    for (const ruta of [
      join(HOME, ".config", "opencode", "opencode.json"),
      join(HOME, ".config", "goose", "config.yaml"),
      join(HOME, ".config", "crush", "crushrc"),
      join(HOME, ".qwen", "settings.json"),
      join(HOME, ".factory", "settings.json"),
      join(HOME, ".codex", "config.toml"),
      join(HOME, ".codex", "auth.json"),
    ]) {
      expect(texto).toContain(ruta);
    }
    // Nada con pinta de credencial: ni prefijos de clave seguidos de material, ni un Bearer con token.
    expect(texto).not.toMatch(/sk-ant-[A-Za-z0-9_-]+|bvk_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]{20,}/);
  });

  it("el módulo solo importa `existsSync` de node:fs, y nada de procesos", () => {
    const fuente = readFileSync(
      fileURLToPath(new URL("../gateway/doctor.ts", import.meta.url)),
      "utf8",
    );
    const imports = [...fuente.matchAll(/^import\s+(.+?)\s+from\s+"([^"]+)";$/gm)].map((m) => [m[1], m[2]]);
    expect(imports).toEqual([
      ["{ existsSync }", "node:fs"],
      ["{ homedir }", "node:os"],
      ["{ delimiter, join }", "node:path"],
    ]);
    expect(fuente).not.toMatch(/node:child_process|node:fs\/promises/);
  });
});
