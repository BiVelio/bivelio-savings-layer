import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";

import { construirSbom, generarSbom, paqueteDeRuta, purlNpm } from "../scripts/sbom.js";

/**
 * LA CADENA DE SUMINISTRO (recomendación n.º 7 del informe de competencia del
 * 2026-09-26): publicar desde CI con npm trusted publishing, provenance cuando
 * el repositorio lo permita y un SBOM del tarball en cada Release.
 *
 * Por qué una verja y no solo el workflow: `publish.yml` corre al cortar una
 * Release, que es DESPUÉS de mergear. Quitarle el `id-token: write` o el
 * `--provenance` compila, pasa ci.yml y se descubre publicando —o no se
 * descubre nunca, si el flag se va y la Release sale verde sin provenance—.
 * Aquí se descubre en el PR.
 *
 * El YAML se lee como texto, sin parser: no hay ninguno entre las dependencias
 * y añadir uno para esto sería una dependencia nueva. Por eso los bloques se
 * cortan por sangría, que es exactamente como los lee GitHub.
 */

const leer = (ruta: string) => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), "utf8");
const RAIZ = fileURLToPath(new URL("..", import.meta.url));

const workflow = leer("../.github/workflows/publish.yml");

/** Quita los comentarios YAML de línea entera: las verjas miran lo que se ejecuta. */
const sinComentarios = (t: string) =>
  t
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/** El bloque de un trabajo: desde `  <nombre>:` hasta el siguiente trabajo. */
function trabajo(nombre: string): string {
  const lineas = sinComentarios(workflow).split("\n");
  const inicio = lineas.findIndex((l) => l === `  ${nombre}:`);
  if (inicio < 0) throw new Error(`publish.yml no tiene el trabajo '${nombre}'`);
  let fin = lineas.length;
  for (let i = inicio + 1; i < lineas.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lineas[i]!) || /^\S/.test(lineas[i]!)) {
      fin = i;
      break;
    }
  }
  return lineas.slice(inicio, fin).join("\n");
}

/** Los pasos de un trabajo, cada uno como texto. */
function pasos(bloque: string): string[] {
  return bloque.split(/\n(?= {6}- )/).slice(1);
}

/** El paso cuyo `name:` contiene el texto dado. */
function paso(bloque: string, nombre: string): string {
  const p = pasos(bloque).find((s) => new RegExp(`name: [^\\n]*${nombre}`).test(s));
  if (!p) throw new Error(`no hay un paso '${nombre}'`);
  return p;
}

describe("publish.yml publica con trusted publishing y provenance", () => {
  const publicar = trabajo("publicar");

  it("el trabajo que publica pide `id-token: write`: sin él no hay OIDC ni trusted publishing", () => {
    expect(publicar).toMatch(/^ {4}permissions:\n(?: {6}.*\n)*? {6}id-token: write$/m);
  });

  it("publica con `--provenance --access public` cuando el repositorio es público", () => {
    const p = paso(publicar, "Publish to npm");
    // La condición sale del evento, no de una variable que alguien pueda fijar.
    expect(p).toMatch(/REPO_PRIVADO: \$\{\{ github\.event\.repository\.private \}\}/);
    const rama = /if \[ "\$REPO_PRIVADO" = "false" \]; then\n\s*(npm publish [^\n]*)\n\s*else/.exec(p);
    expect(rama, "falta la rama del repositorio público").not.toBeNull();
    expect(rama![1]).toMatch(/--provenance/);
    expect(rama![1]).toMatch(/--access public/);
    // Por ruta: sube exactamente el tarball verificado, no un build nuevo.
    expect(rama![1]).toMatch(/^npm publish "\$TGZ"/);
  });

  it("sin provenance SOLO en la rama del repositorio privado, y avisando", () => {
    const p = paso(publicar, "Publish to npm");
    const publicaciones = [...p.matchAll(/npm publish [^\n]*/g)].map((m) => m[0]);
    expect(publicaciones).toHaveLength(2);
    const sinFlag = publicaciones.filter((c) => !c.includes("--provenance"));
    expect(sinFlag).toHaveLength(1);
    const privada = /else\n([\s\S]*?)\n\s*fi/.exec(p)?.[1] ?? "";
    expect(privada).toContain(sinFlag[0]!);
    expect(privada).toMatch(/::warning[^\n]*provenance/);
  });

  it("si el repo es público, comprueba en el registro que la provenance quedó puesta", () => {
    const p = paso(publicar, "El registro sirve el tarball verificado");
    expect(p).toMatch(/dist\.integrity/);
    expect(p).toMatch(/dist\.attestations\.provenance\.predicateType/);
  });

  it("ningún token guardado: ni NPM_TOKEN ni NODE_AUTH_TOKEN en publish.yml", () => {
    // Con un token a mano, un fallo de OIDC no se notaría: npm caería al token
    // y volvería el EOTP. Los comentarios pueden contar la historia; lo que se
    // ejecuta, no puede llevarlo.
    expect(sinComentarios(workflow)).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  it("requisitos de npm: runner de GitHub, Node >= 22.14 y npm >= 11.5.1", () => {
    expect(publicar).toMatch(/runs-on: ubuntu-latest/);
    const node = /node-version: (\d+)(?:\.(\d+))?/.exec(publicar);
    expect(node).not.toBeNull();
    const [mayor, menor] = [Number(node![1]), Number(node![2] ?? 0)];
    // Un «22» a secas no vale: sería la 22.x que toque, y solo desde la 22.14 funciona.
    expect(mayor > 22 || (mayor === 22 && menor >= 14)).toBe(true);
    const npm = paso(publicar, "trusted publishing \\(>= 11.5.1\\)");
    expect(npm).toMatch(/b===5&&c>=1/);
    // Y la comprobación MANDA: si tras instalar sigue por debajo, el paso falla.
    expect(npm).toMatch(/^\s*admite \|\| \{[^\n]*exit 1; \}$/m);
  });

  it("solo el trabajo que publica puede pedir un token OIDC, y no ejecuta código de terceros", () => {
    const todos = [...sinComentarios(workflow).matchAll(/id-token:\s*write/g)];
    expect(todos).toHaveLength(1);
    expect(sinComentarios(workflow)).toMatch(/^permissions: \{\}$/m);
    // Ni instala dependencias ni hace checkout: con `id-token: write`, un
    // script de instalación de un tercero podría publicar en nuestro nombre.
    expect(publicar).not.toMatch(/pnpm|npm ci|actions\/checkout/);
    const instalaciones = [...publicar.matchAll(/npm install[^\n]*/g)].map((m) => m[0]);
    expect(instalaciones.every((i) => /^npm install -g npm@\d+$/.test(i.trim()))).toBe(true);
    expect(publicar).toMatch(/needs: verificar/);
  });

  it("el trabajo que publica está atado al entorno `npm` que se configura en npmjs.com", () => {
    expect(publicar).toMatch(/^ {4}environment: npm$/m);
  });
});

describe("publish.yml conserva las verjas de antes de publicar", () => {
  const verificar = trabajo("verificar");

  it("construye, typechequea y prueba antes de empaquetar", () => {
    const orden = ["pnpm run build:all", "pnpm run typecheck:all", "pnpm test", "npm pack"].map((c) =>
      verificar.indexOf(c),
    );
    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
  });

  it("la etiqueta coincide con package.json", () => {
    const p = paso(verificar, "La etiqueta coincide con package.json");
    expect(p).toMatch(/ETIQUETA="\$\{GITHUB_REF_NAME#v\}"/);
    expect(p).toMatch(/require\('\.\/package\.json'\)\.version/);
    expect(p).toMatch(/exit 1/);
  });

  it("el tarball: paywall cerrado, sin sourcemaps y con la clave pública en el SDK y en el gateway", () => {
    const p = paso(verificar, "El paquete no regala el producto");
    expect(p).toMatch(/grep -q "BVSALA_DEV_OPEN" "\$DIR\/package\/dist\/index\.js"/);
    expect(p).toMatch(/-name "\*\.map"/);
    expect(p).toMatch(/grep -q "BEGIN PUBLIC KEY" "\$DIR\/package\/dist\/index\.js"/);
    expect(p).toMatch(/grep -q "BEGIN PUBLIC KEY" "\$DIR\/package\/dist\/gateway\/bin\.js"/);
    expect(p.match(/exit 1/g)?.length).toBe(4);
  });

  it("genera el SBOM del MISMO tarball y lo entrega al trabajo que publica", () => {
    expect(paso(verificar, "SBOM CycloneDX del tarball")).toMatch(/scripts\/sbom\.ts "paquete\/[^"]*\.tgz" "paquete\/[^"]*\.cdx\.json"/);
    expect(verificar).toMatch(/actions\/upload-artifact@v4/);
    expect(verificar).not.toMatch(/id-token/);
    // Y el que publica comprueba que le llegó ese tarball y no otro.
    expect(paso(trabajo("publicar"), "El tarball es el verificado")).toMatch(/SHA-512/);
  });

  it("el SBOM se adjunta a la Release, solo si la versión llegó a publicarse", () => {
    const sbom = trabajo("sbom");
    expect(sbom).toMatch(/needs: publicar/);
    expect(sbom).toMatch(/if: \$\{\{ always\(\) && needs\.publicar\.outputs\.publicado == 'true' \}\}/);
    // Y `publicado` solo se escribe DESPUÉS de las dos llamadas a npm publish.
    const pub = paso(trabajo("publicar"), "Publish to npm");
    expect(pub.lastIndexOf("npm publish")).toBeLessThan(pub.indexOf('echo "publicado=true" >> "$GITHUB_OUTPUT"'));
    expect(sbom).toMatch(/contents: write/);
    expect(sbom).toMatch(/gh release upload "\$GITHUB_REF_NAME" "paquete\/[^"]*\.cdx\.json"/);
  });
});

describe("package.json cumple lo que el trusted publishing exige", () => {
  it("repository.url apunta EXACTAMENTE a este repositorio (npm lo compara, con mayúsculas)", () => {
    const pkg = JSON.parse(leer("../package.json")) as { repository?: { type?: string; url?: string } };
    expect(pkg.repository?.type).toBe("git");
    expect(pkg.repository?.url).toBe("git+https://github.com/BiVelio/bivelio-savings-layer.git");
  });
});

describe("el SBOM describe lo que viaja", () => {
  it("purl de npm con scope codificado", () => {
    expect(purlNpm("@noble/curves", "2.2.0")).toBe("pkg:npm/%40noble/curves@2.2.0");
    expect(purlNpm("gpt-tokenizer")).toBe("pkg:npm/gpt-tokenizer");
  });

  it("el paquete de un fichero de node_modules, en layout de npm y de pnpm", () => {
    expect(paqueteDeRuta("node_modules/.pnpm/@noble+curves@2.2.0/node_modules/@noble/curves/abstract/edwards.js")?.name).toBe(
      "@noble/curves",
    );
    expect(paqueteDeRuta("node_modules/tslib/tslib.es6.js")?.name).toBe("tslib");
    expect(paqueteDeRuta("src/index.ts")).toBeNull();
  });

  it("CycloneDX 1.5: el tarball con sus hashes, lo empaquetado como required y el peer como optional", () => {
    const sbom = construirSbom({
      paquete: { name: "@bivelio/savings-layer", version: "9.9.9", license: "SEE LICENSE IN LICENSE" },
      tarball: { sha512Hex: "a".repeat(128), sha256Hex: "b".repeat(64) },
      componentes: [
        { name: "gpt-tokenizer", inclusion: "optional-peer", range: "^3" },
        { name: "@noble/curves", version: "2.2.0", license: "MIT", inclusion: "bundled" },
      ],
      timestamp: "2026-09-27T00:00:00.000Z",
      serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000000",
    }) as {
      bomFormat: string;
      specVersion: string;
      metadata: { component: { purl: string; hashes: { alg: string; content: string }[]; licenses: unknown[] } };
      components: { name: string; scope: string; version?: string; licenses?: unknown[] }[];
      dependencies: { ref: string; dependsOn: string[] }[];
    };
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.5");
    expect(sbom.metadata.component.purl).toBe("pkg:npm/%40bivelio/savings-layer@9.9.9");
    expect(sbom.metadata.component.hashes.map((h) => h.alg)).toEqual(["SHA-512", "SHA-256"]);
    expect(sbom.metadata.component.licenses).toEqual([{ license: { name: "SEE LICENSE IN LICENSE" } }]);
    expect(sbom.components.map((c) => [c.name, c.scope])).toEqual([
      ["curves", "required"],
      ["gpt-tokenizer", "optional"],
    ]);
    expect(sbom.components[0]!.licenses).toEqual([{ expression: "MIT" }]);
    expect(sbom.components[1]!.version).toBeUndefined();
    expect(sbom.dependencies[0]!.dependsOn).toHaveLength(2);
  });

  describe("sobre el tarball de verdad", () => {
    // Como sala-limpia-del-tarball: `npm pack` sobre el dist/ construido. Sin
    // esto, el script solo se ejecutaría por primera vez al cortar una Release.
    let dir: string;
    let tgz: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "bvsala-sbom-test-"));
      execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: RAIZ, stdio: "pipe" });
      tgz = join(dir, readdirSync(dir).find((f) => f.endsWith(".tgz"))!);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("lista @noble/curves con la versión instalada y el hash del tarball", async () => {
      const sbom = (await generarSbom(tgz)) as {
        metadata: { component: { version: string; hashes: { alg: string; content: string }[] } };
        components: { group?: string; name: string; version?: string; scope: string }[];
      };
      const pkg = JSON.parse(leer("../package.json")) as { version: string };
      expect(sbom.metadata.component.version).toBe(pkg.version);
      const sha512 = createHash("sha512").update(readFileSync(tgz)).digest("hex");
      expect(sbom.metadata.component.hashes.find((h) => h.alg === "SHA-512")?.content).toBe(sha512);
      const curvas = sbom.components.find((c) => c.group === "@noble" && c.name === "curves");
      const instalada = JSON.parse(leer("../node_modules/@noble/curves/package.json")) as { version: string };
      expect(curvas).toMatchObject({ version: instalada.version, scope: "required" });
      // El peer opcional no viaja, pero se declara.
      expect(sbom.components.find((c) => c.name === "gpt-tokenizer")?.scope).toBe("optional");
      // Y nada de lo que solo construye o prueba.
      expect(sbom.components.map((c) => c.name)).not.toContain("tsup");
      expect(sbom.components.map((c) => c.name)).not.toContain("vitest");
    }, 60_000);

    it("un tarball cuyo bundle no es el del build actual NO obtiene SBOM", async () => {
      const otro = join(dir, "manipulado");
      mkdirSync(otro, { recursive: true });
      execFileSync("tar", ["xzf", tgz, "-C", otro]);
      appendFileSync(join(otro, "package", "dist", "index.js"), "\n// otro artefacto\n");
      const falso = join(dir, "manipulado.tgz");
      execFileSync("tar", ["czf", falso, "-C", otro, "package"]);
      await expect(generarSbom(falso)).rejects.toThrow(/describiría otro artefacto/);
    }, 60_000);
  });
});
