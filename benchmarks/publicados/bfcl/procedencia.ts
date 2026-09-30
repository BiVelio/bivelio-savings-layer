/**
 * QUÉ CÓDIGO MIDE EL BRAZO B, Y A QUÉ HOSTS PUEDE HABLAR.
 * ---------------------------------------------------------------------------
 * Brazo B = v0.4.31 (fuente del tag, `BVSALA_DEV_OPEN=1`; npm = mismo commit,
 * verificado idéntico). Decisión del dueño del 2026-09-28: el paquete de npm es
 * fail-closed y el banco no tiene licencia, así que el brazo B corre el FUENTE
 * del tag por su API pública (`createSavingsLayer` → `generate`), como
 * `pnpm ab`. No se fabrica licencia ni se reconstruye el bundle.
 *
 * DE DÓNDE SALE EL FUENTE. Si `git diff <tag> -- src/ packages/` está vacío en
 * este árbol, se carga `src/` tal cual. Si no (main sigue avanzando después de
 * cortar la etiqueta: tras la v0.4.31, #385 tocó `src/version.ts`), NO se mide
 * el árbol: se extrae `src/` del propio tag con `git archive` a
 * `.cache/fuente-<tag>/` y se carga de ahí. Así el brazo B es el tag byte a
 * byte, pase lo que pase en main, y el artefacto dice cuál de las dos vías usó
 * y qué ficheros del árbol diferían.
 *
 * Lo que este módulo deja comprobado antes de gastar:
 *   · el fuente cargado ES el del tag (árbol idéntico, o extraído de él);
 *   · `BV_SALA_VERSION` del fuente cargado === VERSION_PAQUETE;
 *   · la `integrity` fijada del tarball y el sha256 de su `dist/index.js`
 *     (comprobado a mano el 2026-09-28 para la 0.4.31: `npm pack` da esa
 *     integrity, y `tsup` sobre `git archive v0.4.31` reproduce el `dist/`
 *     entero del tarball byte a byte).
 *
 * Y la VERJA DE HOSTS: durante la tirada, `globalThis.fetch` solo deja salir
 * peticiones a los hosts de los proveedores (api.anthropic.com,
 * api.openai.com). Cualquier otro —metering, ingest, licencias, telemetría—
 * se RECHAZA y se anota. El dataset (raw.githubusercontent.com) se descarga y
 * verifica ANTES de instalarla. El informe publica los hosts vistos (solo el host).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type * as Sdk from "../../../src/index.js";

export const VERSION_PAQUETE = "0.4.31";
export const TAG_RELEASE = "v0.4.31";
/** Commit al que apunta la etiqueta; se comprueba contra `git rev-parse` antes de gastar. */
export const COMMIT_DEL_TAG = "00c99c803c0ab6f3c11b7ab87f3c75a38d609b1c";
export const INTEGRIDAD_NPM =
  "sha512-ePCN+dZr+VuMUSGm2TelDkt7TR6jSi/SCTomomDK/bfF92FHr1eFUdgTWQODCdQf8C8c+/h6AA/up46DXO2mLQ==";
/** sha256 de `package/dist/index.js` del tarball 0.4.31 (== `tsup` sobre `git archive v0.4.31`, dist/ entero idéntico). */
export const SHA256_DIST_NPM = "b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731";
export const ETIQUETA_DEL_BRAZO_B = "v0.4.31 (source of the tag, BVSALA_DEV_OPEN=1; npm = same commit, dist rebuilt from the tag byte-identical)";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface ProcedenciaDelBrazoB {
  version: string;
  etiqueta: string;
  tag: string;
  commitDelTag: string;
  commitDelArbol: string;
  /** El fuente cargado es el del tag (el árbol era idéntico, o se extrajo del tag). */
  fuenteIdenticoAlTag: boolean;
  /** «arbol» = `src/` de este árbol (diff vacío); «git-archive» = `src/` extraído del tag. */
  origenDelFuente?: "arbol" | "git-archive";
  /** Ficheros de `src/`/`packages/` en que este árbol difería del tag (no medidos). */
  diferenciasDelArbol?: string[];
  integridadNpm: string;
  sha256DistNpm: string;
  /** Hosts a los que la tirada llamó (solo el host) y los que la verja rechazó. */
  hostsVistos: string[];
  hostsRechazados: string[];
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: RAIZ, encoding: "utf8" }).trim();
}

export interface SdkCargado {
  sdk: typeof Sdk;
  procedencia: ProcedenciaDelBrazoB;
}

/** Comprueba que el fuente ES el tag y lo carga con la puerta de desarrollo abierta. */
export async function cargarSdk(): Promise<SdkCargado> {
  const commitDelTag = git(["rev-parse", `${TAG_RELEASE}^{commit}`]);
  if (commitDelTag !== COMMIT_DEL_TAG) throw new Error(`${TAG_RELEASE} apunta a ${commitDelTag}, no a ${COMMIT_DEL_TAG}`);
  const diferencias = git(["diff", "--name-only", TAG_RELEASE, "--", "src/", "packages/"]).split("\n").filter(Boolean);
  let entrada = join(RAIZ, "src", "index.ts");
  let origen: "arbol" | "git-archive" = "arbol";
  if (diferencias.length) {
    // El árbol no es el tag: se mide el tag, extraído de git, nunca el árbol.
    const dir = join(dirname(fileURLToPath(import.meta.url)), ".cache", `fuente-${TAG_RELEASE}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const tar = `${dir}.tar`;
    git(["archive", "--format=tar", "-o", tar, TAG_RELEASE, "src"]);
    execFileSync("tar", ["-xf", tar, "-C", dir]);
    rmSync(tar, { force: true });
    entrada = join(dir, "src", "index.ts");
    origen = "git-archive";
  }
  process.env["BVSALA_DEV_OPEN"] = "1";
  const sdk = (await import(pathToFileURL(entrada).href)) as typeof Sdk;
  if ((sdk.BV_SALA_VERSION as string) !== VERSION_PAQUETE) throw new Error(`el fuente cargado es ${sdk.BV_SALA_VERSION}, no ${VERSION_PAQUETE}`);
  return {
    sdk,
    procedencia: {
      version: VERSION_PAQUETE,
      etiqueta: ETIQUETA_DEL_BRAZO_B,
      tag: TAG_RELEASE,
      commitDelTag,
      commitDelArbol: git(["rev-parse", "HEAD"]),
      fuenteIdenticoAlTag: true,
      origenDelFuente: origen,
      diferenciasDelArbol: diferencias,
      integridadNpm: INTEGRIDAD_NPM,
      sha256DistNpm: SHA256_DIST_NPM,
      hostsVistos: [],
      hostsRechazados: [],
    },
  };
}

/**
 * `--fuente-de-main` (banco semanal, benchmarks/banco-semanal): el brazo B es el
 * fuente de ESTE árbol, sea la versión que sea — lo que main lleva hoy, no una
 * release —, con la puerta de desarrollo abierta, como `pnpm ab`. No se compara
 * con ningún tag ni con npm, y la procedencia lo dice en vez de afirmarlo.
 */
export async function cargarSdkDelArbol(): Promise<SdkCargado> {
  process.env["BVSALA_DEV_OPEN"] = "1";
  const sdk = (await import(pathToFileURL(join(RAIZ, "src", "index.ts")).href)) as typeof Sdk;
  const commit = git(["rev-parse", "HEAD"]);
  return {
    sdk,
    procedencia: {
      version: sdk.BV_SALA_VERSION,
      etiqueta: `${sdk.BV_SALA_VERSION} at ${commit.slice(0, 7)} (working-tree source, BVSALA_DEV_OPEN=1; weekly bench, not a release)`,
      tag: "(none: working tree)",
      commitDelTag: "(none: working tree)",
      commitDelArbol: commit,
      fuenteIdenticoAlTag: false,
      origenDelFuente: "arbol",
      diferenciasDelArbol: [],
      integridadNpm: "(n/a: working tree)",
      sha256DistNpm: "(n/a: working tree)",
      hostsVistos: [],
      hostsRechazados: [],
    },
  };
}

/**
 * Instala la verja de hosts sobre `globalThis.fetch` y devuelve el registro.
 * Se instala ANTES de crear ningún proveedor ni capa, así que todo `fetch` de
 * la tirada —el del brazo A, el adaptador del B y cualquier cosa que la capa
 * intentara por su cuenta— pasa por aquí.
 */
export function instalarVerjaDeHosts(permitidos: readonly string[]): { vistos: Set<string>; rechazados: Set<string>; retirar: () => void } {
  const original = globalThis.fetch;
  const vistos = new Set<string>();
  const rechazados = new Set<string>();
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).host;
    if (!permitidos.includes(host)) {
      rechazados.add(host);
      throw new Error(`host guard: ${host} is not a provider host; request refused`);
    }
    vistos.add(host);
    return original(input, init);
  }) as typeof fetch;
  return { vistos, rechazados, retirar: () => void (globalThis.fetch = original) };
}
