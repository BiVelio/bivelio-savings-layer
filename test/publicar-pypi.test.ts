import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * LA PUBLICACIÓN DEL CLIENTE DE PYTHON EN PyPI (publish-pypi.yml).
 *
 * El equivalente de test/cadena-de-suministro.test.ts para PyPI: el workflow
 * solo corre al cortar una Release `py-v*`, después de mergear, así que quitarle
 * el `id-token: write`, meterle un token o romper la verja de la versión se
 * descubriría publicando. Aquí se descubre en el PR.
 *
 * El YAML se lee como texto, sin parser, igual que allí: los bloques se cortan
 * por sangría, que es como los lee GitHub. Y los pasos de shell que se pueden
 * ejecutar fuera de GitHub se ejecutan TAL CUAL con bash.
 */

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const leer = (ruta: string) => readFileSync(join(RAIZ, ruta), "utf8");

const sinComentarios = (t: string) =>
  t
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

const pypi = sinComentarios(leer(".github/workflows/publish-pypi.yml"));
const npm = sinComentarios(leer(".github/workflows/publish.yml"));
const ci = sinComentarios(leer(".github/workflows/ci.yml"));

function trabajo(workflow: string, nombre: string): string {
  const lineas = workflow.split("\n");
  const inicio = lineas.findIndex((l) => l === `  ${nombre}:`);
  if (inicio < 0) throw new Error(`no hay un trabajo '${nombre}'`);
  let fin = lineas.length;
  for (let i = inicio + 1; i < lineas.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lineas[i]!) || /^\S/.test(lineas[i]!)) {
      fin = i;
      break;
    }
  }
  return lineas.slice(inicio, fin).join("\n");
}

function paso(bloque: string, nombre: string): string {
  const p = bloque.split(/\n(?= {6}- )/).slice(1).find((s) => new RegExp(`name: [^\\n]*${nombre}`).test(s));
  if (!p) throw new Error(`no hay un paso '${nombre}'`);
  return p;
}

function scriptDe(p: string): string {
  const i = p.indexOf("run: |\n");
  if (i < 0) throw new Error("el paso no tiene un `run: |`");
  const lineas = p.slice(i + "run: |\n".length).split("\n");
  const sangria = /^ */.exec(lineas[0]!)![0].length;
  return lineas.map((l) => l.slice(sangria)).join("\n");
}

/** Ejecuta un script de paso con `bash -e`, como GitHub Actions en Linux. */
function ejecutar(script: string, cwd: string, env: Record<string, string>): { ok: boolean; salida: string } {
  const r = spawnSync("bash", ["-e", "-c", script], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { ok: r.status === 0, salida: `${r.stdout}${r.stderr}` };
}

const construir = trabajo(pypi, "construir");
const publicar = trabajo(pypi, "publicar");
const pruebas = trabajo(pypi, "pruebas");

describe("publish-pypi.yml publica con trusted publishing", () => {
  it("solo las Release `py-v*`, y publish.yml (npm) las salta", () => {
    expect(pypi).toMatch(/^on:\n {2}release:\n {4}types: \[published\]$/m);
    expect(pruebas).toMatch(/^ {4}if: \$\{\{ startsWith\(github\.event\.release\.tag_name, 'py-v'\) \}\}$/m);
    expect(construir).toMatch(/needs: pruebas/);
    expect(publicar).toMatch(/needs: construir/);
    // Sin este salto, `py-v0.1.0` lanzaría también la cadena de npm.
    expect(trabajo(npm, "verificar")).toMatch(/^ {4}if: \$\{\{ !startsWith\(github\.event\.release\.tag_name, 'py-v'\) && !startsWith\(github\.event\.release\.tag_name, 'pg-v'\) \}\}$/m);
  });

  it("solo el trabajo que publica pide `id-token: write`, y nada por defecto", () => {
    expect(pypi).toMatch(/^permissions: \{\}$/m);
    expect([...pypi.matchAll(/id-token:\s*write/g)]).toHaveLength(1);
    expect(publicar).toMatch(/^ {4}permissions:\n {6}id-token: write$/m);
    expect(construir).not.toMatch(/id-token/);
    expect(pruebas).not.toMatch(/id-token/);
  });

  it("el trabajo que publica no hace checkout ni instala nada: solo dos acciones", () => {
    expect(publicar).not.toMatch(/actions\/checkout|pip install|\bpip\b|setup-python|npm|pnpm|uv /);
    const acciones = [...publicar.matchAll(/uses: ([^\s@]+)@(\S+)/g)].map((m) => `${m[1]}@${m[2]}`);
    expect(acciones.sort()).toEqual(["actions/download-artifact@v4", "pypa/gh-action-pypi-publish@release/v1"]);
  });

  it("atado al entorno `pypi` que se configura en pypi.org", () => {
    expect(publicar).toMatch(/^ {4}environment:\n {6}name: pypi$/m);
  });

  it("ningún token guardado: ni password ni secrets en el workflow", () => {
    // Con un token a mano, un fallo de OIDC no se notaría: la acción caería a él.
    expect(pypi).not.toMatch(/password:|PYPI_TOKEN|PYPI_API_TOKEN|secrets\./);
  });

  it("atestaciones PEP 740 solo con el repositorio público, como la provenance de npm", () => {
    const p = paso(publicar, "Publicar en PyPI");
    expect(p).toMatch(/packages-dir: paquete-py\//);
    expect(p).toMatch(/attestations: \$\{\{ github\.event\.repository\.private == false \}\}/);
  });

  it("sube lo verificado: el hash viaja como SALIDA de `construir` y `publicar` lo compara", () => {
    expect(construir).toMatch(/^ {4}outputs:\n {6}sha256: \$\{\{ steps\.hash\.outputs\.sha256 \}\}$/m);
    const llega = paso(publicar, "Los archivos son los verificados");
    expect(llega).toMatch(/SHA256_VERIFICADO: \$\{\{ needs\.construir\.outputs\.sha256 \}\}/);
    // El hash se calcula igual en los dos trabajos.
    const calculo = /H="\$\(cd paquete-py && [^\n]+\)"/;
    expect(calculo.exec(scriptDe(paso(construir, "Hash de los archivos verificados")))?.[0]).toBe(calculo.exec(scriptDe(llega))?.[0]);
    expect(publicar.indexOf("Los archivos son los verificados")).toBeLessThan(publicar.indexOf("pypa/gh-action-pypi-publish"));
  });
});

describe("publish-pypi.yml conserva las verjas de antes de publicar", () => {
  it("pytest con las mismas dependencias fijadas por hash que ci.yml, y en las mismas versiones", () => {
    const pip = /run: '(python -m pip install --require-hashes [^']+requirements-ci\.txt)'/.exec(ci);
    expect(pip).not.toBeNull();
    expect(pruebas).toContain(pip![1]!);
    expect(pruebas).toMatch(/python -m pytest packages\/python/);
    const matriz = (w: string) => /python-version: (\[[^\]]+\])/.exec(w)?.[1];
    expect(matriz(pruebas)).toBe(matriz(trabajo(ci, "python")));
  });

  it("construye con herramientas fijadas por hash y sin aislamiento (el backend también por hash)", () => {
    expect(construir).toContain(
      "python -m pip install --require-hashes --only-binary :all: -r packages/python/requirements-publicar.txt",
    );
    expect(construir).toMatch(/python -m build --no-isolation packages\/python/);
    const req = leer("packages/python/requirements-publicar.txt");
    for (const p of ["build", "twine", "hatchling"]) expect(req).toMatch(new RegExp(`^${p}==[\\d.]+ \\\\$`, "m"));
    // El backend fijado es el que pyproject admite.
    const minimo = /requires = \["hatchling>=([\d.]+)"\]/.exec(leer("packages/python/pyproject.toml"))?.[1];
    const fijado = /^hatchling==([\d.]+)/m.exec(req)?.[1];
    expect(minimo).toBeDefined();
    const n = (v: string) => v.split(".").map(Number);
    const [a, b] = [n(fijado!), n(minimo!)];
    expect(a[0]! > b[0]! || (a[0] === b[0] && (a[1] ?? 0) >= (b[1] ?? 0))).toBe(true);
  });

  it("el orden: etiqueta, README, build, twine, contenido, instalación, hash y artefacto", () => {
    const orden = [
      "La etiqueta coincide con la versión del paquete",
      "El README anuncia la instalación desde PyPI",
      "python -m build",
      "twine check --strict",
      "Los archivos llevan lo que deben",
      "El wheel se instala e importa",
      "Hash de los archivos verificados",
      "actions/upload-artifact",
    ].map((c) => construir.indexOf(c));
    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
  });

  it("los archivos: LICENSE (Apache-2.0), sin dependencias y sin clave privada (la misma búsqueda que npm)", () => {
    const p = paso(construir, "Los archivos llevan lo que deben");
    expect(p).toMatch(/cmp -s LICENSE/);
    expect(p).toMatch(/License-Expression: Apache-2.0/);
    expect(p).toMatch(/\^Requires-Dist:/);
    const privadaPy = /grep -rqaE "([^"]+)" "\$DIR"/.exec(p)?.[1];
    const privadaNpm = /grep -rqaE "([^"]+)" "\$DIR\/package"/.exec(npm)?.[1];
    expect(privadaPy).toBeDefined();
    expect(privadaPy).toBe(privadaNpm);
    const comprobaciones = p.match(/^\s*if /gm)?.length ?? 0;
    expect(comprobaciones).toBeGreaterThanOrEqual(5);
    expect(p.match(/exit 1/g)?.length).toBe(comprobaciones);
  });

  it("el pyproject declara lo que la verja comprueba", () => {
    const py = leer("packages/python/pyproject.toml");
    expect(py).toMatch(/^name = "bivelio-savings-layer"$/m);
    expect(py).toMatch(/^license = "Apache-2.0"$/m);
    expect(py).toMatch(/^dynamic = \["version"\]$/m);
    expect(py).toMatch(/^\[tool\.hatch\.version\]\npath = "src\/bvsala\/__init__\.py"$/m);
    expect(py).toMatch(/^requires-python = ">=3\.10"$/m);
    // PEP 639: con una expresión de licencia, PyPI rechaza los clasificadores «License ::».
    expect(py).not.toMatch(/"License ::/);
  });
});

describe("los pasos de shell, ejecutados", () => {
  const VERSION = /^__version__ = "([^"]+)"$/m.exec(leer("packages/python/src/bvsala/__init__.py"))![1]!;

  function arbol(): string {
    const dir = mkdtempSync(join(tmpdir(), "bvsala-pypi-"));
    mkdirSync(join(dir, "packages/python/src/bvsala"), { recursive: true });
    writeFileSync(join(dir, "packages/python/src/bvsala/__init__.py"), leer("packages/python/src/bvsala/__init__.py"));
    writeFileSync(join(dir, "packages/python/README.md"), leer("packages/python/README.md"));
    return dir;
  }

  it("la etiqueta: pasa `py-v<versión>`, y rechaza otra versión o una etiqueta de npm", () => {
    const script = scriptDe(paso(construir, "La etiqueta coincide con la versión del paquete"));
    const dir = arbol();
    try {
      const bien = ejecutar(script, dir, { GITHUB_REF_NAME: `py-v${VERSION}` });
      expect(bien.salida).toContain(`coinciden en ${VERSION}`);
      expect(bien.ok).toBe(true);
      for (const mala of [`py-v9.9.9`, `v${VERSION}`, VERSION]) {
        const r = ejecutar(script, dir, { GITHUB_REF_NAME: mala });
        expect(r.ok, mala).toBe(false);
        expect(r.salida).toContain("::error::");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("el README: pasa el de hoy y rechaza uno que diga que aún no está en PyPI", () => {
    const script = scriptDe(paso(construir, "El README anuncia la instalación desde PyPI"));
    const dir = arbol();
    try {
      expect(ejecutar(script, dir, {}).ok).toBe(true);
      writeFileSync(
        join(dir, "packages/python/README.md"),
        "Until the first release on PyPI, install from the repository:\n\npip install ./packages/python\n",
      );
      expect(ejecutar(script, dir, {}).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("el hash: `publicar` acepta lo que `construir` hasheó y rechaza un archivo cambiado", () => {
    const hash = scriptDe(paso(construir, "Hash de los archivos verificados"));
    const comprobar = scriptDe(paso(publicar, "Los archivos son los verificados"));
    const dir = mkdtempSync(join(tmpdir(), "bvsala-pypi-hash-"));
    try {
      mkdirSync(join(dir, "paquete-py"));
      writeFileSync(join(dir, "paquete-py", `bivelio_savings_layer-${VERSION}.tar.gz`), "sdist");
      writeFileSync(join(dir, "paquete-py", `bivelio_savings_layer-${VERSION}-py3-none-any.whl`), "wheel");
      const salida = join(dir, "salida");
      writeFileSync(salida, "");
      expect(ejecutar(hash, dir, { GITHUB_OUTPUT: salida }).ok).toBe(true);
      const sha = /^sha256=([0-9a-f]{64})$/m.exec(readFileSync(salida, "utf8"))?.[1];
      expect(sha).toBeDefined();
      expect(ejecutar(comprobar, dir, { SHA256_VERIFICADO: sha! }).ok).toBe(true);
      expect(ejecutar(comprobar, dir, { SHA256_VERIFICADO: "" }).ok).toBe(false);
      writeFileSync(join(dir, "paquete-py", `bivelio_savings_layer-${VERSION}-py3-none-any.whl`), "otro wheel");
      const r = ejecutar(comprobar, dir, { SHA256_VERIFICADO: sha! });
      expect(r.ok).toBe(false);
      expect(r.salida).toContain("no son los que se verificaron");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
