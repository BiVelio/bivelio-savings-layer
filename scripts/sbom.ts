/**
 * SBOM CycloneDX 1.5 DEL TARBALL QUE SE PUBLICA EN NPM.
 *
 * Uso (desde la raíz del repo, con `dist/` ya construido y empaquetado):
 *
 *   pnpm exec tsx scripts/sbom.ts <bivelio-savings-layer-X.tgz> <salida.cdx.json>
 *
 * ── POR QUÉ NO `npm sbom` ─────────────────────────────────────────────────────
 * `npm sbom` describe el árbol de dependencias DECLARADO en package.json, y el
 * paquete publicado no declara ni una `dependency`: el código de terceros que
 * lleva va DENTRO del bundle (tsup empaqueta @noble/curves, que es
 * devDependency, porque la verificación Ed25519 tiene que viajar con el SDK).
 * Así que `npm sbom --omit dev` diría «ningún componente de terceros» y
 * `npm sbom` a secas listaría tsup, vitest y typescript, que no viajan. Las dos
 * serían falsas, y un SBOM falso es peor que ninguno: es lo que se enseña en una
 * auditoría.
 *
 * Este script le pregunta al PROPIO EMPAQUETADOR qué ficheros de node_modules
 * entraron en el bundle (el metafile de esbuild, vía tsup, con la MISMA
 * configuración que construye `dist/`) y luego COMPRUEBA que el bundle
 * reconstruido es, byte a byte, el que va dentro del tarball. Si no lo es, el
 * SBOM describiría otro artefacto y el script falla en vez de mentir.
 *
 * Sin dependencias nuevas: tsup ya está, y el JSON de CycloneDX se escribe a
 * mano (son una docena de campos).
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));

/** Un paquete de terceros tal como lo ve el SBOM. */
export interface ComponenteDeTerceros {
  name: string;
  /** Versión exacta si va empaquetado; ausente si es un peer (solo hay rango). */
  version?: string;
  /** El campo `license` de su package.json, tal cual. */
  license?: string;
  /** `bundled`: va dentro de dist/. `optional-peer`: lo carga el SDK solo si está instalado. */
  inclusion: "bundled" | "optional-peer";
  /** Rango declarado, solo para los peers. */
  range?: string;
}

export interface EntradaSbom {
  /** name y version del package.json raíz. */
  paquete: { name: string; version: string; license?: string };
  tarball: { sha512Hex: string; sha256Hex: string };
  componentes: ComponenteDeTerceros[];
  /** ISO 8601. */
  timestamp: string;
  serialNumber: string;
}

/**
 * El purl de un paquete npm (https://github.com/package-url/purl-spec): el scope
 * va como namespace con la `@` codificada, `pkg:npm/%40noble/curves@2.2.0`.
 */
export function purlNpm(name: string, version?: string): string {
  const cuerpo = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${cuerpo}${version ? `@${version}` : ""}`;
}

/** `@scope/nombre` → group + name, como los quiere CycloneDX. */
function grupoYNombre(name: string): { group?: string; name: string } {
  if (!name.startsWith("@")) return { name };
  const barra = name.indexOf("/");
  return { group: name.slice(0, barra), name: name.slice(barra + 1) };
}

/**
 * Una expresión SPDX sencilla va en `expression`; cualquier otra cosa (p. ej.
 * «SEE LICENSE IN LICENSE») va como nombre libre, que el esquema admite.
 */
function licencias(license: string | undefined): unknown[] | undefined {
  if (!license) return undefined;
  const pareceSpdx = /^[A-Za-z0-9.+-]+( (AND|OR|WITH) [A-Za-z0-9.+-]+)*$/.test(license) || /^\(.*\)$/.test(license);
  return pareceSpdx ? [{ expression: license }] : [{ license: { name: license } }];
}

/** El documento CycloneDX 1.5. Puro: todo lo que varía entra por argumento. */
export function construirSbom(e: EntradaSbom): Record<string, unknown> {
  const raiz = purlNpm(e.paquete.name, e.paquete.version);
  const { group, name } = grupoYNombre(e.paquete.name);
  const nombreSinScope = e.paquete.name.replace(/^@[^/]+\//, "");
  const componentes = [...e.componentes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => {
      const gn = grupoYNombre(c.name);
      const ref = purlNpm(c.name, c.version);
      return {
        type: "library",
        "bom-ref": ref,
        ...(gn.group ? { group: gn.group } : {}),
        name: gn.name,
        ...(c.version ? { version: c.version } : {}),
        purl: ref,
        scope: c.inclusion === "bundled" ? "required" : "optional",
        ...(licencias(c.license) ? { licenses: licencias(c.license) } : {}),
        properties: [
          { name: "bivelio:inclusion", value: c.inclusion },
          ...(c.range ? [{ name: "bivelio:versionRange", value: c.range }] : []),
        ],
      };
    });
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: e.serialNumber,
    version: 1,
    metadata: {
      timestamp: e.timestamp,
      tools: { components: [{ type: "application", name: "bivelio-savings-layer scripts/sbom.ts" }] },
      component: {
        type: "library",
        "bom-ref": raiz,
        ...(group ? { group } : {}),
        name,
        version: e.paquete.version,
        purl: raiz,
        ...(licencias(e.paquete.license) ? { licenses: licencias(e.paquete.license) } : {}),
        hashes: [
          { alg: "SHA-512", content: e.tarball.sha512Hex },
          { alg: "SHA-256", content: e.tarball.sha256Hex },
        ],
        externalReferences: [
          {
            type: "distribution",
            url: `https://registry.npmjs.org/${e.paquete.name}/-/${nombreSinScope}-${e.paquete.version}.tgz`,
          },
        ],
      },
    },
    components: componentes,
    dependencies: [
      { ref: raiz, dependsOn: componentes.map((c) => c["bom-ref"]) },
      ...componentes.map((c) => ({ ref: c["bom-ref"], dependsOn: [] })),
    ],
  };
}

/**
 * El nombre del paquete al que pertenece un fichero de node_modules: lo que va
 * detrás del ÚLTIMO `node_modules/` (un segmento, o dos si tiene scope). Vale
 * para el layout de npm y para el de pnpm (`node_modules/.pnpm/x@1/node_modules/x/…`).
 */
export function paqueteDeRuta(ruta: string): { name: string; raiz: string } | null {
  const partes = ruta.split(/[\\/]/);
  const i = partes.lastIndexOf("node_modules");
  if (i < 0 || i + 1 >= partes.length) return null;
  const primero = partes[i + 1]!;
  const n = primero.startsWith("@") ? 2 : 1;
  if (i + n >= partes.length) return null;
  const nombre = partes.slice(i + 1, i + 1 + n).join("/");
  return { name: nombre, raiz: partes.slice(0, i + 1 + n).join(sep) };
}

/** Los .js de un directorio, con su ruta relativa a él. */
function jsDe(dir: string): string[] {
  const out: string[] = [];
  const recorrer = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) recorrer(p);
      else if (f.endsWith(".js")) out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  recorrer(dir);
  return out.sort();
}

const sha = (alg: "sha256" | "sha512", b: Buffer): string => createHash(alg).update(b).digest("hex");

interface Metafile {
  inputs: Record<string, unknown>;
  outputs: Record<string, { imports?: { path: string; external?: boolean }[] }>;
}

/**
 * Reconstruye el bundle de npm con metafile, comprueba que es el del tarball y
 * devuelve el SBOM. Tiene que correr desde la raíz del repo (las entradas de
 * tsup y las rutas del metafile son relativas al directorio de trabajo).
 */
export async function generarSbom(
  tarball: string,
  opts: { now?: () => Date; serialNumber?: string } = {},
): Promise<Record<string, unknown>> {
  if (resolve(process.cwd()) !== resolve(RAIZ)) {
    throw new Error(`sbom: ejecútalo desde la raíz del repo (${RAIZ}), no desde ${process.cwd()}`);
  }
  const bytes = readFileSync(tarball);
  const pkg = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as {
    name: string;
    version: string;
    license?: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  const tmp = mkdtempSync(join(tmpdir(), "bvsala-sbom-"));
  try {
    // ── 1 · lo que dice el tarball ────────────────────────────────────────
    const extraido = join(tmp, "tarball");
    mkdirSync(extraido, { recursive: true });
    execFileSync("tar", ["xzf", resolve(tarball), "-C", extraido]);
    const manifiesto = JSON.parse(readFileSync(join(extraido, "package", "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    if (manifiesto.name !== pkg.name || manifiesto.version !== pkg.version) {
      throw new Error(
        `sbom: el tarball es ${manifiesto.name}@${manifiesto.version} y package.json dice ${pkg.name}@${pkg.version}`,
      );
    }

    // ── 2 · el mismo build, con metafile ─────────────────────────────────
    // La configuración se LEE de tsup.config.ts (la entrada que escribe en
    // `dist`), no se copia: si alguien cambia el build, el SBOM lo sigue.
    const { build } = await import("tsup");
    const cfgMod = (await import(pathToFileURL(join(RAIZ, "tsup.config.ts")).href)) as { default: unknown };
    const lista = (Array.isArray(cfgMod.default) ? cfgMod.default : [cfgMod.default]) as Record<string, unknown>[];
    const cfgNpm = lista.find((c) => c.outDir === "dist");
    if (!cfgNpm) throw new Error("sbom: tsup.config.ts no tiene una entrada con outDir 'dist'");
    const salida = join(tmp, "build");
    await build({ ...cfgNpm, outDir: salida, dts: false, metafile: true, clean: true, silent: true, config: false });
    const metaFichero = readdirSync(salida).find((f) => /^metafile-.*\.json$/.test(f));
    if (!metaFichero) throw new Error("sbom: tsup no escribió el metafile");
    const meta = JSON.parse(readFileSync(join(salida, metaFichero), "utf8")) as Metafile;

    // ── 3 · ¿es el mismo bundle? byte a byte ─────────────────────────────
    const reconstruidos = jsDe(salida);
    const publicados = jsDe(join(extraido, "package", "dist"));
    if (reconstruidos.join("\n") !== publicados.join("\n")) {
      throw new Error(
        `sbom: el tarball lleva [${publicados.join(", ")}] y el build da [${reconstruidos.join(", ")}]`,
      );
    }
    for (const f of reconstruidos) {
      const a = sha("sha256", readFileSync(join(salida, f)));
      const b = sha("sha256", readFileSync(join(extraido, "package", "dist", f)));
      if (a !== b) {
        throw new Error(
          `sbom: dist/${f} del tarball no es el que sale del build actual: el SBOM describiría otro artefacto. ` +
            "Reconstruye (pnpm run build) y vuelve a empaquetar.",
        );
      }
    }

    // ── 4 · qué código de terceros va dentro ─────────────────────────────
    const empaquetados = new Map<string, ComponenteDeTerceros>();
    for (const entrada of Object.keys(meta.inputs)) {
      const p = paqueteDeRuta(entrada);
      if (!p) continue;
      const manifest = JSON.parse(readFileSync(join(resolve(process.cwd(), p.raiz), "package.json"), "utf8")) as {
        name?: string;
        version?: string;
        license?: string;
      };
      const name = manifest.name ?? p.name;
      if (!manifest.version) throw new Error(`sbom: ${name} no tiene versión en su package.json`);
      const clave = `${name}@${manifest.version}`;
      if (!empaquetados.has(clave)) {
        empaquetados.set(clave, {
          name,
          version: manifest.version,
          ...(manifest.license ? { license: manifest.license } : {}),
          inclusion: "bundled",
        });
      }
    }

    // Lo que el bundle importa SIN empaquetar tiene que ser de Node o estar
    // declarado: si no, el paquete necesitaría algo que no instala.
    const declarados = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    const nativos = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
    for (const [salidaJs, o] of Object.entries(meta.outputs)) {
      for (const imp of o.imports ?? []) {
        if (!imp.external || nativos.has(imp.path) || imp.path.startsWith("node:")) continue;
        const nombre = imp.path.startsWith("@") ? imp.path.split("/").slice(0, 2).join("/") : imp.path.split("/")[0]!;
        if (!declarados.has(nombre)) {
          throw new Error(`sbom: ${salidaJs} importa '${imp.path}' sin empaquetarlo y package.json no lo declara`);
        }
      }
    }

    // Los peers opcionales: no viajan, pero el SDK los carga si están.
    const peers: ComponenteDeTerceros[] = Object.entries(pkg.peerDependencies ?? {}).map(([name, range]) => ({
      name,
      range,
      inclusion: "optional-peer",
    }));
    if (Object.keys(pkg.dependencies ?? {}).length > 0) {
      // Hoy no hay ninguna; si un día las hay, este SBOM tiene que aprender a
      // listarlas con su versión resuelta antes de publicarse.
      throw new Error("sbom: package.json declara `dependencies` y este generador no las lista todavía");
    }

    return construirSbom({
      paquete: { name: pkg.name, version: pkg.version, ...(pkg.license ? { license: pkg.license } : {}) },
      tarball: { sha512Hex: sha("sha512", bytes), sha256Hex: sha("sha256", bytes) },
      componentes: [...empaquetados.values(), ...peers],
      timestamp: (opts.now ? opts.now() : new Date()).toISOString(),
      serialNumber: opts.serialNumber ?? `urn:uuid:${randomUUID()}`,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const esPrincipal = ((): boolean => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1]!)).href;
  } catch {
    return false;
  }
})();

if (esPrincipal) {
  const [tarball, destino] = process.argv.slice(2);
  if (!tarball || !destino || !existsSync(tarball)) {
    console.error("uso: tsx scripts/sbom.ts <bivelio-savings-layer-X.tgz> <salida.cdx.json>");
    process.exit(2);
  }
  try {
    const sbom = await generarSbom(tarball);
    writeFileSync(destino, `${JSON.stringify(sbom, null, 2)}\n`);
    const comps = (sbom.components as { name: string; group?: string; version?: string; scope: string }[]).map(
      (c) => `${c.group ? `${c.group}/` : ""}${c.name}${c.version ? `@${c.version}` : ""} (${c.scope})`,
    );
    console.log(`SBOM CycloneDX 1.5 escrito en ${destino}: ${comps.join(", ") || "sin componentes de terceros"}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
