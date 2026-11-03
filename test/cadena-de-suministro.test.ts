import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";

import { construirSbom, generarSbom, licencias, paqueteDeRuta, purlNpm } from "../scripts/sbom.js";

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

/** El script de shell de un paso (`run: |`), sin la sangría del YAML. */
function scriptDe(p: string): string {
  const i = p.indexOf("run: |\n");
  if (i < 0) throw new Error("el paso no tiene un `run: |`");
  const lineas = p.slice(i + "run: |\n".length).split("\n");
  const sangria = /^ */.exec(lineas[0]!)![0].length;
  return lineas.map((l) => l.slice(sangria)).join("\n");
}

/** «PRIVATE KEY» en base64, en sus tres alineaciones: lo que la verja busca además del PEM. */
function privateKeyEnBase64(): string[] {
  const s = Buffer.from("PRIVATE KEY");
  return [0, 1, 2].map((k) => {
    const b = Buffer.concat([Buffer.alloc(k, 0x78), s]).toString("base64");
    return b.slice(Math.ceil((k * 8) / 6), Math.floor(((k + s.length) * 8) / 6));
  });
}

describe("publish.yml publica con trusted publishing y provenance", () => {
  const publicar = trabajo("publicar");

  it("el trabajo que publica pide `id-token: write`: sin él no hay OIDC ni trusted publishing", () => {
    expect(publicar).toMatch(/^ {4}permissions:\n(?: {6}.*\n)*? {6}id-token: write$/m);
  });

  it("la ruta del tarball empieza por ./ — sin ella, npm la lee como un repositorio de GitHub «usuario/repo»", () => {
    // La 0.4.25 falló así: `npm publish paquete/x.tgz` intentó un git ls-remote
    // contra github.com/paquete/x.tgz. Con `./` npm la trata como fichero local.
    const rutas = [...trabajo("publicar").matchAll(/TGZ="([^"]+)"/g)].map((m) => m[1]!);
    expect(rutas.length).toBeGreaterThan(0);
    for (const r of rutas) expect(r, r).toMatch(/^\.\//);
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

  it("una prerelease (`0.5.0-rc.1`) se publica en el dist-tag `next` y nunca mueve `latest`", () => {
    // npm 11 se niega a publicar una prerelease sin `--tag`. Una versión final
    // sale SIN `--tag`: npm la pone en `latest` y rechaza una versión menor que
    // la más alta, así que un `--tag latest` explícito sería peor (movería
    // `latest` hacia atrás con un arreglo de una línea vieja).
    const p = paso(publicar, "Publish to npm");
    const publicaciones = [...p.matchAll(/npm publish [^\n]*/g)].map((m) => m[0]);
    for (const c of publicaciones) expect(c, c).toMatch(/ \$\{ETIQUETA_NPM:\+--tag "\$ETIQUETA_NPM"\}$/);
    expect(p).not.toMatch(/--tag "?latest/);
    const caso = /case "\$\{GITHUB_REF_NAME#v\}" in\n\s*\*-\*\) ETIQUETA_NPM="next" ;;\n\s*\*\) ETIQUETA_NPM="" ;;\n\s*esac/.exec(p);
    expect(caso, "la etiqueta de npm no sale de la versión (sufijo → next, sin sufijo → sin --tag)").not.toBeNull();
    expect(p.indexOf("esac")).toBeLessThan(p.indexOf("npm publish"));
  });

  it("`verificar` exige que la Release sea prerelease si y solo si la versión lleva sufijo", () => {
    const p = paso(trabajo("verificar"), "La Release es prerelease si y solo si la versión lleva sufijo");
    expect(p).toMatch(/ES_PRERELEASE: \$\{\{ github\.event\.release\.prerelease \}\}/);
    expect(p).toMatch(/\*-\*\) CON_SUFIJO="true" ;;/);
    expect(p).toMatch(/if \[ "\$CON_SUFIJO" != "\$ES_PRERELEASE" \]; then[\s\S]*?exit 1/);
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

  it("requisitos de npm: runner de GitHub, Node >= 22.14 y npm >= 11.5.1 (comprobado, no instalado)", () => {
    expect(publicar).toMatch(/runs-on: ubuntu-latest/);
    const node = /node-version: (\d+)(?:\.(\d+))?/.exec(publicar);
    expect(node).not.toBeNull();
    const [mayor, menor] = [Number(node![1]), Number(node![2] ?? 0)];
    // Un «22» a secas no vale: sería la 22.x que toque, y solo desde la 22.14 funciona.
    expect(mayor > 22 || (mayor === 22 && menor >= 14)).toBe(true);
    const npm = paso(publicar, "trusted publishing \\(>= 11.5.1\\)");
    expect(npm).toMatch(/b===5&&c>=1/);
    // Y la comprobación MANDA: por debajo, el paso falla. No se instala otro npm.
    expect(npm).toMatch(/^\s*admite \|\| \{[^\n]*exit 1; \}$/m);
    expect(npm).not.toMatch(/install/);
  });

  it("solo el trabajo que publica puede pedir un token OIDC, y no ejecuta código de terceros", () => {
    const todos = [...sinComentarios(workflow).matchAll(/id-token:\s*write/g)];
    expect(todos).toHaveLength(1);
    expect(sinComentarios(workflow)).toMatch(/^permissions: \{\}$/m);
    // No instala NADA (ni dependencias ni otro npm) ni hace checkout: con
    // `id-token: write`, un script de instalación de un tercero podría publicar
    // en nuestro nombre.
    expect(publicar).not.toMatch(/\bnpm (?:install|i|ci|add|update)\b|pnpm|yarn|npx|actions\/checkout/);
    // Y las únicas acciones que ejecuta son estas dos.
    const acciones = [...publicar.matchAll(/uses: ([^\s@]+)@/g)].map((m) => m[1]);
    expect(acciones.sort()).toEqual(["actions/download-artifact", "actions/setup-node"]);
    expect(publicar).toMatch(/needs: \[verificar, banco-semanal\]/);
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

  it("prueba con lo mismo que ci.yml: Python y sus SDK fijados por hash antes de `pnpm test`", () => {
    // La Release de v0.4.26 cayó aquí: ci.yml instalaba los SDK de Python que
    // exige test/python-cliente.test.ts y publish.yml corría la misma suite sin
    // ellos. Lo que ci.yml instala antes de los tests, publish.yml también.
    const ci = sinComentarios(leer("../.github/workflows/ci.yml"));
    const pip = /run: '(python -m pip install --require-hashes [^']+requirements-ci\.txt)'/.exec(ci);
    expect(pip, "ci.yml ya no instala las dependencias de Python como se esperaba").not.toBeNull();
    const version = /uses: actions\/setup-python@\S+\n\s+with:\n\s+python-version: "([^"]+)"/.exec(ci);
    expect(version).not.toBeNull();

    const iPython = verificar.indexOf("uses: actions/setup-python@");
    const iPip = verificar.indexOf(pip![1]!);
    const iTests = verificar.indexOf("run: pnpm test");
    expect(iPython, "publish.yml no prepara Python").toBeGreaterThanOrEqual(0);
    expect(iPip, "publish.yml no instala los SDK de Python con el mismo comando que ci.yml").toBeGreaterThanOrEqual(0);
    expect(iPython).toBeLessThan(iPip);
    expect(iPip).toBeLessThan(iTests);
    expect(verificar).toContain(`python-version: "${version![1]}"`);
  });

  it("la etiqueta coincide con package.json", () => {
    const p = paso(verificar, "La etiqueta coincide con package.json");
    expect(p).toMatch(/ETIQUETA="\$\{GITHUB_REF_NAME#v\}"/);
    expect(p).toMatch(/require\('\.\/package\.json'\)\.version/);
    expect(p).toMatch(/exit 1/);
  });

  it("el tarball: paywall cerrado, sin sourcemaps, con la clave pública en el SDK y en el gateway, y sin ninguna privada", () => {
    const p = paso(verificar, "El paquete no filtra lo que no debe");
    expect(p).toMatch(/grep -q "BVSALA_DEV_OPEN" "\$DIR\/package\/dist\/index\.js"/);
    expect(p).toMatch(/-name "\*\.map"/);
    expect(p).toMatch(/grep -q "BEGIN PUBLIC KEY" "\$DIR\/package\/dist\/index\.js"/);
    expect(p).toMatch(/grep -q "BEGIN PUBLIC KEY" "\$DIR\/package\/dist\/gateway\/bin\.js"/);
    // SECURITY.md promete que la privada no viaja y que el workflow rechaza un
    // tarball que la lleve: esto es lo que lo respalda. En TODO el paquete, en
    // PEM y en base64 del PEM (el formato de LICENSE_PRIVATE_KEY_B64).
    const privada = /grep -rqaE "([^"]+)" "\$DIR\/package"; then\n\s*echo "::error::[^\n]*clave privada[^\n]*"\n\s*exit 1/.exec(p);
    expect(privada, "falta la comprobación de la clave privada").not.toBeNull();
    expect(privada![1]!.split("|").sort()).toEqual(["PRIVATE KEY", ...privateKeyEnBase64()].sort());
    // scripts/simular-ci.sh hace la MISMA búsqueda: lo que pasa en local, pasa en la Release.
    expect(leer("../scripts/simular-ci.sh")).toContain(`grep -rqaE "${privada![1]}" package`);
    // Cada comprobación termina en `exit 1`: una que solo avisara publicaría igual.
    const comprobaciones = p.match(/^\s*if /gm)?.length ?? 0;
    expect(comprobaciones).toBeGreaterThanOrEqual(5);
    expect(p.match(/exit 1/g)?.length).toBe(comprobaciones);
  });

  it("genera el SBOM del MISMO tarball y lo entrega al trabajo que publica", () => {
    expect(paso(verificar, "SBOM CycloneDX del tarball")).toMatch(/scripts\/sbom\.ts "paquete\/[^"]*\.tgz" "paquete\/[^"]*\.cdx\.json"/);
    expect(verificar).toMatch(/actions\/upload-artifact@v4/);
    expect(verificar).not.toMatch(/id-token/);
  });

  it("el hash del tarball verificado viaja como SALIDA de `verificar`, no dentro del artefacto", () => {
    expect(verificar).toMatch(/^ {4}outputs:\n {6}sha512: \$\{\{ steps\.hash\.outputs\.sha512 \}\}$/m);
    const hash = paso(verificar, "Hash del tarball verificado");
    expect(hash).toMatch(/id: hash/);
    expect(hash).toMatch(/echo "sha512=\$H" >> "\$GITHUB_OUTPUT"/);
    // Se calcula después del SBOM y antes de subir el artefacto.
    expect(verificar.indexOf("Hash del tarball verificado")).toBeGreaterThan(verificar.indexOf("SBOM CycloneDX del tarball"));
    expect(verificar.indexOf("Hash del tarball verificado")).toBeLessThan(verificar.indexOf("actions/upload-artifact"));
    // El que publica compara con ESA salida (y con el SBOM), y falla si no llegó.
    const llega = paso(trabajo("publicar"), "El tarball es el verificado");
    expect(llega).toMatch(/SHA512_VERIFICADO: \$\{\{ needs\.verificar\.outputs\.sha512 \}\}/);
    expect(llega).toMatch(/real !== verificado/);
    expect(llega).toMatch(/SHA-512/);
    expect(llega).toMatch(/\[0-9a-f\]\{128\}/);
  });

  it("la comprobación del registro distingue «no la sirve todavía» de «sirve otra», y espera hasta 5 minutos", () => {
    const p = paso(trabajo("publicar"), "El registro sirve el tarball verificado");
    expect(p).toMatch(/for i in \$\(seq 1 30\); do/);
    expect(p).toMatch(/sleep 10/);
    expect(p).toMatch(/if \[ -z "\$REMOTO" \]; then\n[^\n]*NO relances[^\n]*\n\s*exit 1/);
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

  it("solo una expresión SPDX válida va en `expression`; una palabra suelta va como nombre", () => {
    expect(licencias("MIT")).toEqual([{ expression: "MIT" }]);
    expect(licencias("(MIT OR Apache-2.0)")).toEqual([{ expression: "(MIT OR Apache-2.0)" }]);
    expect(licencias("MIT AND ISC")).toEqual([{ expression: "MIT AND ISC" }]);
    for (const libre of ["UNLICENSED", "Custom", "SEE LICENSE IN LICENSE", "(MIT", "MIT OR", "MIT or ISC"]) {
      expect(licencias(libre)).toEqual([{ license: { name: libre } }]);
    }
    expect(licencias(undefined)).toBeUndefined();
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

    /** Un tarball igual al real, con `cambio` aplicado sobre su árbol `package/`. */
    function manipulado(nombre: string, cambio: (pkg: string) => void): string {
      const otro = join(dir, nombre);
      mkdirSync(otro, { recursive: true });
      execFileSync("tar", ["xzf", tgz, "-C", otro]);
      cambio(join(otro, "package"));
      const salida = join(dir, `${nombre}.tgz`);
      execFileSync("tar", ["czf", salida, "-C", otro, "package"]);
      return salida;
    }

    /** Ejecuta TAL CUAL el paso «El paquete no filtra lo que no debe» sobre un tarball. */
    function verjaDelPaquete(tarball: string): { ok: boolean; salida: string } {
      const script = scriptDe(paso(trabajo("verificar"), "El paquete no filtra lo que no debe"));
      const cwd = mkdtempSync(join(tmpdir(), "bvsala-verja-"));
      try {
        const { version } = JSON.parse(leer("../package.json")) as { version: string };
        writeFileSync(join(cwd, "package.json"), JSON.stringify({ version }));
        mkdirSync(join(cwd, "paquete"));
        copyFileSync(tarball, join(cwd, "paquete", `bivelio-savings-layer-${version}.tgz`));
        // `bash -e`, como el shell por defecto de un paso de GitHub Actions en Linux.
        const r = spawnSync("bash", ["-e", "-c", script], { cwd, encoding: "utf8" });
        return { ok: r.status === 0, salida: `${r.stdout}${r.stderr}` };
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }

    it("la verja del paquete deja pasar el tarball real", () => {
      const r = verjaDelPaquete(tgz);
      expect(r.salida).toContain("paquete verificado");
      expect(r.ok).toBe(true);
    }, 60_000);

    it("la verja del paquete rechaza un tarball con una clave privada, en PEM o en base64 del PEM", () => {
      // Una clave de usar y tirar, generada aquí: no es ningún secreto.
      const { privateKey } = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      const casos = [
        manipulado("pem", (pkg) => appendFileSync(join(pkg, "docs", "terminales", "README.md"), `\n${privateKey}\n`)),
        // En base64, a los tres desplazamientos posibles del PEM dentro de lo codificado.
        ...[0, 1, 2].map((k) =>
          manipulado(`b64-${k}`, (pkg) =>
            appendFileSync(
              join(pkg, "dist", "index.js"),
              `\nconst k = "${Buffer.concat([Buffer.alloc(k, 0x61), Buffer.from(privateKey)]).toString("base64")}";\n`,
            ),
          ),
        ),
      ];
      for (const caso of casos) {
        const r = verjaDelPaquete(caso);
        expect(r.ok, caso).toBe(false);
        expect(r.salida).toContain("El paquete lleva una clave privada.");
      }
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
