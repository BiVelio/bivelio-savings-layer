/**
 * QUÉ CÓDIGO MIDE EL BRAZO B, Y A QUÉ HOSTS PUEDE HABLAR.
 * ---------------------------------------------------------------------------
 * Brazo B = v0.4.30 (fuente del tag, `BVSALA_DEV_OPEN=1`; npm = mismo commit,
 * verificado idéntico). Decisión del dueño del 2026-09-28: el paquete de npm es
 * fail-closed y el banco no tiene licencia, así que el brazo B corre el FUENTE
 * del tag `v0.4.30` por su API pública (`createSavingsLayer` → `generate`),
 * como `pnpm ab`. No se fabrica licencia ni se reconstruye el bundle.
 *
 * Lo que este módulo deja comprobado antes de gastar:
 *   · `git diff v0.4.30 -- src/ packages/` vacío en este árbol;
 *   · `BV_SALA_VERSION` === 0.4.30;
 *   · la `integrity` fijada del tarball y el sha256 de su `dist/index.js`
 *     (comprobado a mano el 2026-09-28: `tsup` con las opciones de npm sobre
 *     946f5d5 lo reproduce byte a byte, igual que el `dist/` de la copia limpia).
 *
 * Y la VERJA DE HOSTS: durante la tirada, `globalThis.fetch` solo deja salir
 * peticiones a los hosts de los proveedores (api.anthropic.com,
 * api.openai.com). Cualquier otro —metering, ingest, licencias, telemetría—
 * se RECHAZA y se anota. El informe publica los hosts vistos (solo el host).
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type * as Sdk from "../../../src/index.js";
import { BV_SALA_VERSION } from "../../../src/version.js";

export const VERSION_PAQUETE = "0.4.30";
export const TAG_RELEASE = "v0.4.30";
export const INTEGRIDAD_NPM =
  "sha512-73eFHgLeCQnJlCzkDnnpxJjRCbBDXYxiJIJZ4iglVrN0IrFhGleCYRdE7nyYMzguLzaw5KmexjDyPMpt8BxL+w==";
/** sha256 de `package/dist/index.js` del tarball 0.4.30 (== el `dist/` de la copia limpia de la release). */
export const SHA256_DIST_NPM = "12c709712ee5886b7fe056f026ee820c24c43e93aa470f56aaf4b7d61efb8a88";
export const ETIQUETA_DEL_BRAZO_B = "v0.4.30 (source of the tag, BVSALA_DEV_OPEN=1; npm = same commit, verified identical)";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface ProcedenciaDelBrazoB {
  version: string;
  etiqueta: string;
  tag: string;
  commitDelTag: string;
  commitDelArbol: string;
  /** `git diff v0.4.30 -- src/ packages/` estaba vacío. */
  fuenteIdenticoAlTag: boolean;
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
  if (BV_SALA_VERSION !== VERSION_PAQUETE) throw new Error(`el fuente es ${BV_SALA_VERSION}, no ${VERSION_PAQUETE}`);
  const commitDelTag = git(["rev-parse", `${TAG_RELEASE}^{commit}`]);
  const diff = git(["diff", "--stat", TAG_RELEASE, "--", "src/", "packages/"]);
  if (diff !== "") throw new Error(`src/ o packages/ difieren de ${TAG_RELEASE}: el brazo B no sería la 0.4.30`);
  process.env["BVSALA_DEV_OPEN"] = "1";
  const sdk = (await import("../../../src/index.js")) as typeof Sdk;
  return {
    sdk,
    procedencia: {
      version: VERSION_PAQUETE,
      etiqueta: ETIQUETA_DEL_BRAZO_B,
      tag: TAG_RELEASE,
      commitDelTag,
      commitDelArbol: git(["rev-parse", "HEAD"]),
      fuenteIdenticoAlTag: true,
      integridadNpm: INTEGRIDAD_NPM,
      sha256DistNpm: SHA256_DIST_NPM,
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
