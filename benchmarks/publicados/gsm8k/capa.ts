/**
 * DE DÓNDE SALE LA CAPA DEL BRAZO B — y por qué se aborta sin licencia.
 *
 * Por defecto, del PAQUETE PUBLICADO: `@bivelio/savings-layer@0.4.31` bajado de
 * npm con `npm pack`, comprobado por el `integrity` sha512 del registro y por
 * sha256 (tarball y `dist/index.js`) y cargado
 * desde `benchmarks/out/gsm8k/paquete/` (git lo ignora). Ese build no tiene modo
 * sin licencia, así que exige `BIVELIO_LICENSE_KEY` en el entorno; sin ella la
 * tirada LIVE aborta ANTES de la primera llamada de pago. La licencia se pasa
 * sola, sin `licenseServerUrl` ni `serviceAccountKey`: verificación offline, sin
 * metering, para que el tráfico del banco no entre en ningún panel de producción.
 *
 * `--desde-fuente` es la alternativa declarada, nunca la de por defecto: el fuente
 * de la etiqueta v0.4.31 con `devUnlicensed: true`. Es el mismo código (el
 * `dist/index.js` que construye este árbol, y el de `git archive v0.4.31`, tienen
 * el sha256 del tarball; comprobado el 2026-09-28), pero no es «el paquete tal
 * como se instala» y el artefacto lo dice.
 *
 * La tirada anterior (0.4.30, docs/benchmarks/2026-09-28/gsm8k.{json,md}) queda
 * como está: su artefacto lleva sus propios sha256 en `procedencia`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import * as fuente from "../../../src/index.js";
import { sha256Hex } from "../../cache-semantica/datos.js";
import { DIR_SALIDA_GSM8K } from "./fuente.js";

export const PAQUETE_NPM = {
  nombre: "@bivelio/savings-layer",
  version: "0.4.31",
  /** El `integrity` que publica el registro (`npm view @bivelio/savings-layer@0.4.31 dist.integrity`). */
  integrity: "sha512-ePCN+dZr+VuMUSGm2TelDkt7TR6jSi/SCTomomDK/bfF92FHr1eFUdgTWQODCdQf8C8c+/h6AA/up46DXO2mLQ==",
  tarballSha256: "7f44816f0518e762a00821d03b5beb186772a290efd3ac4bf40006ca421a61ca",
  distIndexSha256: "b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731",
  /** La etiqueta y su commit: `git rev-parse v0.4.31^{commit}`. */
  etiqueta: "v0.4.31",
  commit: "00c99c803c0ab6f3c11b7ab87f3c75a38d609b1c",
} as const;

type ApiDeLaCapa = Pick<typeof fuente, "createSavingsLayer" | "InMemorySemanticCache">;

export interface FabricaDeCapa {
  origen: "npm" | "fuente";
  api: ApiDeLaCapa;
  /** Lo que se le pasa a `createSavingsLayer` para la licencia. Nunca se imprime. */
  licencia: { licenseKey: string } | { devUnlicensed: true };
}

export const DIR_PAQUETE = join(DIR_SALIDA_GSM8K, "paquete");

/** Baja (si falta) y verifica el tarball de npm; devuelve la ruta de `dist/index.js`. */
export function paqueteVerificado(dir = DIR_PAQUETE): string {
  const tgz = join(dir, `bivelio-savings-layer-${PAQUETE_NPM.version}.tgz`);
  if (!existsSync(tgz)) {
    mkdirSync(dir, { recursive: true });
    execFileSync("npm", ["pack", `${PAQUETE_NPM.nombre}@${PAQUETE_NPM.version}`, "--pack-destination", dir, "--silent"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  const bytes = readFileSync(tgz);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== PAQUETE_NPM.integrity) throw new Error(`npm tarball integrity mismatch: ${integrity}`);
  const sha = sha256Hex(bytes);
  if (sha !== PAQUETE_NPM.tarballSha256) throw new Error(`npm tarball sha256 mismatch: ${sha}`);
  const index = join(dir, "package", "dist", "index.js");
  if (!existsSync(index)) execFileSync("tar", ["xzf", tgz, "-C", dir]);
  const shaIndex = sha256Hex(readFileSync(index));
  if (shaIndex !== PAQUETE_NPM.distIndexSha256) throw new Error(`dist/index.js sha256 mismatch: ${shaIndex}`);
  return index;
}

export class SinLicencia extends Error {
  constructor() {
    super(
      `BIVELIO_LICENSE_KEY is not set: the published ${PAQUETE_NPM.version} build has no unlicensed mode, so arm B cannot run. ` +
        `Aborting before any paid call. (--desde-fuente runs the identical ${PAQUETE_NPM.version} source unlicensed, and the artifact says so.)`,
    );
    this.name = "SinLicencia";
  }
}

/**
 * La fábrica de la tirada. Sin red salvo `npm pack`. Comprueba además que la
 * licencia ARRANCA la capa con un proveedor falso (sin red, sin coste): una clave
 * caducada o de otro producto aborta aquí, no a mitad de una tirada pagada.
 */
export async function fabricaDeCapa(opts: { desdeFuente: boolean; env: NodeJS.ProcessEnv }): Promise<FabricaDeCapa> {
  if (opts.desdeFuente) {
    // Igual que `pnpm ab`: la puerta de desarrollo del fuente. Sin licenseServerUrl ni
    // serviceAccountKey la capa no abre ninguna conexión propia.
    process.env["BVSALA_DEV_OPEN"] = "1";
    return { origen: "fuente", api: fuente, licencia: { devUnlicensed: true } };
  }
  const clave = opts.env["BIVELIO_LICENSE_KEY"];
  if (!clave) throw new SinLicencia();
  const api = (await import(pathToFileURL(paqueteVerificado()).href)) as ApiDeLaCapa;
  const f: FabricaDeCapa = { origen: "npm", api, licencia: { licenseKey: clave } };
  const capa = api.createSavingsLayer({
    ...f.licencia,
    silenceWarnings: true,
    provider: {
      id: "comprobacion-de-licencia",
      async generate() {
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, finishReason: "stop" };
      },
    },
  });
  try {
    await capa.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "license check" }] });
  } catch (err) {
    // El mensaje de la capa nunca lleva la clave; se recorta igual.
    throw new Error(`the license did not start the published layer: ${String((err as Error).message).slice(0, 200)}`);
  } finally {
    capa.close();
  }
  return f;
}
